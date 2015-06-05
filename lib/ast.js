exports.id = function (name) {
  return exports.smallRange({ type: 'Identifier', name: name })
}

exports.literal = function (value) {
  return { type: 'Literal', value: value }
}

exports.comment = function (ast, type, value) {
  ast.trailingComments = ast.trailingComments || []
  ast.trailingComments.push({
    type: type,
    value: value
  })
  return ast
}

exports.largeRange = function (ast) {
  ast.range = [ 0, Infinity ]
  return ast
}

exports.smallRange = function (ast, n) {
  ast.range = [ n || 0, n || 0 ]
  return ast
}

exports.statement = function (expr) {
  return {
    type: 'ExpressionStatement',
    expression: expr,
    range: expr.range
  }
}

exports.block = function (stmt) {
  return stmt.type === 'BlockStatement' ? stmt : {
    type: 'BlockStatement',
    body: [ stmt ],
    range: stmt.range
  }
}
