export const id = name => smallRange({ type: 'Identifier', name })

export const literal = value => ({ type: 'Literal', value })

export const comment = (ast, type, value) => {
  ast.trailingComments = ast.trailingComments || []
  ast.trailingComments.push({ type, value })
  return ast
}

export const largeRange = ast => ({ ...ast, range: [ 0, Infinity ] })
export const smallRange = (ast, n = 0) => ({ ...ast, range: [ n, n ] })

export const statement = expression => ({
  type: 'ExpressionStatement',
  expression,
  range: expression.range
})

export const block = stmt => stmt.type === 'BlockStatement'
  ? stmt
  : {
      type: 'BlockStatement',
      body: [ stmt ],
      range: stmt.range
    }
