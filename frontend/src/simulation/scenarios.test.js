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
  tickDurations,
  NODE_BEAT_MS,
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

/*
 * source -> insert fn -> two destinations.
 *
 * A fork, which `chain` above is not -- and on a linear graph the step count and the wave count are
 * the same number, so every assertion about one passes for the other by coincidence. This is the
 * fixture that can tell them apart: four steps over three waves, with both destinations reached on
 * the last one, and five beats once travelling is counted separately from arriving.
 */
function fork() {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Website' },
      { id: 'fn', kind: 'source_insert_function', name: 'Enrich' },
      { id: 'braze', kind: 'destination', name: 'Braze' },
      { id: 'amp', kind: 'destination', name: 'Amplitude' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'fn' },
      { id: 'e2', source: 'fn', target: 'braze' },
      { id: 'e3', source: 'fn', target: 'amp' },
    ],
  }
}

const scenario = (overrides) => ({
  ...newScenario({ id: 'x', name: 'x', event: TRACK }),
  ...overrides,
})

/* Which tick is the travelling (or arriving) beat of a given wave. Named rather than counted,
   because a literal beat number encodes the phase layout into every assertion that uses it. */
const beatIndex = (trace, kind, wave) =>
  trace.phases.findIndex((beat) => beat.kind === kind && beat.wave === wave)

/* Which tick the event arrives at a named component on. */
const arrivalBeat = (trace, nodeId) =>
  beatIndex(trace, 'node', trace.steps.find((step) => step.nodeId === nodeId).wave)

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

/*
 * The assumption fields, and the one property they all share: a scenario that has never been edited
 * has to describe a run that behaves exactly as the tool did before the field existed.
 *
 * Worth its own block because every one of them is read with a `?? default` in `runScenarios`, and
 * those guards are load-bearing rather than defensive -- nothing normalises a scenario on the way in
 * from Postgres, so a path saved before a field existed reaches `simulate` without it.
 */
describe('the assumptions a path carries', () => {
  it('starts every one of them empty, so a new path is a complete description of its own run', () => {
    const fresh = newScenario({ id: 'a', name: 'New', event: TRACK })
    expect(fresh.disabled).toEqual([])
    expect(fresh.excluded).toEqual([])
    expect(fresh.revisit).toEqual([])
    expect(fresh.branches).toEqual({})
  })

  it('runs a path saved before revisits existed as one that names nothing', () => {
    /* The inertness guarantee at this layer. A stored scenario has no `revisit` key at all, and the
       walk it produces must be the one it has always produced -- so this asserts the absent case and
       the empty case are the same run rather than trusting they are. */
    const before = scenario({ sourceId: 'src' })
    delete before.revisit
    const after = scenario({ sourceId: 'src', revisit: [] })

    const [older] = runScenarios(chain(), [before])
    const [newer] = runScenarios(chain(), [after])
    expect(older.trace.steps.map((step) => [step.nodeId, step.status, step.wave])).toEqual(
      newer.trace.steps.map((step) => [step.nodeId, step.status, step.wave]),
    )
  })
})

describe('runnable', () => {
  it('drops a path whose source is no longer on the diagram', () => {
    const kept = scenario({ id: 'keep', sourceId: 'src' })
    const gone = scenario({ id: 'gone', sourceId: 'deleted' })
    expect(runnable(chain(), [kept, gone]).map((s) => s.id)).toEqual(['keep'])
  })

  it('drops a path with no event', () => {
    const noEvent = scenario({ id: 'no-event', event: null, sourceId: 'src' })
    const ok = scenario({ id: 'ok', sourceId: 'src' })
    expect(runnable(chain(), [noEvent, ok]).map((s) => s.id)).toEqual(['ok'])
  })

  it('drops a path whose start was never chosen', () => {
    /* This used to fall back to the first source on the diagram, which made the path appear to
       work while answering a question nobody asked -- and hid the case where the chosen start
       feeds nothing because the connectors point the wrong way. */
    const noSource = scenario({ id: 'no-start', sourceId: null })
    expect(runnable(chain(), [noSource])).toEqual([])
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
    /* Beats, which is what a tick is. This read `steps.length` and passed only because the fixture
       is linear -- on a fork the numbers differ, and travelling is a separate beat from arriving. */
    const lengths = runs.map((run) => run.trace.phases.length)
    expect(playbackLength(runs, PLAY_MODES.together)).toBe(Math.max(...lengths))
    expect(playbackLength(runs, PLAY_MODES.sequence)).toBe(lengths[0] + lengths[1])
  })

  it('counts a fork as one wave, and each wave as travel-then-arrive', () => {
    /* Four components reached over three waves, and five beats: the origin arrives from nowhere so
       it has no travelling beat, and the two later waves each get one. */
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    expect(runs[0].trace.steps).toHaveLength(4)
    expect(runs[0].trace.waves).toHaveLength(3)
    expect(playbackLength(runs, PLAY_MODES.together)).toBe(5)
  })

  it('lights both arms of a fork on the same beat', () => {
    /* The behaviour the whole change is for: the event does not visit one destination before the
       other, so neither may be lit a beat ahead of its sibling. */
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const travelling = beatIndex(runs[0].trace, 'edge', 2)
    const frame = combinedFrameAt(runs, travelling, { mode: PLAY_MODES.together })
    expect(frame.edges.e2[0].status).toBe('active')
    expect(frame.edges.e3[0].status).toBe('active')
  })

  it('reports every component in flight, not just one', () => {
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const arriving = beatIndex(runs[0].trace, 'node', 2)
    const frame = combinedFrameAt(runs, arriving, { mode: PLAY_MODES.together })
    expect(frame.current.map((entry) => entry.step.nodeId).sort()).toEqual(['amp', 'braze'])
    expect(frame.nodes.braze[0].current).toBe(true)
    expect(frame.nodes.amp[0].current).toBe(true)
  })

  /*
   * Timing.
   *
   * The event has to cross every connector at the same *speed*, so a beat spent travelling lasts as
   * long as the distance being covered. Timing all of them alike is what made it appear to accelerate
   * across the long connectors on a wide diagram and crawl across the short ones.
   */
  it('times an arriving beat at a fixed length and a travelling beat by distance', () => {
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const trace = runs[0].trace
    const hopMs = new Map([
      ['e1', 400],
      ['e2', 1800],
      ['e3', 700],
    ])
    const beats = tickDurations(runs, PLAY_MODES.together, { hopMs })

    expect(beats[beatIndex(trace, 'node', 0)]).toBe(NODE_BEAT_MS)
    expect(beats[beatIndex(trace, 'edge', 1)]).toBe(400)
  })

  it('holds a fork open until the slowest of its connectors is crossed', () => {
    /* Cutting to the next beat when the shortest arrives would leave the other dot still in flight
       and the component it is heading for already lit. */
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const hopMs = new Map([
      ['e1', 400],
      ['e2', 1800],
      ['e3', 700],
    ])
    const beats = tickDurations(runs, PLAY_MODES.together, { hopMs })
    expect(beats[beatIndex(runs[0].trace, 'edge', 2)]).toBe(1800)
  })

  it('falls back to a node beat for a connector it has no measurement for', () => {
    /* A node reports no size for the frame after it mounts, so an unmeasured hop has to be merely
       average rather than instant. */
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const beats = tickDurations(runs, PLAY_MODES.together, { hopMs: new Map() })
    expect(beats.every((ms) => ms === NODE_BEAT_MS)).toBe(true)
  })

  it('gives one duration per tick, in both modes', () => {
    const runs = uneven()
    expect(tickDurations(runs, PLAY_MODES.together, {})).toHaveLength(
      playbackLength(runs, PLAY_MODES.together),
    )
    expect(tickDurations(runs, PLAY_MODES.sequence, {})).toHaveLength(
      playbackLength(runs, PLAY_MODES.sequence),
    )
  })

  it('is empty with no runs', () => {
    expect(tickDurations([], PLAY_MODES.together, {})).toEqual([])
  })

  it('has nothing at a component while the event is between two', () => {
    /* What lets the canvas glow in exactly one place: on a travelling beat the connectors are lit
       and no component is, so the halo belongs to the line rather than to both ends of it. */
    const runs = runScenarios(fork(), [scenario({ id: 'f', event: TRACK, sourceId: 'src' })])
    const travelling = beatIndex(runs[0].trace, 'edge', 2)
    const frame = combinedFrameAt(runs, travelling, { mode: PLAY_MODES.together })
    expect(frame.current).toEqual([])
    expect(frame.nodes.braze).toBeUndefined()
  })

  it('together advances every run on the same tick', () => {
    const runs = uneven()
    const frame = combinedFrameAt(runs, 1, { mode: PLAY_MODES.together })
    expect(frame.runs.map((run) => run.index)).toEqual([1, 1])
  })

  it('sequence advances one run at a time', () => {
    const runs = uneven()
    const first = runs[0].trace.phases.length

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

  const runsOf = () => runScenarios(chain(), [scenario({ id: 'a', event: TRACK, sourceId: 'src' })])
  const frameOf = (tick) => combinedFrameAt(runsOf(), tick, {})
  /* The beat the event arrives at a component on. A literal tick would encode the phase layout --
     travel-then-arrive per wave -- into every assertion, so they would all have to move together
     the next time the beats change. */
  const arrivalOf = (nodeId) => arrivalBeat(runsOf()[0].trace, nodeId)

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
    const before = applyPathsToNodes(canvasNodes(), frameOf(arrivalOf('fn')))
    const after = applyPathsToNodes(before, frameOf(arrivalOf('dest')))

    const at = (nodes, id) => nodes.find((node) => node.id === id)
    /* The source is behind the playhead in both frames, so it must be untouched;
       the node the playhead moved onto must not be. */
    expect(at(after, 'src')).toBe(at(before, 'src'))
    expect(at(after, 'dest')).not.toBe(at(before, 'dest'))
    /* Zone backdrops are regions, never path carriers. */
    expect(at(after, 'zone-connections')).toBe(at(before, 'zone-connections'))
  })

  it('marks the component the playhead is on, and only that one', () => {
    const nodes = applyPathsToNodes(canvasNodes(), frameOf(arrivalOf('fn')))
    const here = nodes.filter((node) => node.data.paths?.some((entry) => entry.current))
    expect(here.map((node) => node.id)).toEqual(['fn'])
  })

  it('marks no component while the event is in transit', () => {
    /* A glowing component is the claim "the event is here". On a travelling beat it is not at a
       component at all, so lighting either end of the connector would be saying something untrue --
       and the event itself is on the line, drawn by simulation/EventLayer.jsx. */
    const trace = runsOf()[0].trace
    const nodes = applyPathsToNodes(canvasNodes(), frameOf(beatIndex(trace, 'edge', 1)))
    expect(nodes.filter((node) => node.data.paths?.some((entry) => entry.current))).toHaveLength(0)
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

describe('what a walkthrough writes onto a component', () => {
  /*
   * Once: a note pinned open on whichever component the playhead was at. It covered the components
   * either side of the one it described, and because a wave arrives at several at once it had to be
   * capped at three and open *none* past that -- so a source feeding twenty destinations explained
   * nothing at the moment it had most to explain. The notes moved to a lane above the diagram
   * (simulation/NotesLane.jsx) and nothing is forced open on the canvas any more.
   *
   * What a component still carries is `paths`: the status that draws its ring, and the verdict, so
   * hovering it says what happened to *this* event rather than what the component is for.
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

  it('pins nothing open on the diagram', () => {
    const next = applyPathsToNodes(nodes(), frame)
    expect(next.find((node) => node.id === 'a').data.anchor).toBeUndefined()
  })

  it('carries the verdict on the path entry, for whoever asks to read it', () => {
    const runs = runScenarios(chain(), [scenario({ id: 'a', event: TRACK, sourceId: 'src' })])
    const canvas = [{ id: 'fn', type: 'segmentNode', data: { kind: 'source_insert_function' } }]
    const next = applyPathsToNodes(canvas, combinedFrameAt(runs, 99, {}))
    const entry = next[0].data.paths[0]
    expect(entry.step.nodeId).toBe('fn')
    expect(entry.step.reason).toBeTruthy()
  })

  /*
   * The verdict rides inside `paths` rather than in a field of its own, and this is why: a frame is
   * recomputed rather than mutated, so a separately-written step object is a *new* object every beat
   * and comparing it by identity would rebuild every annotated node on every beat -- which is
   * precisely what the identity contract above exists to prevent.
   */
  it('does not rebuild a component whose verdict was already recorded', () => {
    const runsOf = () =>
      runScenarios(chain(), [scenario({ id: 'a', event: TRACK, sourceId: 'src' })])
    const canvas = [{ id: 'src', type: 'segmentNode', data: { kind: 'source' } }]

    const before = applyPathsToNodes(canvas, combinedFrameAt(runsOf(), 2, {}))
    /* A freshly simulated trace, so every step object inside it is new. */
    const after = applyPathsToNodes(before, combinedFrameAt(runsOf(), 2, {}))
    expect(after[0]).toBe(before[0])
  })

  it('keeps the result once the transport has stopped', () => {
    /* The rings and the dimming are the result -- the reason to have watched -- so they stay put
       when playback ends rather than clearing themselves. */
    const next = applyPathsToNodes(nodes(), frame)
    expect(next.find((node) => node.id === 'a').data.paths).toHaveLength(1)
  })

  it('clears everything when handed no frame at all', () => {
    const annotated = applyPathsToNodes(nodes(), frame)
    const cleared = applyPathsToNodes(annotated, null)
    for (const node of cleared) {
      expect(node.data.paths).toBeUndefined()
      expect(node.data.anchor).toBeUndefined()
    }
  })

  it('leaves zones alone', () => {
    const withZone = [...nodes(), { id: 'zone-segment', type: 'zone', data: { id: 'segment' } }]
    const next = applyPathsToNodes(withZone, frame)
    expect(next.find((node) => node.type === 'zone').data).toEqual({ id: 'segment' })
  })
})
