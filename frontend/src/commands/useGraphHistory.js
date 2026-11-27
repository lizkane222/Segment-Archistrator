/*
 * The undo stack, wired to the document.
 *
 * Separate from `history.js` so that module -- where all the logic is -- can be tested
 * without importing React. What is left here is the wiring: notice a new print, and
 * hand a stored snapshot back to whoever knows how to put it on the canvas.
 *
 * **A gesture is one entry, not one per frame.** Every frame of a drag, every key of a held arrow and every
 * keystroke of a rename is a new document print, and recording each one made a single undo step back by a
 * frame: Cmd-Z after moving a zone nudged it a few pixels and the rest of the move stayed put -- while the
 * fifty-entry limit filled with frames and pushed the real history off the end. Prints are recorded once
 * they have been still for `SETTLE_MS`, and anything pending is recorded the moment undo or redo is asked
 * for, so nothing done a moment ago is skipped over.
 *
 * Two things about the wiring are worth stating, because both look like omissions.
 *
 * **There is no flag suppressing the record that an undo would otherwise cause.** It
 * needs none. Restoring entry N produces a document whose print *is* entry N's print,
 * and the cursor is now on entry N -- so `record` sees the print it already holds and
 * returns the stack untouched. The suppression is a consequence of keying on the print
 * rather than a mechanism bolted beside it, and if the round trip were ever unfaithful
 * the failure would be a harmless extra entry rather than a corrupted stack.
 *
 * **Restoring does not go through `applyGraph`.** That function is for *opening* a
 * document: it calls `docs.markSaved`, which would make an undone state look saved and
 * hide the unsaved-changes dot, and it clears the walkthrough selection and refits the
 * viewport. Undo is not an open. So the caller passes a narrower `restore` that puts the
 * nodes, scenarios and collapse state back and touches nothing else.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { graphFingerprint } from '../diagram/serialize.js'
import { canRedo, canUndo, emptyHistory, record, stepBack, stepForward } from './history.js'

/* How long the document has to hold still before it counts as one finished change. Long enough to span a
   held key's repeat and the pauses inside a drag; short enough that two separate actions rarely merge. */
export const SETTLE_MS = 350

/**
 * @param graph    the serialized document, as `serializeGraph` returns it
 * @param print    `graphFingerprint(graph)`; the identity the stack is keyed on
 * @param restore  puts a stored snapshot back on the canvas
 */
export function useGraphHistory({ graph, print, restore }) {
  const [history, setHistory] = useState(emptyHistory)

  /* The graph is read through a ref, and the effect depends on the print alone.
     `graph` is a fresh object on every render -- and gets one on every frame of a
     walkthrough, since serializing reads node data that playback rewrites -- so
     depending on it would run this effect continuously. The print is a string, so
     React's own equality check does the filtering. */
  /* While held, edits are not recorded -- see `pause`. `resumed` re-runs the recording effect when the
     hold lifts, because the print may not have changed since and the effect keys on it alone. */
  const paused = useRef(false)
  const [resumed, setResumed] = useState(0)
  const latest = useRef({ graph, print })
  latest.current = { graph, print }

  /* Mirrored into a ref so two undos dispatched in one tick step back twice. Reading
     `history` from the closure would give both the same starting point, and the second
     would restore the state the first had just left. */
  const stack = useRef(history)
  stack.current = history

  const timer = useRef(null)
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (paused.current) return undefined
    /* The first print is the document as opened: recorded at once, so there is always somewhere to go back to. */
    if (stack.current.entries.length === 0) {
      setHistory((current) => record(current, latest.current.graph, latest.current.print))
      return undefined
    }
    clearTimeout(timer.current)
    setSettling(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setHistory((current) => record(current, latest.current.graph, latest.current.print))
      setSettling(false)
    }, SETTLE_MS)
    return () => clearTimeout(timer.current)
  }, [print, resumed])

  /* Record what is still waiting, now. Called before any step, so an undo pressed a moment after a change
     goes back *over* that change instead of past it. */
  const flush = useCallback(() => {
    if (timer.current == null) return
    clearTimeout(timer.current)
    timer.current = null
    const next = record(stack.current, latest.current.graph, latest.current.print)
    stack.current = next
    setHistory(next)
    setSettling(false)
  }, [])

  /* Hold the stack while a change is being previewed, so trying five options records one undo step
     (the one that was confirmed) and cancelling records none. */
  const pause = useCallback(() => {
    paused.current = true
  }, [])
  const resume = useCallback(() => {
    paused.current = false
    setResumed((count) => count + 1)
  }, [])

  const travel = useCallback(
    (step) => {
      flush()
      const next = step(stack.current)
      if (!next) return false
      stack.current = next.history
      setHistory(next.history)
      restore(next.entry.graph)
      return true
    },
    [restore, flush],
  )

  const undo = useCallback(() => travel(stepBack), [travel])
  const redo = useCallback(() => travel(stepForward), [travel])

  /*
   * Start again from a given document.
   *
   * Opening a diagram or a template is not an edit, so undo must not walk backwards out
   * of the document the user is now looking at and into the previous one -- the canvas
   * would fill with a different customer's architecture and there would be nothing on
   * screen to explain it.
   *
   * Seeded with the opened document rather than left empty, so the first edit after an
   * open has something to return to.
   */
  const reset = useCallback((opened) => {
    clearTimeout(timer.current)
    timer.current = null
    setSettling(false)
    const seeded = record(emptyHistory(), opened, graphFingerprint(opened))
    stack.current = seeded
    setHistory(seeded)
  }, [])

  return {
    pause,
    resume,
    undo,
    redo,
    reset,
    /* Also true while a change is waiting to be recorded: it is undoable the moment it is made. */
    canUndo: canUndo(history) || (settling && history.entries.length > 0),
    canRedo: canRedo(history),
    depth: history.entries.length,
  }
}
