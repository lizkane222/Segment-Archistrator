/*
 * FQL: the condition language on destination filters.
 *
 * This evaluator is two-valued, and that is the interesting thing about it. A
 * destination filter in Segment looks at one event with no profile context, so a
 * local interpreter can reach the *same* answer the real engine does -- unlike an
 * audience query, where a single event can never settle a question about history
 * (see logic.js). Filter drop reasons are therefore the one part of the simulator
 * that is a claim about behaviour rather than a hint.
 *
 * Which makes parse failure the dangerous case: an unrecognised condition must
 * never silently become "passes". `evaluateCondition` returns a distinct
 * `parsed: false` result so the router can report "not evaluated" and the UI can
 * say so, rather than crediting a filter with a verdict it never produced.
 *
 * Supported subset, from Segment's destination filter docs:
 *   paths            event, type, userId, properties.x, context.a.b, traits.x
 *   comparison       = != < <= > >=
 *   boolean          and, or, not, !, parentheses
 *   nil tests        is nil, is not nil
 *   membership       in ["a", "b"]
 *   functions        contains(), match(), lowercase(), length(), typeof()
 * Anything else is a parse error by design rather than a best guess.
 */

import { resolvePath } from './payload.js'

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'nil', 'in', 'true', 'false', 'null'])
const FUNCTIONS = new Set(['contains', 'match', 'lowercase', 'length', 'typeof'])

class FqlError extends Error {}

/* --- tokenizer ------------------------------------------------------------- */

function tokenize(input) {
  const tokens = []
  let index = 0

  while (index < input.length) {
    const char = input[index]

    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      const { value, next } = readString(input, index)
      tokens.push({ type: 'string', value })
      index = next
      continue
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(input[index + 1] ?? ''))) {
      const match = /^-?\d*\.?\d+([eE][-+]?\d+)?/.exec(input.slice(index))
      tokens.push({ type: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }

    const twoChar = input.slice(index, index + 2)
    if (twoChar === '!=' || twoChar === '<=' || twoChar === '>=') {
      tokens.push({ type: 'op', value: twoChar })
      index += 2
      continue
    }

    if ('=<>'.includes(char)) {
      tokens.push({ type: 'op', value: char })
      index += 1
      continue
    }

    if ('()[],!'.includes(char)) {
      tokens.push({ type: char === '!' ? 'bang' : 'punct', value: char })
      index += 1
      continue
    }

    /* A path is one token including its dots, so `properties.page.url` does not
       have to be reassembled by the parser -- and a quoted segment
       (`properties."odd key"`) stays attached to the path it belongs to. */
    const pathMatch = /^[A-Za-z_$][A-Za-z0-9_$]*(\.(?:[A-Za-z0-9_$-]+|"[^"]*"|'[^']*'))*/.exec(
      input.slice(index),
    )
    if (pathMatch) {
      const raw = pathMatch[0]
      const lower = raw.toLowerCase()
      if (KEYWORDS.has(lower)) tokens.push({ type: 'keyword', value: lower })
      else if (FUNCTIONS.has(lower)) tokens.push({ type: 'function', value: lower })
      else tokens.push({ type: 'path', value: raw })
      index += raw.length
      continue
    }

    throw new FqlError(`Unexpected character ${JSON.stringify(char)} at position ${index}.`)
  }

  return tokens
}

function readString(input, start) {
  const quote = input[start]
  let value = ''
  let index = start + 1
  while (index < input.length) {
    if (input[index] === '\\' && index + 1 < input.length) {
      value += input[index + 1]
      index += 2
      continue
    }
    if (input[index] === quote) return { value, next: index + 1 }
    value += input[index]
    index += 1
  }
  throw new FqlError('Unterminated string literal.')
}

/* --- parser ---------------------------------------------------------------- */

export function parseCondition(source) {
  const tokens = tokenize(String(source ?? ''))
  if (tokens.length === 0) throw new FqlError('Empty condition.')

  let position = 0
  const peek = () => tokens[position]
  const next = () => tokens[position++]

  function expect(type, value) {
    const token = next()
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new FqlError(
        `Expected ${value ?? type} but found ${token ? JSON.stringify(token.value) : 'end of condition'}.`,
      )
    }
    return token
  }

  function parseOr() {
    const operands = [parseAnd()]
    while (peek()?.type === 'keyword' && peek().value === 'or') {
      next()
      operands.push(parseAnd())
    }
    return operands.length === 1 ? operands[0] : { node: 'or', operands }
  }

  function parseAnd() {
    const operands = [parseUnary()]
    while (peek()?.type === 'keyword' && peek().value === 'and') {
      next()
      operands.push(parseUnary())
    }
    return operands.length === 1 ? operands[0] : { node: 'and', operands }
  }

  function parseUnary() {
    const token = peek()
    if (token?.type === 'bang' || (token?.type === 'keyword' && token.value === 'not')) {
      next()
      return { node: 'not', operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary() {
    if (peek()?.type === 'punct' && peek().value === '(') {
      next()
      const inner = parseOr()
      expect('punct', ')')
      return inner
    }
    return parsePredicate()
  }

  function parsePredicate() {
    const left = parseOperand()
    const token = peek()

    if (token?.type === 'op') {
      next()
      return { node: 'compare', op: token.value, left, right: parseOperand() }
    }

    if (token?.type === 'keyword' && token.value === 'is') {
      next()
      let negated = false
      if (peek()?.type === 'keyword' && peek().value === 'not') {
        next()
        negated = true
      }
      const nilToken = next()
      if (!nilToken || nilToken.type !== 'keyword' || !['nil', 'null'].includes(nilToken.value)) {
        throw new FqlError('`is` must be followed by `nil` or `not nil`.')
      }
      return { node: 'nil', operand: left, negated }
    }

    if (token?.type === 'keyword' && token.value === 'in') {
      next()
      const open = next()
      if (!open || open.type !== 'punct' || !['[', '('].includes(open.value)) {
        throw new FqlError('`in` must be followed by a list.')
      }
      const closer = open.value === '[' ? ']' : ')'
      const items = [parseOperand()]
      while (peek()?.type === 'punct' && peek().value === ',') {
        next()
        items.push(parseOperand())
      }
      expect('punct', closer)
      return { node: 'in', operand: left, items }
    }

    return { node: 'truthy', operand: left }
  }

  function parseOperand() {
    const token = next()
    if (!token) throw new FqlError('Unexpected end of condition.')

    if (token.type === 'string') return { node: 'literal', value: token.value }
    if (token.type === 'number') return { node: 'literal', value: token.value }
    if (token.type === 'keyword' && token.value === 'true') return { node: 'literal', value: true }
    if (token.type === 'keyword' && token.value === 'false') return { node: 'literal', value: false }
    if (token.type === 'keyword' && ['nil', 'null'].includes(token.value)) {
      return { node: 'literal', value: null }
    }

    if (token.type === 'function') {
      expect('punct', '(')
      const args = [parseOperand()]
      while (peek()?.type === 'punct' && peek().value === ',') {
        next()
        args.push(parseOperand())
      }
      expect('punct', ')')
      return { node: 'call', name: token.value, args }
    }

    if (token.type === 'path') return { node: 'path', path: token.value }

    throw new FqlError(`Unexpected ${JSON.stringify(token.value)} in condition.`)
  }

  const ast = parseOr()
  if (position < tokens.length) {
    throw new FqlError(`Unexpected ${JSON.stringify(peek().value)} after the end of the condition.`)
  }
  return ast
}

/* --- evaluation ------------------------------------------------------------ */

const NIL = Symbol('nil')

function value(node, event) {
  switch (node.node) {
    case 'literal':
      return node.value ?? NIL

    case 'path': {
      /* Quoted segments were kept verbatim by the tokenizer so the path stayed one
         token; the quotes are not part of the key. */
      const cleaned = node.path.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b)
      const resolved = resolvePath(event, cleaned)
      return resolved === undefined ? NIL : resolved
    }

    case 'call':
      return callValue(node, event)

    default:
      /* A boolean sub-expression used where a value is expected, e.g.
         `contains(properties.a, "x") = true`. */
      return evaluate(node, event)
  }
}

function callValue(node, event) {
  const args = node.args.map((arg) => value(arg, event))
  const [first, second] = args

  switch (node.name) {
    case 'contains':
      if (first === NIL || second === NIL) return false
      return String(first).includes(String(second))

    case 'match':
      if (first === NIL || second === NIL) return false
      return globToRegExp(String(second)).test(String(first))

    case 'lowercase':
      return first === NIL ? NIL : String(first).toLowerCase()

    case 'length':
      if (first === NIL) return NIL
      if (Array.isArray(first)) return first.length
      if (typeof first === 'object') return Object.keys(first).length
      return String(first).length

    case 'typeof':
      return typeName(first)

    default:
      throw new FqlError(`Unknown function ${node.name}().`)
  }
}

function typeName(resolved) {
  if (resolved === NIL) return 'nil'
  if (Array.isArray(resolved)) return 'array'
  return typeof resolved
}

/* Segment's `match` is glob-style, not a regex, so the pattern is escaped and
   only `*` and `?` are given meaning. Passing a user's pattern to RegExp raw
   would turn a literal `.` in `*@example.com` into "any character". */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`)
}

export function evaluate(node, event) {
  switch (node.node) {
    case 'and':
      return node.operands.every((operand) => evaluate(operand, event))

    case 'or':
      return node.operands.some((operand) => evaluate(operand, event))

    case 'not':
      return !evaluate(node.operand, event)

    case 'nil': {
      const resolved = value(node.operand, event)
      return node.negated ? resolved !== NIL : resolved === NIL
    }

    case 'in': {
      const resolved = value(node.operand, event)
      if (resolved === NIL) return false
      return node.items.some((item) => looseEquals(resolved, value(item, event)))
    }

    case 'compare':
      return compare(node.op, value(node.left, event), value(node.right, event))

    case 'truthy': {
      const resolved = value(node.operand, event)
      return resolved !== NIL && resolved !== false && resolved !== 0 && resolved !== ''
    }

    default:
      throw new FqlError(`Cannot evaluate ${node.node}.`)
  }
}

/*
 * A documented interpretation, not a derivation from the spec: an absent field is
 * unequal to every concrete value, so `properties.plan != "pro"` is TRUE when the
 * event has no `plan`. The alternative -- nil comparing false to everything,
 * including `!=` -- makes `not (properties.plan = "pro")` and
 * `properties.plan != "pro"` disagree, which is worse than being possibly wrong
 * in one direction. Ordering comparisons against nil stay false either way.
 */
function compare(op, left, right) {
  if (op === '=') return left !== NIL && right !== NIL && looseEquals(left, right)
  if (op === '!=') {
    if (left === NIL && right === NIL) return false
    if (left === NIL || right === NIL) return true
    return !looseEquals(left, right)
  }

  if (left === NIL || right === NIL) return false
  const a = Number(left)
  const b = Number(right)
  if (Number.isNaN(a) || Number.isNaN(b)) {
    // Strings compare lexicographically; anything else has no ordering.
    if (typeof left !== 'string' || typeof right !== 'string') return false
    return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right
  }
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
}

function looseEquals(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left)
    const b = Number(right)
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return String(left) === String(right)
  }
  return left === right
}

/**
 * Does `event` match `condition`?
 *
 * @returns {{parsed: boolean, matched: boolean|null, error: string|null}}
 *   `parsed: false` means no verdict was reached -- callers must not read
 *   `matched`, which is null precisely so that treating it as a boolean fails
 *   loudly rather than defaulting to "passed".
 */
export function evaluateCondition(condition, event) {
  if (condition == null || String(condition).trim() === '') {
    return { parsed: true, matched: true, error: null, empty: true }
  }
  try {
    return { parsed: true, matched: evaluate(parseCondition(condition), event), error: null }
  } catch (error) {
    return { parsed: false, matched: null, error: error.message }
  }
}
