/*
 * Names for diagrams that start life as a copy of something else.
 *
 * Two tabs holding "the same diagram" must be told apart, and must not be able to overwrite one
 * another on save. The second half is `doc.id` (a copy has none); this file is the first half.
 *
 * Pure, so the rules -- which are all about what already exists -- are tested rather than clicked.
 */

/** `2026-11-16` -> `11-16-26`, in the reader's local time. */
export function dateTag(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getFullYear() % 100)}`
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `base` if nothing else is called that, otherwise `base (V2)`, `base (V3)`, ...
 *
 * Counts on from the highest version seen rather than filling gaps, so deleting V2 does not make the
 * next one a second V2 beside a V3 that is still open.
 */
export function versioned(base, taken = []) {
  const pattern = new RegExp(`^${escape(base)}(?: \\(V(\\d+)\\))?$`)
  let highest = 0
  for (const name of taken) {
    const match = pattern.exec((name ?? '').trim())
    if (match) highest = Math.max(highest, match[1] ? Number(match[1]) : 1)
  }
  return highest === 0 ? base : `${base} (V${highest + 1})`
}

/** A new diagram from a template: `Name 11-16-26`, then `Name 11-16-26 (V2)` the same day. */
export function templateInstanceName(templateName, taken = [], date = new Date()) {
  return versioned(`${(templateName ?? '').trim()} ${dateTag(date)}`, taken)
}

/** A saved diagram opened a second time: `Name (V2)`. Its own `(V#)` is not stacked. */
export function openedAgainName(name, taken = []) {
  const base = (name ?? '').trim().replace(/ \(V\d+\)$/, '')
  return versioned(base, [name, ...taken])
}
