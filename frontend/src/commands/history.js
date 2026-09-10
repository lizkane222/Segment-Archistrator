/*
 * Undo/redo, as a stack of whole document snapshots.
 *
 * Snapshots rather than inverse operations, which is the cheap choice and here also
 * the correct one: the canvas is mutated from six places (drag, drop, connect,
 * delete, the inspector, the collapse control) and an inverse for each is six more
 * things that can be subtly wrong. A `serializeGraph` result is already the exact
 * bytes a save writes, and `replace()` already knows how to put one back on the
 * canvas -- so restoring a snapshot is the same operation as opening a diagram, and
 * inherits its round-trip test.
 *
 * Entries are keyed on `graphFingerprint`, so nothing is pushed for a change that did
 * not change the document. That is what keeps a drag that ends where it started, and
 * every frame of a walkthrough, out of the stack -- playback writes only
 * RUNTIME_NODE_KEYS, which the fingerprint does not read.
 *
 * Bounded, because a snapshot of a 300-node architecture is not small and an
 * unbounded stack in a tab left open all day is a leak with no upper limit.
 */

export const HISTORY_LIMIT = 50

export function emptyHistory() {
  return { entries: [], index: -1 }
}

/**
 * Note a new state of the document.
 *
 * Returns the history unchanged -- by identity, so a caller can skip a state update --
 * when the print matches where we already are.
 */
export function record(history, graph, print) {
  const current = history.entries[history.index]
  if (current && current.print === print) return history

  /* Anything ahead of the cursor is a future that no longer happens: the user undid
     to here and then did something else. Keeping it would offer a redo that jumps to
     a document with no relationship to the one on screen. */
  const kept = history.entries.slice(0, history.index + 1)
  kept.push({ print, graph })

  const overflow = Math.max(0, kept.length - HISTORY_LIMIT)
  const entries = overflow ? kept.slice(overflow) : kept
  return { entries, index: entries.length - 1 }
}

export function canUndo(history) {
  return history.index > 0
}

export function canRedo(history) {
  return history.index < history.entries.length - 1
}

/**
 * One step back. Returns `{history, entry}`, or null when there is nowhere to go.
 *
 * `index > 0`, not `>= 0`: entry 0 is the state the document is in, not a state to
 * return to. Undoing off the bottom of the stack would restore the current document
 * over itself and read as the shortcut being broken.
 */
export function stepBack(history) {
  if (!canUndo(history)) return null
  const index = history.index - 1
  return { history: { ...history, index }, entry: history.entries[index] }
}

export function stepForward(history) {
  if (!canRedo(history)) return null
  const index = history.index + 1
  return { history: { ...history, index }, entry: history.entries[index] }
}
