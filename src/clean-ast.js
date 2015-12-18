import { replace } from 'estraverse'
import * as $ from './ast'

const isTernaryStatement = node =>
  node.type === 'ExpressionStatement' &&
  node.expression.type === 'ConditionalExpression'

const isTernaryReturn = node =>
  node.type === 'ReturnStatement' &&
  node.argument &&
  node.argument.type === 'ConditionalExpression' && (
    node.argument.consequent.type === 'ConditionalExpression' ||
    node.argument.consequent.type === 'SequenceExpression' ||
    node.argument.alternate.type === 'ConditionalExpression' ||
    node.argument.alternate.type === 'SequenceExpression'
  )

const isLogicalStatement = node =>
  node.type === 'ExpressionStatement' &&
  node.expression.type === 'LogicalExpression'

const isSequence = node =>
  node.type === 'ExpressionStatement' &&
  node.expression.type === 'SequenceExpression'

const isSequencedReturn = node =>
  node.type === 'ReturnStatement' &&
  node.argument &&
  node.argument.type === 'SequenceExpression'

const isNegated = (type, node) =>
  node.type === 'UnaryExpression' &&
  node.operator === '!' &&
  node.argument.type === type

const isNestedBracketedElseIf = node =>
  node.type === 'IfStatement' &&
  node.alternate && node.alternate.type === 'BlockStatement' &&
  node.alternate.body.length === 1 && node.alternate.body[0].type === 'IfStatement'

// expand ternary expression statements into if(){}else{} blocks
const expandTernary = expr => ({
  type: 'IfStatement',
  range: expr.range,
  test: expr.test,
  consequent: $.block($.statement(expr.consequent)),
  alternate: expr.alternate.type === 'ConditionalExpression'
    ? expandTernary(expr.alternate)
    : $.block($.statement(expr.alternate))
})

const wrapIfBranches = node => ({
  ...node,
  consequent: node.consequent ? $.block(node.consequent) : null,
  alternate: node.alternate ? $.block(node.alternate) : null
})

const wrapBody = node => ({
  ...node,
  body: $.block(node.body)
})

// expand `a && b`, `a || b` expressions into `if (a) b`, `if (!a) b` statements.
const expandAndOr = node => {
  if (node.expression.operator === '&&') {
    return {
      type: 'IfStatement',
      range: node.range,
      test: node.expression.left,
      consequent: $.block($.statement(node.expression.right))
    }
  }
  if (node.expression.operator === '||') {
    return {
      type: 'IfStatement',
      range: node.range,
      test: {
        type: 'UnaryExpression',
        operator: '!',
        range: node.expression.left.range,
        argument: node.expression.left,
        prefix: true
      },
      consequent: $.statement(node.expression.right)
    }
  }
  return node
}

const astReplacer = {
  enter(node) {
    // add braces around branch/loop constructs if they are not yet present
    if (node.type === 'IfStatement') {
      return wrapIfBranches(node)
    } else if (node.type === 'ForStatement' || node.type === 'WhileStatement') {
      return wrapBody(node)
    }

    // turn !0, !1 into true, false
    if (isNegated('Literal', node)) {
      if (node.argument.value === 0) {
        return { type: 'Literal', value: true, raw: 'true' }
      } else if (node.argument.value === 1) {
        return { type: 'Literal', value: false, raw: 'false' }
      }
    }

    // expand ternary ?: statements to if/else statements
    if (isTernaryStatement(node)) {
      return expandTernary(node.expression)
    }
    // expand compressed &&, || expressions into if/else statements
    if (isLogicalStatement(node)) {
      return expandAndOr(node)
    }

    // expand some expressions into multiple statements
    if (node.type === 'BlockStatement') {
      node.body = node.body.reduce((newBody, node) => {
        // expand comma-separated expressions on a single line to multiple statements
        if (isSequence(node)) {
          return [ ...newBody, ...node.expression.expressions.map($.statement) ]
        }
        // expand complex ternary conditionals in return statements to
        // if(){}else{} statements
        if (isTernaryReturn(node)) {
          return newBody.concat({
            range: node.range,
            type: 'IfStatement',
            test: node.argument.test,
            consequent: $.block({
              range: node.argument.consequent.range,
              type: 'ReturnStatement',
              argument: node.argument.consequent
            }),
            alternate: $.block({
              range: node.argument.alternate.range,
              type: 'ReturnStatement',
              argument: node.argument.alternate
            })
          })
        }
        // expand comma-separated expressions in a return statement to multiple statements
        if (isSequencedReturn(node)) {
          const exprs = node.argument.expressions
          node.argument = exprs.pop()
          return [ ...newBody, ...exprs.map($.statement), node ]
        }
        return [ ...newBody, node ]
      }, [])
      return node
    }
  },
  leave(node) {
    // remove braces from else statements that contain only an if statement
    // (i.e. else if statements)
    if (isNestedBracketedElseIf(node)) {
      node.alternate = node.alternate.body[0]
    }
    return node
  }
}

export default function cleanAst (ast) {
  replace(ast, astReplacer)
  return ast
}
