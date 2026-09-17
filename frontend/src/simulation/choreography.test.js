/*
 * The event's itinerary in milliseconds.
 *
 * The property this file exists to hold is *alignment*: a token must reach a component on the
 * same instant the component lights up. The transport schedules beats from `tickDurations` and
 * the token moves from `choreograph`, and if those two ever compute time differently the event
 * arrives visibly early or late -- the exact defect the continuous clock was added to fix. So the
 * assertions here derive the expected millisecond independently, from `tickDurations` and
 * `phases`, rather than from `choreograph`'s own output.
 *
 * The other recurring theme is that a trace records more than the route the event took: one hop
 * past everything that stopped, so the diagram can say why, and the inert components no path
 * touches. Those belong on the canvas and must never get a token, because a token on them is the
 * tool claiming an event went somewhere it did not.
 */

import { describe, expect, it } from 'vitest'

import { choreograph, choreographyLength, legsAt, maxConcurrency } from './choreography.js'
import { simulate } from './router.js'
import { NODE_BEAT_MS, PLAY_MODES, tickDurations } from './scenarios.js'

const TRACK = {
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1',
  properties: { revenue: 42.5 },
  timestamp: '2026-01-15T10:30:00.000Z',
}

/* source -> insert fn -> destination. */
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

/* One moment with the event in two places, and the two connectors deliberately unequal in
   length -- which is what makes "both start together, one arrives first" observable. */
function fork() {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Website' },
      { id: 'braze', kind: 'destination', name: 'Braze' },
      { id: 'amp', kind: 'destination', name: 'Amplitude' },
    ],
    edges: [
      { id: 'near', source: 'src', target: 'braze' },
      { id: 'far', source: 'src', target: 'amp' },
    ],
  }
}

/* Two routes into one component, so the second connector is recorded as a rejoin. */
function diamond() {
  return {
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
}

/* The trace, its beat lengths, and its legs -- the three things every assertion needs, built the
   way the app builds them so the test cannot accidentally time things its own way. */
function staged(graph, { hopMs, ...options } = {}) {
  const trace = simulate(graph, TRACK, options)
  const table = hopMs ? new Map(Object.entries(hopMs)) : null
  const durations = tickDurations([{ trace }], PLAY_MODES.together, { hopMs: table })
  return { trace, durations, legs: choreograph(trace, { durations, hopMs: table }) }
}

/* When beat `n` begins, summed independently of `choreograph`. */
const offsetOf = (durations, beat) =>
  durations.slice(0, beat).reduce((total, span) => total + span, 0)

const beatIndex = (trace, kind, wave) =>
  trace.phases.findIndex((beat) => beat.kind === kind && beat.wave === wave)

const dwellFor = (legs, nodeId) => legs.find((leg) => leg.kind === 'dwell' && leg.nodeId === nodeId)
const travelFor = (legs, edgeId) =>
  legs.find((leg) => leg.kind === 'travel' && leg.edgeId === edgeId)

describe('choreograph', () => {
  it('puts the event at the start component from the very first millisecond', () => {
    const { legs } = staged(chain())
    const origin = dwellFor(legs, 'src')
    expect(origin.start).toBe(0)
    /* Not merely present: live at 0. A run whose first leg began later would open with the event
       nowhere, which is the whole class of bug this module addresses. */
    expect(legsAt(legs, 0).map((leg) => leg.nodeId)).toContain('src')
  })

  /*
   * The invariant. Both numbers describe the same instant and are computed by different code:
   * the left from the beat table the transport uses, the right from the legs the token follows.
   */
  it('lands the event on a component at the instant that component lights up', () => {
    const { trace, durations, legs } = staged(chain())

    for (const nodeId of ['src', 'fn', 'dest']) {
      const wave = trace.steps.find((step) => step.nodeId === nodeId).wave
      const beat = beatIndex(trace, 'node', wave)
      expect(dwellFor(legs, nodeId).start).toBe(offsetOf(durations, beat))
    }
  })

  it('starts crossing a connector at the instant its travelling beat begins', () => {
    const { trace, durations, legs } = staged(chain())
    const beat = beatIndex(trace, 'edge', 1)
    expect(travelFor(legs, 'e1').start).toBe(offsetOf(durations, beat))
  })

  /*
   * No gaps between one leg's end and the next one's start.
   *
   * This is the property the whole module exists for. The event used to be drawn only by the
   * connector it was crossing, so on every arrival beat there was nothing on screen at all -- half of
   * every run had no event in it. Checked across the span the event is in play, sampled finely enough
   * to catch a gap of a frame or two.
   */
  it('leaves no instant where the event is nowhere', () => {
    const { legs } = staged(chain())

    for (let at = 0; at < choreographyLength(legs); at += 25) {
      expect(legsAt(legs, at).length, `nothing live at ${at}ms`).toBeGreaterThan(0)
    }
  })

  it('runs exactly as long as the transport does, when the event gets everywhere', () => {
    const { legs, durations } = staged(chain())
    expect(choreographyLength(legs)).toBe(durations.reduce((sum, span) => sum + span, 0))
  })

  /*
   * And stops early when the event does, rather than being padded out to the transport's length.
   *
   * The trace keeps going after the event stops -- a beat per dead end, so the diagram can say why
   * nothing arrived. Those beats carry no token, which is the honest reading: inventing one to fill
   * them would draw an event travelling to a component the run has just finished explaining it never
   * reaches. What must never happen is a leg running *past* the transport, which would leave a token
   * still moving after playback had ended.
   */
  it('never outlasts the transport, and ends early when the event stops early', () => {
    const { legs, durations } = staged(chain(), { functionBehaviour: { fn: 'drop' } })
    const total = durations.reduce((sum, span) => sum + span, 0)
    expect(choreographyLength(legs)).toBeLessThan(total)
    for (const leg of legs) expect(leg.until).toBeLessThanOrEqual(total)
  })

  describe('a fork', () => {
    it('sends both arms off at the same instant', () => {
      const { legs } = staged(fork(), { hopMs: { near: 400, far: 1200 } })
      expect(travelFor(legs, 'near').start).toBe(travelFor(legs, 'far').start)
    })

    /* Constant speed: the arm covering three times the distance takes three times as long,
       rather than both being stretched to the beat. */
    it('lets the shorter arm arrive first', () => {
      const { legs } = staged(fork(), { hopMs: { near: 400, far: 1200 } })
      const near = travelFor(legs, 'near')
      const far = travelFor(legs, 'far')
      expect(near.end - near.start).toBe(400)
      expect(far.end - far.start).toBe(1200)
      expect(near.end).toBeLessThan(far.end)
    })

    /* ...and then waits, rather than the beat cutting early and leaving the other arm mid-air. */
    it('holds the arrived arm at the far end until the slower one lands', () => {
      const { legs } = staged(fork(), { hopMs: { near: 400, far: 1200 } })
      expect(travelFor(legs, 'near').until).toBe(travelFor(legs, 'far').until)

      const parked = legsAt(legs, travelFor(legs, 'near').end + 50).find(
        (leg) => leg.edgeId === 'near',
      )
      expect(parked.progress).toBe(1)
    })

    it('has the event in two places at once while both arms are crossing', () => {
      const { legs } = staged(fork(), { hopMs: { near: 400, far: 1200 } })
      const live = legsAt(legs, travelFor(legs, 'near').start + 100)
      expect(live.filter((leg) => leg.kind === 'travel').map((leg) => leg.edgeId).sort()).toEqual([
        'far',
        'near',
      ])
    })

    it('arrives at both components on one beat', () => {
      const { legs } = staged(fork(), { hopMs: { near: 400, far: 1200 } })
      expect(dwellFor(legs, 'braze').start).toBe(dwellFor(legs, 'amp').start)
    })
  })

  describe('a connector the event never crossed', () => {
    /*
     * The trace records one hop past whatever stopped, so the diagram can say "the event never
     * reaches Braze, and here is why". That connector is drawn, and dimmed -- but an event token
     * travelling down it would be the tool asserting a delivery that did not happen.
     */
    it('gets no token when the component feeding it dropped the event', () => {
      const { legs } = staged(chain(), { functionBehaviour: { fn: 'drop' } })
      expect(travelFor(legs, 'e1')).toBeDefined()
      expect(travelFor(legs, 'e2')).toBeUndefined()
      expect(dwellFor(legs, 'dest')).toBeUndefined()
    })

    it('still puts a token on the component that did the dropping', () => {
      const { legs } = staged(chain(), { functionBehaviour: { fn: 'drop' } })
      /* The event got as far as the function. Leaving it out would end the run with the token
         parked one component short of where it actually stopped. */
      expect(dwellFor(legs, 'fn')).toBeDefined()
    })
  })

  describe('a component reached by two routes', () => {
    it('puts a token on both connectors into it', () => {
      const { legs } = staged(diamond())
      expect(travelFor(legs, 'ad')).toBeDefined()
      expect(travelFor(legs, 'bd')).toBeDefined()
    })

    /* One component, one token. The rejoin exists so the second *connector* lights up; a second
       dwell would stack two tokens on the same centre and read as one that flickered. */
    it('puts only one token on the component itself', () => {
      const { legs } = staged(diamond())
      expect(legs.filter((leg) => leg.kind === 'dwell' && leg.nodeId === 'dest')).toHaveLength(1)
    })
  })

  describe('a component no path touches', () => {
    it('gets no token', () => {
      const graph = chain()
      graph.nodes.push({ id: 'orphan', kind: 'destination', name: 'Unconnected' })
      const { legs } = staged(graph)
      expect(dwellFor(legs, 'orphan')).toBeUndefined()
    })
  })

  describe('with no timing supplied', () => {
    /* A caller with no geometry -- a test, an export -- gets uniform beats rather than a
       collapsed timeline. A zero-length beat would make its leg never live, so the event would
       blink out for that hop instead of merely being mistimed. */
    it('falls back to a uniform beat rather than to nothing', () => {
      const trace = simulate(chain(), TRACK)
      const legs = choreograph(trace)
      expect(legs.length).toBeGreaterThan(0)
      for (const leg of legs) expect(leg.until - leg.start).toBe(NODE_BEAT_MS)
    })
  })

  /* `sequence` mode lays the runs end to end, so the second one's legs have to sit after the first
     one's on the same clock -- the transport's own offset expressed in milliseconds rather than in
     beats. Without it every run would start at zero and they would all animate at once, which is the
     other play mode. */
  describe('a run that starts partway through the transport', () => {
    it('shifts every leg by the offset', () => {
      const { trace, durations } = staged(chain())
      const plain = choreograph(trace, { durations })
      const shifted = choreograph(trace, { durations, offset: 5000 })

      expect(shifted[0].start).toBe(plain[0].start + 5000)
      expect(choreographyLength(shifted)).toBe(choreographyLength(plain) + 5000)
    })

    it('is not live before its offset', () => {
      const { trace, durations } = staged(chain())
      const shifted = choreograph(trace, { durations, offset: 5000 })
      expect(legsAt(shifted, 4999)).toEqual([])
      expect(legsAt(shifted, 5000).length).toBeGreaterThan(0)
    })

    it('ignores a nonsense offset rather than producing legs at NaN', () => {
      const { trace, durations } = staged(chain())
      expect(choreograph(trace, { durations, offset: NaN })[0].start).toBe(0)
    })
  })

  it('is empty for a trace that never started', () => {
    expect(choreograph(simulate(chain(), TRACK, { sourceId: 'nope' }))).toEqual([])
    expect(choreograph(null)).toEqual([])
    expect(choreographyLength(null)).toBe(0)
  })
})

describe('maxConcurrency', () => {
  /* How many tokens the canvas mounts. It must be the peak over the whole run and not the count
     right now, because they are mounted once and then moved -- sizing to the current count would
     mean a React render on every beat, which is what moving them imperatively avoids. */
  it('is one for a route that never splits', () => {
    expect(maxConcurrency(staged(chain()).legs)).toBe(1)
  })

  it('counts both arms of a fork', () => {
    expect(maxConcurrency(staged(fork(), { hopMs: { near: 400, far: 1200 } }).legs)).toBe(2)
  })

  /* Agrees with what is actually live: a pool sized below the peak would drop a token mid-flight. */
  it('is never exceeded at any instant of the run', () => {
    const { legs } = staged(diamond())
    const peak = maxConcurrency(legs)
    for (let at = 0; at < choreographyLength(legs); at += 25) {
      expect(legsAt(legs, at).length).toBeLessThanOrEqual(peak)
    }
  })

  it('is zero with nothing to play', () => {
    expect(maxConcurrency([])).toBe(0)
    expect(maxConcurrency(null)).toBe(0)
  })
})

describe('legsAt', () => {
  it('is empty before the run and once it has finished', () => {
    const { legs, durations } = staged(chain())
    const total = durations.reduce((sum, span) => sum + span, 0)
    expect(legsAt(legs, -1)).toEqual([])
    expect(legsAt(legs, total)).toEqual([])
  })

  it('reports how far along a connector the event is', () => {
    const { legs } = staged(chain(), { hopMs: { e1: 1000, e2: 1000 } })
    const travel = travelFor(legs, 'e1')
    const half = legsAt(legs, travel.start + 500).find((leg) => leg.edgeId === 'e1')
    expect(half.progress).toBeCloseTo(0.5, 5)
  })

  /* A pure projection of a number, like every other frame in this system -- which is what makes
     scrubbing free and playing backwards cost the same as forwards. */
  it('is a pure function of the millisecond', () => {
    const { legs } = staged(diamond())
    expect(legsAt(legs, 1400)).toEqual(legsAt(legs, 1400))
  })

  it('treats a garbled clock as the start of the run', () => {
    const { legs } = staged(chain())
    expect(legsAt(legs, undefined)).toEqual(legsAt(legs, 0))
    expect(legsAt(legs, NaN)).toEqual(legsAt(legs, 0))
  })
})
