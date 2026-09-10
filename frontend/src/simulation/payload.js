/*
 * The event being simulated: skeletons, hydration, and field lookup.
 *
 * Skeletons follow the Spec shapes rather than a lowest-common-denominator
 * envelope, because destination filters are written against real field paths
 * (`properties.revenue`, `context.app.name`) and a filter tested against a
 * payload missing `context` would report a pass it has not earned.
 *
 * `resolvePath` is shared with fql.js on purpose: a filter's idea of what
 * `properties.total` means has to match what the payload editor shows the user,
 * or the simulator explains a drop by pointing at a field the user cannot see.
 */

export const EVENT_TYPES = ['track', 'identify', 'page', 'group', 'alias']

/* Fixed, not generated. A `new Date()` here would make every simulation a
   different document and defeat memoising the trace on (graph, event). Callers
   that want a live timestamp pass one in. */
const SAMPLE_TIMESTAMP = '2026-01-15T10:30:00.000Z'

const SHARED_CONTEXT = {
  ip: '198.51.100.24',
  locale: 'en-US',
  page: {
    path: '/pricing',
    referrer: 'https://www.google.com',
    title: 'Pricing',
    url: 'https://example.com/pricing',
  },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
}

const SKELETONS = {
  track: {
    type: 'track',
    event: 'Order Completed',
    userId: 'user_1234',
    properties: { order_id: 'ord_9876', revenue: 42.5, currency: 'USD', quantity: 2 },
  },
  identify: {
    type: 'identify',
    userId: 'user_1234',
    traits: { email: 'avery@example.com', firstName: 'Avery', plan: 'pro', created_at: SAMPLE_TIMESTAMP },
  },
  page: {
    type: 'page',
    userId: 'user_1234',
    name: 'Pricing',
    properties: { path: '/pricing', title: 'Pricing', url: 'https://example.com/pricing' },
  },
  group: {
    type: 'group',
    userId: 'user_1234',
    groupId: 'group_5678',
    traits: { name: 'Example Corp', industry: 'Software', employees: 220 },
  },
  alias: {
    type: 'alias',
    userId: 'user_1234',
    previousId: 'anon_abcdef123456',
  },
}

/**
 * The name an event surfaces under in Unify, for audience `event(...)` predicates.
 *
 * UNVERIFIED for everything but track, in the same sense as deeplinks.py: a track
 * call is unambiguously its own `event` name, and page/group/alias are believed to
 * appear as these canonical names in the audience builder but that has not been
 * checked against a real workspace. Anything wrong here produces an UNKNOWN
 * verdict rather than a false one, because a name mismatch means "this event does
 * not contribute" and contribution of zero is never definite on its own.
 */
export const UNIFY_EVENT_NAME = {
  page: 'Page Viewed',
  group: 'Group',
  alias: 'Alias',
}

export function eventNameOf(event) {
  if (!event?.type) return null
  if (event.type === 'track') return event.event ?? null
  return UNIFY_EVENT_NAME[event.type] ?? null
}

export function skeleton(type, { timestamp = SAMPLE_TIMESTAMP } = {}) {
  const base = SKELETONS[type]
  if (!base) return null
  return {
    ...structuredClone(base),
    anonymousId: 'anon_abcdef123456',
    timestamp,
    context: structuredClone(SHARED_CONTEXT),
  }
}

/**
 * Replace a skeleton's properties with the workspace's real ones.
 *
 * Only the property *names* come from the schema; a name with no sample value
 * gets a placeholder derived from its declared type rather than being dropped.
 * A filter written against `properties.plan_tier` has to see that key exist, and
 * omitting it because Segment reported no sample would make the filter look like
 * it passed on merit.
 */
export function hydrateProperties(event, properties) {
  if (!Array.isArray(properties) || properties.length === 0) return event

  const hydrated = {}
  for (const property of properties) {
    const name = property?.name ?? property?.key
    if (!name) continue
    hydrated[name] = sampleValueFor(property)
  }
  if (Object.keys(hydrated).length === 0) return event

  const slot = event.type === 'identify' || event.type === 'group' ? 'traits' : 'properties'
  return { ...event, [slot]: hydrated }
}

function sampleValueFor(property) {
  const samples = property?.sampleValues ?? property?.samples
  if (Array.isArray(samples) && samples.length > 0 && samples[0] != null) return samples[0]

  switch ((property?.type ?? '').toLowerCase()) {
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return `<${property?.name ?? 'value'}>`
  }
}

/**
 * Look up a dotted path, returning `undefined` for anything absent.
 *
 * Deliberately does not distinguish "key missing" from "key present and null":
 * FQL's `is nil` is true for both, and inventing a distinction here would put
 * this module and the filter language at odds.
 */
export function resolvePath(event, path) {
  if (!event || !path) return undefined
  let current = event
  for (const segment of String(path).split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current ?? undefined
}

/** Traits this event sets, if any. Track calls can carry them under context. */
export function traitsOf(event) {
  if (!event) return {}
  if (event.type === 'identify' || event.type === 'group') return event.traits ?? {}
  return event.context?.traits ?? {}
}

export function propertiesOf(event) {
  return event?.properties ?? {}
}

/** Identifiers identity resolution would key on, in Segment's precedence order. */
export function identifiersOf(event) {
  const traits = traitsOf(event)
  const found = []
  if (event?.userId) found.push({ key: 'userId', value: event.userId })
  if (traits.email) found.push({ key: 'email', value: traits.email })
  if (event?.groupId) found.push({ key: 'groupId', value: event.groupId })
  if (event?.anonymousId) found.push({ key: 'anonymousId', value: event.anonymousId })
  return found
}
