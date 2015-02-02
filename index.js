var request = require('request'),
  jsBeautify = require('js-beautify'),
  concat = require('concat-stream'),
  jsdom = require('jsdom'),
  ProgressBar = require('progress'),
  esrefactor = require('esrefactor'),
  each = require('each-async'),
  mkdirp = require('mkdirp'),
  path = require('path'),
  fs = require('fs'),
  Transform = require('stream').Transform

// poor lady's merge
var merge = function (o, a) {
  Object.keys(a).forEach(function (k) { o[k] = a[k] })
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

// beautifies source using js-beautify
function beautify(src) {
  return jsBeautify.js_beautify(src, {
    indent_size: 2
  , space_after_anon_function: true
  , brace_style: 'end-expand'
  })
}

// like concat-stream, but it throws the result of the given function back onto the stream output
function concatIntoStream(fn) {
  var stream = new Transform()
  stream.buffer = ''
  stream._transform = function (chunk, enc, cb) {
    this.buffer += chunk.toString()
    cb()
  }
  stream._flush = function (cb) {
    this.push(fn(this.buffer))
    cb()
  }
  return stream
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

// fetches unfancy files that don't need no logins
function fetchFiles() {
  request('https://plug.dj/', function (e, res) {
    var indexUrl = res.body.match(INDEX_JS)[1]
    var langUrl = res.body.match(LANG_JS)[1]

    request(langUrl)
      .pipe(concatIntoStream(beautify))
      .pipe(fs.createWriteStream(path.join(outdir, 'lang.js')))

    request(indexUrl)
      // this is probably broken now
      .pipe(concat(executeFile.bind(null, 'index')))

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
    var params = src.match(/\((?:[a-z_$]+,?)*\)/)[0].slice(1, -1).split(',')
    // will keep track of renames that we may want to do after building the source
    var renames = []
    var prelude = 'define(\'' + name + '\' /* ' + (mapping[name] || 'unknown') + ' */, ' +
                  'function (require, exports, module) {'
    var renameIdx = prelude.length
    // build javascript string of dependency require()s
    var deps = factory.deps.map(function (dep, i) {
      if (!params[i]) params[i] = '__' + i
      // rename variables according to their module names
      if (mapping[dep]) {
        var newName = mapping[dep].split('/').pop().replace(/-/g, '_')
        renames.push({ idx: renameIdx, to: newName })
        // the next rename index is going to be a few characters further after this rename
        // is executed. so we account for that immediately
        renameIdx += newName.length - params[i].length
      }
      var ret = 'var ' + params[i] + ' = require(\'' + dep + '\'); /* ' + (mapping[dep] || 'unknown') + ' */'
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

    if (renames.length) {
      // lol this is so inefficient, parsing the file again and again and again after every pass
      renames.forEach(function (r) {
        var renaming = new esrefactor.Context(fullCode)
        var id = renaming.identify(r.idx + 4)
        fullCode = renaming.rename(id, r.to)
      })
    }

    // <3
    var beauty = beautify(fullCode)

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