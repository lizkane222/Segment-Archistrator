/*
 * The console's log: what happened, in order, kept small.
 *
 * Pure, so the ring buffer and the folding of repeats can be tested without a DOM.
 * Nothing here reads the clock or mints an id -- both arrive as arguments, because a
 * function that calls `Date.now()` cannot be asserted against and `crypto` is absent
 * from the test environment this project runs in.
 *
 * Why a log at all when there are already toasts: a toast is gone in six seconds. The
 * refusals it carries -- why a drop was rejected, why an edge is illegal, why a save
 * failed -- are exactly what someone wants to re-read once they have stopped and
 * thought about it. This is the same stream, kept.
 */

/* Enough to cover a working session's worth of refusals without holding a diagram's
   weight in strings. Oldest go first. */
export const MAX_ENTRIES = 400

export const LEVELS = ['error', 'warning', 'success', 'info']

/* Toast tones and log levels are deliberately the same vocabulary, so a notify call
   needs no translation. `warning` is the one level toasts have no equivalent for --
   nothing user-facing raises one; it comes from the browser and from React. */
const LEVEL_RANK = { error: 0, warning: 1, success: 2, info: 3 }

/*
 * The one class of window error this log deliberately drops.
 *
 * "ResizeObserver loop completed with undelivered notifications" is not a fault. It is
 * the browser saying it ran out of frame budget delivering resize callbacks and will
 * deliver the rest next frame -- which is inherent to a canvas whose zones resize
 * themselves while being dragged, and is not catchable from inside the callback that
 * caused it. Chrome raises it as an uncaught error rather than a warning, so it arrives
 * here as red.
 *
 * Dropped rather than downgraded to `info`, because the volume is the problem: 20 of
 * them per drag (the whole `REPEAT_LIMIT` run) is enough to push the refusals someone
 * opened the drawer to read off the end of a 400-entry buffer. The devtools console
 * still shows every one -- nothing is being hidden from anyone who goes looking, and
 * `useConsoleLog` only ever wraps `console.error`, never replaces it.
 *
 * Matched on the message rather than on a source or a stack because there is no stack:
 * the error has no `error` object attached, which is itself part of why it cannot be
 * traced to a component. The older Chrome wording is here too -- the message changed in
 * Chrome 92 and both are still in the wild.
 */
const BROWSER_NOISE = [
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i,
]

/** Whether a window error is a browser notification rather than a fault. */
export function isBrowserNoise(message) {
  const text = String(message ?? '')
  return BROWSER_NOISE.some((pattern) => pattern.test(text))
}

/**
 * Add an entry, folding an immediate repeat into a count.
 *
 * Consecutive rather than global folding: the same refusal three times in a row is
 * one fact and reads better as "x3", but the same message an hour later is a
 * separate event and collapsing the two would misreport when it happened. This is
 * the same judgement `useToasts` makes, applied to a list that keeps its history.
 */
export function appendEntry(entries, entry, { max = MAX_ENTRIES } = {}) {
  const list = entries ?? []
  const last = list[list.length - 1]

  if (last && last.level === entry.level && last.message === entry.message) {
    return [
      ...list.slice(0, -1),
      { ...last, count: (last.count ?? 1) + 1, at: entry.at ?? last.at },
    ]
  }

  const next = [...list, { count: 1, ...entry }]
  /* Trimmed from the front. A log that dropped the newest entry to stay under its cap
     would go quiet exactly when something started going wrong. */
  return next.length > max ? next.slice(next.length - max) : next
}

/** How many of each level, for the drawer's header and the button's badge. */
export function levelCounts(entries) {
  const counts = { error: 0, warning: 0, success: 0, info: 0 }
  for (const entry of entries ?? []) {
    if (counts[entry.level] === undefined) continue
    counts[entry.level] += entry.count ?? 1
  }
  return counts
}

/**
 * The count the button wears.
 *
 * Errors and warnings only. A badge that counted every "Copied 3 components" would
 * sit at forty by lunchtime and stop meaning anything, and the thing it needs to be
 * able to say is "something went wrong while you were not looking".
 */
export function alertCount(entries) {
  const counts = levelCounts(entries)
  return counts.error + counts.warning
}

/** Entries at or above a level, most severe first being irrelevant -- order is kept. */
export function filterEntries(entries, level) {
  if (!level || level === 'all') return entries ?? []
  return (entries ?? []).filter((entry) => entry.level === level)
}

/** Severity order, for a "worst first" reading of a session. */
export function bySeverity(entries) {
  return [...(entries ?? [])].sort(
    (a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9),
  )
}

/**
 * The log as text, for pasting into a ticket.
 *
 * Timestamps as ISO, not localised: the reader of a pasted log is usually not in the
 * timezone that produced it, and an ambiguous "2:04" has cost more than the extra
 * characters do.
 */
export function formatLogText(entries) {
  return (entries ?? [])
    .map((entry) => {
      const stamp = new Date(entry.at).toISOString()
      const repeat = (entry.count ?? 1) > 1 ? ` (x${entry.count})` : ''
      const where = entry.source ? ` [${entry.source}]` : ''
      const detail = entry.detail ? `\n    ${String(entry.detail).replace(/\n/g, '\n    ')}` : ''
      return `${stamp} ${entry.level.toUpperCase()}${where} ${entry.message}${repeat}${detail}`
    })
    .join('\n')
}
