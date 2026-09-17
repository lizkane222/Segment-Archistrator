/*
 * Turning a pasted Segment Profile API response into something a panel can render.
 *
 * There is no endpoint that lists a space's profiles -- see the comment on
 * `PROFILE_SECTIONS` in canvas/grouping.js -- so a real profile only ever gets onto
 * a diagram by hand: someone runs a Profile API call in Postman or curl and pastes
 * the JSON in here. Five endpoints, five shapes, and nothing in any of them says
 * which endpoint it came from, so `detectPaste` tells them apart the same way the
 * rest of this codebase tells components apart -- by which fields are actually on
 * the object, not by asking the caller.
 *
 * The traits endpoint is the interesting one: it returns one flat object with every
 * trait a profile carries, custom and computed and audience-membership alike, and
 * nothing in that response says which is which. `classifyTraits` answers that the
 * same way `canvas/grouping.js` groups components -- by reading it off the diagram
 * itself, not by guessing from the key's spelling. A trait key that matches an
 * audience or computed-trait component already on the canvas is that; a trait key
 * that matches Segment's journey-step naming convention is a journey step; anything
 * left over is a custom trait. That is deliberately the same shape as `TYPE_OF` in
 * grouping.js, and it fails the same way: a trait nothing on the canvas can vouch
 * for reads as custom, not as "unknown."
 */

/*
 * `j_o_<journey>__<step>_<hash>`, mirroring `JOURNEY_TRAIT_RE` in
 * apps/segmentapi/schemas.py and the same pattern `simulation/audienceQuery.js` and
 * `inspector/RulesTab.jsx`'s journey inference already lean on. Kept in sync by hand
 * across the two languages -- there is no shared source of truth for it -- so a
 * change to one without the other is a bug, not a style choice.
 */
export const JOURNEY_TRAIT_RE = /^j_o_(.+?)__(.+?)_[a-z0-9]{5,}$/

const EMPTY_SNAPSHOT = Object.freeze({
  identifiers: [],
  traits: {},
  metadata: {},
  events: [],
  links: [],
  importedAt: null,
})

/** A snapshot with nothing pasted into it yet. */
export function emptySnapshot() {
  return { ...EMPTY_SNAPSHOT }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Which of the five Profile API responses this is, from the shape alone.
 *
 * Order matters: `links` and `events` are both `{ data: [...] }`, so the entries
 * have to be inspected, not just the envelope -- and events are checked first
 * because an events entry that happens to carry no `properties` (a Track call with
 * none) still has `event`, where a links entry never does.
 */
export function detectPaste(parsed) {
  if (!isPlainObject(parsed)) {
    throw new Error('That is not a Profile API response -- expected a JSON object.')
  }

  if (isPlainObject(parsed.traits) && !Array.isArray(parsed.data)) {
    return 'traits'
  }

  if (isPlainObject(parsed.metadata) && typeof parsed.segment_id === 'string') {
    return 'metadata'
  }

  if (Array.isArray(parsed.data)) {
    const [first] = parsed.data
    if (!first) {
      throw new Error(
        'That response has no entries to tell identifiers, events and links apart -- paste one with at least one row.',
      )
    }
    if (typeof first.event === 'string') return 'events'
    if (typeof first.to_collection === 'string') return 'links'
    if (typeof first.type === 'string' && typeof first.collection === 'string') {
      return 'external_ids'
    }
  }

  throw new Error(
    'Unrecognized shape -- expected a traits, external_ids, metadata, events, or links response from the Profile API.',
  )
}

/**
 * The endpoint's own payload, trimmed to what the panel renders.
 *
 * Kept separate from `mergeSnapshot` so `detectPaste` + `extract` can be tested
 * against the exact sample shapes without also exercising the merge.
 */
function extract(kind, payload) {
  switch (kind) {
    case 'traits':
      return payload.traits ?? {}
    case 'external_ids':
      return payload.data ?? []
    case 'metadata':
      /* `segment_id` rides in on the envelope, not inside `metadata` itself -- see the
         sample response -- but it is the profile's own Unify id, so it belongs beside
         the rest of what this section shows rather than being the one field dropped. */
      return { ...(payload.metadata ?? {}), segment_id: payload.segment_id }
    case 'events':
      return payload.data ?? []
    case 'links':
      return payload.data ?? []
    default:
      return null
  }
}

const SECTION_OF = {
  traits: 'traits',
  external_ids: 'identifiers',
  metadata: 'metadata',
  events: 'events',
  links: 'links',
}

/**
 * A fresh paste, folded into the existing snapshot.
 *
 * Replaces the one section the paste is for and leaves the rest untouched -- a
 * profile is built up over several pastes, one per endpoint, and re-pasting
 * `external_ids` after `traits` must not lose the traits. Each paste is a full read
 * of that endpoint rather than a diff, so it replaces rather than appends: pasting
 * the same `events` response twice must not double the list.
 */
export function mergeSnapshot(existing, kind, payload) {
  const section = SECTION_OF[kind]
  if (!section) throw new Error(`Unknown profile section: ${kind}`)

  return {
    ...emptySnapshot(),
    ...existing,
    [section]: extract(kind, payload),
    importedAt: Date.now(),
  }
}

/** Parse text, detect its shape, and fold it into `existing` in one step. */
export function importPaste(existing, text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON.')
  }
  const kind = detectPaste(parsed)
  return { kind, snapshot: mergeSnapshot(existing, kind, parsed) }
}

/** The `audienceKey` of every audience node on the canvas, present or not. */
function keyedNodes(nodes, kind, field) {
  const map = new Map()
  for (const node of nodes ?? []) {
    const data = node?.data ?? {}
    const key = data.kind === kind ? data[field] : null
    if (key) map.set(key, node)
  }
  return map
}

/**
 * The flat `traits` object, split into the four buckets the Unify profile explorer
 * shows -- by asking the diagram, not the trait's name. See the file comment.
 *
 * @param traits  the flat object from the `traits` endpoint
 * @param nodes   the diagram's own nodes, for cross-referencing audienceKey/traitKey
 */
export function classifyTraits(traits, nodes) {
  const audienceKeys = keyedNodes(nodes, 'audience', 'audienceKey')
  const computedKeys = keyedNodes(nodes, 'computed_trait', 'traitKey')

  const audiences = []
  const computedTraits = []
  const journeys = []
  const custom = []

  for (const [key, value] of Object.entries(traits ?? {})) {
    const entry = { key, value }

    if (audienceKeys.has(key)) {
      audiences.push({ ...entry, node: audienceKeys.get(key) })
      continue
    }
    if (computedKeys.has(key)) {
      computedTraits.push({ ...entry, node: computedKeys.get(key) })
      continue
    }
    const step = JOURNEY_TRAIT_RE.exec(key)
    if (step) {
      journeys.push({ ...entry, journey: step[1], step: step[2] })
      continue
    }
    custom.push(entry)
  }

  return { audiences, computedTraits, journeys, custom }
}

/** Journey trait rows, grouped by journey slug -- what `JourneySteps` in RulesTab.jsx
    already does for a journey node's own `steps`, applied here to whichever journey
    traits turned up on this profile. */
export function groupJourneys(journeyTraits) {
  const byJourney = new Map()
  for (const entry of journeyTraits ?? []) {
    const group = byJourney.get(entry.journey) ?? []
    group.push(entry)
    byJourney.set(entry.journey, group)
  }
  return [...byJourney.entries()].map(([journey, steps]) => ({ journey, steps }))
}

/** The `links` endpoint's rows, grouped by `to_collection` -- named for what actually
    came back (usually `accounts`) rather than assumed to be Engage's Linked
    Audiences, which this endpoint does not distinguish from any other link. */
export function linkedCollections(links) {
  const byCollection = new Map()
  for (const entry of links ?? []) {
    const collection = entry?.to_collection ?? 'unknown'
    const group = byCollection.get(collection) ?? []
    group.push(entry)
    byCollection.set(collection, group)
  }
  return [...byCollection.entries()].map(([collection, entries]) => ({ collection, entries }))
}

/** What each endpoint kind is called in the panel -- shared between the template
    picker and the "imported X" notification, so the two never drift apart. */
export const PROFILE_KIND_LABELS = {
  traits: 'Traits',
  external_ids: 'Identifiers',
  metadata: 'Metadata',
  events: 'Events',
  links: 'Linked profiles',
}

/*
 * A minimal, valid starting point for each endpoint -- so populating a Profile node
 * does not require already knowing the exact envelope a real Profile API call
 * returns. Each one is deliberately the smallest shape `detectPaste` still recognizes
 * for that kind, tested for exactly that below, so a future change to `detectPaste`'s
 * rules cannot silently leave a template it no longer accepts.
 */
export const PROFILE_KIND_TEMPLATES = {
  traits: JSON.stringify({ traits: { trait_key: 'value' }, cursor: {} }, null, 2),
  external_ids: JSON.stringify(
    {
      data: [
        {
          id: '',
          type: 'user_id',
          source_id: '',
          collection: 'users',
          created_at: '',
          encoding: 'none',
          first_message_id: '',
        },
      ],
      cursor: {},
    },
    null,
    2,
  ),
  metadata: JSON.stringify(
    {
      segment_id: '',
      metadata: {
        created_at: '',
        updated_at: '',
        expires_at: '',
        first_message_id: '',
        last_message_id: '',
        first_source_id: '',
      },
    },
    null,
    2,
  ),
  events: JSON.stringify(
    {
      data: [
        {
          event: '',
          type: 'track',
          message_id: '',
          timestamp: '',
          source_id: '',
          properties: {},
          context: {},
          external_ids: [],
          related: {},
        },
      ],
      cursor: {},
    },
    null,
    2,
  ),
  links: JSON.stringify(
    {
      data: [
        {
          to_collection: 'accounts',
          external_ids: [{ id: '', type: 'group_id', source_id: '', collection: 'accounts' }],
        },
      ],
      cursor: {},
    },
    null,
    2,
  ),
}

/**
 * The one thing about a profile worth showing without opening it -- so two Profile
 * nodes on the same canvas, both named "Profile" by default, don't look identical.
 *
 * Never written to `data.name`: that field is persisted and exported to PDF, and an
 * email or user id landing there would be exactly the customer PII `profileSnapshot`
 * being session-only (see diagram/serialize.js) exists to keep out of the document.
 * This is read straight off the snapshot at render time instead, in the same
 * derived-and-never-stored spirit.
 *
 * Priority mirrors how a person would point at a profile out loud: the trait that
 * reads as a name-like handle first, then whichever identifier the profile itself
 * treats as canonical, then whatever identifier exists at all, then the profile's own
 * internal id as a last resort.
 */
export function profileIdentity(snapshot) {
  const email = snapshot?.traits?.email
  if (typeof email === 'string' && email) {
    return { label: 'Email', value: email }
  }

  const identifiers = snapshot?.identifiers ?? []
  const userId = identifiers.find((entry) => entry?.type === 'user_id' && entry.id)
  if (userId) return { label: 'User ID', value: userId.id }

  const anyId = identifiers.find((entry) => entry?.id)
  if (anyId) return { label: anyId.type ?? 'ID', value: anyId.id }

  const segmentId = snapshot?.metadata?.segment_id
  if (typeof segmentId === 'string' && segmentId) {
    return { label: 'Profile ID', value: segmentId }
  }

  return null
}
