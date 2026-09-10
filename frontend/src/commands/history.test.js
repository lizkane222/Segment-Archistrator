import { describe, expect, it } from 'vitest'

import { graphFingerprint, serializeGraph } from '../diagram/serialize.js'
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  emptyHistory,
  record,
  stepBack,
  stepForward,
} from './history.js'

/* A snapshot only ever reaches this module as an opaque value keyed by its print, so
   the graphs here are stand-ins except where a test is specifically about the print. */
const graphAt = (n) => ({ nodes: [{ id: 'a', position: { x: n, y: 0 } }], edges: [] })

/** The history after a sequence of prints, each with a matching graph. */
function history(...prints) {
  return prints.reduce((acc, print) => record(acc, graphAt(print), String(print)), emptyHistory())
}

describe('record', () => {
  it('starts with the opening state, which is not somewhere to undo to', () => {
    const h = record(emptyHistory(), graphAt(0), 'a')
    expect(h.entries).toHaveLength(1)
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it('ignores a change that did not change the document', () => {
    /* Returned by identity, not merely equal: the hook passes this straight to
       setState, and a fresh object every render would re-render the whole workbench
       on every mouse move over the canvas. */
    const h = history('a')
    expect(record(h, graphAt(1), 'a')).toBe(h)
  })

  it('does not collapse a return to an earlier state', () => {
    /* Move a node and move it back: the print matches entry 0, but that is two edits
       and undo has to walk back through both. Only the *current* entry is compared,
       so this is a stack and not a set. */
    const h = history('a', 'b', 'a')
    expect(h.entries.map((entry) => entry.print)).toEqual(['a', 'b', 'a'])
  })

  it('drops the redo tail when the user does something else after undoing', () => {
    const undone = stepBack(history('a', 'b', 'c')).history
    expect(canRedo(undone)).toBe(true)

    const h = record(undone, graphAt(9), 'd')
    expect(h.entries.map((entry) => entry.print)).toEqual(['a', 'b', 'd'])
    expect(canRedo(h)).toBe(false)
  })

  it('forgets the oldest states rather than growing without bound', () => {
    const prints = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => `p${i}`)
    const h = history(...prints)

    expect(h.entries).toHaveLength(HISTORY_LIMIT)
    expect(h.index).toBe(HISTORY_LIMIT - 1)
    expect(h.entries[0].print).toBe('p10')
    /* The point of trimming from the front: the newest state is still the cursor, so
       an overflowing stack costs the user the far past and never the present. */
    expect(h.entries[h.entries.length - 1].print).toBe(`p${HISTORY_LIMIT + 9}`)
  })

  it('keeps the graph it was handed', () => {
    const graph = graphAt(3)
    const h = record(emptyHistory(), graph, 'a')
    expect(h.entries[0].graph).toBe(graph)
  })
})

describe('stepBack / stepForward', () => {
  it('walks back and forward over the same states', () => {
    const h = history('a', 'b', 'c')

    const back = stepBack(h)
    expect(back.entry.print).toBe('b')
    const twice = stepBack(back.history)
    expect(twice.entry.print).toBe('a')

    const forward = stepForward(twice.history)
    expect(forward.entry.print).toBe('b')
  })

  it('refuses rather than restoring the current document over itself', () => {
    const h = history('a')
    expect(stepBack(h)).toBe(null)
    expect(stepForward(h)).toBe(null)
    expect(canUndo(h)).toBe(false)
  })

  it('does not mutate the history it is given', () => {
    const h = history('a', 'b')
    stepBack(h)
    expect(h.index).toBe(1)
  })
})

describe('playing a walkthrough', () => {
  /*
   * The requirement this pins: cmd-z must undo the last *edit*, never the last frame
   * of a simulation. It holds because the simulator writes only `anchor`, `anchorStep`
   * and `paths`, all of which are in RUNTIME_NODE_KEYS and so absent from the print --
   * which means `record` sees no change and returns the stack untouched.
   *
   * By construction, but worth a test, because the thing that would break it is
   * innocuous: any future field the simulator writes that is not in that set turns
   * every animation frame into a history entry, and the fifty-deep stack is then
   * nothing but one playthrough.
   */
  const node = (extra) => ({
    id: 'source:1',
    type: 'segmentNode',
    parentId: 'zone-connections',
    position: { x: 10, y: 20 },
    data: { id: 'source:1', kind: 'source', name: 'Website', ...extra },
  })

  const still = serializeGraph({ nodes: [node()], edges: [] })
  const playing = serializeGraph({
    nodes: [
      node({
        anchor: { x: 4, y: 4 },
        anchorStep: 3,
        paths: ['path:abc'],
      }),
    ],
    edges: [],
  })

  it('changes nothing the fingerprint reads', () => {
    expect(graphFingerprint(playing)).toBe(graphFingerprint(still))
  })

  it('pushes no history entry', () => {
    const h = record(emptyHistory(), still, graphFingerprint(still))
    expect(record(h, playing, graphFingerprint(playing))).toBe(h)
  })

  it('is not simply comparing two empty graphs', () => {
    /* Guards the two assertions above against being vacuous: if serializeGraph ever
       returned nothing useful here they would pass for the wrong reason. An edit the
       fingerprint *does* read still lands. */
    expect(still.nodes).toHaveLength(1)
    const renamed = serializeGraph({ nodes: [node({ name: 'Mobile' })], edges: [] })
    const h = record(emptyHistory(), still, graphFingerprint(still))
    expect(record(h, renamed, graphFingerprint(renamed))).not.toBe(h)
  })
})
