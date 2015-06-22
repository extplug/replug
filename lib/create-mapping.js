var fs = require('fs')
var path = require('path')
var Promise = require('bluebird')

var pmPath = path.join(__dirname, '../node_modules/plug-modules/plug-modules.js')

module.exports = createMapping

// stubs needed by plug.dj's app code at boot time
var stubs = {
  localStorage: {
    getItem: function () {},
    setItem: function () {},
    clear: function () {}
  },
  gapi: {
    client: {
      setApiKey: function () {},
      load: function () {}
    }
  }
}

function jsdomEnv(opts) {
  return new Promise(function (resolve, reject) {
    opts.done = function (e, window) {
      if (e) reject(e)
      else   resolve(window)
    }
    require('jsdom').env(opts)
  })
}

function waitForRequireJs(window) {
  return new Promise(function (resolve, reject) {
    // wait for the app javascript to load, then run plug-modules
    var intv = setInterval(waitForRequireJs, 20)
    function waitForRequireJs() {
      if (window.requirejs && window.requirejs.defined('lang/Lang')) {
        clearInterval(intv)
        resolve()
      }
    }
  })
}

// Create a name mapping from plug.dj's obfuscated require.js module names to
// readable names by running plug-modules in a headless browser-like
// environment (aka jsdom).
// You need to be logged in to run plug-modules, so pass in a cookie jar with
// a valid session cookie.
function createMapping(jar, cb) {
  return jsdomEnv({
    url: 'https://plug.dj/dashboard',
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
         , fs.readFileSync('./getMapping.js', 'utf-8') ]
  })
    .tap(function (window) {
      // stub out some objects that plug needs at boot time
      window.localStorage = stubs.localStorage
      window.gapi = stubs.gapi
      return waitForRequireJs(window)
    })
    .then(function (window) {
      var reqAsync = function (id) {
        return new Promise(window.requirejs.bind(null, id))
      }

      return fs.readFileAsync(pmPath, 'utf-8')
        .then(function (plugModules) {
          // ensure that plugModules defines itself as "plug-modules"
          return plugModules.replace('define([', 'define("plug-modules",[')
        })
        // insert plug-modules
        .then(function (src) { return window.eval(src) })
        .then(function ()    { return reqAsync([ 'plug-modules' ]) })
        .then(function (pm)  { return window.getMapping(pm, true) })
        .tap (function ()    { window.close() })
    })
}