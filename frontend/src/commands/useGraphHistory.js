/*
 * The undo stack, wired to the document.
 *
 * Separate from `history.js` so that module -- where all the logic is -- can be tested
 * without importing React. What is left here is the wiring: notice a new print, and
 * hand a stored snapshot back to whoever knows how to put it on the canvas.
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
  const latest = useRef({ graph, print })
  latest.current = { graph, print }

  /* Mirrored into a ref so two undos dispatched in one tick step back twice. Reading
     `history` from the closure would give both the same starting point, and the second
     would restore the state the first had just left. */
  const stack = useRef(history)
  stack.current = history

  useEffect(() => {
    setHistory((current) => record(current, latest.current.graph, latest.current.print))
  }, [print])

  const travel = useCallback(
    (step) => {
      const next = step(stack.current)
      if (!next) return false
      stack.current = next.history
      setHistory(next.history)
      restore(next.entry.graph)
      return true
    },
    [restore],
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
    const seeded = record(emptyHistory(), opened, graphFingerprint(opened))
    stack.current = seeded
    setHistory(seeded)
  }, [])

  return {
    undo,
    redo,
    reset,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    depth: history.entries.length,
  }
}
