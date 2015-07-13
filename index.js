#!/usr/bin/env node

var Promise = require('bluebird'),
  program = require('commander'),
  ProgressBar = require('progress'),
  request = require('request'),
  esrefactor = require('esrefactor'),
  esprima = require('esprima'),
  estraverse = require('estraverse'),
  escodegen = require('escodegen'),
  mkdirp = Promise.promisify(require('mkdirp')),
  path = require('path'),
  fs = Promise.promisifyAll(require('fs')),
  pkg = require('./package.json'),
  plugLogin = Promise.promisify(require('plug-login').guest),
  $ = require('./lib/ast'),
  cleanAst = require('./lib/clean-ast')

var _v

program
  .usage('[options]')
  .version(pkg.version)
  .option('-m, --mapping [file]', 'File containing the mapping JSON ' +
            '(optional, it\'s auto-generated if no file is given)')
  .option('-o, --out [dir]', 'Output directory [out/]', 'out/')
  .option('-c, --copy', 'Copy deobfuscated files instead of symlinking (nice for Windows)')
  .option('--save-source', 'Copy the source javascript to the output directory')
  .option('--save-mapping', 'Copy the mapping file to the output directory')
  .parse(process.argv)

// formatting for escodegen
var codegenOptions = {
  format: { indent: { style: '  ' } },
  comment: true
}

var requestOpts = {
  headers: { 'user-agent': 'replug' }
}

// poor lady's merge
function merge(o, a) {
  Object.keys(a).forEach(function (k) { o[k] = a[k] })
  return o
}

function progress(text, size) {
  var bar = new ProgressBar(text + ' [:bar] :percent', {
    total: size,
    width: 40,
    complete: '#',
    clear: true,
    callback: function () {
      console.log(text + ' done')
    }
  })
  return bar
}

function fetchAppFile(url) {
  return new Promise(function (resolve, reject) {
    request(url, function (e, res) {
      if (e) reject(e)
      else   resolve(res && res.body)
    })
    .on('response', function (res) {
      var size = parseInt(res.headers['content-length'], 10)
      var bar = progress('downloading app javascript...', size)
      res.on('data', function (chunk) {
        bar.tick(chunk.length)
      })
    })
  })
}

function variableNameFor(dep, mapping) {
  var libraryNames = {
    jquery: '$',
    backbone: 'Backbone',
    handlebars: 'Handlebars',
    underscore: '_'
  }
  return dep in libraryNames
       ? libraryNames[dep]
       : dep.indexOf('hbs!templates/') === 0
       ? 'template' + dep.split('/').pop()
       : dep in mapping
       ? mapping[dep].split('/').pop().replace(/-/g, '_')
       : dep
}

function parseModules(str) {
  var ast = esprima.parse(str, { range: true })
  var modules = {}
  process.stdout.write('parsing javascript...')
  estraverse.traverse(ast, {
    enter: function (node) {
      if (node.type === 'CallExpression' &&
          node.callee.name === 'define') {
        var name = node.arguments[0],
          deps = node.arguments[1],
          factory = node.arguments[2]
        if (deps.type === 'ArrayExpression') {
          deps = deps.elements
        }
        else {
          factory = deps
          deps = []
        }
        modules[name.value] = {
          deps: deps,
          ast: factory
        }
      }
    }
  })
  console.log(' done')

  return modules
}

function findReturnVar(ast) {
  var lastSt = ast.body[ast.body.length - 1]
  if (lastSt && lastSt.type === 'ReturnStatement') {
    var retVal = lastSt.argument
    return retVal.type === 'NewExpression'
      ? retVal.callee
      : retVal.type === 'Identifier'
      ? retVal
      : null
  }
}

function cleanModules(modules) {
  var bar = progress('cleaning module ASTs...', Object.keys(modules).length)
  for (var name in modules) if (modules.hasOwnProperty(name)) {
    cleanAst(modules[name].ast)
    bar.tick()
  }
  return modules
}

function remapModuleNames(modules, mapping) {
  var bar = progress('remapping module names...', Object.keys(modules).length)
  for (var name in modules) if (modules.hasOwnProperty(name)) {
    var ast = modules[name].ast,
      deps = modules[name].deps,
      params = ast.params && ast.params.map(function (p) { return p.name })

    if (!params) {
      bar.tick()
      continue
    }
    var renames = []
    // build ast of dependency require()s
    var depsAst = deps.map(function (dep, i) {
      if (!params[i]) params[i] = '__' + i
      var newName = 'unknown'
      // rename variables according to their module names
      if (mapping[dep.value]) {
        newName = variableNameFor(dep.value, mapping)
        renames.push({ idx: dep.range[0], to: newName })
      }
      else if (/^hbs!templates\//.test(dep.value)) {
        newName = 'template' + dep.value.split('/').pop()
        renames.push({ idx: dep.range[0], to: newName })
      }
      var range = [ dep.range[0] - 1, dep.range[1] + 1 ]
      return {
        type: 'VariableDeclaration',
        kind: 'var',
        range: range,
        declarations: [ {
          type: 'VariableDeclarator',
          id: merge($.id(params[i]), { range: dep.range }),
          range: range,
          init: {
            type: 'CallExpression',
            callee: $.id('require'),
            range: range,
            arguments: [ merge(dep, {
              trailingComments: [ {
                type: 'Block',
                value: ' ' + (dep.value in mapping ? mapping[dep.value] : 'Unknown module')
              } ]
            }) ]
          }
        } ]
      }
    })

    // move dependencies from the define() call
    // to the factory body
    ast.body.body = depsAst.concat(ast.body.body)
    ast.params = [
      $.id('require'),
      $.id('exports'),
      $.id('module')
    ]

    var returnVar = findReturnVar(ast.body)
    if (returnVar) {
      renames.push({
        idx: returnVar.range[0],
        to: variableNameFor(name, mapping)
      })
    }

    // wrap the ast in a Program node so esrefactor accepts it
    var fullAst = $.largeRange({
      type: 'Program',
      body: [ $.largeRange({
        type: 'ExpressionStatement',
        expression: ast
      }) ]
    })

    processRenames(fullAst, renames)
    bar.tick()
  }

  return modules
}

function getDependents(modules, name) {
  var dependents = []
  function isDep(d) {
    return d.value === name
  }
  for (var i in modules) if (modules.hasOwnProperty(i)) {
    if (modules[i].deps.some(isDep)) {
      dependents.push(i)
    }
  }
  return dependents
}

function findMemberExpressionName(ast) {
  var body = ast.body
  for (var i = 0, l = body.length; i < l; i++) {
    if (body[i].type === 'ExpressionStatement' &&
        body[i].expression.type === 'AssignmentExpression' &&
        body[i].expression.left.type === 'MemberExpression' &&
        body[i].expression.left.object.type === 'Identifier') {
      return body[i].expression.left.property
    }
  }
}
function addMappingForUnknownModules(modules, mapping) {
  for (var orig in mapping) {
    if (mapping[orig] === 'plug/server/socketReceiver') {
      // websocket event receiver modules don't export anything,
      // so they cannot be identified individually by plug-modules.
      // however, we have accesss to their full source here, so
      // we can extract them anyway!
      // socket event receivers set properties on a shared object,
      // which will actually be require()d by plug.dj source code,
      // and which can also be identified by plug-modules. here, we
      // can find all modules that depend on socketReceiver, and find
      // the relevant assignments.
      getDependents(modules, orig).forEach(function (name) {
        var prop = findMemberExpressionName(modules[name].ast.body)
        if (prop) {
          // some of these modules have multiple event receivers, so we
          // rename them to be a bit more clear.
          var niceName = {
            // contains a bunch of booth/wait list moderation events
            modAddDJ: 'plug/server/socket/modBooth',
            // contains subscription, XP, and PP events
            earn: 'plug/server/socket/currency',
            // contains multiple events for updates to the current room
            roomNameUpdate: 'plug/server/socket/roomUpdate',
            // this is actually the websocket manager module,
            // and it sets the window._gws property to undefined.
            // it really is just a false positive but we can abuse
            // it to get the proper module, anyway.
            // TODO detect this in a less stupid way
            _gws: 'plug/server/socket'
          }[prop.name] || 'plug/server/socket/' + prop.name
          mapping[name] = niceName
        }
      })
    }
    else if (mapping[orig] === 'plug/util/API') {
      getDependents(modules, orig).forEach(function (name) {
        var prop = findMemberExpressionName(modules[name].ast.body)
        if (prop) {
          var niceName = {
            getAdmins: 'admins',
            getAmbassadors: 'ambassadors',
            getAudience: 'audience',
            getBannedUsers: 'bannedUsers',
            getDJ: 'dj',
            getHistory: 'history',
            getHost: 'host',
            getMedia: 'media',
            getNextMedia: 'nextMedia',
            getScore: 'score',
            getStaff: 'staff',
            getTimeElapsed: 'playTime',
            getUser: 'users',
            getWaitList: 'waitlist',
            moderateForceSkip: 'moderator',
            sendChat: 'chat',
            setVolume: 'volume'
          }[prop.name] || prop.name
          mapping[name] = 'plug/util/api/' + niceName
        }
      })
    }
  }
}

function processRenames(ast, renames) {
  var renaming = new esrefactor.Context(ast)
  renames.forEach(function (r) {
    var id = renaming.identify(r.idx)
    if (id) {
      // rename manually.
      // esrefactor renames things "in-place" in the source code,
      // which means that you have to parse the source again every
      // time you rename a variable. Since we don't need to retain
      // formatting (it's minified code at this point, after all)
      // we can manually rename all variables at once without ever
      // parsing the source again.
      if (id.identifier) id.identifier.name = r.to
      if (id.declaration) id.declaration.name = r.to
      id.references.forEach(function (node) { node.name = r.to })
    }
  })
  return ast
}

function extract(modules, mapping) {
  var moduleNames = Object.keys(modules)
  var bar = progress('extracting files...', moduleNames.length)
  return Promise.each(moduleNames, function (name) {
    var ast = {
      type: 'Program',
      body: [ $.statement({
        type: 'CallExpression',
        callee: $.id('define'),
        arguments: [
          merge($.literal(name), {
            trailingComments: [ {
              type: 'Block',
              value: ' ' + (name in mapping ? mapping[name] : 'Unknown module')
            } ]
          }),
          modules[name].ast
        ]
      }) ]
    }
    return outputFile(name, mapping, escodegen.generate(ast, codegenOptions))
      .tap(bar.tick.bind(bar))
  }).return(modules)
}

function writeFile(name, content) {
  return mkdirp(path.dirname(name))
    .then(function () { return fs.writeFileAsync(name, content) })
}

function outputFile(name, mapping, beauty) {
  var file = path.join(program.out, name + '.js')
  return writeFile(file, beauty).then(function () {
    // set up symlinks from nicer paths
    if (mapping[name] && mapping[name].indexOf('plug/') === 0) {
      var niceFile = path.join(program.out, mapping[name] + '.js')
      return program.copy?   writeFile(niceFile, beauty)
           : /* otherwise */ makeLink(file, niceFile)
    }
  })
}

function makeLink(file, niceFile) {
  // cheaty use of path.relative to find link target path
  var linkTarget = path.relative('/' + path.dirname(niceFile), '/' + file)
  return mkdirp(path.dirname(niceFile))
    .then(function () { return fs.symlinkAsync(linkTarget, niceFile) })
}

function run(mapping, str) {
  var modules = parseModules(str)
  console.log('found', Object.keys(modules).length, 'modules.')
  modules = cleanModules(modules)
  addMappingForUnknownModules(modules, mapping)
  modules = remapModuleNames(modules, mapping)
  extract(modules, mapping)
    .tap(function () {
      return program.saveSource &&
        fs.writeFileAsync(path.join(program.out, 'source.js'), str)
    })
    .tap(function () {
      return program.saveMapping &&
        fs.writeFileAsync(path.join(program.out, 'mapping.json'),
                          JSON.stringify(mapping, null, 2))
    })
    .then(function () {
      return outputFile('version', {}, 'window._v = \'' + _v + '\';')
    })
    .then(function () { console.log('v' + _v + ' done') })
}

var mappingString
if (program.mapping) {
  mappingString = fs.readFileAsync(program.mapping, 'utf-8')
}
else {
  process.stdout.write('logging in to create mapping...')
  mappingString = plugLogin(requestOpts)
    .then(function (result) {
      console.log('  logged in to plug.dj')
      process.stdout.write('generating mapping...')
      return require('./lib/create-mapping')(result.jar)
    })
}

mappingString
  .then(JSON.parse)
  .then(function (result) {
    var mapping = result.mapping
    var sourceFile = result.appUrl
    // global!
    _v = result.version

    return Promise.props({
      mapping: mapping,
      src: /^https?:/.test(sourceFile)? fetchAppFile(sourceFile)
           : /* otherwise */            fs.readFileAsync(sourceFile, 'utf-8')
    })
  })
  .then(function (o) {
    return run(o.mapping, o.src)
  })
  .catch(function (e) { throw e })
