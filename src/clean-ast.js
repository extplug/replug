const traverse = require('babel-traverse').default
const t = require('babel-types')
const beautifier = require('babel-plugin-transform-beautifier')

module.exports = function cleanAst (file) {
  traverse(file, beautifier({ types: t }).visitor)
  return file
}
