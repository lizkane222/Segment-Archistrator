/*
 * The audience / computed-trait definition language, interpreted three-valued.
 *
 * The grammar here was derived from real captured `definition.query` strings
 * rather than from documentation, because the documentation does not give a
 * grammar. Every construct below appears in a live workspace's audience list:
 *
 *   event('Page Viewed').where(property('path').contains('/user/')).count() >= 1
 *   trait('is_on_waitlist').exists()
 *   trait('score') <= .20 AND event('Page Viewed').within(90 days).count() = 0
 *   event('Product Added').between(14 days, 30 days).count() >= 1
 *   ANY event('Audience Entered').within(30 days).count() >= 1
 *
 * ---
 *
 * The hard part is not parsing, it is knowing what a single event is allowed to
 * conclude. An audience asks a question about a profile's whole history; a
 * simulation has one event and no history at all. So every leaf answers under the
 * contract logic.js depends on: TRUE/FALSE only when no possible history could
 * flip the answer.
 *
 * For event counts that reduces to a monotonicity argument. Let n1 be the count
 * this event contributes (0 or 1) and h >= 0 the unknown count from history, so
 * the true count is n1 + h:
 *
 *   count() >= k   n1 >= k  -> TRUE   (h only adds)      otherwise UNKNOWN
 *   count() <= k   n1 >  k  -> FALSE  (h only adds)      otherwise UNKNOWN
 *   count() = 0    n1 >  0  -> FALSE                     otherwise UNKNOWN
 *
 * which is why `event('Page Viewed').within(90 days).count() = 0` is a definite
 * FALSE when the simulated event is a Page Viewed -- a genuinely useful verdict --
 * while `event('User Registered').count() >= 3` is UNKNOWN no matter what, because
 * the profile may already hold two.
 *
 * Traits and properties differ, and the asymmetry is deliberate. An event's
 * properties are fully known, so an absent property is a definite FALSE. A trait
 * absent from the payload is UNKNOWN, because an earlier identify may already have
 * set it on the profile.
 */

import {
  and as andAll,
  dependsOnHistory,
  no,
  not as negate,
  notSupported,
  or as orAll,
  definite,
} from './logic.js'
import { eventNameOf, propertiesOf, traitsOf } from './payload.js'

const QUANTIFIERS = new Set(['ANY', 'ALL', 'NONE'])
const TIME_UNITS = new Set(['day', 'days', 'hour', 'hours', 'week', 'weeks', 'month', 'months'])

class QueryError extends Error {}

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

    if (char === "'" || char === '"') {
      const { value, next } = readString(input, index)
      tokens.push({ type: 'string', value })
      index = next
      continue
    }

    /* Thresholds are written as bare decimals in real queries -- `<= .20` -- so a
       leading dot starts a number, and only a dot followed by a letter is the
       method accessor. */
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(input[index + 1] ?? ''))) {
      const match = /^-?\d*\.?\d+/.exec(input.slice(index))
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

    if ('().,:'.includes(char)) {
      tokens.push({ type: 'punct', value: char })
      index += 1
      continue
    }

    const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index))
    if (wordMatch) {
      tokens.push({ type: 'word', value: wordMatch[0] })
      index += wordMatch[0].length
      continue
    }

    throw new QueryError(`Unexpected character ${JSON.stringify(char)} at position ${index}.`)
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
  throw new QueryError('Unterminated string literal.')
}

/* --- parser ---------------------------------------------------------------- */

export function parseQuery(source) {
  const tokens = tokenize(String(source ?? ''))
  if (tokens.length === 0) throw new QueryError('Empty definition.')

  let position = 0
  const peek = (offset = 0) => tokens[position + offset]
  const next = () => tokens[position++]

  const isWord = (token, word) =>
    token?.type === 'word' && token.value.toUpperCase() === word.toUpperCase()
  const isPunct = (token, value) => token?.type === 'punct' && token.value === value

  function expectPunct(value) {
    const token = next()
    if (!isPunct(token, value)) {
      throw new QueryError(
        `Expected "${value}" but found ${token ? JSON.stringify(token.value) : 'end of definition'}.`,
      )
    }
  }

  function expectWord(word) {
    const token = next()
    if (!isWord(token, word)) {
      throw new QueryError(
        `Expected "${word}" but found ${token ? JSON.stringify(token.value) : 'end of definition'}.`,
      )
    }
  }

  function expectString() {
    const token = next()
    if (token?.type !== 'string') {
      throw new QueryError(
        `Expected a quoted name but found ${token ? JSON.stringify(token.value) : 'end of definition'}.`,
      )
    }
    return token.value
  }

  function parseOr() {
    const operands = [parseAnd()]
    while (isWord(peek(), 'OR')) {
      next()
      operands.push(parseAnd())
    }
    return operands.length === 1 ? operands[0] : { node: 'or', operands }
  }

  function parseAnd() {
    const operands = [parseUnary()]
    while (isWord(peek(), 'AND')) {
      next()
      operands.push(parseUnary())
    }
    return operands.length === 1 ? operands[0] : { node: 'and', operands }
  }

  function parseUnary() {
    if (isWord(peek(), 'NOT')) {
      next()
      return { node: 'not', operand: parseUnary() }
    }

    /* A quantifier binds to the predicate that follows it. It is parsed so the
       rest of the query still evaluates, and evaluation reports it unsupported --
       dropping it here would silently change the meaning. */
    if (peek()?.type === 'word' && QUANTIFIERS.has(peek().value.toUpperCase())) {
      const quantifier = next().value.toUpperCase()
      return { node: 'quantified', quantifier, operand: parseUnary() }
    }

    return parsePrimary()
  }

  function parsePrimary() {
    if (isPunct(peek(), '(')) {
      next()
      const inner = parseOr()
      expectPunct(')')
      return inner
    }

    const token = peek()
    if (token?.type !== 'word') {
      throw new QueryError(
        `Expected a predicate but found ${token ? JSON.stringify(token.value) : 'end of definition'}.`,
      )
    }

    const name = token.value.toLowerCase()
    if (name === 'event') return parseEventPredicate()
    if (name === 'trait') return parseFieldPredicate('trait')
    if (name === 'property') return parseFieldPredicate('property')
    if (name === 'context') return parseFieldPredicate('context')

    throw new QueryError(`Unknown predicate "${token.value}".`)
  }

  function parseEventPredicate() {
    expectWord('event')
    expectPunct('(')
    const eventName = expectString()
    expectPunct(')')

    const modifiers = []
    while (isPunct(peek(), '.') && peek(1)?.type === 'word') {
      const method = peek(1).value.toLowerCase()
      if (method === 'count') break

      next()
      next()
      expectPunct('(')

      if (method === 'where') {
        modifiers.push({ modifier: 'where', condition: parseOr() })
      } else if (method === 'within') {
        modifiers.push({ modifier: 'within', window: parseWindow() })
      } else if (method === 'between') {
        const from = parseWindow()
        expectPunct(',')
        const to = parseWindow()
        modifiers.push({ modifier: 'between', from, to })
      } else {
        throw new QueryError(`Unsupported event modifier ".${method}()".`)
      }
      expectPunct(')')
    }

    expectPunct('.')
    expectWord('count')
    expectPunct('(')
    expectPunct(')')

    /* A bare `.count()` with no comparison means "it happened", which is the same
       question as `>= 1`. Written down rather than left to the evaluator so the
       AST is always fully specified. */
    let comparison = { op: '>=', value: { node: 'literal', value: 1 } }
    if (peek()?.type === 'op') {
      const op = next().value
      comparison = { op, value: parseValue() }
    }

    return { node: 'eventCount', eventName, modifiers, comparison }
  }

  function parseWindow() {
    /* `within(parent: 30 days)` scopes the window to the enclosing event's
       timestamp in a nested where(). Recorded, then reported unsupported. */
    let relativeToParent = false
    if (isWord(peek(), 'parent') && isPunct(peek(1), ':')) {
      next()
      next()
      relativeToParent = true
    }

    const amountToken = next()
    if (amountToken?.type !== 'number') {
      throw new QueryError('A time window must start with a number.')
    }

    const unitToken = next()
    if (unitToken?.type !== 'word' || !TIME_UNITS.has(unitToken.value.toLowerCase())) {
      throw new QueryError(
        `Expected a time unit but found ${unitToken ? JSON.stringify(unitToken.value) : 'end of definition'}.`,
      )
    }

    return { amount: amountToken.value, unit: unitToken.value.toLowerCase(), relativeToParent }
  }

  function parseFieldPredicate(source) {
    expectWord(source)
    expectPunct('(')
    const key = expectString()
    expectPunct(')')

    const field = { node: 'field', source, key }

    if (isPunct(peek(), '.') && peek(1)?.type === 'word') {
      const method = peek(1).value.toLowerCase()
      next()
      next()
      expectPunct('(')

      if (method === 'exists') {
        expectPunct(')')
        return { node: 'exists', field }
      }
      if (method === 'contains') {
        const argument = parseValue()
        expectPunct(')')
        return { node: 'contains', field, value: argument }
      }
      if (method === 'before_date' || method === 'after_date') {
        const argument = parseValue()
        expectPunct(')')
        return { node: 'dateCompare', field, direction: method, value: argument }
      }
      throw new QueryError(`Unsupported method ".${method}()" on ${source}().`)
    }

    if (peek()?.type === 'op') {
      const op = next().value
      return { node: 'compare', field, op, value: parseValue() }
    }

    /* A bare `trait('x')` used as a condition asks whether it is set. */
    return { node: 'exists', field }
  }

  function parseValue() {
    const token = peek()
    if (token?.type === 'string') {
      next()
      return { node: 'literal', value: token.value }
    }
    if (token?.type === 'number') {
      next()
      return { node: 'literal', value: token.value }
    }
    if (
      token?.type === 'word' &&
      ['trait', 'property', 'context'].includes(token.value.toLowerCase())
    ) {
      const source = next().value.toLowerCase()
      expectPunct('(')
      const key = expectString()
      expectPunct(')')
      return { node: 'field', source, key }
    }
    if (token?.type === 'word' && ['true', 'false'].includes(token.value.toLowerCase())) {
      next()
      return { node: 'literal', value: token.value.toLowerCase() === 'true' }
    }
    throw new QueryError(
      `Expected a value but found ${token ? JSON.stringify(token.value) : 'end of definition'}.`,
    )
  }

  const ast = parseOr()
  if (position < tokens.length) {
    const trailing = peek()
    throw new QueryError(
      `Unexpected ${JSON.stringify(trailing.value)} after the end of the definition.`,
    )
  }
  return ast
}

/* --- evaluation ------------------------------------------------------------ */

/*
 * A resolved operand, plus whether the simulation actually knows it.
 *
 * `known: false` is not the same as `value: undefined`. A property this event does
 * not carry is known-absent; a trait it does not carry is simply unknown, because
 * the profile may already hold it.
 */
function resolveField(field, context) {
  const { event } = context

  if (field.source === 'property') {
    const properties = propertiesOf(event)
    return { known: true, value: properties[field.key], scope: 'property' }
  }

  if (field.source === 'context') {
    /* `context('timestamp')` means the event's timestamp, which lives at the top
       level of the payload rather than inside `context`. */
    const fromContext = event?.context?.[field.key]
    const value = fromContext ?? (field.key === 'timestamp' ? event?.timestamp : undefined)
    return { known: true, value, scope: 'context' }
  }

  const traits = traitsOf(event)
  if (Object.prototype.hasOwnProperty.call(traits, field.key)) {
    return { known: true, value: traits[field.key], scope: 'trait' }
  }
  return { known: false, value: undefined, scope: 'trait' }
}

function describeField(field) {
  return `${field.source}('${field.key}')`
}

/* Traits that can only ever be computed by Segment, never set by an event. Named
   so the UNKNOWN reason is specific -- "this event cannot set a predictive trait"
   is actionable, "depends on profile history" reads like a shrug. */
function traitNote(field) {
  if (/^predictive_/.test(field.key)) {
    return `${describeField(field)} is a predictive trait — Segment computes it, so no single event can decide it.`
  }
  if (/^j_o_/.test(field.key)) {
    return `${describeField(field)} is journey-step membership, which is set by the journey rather than by this event.`
  }
  return `The profile may already have ${describeField(field)} from an earlier call; this event does not set it.`
}

function compareValues(op, left, right) {
  // Kept consistent with fql.js: nothing equals a missing value, and `!=` holds.
  if (left === undefined || right === undefined) return op === '!='

  if (op === '=' || op === '!=') {
    const equal =
      typeof left === 'number' || typeof right === 'number'
        ? Number(left) === Number(right)
        : String(left) === String(right)
    return op === '=' ? equal : !equal
  }

  const a = Number(left)
  const b = Number(right)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
}

function evaluateNode(node, context) {
  switch (node.node) {
    case 'and':
      return andAll(node.operands.map((operand) => evaluateNode(operand, context)))

    case 'or':
      return orAll(node.operands.map((operand) => evaluateNode(operand, context)))

    case 'not':
      return negate(evaluateNode(node.operand, context))

    case 'quantified':
      return notSupported(
        `The "${node.quantifier}" quantifier is outside the subset this simulator evaluates.`,
      )

    case 'exists': {
      const resolved = resolveField(node.field, context)
      if (!resolved.known) return dependsOnHistory(traitNote(node.field))
      return definite(resolved.value !== undefined && resolved.value !== null)
    }

    case 'contains': {
      const resolved = resolveField(node.field, context)
      if (!resolved.known) return dependsOnHistory(traitNote(node.field))
      const argument = resolveValue(node.value, context)
      if (!argument.known) return dependsOnHistory(traitNote(node.value))
      if (resolved.value === undefined || argument.value === undefined) return no()
      return definite(String(resolved.value).includes(String(argument.value)))
    }

    case 'compare': {
      const resolved = resolveField(node.field, context)
      if (!resolved.known) return dependsOnHistory(traitNote(node.field))
      const argument = resolveValue(node.value, context)
      if (!argument.known) return dependsOnHistory(traitNote(node.value))
      return definite(compareValues(node.op, resolved.value, argument.value))
    }

    case 'dateCompare': {
      const resolved = resolveField(node.field, context)
      if (!resolved.known) return dependsOnHistory(traitNote(node.field))
      const argument = resolveValue(node.value, context)
      if (!argument.known) return dependsOnHistory(traitNote(node.value))

      const left = Date.parse(resolved.value ?? '')
      const right = Date.parse(argument.value ?? '')
      if (Number.isNaN(left) || Number.isNaN(right)) {
        return notSupported(
          `${describeField(node.field)} is not a date this simulator can read, so ${node.direction}() was not evaluated.`,
        )
      }
      return definite(node.direction === 'before_date' ? left < right : left > right)
    }

    case 'eventCount':
      return evaluateEventCount(node, context)

    default:
      return notSupported('This part of the definition is outside the supported subset.')
  }
}

function resolveValue(node, context) {
  if (node.node === 'literal') return { known: true, value: node.value }
  return resolveField(node, context)
}

/**
 * An `event(...).count()` predicate, decided by monotonicity.
 *
 * Returns TRUE or FALSE only where no history could change the answer; see this
 * module's header for the argument.
 */
function evaluateEventCount(node, context) {
  const { event } = context
  const label = `event('${node.eventName}')`

  for (const modifier of node.modifiers) {
    if (modifier.modifier === 'within' && modifier.window.relativeToParent) {
      return notSupported(
        `${label} uses a window relative to a parent event, which this simulator does not evaluate.`,
      )
    }
    if (modifier.modifier === 'between' && (modifier.from.relativeToParent || modifier.to.relativeToParent)) {
      return notSupported(
        `${label} uses a window relative to a parent event, which this simulator does not evaluate.`,
      )
    }
  }

  let contributes = eventNameOf(event) === node.eventName
  const notes = []

  if (!contributes) {
    notes.push(
      `The simulated event is not ${label}, so it contributes nothing to this count — the profile's history might.`,
    )
  }

  /* A `between` window asks for events in the past. The simulated event happens
     now, so it can never fall inside one; `within` is always satisfied for the
     same reason. */
  if (contributes) {
    const between = node.modifiers.find((modifier) => modifier.modifier === 'between')
    if (between) {
      contributes = false
      notes.push(
        `${label} must have happened between ${windowText(between.from)} and ${windowText(between.to)} ago; the simulated event is happening now.`,
      )
    }
  }

  if (contributes) {
    for (const modifier of node.modifiers) {
      if (modifier.modifier !== 'where') continue
      const inner = evaluateNode(modifier.condition, context)
      if (inner.value === 'false') {
        contributes = false
        notes.push(`The simulated event does not satisfy the where() clause on ${label}.`)
        break
      }
      if (inner.value === 'unknown') {
        /* Whether this event counts at all is undecided, so the count is too. The
           inner reasons are the useful ones -- they name the missing trait. */
        return { value: 'unknown', reasons: inner.reasons }
      }
    }
  }

  const contributed = contributes ? 1 : 0
  const threshold = resolveValue(node.comparison.value, context)
  if (!threshold.known) return dependsOnHistory(traitNote(node.comparison.value))

  const target = Number(threshold.value)
  if (Number.isNaN(target)) {
    return notSupported(`${label}.count() is compared against a value that is not a number.`)
  }

  const verdict = decideCount(node.comparison.op, contributed, target)
  if (verdict === true) return definite(true)
  if (verdict === false) return definite(false)

  return dependsOnHistory(
    notes[0] ??
      `${label}.count() ${node.comparison.op} ${target} needs the profile's event history, which a single simulated event cannot supply.`,
  )
}

/**
 * TRUE / FALSE / null(unknown) for `contributed + history <op> target`.
 *
 * `history` is any integer >= 0, so only the comparisons that are already settled
 * at history = 0 -- and stay settled as it grows -- get a definite answer.
 */
function decideCount(op, contributed, target) {
  switch (op) {
    case '>=':
      return contributed >= target ? true : null
    case '>':
      return contributed > target ? true : null
    case '<=':
      return contributed > target ? false : null
    case '<':
      return contributed >= target ? false : null
    case '=':
      return contributed > target ? false : null
    case '!=':
      return contributed > target ? true : null
    default:
      return null
  }
}

function windowText(window) {
  return `${window.amount} ${window.unit}`
}

/**
 * Evaluate an audience or computed-trait definition against one simulated event.
 *
 * Never throws. A definition outside the grammar becomes UNKNOWN/unsupported for
 * the whole query; a clause inside the grammar that cannot be interpreted (a
 * quantifier, a parent-relative window) becomes UNKNOWN on its own, which Kleene
 * logic can still absorb -- unsupported ANDed with a definite FALSE is FALSE.
 */
export function evaluateQuery(query, event) {
  if (query == null || String(query).trim() === '') {
    return notSupported('This component reports no definition, so there is nothing to evaluate.')
  }

  let ast
  try {
    ast = parseQuery(query)
  } catch (error) {
    return notSupported(`The definition could not be parsed: ${error.message}`)
  }

  return evaluateNode(ast, { event })
}
