/*
 * Destination filter conditions.
 *
 * The event fixture is a full Spec-shaped payload rather than a stub, because the
 * whole risk in this module is a condition passing for the wrong reason -- a filter
 * that references `context.app.name` against a payload with no `context` at all
 * would report a pass it did not earn.
 *
 * The most important test here is the last group: a condition this parser cannot
 * read must NOT come back as "matched: false". Silently treating an unreadable
 * condition as "does not match" would tell the user their event sailed through a
 * filter the simulator never actually ran.
 */

import { describe, expect, it } from 'vitest'

import { evaluateCondition, parseCondition } from './fql.js'

const EVENT = {
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1234',
  anonymousId: 'anon_1',
  properties: {
    revenue: 42.5,
    currency: 'USD',
    coupon: null,
    tags: ['a', 'b'],
    plan: 'pro',
    /* Deliberately one character off a real domain, to catch a glob pattern being
       handed to RegExp raw. See the match() test. */
    lookalike: 'avery@exampleXcom',
  },
  context: { app: { name: 'Storefront', version: '2.1' }, locale: 'en-US' },
  traits: { email: 'avery@example.com' },
}

const matches = (condition, event = EVENT) => {
  const result = evaluateCondition(condition, event)
  expect(result.parsed, `failed to parse: ${result.error}`).toBe(true)
  return result.matched
}

describe('field paths', () => {
  it('reads top-level fields', () => {
    expect(matches('type = "track"')).toBe(true)
    expect(matches('event = "Order Completed"')).toBe(true)
    expect(matches('event = "Product Added"')).toBe(false)
  })

  it('reads nested paths', () => {
    expect(matches('context.app.name = "Storefront"')).toBe(true)
    expect(matches('properties.revenue > 40')).toBe(true)
    expect(matches('properties.revenue > 100')).toBe(false)
  })

  it('treats an absent path as nil rather than throwing', () => {
    expect(matches('properties.missing = "x"')).toBe(false)
    expect(matches('properties.deeply.nested.missing = "x"')).toBe(false)
  })

  it('reads a quoted segment for keys that are not identifiers', () => {
    expect(matches('properties."plan" = "pro"')).toBe(true)
  })
})

describe('nil tests', () => {
  it('is nil covers both absent and explicitly null', () => {
    expect(matches('properties.missing is nil')).toBe(true)
    expect(matches('properties.coupon is nil')).toBe(true)
  })

  it('is not nil is the complement', () => {
    expect(matches('properties.revenue is not nil')).toBe(true)
    expect(matches('properties.missing is not nil')).toBe(false)
  })
})

describe('comparison against a missing field', () => {
  it('never equals a concrete value', () => {
    expect(matches('properties.missing = "pro"')).toBe(false)
  })

  /* The documented interpretation in fql.js: absent is unequal to a concrete
     value, so `!=` holds. The point of the test is that this stays consistent with
     `not (... = ...)`, which is the pair that would otherwise contradict. */
  it('is unequal to a concrete value, and agrees with a negated equality', () => {
    expect(matches('properties.missing != "pro"')).toBe(true)
    expect(matches('not properties.missing = "pro"')).toBe(true)
  })

  it('has no ordering', () => {
    expect(matches('properties.missing > 0')).toBe(false)
    expect(matches('properties.missing < 0')).toBe(false)
  })
})

describe('boolean composition', () => {
  it('ands, ors, and negates', () => {
    expect(matches('type = "track" and properties.revenue > 40')).toBe(true)
    expect(matches('type = "track" and properties.revenue > 100')).toBe(false)
    expect(matches('type = "page" or properties.revenue > 40')).toBe(true)
    expect(matches('not type = "page"')).toBe(true)
    expect(matches('!(type = "track")')).toBe(false)
  })

  it('respects parentheses over default precedence', () => {
    expect(matches('type = "page" and properties.revenue > 40 or event = "Order Completed"')).toBe(true)
    expect(matches('type = "page" and (properties.revenue > 40 or event = "Order Completed")')).toBe(false)
  })
})

describe('membership', () => {
  it('matches a list in either bracket style', () => {
    expect(matches('event in ["Order Completed", "Product Added"]')).toBe(true)
    expect(matches('event in ("Product Added", "Cart Viewed")')).toBe(false)
  })
})

describe('functions', () => {
  it('contains does a substring test', () => {
    expect(matches('contains(traits.email, "@example.com")')).toBe(true)
    expect(matches('contains(traits.email, "@other.com")')).toBe(false)
  })

  /* Segment's match is glob-style. If the pattern were passed to RegExp raw, the
     literal dot in "*@example.com" would match any character, so it would also
     match properties.lookalike -- which is exactly the false pass this asserts
     against. */
  it('match is a glob, not a regex', () => {
    expect(matches('match(traits.email, "*@example.com")')).toBe(true)
    expect(matches('match(properties.lookalike, "*@example.com")')).toBe(false)
  })

  it('match treats ? as exactly one character', () => {
    expect(matches('match(properties.plan, "p?o")')).toBe(true)
    expect(matches('match(properties.plan, "p?")')).toBe(false)
  })

  it('lowercase and length compose with comparison', () => {
    expect(matches('lowercase(context.app.name) = "storefront"')).toBe(true)
    expect(matches('length(properties.tags) = 2')).toBe(true)
    expect(matches('typeof(properties.revenue) = "number"')).toBe(true)
    expect(matches('typeof(properties.missing) = "nil"')).toBe(true)
  })
})

describe('an empty condition', () => {
  it('matches everything, and says so', () => {
    const result = evaluateCondition('', EVENT)
    expect(result).toMatchObject({ parsed: true, matched: true, empty: true })
  })
})

describe('conditions outside the subset', () => {
  const unreadable = [
    'properties.revenue >',
    'contains(properties.plan',
    'properties.plan ~= "pro"',
    'coalesce(properties.a, properties.b) = 1',
    '"unterminated',
  ]

  it.each(unreadable)('reports %s as unparsed with no verdict', (condition) => {
    const result = evaluateCondition(condition, EVENT)
    expect(result.parsed).toBe(false)
    /* Null, not false: a caller that reads `matched` as a boolean gets a falsy
       value it cannot mistake for a real "does not match". */
    expect(result.matched).toBeNull()
    expect(result.error).toBeTruthy()
  })

  it('throws from the parser directly, so callers cannot get a silent default', () => {
    expect(() => parseCondition('properties.revenue >')).toThrow()
  })
})
