/*
 * Scenarios: several runs over one diagram.
 *
 * The invariant this file exists to hold is that a *list* survives all the way from
 * two `simulate` calls to one edge on the canvas. Every collapse -- keeping the last
 * scenario per edge, merging by status, deduping by id -- looks like a tidier data
 * structure and silently deletes the comparison the feature is for. So the
 * shared-edge assertions check the length and both colours, not just that something
 * is there.
 *
 * Graphs are in the document shape, matching router.test.js: that is what comes back
 * from Postgres, and it is what AppShell feeds these functions (it simulates over the
 * serialized graph, not the live canvas nodes).
 */

import { describe, expect, it } from 'vitest'

import { STATUS } from './router.js'
import {
  PATH_COLORS,
  PLAY_MODES,
  applyPathsToEdges,
  applyPathsToNodes,
  combinedFrameAt,
  newScenario,
  nextColor,
  playbackLength,
  runScenarios,
  runnable,
  runStatus,
} from './scenarios.js'

const TRACK = {
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1',
  properties: { revenue: 42.5 },
  timestamp: '2026-01-15T10:30:00.000Z',
}

/*
 * source -> insert fn -> destination.
 *
 * The insert function is the thing the two headline scenarios differ by, and its
 * `behaviour: 'drop'` default is deliberately NOT set here -- `functionBehaviour`
 * decides that per run, which is the point.
 */
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

const scenario = (overrides) => ({
  ...newScenario({ id: 'x', name: 'x', event: TRACK }),
  ...overrides,
})

describe('colours', () => {
  it('hands out an unused colour until the palette runs out', () => {
    expect(nextColor([])).toBe(PATH_COLORS[0])
    expect(nextColor([{ color: PATH_COLORS[0] }])).toBe(PATH_COLORS[1])
  })

  it('wraps rather than returning undefined once every colour is taken', () => {
    const all = PATH_COLORS.map((color) => ({ color }))
    expect(PATH_COLORS).toContain(nextColor(all))
  })

  /* Nothing in the UI may depend on colour alone, so a path always has a name. */
  it('never creates a nameless path', () => {
    expect(newScenario({ id: 'a', name: '   ', event: TRACK }).name).toBeTruthy()
  })
})

describe('runnable', () => {
  it('drops a path whose source is no longer on the diagram', () => {
    const kept = scenario({ id: 'keep', sourceId: 'src' })
    const gone = scenario({ id: 'gone', sourceId: 'deleted' })
    expect(runnable(chain(), [kept, gone]).map((s) => s.id)).toEqual(['keep'])
  })

  it('drops a path with no event, and allows one with no explicit source', () => {
    const noEvent = scenario({ id: 'no-event', event: null })
    const noSource = scenario({ id: 'default-source', sourceId: null })
    expect(runnable(chain(), [noEvent, noSource]).map((s) => s.id)).toEqual(['default-source'])
  })
})

/*
 * The headline case from the plan: two scenarios over one diagram, differing only by
 * `disabled`.
 */
describe('the source-only versus source-plus-insert-function pair', () => {
  const pair = [
    scenario({ id: 'with', name: 'With the function', color: '#111111' }),
    scenario({
      id: 'without',
      name: 'Function off',
      color: '#222222',
      disabled: ['fn'],
    }),
  ]

  it('delivers in one run and blocks at the function in the other', () => {
    const [withFn, withoutFn] = runScenarios(chain(), pair)

    expect(withFn.trace.visited.fn.status).toBe(STATUS.transformed)
    expect(withFn.trace.visited.dest.status).toBe(STATUS.delivered)

    /* The destination is recorded, blocked, carrying the whole chain of why -- the
       reducer does not simply stop, because "Braze got nothing, and here is what
       stood in the way" is the answer someone runs this to get. */
    expect(withoutFn.trace.visited.fn.status).toBe(STATUS.blocked)
    expect(withoutFn.trace.visited.dest.status).toBe(STATUS.blocked)
    expect(withoutFn.trace.visited.dest.reason).toMatch(/never reaches “Braze”/)
    expect(withoutFn.trace.visited.dest.reason).toMatch(/switched “Enrich” off/)
  })

  it('says the user switched it off, not that the workspace did', () => {
    const [, withoutFn] = runScenarios(chain(), pair)
    expect(withoutFn.trace.visited.fn.reason).toMatch(/You switched/)
    expect(withoutFn.trace.visited.fn.reason).not.toMatch(/workspace/)
  })

  /* `disabled` is a question about one run. If it leaked into the graph the second
     scenario would inherit the first one's assumption -- and the pair above would
     agree, which is the one thing it must never do. */
  it('does not mutate the graph', () => {
    const graph = chain()
    const before = JSON.stringify(graph)
    runScenarios(graph, pair)
    expect(JSON.stringify(graph)).toBe(before)
  })

  it('reports the withheld destination in the run status, from the first tick', () => {
    const runs = runScenarios(chain(), pair)
    const early = combinedFrameAt(runs, 0, { mode: PLAY_MODES.together })
    const late = combinedFrameAt(runs, 99, { mode: PLAY_MODES.together })

    /* Counted over the whole trace, so the number does not appear to grow as the
       animation plays -- "1 withheld" is a fact about the run. */
    expect(runStatus(early.runs[1]).withheld).toBe(runStatus(late.runs[1]).withheld)
    expect(runStatus(late.runs[1]).withheld).toBeGreaterThan(0)
    expect(runStatus(late.runs[0]).delivered).toBe(1)
  })
})

describe('a shared edge carries every scenario that crossed it', () => {
  /* Both paths start at the same source and cross e1, differing only in event. */
  const shared = [
    scenario({ id: 'a', name: 'Orders', color: '#aa0000', event: TRACK }),
    scenario({
      id: 'b',
      name: 'Signups',
      color: '#00aa00',
      event: { ...TRACK, event: 'Signed Up' },
    }),
  ]

  it('lists both, in both colours', () => {
    const runs = runScenarios(chain(), shared)
    const frame = combinedFrameAt(runs, 99, { mode: PLAY_MODES.together })

    expect(frame.edges.e1).toHaveLength(2)
    expect(frame.edges.e1.map((entry) => entry.scenarioId).sort()).toEqual(['a', 'b'])
    expect(frame.edges.e1.map((entry) => entry.color).sort()).toEqual(['#00aa00', '#aa0000'])
  })

  it('lists both on a shared node too, with their names', () => {
    const runs = runScenarios(chain(), shared)
    const frame = combinedFrameAt(runs, 99, { mode: PLAY_MODES.together })

    expect(frame.nodes.dest).toHaveLength(2)
    expect(frame.nodes.dest.map((entry) => entry.name).sort()).toEqual(['Orders', 'Signups'])
    expect(frame.nodes.dest.every((entry) => entry.arrived)).toBe(true)
  })

  /* A node a run never reached is *in* the list, marked `arrived: false`. Omitting
     it would leave the canvas unable to say "this path stopped short of here",
     which is the finding a scenario is usually run to produce. */
  it('keeps a node the run did not reach, flagged as not arrived', () => {
    const runs = runScenarios(chain(), [
      shared[0],
      scenario({ id: 'off', name: 'Function off', color: '#0000aa', disabled: ['fn'] }),
    ])
    const frame = combinedFrameAt(runs, 99, { mode: PLAY_MODES.together })

    const atFunction = frame.nodes.fn.find((entry) => entry.scenarioId === 'off')
    expect(atFunction.arrived).toBe(false)

    /* Both paths are listed at the destination and exactly one of them arrived.
       This is the pair `SegmentNode` renders as a ring versus a dimmed node, so
       collapsing the list here would light up a destination that received nothing. */
    const atDest = Object.fromEntries(
      frame.nodes.dest.map((entry) => [entry.scenarioId, entry.arrived]),
    )
    expect(atDest).toEqual({ a: true, off: false })
  })
})

describe('playback length and tick mapping', () => {
  const uneven = () => {
    const graph = chain()
    return runScenarios(graph, [
      scenario({ id: 'long', event: TRACK }),
      scenario({ id: 'short', event: TRACK, disabled: ['fn'] }),
    ])
  }

  it('together takes as long as the longest run; sequence takes the sum', () => {
    const runs = uneven()
    const lengths = runs.map((run) => run.trace.steps.length)
    expect(playbackLength(runs, PLAY_MODES.together)).toBe(Math.max(...lengths))
    expect(playbackLength(runs, PLAY_MODES.sequence)).toBe(lengths[0] + lengths[1])
  })

  it('together advances every run on the same tick', () => {
    const runs = uneven()
    const frame = combinedFrameAt(runs, 1, { mode: PLAY_MODES.together })
    expect(frame.runs.map((run) => run.index)).toEqual([1, 1])
  })

  it('sequence advances one run at a time', () => {
    const runs = uneven()
    const first = runs[0].trace.steps.length

    const early = combinedFrameAt(runs, 0, { mode: PLAY_MODES.sequence })
    expect(early.runs[0].index).toBe(0)
    expect(early.runs[1].index).toBe(-1)

    const later = combinedFrameAt(runs, first, { mode: PLAY_MODES.sequence })
    expect(later.runs[0].index).toBe(first - 1)
    expect(later.runs[1].index).toBe(0)
  })

  /* The two modes differ in *timing* only. A path that vanished when the next one
     started could not be compared with it, which is the reason to play several. */
  it('leaves an already-played run fully lit in sequence mode', () => {
    const runs = uneven()
    const total = playbackLength(runs, PLAY_MODES.sequence)
    const end = combinedFrameAt(runs, total - 1, { mode: PLAY_MODES.sequence })
    const together = combinedFrameAt(runs, 99, { mode: PLAY_MODES.together })
    expect(Object.keys(end.nodes).sort()).toEqual(Object.keys(together.nodes).sort())
  })

  it('clamps out-of-range ticks at both ends', () => {
    const runs = uneven()
    const total = playbackLength(runs, PLAY_MODES.together)
    expect(combinedFrameAt(runs, -50, { mode: PLAY_MODES.together }).tick).toBe(-1)
    expect(combinedFrameAt(runs, 500, { mode: PLAY_MODES.together }).tick).toBe(total - 1)
    expect(combinedFrameAt(runs, 500, { mode: PLAY_MODES.together }).done).toBe(true)
  })

  it('is empty and harmless with no runs at all', () => {
    const frame = combinedFrameAt([], 3, { mode: PLAY_MODES.together })
    expect(frame).toMatchObject({ total: 0, runs: [], nodes: {}, edges: {}, current: [] })
  })
})

/* The property `frameAt` already holds, lifted to many runs: the frame is a function
   of the tick and nothing else, so scrubbing backwards cannot land somewhere a
   forwards playthrough would not have. */
describe('combinedFrameAt is a pure projection of the tick', () => {
  it('gives the same frame whether the tick was reached forwards or at once', () => {
    const runs = runScenarios(chain(), [
      scenario({ id: 'a', event: TRACK }),
      scenario({ id: 'b', event: TRACK, disabled: ['fn'] }),
    ])
    const direct = combinedFrameAt(runs, 2, { mode: PLAY_MODES.together })

    let walked = null
    for (let tick = -1; tick <= 2; tick += 1) {
      walked = combinedFrameAt(runs, tick, { mode: PLAY_MODES.together })
    }
    expect(walked).toEqual(direct)

    /* And backwards from the end lands in the same place. */
    for (let tick = 9; tick >= 2; tick -= 1) {
      walked = combinedFrameAt(runs, tick, { mode: PLAY_MODES.together })
    }
    expect(walked).toEqual(direct)
  })

  it('defaults to the end when the tick is undefined', () => {
    const runs = runScenarios(chain(), [scenario({ id: 'a', event: TRACK })])
    expect(combinedFrameAt(runs, undefined, {}).done).toBe(true)
  })
})

/*
 * Identity preservation. Not a micro-optimisation: React Flow re-renders any node
 * whose object identity changed and `SegmentNode` is memoised on exactly that, so a
 * rebuild-everything version drops the animation on a large diagram.
 */
describe('applying a frame to the canvas', () => {
  const canvasNodes = () => [
    { id: 'zone-connections', type: 'zone', data: { id: 'connections' } },
    { id: 'src', type: 'segmentNode', data: { kind: 'source', name: 'Website' } },
    { id: 'fn', type: 'segmentNode', data: { kind: 'source_insert_function', name: 'Enrich' } },
    { id: 'dest', type: 'segmentNode', data: { kind: 'destination', name: 'Braze' } },
  ]
  const canvasEdges = () => [
    { id: 'e1', source: 'src', target: 'fn', data: {} },
    { id: 'e2', source: 'fn', target: 'dest', data: {} },
  ]

  const frameOf = (tick) =>
    combinedFrameAt(runScenarios(chain(), [scenario({ id: 'a', event: TRACK })]), tick, {})

  it('returns the very same array when nothing changed', () => {
    const nodes = canvasNodes()
    const edges = canvasEdges()
    const frame = frameOf(2)

    const nextNodes = applyPathsToNodes(nodes, frame)
    const nextEdges = applyPathsToEdges(edges, frame)
    expect(applyPathsToNodes(nextNodes, frame)).toBe(nextNodes)
    expect(applyPathsToEdges(nextEdges, frame)).toBe(nextEdges)
  })

  it('reuses the identity of a node whose own playback state did not change', () => {
    const before = applyPathsToNodes(canvasNodes(), frameOf(1))
    const after = applyPathsToNodes(before, frameOf(2))

    const at = (nodes, id) => nodes.find((node) => node.id === id)
    /* The source is behind the playhead in both frames, so it must be untouched;
       the node the playhead moved onto must not be. */
    expect(at(after, 'src')).toBe(at(before, 'src'))
    expect(at(after, 'dest')).not.toBe(at(before, 'dest'))
    /* Zone backdrops are regions, never path carriers. */
    expect(at(after, 'zone-connections')).toBe(at(before, 'zone-connections'))
  })

  it('opens the anchor on the node the playhead is on, and only that one', () => {
    const nodes = applyPathsToNodes(canvasNodes(), frameOf(1))
    const stepped = nodes.filter((node) => node.data.anchor === 'step')
    expect(stepped).toHaveLength(1)
    expect(stepped[0].data.anchorStep.nodeId).toBe(stepped[0].id)
  })

  it('clears everything when handed no frame', () => {
    const played = applyPathsToNodes(canvasNodes(), frameOf(2))
    const playedEdges = applyPathsToEdges(canvasEdges(), frameOf(2))

    const cleared = applyPathsToNodes(played, null)
    const clearedEdges = applyPathsToEdges(playedEdges, null)

    expect(cleared.every((node) => node.data.paths === undefined)).toBe(true)
    expect(cleared.every((node) => node.data.anchor === undefined)).toBe(true)
    expect(clearedEdges.every((edge) => edge.data.paths === undefined)).toBe(true)
    /* Idempotent, so an already-clear canvas is not rebuilt on every render. */
    expect(applyPathsToNodes(cleared, null)).toBe(cleared)
  })

  it('carries every scenario onto a shared edge, not just the last one', () => {
    const runs = runScenarios(chain(), [
      scenario({ id: 'a', color: '#aa0000', event: TRACK }),
      scenario({ id: 'b', color: '#00aa00', event: { ...TRACK, event: 'Signed Up' } }),
    ])
    const edges = applyPathsToEdges(canvasEdges(), combinedFrameAt(runs, 99, {}))
    const e1 = edges.find((edge) => edge.id === 'e1')

    expect(e1.data.paths).toHaveLength(2)
    expect(e1.data.paths.map((entry) => entry.color).sort()).toEqual(['#00aa00', '#aa0000'])
  })
})

describe('what a stopped walkthrough leaves on the canvas', () => {
  /*
   * The reported bug: three components greyed out with a note stuck to one of them
   * and nothing on screen to explain why. The cause was that the transport stops at
   * the last tick rather than returning to -1, so the final frame's annotations --
   * including the auto-opening tooltip -- stayed on the diagram indefinitely.
   */
  const nodes = () => [
    { id: 'a', type: 'segmentNode', data: { kind: 'source', name: 'A' } },
    { id: 'b', type: 'segmentNode', data: { kind: 'destination', name: 'B' } },
  ]
  const frame = {
    current: [{ step: { nodeId: 'a', index: 0, status: 'origin' } }],
    nodes: { a: [{ id: 's1', color: '#000', arrived: true }] },
    edges: {},
  }

  it('opens the playhead tooltip while the transport is running', () => {
    const next = applyPathsToNodes(nodes(), frame, { playing: true })
    expect(next.find((node) => node.id === 'a').data.anchor).toBe('step')
    expect(next.find((node) => node.id === 'a').data.anchorStep).toBeTruthy()
  })

  it('closes it the moment the transport stops, and keeps the result', () => {
    /* The rings and the dimming are the result -- the reason to have watched -- so
       they stay. The tooltip is the claim "the event is here, now", which stops being
       true when the transport does. */
    const next = applyPathsToNodes(nodes(), frame, { playing: false })
    const a = next.find((node) => node.id === 'a')
    expect(a.data.anchor).toBeUndefined()
    expect(a.data.anchorStep).toBeUndefined()
    expect(a.data.paths).toHaveLength(1)
  })

  it('defaults to playing, so an existing caller is unchanged', () => {
    expect(applyPathsToNodes(nodes(), frame).find((n) => n.id === 'a').data.anchor).toBe('step')
  })

  it('clears everything when handed no frame at all', () => {
    const annotated = applyPathsToNodes(nodes(), frame, { playing: true })
    const cleared = applyPathsToNodes(annotated, null)
    for (const node of cleared) {
      expect(node.data.paths).toBeUndefined()
      expect(node.data.anchor).toBeUndefined()
    }
  })

  it('leaves zones alone either way', () => {
    const withZone = [...nodes(), { id: 'zone-segment', type: 'zone', data: { id: 'segment' } }]
    const next = applyPathsToNodes(withZone, frame, { playing: false })
    expect(next.find((node) => node.type === 'zone').data).toEqual({ id: 'segment' })
  })
})
