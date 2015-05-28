// don't run automatically when called by replug
if (!window._REPLUG_AUTO) {
  if (require.defined('plug-modules')) {
    getMapping(require('plug-modules'));
  }
  else if (typeof window.plugModules !== 'undefined') {
    getMapping(window.plugModules);
  }
  else {
    require([ 'https://rawgit.com/ExtPlug/plug-modules/master/plug-modules.js' ], getMapping);
  }
}

function getMapping(plugModules, returnOnly) {

  plugModules.run();

  var knownKeys = _.keys(plugModules._nameMapping);
  var unknownKeys = plugModules.getUnknownModules();

  var knownModules = knownKeys.map(function (key) {
    return {
      isUnknown: false,
      name: key,
      original: plugModules.resolveName(key),
      module: plugModules.require(key)
    };
  });
  var unknownModules = unknownKeys.map(function (key) {
    return {
      isUnknown: true,
      name: '?',
      original: key,
      module: plugModules.require(key)
    };
  });

  // build mappings
  var partsMapping = {};
  knownModules.forEach(function (mod) {
    var name = mod.name.split('/'),
      obsc = mod.original.split('/');

    obsc.forEach(function (part, i) {
      partsMapping[part] = name[i];
    });
  });

  // guess module names based on known paths
  unknownModules.forEach(function (mod) {
    mod.name = mod.original.split('/').map(function (part) {
      return partsMapping[part] || part;
    }).join('/');
  });

  // modules that were not remapped by plug-modules, but were partially guessed
  var unknownPlugModules = unknownModules.filter(function (mod) {
    return mod.name.indexOf('plug/') === 0;
  });

  // build full mapping of original names to (possibly partially guessed) proper names
  var fullMapping = {};
  knownModules.concat(unknownModules).forEach(function (mod) {
    fullMapping[mod.original] = mod.name;
  });

  // get app.js file url ( it appears in one of the inline <script> tags)
  var js = $('script:not([src])').text();
  var appUrl = /cdn\.plug\.dj\/_\/static\/js\/app\..*?\.js/.exec(js)[0];
  var version = /_v="(.*?)"/.exec(js)[1];

  var result = JSON.stringify({
    version: version,
    appUrl: 'https://' + appUrl,
    mapping: fullMapping
  });

  if (!returnOnly) {
    var dl = document.createElement('a');
    dl.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(result));
    dl.setAttribute('download', 'mapping.json');
    document.body.appendChild(dl);
    dl.click();
    document.body.removeChild(dl);
  }

  return result;

}
