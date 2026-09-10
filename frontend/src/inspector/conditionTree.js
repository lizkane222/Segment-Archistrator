/*
 * FQL -> the field/operator/value breakdown the Segment UI shows for the same rule.
 *
 * The request asks for both readings of a destination filter, because a customer has
 * only ever seen one of them: the FQL is what the API returns, and the rows are what
 * they built the filter in. Both are produced from one parse -- fql.js's, the same one
 * the simulator routes with -- because a second parser written for display would drift,
 * and a breakdown that disagreed with the verdict would be explaining a drop that did
 * not happen.
 *
 * Nothing here evaluates anything. A breakdown reads with no event on the canvas, which
 * is the point: it answers "what does this rule select", not "did this event match".
 *
 * `unsupported` is a guard, not a routine outcome. Every tree today's grammar can produce
 * becomes rows -- fql.js's operands are only paths, literals and calls, so there is
 * always a label for both sides. It is kept because this renders in a panel: a grammar
 * that grows an operand kind should cost one row that says so, not a blank inspector.
 */

import { parseCondition } from '../simulation/fql.js'

/* Segment's own wording, not the operator symbols. `>=` as "is at least" is what the
   filter builder says, and matching it is the whole reason this view exists. */
const OPERATOR_LABELS = {
  '=': 'is',
  '!=': 'is not',
  '>': 'is greater than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
}

/* `not (a > b)` is `a <= b`. Flipping the operator rather than drawing a negated group
   around one row is what keeps `!(plan = "pro")` reading as "plan is not pro" -- which
   is what someone wrote it to mean. */
const OPPOSITE = { '=': '!=', '!=': '=', '>': '<=', '<=': '>', '<': '>=', '>=': '<' }

/* `10 < properties.revenue` says the same thing as `properties.revenue > 10`, and only
   the second has a field to put in the first column. */
const MIRRORED = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' }

/* Only the two functions that are boolean on their own get a row. `lowercase`, `length`
   and `typeof` return values, so they appear inside a field label instead. */
const PREDICATE_CALLS = {
  contains: { label: 'contains', negated: 'does not contain' },
  match: { label: 'matches', negated: 'does not match' },
}

/**
 * A rule's breakdown.
 *
 * @param source FQL, or null/'' for a rule that records no condition
 * @returns `{parsed, empty, error, tree, clauseCount, unsupportedCount}`. `tree` is null
 *   when `parsed` is false -- the caller shows the FQL and the parse error instead,
 *   which is strictly more useful than a partial tree that stops mid-rule.
 */
export function describeCondition(source) {
  const text = String(source ?? '').trim()
  if (!text) {
    return { parsed: true, empty: true, error: null, tree: null, clauseCount: 0, unsupportedCount: 0 }
  }

  let ast
  try {
    ast = parseCondition(text)
  } catch (error) {
    return {
      parsed: false,
      empty: false,
      error: error.message,
      tree: null,
      clauseCount: 0,
      unsupportedCount: 0,
    }
  }

  const tree = toNode(ast)
  return {
    parsed: true,
    empty: false,
    error: null,
    tree,
    clauseCount: count(tree, 'clause'),
    unsupportedCount: count(tree, 'unsupported'),
  }
}

/**
 * A group's heading.
 *
 * Here rather than in the component because the negated pair is a trap: `not (a or b)`
 * is "none of these", `not (a and b)` is "not all of these", and the two swapped over
 * describe opposite sets of events. Wording that can be wrong that way belongs beside
 * OPERATOR_LABELS where a test can hold it.
 */
export function groupLabel(group) {
  if (group.join === 'and') return group.negated ? 'Not all of these match' : 'All of these match'
  return group.negated ? 'None of these match' : 'Any of these matches'
}

function count(node, kind) {
  if (!node) return 0
  if (node.kind === kind) return 1
  return (node.children ?? []).reduce((total, child) => total + count(child, kind), 0)
}

function toNode(ast, negated = false) {
  switch (ast.node) {
    case 'and':
    case 'or':
      return {
        kind: 'group',
        join: ast.node,
        negated,
        children: ast.operands.map((operand) => toNode(operand)),
      }

    case 'not':
      /* Two negations cancel rather than nesting. `not not x` is rare by hand and normal
         in generated FQL, and drawing it as two wrappers around one row would suggest a
         complexity the rule does not have. */
      return toNode(ast.operand, !negated)

    case 'compare':
      return compareClause(ast, negated)

    case 'nil':
      return {
        kind: 'clause',
        field: operandLabel(ast.operand),
        path: firstPath(ast.operand),
        /* `is nil` reads as "is not set", so a negation on top of it flips back to
           "is set" rather than stacking into "is not not set". */
        operator: ast.negated === negated ? 'is not set' : 'is set',
        values: [],
        raw: format(ast),
      }

    case 'in':
      return {
        kind: 'clause',
        field: operandLabel(ast.operand),
        path: firstPath(ast.operand),
        operator: negated ? 'is not one of' : 'is one of',
        values: ast.items.map(format),
        raw: format(ast),
      }

    case 'truthy':
      return truthyClause(ast, negated)

    default:
      return unsupported(ast, 'This is not a condition on its own.')
  }
}

/*
 * A comparison, in the four shapes that actually turn up.
 *
 * The `call = true` case is the one worth naming: a filter built in the UI as
 * "name contains x" is returned by the API as `contains(properties.name, "x") = true`,
 * so without it the commonest string rule in Segment would render as unsupported.
 */
function compareClause(ast, negated) {
  const op = negated ? OPPOSITE[ast.op] : ast.op
  if (!op) return unsupported(ast, `No wording for the operator ${ast.op}.`)

  const boolean = booleanComparison(ast, negated)
  if (boolean) return boolean

  const leftPath = firstPath(ast.left)
  const rightPath = firstPath(ast.right)

  /* Mirrored only when the right side is the field and the left is not: with a path on
     both sides there is no "field" column to prefer, and swapping would just relabel an
     arbitrary one. */
  if (!leftPath && rightPath) {
    const mirrored = MIRRORED[op]
    if (mirrored) {
      return {
        kind: 'clause',
        field: operandLabel(ast.right),
        path: rightPath,
        operator: OPERATOR_LABELS[mirrored],
        values: [format(ast.left)],
        raw: format(ast),
      }
    }
  }

  const field = operandLabel(ast.left)
  const value = operandLabel(ast.right)
  if (field === null || value === null) {
    return unsupported(ast, 'Both sides are computed, so there is no field and value to show.')
  }

  return {
    kind: 'clause',
    field,
    path: leftPath,
    operator: OPERATOR_LABELS[op],
    values: [value],
    raw: format(ast),
  }
}

/* `contains(...) = true` and `contains(...) != false` are the same rule. Anything else
   compared against a boolean is left alone -- `properties.vip = true` is a plain
   comparison and reads better as one. */
function booleanComparison(ast, negated) {
  if (ast.left.node !== 'call' || ast.right.node !== 'literal') return null
  if (typeof ast.right.value !== 'boolean') return null
  if (ast.op !== '=' && ast.op !== '!=') return null

  /* `= true` and `!= false` both assert the call; `= false` and `!= true` deny it. An
     outer `not` then flips whichever of those it was. */
  const asserted = (ast.op === '=') === ast.right.value
  return callClause(ast.left, asserted === negated, format(ast))
}

function truthyClause(ast, negated) {
  if (ast.operand.node === 'call') {
    const clause = callClause(ast.operand, negated, format(ast))
    if (clause) return clause
  }

  const field = operandLabel(ast.operand)
  if (field === null) return unsupported(ast, 'This is not a condition on its own.')
  return {
    kind: 'clause',
    field,
    path: firstPath(ast.operand),
    /* Not "is true": fql.js treats 0 and "" as false here as well as `false` itself, and
       "is set" alone would be wrong for a field that is present and empty. */
    operator: negated ? 'is missing, false, zero, or empty' : 'is set and not false, zero, or empty',
    values: [],
    raw: format(ast),
  }
}

function callClause(call, negated, raw) {
  const wording = PREDICATE_CALLS[call.name]
  if (!wording || call.args.length !== 2) return null
  return {
    kind: 'clause',
    field: operandLabel(call.args[0]),
    path: firstPath(call.args[0]),
    operator: negated ? wording.negated : wording.label,
    values: [format(call.args[1])],
    /* Segment's `match` is glob-style rather than a regex, and a reader who assumes
       otherwise will misread `*@acme.com`. fql.js escapes accordingly; this says so. */
    note: call.name === 'match' ? 'Wildcards are * and ?, not a regular expression.' : null,
    raw,
  }
}

function unsupported(ast, reason) {
  return { kind: 'unsupported', reason, raw: format(ast) }
}

/**
 * An operand as a column label, or null when it is a condition rather than a value.
 *
 * A call is kept whole -- `lowercase(properties.email)` -- because the transform is part
 * of what the rule compares, and dropping it to show a bare field name would describe a
 * case-sensitive rule as a case-insensitive one.
 */
function operandLabel(node) {
  switch (node.node) {
    case 'path':
      return node.path
    case 'literal':
      return formatLiteral(node.value)
    case 'call':
      return `${node.name}(${node.args.map((arg) => operandLabel(arg) ?? '…').join(', ')})`
    default:
      return null
  }
}

/* The field a clause is *about*, for grouping and highlighting, as distinct from the
   label: both `properties.email` and `lowercase(properties.email)` have this path. */
function firstPath(node) {
  if (node.node === 'path') return node.path
  if (node.node === 'call') {
    for (const arg of node.args) {
      const path = firstPath(arg)
      if (path) return path
    }
  }
  return null
}

/**
 * An AST back to FQL.
 *
 * Needed because the tokenizer keeps no source offsets, so a sub-expression cannot be
 * quoted from the original text. Round-tripping is tested rather than assumed: the
 * output has to re-parse to the same tree, or a clause's `raw` would show something the
 * rule does not say.
 */
export function format(node) {
  switch (node.node) {
    case 'and':
    case 'or':
      return node.operands.map(parenthesised).join(` ${node.node} `)
    case 'not':
      return `not ${parenthesised(node.operand)}`
    case 'compare':
      return `${format(node.left)} ${node.op} ${format(node.right)}`
    case 'nil':
      return `${format(node.operand)} is ${node.negated ? 'not ' : ''}nil`
    case 'in':
      return `${format(node.operand)} in [${node.items.map(format).join(', ')}]`
    case 'truthy':
      return format(node.operand)
    case 'path':
      return node.path
    case 'literal':
      return formatLiteral(node.value)
    case 'call':
      return `${node.name}(${node.args.map(format).join(', ')})`
    default:
      return ''
  }
}

/* `and`/`or` only. A `not` binds tighter than both, and wrapping it would add parens the
   original did not have -- which matters because this output is shown to the user. */
const parenthesised = (node) =>
  node.node === 'and' || node.node === 'or' ? `(${format(node)})` : format(node)

function formatLiteral(value) {
  if (value === null) return 'nil'
  if (typeof value === 'string') return `"${value.replace(/(["\\])/g, '\\$1')}"`
  return String(value)
}
