function getMapping(plugModules) {

  plugModules.run();

  var knownKeys = Object.keys(plugModules._nameMapping);
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

  var scriptSources = $('script[src*="cdn.plug"]').map(function (e) {
    return this.src;
  });

  // get plug.dj version (it appears in one of the inline <script> tags)
  var js = $('script:not([src])').text();
  var version = /_v="(.*?)"/.exec(js)[1];

  var appUrl = find(scriptSources, contains('js/app'));
  var langUrl = find(scriptSources, contains('js/lang/'));
  var avatarsUrl = find(scriptSources, contains('js/avatars'));

  return JSON.stringify({
    version: version,
    appUrl: appUrl,
    langUrl: langUrl,
    avatarsUrl: avatarsUrl,
    mapping: fullMapping
  });

  function find(arr, fn) {
    for (var i = 0, l = arr.length; i < l; i++)
      if (fn(arr[i])) return arr[i]
  }
  function contains(str) {
    return function (src) { return src.indexOf(str) > 0 }
  }
}
