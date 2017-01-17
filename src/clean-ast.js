import traverse from 'babel-traverse'
import * as t from 'babel-types'

// expand ternary expression statements into if(){}else{} blocks
const expandTernary = (expr) =>
  t.ifStatement(
    expr.test,
    t.expressionStatement(expr.consequent),
    t.isConditionalExpression(expr.alternate)
      ? expandTernary(expr.alternate)
      : t.expressionStatement(expr.alternate)
  )

// expand `a && b`, `a || b` expressions into `if (a) b`, `if (!a) b` statements.
const expandAndOr = (expr) => {
  if (expr.operator === '&&') {
    return t.ifStatement(
      expr.left,
      t.blockStatement([
        t.expressionStatement(expr.right)
      ])
    )
  }
  if (expr.operator === '||') {
    return t.ifStatement(
      t.unaryExpression('!', expr.left, true),
      t.expressionStatement(expr.right)
    )
  }
  return expr
}

const astReplacer = {
  // add braces around branch/loop constructs if they are not yet present
  IfStatement (path) {
    if (path.node.consequent) {
      t.ensureBlock(path.node, 'consequent')
      path.get('consequent').replaceWith(path.node.consequent)
    }
    if (path.node.alternate && !t.isIfStatement(path.node.alternate)) {
      t.ensureBlock(path.node, 'alternate')
      path.get('alternate').replaceWith(path.node.alternate)
    }
  },
  'ForStatement|WhileStatement' (path) {
    path.get('body').replaceWith(
      t.ensureBlock(path.node)
    )
  },
  UnaryExpression (path) {
    if (path.node.operator === '!' &&
        t.isNumericLiteral(path.node.argument)) {
      path.replaceWith(
        t.booleanLiteral(!path.node.argument.value)
      )
    }
  },
  ExpressionStatement (path) {
    // expand comma-separated expressions on a single line to multiple statements
    if (t.isSequenceExpression(path.node.expression)) {
      return path.replaceWithMultiple(
        path.node.expression.expressions.map((expr) =>
          t.expressionStatement(expr)
        )
      )
    }
    // expand ternary expression statements into if(){}else{} blocks
    if (t.isConditionalExpression(path.node.expression)) {
      return path.replaceWith(
        expandTernary(path.node.expression)
      )
    }
    // expand `a && b`, `a || b` expressions into `if (a) b`, `if (!a) b` statements
    if (t.isLogicalExpression(path.node.expression)) {
      return path.replaceWith(
        expandAndOr(path.node.expression)
      )
    }
  },
  ReturnStatement (path) {
    if (t.isSequenceExpression(path.node.argument)) {
      const exprs = path.node.argument.expressions
      const last = exprs.pop()
      path.insertBefore(exprs.map((expr) => t.expressionStatement(expr)))
      path.get('argument').replaceWith(last)
      return
    }
    if (t.isConditionalExpression(path.node.argument)) {
      const cond = path.node.argument
      path.replaceWith(
        t.ifStatement(
          cond.test,
          t.returnStatement(cond.consequent),
          t.returnStatement(cond.alternate)
        )
      )
    }
  }
}

export default function cleanAst (file) {
  traverse(file, astReplacer)
  return file
}
