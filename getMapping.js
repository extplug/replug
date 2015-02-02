// first run:
// https://github.com/PlugLynn/plug-modules/blob/master/plug-modules.js
// which figures out decent names for a bunch of stuff
// then run this on plug.dj while logged in

var modules = require.s.contexts._.defined;

var knownKeys = Object.keys(modules).filter(function (a) {
  return a.indexOf('plug/') === 0 && // remapped by plug-modules
    modules[a];                      // non-null
});
var unknownKeys = Object.keys(modules).filter(function (a) {
  return a.indexOf('plug/') === -1 && // remapped by plug-modules
    a.indexOf('hbs!') === -1       && // templates
    a.indexOf('extplug/') === -1   && // ExtPlug
    modules[a]                     && // non-null
    !modules[a].originalModuleName;   // unknown module, not remapped by plug-modules
});

var knownModules = knownKeys.map(function (key) {
  return {
    isUnknown: false,
    name: key,
    original: modules[key].originalModuleName,
    module: modules[key]
  };
});
var unknownModules = unknownKeys.map(function (key) {
  return {
    isUnknown: true,
    name: '?',
    original: key,
    module: modules[key]
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

var fullMappingString = Object.keys(fullMapping).map(function (name) {
  return name + '=' + fullMapping[name];
}).join(' ');

fullMappingString;