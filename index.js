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
  fs = require('fs'),
  Transform = require('stream').Transform

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

// stupid url matching regexes
var INDEX_JS = /"(.*?cdn\.plug\.dj\/_\/static\/js\/index\..*?\.js)"/
var CORE_JS = /"(.*?cdn\.plug\.dj\/_\/static\/js\/core\..*?\.js)"/
var APP_JS = /"(.*?cdn\.plug\.dj\/_\/static\/js\/app\..*?\.js)"/
var LANG_JS = /src="(.*?cdn\.plug\.dj\/_\/static\/js\/lang\/en\..*?\.js)"/

function fetchAppFile(url) {
  request(url, function (e, res) {
    if (e) throw e
    executeFile('app', res.body)
  })
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

  // stub out some jQuery stuff that's used by plug.dj dependencies before it even boots
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
    console.log('swallow error', e)
  }

  var allModuleNames = r.list()

  console.log('going to walk through ' + allModuleNames.length + ' modules now, renaming lots of shit,')
  console.log('and parsing files again after every rename')
  console.log('this might take a while...')

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
        var newName = mapping[dep].split('/').pop().replace(/-/g, '_')
        renames.push({ idx: renameIdx, to: newName })
      }
      else if (/^hbs!templates\//.test(dep)) {
        renames.push({ idx: renameIdx, to: 'template' + dep.split('/').pop() })
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
    if (renames.length) {
      var renaming = new esrefactor.Context(ast)
      renames.forEach(function (r) {
        var id = renaming.identify(r.idx + 4)
        if (id) {
          if (id.identifier) id.identifier.name = r.to
          if (id.declaration) id.declaration.name = r.to
          id.references.forEach(function (node) { node.name = r.to })
        }
      })
    }

    // expand mangled function bodies into separate statements
    var toStatement = function (expr) { return { type: 'ExpressionStatement', expression: expr } }
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
        // remove braces from if statements inside else statements
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
      if (e) cb(e)
      else fs.writeFile(file, beauty, function (e) {
        // set up symlinks from nicer paths
        if (!e && mapping[name] && mapping[name].indexOf('plug/') === 0) {
          var niceFile = path.join(outdir, outfile, mapping[name] + '.js')
          mkdirp.sync(path.dirname(niceFile))
          // you may wanna remove your output dir every time because you can't symlink shit
          // if a file by the symlink's name already exists
          try {
            // cheaty use of path.relative to find link target path
            fs.symlinkSync(path.relative('/' + path.dirname(niceFile), '/' + file), niceFile)
          }
          catch (e) {
            // could not symlink stuff, who the fuck cares
          }
        }

        cb(e)
      })
    })

    bar.tick()
  }, function (e) {
    if (e) {
      console.log('something blew up')
      throw e
    }
    console.log('there should be a bunch of files in', outfile + '/', 'now')
  })
}

// global lmao
var mapping
fs.readFile(process.argv[3], { encoding: 'utf8' }, function (e, c) {
  if (e) throw e
  // parses module name mappings from the given file
  mapping = c.split(' ').reduce(function (mapping, str) {
    str = str.split('=')
    mapping[str[0]] = str[1]
    return mapping
  }, {})

  // fetches the application js file and does magical fucking shit
  fetchAppFile(process.argv[2])
})