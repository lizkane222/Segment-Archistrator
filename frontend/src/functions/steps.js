/*
 * The checklist: what a function is supposed to do, tied to the lines that do it.
 *
 * A function's verdict is one word -- "returned the event" -- and that is not what someone
 * wants to know about a forty-line handler. What they want is the list they had in their
 * head when they wrote it: *drops test traffic, redacts the vendor's forbidden traits,
 * stamps the region*. Each of those is a line, and a run either reached that line or it
 * did not. So a checklist item is a sentence plus an anchor, and running an event through
 * turns it into a tick or a cross.
 *
 * ## Where the anchor lives, and why it is a comment
 *
 * In the code, as `// @step s1`.
 *
 * The obvious alternative is to store a line *number* on the item. That breaks the moment
 * anyone edits: press return above line 12 and every anchor below it now points one line
 * too high, silently, and the checklist starts reporting on the wrong statements. Keeping
 * the anchor as text on the line it belongs to makes the whole problem go away -- the
 * marker moves with its line through inserts, deletes, reorders and reindents, because it
 * *is* part of that line. The user's requirement that "the line should update
 * automatically if the code is updated" is then not a feature to maintain but a property
 * of where the anchor is kept.
 *
 * It costs a comment in code that may get pasted back into Segment, which is a fair price:
 * it is inert there, and it documents the same thing the checklist does.
 *
 * Deleting the marker by hand is the natural way to unanchor an item, and it works.
 *
 * ## Why the label is not in the comment too
 *
 * Because then the list could only ever be in code order, and could not exist before the
 * code does. Someone writing down the three things a function will do, and *then* anchoring
 * them, is the order this gets used in. So labels and order live on the node
 * (`data.checklist`), the anchor lives in the source, and the id is what joins them.
 */

import { probePoint, spans } from './prepare.js'

/* `@step` then the id. Tolerant of the spacing, because people will retype these. */
const MARKER = /@step\s+([A-Za-z0-9_-]{1,12})/g

/** The text appended to a line to anchor it. */
export const markerFor = (id) => `// @step ${id}`

/**
 * Ids in use, in the order they appear, wherever they appear.
 *
 * Read from the whole source rather than from comment spans only: an id inside a string
 * would be a very odd thing to write, and treating it as taken costs nothing while
 * mis-reusing it would put two markers in play for one item.
 */
export function usedIds(source) {
  return [...String(source ?? '').matchAll(MARKER)].map((match) => match[1])
}

/**
 * The next free id, as `s1`, `s2`, ...
 *
 * Deliberately short and readable rather than a uuid slice: it sits in the user's own
 * source, where `// @step s2` is self-explanatory and `// @step k3f9` is litter. Stable
 * across reordering the list, because it is an identity and not a position.
 */
export function newStepId(items = [], source = '') {
  const taken = new Set([...(items ?? []).map((item) => item?.id), ...usedIds(source)])
  for (let index = 1; index < 500; index += 1) {
    const id = `s${index}`
    if (!taken.has(id)) return id
  }
  return `s${Date.now().toString(36)}`
}

/**
 * Which line each anchored id sits on, as `{id: line}` with **1-based** lines.
 *
 * One-based because every other line number the user sees is: the gutter, the compile
 * errors, `prepare`'s refusals. Two numbering schemes for one concept in one feature is a
 * bug waiting to be written.
 *
 * Only markers inside comments count. A marker in a string is not an anchor -- it is a
 * function that happens to build the text `@step s1`, and instrumenting the line it is on
 * would be acting on a coincidence.
 *
 * A duplicated id keeps its *first* occurrence, so a copy-pasted line cannot make one
 * checklist item claim two anchors.
 */
export function anchoredLines(source) {
  const text = String(source ?? '')
  const commented = new Set()
  for (const span of spans(text)) {
    if (span.type !== 'line-comment' && span.type !== 'block-comment') continue
    for (let index = span.start; index < span.end; index += 1) commented.add(index)
  }

  const starts = lineStartOffsets(text)
  const found = {}
  for (const match of text.matchAll(MARKER)) {
    if (!commented.has(match.index)) continue
    const id = match[1]
    if (found[id]) continue
    found[id] = lineOf(starts, match.index) + 1
  }
  return found
}

function lineStartOffsets(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function lineOf(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Can line `line` (1-based) carry an anchor at all?
 *
 * Two separate questions, and both have to be yes:
 *
 *   1. Is there somewhere on the line to put the comment? A line whose end falls inside a
 *      template literal cannot take a trailing `//` -- the marker would become part of the
 *      string.
 *   2. Can the line be *instrumented*? An anchor whose line cannot be probed would show a
 *      cross on every run regardless of what happened, which is worse than not offering
 *      it. `probePoint` in ./prepare.js is the authority, and it is the same function the
 *      runner uses, so the button cannot offer an anchor the runner will then refuse.
 */
export function anchorable(source, line) {
  const text = String(source ?? '')
  const lines = text.split('\n')
  if (line < 1 || line > lines.length) return false
  if (!lines[line - 1].trim()) return false

  const starts = lineStartOffsets(text)
  const endOfLine = (starts[line - 1] ?? 0) + lines[line - 1].length

  /* Inside a template literal or a block comment at end of line: nowhere to hang a `//`. */
  for (const span of spans(text)) {
    if (span.type !== 'template' && span.type !== 'block-comment') continue
    if (span.start < endOfLine && endOfLine < span.end) return false
  }

  return probePoint(text, line) !== null
}

/** Append the marker for `id` to line `line` (1-based). */
export function anchor(source, line, id) {
  const lines = String(source ?? '').split('\n')
  if (line < 1 || line > lines.length) return source
  /* Removed first, so re-anchoring an item moves it rather than leaving two markers and a
     first-occurrence rule deciding which one counted. */
  const cleaned = unanchor(lines.join('\n'), id).split('\n')
  const target = cleaned[line - 1]
  /* Appended even when the line already ends in a `//` comment: the marker simply joins it,
     and `anchoredLines` finds it either way. */
  cleaned[line - 1] = `${target.replace(/\s+$/, '')}  ${markerFor(id)}`
  return cleaned.join('\n')
}

/** Strip the marker for `id`, and the whitespace it was hanging on. */
export function unanchor(source, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return String(source ?? '')
    .split('\n')
    .map((line) => {
      const stripped = line
        /* The whole `// @step id` when the marker is the only thing in that comment, so
           removing an anchor does not leave a bare `//` behind. */
        .replace(new RegExp(`\\s*//\\s*@step\\s+${escaped}\\s*$`), '')
        /* Otherwise just the marker, leaving the user's own comment text alone. */
        .replace(new RegExp(`\\s*@step\\s+${escaped}\\b`), '')
      return stripped
    })
    .join('\n')
}

/**
 * The checklist, resolved against the code and (optionally) a run.
 *
 * @param items   `data.checklist`, in the user's order
 * @param source  the code, which is where the anchors are
 * @param hits    1-based lines the run reached, or null when nothing has been run
 * @param tracked 1-based lines the runner could actually probe, or null for "all of them"
 *
 * The four states are deliberately distinct, because collapsing any of them into a cross
 * would be a lie about the function:
 *
 *   `done`       the line ran
 *   `missed`     the line did not run -- the only honest red
 *   `unanchored` no marker for this item, so there is nothing to measure
 *   `untracked`  anchored, but the runner could not place a probe on that line
 *   `pending`    nothing has been run yet
 */
export function checklistState(items, source, hits = null, tracked = null) {
  const lines = anchoredLines(source)
  const hit = hits === null ? null : new Set(hits)
  const canTrack = tracked === null ? null : new Set(tracked)

  return (items ?? [])
    .filter((item) => item?.id)
    .map((item) => {
      const line = lines[item.id] ?? null
      if (!line) return { ...item, line: null, status: 'unanchored' }
      if (canTrack && !canTrack.has(line)) return { ...item, line, status: 'untracked' }
      if (!hit) return { ...item, line, status: 'pending' }
      return { ...item, line, status: hit.has(line) ? 'done' : 'missed' }
    })
}

/** A one-line summary for the walkthrough, e.g. "2 of 3 steps". Null when there is no checklist. */
export function summarizeSteps(state) {
  const measured = (state ?? []).filter((item) => item.status === 'done' || item.status === 'missed')
  if (measured.length === 0) return null
  const done = measured.filter((item) => item.status === 'done').length
  return { done, total: measured.length, missed: measured.filter((i) => i.status === 'missed') }
}

/* Re-exported so callers do not have to know that the authority on "can this line be
   probed" lives in the module that does the instrumenting. */
export { probePoint } from './prepare.js'
