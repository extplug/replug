var request = require('request'),
  jsdom = require('jsdom'),
  ProgressBar = require('progress'),
  esrefactor = require('esrefactor'),
  esprima = require('esprima'),
  estraverse = require('estraverse'),
  escodegen = require('escodegen'),
  each = require('each-async'),
  mkdirp = require('mkdirp'),
  path = require('path'),
  fs = require('fs')

// poor lady's merge
var merge = function (o, a) {
  Object.keys(a).forEach(function (k) { o[k] = a[k] })
}

// formatting for escodegen
var codegenOptions = {
  format: { indent: { style: '  ' } }
}

// creates a fake require function that only keeps track of modules,
// but does not instantiate them
function fakeRequire() {
  var _factories = {}
  var conf = {}
  function require(val) {
    // hehe
  }
  // (we don't actually use the config!)
  // (but someday we might!)
  require.config = function (obj) {
    obj && merge(conf, obj)
    return conf
  }

  require.define = function (val, deps, factory) {
    if (typeof deps === 'function') factory = deps, deps = []
    _factories[val] = { fn: factory, deps: deps }
  }

  // list registered module names
  require.list = function () { return Object.keys(_factories) }

  // returns registered modules
  require.factories = function () { return _factories }

  return require
}

// hardcoded because fuck everything
var outdir = './out/'
fs.mkdir(outdir, function (e) { /* errors are for pimps */ })

function fetchAppFile(url) {
  request(url, function (e, res) {
    if (e) throw e
    executeFile('app', res.body)
  })
}

function variableNameFor(dep) {
  var libraryNames = {
    jquery: '$',
    backbone: 'Backbone',
    handlebars: 'Handlebars',
    underscore: '_'
  }
  return dep in libraryNames
       ? libraryNames[dep]
       : mapping[dep].split('/').pop().replace(/-/g, '_')
}

// it's called "executeFile" but it actually gets module definitions from the given js source,
// finds possible non-stupid names for the modules, renames variables for dependencies,
// rewrites AMD stuff into a more commonjs-y style, beautifies, extracts the modules into a
// folder, and symlinks their non-stupid names to the extracted files
function executeFile(outfile, js) {
  var dom = jsdom.jsdom()
  var w = dom.parentWindow
  // initialize DOM
  var r = fakeRequire(w)
  merge(w, {
    requirejs: r, require: r, define: r.define,
    Raygun: { init: function () { return w.Raygun }
            , withTags: function () {}
            , setVersion: function () {} },
    localStorage: { getItem: function () {},
                    setItem: function () {},
                    clear: function () {} }
  })

  // define default modules
  // for lack of require.js's shim config
  r.define('backbone', [], function () { return w.Backbone })
  r.define('underscore', [], function () { return w._ })
  r.define('jquery', [], function () { return w.jQuery })

  // stub out some jQuery stuff that's used by plug.dj dependencies before it boots
  w.jQuery = function () {}
  w.jQuery.easing = {}
  w.jQuery.event = { special: {} }
  w.jQuery.fn = { extend: function () {} }

  // run plug.dj code so we can easily extract the modules
  try {
    // set process to undefined to fool handlebars's nodejs detection
    // yes, that is a "with()" statement
    Function('window,jQuery', 'var process=void 0;with(window)'+(js)).call(w, w, w.jQuery)
  }
  catch (e) {
    // we get an error about `define` not being defined, somehow,
    // but everything basically works anyway, so we just ignore
    console.warn('ignoring error', e)
  }

  var allModuleNames = r.list()

  console.log('Found ' + allModuleNames.length + ' require.js modules.')
  console.log('Now renaming, formatting, and extracting...')

  // show a progress bar while we parse a few hundred files a total of tens of thousands of times
  // because all existent refactoring modules are basically shit <3
  var bar = new ProgressBar('[:bar] :current/:total (:percent)', {
    total: allModuleNames.length,
    width: 50,
    complete: '#',
    incomplete: '-'
  })

  // loop over all registered modules
  each(allModuleNames, function (name, i, cb) {
    var factory = r.factories()[name]
    // actual module source!
    var src = factory.fn.toString()
    // non-beautified javascript, all parameters are nicely bunched up together
    // so we can get away with this braindead regex
    var params = src.match(/\((?:[a-z_$]+,?)*\)/i)[0].slice(1, -1).split(',')
    // will keep track of renames that we may want to do after building the source
    var renames = []
    var prelude = 'define(\'' + name + '\', ' +
                  'function (require, exports, module) {'
    var renameIdx = prelude.length
    // build javascript string of dependency require()s
    var deps = factory.deps.map(function (dep, i) {
      if (!params[i]) params[i] = '__' + i
      // rename variables according to their module names
      if (mapping[dep]) {
        var newName = variableNameFor(dep)
        renames.push({ idx: renameIdx + 4, to: newName })
      }
      else if (/^hbs!templates\//.test(dep)) {
        renames.push({ idx: renameIdx + 4, to: 'template' + dep.split('/').pop() })
      }
      var ret = 'var ' + params[i] + ' = require(\'' + dep + '\');'
      // next rename index is right after this statement
      renameIdx += ret.length
      return ret
    }).join('')

    // actual module source! no more function () {} toString-ed boilerplate everywhere
    var start = src.indexOf('{'), end = src.lastIndexOf('}')
    src = deps + src.substring(start + 1, end)
    var fullCode = prelude + src + '})'

    // output file name
    var file = path.join(outdir, outfile, name + '.js')

    var ast = esprima.parse(fullCode, { range: true })

    // find and rename original var name of the module return value
    ;(function () {
      var body = ast.body
      if (body.length <= 0 ||
          body[0].type !== 'ExpressionStatement' ||
          body[0].expression.type !== 'CallExpression') {
        return
      }
      var defineCall = ast.body[0].expression
      if (defineCall.callee.name !== 'define') return
      var defineFactory = defineCall.arguments[1]
      var defineBody = defineFactory.body.body
      var lastStatement = defineBody[defineBody.length - 1]
      if (lastStatement.type !== 'ReturnStatement') return
      var returnId = lastStatement.argument.type === 'NewExpression'
                   ? lastStatement.argument.callee
                   : lastStatement.argument
      if (returnId.type === 'Identifier') {
        renames.push({
          idx: returnId.range[0],
          to: variableNameFor(name)
        })
      }
    }())

    if (renames.length) {
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
    }

    // some more formatting!
    // expand mangled function bodies into separate statements
    var toStatement = function (expr) { return { type: 'ExpressionStatement', expression: expr } }
    // expand ternary expression statements into if(){}else{} blocks
    var expandTernary = function (expr) {
      return {
        type: 'IfStatement',
        test: expr.test,
        consequent: toStatement(expr.consequent),
        alternate: expr.alternate.type === 'ConditionalExpression' ? expandTernary(expr.alternate) : toStatement(expr.alternate)
      }
    }
    var wrapBlock = function (stmt) { return { type: 'BlockStatement', body: [ stmt ] } }
    estraverse.traverse(ast, {
      enter: function (node) {
        // add braces around branch/loop constructs if they are not yet present
        if (node.type === 'IfStatement') {
          if (node.consequent.type !== 'BlockStatement') {
            node.consequent = wrapBlock(node.consequent)
          }
          if (node.alternate && node.alternate !== 'BlockStatement') {
            node.alternate = wrapBlock(node.alternate)
          }
        }
        else if (node.type === 'ForStatement' ||
                 node.type === 'WhileStatement') {
          if (node.body.type !== 'BlockStatement') {
            node.body = wrapBlock(node.body)
          }
        }
        // expand some expressions
        if (node.type === 'BlockStatement') {
          node.body = node.body.reduce(function (newBody, node) {
            // expand comma-separated expressions on a single line to multiple statements
            if (node.type === 'ExpressionStatement' &&
                node.expression.type === 'SequenceExpression') {
              return newBody.concat(node.expression.expressions.map(toStatement))
            }
            // expand comma-separated expressions in a return statement to multiple statements
            else if (node.type === 'ReturnStatement' &&
                     node.argument &&
                     node.argument.type === 'SequenceExpression') {
              var exprs = node.argument.expressions
              node.argument = exprs.pop()
              return newBody.concat(exprs.map(toStatement)).concat([ node ])
            }
            // expand ternary ?: statements to if/else statements
            else if (node.type === 'ExpressionStatement' &&
                     node.expression.type === 'ConditionalExpression') {
              return newBody.concat([ expandTernary(node.expression) ])
            }
            // expand compressed &&, || expressions into if/else statements
            else if (node.type === 'ExpressionStatement' &&
                     node.expression.type === 'LogicalExpression' &&
                     node.expression.operator === '&&') {
              return newBody.concat([ {
                type: 'IfStatement',
                test: node.expression.left,
                consequent: toStatement(node.expression.right)
              } ])
            }
            return newBody.concat([ node ])
          }, [])
        }
      },
      leave: function (node) {
        // remove braces from else statements that contain only an if statement
        // (i.e. else if statements)
        if (node.type === 'IfStatement' &&
            node.alternate && node.alternate.type === 'BlockStatement' &&
            node.alternate.body.length === 1 && node.alternate.body[0].type === 'IfStatement') {
          node.alternate = node.alternate.body[0]
        }
      }
    })

    // <3
    var beauty = escodegen.generate(ast, codegenOptions)

    // wanna check if it exists? nah...
    mkdirp(path.dirname(file), function (e) {
      if (e) return cb(e)
      var m
      fs.writeFile(file, beauty, function (e) {
        if (e) return cb(e)
        // set up symlinks from nicer paths
        if (mapping[name] && mapping[name].indexOf('plug/') === 0) {
          var niceFile = path.join(outdir, outfile, mapping[name] + '.js')
          makeLink(file, niceFile, cb)
        }
        // websocket event receiver modules don't export anything,
        // so they cannot be identified individually by plug-modules.
        // however, we have accesss to their full source here, so
        // we can extract them anyway!
        // socket event receivers set properties on a shared object,
        // which will actually be require()d by plug.dj source code,
        // and which can also be identified by plug-modules. this occurs
        // *after* beautification and renaming, so we can just check
        // for assignments on an object named "socketReceiver" to find
        // the separate event receiver modules.
        else if (m = /socketReceiver\.([a-z0-9A-Z]+) =/.exec(beauty)) {
          // some of these modules have multiple event receivers, so we
          // rename them to be a bit more clear.
          var srName = {
            // contains a bunch of booth/wait list moderation events
            modAddDJ: 'modBooth',
            // contains subscription, XP, and PP events
            earn: 'currency',
            // contains multiple events for updates to the current room
            roomNameUpdate: 'roomUpdate'
          }[m[1]] || m[1]
          // store this in the mapping, so future modules can still
          // rename it properly.
          // (earlier modules will not have use new name)
          mapping[name] = 'plug/server/socket/' + srName
          makeLink(file,
                   path.join(outdir, outfile, mapping[name] + '.js'),
                   cb)
        }
        // the public js API object is built in a similar manner to
        // the socket event receiver object, so we use a similar method
        // to extract it.
        else if (m = /API\.([a-z0-9A-Z]+) =/.exec(beauty)) {
          var acName = {
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
          }[m[1]] || m[1]
          mapping[name] = 'plug/util/api/' + acName
          makeLink(file,
                   path.join(outdir, outfile, mapping[name] + '.js'),
                   cb)
        }
        // the websocket module does not export anything.
        // luckily, it is the only module that sends an AuthTokenAction,
        // so we can use that instead.
        else if (beauty.indexOf('new AuthTokenAction') !== -1) {
          makeLink(file,
                   path.join(outdir, outfile, 'plug/server/socket.js'),
                   cb)
        }
        else {
          cb()
        }
      })
    })

    bar.tick()
  }, function (e) {
    if (e) {
      throw e
    }
    console.log('Extracted into ' + path.join(outdir, outfile))
  })
}

function makeLink(file, niceFile, cb) {
  mkdirp(path.dirname(niceFile), function (e) {
    if (e) return cb(e)
    // you may wanna remove your output dir every time because you can't symlink shit
    // if a file by the symlink's name already exists
    try {
      // cheaty use of path.relative to find link target path
      fs.symlink(path.relative('/' + path.dirname(niceFile), '/' + file), niceFile, cb)
    }
    catch (e) {
      cb(e)
    }
  })
}

// global lmao
var mapping
fs.readFile(process.argv[2], { encoding: 'utf8' }, function (e, c) {
  if (e) throw e
  // parses module name mappings from the given file
  var result = JSON.parse(c)
  mapping = result.mapping
  sourceFile = result.appUrl

  // fetches the application js file
  if (/^https?:/.test(sourceFile)) {
    fetchAppFile(sourceFile)
  }
  else {
    fs.readFile(sourceFile, { encoding: 'utf8' }, function (e, c) {
      executeFile('app', c)
    })
  }
})