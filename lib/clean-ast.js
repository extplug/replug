var estraverse = require('estraverse'),
  $ = require('./ast')

module.exports = cleanAst

function cleanAst(ast) {
  estraverse.replace(ast, {
    enter: function (node) {
      // add braces around branch/loop constructs if they are not yet present
      if (node.type === 'IfStatement') {
        wrapIfBranches(node)
      }
      else if (node.type === 'ForStatement' ||
               node.type === 'WhileStatement') {
        wrapBody(node)
      }
      // turn !0, !1 into true, false
      else if (node.type === 'UnaryExpression' &&
               node.operator === '!' &&
               node.argument.type === 'Literal') {
        if (node.argument.value === 0) {
          return { type: 'Literal', value: true, raw: 'true' }
        }
        else if (node.argument.value === 1) {
          return { type: 'Literal', value: false, raw: 'false' }
        }
      }
      // expand ternary ?: statements to if/else statements
      else if (node.type === 'ExpressionStatement' &&
               node.expression.type === 'ConditionalExpression') {
        return expandTernary(node.expression)
      }
      // expand compressed &&, || expressions into if/else statements
      else if (node.type === 'ExpressionStatement' &&
               node.expression.type === 'LogicalExpression') {
        return expandAndOr(node)
      }
      // expand some expressions into multiple statements
      else if (node.type === 'BlockStatement') {
        node.body = node.body.reduce(function (newBody, node) {
          // expand comma-separated expressions on a single line to multiple statements
          if (node.type === 'ExpressionStatement' &&
              node.expression.type === 'SequenceExpression') {
            return newBody.concat(node.expression.expressions.map($.statement))
          }
          // expand complex ternary conditionals in return statements to
          // if(){}else{} statements
          else if (node.type === 'ReturnStatement' &&
                   node.argument &&
                   node.argument.type === 'ConditionalExpression' &&
                   (node.argument.consequent.type === 'ConditionalExpression' ||
                    node.argument.consequent.type === 'SequenceExpression' ||
                    node.argument.alternate.type === 'ConditionalExpression' ||
                    node.argument.alternate.type === 'SequenceExpression')) {
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
          else if (node.type === 'ReturnStatement' &&
                   node.argument &&
                   node.argument.type === 'SequenceExpression') {
            var exprs = node.argument.expressions
            node.argument = exprs.pop()
            return newBody.concat(exprs.map($.statement)).concat([ node ])
          }
          return newBody.concat([ node ])
        }, [])
      }
    },
    leave: function (node) {
      // remove braces from else statements that contain only an if statement
      // (i.e. else if statements)
      if (node.type === 'IfStatement' &&
          node.alternate && node.alternate.type === 'BlockStatement' &&
          node.alternate.body.length === 1 && node.alternate.body[0].type === 'IfStatement') {
        node.alternate = node.alternate.body[0]
      }
      return node
    }
  })

  return ast
}

// expand ternary expression statements into if(){}else{} blocks
function expandTernary(expr) {
  return {
    type: 'IfStatement',
    range: expr.range,
    test: expr.test,
    consequent: $.block($.statement(expr.consequent)),
    alternate: expr.alternate.type === 'ConditionalExpression'
      ? expandTernary(expr.alternate)
      : $.block($.statement(expr.alternate))
  }
}

function wrapIfBranches(node) {
  if (node.consequent.type !== 'BlockStatement') {
    node.consequent = $.block(node.consequent)
  }
  if (node.alternate && node.alternate !== 'BlockStatement') {
    node.alternate = $.block(node.alternate)
  }
  return node
}
function wrapBody(node) {
  if (node.body.type !== 'BlockStatement') {
    node.body = $.block(node.body)
  }
}
function expandAndOr(node) {
  if (node.expression.operator === '&&') {
    return {
      type: 'IfStatement',
      range: node.range,
      test: node.expression.left,
      consequent: $.block($.statement(node.expression.right))
    }
  }
  else if (node.expression.operator === '||') {
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
