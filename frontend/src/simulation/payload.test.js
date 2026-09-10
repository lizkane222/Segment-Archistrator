/*
 * The simulated event.
 *
 * Most of this is shape-checking, with two exceptions worth the reader's attention:
 * hydration must keep a property whose sample value Segment did not return (an
 * absent key would make a filter look like it passed on merit), and the skeletons
 * must not share mutable structure between calls -- the payload editor hands the
 * event straight to a controlled form, so a leaked reference would let one
 * simulation edit the next one's starting point.
 */

import { describe, expect, it } from 'vitest'

import {
  EVENT_TYPES,
  eventNameOf,
  hydrateProperties,
  identifiersOf,
  propertiesOf,
  resolvePath,
  skeleton,
  traitsOf,
} from './payload.js'

describe('skeletons', () => {
  it.each(EVENT_TYPES)('builds a %s call with a type, an id, and context', (type) => {
    const event = skeleton(type)
    expect(event.type).toBe(type)
    expect(event.userId).toBeTruthy()
    expect(event.anonymousId).toBeTruthy()
    expect(event.timestamp).toBeTruthy()
    expect(event.context.page.path).toBe('/pricing')
  })

  it('gives each type the fields its Spec call actually carries', () => {
    expect(skeleton('track').event).toBe('Order Completed')
    expect(skeleton('track').properties.revenue).toBe(42.5)
    expect(skeleton('identify').traits.email).toBe('avery@example.com')
    expect(skeleton('page').name).toBe('Pricing')
    expect(skeleton('group').groupId).toBeTruthy()
    expect(skeleton('alias').previousId).toBeTruthy()
  })

  it('returns null for a type that is not an event type', () => {
    expect(skeleton('screen')).toBeNull()
    expect(skeleton(undefined)).toBeNull()
  })

  /* The editor mutates the event it is given. Shared structure here would mean
     editing one simulation's payload silently changed the next one's default. */
  it('does not share mutable structure between calls', () => {
    const first = skeleton('track')
    first.properties.revenue = 999
    first.context.page.path = '/edited'
    const second = skeleton('track')
    expect(second.properties.revenue).toBe(42.5)
    expect(second.context.page.path).toBe('/pricing')
  })

  it('is deterministic, so a trace can be memoised on the event', () => {
    expect(skeleton('track')).toEqual(skeleton('track'))
  })

  it('accepts a caller-supplied timestamp', () => {
    expect(skeleton('track', { timestamp: '2020-02-02T00:00:00.000Z' }).timestamp).toBe(
      '2020-02-02T00:00:00.000Z',
    )
  })
})

describe('eventNameOf', () => {
  it('uses a track call own event name', () => {
    expect(eventNameOf({ type: 'track', event: 'Order Completed' })).toBe('Order Completed')
  })

  it('maps the non-track types to their Unify names', () => {
    expect(eventNameOf({ type: 'page' })).toBe('Page Viewed')
    expect(eventNameOf({ type: 'group' })).toBe('Group')
    expect(eventNameOf({ type: 'alias' })).toBe('Alias')
  })

  /* An identify has no event name at all, and returning something plausible would
     let an audience predicate match on a name that does not exist. */
  it('is null when there is no event name', () => {
    expect(eventNameOf({ type: 'identify' })).toBeNull()
    expect(eventNameOf({ type: 'track' })).toBeNull()
    expect(eventNameOf(null)).toBeNull()
  })
})

describe('hydrateProperties', () => {
  const base = skeleton('track')

  it('replaces the sample properties with the workspace ones', () => {
    const event = hydrateProperties(base, [
      { name: 'plan_tier', type: 'string', sampleValues: ['enterprise'] },
      { name: 'seat_count', type: 'number', sampleValues: [12] },
    ])
    expect(event.properties).toEqual({ plan_tier: 'enterprise', seat_count: 12 })
    expect(base.properties.revenue).toBe(42.5)
  })

  /* The case this function exists for. Dropping a name Segment reported without a
     sample would make a filter on that path look like it passed on merit. */
  it('keeps a property whose sample value is missing', () => {
    const event = hydrateProperties(base, [
      { name: 'plan_tier', type: 'string' },
      { name: 'seat_count', type: 'number' },
      { name: 'is_trial', type: 'boolean' },
      { name: 'tags', type: 'array' },
      { name: 'meta', type: 'object' },
      { name: 'unknowable' },
    ])
    expect(Object.keys(event.properties)).toEqual([
      'plan_tier',
      'seat_count',
      'is_trial',
      'tags',
      'meta',
      'unknowable',
    ])
    expect(event.properties.plan_tier).toBe('<plan_tier>')
    expect(event.properties.seat_count).toBe(0)
    expect(event.properties.is_trial).toBe(false)
    expect(event.properties.tags).toEqual([])
    expect(event.properties.meta).toEqual({})
  })

  it('ignores a null sample rather than writing null into the payload', () => {
    const event = hydrateProperties(base, [{ name: 'coupon', type: 'string', sampleValues: [null] }])
    expect(event.properties.coupon).toBe('<coupon>')
  })

  it('accepts the key/samples spelling as well', () => {
    const event = hydrateProperties(base, [{ key: 'plan_tier', samples: ['pro'] }])
    expect(event.properties.plan_tier).toBe('pro')
  })

  it('hydrates traits, not properties, for identify and group', () => {
    const event = hydrateProperties(skeleton('identify'), [{ name: 'ltv', sampleValues: [1200] }])
    expect(event.traits).toEqual({ ltv: 1200 })
    expect(event.properties).toBeUndefined()
  })

  /* An empty schema response must leave the realistic sample payload in place;
     replacing it with {} would make every filter drop the event. */
  it('leaves the event alone when there is nothing to hydrate', () => {
    expect(hydrateProperties(base, [])).toBe(base)
    expect(hydrateProperties(base, undefined)).toBe(base)
    expect(hydrateProperties(base, [{ type: 'string' }])).toBe(base)
  })
})

describe('resolvePath', () => {
  const event = skeleton('track')

  it('reads nested paths', () => {
    expect(resolvePath(event, 'context.page.path')).toBe('/pricing')
    expect(resolvePath(event, 'properties.revenue')).toBe(42.5)
    expect(resolvePath(event, 'type')).toBe('track')
  })

  it('is undefined for anything absent, at any depth', () => {
    expect(resolvePath(event, 'properties.missing')).toBeUndefined()
    expect(resolvePath(event, 'properties.missing.deeper')).toBeUndefined()
    expect(resolvePath(event, 'type.nope')).toBeUndefined()
  })

  /* Matching FQL's `is nil`, which does not distinguish the two either. */
  it('does not distinguish an explicit null from an absent key', () => {
    expect(resolvePath({ properties: { coupon: null } }, 'properties.coupon')).toBeUndefined()
  })

  it('handles a missing event or path without throwing', () => {
    expect(resolvePath(null, 'type')).toBeUndefined()
    expect(resolvePath(event, '')).toBeUndefined()
  })
})

describe('traitsOf', () => {
  it('reads top-level traits from identify and group', () => {
    expect(traitsOf(skeleton('identify')).email).toBe('avery@example.com')
    expect(traitsOf(skeleton('group')).industry).toBe('Software')
  })

  /* A track call's traits live under context, and an audience `trait()` predicate
     has to find them there or it reports UNKNOWN for a trait the event just set. */
  it('reads context.traits from every other type', () => {
    expect(traitsOf({ type: 'track', context: { traits: { plan: 'pro' } } }).plan).toBe('pro')
    expect(traitsOf({ type: 'track', traits: { plan: 'pro' } })).toEqual({})
  })

  it('is an empty object rather than undefined when there are none', () => {
    expect(traitsOf(skeleton('alias'))).toEqual({})
    expect(traitsOf(null)).toEqual({})
    expect(propertiesOf(null)).toEqual({})
  })
})

describe('identifiersOf', () => {
  it('lists identifiers in Segment precedence order', () => {
    const event = {
      type: 'identify',
      userId: 'user_1',
      anonymousId: 'anon_1',
      groupId: 'group_1',
      traits: { email: 'a@b.com' },
    }
    expect(identifiersOf(event).map((id) => id.key)).toEqual([
      'userId',
      'email',
      'groupId',
      'anonymousId',
    ])
  })

  it('finds an email a track call carries under context', () => {
    const event = { type: 'track', anonymousId: 'anon_1', context: { traits: { email: 'a@b.com' } } }
    expect(identifiersOf(event).map((id) => id.key)).toEqual(['email', 'anonymousId'])
  })

  /* An event with no identifier cannot be attached to a profile, which is what
     makes the space node stop rather than fan out to audiences. */
  it('is empty for an event with nothing to key on', () => {
    expect(identifiersOf({ type: 'track', event: 'X' })).toEqual([])
    expect(identifiersOf(null)).toEqual([])
  })
})
