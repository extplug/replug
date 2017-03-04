#!/usr/bin/env node

import assign from 'object-assign'
import Promise from 'bluebird'
import program from 'commander'
import ProgressBar from 'progress'
import { parse } from 'babylon'
import File from 'babel-core/lib/transformation/file'
import traverse from 'babel-traverse'
import generate from 'babel-generator'
import * as t from 'babel-types'
import path from 'path'
import mkdirp from 'mkdirp-then'
import fs from 'mz/fs'
import login from 'plug-login'
import got from 'got'

import pkg from '../package.json'
import cleanAst from './clean-ast'
import createMappingFile from './create-mapping'

let _v

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

// formatting options! apparently like half of these get overridden though (?)
const babelGenOptions = {
  comments: true,
  quotes: 'single',
  indent: {
    style: '  '
  }
}

const moduleComment = (mapping, name) => ({
  type: 'Block',
  value: ' ' + (name in mapping ? mapping[name] : 'Unknown module')
})

const progress = (text, size) =>
  new ProgressBar(`${text} [:bar] :percent`, {
    total: size,
    width: 40,
    complete: '#',
    clear: true,
    callback () {
      console.log(`${text} done`)
    }
  })

function fetchAppFile (url) {
  return new Promise((resolve, reject) => {
    let contents = ''

    const stream = got.stream(url)
    stream.on('response', (res) => {
      const size = parseInt(res.headers['content-length'], 10)
      const bar = progress('downloading app javascript...', size)
      stream.on('data', (chunk) => {
        bar.tick(chunk.length)
        contents += chunk.toString('utf8')
      })
    })

    stream.on('error', reject)
    stream.on('end', () => resolve(contents))
  })
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

function sliceTokens (tokens, loc) {
  let start = 0
  while (tokens[start].start < loc.start) {
    start++
  }
  let end = start
  while (tokens[end].end < loc.end) {
    end++
  }
  return tokens.slice(start, end)
}

function parseModules (str) {
  const ast = parse(str)
  const modules = {}
  process.stdout.write('parsing javascript...')
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

        const tokens = sliceTokens(ast.tokens, node)
        const code = str.slice(node.start, node.end)

        const comments = []
        const program = t.file(
          t.program([ t.expressionStatement(factory) ]),
          comments,
          tokens
        )

        const file = new File()
        file.addAst(program)
        modules[name.value] = {
          deps,
          file,
          code,
          ast: factory
        }
      }
    }
  })
  console.log(' done')

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

function cleanModules (modules) {
  const names = Object.keys(modules)
  const bar = progress('cleaning module ASTs...', names.length)
  names.forEach((name) => {
    cleanAst(modules[name].file.ast)
    bar.tick()
  })
  return modules
}

function remapModuleNames (modules, mapping) {
  const names = Object.keys(modules)
  const bar = progress('remapping module names...', names.length)
  names.forEach((name) => {
    const { ast, deps } = modules[name]
    const params = ast.params && ast.params.map((param) => param.name)

    if (!params) {
      return bar.tick()
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

      return t.variableDeclaration('var', [
        t.variableDeclarator(
          t.identifier(params[i]),
          t.callExpression(t.identifier('require'), [
            assign(dep, {
              trailingComments: [ moduleComment(mapping, dep.value) ]
            })
          ])
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

    processRenames(modules[name].file.ast, renames)
    bar.tick()
  })

  return modules
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

function extract (modules, mapping) {
  const moduleNames = Object.keys(modules)
  const bar = progress('extracting files...', moduleNames.length)
  return Promise.each(moduleNames, (name) => {
    const mod = modules[name]
    const ast = t.program([
      t.expressionStatement(
        t.callExpression(t.identifier('define'), [
          assign(t.stringLiteral(name), {
            trailingComments: [ moduleComment(mapping, name) ]
          }),
          mod.ast
        ])
      )
    ])
    return outputFile(name, mapping, generate(ast, babelGenOptions, mod.code))
      .tap(bar.tick.bind(bar))
  }).return(modules)
}

function writeFile (name, content) {
  return mkdirp(path.dirname(name))
    .then(() => fs.writeFile(name, content))
}

function outputFile (name, mapping, code) {
  const file = path.join(program.out, `${name}.js`)
  return writeFile(file, code.code).then(() => {
    // set up symlinks from nicer paths
    if (mapping[name] && mapping[name].indexOf('plug/') === 0) {
      const niceFile = path.join(program.out, `${mapping[name]}.js`)
      return program.copy
        ? writeFile(niceFile, code.code)
        : makeLink(file, niceFile)
    }
  })
}

function makeLink (file, niceFile) {
  // cheaty use of path.relative to find link target path
  const linkTarget = path.relative('/' + path.dirname(niceFile), `/${file}`)
  return mkdirp(path.dirname(niceFile))
    .then(() => fs.symlink(linkTarget, niceFile))
}

function run (mapping, str) {
  let modules = parseModules(str)
  console.log('found', Object.keys(modules).length, 'modules.')
  modules = cleanModules(modules)
  addMappingForUnknownModules(modules, mapping)
  modules = remapModuleNames(modules, mapping)
  extract(modules, mapping)
    .tap(() => program.saveSource &&
      fs.writeFile(path.join(program.out, 'source.js'), str)
    )
    .tap(() => program.saveMapping &&
      fs.writeFile(path.join(program.out, 'mapping.json'),
                   JSON.stringify(mapping, null, 2))
    )
    .then(() => outputFile('version', {}, `window._v = '${_v}';`))
    .then(() => console.log(`v${_v} done`))
}

let mappingString
if (program.mapping) {
  mappingString = fs.readFile(program.mapping, 'utf-8')
} else {
  process.stdout.write('logging in to create mapping...')
  mappingString = login.guest()
    .then((result) => {
      console.log('  logged in to plug.dj')
      process.stdout.write('generating mapping...')
      return createMappingFile(result.cookie)
    })
    .catch((err) => {
      console.log('')
      console.error('Could not log in.')
      console.error(err.stack || err.message || err)
    })
}

mappingString
  .then(JSON.parse)
  .then((result) => {
    const mapping = result.mapping
    const sourceFile = result.appUrl
    // global!
    _v = result.version

    return Promise.props({
      mapping,
      src: /^https?:/.test(sourceFile)
        ? fetchAppFile(sourceFile)
        : fs.readFile(sourceFile, 'utf-8')
    })
  })
  .then((o) => run(o.mapping, o.src))
  .catch((e) => { throw e })
