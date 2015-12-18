var fs = require('fs')
var path = require('path')
var Promise = require('bluebird')
var assign = require('object-assign')

var pmPath = path.join(__dirname, '../node_modules/plug-modules/plug-modules.js')

module.exports = createMapping

// stubs needed by plug.dj's app code at boot time
const stubs = {
  localStorage: {
    getItem () {},
    setItem () {},
    clear () {}
  },
  gapi: {
    client: {
      setApiKey () {},
      load () {}
    }
  },
  Intercom: {},
  amplitude: { __VERSION__: true },
  FB: { init: function () {} }
}

function jsdomEnv (opts) {
  return new Promise((resolve, reject) => {
    opts.done = (e, window) => {
      if (e) reject(e)
      else   resolve(window)
    }
    require('jsdom').env(opts)
  })
}

function waitForRequireJs (window) {
  return new Promise((resolve, reject) => {
    // wait for the app javascript to load, then run plug-modules
    var intv = setInterval(waitForRequireJs, 20)
    function waitForRequireJs () {
      if (window.requirejs) {
        window.define('facebook', stubs.FB)
        // intercept plug.dj's booting code
        // plug.dj uses require([ deps ]) calls in places to actually start the
        // app. we do want those calls to register the dependencies with require,
        // but we don't want to start plug.dj because that's expensive and
        // usually throws an error somewhere. instead we override the callback
        // with an empty function :D
        var orig = window.require
        window.require = function require (arg) {
          if (Array.isArray(arg) && arg[0].indexOf('http') !== 0) {
            return orig(arg, () => {
              /* ... */
              clearInterval(intv)
              resolve()
            })
          }
          return orig.apply(window, arguments)
        }
        assign(window.require, orig)
      }
    }
  })
}

// Create a name mapping from plug.dj's obfuscated require.js module names to
// readable names by running plug-modules in a headless browser-like
// environment (aka jsdom).
// You need to be logged in to run plug-modules, so pass in a cookie jar with
// a valid session cookie.
function createMapping (jar, cb) {
  return jsdomEnv({
    url: 'https://plug.dj/plug-socket-test',
    headers: {
      Cookie: jar.getCookieString('https://plug.dj/')
    },
    features: {
      FetchExternalResources: [ 'script' ],
      ProcessExternalResources: [ 'script' ]
    },
    src: [ // prevent getMapping.js autorun
           'window._REPLUG_AUTO = true'
           // will generate the mapping file
         , fs.readFileSync(path.join(__dirname, '../getMapping.js'), 'utf-8') ]
  })
    .tap(window => {
      // stub out some objects that plug needs at boot time
      assign(window, stubs)
      return waitForRequireJs(window)
    })
    .then(window => {
      var reqAsync = id => new Promise(window.requirejs.bind(null, id))

      return fs.readFileAsync(pmPath, 'utf-8')
        // ensure that plugModules defines itself as "plug-modules"
        .then(plugModules => plugModules.replace('define([', 'define("plug-modules",['))
        // insert plug-modules
        .then(src => window.eval(src))
        .then(() => reqAsync([ 'plug-modules' ]))
        .then(pm => window.getMapping(pm, true))
        .tap (() => window.close())
    })
}
