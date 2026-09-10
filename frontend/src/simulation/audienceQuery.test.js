/*
 * Audience and computed-trait definitions.
 *
 * The corpus below is the set of *shapes* found in a real workspace's audience
 * list -- every construct the parser claims to support appears in production
 * somewhere. Customer-specific event and trait names have been replaced with
 * generic ones; the structure, including the oddities (bare `.20` decimals, a
 * `parent:` window, a leading `ANY`), is verbatim. That corpus is what stops this
 * grammar drifting into something only the tests use.
 *
 * The monotonicity group is the heart of the file. Those cases are the difference
 * between a simulator you can trust and one that tells a professional-services
 * engineer an audience will not match when it might already.
 */

import { describe, expect, it } from 'vitest'

import { evaluateQuery, parseQuery } from './audienceQuery.js'
import { HISTORY, UNSUPPORTED, dominantCause, explain } from './logic.js'

/* Shapes observed in a live workspace, names genericised. */
const CORPUS = [
  "event('Page Viewed').where(property('path').contains('/user/')).count() >= 1 AND event('Subscription Created').where(property('email').exists()).count() >= 1",
  "event('Order Completed').count() >= 1 AND event('Page Viewed').where(property('page_name') = 'Docs').count() >= 1",
  "event('Quote Generated').where(property('quote_id') = trait('quote_id')).count() >= 1",
  "trait('primaryEmail').exists()",
  "trait('first_name_exists') = 'true' AND NOT trait('avatar_added') = 'true'",
  "trait('a') = 'true' OR trait('b') = 'true' OR trait('c') = 'true'",
  "trait('predictive_vip_665') <= .20 AND event('Page Viewed').within(90 days).count() = 0",
  "trait('predictive_vip_665') >= .80 AND trait('predictive_ready_859') >= .90 AND event('Page Viewed').within(14 days).count() >= 1",
  "event('Page Viewed').where(context('timestamp').before_date('2023-08-25T02:00:00-07:00')).count() >= 1",
  "trait('j_o_flow__step_ghgzm') = 'true'",
  "event('Product Added').where(NOT event('Order Completed').within(parent: 30 days).count() = 1).between(14 days, 30 days).count() >= 1",
  "event('User Registered').count() >= 3",
  "ANY event('Audience Entered').within(30 days).count() >= 1",
  "trait('email').contains('@') AND event('Motivation Submitted').count() >= 1",
  "event('Before Unload').within(30 days).count() >= 1",
]

const track = (event, properties = {}, extra = {}) => ({
  type: 'track',
  event,
  userId: 'user_1',
  properties,
  timestamp: '2026-01-15T10:30:00.000Z',
  ...extra,
})

const identify = (traits) => ({
  type: 'identify',
  userId: 'user_1',
  traits,
  timestamp: '2026-01-15T10:30:00.000Z',
})

describe('the real-world corpus', () => {
  it.each(CORPUS)('parses %s', (query) => {
    expect(() => parseQuery(query)).not.toThrow()
  })

  it.each(CORPUS)('evaluates without throwing: %s', (query) => {
    expect(() => evaluateQuery(query, track('Page Viewed'))).not.toThrow()
  })
})

describe('event counts, decided by monotonicity', () => {
  /* The event contributes 1, and history can only add, so >= 1 is settled. */
  it('is TRUE when this event alone satisfies the threshold', () => {
    const verdict = evaluateQuery("event('Order Completed').count() >= 1", track('Order Completed'))
    expect(verdict.value).toBe('true')
  })

  /* The whole point. One event contributes 1 of 3; the profile may hold the rest. */
  it('is UNKNOWN when the threshold needs more events than one', () => {
    const verdict = evaluateQuery("event('User Registered').count() >= 3", track('User Registered'))
    expect(verdict.value).toBe('unknown')
    expect(dominantCause(verdict)).toBe(HISTORY)
  })

  /* Equally the point, in the other direction: a non-matching event proves nothing,
     because the profile's history is where the matching events would be. */
  it('is UNKNOWN when a different event was simulated', () => {
    const verdict = evaluateQuery("event('Order Completed').count() >= 1", track('Page Viewed'))
    expect(verdict.value).toBe('unknown')
    expect(explain(verdict).join(' ')).toMatch(/not event\('Order Completed'\)/)
  })

  /* count() = 0 is the case a single event CAN refute: counts only grow. */
  it('is FALSE when this event makes a zero-count impossible', () => {
    const verdict = evaluateQuery("event('Page Viewed').within(90 days).count() = 0", track('Page Viewed'))
    expect(verdict.value).toBe('false')
  })

  it('is UNKNOWN for a zero-count the simulated event does not contribute to', () => {
    const verdict = evaluateQuery("event('Page Viewed').within(90 days).count() = 0", track('Order Completed'))
    expect(verdict.value).toBe('unknown')
  })

  it('refutes an upper bound this event already exceeds', () => {
    expect(evaluateQuery("event('Page Viewed').count() <= 0", track('Page Viewed')).value).toBe('false')
    expect(evaluateQuery("event('Page Viewed').count() < 1", track('Page Viewed')).value).toBe('false')
  })

  it('treats a bare count() as "it happened"', () => {
    expect(evaluateQuery("event('Page Viewed').count()", track('Page Viewed')).value).toBe('true')
  })
})

describe('time windows', () => {
  /* The simulated event happens now, so it is inside any lookback window. */
  it('a within() window does not stop this event contributing', () => {
    expect(evaluateQuery("event('Page Viewed').within(30 days).count() >= 1", track('Page Viewed')).value).toBe('true')
  })

  /* ...but it cannot be in the past, so a between() window excludes it. */
  it('a between() window excludes an event happening now', () => {
    const verdict = evaluateQuery("event('Page Viewed').between(14 days, 30 days).count() >= 1", track('Page Viewed'))
    expect(verdict.value).toBe('unknown')
    expect(explain(verdict).join(' ')).toMatch(/happening now/)
  })

  it('reports a parent-relative window as unsupported rather than guessing', () => {
    const verdict = evaluateQuery(
      "event('Product Added').where(NOT event('Order Completed').within(parent: 30 days).count() = 1).count() >= 1",
      track('Product Added'),
    )
    expect(dominantCause(verdict)).toBe(UNSUPPORTED)
  })
})

describe('where() clauses', () => {
  it('excludes the event when its properties do not satisfy the clause', () => {
    const verdict = evaluateQuery(
      "event('Page Viewed').where(property('path').contains('/user/')).count() >= 1",
      track('Page Viewed', { path: '/pricing' }),
    )
    expect(verdict.value).toBe('unknown')
  })

  it('counts the event when its properties do satisfy the clause', () => {
    const verdict = evaluateQuery(
      "event('Page Viewed').where(property('path').contains('/user/')).count() >= 1",
      track('Page Viewed', { path: '/user/42' }),
    )
    expect(verdict.value).toBe('true')
  })

  /* An event's own properties are fully known, so an absent one is a definite
     "does not satisfy" -- unlike an absent trait. */
  it('treats an absent property as definitely not satisfying the clause', () => {
    const verdict = evaluateQuery(
      "event('Page Viewed').where(property('path').exists()).count() >= 1",
      track('Page Viewed', {}),
    )
    expect(verdict.value).toBe('unknown')
    expect(explain(verdict).join(' ')).toMatch(/where\(\) clause/)
  })

  /* A property the event does not carry is definitely absent, unlike a trait, so a
     comparison against it is settled -- and `!=` holds where `=` does not. This is
     the only path that reaches the missing-operand rule in compareValues. */
  it('settles a comparison against a property the event does not carry', () => {
    const unequal = evaluateQuery(
      "event('Page Viewed').where(property('plan') != 'pro').count() >= 1",
      track('Page Viewed', {}),
    )
    expect(unequal.value).toBe('true')

    const equal = evaluateQuery(
      "event('Page Viewed').where(property('plan') = 'pro').count() >= 1",
      track('Page Viewed', {}),
    )
    expect(equal.value).toBe('unknown')
  })

  it('is UNKNOWN when the clause compares against a trait the event does not set', () => {
    const verdict = evaluateQuery(
      "event('Quote Generated').where(property('quote_id') = trait('quote_id')).count() >= 1",
      track('Quote Generated', { quote_id: 'q_1' }),
    )
    expect(verdict.value).toBe('unknown')
    expect(explain(verdict).join(' ')).toMatch(/trait\('quote_id'\)/)
  })
})

describe('traits', () => {
  it('is definite for a trait this event sets', () => {
    expect(evaluateQuery("trait('email').exists()", identify({ email: 'a@b.com' })).value).toBe('true')
    expect(evaluateQuery("trait('plan') = 'pro'", identify({ plan: 'pro' })).value).toBe('true')
    expect(evaluateQuery("trait('plan') = 'pro'", identify({ plan: 'free' })).value).toBe('false')
    expect(evaluateQuery("trait('email').contains('@')", identify({ email: 'a@b.com' })).value).toBe('true')
  })

  /* An absent trait is not a false trait: an earlier identify may have set it. */
  it('is UNKNOWN for a trait absent from the payload', () => {
    const verdict = evaluateQuery("trait('is_on_waitlist').exists()", identify({ email: 'a@b.com' }))
    expect(verdict.value).toBe('unknown')
    expect(dominantCause(verdict)).toBe(HISTORY)
  })

  it('names a predictive trait specifically, since no event can ever set one', () => {
    const verdict = evaluateQuery("trait('predictive_vip_665') >= .80", identify({ email: 'a@b.com' }))
    expect(explain(verdict).join(' ')).toMatch(/predictive trait/)
  })

  it('names journey-step membership specifically', () => {
    const verdict = evaluateQuery("trait('j_o_flow__step_ghgzm') = 'true'", identify({}))
    expect(explain(verdict).join(' ')).toMatch(/journey-step membership/)
  })

  it('reads traits a track call carries under context', () => {
    const event = track('Order Completed', {}, { context: { traits: { plan: 'pro' } } })
    expect(evaluateQuery("trait('plan') = 'pro'", event).value).toBe('true')
  })

  it('parses a bare decimal threshold', () => {
    expect(evaluateQuery("trait('score') <= .20", identify({ score: 0.1 })).value).toBe('true')
    expect(evaluateQuery("trait('score') <= .20", identify({ score: 0.5 })).value).toBe('false')
  })
})

describe('three-valued composition', () => {
  /* An unknown clause must not cost a verdict the rest of the query settles. */
  it('an unknown ANDed with a definite FALSE is still FALSE', () => {
    const verdict = evaluateQuery(
      "trait('unknowable').exists() AND trait('plan') = 'enterprise'",
      identify({ plan: 'free' }),
    )
    expect(verdict.value).toBe('false')
  })

  it('an unknown ORed with a definite TRUE is still TRUE', () => {
    const verdict = evaluateQuery(
      "trait('unknowable').exists() OR trait('plan') = 'free'",
      identify({ plan: 'free' }),
    )
    expect(verdict.value).toBe('true')
  })

  it('NOT of a definite value is definite', () => {
    expect(evaluateQuery("NOT trait('plan') = 'pro'", identify({ plan: 'free' })).value).toBe('true')
  })

  it('NOT of an unknown stays unknown', () => {
    expect(evaluateQuery("NOT trait('absent') = 'pro'", identify({})).value).toBe('unknown')
  })

  it('respects explicit parentheses', () => {
    const event = identify({ a: 'true', b: 'false', c: 'false' })
    expect(evaluateQuery("trait('a') = 'true' OR trait('b') = 'true' AND trait('c') = 'true'", event).value).toBe('true')
    expect(evaluateQuery("(trait('a') = 'true' OR trait('b') = 'true') AND trait('c') = 'true'", event).value).toBe('false')
  })
})

describe('context predicates', () => {
  it('compares the event timestamp as a date', () => {
    const event = track('Page Viewed')
    expect(
      evaluateQuery("event('Page Viewed').where(context('timestamp').before_date('2030-01-01T00:00:00Z')).count() >= 1", event).value,
    ).toBe('true')
    expect(
      evaluateQuery("event('Page Viewed').where(context('timestamp').after_date('2030-01-01T00:00:00Z')).count() >= 1", event).value,
    ).toBe('unknown')
  })
})

describe('quantifiers and unreadable definitions', () => {
  it('reports a quantifier as unsupported rather than ignoring it', () => {
    const verdict = evaluateQuery("ANY event('Audience Entered').within(30 days).count() >= 1", track('Audience Entered'))
    expect(dominantCause(verdict)).toBe(UNSUPPORTED)
  })

  it.each([
    "event('X').sometimes() >= 1",
    "trait('x') ~ 'y'",
    "event('X').count() >=",
    'nonsense',
    "trait('unterminated",
  ])('never throws and never returns a definite verdict for %s', (query) => {
    const verdict = evaluateQuery(query, track('X'))
    expect(verdict.value).toBe('unknown')
    expect(dominantCause(verdict)).toBe(UNSUPPORTED)
  })

  it('treats a missing definition as nothing to evaluate', () => {
    expect(evaluateQuery('', track('X')).value).toBe('unknown')
    expect(evaluateQuery(null, track('X')).value).toBe('unknown')
  })
})

describe('page, group, and alias events', () => {
  it('surfaces a page call under its Unify event name', () => {
    const page = { type: 'page', userId: 'user_1', name: 'Pricing', properties: { path: '/pricing' } }
    expect(evaluateQuery("event('Page Viewed').count() >= 1", page).value).toBe('true')
  })

  it('reads group traits', () => {
    const group = { type: 'group', userId: 'user_1', groupId: 'g_1', traits: { industry: 'Software' } }
    expect(evaluateQuery("trait('industry') = 'Software'", group).value).toBe('true')
  })
})
