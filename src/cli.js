#!/usr/bin/env node

const Listr = require('listr')
const updateRenderer = require('listr-update-renderer')
const verboseRenderer = require('listr-verbose-renderer')
const chalk = require('chalk')
const Promise = require('bluebird')
const program = require('commander')
const { parse } = require('babylon')
const traverse = require('babel-traverse').default
const generate = require('prettier').__debug.formatAST
const t = require('babel-types')
const path = require('path')
const mkdirp = require('mkdirp-then')
const fs = require('mz/fs')
const login = require('plug-login')
const got = require('got')

const pkg = require('../package.json')
const cleanAst = require('./clean-ast')
const createMappingFile = require('./create-mapping')

let _v

program
  .usage('[options]')
  .version(pkg.version)
  .option('-m, --mapping [file]', 'File containing the mapping JSON ' +
            '(optional, it\'s auto-generated if no file is given)')
  .option('-o, --out [dir]', 'Output directory [out/]', 'out/')
  .option('-v, --verbose', 'Use verbose output instead of bullet list', false)
  .parse(process.argv)

async function fetchAppFile (url, progress) {
  const response = got(url)
  response.on('downloadProgress', ({ transferred, total }) => {
    progress(transferred, total)
  })
  const { body } = await response
  return body
}

function variableNameFor (dep, mapping) {
  const libraryNames = {
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

function parseModules (str, progress) {
  const ast = parse(str)
  const modules = {}
  traverse(ast, {
    CallExpression ({ node }) {
      if (t.isIdentifier(node.callee, { name: 'define' })) {
        let [ name, deps, factory ] = node.arguments
        if (t.isArrayExpression(deps)) {
          deps = deps.elements
        } else {
          factory = deps
          deps = []
        }

        const code = str.slice(node.start, node.end)

        const file = t.file(
          t.program([ t.expressionStatement(factory) ]),
          [], [])

        progress(name.value)
        modules[name.value] = {
          deps,
          code,
          file,
          ast: factory
        }
      }
    }
  })

  progress(null)
  return modules
}

function findReturnVar (ast) {
  const lastSt = ast.body[ast.body.length - 1]
  if (t.isReturnStatement(lastSt)) {
    const retVal = lastSt.argument
    return t.isNewExpression(retVal)
      ? retVal.callee
      : t.isIdentifier(retVal) && retVal.name !== 'undefined'
      ? retVal
      : null
  }
}

async function cleanModules (modules, progress) {
  const names = Object.keys(modules)
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]

    cleanAst(modules[name].file)

    await progress(i + 1, names.length)
  }
}

async function remapModuleNames (modules, mapping, progress) {
  const names = Object.keys(modules)

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    const { ast, deps } = modules[name]
    const params = ast.params && ast.params.map((param) => param.name)

    if (!params) {
      await progress(index + 1, names.length)
      continue
    }

    const renames = []
    // build ast of dependency require()s
    const depsAst = deps.map((dep, i) => {
      if (!params[i]) {
        params[i] = '__' + i
      }

      let newName = 'unknown'
      // rename variables according to their module names
      if (mapping[dep.value]) {
        newName = variableNameFor(dep.value, mapping)
        renames.push({ from: params[i], to: newName })
      } else if (/^hbs!templates\//.test(dep.value)) {
        newName = 'template' + dep.value.split('/').pop()
        renames.push({ from: params[i], to: newName })
      }

      if (dep.value in mapping) {
        const originalName = dep.value
        dep.value = mapping[originalName]
        dep.extra.raw = JSON.stringify(dep.value)
        dep.comments = [
          { type: 'Block', value: ` was ${originalName}`, trailing: true }
        ]
      } else {
        dep.comments = [
          { type: 'Block', value: ' Unknown module', trailing: true }
        ]
      }

      return t.variableDeclaration('var', [
        t.variableDeclarator(
          t.identifier(params[i]),
          t.callExpression(t.identifier('require'), [dep])
        )
      ])
    })

    // move dependencies from the define() call
    // to the factory body
    ast.body.body = depsAst.concat(ast.body.body)
    ast.params = [
      t.identifier('require'),
      t.identifier('exports'),
      t.identifier('module')
    ]

    const returnVar = findReturnVar(ast.body)
    if (returnVar) {
      renames.push({
        from: returnVar.name,
        to: variableNameFor(name, mapping)
      })
    }

    processRenames(modules[name].file, renames)

    await progress(index + 1, names.length)
  }
}

function getDependents (modules, name) {
  const isDep = (d) => d.value === name

  return Object.keys(modules).filter((name) =>
    modules[name].deps.some(isDep)
  )
}

function findMemberExpressionName (ast) {
  const body = ast.body
  for (let i = 0, l = body.length; i < l; i++) {
    if (t.isExpressionStatement(body[i]) &&
        t.isAssignmentExpression(body[i].expression) &&
        t.isMemberExpression(body[i].expression.left) &&
        t.isIdentifier(body[i].expression.left.object)) {
      return body[i].expression.left.property
    }
  }
}

function addMappingForUnknownModules (modules, mapping) {
  for (const orig in mapping) {
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
      getDependents(modules, orig).forEach((name) => {
        const prop = findMemberExpressionName(modules[name].ast.body)
        if (prop) {
          // some of these modules have multiple event receivers, so we
          // rename them to be a bit more clear.
          const niceName = {
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
    } else if (mapping[orig] === 'plug/util/API') {
      getDependents(modules, orig).forEach((name) => {
        const prop = findMemberExpressionName(modules[name].ast.body)
        if (prop) {
          const niceName = {
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

function processRenames (ast, renames) {
  traverse(ast, {
    FunctionExpression (path) {
      renames.forEach(({ from, to }) => {
        if (path.scope.hasBinding(to)) {
          path.scope.rename(to, path.scope.generateUid(to))
        }
        path.scope.rename(from, to)
      })
      path.stop()
    }
  })
  return ast
}

function extract (modules, mapping, progress) {
  const moduleNames = Object.keys(modules)
  return Promise.each(moduleNames, (name, i) => {
    const mod = modules[name]

    const moduleIdentifier = t.stringLiteral(name)
    if (name in mapping) {
      moduleIdentifier.raw = JSON.stringify(mapping[name])
      moduleIdentifier.value = mapping[name]
      moduleIdentifier.comments = [
        { type: 'Block', value: ` was ${name}`, trailing: true }
      ]
    } else {
      moduleIdentifier.raw = JSON.stringify(name)
      moduleIdentifier.comments = [
        { type: 'Block', value: ' Unknown module', trailing: true }
      ]
    }

    const ast = t.program([
      t.expressionStatement(
        t.callExpression(t.identifier('define'), [
          moduleIdentifier,
          mod.ast
        ])
      )
    ])
    const code = generate(ast, { originalText: '', singleQuote: true })
    return outputFile(name, mapping, code.formatted).then(() => {
      progress(i + 1, moduleNames.length)
    })
  })
}

function writeFile (name, content) {
  return mkdirp(path.dirname(name))
    .then(() => fs.writeFile(name, content))
}

function outputFile (name, mapping, code) {
  const file = path.join(program.out, `${name}.js`)
  return writeFile(file, code).then(() => {
    // set up symlinks from nicer paths
    if (mapping[name] && mapping[name].indexOf('plug/') === 0) {
      const niceFile = path.join(program.out, `${mapping[name]}.js`)
      return writeFile(niceFile, code)
    }
  })
}

function progress (task) {
  const title = task.title
  return (current, total) => {
    if (typeof current === 'string') {
      task.title = `${title} ${chalk.gray(current)}`
    } else if (typeof current === 'number' && current < total) {
      const percent = chalk.gray(`${Math.floor((current / total) * 100)}%`)
      task.title = `${title} ${percent}`
    } else {
      task.title = title
    }
  }
}

const renderer = program.verbose
  ? verboseRenderer
  : updateRenderer
const main = new Listr([
  {
    title: 'Logging in to plug.dj',
    task: (ctx) =>
      Promise.resolve(login.guest()).tap((result) => {
        ctx.session = result
      })
  },
  {
    title: 'Generating module name mapping',
    task: (ctx) => createMappingFile(ctx.session.cookie, ctx)
  },
  {
    title: 'Downloading application file',
    task: (ctx, task) => fetchAppFile(ctx.appUrl, progress(task)).then((src) => {
      ctx.src = src
    })
  },
  {
    title: 'Parsing modules',
    task: (ctx, task) => Promise.delay(100).then(() => {
      ctx.modules = parseModules(ctx.src, progress(task))
    }).delay(100)
  },
  {
    title: 'Cleaning modules',
    task: (ctx, task) => cleanModules(ctx.modules, progress(task))
  },
  {
    title: 'Finding correct names for special modules',
    task: (ctx) => Promise.delay(100).then(() => {
      addMappingForUnknownModules(ctx.modules, ctx.mapping)
    }).delay(100)
  },
  {
    title: 'Remapping module names',
    task: (ctx, task) => remapModuleNames(ctx.modules, ctx.mapping, progress(task))
  },
  {
    title: 'Extracting files',
    task: (ctx, task) =>
      extract(ctx.modules, ctx.mapping, progress(task))
        .tap(() => fs.writeFile(path.join(program.out, 'source.js'), ctx.src))
        .tap(() => fs.writeFile(path.join(program.out, 'mapping.json'),
          JSON.stringify(ctx.mapping, null, 2)))
        .then(() => outputFile('version', {}, `window._v = '${_v}';`))
        .then(() => console.log(`v${_v} done`))
  }
], { renderer: renderer })

main.run().catch((e) => {
  setImmediate(() => {
    throw e
  })
})
