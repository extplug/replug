var fs = require('fs')
var path = require('path')

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

// Create a name mapping from plug.dj's obfuscated require.js module names to
// readable names by running plug-modules in a headless browser-like
// environment (aka jsdom).
// You need to be logged in to run plug-modules, so pass in a cookie jar with
// a valid session cookie.
function createMapping(jar, cb) {
  var jsdom = require('jsdom')
  jsdom.env({
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
         , fs.readFileSync('./getMapping.js', 'utf-8') ],
    done: function (e, window) {
      if (e) return cb(e)
      // stub out some objects that plug needs at boot time
      window.localStorage = stubs.localStorage
      window.gapi = stubs.gapi

      // wait for the app javascript to load, then run plug-modules
      var intv = setInterval(waitForRequireJs, 20)
      function waitForRequireJs() {
        if (window.requirejs && window.requirejs.defined('lang/Lang')) {
          clearInterval(intv)

          var plugModules = fs.readFileSync(pmPath, 'utf-8')
          // ensure that plugModules defines itself as "plug-modules"
          plugModules = plugModules.replace('define([', 'define("plug-modules",[')
          // insert plug-modules
          window.eval(plugModules)

          window.requirejs([ 'plug-modules' ], function (pm) {
            var mapping = window.getMapping(pm, true)
            window.close()
            cb(null, mapping)
          })
        }
      }
    }
  })
}