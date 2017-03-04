/* global $ */

// eslint-disable-next-line no-unused-vars
function getMapping (plugModules) {
  plugModules.run()

  const knownKeys = Object.keys(plugModules._nameMapping)
  const unknownKeys = plugModules.getUnknownModules()

  const knownModules = knownKeys.map((key) => ({
    isUnknown: false,
    name: key,
    original: plugModules.resolveName(key),
    module: plugModules.require(key)
  }))
  const unknownModules = unknownKeys.map((key) => ({
    isUnknown: true,
    name: '?',
    original: key,
    module: plugModules.require(key)
  }))

  // build mappings
  const partsMapping = {}
  knownModules.forEach((mod) => {
    const name = mod.name.split('/')
    const obsc = mod.original.split('/')

    obsc.forEach((part, i) => {
      partsMapping[part] = name[i]
    })
  })

  // guess module names based on known paths
  unknownModules.forEach((mod) => {
    mod.name = mod.original
      .split('/')
      .map((part) => partsMapping[part] || part)
      .join('/')
  })

  // modules that were not remapped by plug-modules, but were partially guessed
  const unknownPlugModules = unknownModules.filter(
    (mod) => mod.name.indexOf('plug/') === 0
  )

  void unknownPlugModules // It's not used atm

  // build full mapping of original names to (possibly partially guessed) proper names
  const fullMapping = {}
  knownModules.concat(unknownModules).forEach((mod) => {
    fullMapping[mod.original] = mod.name
  })

  const scriptSources = $('script[src*="cdn.plug"]').toArray().map((el) => el.src)

  // get plug.dj version (it appears in one of the inline <script> tags)
  const js = $('script:not([src])').text()
  const version = /_v="(.*?)"/.exec(js)[1]

  const appUrl = scriptSources.find(contains('js/app'))
  const langUrl = scriptSources.find(contains('js/lang/'))
  const avatarsUrl = scriptSources.find(contains('js/avatars'))

  return JSON.stringify({
    version: version,
    appUrl: appUrl,
    langUrl: langUrl,
    avatarsUrl: avatarsUrl,
    mapping: fullMapping
  })

  function contains (str) {
    return (src) => src.indexOf(str) > 0
  }
}
