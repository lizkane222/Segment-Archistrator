/*
 * An event drawn on the canvas, and what it shows.
 *
 * Two kinds of card share one renderer. A **sample** carries its own payload -- dragged out of the
 * Events tab, it is a copy of that event and nothing in the diagram changes it. A **preview** carries
 * none: it names a path and a place on it (a component, or a connector), and shows the payload the
 * walkthrough has there, so the same event can be read at the source, after the insert function, at the
 * mapping and at the destination by putting a card at each.
 *
 * Which fields a card shows is its own: `shownFields` is a list of paths into the payload, empty by
 * default. A duplicate is a copy of the node's data, so every instance keeps its own list -- the whole
 * point of having several.
 */

const MAX_DEPTH = 8
const MAX_FIELDS = 300

const isObject = (value) => value !== null && typeof value === 'object'

/*
 * The order a card lists its fields in, top to bottom: what kind of call it is, what it is called, who it
 * is about, then the bodies. Both spellings of the two ids are named, because a payload can carry either
 * `userId` (the spec) or `user_id` (what the warehouse tables and the Profile API call it). A key not
 * named here follows in the payload's own order.
 */
const FIELD_ORDER = [
  ['type'],
  ['event'],
  ['userId', 'user_id'],
  ['anonymousId', 'anonymous_id'],
  ['properties'],
  ['traits'],
  ['context'],
]
const rankOf = (key) => {
  const at = FIELD_ORDER.findIndex((names) => names.includes(key))
  return at < 0 ? FIELD_ORDER.length : at
}

/**
 * Every key:value pair in a payload, as `{path, value}` in document order.
 *
 * Leaves only: `properties.total`, `traits.address.city`, `items[0].sku`. An empty object or list is
 * itself a leaf (there is nothing inside to show). Capped, because a payload is user-pasted and a card
 * is not a place for ten thousand rows.
 */
export function flattenPayload(payload) {
  const rows = []
  const walk = (value, path, depth) => {
    if (rows.length >= MAX_FIELDS) return
    if (isObject(value) && depth < MAX_DEPTH) {
      let entries
      if (Array.isArray(value)) {
        entries = value.map((item, index) => [`${path}[${index}]`, item])
      } else {
        entries = Object.entries(value)
        /* Only the top level is put in the card's order; a stable sort leaves the rest as they came. */
        if (!path) entries = entries.map((entry, index) => [entry, index]).sort((a, b) => rankOf(a[0][0]) - rankOf(b[0][0]) || a[1] - b[1]).map(([entry]) => entry)
        entries = entries.map(([key, item]) => [path ? `${path}.${key}` : key, item])
      }
      if (entries.length) {
        for (const [childPath, item] of entries) walk(item, childPath, depth + 1)
        return
      }
    }
    if (path) rows.push({ path, value })
  }
  walk(payload, '', 0)
  return rows
}

/** The value at a path produced by `flattenPayload`, or undefined. */
export function valueAt(payload, path) {
  const parts = String(path).match(/[^.[\]]+/g) ?? []
  let current = payload
  for (const part of parts) {
    if (!isObject(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * The payload with the value at `path` replaced, or added -- a copy, never a mutation. Missing objects on
 * the way are made. `value` is whatever the field should now hold.
 */
export function setValueAt(payload, path, value) {
  const parts = String(path).match(/[^.[\]]+/g) ?? []
  if (!parts.length) return payload
  const copy = (source) => (Array.isArray(source) ? [...source] : isObject(source) ? { ...source } : {})
  const root = copy(payload)
  let cursor = root
  parts.forEach((part, index) => {
    const key = Array.isArray(cursor) ? Number(part) : part
    if (index === parts.length - 1) {
      cursor[key] = value
      return
    }
    const nextIsIndex = /^\d+$/.test(parts[index + 1])
    cursor[key] = isObject(cursor[key]) ? copy(cursor[key]) : nextIsIndex ? [] : {}
    cursor = cursor[key]
  })
  return root
}

/** The payload without the value at `path`. A copy; the same object when the path is not there. */
export function removeAt(payload, path) {
  const parts = String(path).match(/[^.[\]]+/g) ?? []
  if (!parts.length || valueAt(payload, path) === undefined) return payload
  const copy = (source) => (Array.isArray(source) ? [...source] : { ...source })
  const root = copy(payload)
  let cursor = root
  parts.slice(0, -1).forEach((part) => {
    const key = Array.isArray(cursor) ? Number(part) : part
    cursor[key] = copy(cursor[key])
    cursor = cursor[key]
  })
  const last = parts[parts.length - 1]
  if (Array.isArray(cursor)) cursor.splice(Number(last), 1)
  else delete cursor[last]
  return root
}

/**
 * What text typed into a field should become, given what the field held: a number stays a number when what
 * is typed is one, a boolean stays a boolean, null accepts JSON, and anything else is text. A field that
 * held text keeps text even if it looks like a number -- an id of `123` is not the number 123.
 */
export function coerceLike(previous, text) {
  const raw = String(text)
  if (typeof previous === 'number') {
    const number = Number(raw)
    return raw.trim() !== '' && Number.isFinite(number) ? number : raw
  }
  if (typeof previous === 'boolean') {
    if (raw.trim() === 'true') return true
    if (raw.trim() === 'false') return false
    return raw
  }
  if (previous === null || previous === undefined) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (isObject(previous)) {
    try {
      return JSON.parse(raw)
    } catch {
      return previous
    }
  }
  return raw
}

/** The rows a card draws: the chosen paths that exist in this payload, in the payload's own order. */
export function shownRows(payload, shownFields) {
  const wanted = new Set(shownFields ?? [])
  if (!wanted.size) return []
  return flattenPayload(payload).filter((row) => wanted.has(row.path))
}

/** `shown` with `path` switched on or off. */
export function toggleField(shown, path) {
  const list = shown ?? []
  return list.includes(path) ? list.filter((entry) => entry !== path) : [...list, path]
}

/** How a leaf reads on a card. Strings are bare, everything else is JSON. */
export function displayValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/**
 * The payload a run holds at one place: a component's arrival, or a connector's crossing.
 *
 * `anchor` is `{type: 'node' | 'edge', id}`. Null when the run never gets there -- a destination the
 * event was filtered out of has no payload, and a card there should say so rather than show whatever
 * was last in flight.
 */
export function payloadAtAnchor(trace, anchor) {
  if (!trace || !anchor?.id) return null
  let payload = trace.event ?? null
  for (const step of trace.steps ?? []) {
    if (step.payload) payload = step.payload
    const hit = anchor.type === 'edge' ? step.edgeId === anchor.id : step.nodeId === anchor.id
    if (hit) return payload
  }
  return null
}

/** A node's data for a sample card. */
export function sampleCardData({ type, payload, name }) {
  return {
    kind: 'event',
    name: name || payload?.event || type || 'Event',
    description: '',
    bound: true,
    bindable: false,
    eventType: type ?? payload?.type ?? 'track',
    eventPayload: payload ?? {},
    shownFields: [],
    size: { width: 240 },
  }
}

/** A node's data for a preview card. */
export function previewCardData({ scenarioId, anchor, anchorName }) {
  return {
    kind: 'event',
    name: anchorName ? `Event at ${anchorName}` : 'Event preview',
    description: '',
    bound: true,
    bindable: false,
    preview: { scenarioId, anchor },
    shownFields: [],
    size: { width: 240 },
  }
}
