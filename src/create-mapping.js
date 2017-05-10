const Listr = require('listr')
const got = require('got')
const { JSDOM } = require('jsdom')
const bresolve = require('browser-resolve')
const Promise = require('bluebird')
const readFile = require('mz/fs').readFile

const pmPath = bresolve.sync('plug-modules', { filename: __filename })

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

function waitForRequireJs (window) {
  return new Promise((resolve, reject) => {
    // wait for the app javascript to load, then run plug-modules
    const intv = setInterval(waitForRequireJs, 20)
    function waitForRequireJs () {
      if (window.requirejs) {
        window.define('facebook', stubs.FB)
        // intercept plug.dj's booting code
        // plug.dj uses require([ deps ]) calls in places to actually start the
        // app. we do want those calls to register the dependencies with require,
        // but we don't want to start plug.dj because that's expensive and
        // usually throws an error somewhere. instead we override the callback
        // with an empty function :D
        const orig = window.require
        window.require = function require (arg) {
          if (Array.isArray(arg) && arg[0].indexOf('http') !== 0) {
            return orig(arg, () => {
              /* ... */
              resolve()
            })
          }
          return orig.apply(window, arguments)
        }
        Object.assign(window.require, orig)
        clearInterval(intv)
      }
    }
  })
}

const PLUG_ROOM_URL = 'https://plug.dj/plug-socket-test'

// Create a name mapping from plug.dj's obfuscated require.js module names to
// readable names by running plug-modules in a headless browser-like
// environment (aka jsdom).
// You need to be logged in to run plug-modules, so pass in a cookie jar with
// a valid session cookie.
module.exports = function createMapping (cookie, ctx) {
  const reqAsync = (req, id) => new Promise((resolve, reject) => req(id, resolve, reject))

  return new Listr([
    {
      title: 'Loading plug.dj',
      task: (ctx) =>
        got(PLUG_ROOM_URL, {
          headers: { cookie: cookie }
        }).then((response) => {
          ctx.source = response.body
        })
    },
    {
      title: 'Opening plug.dj',
      task: (ctx) => {
        ctx.dom = new JSDOM(ctx.source, {
          url: PLUG_ROOM_URL,
          runScripts: 'dangerously',
          resources: 'usable',
          beforeParse (window) {
            Object.assign(window, stubs)
            ctx.window = window
          }
        })
      }
    },
    {
      title: 'Injecting module mapping helper',
      task: (ctx) =>
        readFile(require.resolve('./get-mapping'), 'utf8').then((source) => {
          ctx.window.eval(source)
        })
    },
    {
      title: 'Waiting for plug.dj to finish loading',
      task: (ctx) => waitForRequireJs(ctx.window)
    },
    {
      title: 'Running plug-modules',
      task: (ctx) => readFile(pmPath, 'utf-8')
        // ensure that plugModules defines itself as "plug-modules"
        .then((plugModules) => plugModules.replace('define([', 'define("plug-modules",['))
        // insert plug-modules
        .then((src) => ctx.window.eval(src))
        .then(() => reqAsync(ctx.window.requirejs, [ 'plug-modules' ]))
        .then((pm) => ctx.window.getMapping(pm))
        .tap(() => ctx.window.close())
        .then(JSON.parse)
        .then((result) => {
          ctx.window = null
          ctx.mapping = result.mapping
          ctx.appUrl = result.appUrl
        })
    }
  ], { context: ctx })
}
