/*
 * The notes lane's contents.
 *
 * The properties worth pinning are the ones that make it a *projection* rather than a log: it grows
 * with the tick, it shrinks again when the tick goes back, and it never shows a note for something
 * the event has not reached yet. A lane that appended as it played would pass the first of those and
 * fail the other two, and the failure only shows up when someone scrubs.
 */

import { describe, expect, it } from 'vitest'

import { notesInView, notesSoFar } from './notes.js'
import { combinedFrameAt, newScenario, runScenarios } from './scenarios.js'
import { STATUS } from './router.js'

const TRACK = {
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1',
  properties: { revenue: 42.5 },
  timestamp: '2026-01-15T10:30:00.000Z',
}

function chain() {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Website' },
      { id: 'fn', kind: 'source_insert_function', name: 'Enrich' },
      { id: 'dest', kind: 'destination', name: 'Braze' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'fn' },
      { id: 'e2', source: 'fn', target: 'dest' },
    ],
  }
}

function fork() {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Website' },
      { id: 'braze', kind: 'destination', name: 'Braze' },
      { id: 'amp', kind: 'destination', name: 'Amplitude' },
    ],
    edges: [
      { id: 'a', source: 'src', target: 'braze' },
      { id: 'b', source: 'src', target: 'amp' },
    ],
  }
}

const path = (overrides) => ({
  ...newScenario({ id: 'p1', name: 'Path 1', event: TRACK }),
  sourceId: 'src',
  ...overrides,
})

/* The lane at a given tick, built the way the app builds it. */
function laneAt(graph, tick, scenarios = [path()]) {
  const runs = runScenarios(graph, scenarios)
  return notesSoFar(combinedFrameAt(runs, tick).runs, graph)
}

const names = (entries) => entries.map((entry) => entry.name)

describe('notesSoFar', () => {
  it('is empty before the run has started', () => {
    expect(laneAt(chain(), -1)).toEqual([])
  })

  it('opens with the component the path starts at', () => {
    expect(names(laneAt(chain(), 0))).toEqual(['Website'])
  })

  it('grows as the run advances', () => {
    const graph = chain()
    const lengths = [0, 1, 2, 3, 4].map((tick) => laneAt(graph, tick).length)
    /* Never shrinks going forward, and does grow -- a lane that stayed at one card would mean the
       playhead's note was replacing its predecessor rather than joining it. */
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
    expect(lengths.at(-1)).toBeGreaterThan(lengths[0])
  })

  /* The property a log could not have. Scrubbing back has to *remove* notes, or the lane claims the
     event reached somewhere it has not. */
  it('shrinks again when the tick goes backwards', () => {
    const graph = chain()
    const late = laneAt(graph, 4).length
    expect(laneAt(graph, 1).length).toBeLessThan(late)
    /* And is identical to having only ever played that far, which is what makes it a projection. */
    expect(laneAt(graph, 1)).toEqual(laneAt(graph, 1))
  })

  it('says nothing about a component the event has not got to yet', () => {
    expect(names(laneAt(chain(), 0))).not.toContain('Braze')
  })

  it('carries both the per-kind heading and what happened to this event', () => {
    const [first] = laneAt(chain(), 0)
    expect(first.anchor?.title).toBeTruthy()
    expect(first.step?.reason).toBeTruthy()
    /* Only the step would leave a card whose heading is a status badge; only the kind would leave
       one that never mentions the event. */
    expect(first.step.status).toBeTruthy()
  })

  it('marks where the playhead is now', () => {
    const lane = laneAt(chain(), 0)
    expect(lane.filter((entry) => entry.current).map((entry) => entry.name)).toEqual(['Website'])
  })

  describe('a fork', () => {
    it('lists both arms', () => {
      const lane = laneAt(fork(), 99)
      expect(names(lane).sort()).toEqual(['Amplitude', 'Braze', 'Website'])
    })

    /* Both, not one. Capping this is exactly what the on-canvas tooltips had to do, and it meant a
       wide fan-out explained nothing at the moment it had most to explain. */
    it('marks both arms as current when they arrive together', () => {
      const lane = laneAt(fork(), 99)
      const current = lane.filter((entry) => entry.current).map((entry) => entry.name)
      expect(current.sort()).toEqual(['Amplitude', 'Braze'])
    })
  })

  describe('a component reached by two routes', () => {
    it('gets one card, not one per route', () => {
      const graph = {
        nodes: [
          { id: 'src', kind: 'source', name: 'Website' },
          { id: 'a', kind: 'source_insert_function', name: 'A' },
          { id: 'b', kind: 'source_insert_function', name: 'B' },
          { id: 'dest', kind: 'destination', name: 'Braze' },
        ],
        edges: [
          { id: 'sa', source: 'src', target: 'a' },
          { id: 'sb', source: 'src', target: 'b' },
          { id: 'ad', source: 'a', target: 'dest' },
          { id: 'bd', source: 'b', target: 'dest' },
        ],
      }
      expect(names(laneAt(graph, 99)).filter((name) => name === 'Braze')).toHaveLength(1)
    })
  })

  describe('with two paths playing', () => {
    const two = [path({ id: 'p1', name: 'Path 1' }), path({ id: 'p2', name: 'Path 2' })]

    it('names and colours each card by its path', () => {
      const lane = laneAt(chain(), 99, two)
      expect(new Set(lane.map((entry) => entry.pathName))).toEqual(new Set(['Path 1', 'Path 2']))
      expect(lane.every((entry) => entry.color)).toBe(true)
    })

    /* Chronological across paths, so what happened at one moment sits together -- rather than one
       path's whole story followed by the other's, which cannot be compared by eye. */
    it('orders by moment rather than by path', () => {
      const lane = laneAt(chain(), 99, two)
      const waves = lane.map((entry) => entry.wave)
      expect(waves).toEqual([...waves].sort((a, b) => a - b))
    })

    it('keeps one card per component per path', () => {
      const lane = laneAt(chain(), 99, two)
      expect(new Set(lane.map((entry) => entry.key)).size).toBe(lane.length)
    })
  })

  it('survives a graph it has no nodes for', () => {
    const runs = runScenarios(chain(), [path()])
    expect(notesSoFar(combinedFrameAt(runs, 99).runs, { nodes: [], edges: [] })).toBeInstanceOf(Array)
    expect(notesSoFar(null, chain())).toEqual([])
  })
})

/*
 * The lane when nothing is playing: the note of every component on screen.
 *
 * Viewport-scoped because the lane is a strip and an architecture is not -- three hundred cards is a
 * scrollbar nobody will drag. The properties worth pinning are which components count as "on screen"
 * (any overlap, not containment, or the cards at the edge you are panning towards vanish) and the
 * left-to-right order, so the lane reads in the same direction as the diagram.
 */
describe('notesInView', () => {
  const card = (id, x, y, extra = {}) => ({
    id,
    type: 'segmentNode',
    position: { x, y },
    measured: { width: 200, height: 60 },
    data: { kind: 'destination', name: id, ...extra },
  })

  const view = { x: 0, y: 0, width: 500, height: 500 }
  const ids = (entries) => entries.map((entry) => entry.nodeId)

  it('lists the components inside the viewport', () => {
    const nodes = [card('near', 10, 10), card('far', 5000, 5000)]
    expect(ids(notesInView(nodes, view))).toEqual(['near'])
  })

  /* Containment would drop the cards at the edge the reader is panning towards, which are the ones
     they are on their way to asking about. */
  it('counts a card that is only half on screen', () => {
    expect(ids(notesInView([card('edge', 450, 10)], view))).toEqual(['edge'])
    expect(ids(notesInView([card('behind', -190, 10)], view))).toEqual(['behind'])
  })

  it('drops a card just past the edge', () => {
    expect(notesInView([card('gone', 501, 10)], view)).toEqual([])
  })

  it('reads left to right, then top to bottom', () => {
    const nodes = [card('right', 300, 0), card('lower-left', 0, 200), card('left', 0, 0)]
    expect(ids(notesInView(nodes, view))).toEqual(['left', 'lower-left', 'right'])
  })

  it('is stable for two components at the same point', () => {
    const nodes = [card('b', 10, 10), card('a', 10, 10)]
    expect(ids(notesInView(nodes, view))).toEqual(['a', 'b'])
  })

  /* A zone is described by what is inside it; a collapsed group stands for components whose notes the
     reader has just asked to see less of. */
  it('skips zones and collapsed groups', () => {
    const nodes = [
      card('real', 10, 10),
      { id: 'z', type: 'zone', position: { x: 0, y: 0 }, data: {} },
      { id: 'stack', type: 'groupStack', position: { x: 20, y: 20 }, data: {} },
    ]
    expect(ids(notesInView(nodes, view))).toEqual(['real'])
  })

  it('carries the per-kind description', () => {
    const [note] = notesInView([card('dest', 10, 10)], view)
    expect(note.anchor?.title).toBeTruthy()
    expect(note.name).toBe('dest')
  })

  /* After a run has played, the verdict is more use than the generic description -- and it is already
     written onto the node by `applyPathsToNodes`. */
  it('prefers what happened to the event, when a run has left a verdict behind', () => {
    const played = card('dest', 10, 10, {
      paths: [
        {
          scenarioId: 'a',
          status: STATUS.delivered,
          step: { nodeId: 'dest', status: STATUS.delivered, reason: 'Delivered.' },
        },
      ],
    })
    expect(notesInView([played], view)[0].step?.reason).toBe('Delivered.')
  })

  it('shows everything when given no viewport', () => {
    const nodes = [card('near', 10, 10), card('far', 5000, 5000)]
    expect(notesInView(nodes, null)).toHaveLength(2)
  })

  it('prefers a live absolute position over the stored one', () => {
    /* A component inside a zone stores a position relative to it, so the absolute one React Flow
       computes is the only one that can be compared against a viewport. */
    const nested = {
      ...card('inside', 10, 10),
      internals: { positionAbsolute: { x: 5000, y: 5000 } },
    }
    expect(notesInView([nested], view)).toEqual([])
  })

  it('survives being asked nothing', () => {
    expect(notesInView(null, view)).toEqual([])
    expect(notesInView([], view)).toEqual([])
  })
})
