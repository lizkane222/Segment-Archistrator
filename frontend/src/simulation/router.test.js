/*
 * The reducer.
 *
 * Graphs here are written in the *document* shape (flat nodes, no `data`) on
 * purpose: the reducer accepts either that or React Flow's nested shape, and the
 * flat one is what comes back from Postgres. `nestedGraph` re-wraps one fixture to
 * prove both work, because a reducer that only handled live canvas nodes would fail
 * exactly when someone simulated a diagram they had just reopened.
 *
 * The chain mirrors the end-to-end-test template fixture: source -> insert function
 * -> filter -> destination, plus an unfiltered control destination hanging off the
 * same insert function. That template exists to answer "where was my event dropped",
 * so it is the shape worth testing against.
 */

import { describe, expect, it } from 'vitest'

import { anchor } from '../functions/steps.js'
import {
  FALLBACK,
  STATUS,
  acceptsModify,
  foldLegacyBehaviour,
  hasArrived,
  indeterminate,
  defaultSourceId,
  eligibleSources,
  eligibleStarts,
  frameAt,
  frameAtPhase,
  simulate,
  revisitable,
  simulateAt,
  summarize,
} from './router.js'

const TRACK = {
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1',
  anonymousId: 'anon_1',
  properties: { revenue: 42.5, plan: 'pro' },
  context: { locale: 'en-US' },
  timestamp: '2026-01-15T10:30:00.000Z',
}

/*
 * source -> insert fn -> filter -> destination, and insert fn -> control dest.
 *
 * The default condition MATCHES the fixture event, because a filter's condition
 * selects which events its actions apply to. Pairing a non-matching condition with
 * a DROP action would let the event through, which is the inversion most likely to
 * be got backwards -- so the fixture pins the matching case.
 *
 * The fan-out is off the insert function rather than off a hub in the middle. There
 * used to be a `segment_core` node between the two, and every test in this file
 * walked through it; what replaced it is the `segment` zone containing both ends, so
 * the branch point is now the last component the event actually passes through.
 */
function chain({ condition = 'properties.revenue > 10', actions = [{ type: 'DROP' }] } = {}) {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Test source', segmentId: 'S1' },
      { id: 'fn', kind: 'source_insert_function', name: 'Transform' },
      { id: 'filter', kind: 'destination_filter', name: 'Big orders only', condition, actions },
      { id: 'dest', kind: 'destination', name: 'Warehouse of record' },
      { id: 'control', kind: 'destination', name: 'Webhook (control)' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'fn' },
      { id: 'e2', source: 'fn', target: 'filter' },
      { id: 'e3', source: 'filter', target: 'dest' },
      { id: 'e4', source: 'fn', target: 'control' },
    ],
  }
}

const statusOf = (trace, id) => trace.visited[id]?.status
const reasonOf = (trace, id) => trace.visited[id]?.reason ?? ''

describe('choosing a start', () => {
  it('still lists only sources as the origins of an *event*', () => {
    expect(eligibleSources(chain()).map((node) => node.id)).toEqual(['src'])
  })

  it('offers every component as a walkthrough start, sources first', () => {
    /* Widened deliberately: `warehouse -> reverse_etl_model -> destination` is a real
       Segment path with no write key and no source in it, and it used to be unwalkable.
       Sources lead because they are still the usual answer. */
    const ids = eligibleStarts(chain()).map((node) => node.id)
    expect(ids[0]).toBe('src')
    expect(ids).toContain('filter')
    expect(defaultSourceId(chain())).toBe('src')
  })

  it('traces forward from a component that is not a source', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'filter' })
    expect(trace.steps.length).toBeGreaterThan(0)
    expect(trace.steps[0].nodeId).toBe('filter')
  })

  it('says so when the run did not start at a source', () => {
    /* The trace is honest about being a partial path rather than presenting itself as a
       full event journey, which is what it would otherwise look like. */
    const trace = simulate(chain(), TRACK, { sourceId: 'filter' })
    expect(trace.notes.join(' ')).toMatch(/not a source/)
  })

  it('refuses only when the start is not on the diagram at all', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'ghost' })
    expect(trace.steps).toEqual([])
    expect(trace.notes.join(' ')).toMatch(/Pick a component/)
  })

  it('says which source it used when a diagram has several', () => {
    const graph = chain()
    graph.nodes.push({ id: 'src2', kind: 'source', name: 'Mobile', segmentId: 'S2' })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(trace.notes.join(' ')).toMatch(/Test source/)
    expect(trace.notes.join(' ')).toMatch(/1 source/)
  })

  it('reports an empty canvas rather than producing an empty success', () => {
    const trace = simulate({ nodes: [], edges: [] }, TRACK)
    expect(trace.notes.join(' ')).toMatch(/nothing on the canvas/)
  })
})

describe('a filter that drops the event', () => {
  const trace = simulate(chain(), TRACK, { sourceId: 'src' })

  it('walks the whole path in breadth-first order', () => {
    expect(trace.steps.map((step) => step.nodeId)).toEqual([
      'src',
      'fn',
      'filter',
      'control',
      'dest',
    ])
  })

  it('drops at the filter and names the condition', () => {
    expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'filter')).toMatch(/properties\.revenue > 10/)
  })

  /* Pass two: the destination behind the filter is reported, with the upstream
     reason, rather than left unvisited. */
  it('explains the destination it never reached', () => {
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
    expect(reasonOf(trace, 'dest')).toMatch(/never reaches/)
    expect(reasonOf(trace, 'dest')).toMatch(/Big orders only/)
  })

  it('still delivers to the unfiltered control destination', () => {
    expect(statusOf(trace, 'control')).toBe(STATUS.delivered)
  })

  it('marks the function as a transform it did not read', () => {
    expect(statusOf(trace, 'fn')).toBe(STATUS.transformed)
    expect(reasonOf(trace, 'fn')).toMatch(/code is not read/)
  })
})

describe('a filter whose condition the event does not match', () => {
  /* The same DROP action as the fixture, and the event still arrives: the action
     applies only to what the condition selects. */
  it('leaves the event alone', () => {
    const trace = simulate(chain({ condition: 'properties.revenue > 1000' }), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'filter')).toMatch(/does not match/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('drops when a filter matches everything because it has no condition', () => {
    const trace = simulate(chain({ condition: '' }), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
  })
})

describe('filter actions', () => {
  it('reports a field-blocking action as a transform and keeps going', () => {
    const graph = chain({
      condition: 'type = "track"',
      actions: [{ type: 'BLACKLIST_FIELDS', fields: { properties: { fields: ['plan'] } } }],
    })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.transformed)
    expect(reasonOf(trace, 'filter')).toMatch(/removes properties\.plan/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  /* Sampling is random. Claiming either outcome would be inventing a result. */
  it('refuses to decide a sampled event', () => {
    const graph = chain({ condition: 'type = "track"', actions: [{ type: 'SAMPLE_EVENT', percent: 0.1 }] })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.undecided)
    expect(reasonOf(trace, 'filter')).toMatch(/10%/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
  })

  it('keeps an honest verdict for a condition it cannot parse, without truncating', () => {
    /* The filter's own verdict is unchanged -- the tool did not read the condition and does not claim
       to have. What changed is that it no longer takes the rest of the diagram down with it: one
       unparseable condition used to blank out every component behind it, which is a claim about the
       reader's diagram rather than about their filter. */
    const graph = chain({ condition: 'properties.revenue ~= 100' })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.notEvaluated)
    expect(reasonOf(trace, 'filter')).toMatch(/cannot read/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('stops there when the reader says to block on an unreadable condition', () => {
    /* The escape hatch that replaces the old default: the reader, not the parser, decides. */
    const graph = chain({ condition: 'properties.revenue ~= 100' })
    const trace = simulate(graph, TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.block } })
    expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('treats a disabled filter as absent', () => {
    const graph = chain()
    graph.nodes.find((node) => node.id === 'filter').enabled = false
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.passed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })
})

/*
 * Schema controls, the one gate inside Segment's own validation.
 *
 * The fixture records the plan on the *component* rather than reaching for a
 * `tracking_plan` node, which is the shape the reducer is given: a plan node is a
 * definition and the enforcement is a setting on the source, so what the simulator can
 * check is the list of names someone recorded on the gate.
 */
function withSchemaControl(settings = {}) {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'schema', kind: 'source_schema_control', name: 'Schema controls', ...settings },
      { id: 'dest', kind: 'destination', name: 'Braze' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'schema' },
      { id: 'e2', source: 'schema', target: 'dest' },
    ],
  }
}

describe('source schema controls', () => {
  it('drops a blocked event and says it costs nothing', () => {
    const trace = simulate(withSchemaControl({ blockedEvents: ['Order Completed'] }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'schema')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'schema')).toMatch(/MTU/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  /* Both tolerated forms of the list, because the API returns strings and a hand-drawn
     component is as likely to hold `{name}` -- and a gate that silently matched neither
     would report every event as fine. */
  it('matches a blocked name case-insensitively and in object form', () => {
    const lower = simulate(withSchemaControl({ blockedEvents: ['order completed'] }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(lower, 'schema')).toBe(STATUS.dropped)

    const objects = simulate(
      withSchemaControl({ blockedEvents: [{ name: 'Order Completed' }] }),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(objects, 'schema')).toBe(STATUS.dropped)
  })

  it('blocks an unplanned event when the source is set to block', () => {
    const trace = simulate(
      withSchemaControl({ plannedEvents: ['Page Viewed'], unplanned: 'block' }),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'schema')).toBe(STATUS.dropped)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('carries an unplanned event on when the source omits rather than blocks', () => {
    const trace = simulate(
      withSchemaControl({ plannedEvents: ['Page Viewed'], unplanned: 'omit' }),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'schema')).toBe(STATUS.transformed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('passes an unplanned event when the source allows it, and says it is still a violation', () => {
    const trace = simulate(
      withSchemaControl({ plannedEvents: ['Page Viewed'], unplanned: 'allow' }),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'schema')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'schema')).toMatch(/violation/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  /* The important one. Allow, omit and block differ by everything downstream, so an
     unplanned event on a component that does not record which of them applies must not
     be guessed at in either direction -- and the destination behind it inherits the
     doubt rather than a verdict. */
  it('claims nothing for an unplanned event when the mode is not recorded', () => {
    const trace = simulate(withSchemaControl({ plannedEvents: ['Page Viewed'] }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'schema')).toBe(STATUS.notEvaluated)
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
  })

  it('passes a planned event but only claims the name was checked', () => {
    const trace = simulate(withSchemaControl({ plannedEvents: ['Order Completed'] }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'schema')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'schema')).toMatch(/only the event name/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('passes when the component records no lists at all', () => {
    const trace = simulate(withSchemaControl(), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'schema')).toBe(STATUS.passed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })
})

/* An actions destination's mapping. The trigger is FQL, so unlike a function body it is
   evaluated rather than described -- which is what lets the walkthrough show a
   destination that is connected, enabled, and still receives nothing. */
function withMapping(mapping = {}) {
  return {
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'map', kind: 'destination_mapping', name: 'Track Event', ...mapping },
      { id: 'dest', kind: 'destination', name: 'Braze' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'map' },
      { id: 'e2', source: 'map', target: 'dest' },
    ],
  }
}

describe('an actions destination mapping', () => {
  it('fires when the trigger matches, and does not resolve the fields', () => {
    const trace = simulate(withMapping({ trigger: 'type = "track"' }), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'map')).toBe(STATUS.transformed)
    expect(trace.visited.map.transform).toEqual({ unread: true })
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('sends nothing when no trigger matches, though the destination is connected', () => {
    const trace = simulate(withMapping({ trigger: 'type = "page"' }), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'map')).toBe(STATUS.unmatched)
    expect(reasonOf(trace, 'map')).toMatch(/still send nothing/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('fires on every event when no trigger is recorded', () => {
    const trace = simulate(withMapping(), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'map')).toBe(STATUS.transformed)
    expect(reasonOf(trace, 'map')).toMatch(/no trigger/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('keeps an honest verdict for a trigger it cannot read, without truncating', () => {
    const trace = simulate(withMapping({ trigger: 'properties.revenue >' }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'map')).toBe(STATUS.notEvaluated)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })
})

describe('a destination wired to a different source', () => {
  /* build_graph now draws one edge per real source->destination connection, so the
     diagram can show this -- but only for a diagram it discovered. A hand-drawn or
     hand-edited one can still claim an edge the workspace does not have, and this is
     the commonest real answer to "why did my event not arrive". */
  it('is reported as not connected, not as delivered', () => {
    const graph = chain({ condition: 'type = "page"' })
    graph.nodes.find((node) => node.id === 'dest').sourceId = 'SOMEONE_ELSE'
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
    expect(reasonOf(trace, 'dest')).toMatch(/different source/)
  })

  it('delivers when the wiring matches the simulated source', () => {
    const graph = chain({ condition: 'type = "page"' })
    graph.nodes.find((node) => node.id === 'dest').sourceId = 'S1'
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })
})

describe('disabled components', () => {
  it('delivers nothing to a disabled destination', () => {
    const graph = chain({ condition: 'type = "page"' })
    graph.nodes.find((node) => node.id === 'dest').enabled = false
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
    expect(reasonOf(trace, 'dest')).toMatch(/disabled/)
  })
})

describe('Unify and Engage', () => {
  function unifyGraph(query) {
    return {
      nodes: [
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'space', kind: 'space', name: 'Production space' },
        { id: 'aud', kind: 'audience', name: 'Purchasers', query },
        { id: 'dest', kind: 'destination', name: 'Ad platform' },
      ],
      edges: [
        { id: 'e1', source: 'src', target: 'space' },
        { id: 'e2', source: 'space', target: 'aud' },
        { id: 'e3', source: 'aud', target: 'dest' },
      ],
    }
  }

  it('matches an audience this event satisfies, and syncs onward', () => {
    const trace = simulate(unifyGraph("event('Order Completed').count() >= 1"), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.matched)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('reports an audience needing history as undecided, and carries on past it', () => {
    /*
     * The audience keeps its amber verdict, because one event genuinely cannot tell you whether a
     * profile has five orders and saying otherwise would be a lie. What it no longer does is take the
     * destination down with it.
     *
     * That used to read `undecided` here too, which was defensible and unhelpful: an audience is the
     * component readers most often have downstream of them, so one honest caveat greyed out the whole
     * end of the walkthrough. The verdict is preserved and the *walk* continues, which is the
     * distinction `carryOn` exists for.
     */
    const trace = simulate(unifyGraph("event('Order Completed').count() >= 5"), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.undecided)
    expect(reasonOf(trace, 'aud')).toMatch(/carries on past it/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('lets the reader block at an audience it cannot settle', () => {
    const trace = simulate(unifyGraph("event('Order Completed').count() >= 5"), TRACK, {
      sourceId: 'src',
      fallback: { aud: FALLBACK.block },
    })
    expect(statusOf(trace, 'aud')).toBe(STATUS.dropped)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('lets an unconfigured audience through rather than stalling on it', () => {
    /* A placeholder somebody dropped on the canvas records no definition at all, which is a different
       thing from a definition that cannot be settled -- there is no verdict to preserve, so the route
       reads green. Every audience in every diagram this tool holds is in exactly this state. */
    const trace = simulate(unifyGraph(undefined), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'aud')).toMatch(/No audience definition is recorded/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('reports a definite non-match as unmatched, and blocks downstream', () => {
    const trace = simulate(unifyGraph("event('Order Completed').count() = 0"), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.unmatched)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('reports a definition outside the subset as not evaluated', () => {
    const trace = simulate(unifyGraph("ANY event('X').count() >= 1"), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.notEvaluated)
  })

  it('cannot attach an event with no identifier to a profile', () => {
    const anonymous = { type: 'track', event: 'Order Completed', properties: {} }
    const trace = simulate(unifyGraph("event('Order Completed').count() >= 1"), anonymous, { sourceId: 'src' })
    expect(statusOf(trace, 'space')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'space')).toMatch(/no identifier/)
    expect(statusOf(trace, 'aud')).toBe(STATUS.blocked)
  })
})

describe('components that are not event-driven', () => {
  it('says so for Reverse ETL and the Profile API rather than animating through them', () => {
    const graph = {
      nodes: [
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'wh', kind: 'warehouse', name: 'Snowflake' },
        { id: 'model', kind: 'reverse_etl_model', name: 'VIP model' },
        { id: 'space', kind: 'space', name: 'Space' },
        { id: 'papi', kind: 'profile_api', name: 'Profile API' },
      ],
      edges: [
        { id: 'e1', source: 'src', target: 'wh' },
        { id: 'e2', source: 'wh', target: 'model' },
        { id: 'e3', source: 'src', target: 'space' },
        { id: 'e4', source: 'space', target: 'papi' },
      ],
    }
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'wh')).toBe(STATUS.delivered)
    expect(statusOf(trace, 'model')).toBe(STATUS.notApplicable)
    expect(reasonOf(trace, 'model')).toMatch(/schedule/)
    expect(statusOf(trace, 'papi')).toBe(STATUS.notApplicable)
    expect(reasonOf(trace, 'papi')).toMatch(/read surface/)
  })
})

/*
 * Pass three: definitions nothing routes through.
 *
 * These have no edge to be explained along, so passes one and two cannot reach them and
 * they would render grey -- indistinguishable from a simulator that gave up, on exactly
 * the components someone stops a walkthrough to ask about.
 *
 * The bound matters as much as the behaviour, which is why the orphaned destination is in
 * the same fixture: a pass that accounted for every unvisited node would flood a real
 * workspace's walkthrough with hundreds of destinations belonging to other sources.
 */
describe('components no event passes through', () => {
  const protocols = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'dest', kind: 'destination', name: 'Braze' },
      { id: 'plan', kind: 'tracking_plan', name: 'Core plan' },
      { id: 'events', kind: 'event_library', name: 'Shared events' },
      { id: 'props', kind: 'property_library', name: 'Shared properties' },
      { id: 'orphan', kind: 'destination', name: 'Amplitude', sourceId: 'SOMEONE_ELSE' },
    ],
    edges: [{ id: 'e1', source: 'src', target: 'dest' }],
  })

  it('accounts for a tracking plan with no edges, and names what enforces it', () => {
    const trace = simulate(protocols(), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'plan')).toBe(STATUS.notApplicable)
    expect(reasonOf(trace, 'plan')).toMatch(/schema controls/)
  })

  it('distinguishes the two library kinds', () => {
    const trace = simulate(protocols(), TRACK, { sourceId: 'src' })
    expect(reasonOf(trace, 'events')).toMatch(/events and their properties/)
    expect(reasonOf(trace, 'props')).toMatch(/groups of properties/)
  })

  it('leaves a destination on another source grey rather than explaining it', () => {
    const trace = simulate(protocols(), TRACK, { sourceId: 'src' })
    expect(trace.visited.orphan).toBeUndefined()
  })

  /* Footnotes, not part of the walk: an anchor with no edge inserted mid-trace would
     make the animation jump to an unconnected corner of the canvas and back. */
  it('records them last and with no edge to travel', () => {
    const trace = simulate(protocols(), TRACK, { sourceId: 'src' })
    const inert = trace.steps.filter((step) => step.edgeId === null && step.index > 0)
    expect(inert.map((step) => step.nodeId)).toEqual(['plan', 'events', 'props'])
    expect(inert[0].index).toBeGreaterThan(trace.visited.dest.index)
    for (const step of inert) {
      expect(step.fromId).toBeNull()
      expect(step.propagate).toBe(false)
    }
  })

  it('adds no edge to the frame, so playback is unaffected', () => {
    const trace = simulate(protocols(), TRACK, { sourceId: 'src' })
    const frame = frameAt(trace, trace.steps.length - 1)
    expect(Object.keys(frame.edgeStatus)).toEqual(['e1'])
    expect(frame.nodeStatus.plan).toBe(STATUS.notApplicable)
  })

  /* Reverse ETL is inert *and* reachable -- a warehouse propagates into it. Pass one has
     to win, or the model would be described as taking no part in a path it is on. */
  it('still explains a Reverse ETL model along its edge when one exists', () => {
    const graph = protocols()
    graph.nodes.push({ id: 'wh', kind: 'warehouse', name: 'Snowflake' })
    graph.nodes.push({ id: 'model', kind: 'reverse_etl_model', name: 'VIP model' })
    graph.edges.push({ id: 'e2', source: 'src', target: 'wh' })
    graph.edges.push({ id: 'e3', source: 'wh', target: 'model' })

    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(trace.visited.model.fromId).toBe('wh')
    expect(trace.visited.model.edgeId).toBe('e3')
  })
})

describe('Profiles Sync', () => {
  const synced = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'space', kind: 'space', name: 'Prod space' },
      { id: 'sync', kind: 'profile_sync', name: 'Profiles Sync' },
      { id: 'wh', kind: 'warehouse', name: 'Snowflake' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'space' },
      { id: 'e2', source: 'space', target: 'sync' },
      { id: 'e3', source: 'sync', target: 'wh' },
    ],
  })

  /* `passed`, not `delivered`: what lands in the warehouse is the profile this event
     changed, on the sync's own schedule. Calling the event delivered here would date a
     row that does not exist yet -- and the warehouse behind it is the thing that gets to
     say "delivered", on its own next sync. */
  it('carries the profile onward without claiming the event arrived now', () => {
    const trace = simulate(synced(), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'sync')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'sync')).toMatch(/schedule/)
    expect(statusOf(trace, 'wh')).toBe(STATUS.delivered)
  })
})

describe('functions the user asserts a behaviour for', () => {
  it('drops when told to, and explains that it was told to', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', fallback: { fn: FALLBACK.block } })
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'fn')).toMatch(/You set/)
    expect(statusOf(trace, 'filter')).toBe(STATUS.blocked)
  })

  it('still reads the legacy functionBehaviour spelling', () => {
    /* Nothing in the app ever wrote it, but a scenario in the database may carry one and both
       `serialize.test.js` and `tests/test_graph.py` pin that it survives a round trip. `drop` is the
       only value that ever did anything, and it means `block`. */
    const trace = simulate(chain(), TRACK, { sourceId: 'src', functionBehaviour: { fn: 'drop' } })
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(statusOf(trace, 'filter')).toBe(STATUS.blocked)
  })
})

/*
 * A function that carries code.
 *
 * The condition throughout is `type = "page"`, which the fixture's track event does not
 * match, so the filter leaves it alone and the payload the destination receives is the
 * one the function returned. That is the property under test: the code has to change
 * what the *rest of the path* sees, not merely produce a different sentence at the
 * function itself.
 */
describe('functions that carry code', () => {
  const withCode = (code, extra = {}) => {
    const graph = chain({ condition: 'type = "page"' })
    graph.nodes[1] = { ...graph.nodes[1], code, ...extra }
    return graph
  }
  const payloadAt = (trace, id) => trace.visited[id]?.payload

  it('carries a stripped field away from the function', () => {
    const trace = simulate(
      withCode('async function onTrack(event) { delete event.properties.revenue; return event }'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'fn')).toBe(STATUS.transformed)
    expect(reasonOf(trace, 'fn')).toMatch(/removed properties\.revenue/)
    /* The whole point: the destination two hops later sees the event without it. */
    expect(payloadAt(trace, 'dest').properties).toEqual({ plan: 'pro' })
    expect(payloadAt(trace, 'dest').userId).toBe('user_1')
  })

  it('carries a rewritten field, and does not touch the event handed in', () => {
    const event = structuredClone(TRACK)
    const trace = simulate(
      withCode('async function onTrack(e) { e.properties.revenue = 1; return e }'),
      event,
      { sourceId: 'src' },
    )
    expect(payloadAt(trace, 'dest').properties.revenue).toBe(1)
    expect(event.properties.revenue).toBe(42.5)
  })

  it('lets code change the event from one type to another, and routes on the new type', () => {
    /* A filter downstream reads the *new* type, because the event really has been
       rewritten by this point. This is the case that would be impossible to show if the
       payload were carried through untouched. */
    const graph = chain({ condition: 'type = "page"', actions: [{ type: 'DROP' }] })
    graph.nodes[1] = {
      ...graph.nodes[1],
      code: 'async function onTrack(e) { return { type: "page", userId: e.userId, name: "Pricing" } }',
    }
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(payloadAt(trace, 'fn').type).toBe('page')
    /* The filter matches now, and its DROP action fires -- which it would not have done
       for the track event that entered the function. */
    expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('reads passing the event through unchanged as passed, not as transformed', () => {
    /* An amber "the event was rewritten here" note on a component that did nothing to
       the event is a claim about the architecture that is simply false. */
    const trace = simulate(withCode('async function onTrack(e) { return e }'), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'fn')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'fn')).toMatch(/returned the event unchanged/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('stops the path where the code throws DropEvent', () => {
    const trace = simulate(
      withCode('async function onTrack(e) { throw new DropEvent("test traffic") }'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'fn')).toMatch(/test traffic/)
    expect(hasArrived(statusOf(trace, 'dest'))).toBe(false)
  })

  it('treats a missing handler as blocking that event type', () => {
    const trace = simulate(withCode('async function onIdentify(e) { return e }'), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'fn')).toMatch(/onTrack/)
  })

  it('leaves a RetryError undecided rather than guessing either way', () => {
    const trace = simulate(
      withCode('async function onTrack(e) { throw new RetryError("502 from vendor") }'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'fn')).toBe(STATUS.undecided)
    /* Pass two has to inherit the doubt rather than reporting a hard block. */
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
  })

  it('falls back to the unread verdict when the code needs the network', () => {
    /* The important fallback. Code that cannot be run locally must produce exactly the
       verdict this simulator gave before it read any code at all -- not an optimistic
       one, and not a truncated path. */
    const trace = simulate(
      withCode('async function onTrack(e) { await fetch("https://x.test"); return e }'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'fn')).toBe(STATUS.transformed)
    expect(trace.visited.fn.transform).toEqual({ unread: true })
    expect(reasonOf(trace, 'fn')).toMatch(/fetch/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('does not truncate the diagram because the code has a typo in it', () => {
    /* Someone is editing this in a sidebar beside the canvas. Half-typed code must not
       blank out everything downstream of the component. */
    const trace = simulate(withCode('async function onTrack(e) { return e'), TRACK, {
      sourceId: 'src',
    })
    expect(trace.visited.fn.transform).toEqual({ unread: true })
    expect(reasonOf(trace, 'fn')).toMatch(/could not be run/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('claims nothing past code that threw unexpectedly', () => {
    const trace = simulate(withCode('async function onTrack(e) { return e.nope.deeper }'), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'fn')).toBe(STATUS.notEvaluated)
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
  })

  it('lets the user override the code with an assumption', () => {
    /* "Assume this drops" is a question the reader asked. Code saying otherwise is not
       an answer to it. */
    const trace = simulate(withCode('async function onTrack(e) { return e }'), TRACK, {
      sourceId: 'src',
      fallback: { fn: FALLBACK.block },
    })
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'fn')).toMatch(/You set/)
  })

  it('steps over code on a component left out of the path', () => {
    const trace = simulate(withCode('async function onTrack(e) { throw new DropEvent("no") }'), TRACK, {
      sourceId: 'src',
      excluded: ['fn'],
    })
    expect(statusOf(trace, 'fn')).toBe(STATUS.bypassed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('reports how many lines the code logged, without carrying them in the trace', () => {
    const trace = simulate(
      withCode('async function onTrack(e) { console.log("one"); console.warn("two"); return e }'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(reasonOf(trace, 'fn')).toMatch(/logged 2 lines/)
    expect(trace.visited.fn.transform.logs).toBe(2)
    /* The text itself belongs in the Code tab. A trace is held per scenario per tick, so
       what rides in it stays small. */
    expect(JSON.stringify(trace.visited.fn.transform)).not.toMatch(/one|two/)
  })

  it('passes the component settings to the handler', () => {
    const trace = simulate(
      withCode('async function onTrack(e, settings) { e.properties.region = settings.region; return e }', {
        functionSettings: { region: 'eu' },
      }),
      TRACK,
      { sourceId: 'src' },
    )
    expect(payloadAt(trace, 'dest').properties.region).toBe('eu')
  })

  it('delivers at a destination function rather than propagating past it', () => {
    const graph = {
      nodes: [
        { id: 'src', kind: 'source', name: 'Test source', segmentId: 'S1' },
        {
          id: 'fn',
          kind: 'destination_function',
          name: 'Custom vendor',
          code: 'async function onTrack(e) { delete e.properties.plan; return e }',
        },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'fn' }],
    }
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'fn')).toBe(STATUS.delivered)
    expect(reasonOf(trace, 'fn')).toMatch(/removed properties\.plan/)
    expect(trace.visited.fn.propagate).toBe(false)
  })

  /* `App -> source function -> destination`: the shape a source function is actually
     drawn in, with the customer's own system outside the Segment zone feeding it. */
  const webhook = () => ({
    nodes: [
      { id: 'app', kind: 'custom', name: 'Vendor webhook' },
      {
        id: 'fn',
        kind: 'source_function',
        name: 'Webhook',
        code: `async function onRequest(request) {
          const body = await request.json();
          Segment.track({ userId: body.userId, event: 'Shipped', properties: { carrier: 'dhl' } });
        }`,
      },
      { id: 'dest', kind: 'destination', name: 'Vendor' },
    ],
    edges: [
      { id: 'e1', source: 'app', target: 'fn' },
      { id: 'e2', source: 'fn', target: 'dest' },
    ],
  })

  it('follows the event a source function emits', () => {
    const trace = simulate(webhook(), TRACK, { sourceId: 'app' })
    expect(statusOf(trace, 'fn')).toBe(STATUS.transformed)
    expect(reasonOf(trace, 'fn')).toMatch(/emitted one track call/)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
    /* The webhook body became a different event, and that is what the destination gets. */
    expect(payloadAt(trace, 'dest')).toMatchObject({
      type: 'track',
      event: 'Shipped',
      properties: { carrier: 'dhl' },
    })
  })

  it('says which of several emitted events the path follows', () => {
    const graph = webhook()
    graph.nodes[1].code = `async function onRequest(request) {
      const body = await request.json();
      Segment.identify({ userId: body.userId, traits: { seen: true } });
      Segment.track({ userId: body.userId, event: 'Shipped' });
    }`
    const trace = simulate(graph, TRACK, { sourceId: 'app' })
    /* A reducer built around one payload cannot walk four events at once, and saying so
       is better than quietly following the first as though it were the only one. */
    expect(reasonOf(trace, 'fn')).toMatch(/emitted 2 calls \(identify, track\)/)
    expect(payloadAt(trace, 'dest').type).toBe('identify')
  })

  it('does not run the code of the component the walkthrough starts at', () => {
    /*
     * Pinned deliberately, because it is a choice rather than an oversight and it would
     * be easy to "fix" into something worse.
     *
     * The origin step is not a verdict -- `simulate` records it without asking `visit`
     * anything, and its own note says a walkthrough that starts somewhere other than a
     * source "traces what happens downstream of it rather than a full event path". That
     * holds for every kind: a destination filter at the origin is not evaluated either.
     * Making functions the exception would mean the origin could drop the event, and a
     * walkthrough whose first step is a dead end is indistinguishable from one that
     * failed to run.
     *
     * The Code tab says this out loud where a path starts at the function, so the
     * behaviour is discoverable rather than a surprise.
     */
    const graph = webhook()
    graph.nodes[1].code = 'async function onRequest() { throw new DropEvent("never runs") }'
    const trace = simulate(graph, TRACK, { sourceId: 'fn' })
    expect(statusOf(trace, 'fn')).toBe(STATUS.origin)
    expect(payloadAt(trace, 'dest')).toEqual(TRACK)
  })

  it('stops a runaway loop instead of hanging the walkthrough', () => {
    /* The tab is holding an unsaved diagram. Nothing in a sidebar may be able to take it
       down, which is why ../functions/prepare.js injects a step budget. */
    const trace = simulate(
      withCode('async function onTrack(e) {\n  while (true) { e.n = 1 }\n  return e\n}'),
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'fn')).toBe(STATUS.notEvaluated)
    expect(reasonOf(trace, 'fn')).toMatch(/Stopped after/)
  })

  /*
   * The checklist, as the walkthrough sees it.
   *
   * The tally rides in the trace so the drawer can say what the Code tab shows, and the two
   * must not be able to disagree -- they run the same code with the same probes.
   */
  describe('a function carrying a checklist', () => {
    const CHECKED = anchor(
      anchor(
        `async function onTrack(event) {
  if (event.properties?.is_test === true) {
    throw new DropEvent('test traffic')
  }
  event.properties.region = 'eu'
  return event
}`,
        3,
        's1',
      ),
      5,
      's2',
    )

    const graph = (event) => {
      const built = chain({ condition: 'type = "page"' })
      built.nodes[1] = {
        ...built.nodes[1],
        code: CHECKED,
        checklist: [
          { id: 's1', label: 'Drops test traffic' },
          { id: 's2', label: 'Stamps the region' },
        ],
      }
      return { built, event }
    }

    it('reports how many steps the event reached', () => {
      const { built } = graph()
      const trace = simulate(built, TRACK, { sourceId: 'src' })
      expect(trace.visited.fn.transform.steps).toEqual({ done: 1, total: 2 })
      expect(reasonOf(trace, 'fn')).toMatch(/1 of 2 checklist steps was reached/)
    })

    it('reports the other branch when the event takes it', () => {
      const { built } = graph()
      const trace = simulate(built, { ...TRACK, properties: { is_test: true } }, { sourceId: 'src' })
      expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
      expect(trace.visited.fn.transform.steps).toEqual({ done: 1, total: 2 })
    })

    it('carries no steps key when the component has no checklist', () => {
      /* Absent rather than zeroed. `0 of 0` in the drawer would read as a failure on a
         component nobody has written a checklist for. */
      const built = chain({ condition: 'type = "page"' })
      built.nodes[1] = { ...built.nodes[1], code: 'async function onTrack(e) { return e }' }
      const trace = simulate(built, TRACK, { sourceId: 'src' })
      expect(trace.visited.fn.transform.steps).toBeUndefined()
      expect(reasonOf(trace, 'fn')).not.toMatch(/checklist/)
    })

    it('keeps the markers from changing what the function does', () => {
      /* The anchors are comments and the probes are injected. If this ever fails, the
         checklist has started altering the thing it measures. */
      const withList = chain({ condition: 'type = "page"' })
      withList.nodes[1] = { ...withList.nodes[1], code: CHECKED }
      const bare = chain({ condition: 'type = "page"' })
      bare.nodes[1] = {
        ...bare.nodes[1],
        code: CHECKED.replace(/\s*\/\/ @step s\d+/g, ''),
      }
      expect(simulate(withList, TRACK, { sourceId: 'src' }).visited.dest.payload).toEqual(
        simulate(bare, TRACK, { sourceId: 'src' }).visited.dest.payload,
      )
    })
  })

  it('gives the same answer twice, so the trace stays memoisable', () => {
    const graph = withCode('async function onTrack(e) { delete e.properties.plan; return e }')
    const first = simulate(graph, TRACK, { sourceId: 'src' })
    const second = simulate(graph, TRACK, { sourceId: 'src' })
    expect(second.visited.dest.payload).toEqual(first.visited.dest.payload)
    expect(second.visited.fn.reason).toBe(first.visited.fn.reason)
  })
})

describe('React Flow node shape', () => {
  it('reads kinds from node.data as well as from a flat node', () => {
    const flat = chain({ condition: 'type = "page"' })
    const nested = {
      nodes: flat.nodes.map(({ id, ...rest }) => ({ id, type: 'segmentNode', data: rest })),
      edges: flat.edges,
    }
    const trace = simulate(nested, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('ignores zone backdrops', () => {
    const graph = chain({ condition: 'type = "page"' })
    graph.nodes.push({ id: 'zone-connections', type: 'zone', data: {} })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(trace.visited['zone-connections']).toBeUndefined()
  })
})

describe('frameAt', () => {
  const trace = simulate(chain(), TRACK, { sourceId: 'src' })

  it('reveals exactly the steps played so far', () => {
    expect(Object.keys(frameAt(trace, 0).nodeStatus)).toEqual(['src'])
    expect(Object.keys(frameAt(trace, 2).nodeStatus)).toEqual(['src', 'fn', 'filter'])
  })

  /* The travelling dot rides the active edge; earlier ones stay lit but static.
     Read at the control destination rather than at the filter: the filter drops, and
     an edge into a dropped node is `dropped`, which would make this pass or fail for
     the wrong reason. */
  it('marks the edge just travelled active and earlier ones travelled', () => {
    const frame = frameAt(trace, 3)
    expect(frame.edgeStatus.e4).toBe('active')
    expect(frame.edgeStatus.e1).toBe('travelled')
    expect(frame.edgeStatus.e3).toBeUndefined()
  })

  /* Red goes on the edge *into* the node where the bad news happened, so the path
     reads as "the event went this way and died here". */
  it('marks the edge into a dropped node as dropped', () => {
    const frame = frameAt(trace, trace.steps.length - 1)
    expect(frame.edgeStatus.e2).toBe('dropped')
    expect(frame.edgeStatus.e3).toBe('dropped')
    expect(frame.edgeStatus.e4).toBe('travelled')
  })

  /* Scrubbing backwards must be a pure projection, not a replay with residue. */
  it('is a pure function of the step index', () => {
    const forward = frameAt(trace, 3)
    frameAt(trace, trace.steps.length - 1)
    expect(frameAt(trace, 3)).toEqual(forward)
  })

  it('clamps out-of-range indices instead of throwing', () => {
    expect(frameAt(trace, -5).index).toBe(-1)
    expect(frameAt(trace, 999).index).toBe(trace.steps.length - 1)
    expect(frameAt(trace, 999).done).toBe(true)
  })

  it('defaults to the finished state', () => {
    expect(frameAt(trace, undefined).index).toBe(trace.steps.length - 1)
  })
})

describe('simulateAt', () => {
  it('returns the trace and the frame together', () => {
    const { trace, frame } = simulateAt(chain(), TRACK, 1, { sourceId: 'src' })
    expect(trace.steps.length).toBeGreaterThan(1)
    expect(frame.index).toBe(1)
  })
})

/*
 * A component reached by more than one route.
 *
 * The bug this pins: the walk used to skip an edge whose target it had already visited, which
 * dropped the *connector* from the trace along with the component. So on any diagram where two
 * things feed one destination -- the commonest shape in Segment there is -- one of the two
 * connectors appeared nowhere and stayed dark for the whole walkthrough, which reads as the
 * event not having taken it.
 */
describe('a component fed by two routes', () => {
  const diamond = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Source' },
      { id: 'left', kind: 'source_insert_function', name: 'Left' },
      { id: 'right', kind: 'source_insert_function', name: 'Right' },
      { id: 'dest', kind: 'destination', name: 'Braze' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'left' },
      { id: 'e2', source: 'src', target: 'right' },
      { id: 'e3', source: 'left', target: 'dest' },
      { id: 'e4', source: 'right', target: 'dest' },
    ],
  })

  const trace = simulate(diamond(), TRACK, { sourceId: 'src' })

  it('lights both connectors into it', () => {
    const frame = frameAtPhase(trace, trace.phases.length - 1)
    expect(frame.edgeStatus.e3).toBeDefined()
    expect(frame.edgeStatus.e4).toBeDefined()
  })

  it('gives it only one verdict', () => {
    /* Recorded twice as a *step* -- the event does travel both connectors -- but once as a
       component, or the results panel would list Braze twice with the same reason. */
    expect(trace.steps.filter((step) => step.nodeId === 'dest')).toHaveLength(2)
    expect(trace.steps.filter((step) => step.nodeId === 'dest' && !step.rejoin)).toHaveLength(1)
  })

  it('does not double-count it in the summary', () => {
    const summary = summarize(trace, diamond())
    expect(summary.rows.filter((row) => row.nodeId === 'dest')).toHaveLength(1)
    expect(summary.delivered).toBe(1)
  })

  it('says why the second connector is there', () => {
    const rejoin = trace.steps.find((step) => step.rejoin)
    expect(rejoin.reason).toContain('more than one route')
  })
})

/*
 * Leaving a component out of a path.
 *
 * The distinction this pins: switching a component off stops the event dead, because that is a
 * claim about the architecture. Leaving one out steps *over* it, because that is a claim about the
 * story the path tells -- and truncating everything downstream of a component the reader merely
 * did not want to talk about would make the feature useless in the middle of a route.
 */
describe('a component left out of the path', () => {
  it('lets the event through to what it feeds', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['fn'] })
    expect(statusOf(trace, 'fn')).toBe(STATUS.bypassed)
    expect(statusOf(trace, 'control')).toBe(STATUS.delivered)
  })

  it('stops the event when switched off instead, which is the opposite claim', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', disabled: ['fn'] })
    expect(statusOf(trace, 'fn')).toBe(STATUS.blocked)
    expect(statusOf(trace, 'control')).not.toBe(STATUS.delivered)
  })

  it('does not evaluate what it does', () => {
    /* The filter drops this event. Left out of the path, it neither drops it nor is reported as
       having passed it -- its condition is simply not a question this path asks. */
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['filter'] })
    expect(statusOf(trace, 'filter')).toBe(STATUS.bypassed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('counts as having arrived, so it is not reported as withheld', () => {
    /* The event did pass through. Counting it as withheld would put a number in the results panel
       that reads as a fault when it was a choice.

       The filter is left out along with the destination, because otherwise it drops the event and
       the destination is never reached at all -- exclusion only means anything where the walk
       actually gets to. */
    expect(hasArrived(STATUS.bypassed)).toBe(true)
    const graph = chain()
    const trace = simulate(graph, TRACK, { sourceId: 'src', excluded: ['filter', 'dest'] })
    const summary = summarize(trace, graph)
    expect(statusOf(trace, 'dest')).toBe(STATUS.bypassed)
    expect(summary.withheld).toBe(0)
    /* Bypassed is not delivered either, so only the control destination is counted. */
    expect(summary.delivered).toBe(1)
  })

  it('is not applied to a component the walk never reaches', () => {
    /* The filter drops the event, so the destination past it is blocked rather than stepped over.
       Leaving something out cannot conjure a route to it. */
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['dest'] })
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
  })

  it('says why, in terms of the path rather than the architecture', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['fn'] })
    expect(reasonOf(trace, 'fn')).toContain('left out of this path')
  })

  it('steps over a run of them', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['fn', 'filter'] })
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('leaves the start alone, which has no verdict to bypass', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src', excluded: ['src'] })
    expect(statusOf(trace, 'src')).toBe(STATUS.origin)
  })
})

describe('waves', () => {
  it('puts both arms of a fork in one wave', () => {
    /* The whole reason waves exist. `fn` feeds the filter and the control destination, and
       stepping through those one at a time claimed the event went to one before the other. */
    const trace = simulate(chain(), TRACK, { sourceId: 'src' })
    const forked = trace.waves[2].map((index) => trace.steps[index].nodeId)
    expect(forked.sort()).toEqual(['control', 'filter'])
  })

  it('starts with the origin alone', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src' })
    expect(trace.waves[0].map((index) => trace.steps[index].nodeId)).toEqual(['src'])
  })

  it('accounts for every step exactly once', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src' })
    expect(trace.waves.flat().sort((a, b) => a - b)).toEqual(
      trace.steps.map((step) => step.index),
    )
  })

  it('puts the footnotes after the run rather than at the start', () => {
    /* A tracking plan nothing connects to gets a verdict from pass three. It has no depth, so
       grouping by depth would have played it on the first tick alongside the origin. */
    const graph = chain()
    graph.nodes.push({ id: 'plan', kind: 'tracking_plan', name: 'Plan' })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    const wave = trace.steps.find((step) => step.nodeId === 'plan').wave
    expect(wave).toBe(trace.waves.length - 1)
    expect(wave).toBeGreaterThan(0)
  })
})

/*
 * Beats.
 *
 * A wave is two of them -- travelling along its connectors, then arriving at its components -- and
 * the reason is the animation: exactly one thing may glow at a time, so the canvas can light where
 * the event *is* rather than everywhere it has been.
 */
describe('phasesOf', () => {
  const trace = simulate(chain(), TRACK, { sourceId: 'src' })

  it('splits each wave into travelling and arriving', () => {
    /* Wave 0 is the origin, which arrives from nowhere -- so no edge beat leads it. */
    expect(trace.phases.slice(0, 3)).toEqual([
      { kind: 'node', wave: 0 },
      { kind: 'edge', wave: 1 },
      { kind: 'node', wave: 1 },
    ])
  })

  it('gives the origin no connector beat', () => {
    expect(trace.phases[0]).toEqual({ kind: 'node', wave: 0 })
  })

  it('skips a connector beat for a wave with no connectors', () => {
    /* The footnote wave -- components nothing on the path reaches -- has no route to them, so a beat
       spent travelling to them would be a second of stillness. */
    const graph = chain()
    graph.nodes.push({ id: 'plan', kind: 'tracking_plan', name: 'Plan' })
    const withFootnotes = simulate(graph, TRACK, { sourceId: 'src' })
    const footnoteWave = withFootnotes.steps.find((step) => step.nodeId === 'plan').wave
    const beats = withFootnotes.phases.filter((beat) => beat.wave === footnoteWave)
    expect(beats).toEqual([{ kind: 'node', wave: footnoteWave }])
  })

  it('is empty for a trace with nothing in it', () => {
    expect(simulate({ nodes: [], edges: [] }, TRACK).phases ?? []).toEqual([])
  })
})

describe('frameAtPhase', () => {
  const trace = simulate(chain(), TRACK, { sourceId: 'src' })
  /* Beat index of the node beat for a given wave, so the assertions below read in terms of what is
     happening rather than in terms of arithmetic on the phase list. */
  const nodeBeat = (wave) => trace.phases.findIndex((b) => b.kind === 'node' && b.wave === wave)
  const edgeBeat = (wave) => trace.phases.findIndex((b) => b.kind === 'edge' && b.wave === wave)

  it('reveals components only once their arriving beat has played', () => {
    expect(Object.keys(frameAtPhase(trace, nodeBeat(0)).nodeStatus)).toEqual(['src'])
    expect(Object.keys(frameAtPhase(trace, nodeBeat(1)).nodeStatus).sort()).toEqual(['fn', 'src'])
  })

  it('lights the connector without lighting what it feeds', () => {
    /* The point of splitting the beat: on the travelling beat the line glows and the component at
       its far end is still dark, because the event has not got there yet. */
    const frame = frameAtPhase(trace, edgeBeat(1))
    expect(frame.edgeStatus.e1).toBe('active')
    expect(frame.nodeStatus.fn).toBeUndefined()
  })

  it('drops the connector to travelled once the event arrives', () => {
    const frame = frameAtPhase(trace, nodeBeat(1))
    expect(frame.edgeStatus.e1).toBe('travelled')
    expect(frame.nodeStatus.fn).toBeDefined()
  })

  it('has nothing active but the connectors during a travelling beat', () => {
    /* Which is what lets the canvas glow in exactly one place. */
    const frame = frameAtPhase(trace, edgeBeat(2))
    expect(frame.current).toEqual([])
    expect(frame.kind).toBe('edge')
    expect(Object.values(frame.edgeStatus).filter((s) => s === 'active').length).toBeGreaterThan(0)
  })

  it('marks every connector of a fork active together', () => {
    const frame = frameAtPhase(trace, edgeBeat(2))
    expect(frame.edgeStatus.e4).toBe('active')
    expect(frame.edgeStatus.e1).toBe('travelled')
  })

  it('reports every component in flight, not one', () => {
    const frame = frameAtPhase(trace, nodeBeat(2))
    expect(frame.current.map((step) => step.nodeId).sort()).toEqual(['control', 'filter'])
    expect(frame.leading).toBe(frame.current[0])
  })

  it('still marks the connector into a dropped component as dropped', () => {
    const frame = frameAtPhase(trace, trace.phases.length - 1)
    expect(frame.edgeStatus.e2).toBe('dropped')
    expect(frame.edgeStatus.e4).toBe('travelled')
  })

  it('remembers the last arrival across a travelling beat', () => {
    /* `current` empties mid-hop, which is what shuts the tooltips and moves the glow onto the line.
       Anything describing the payload has to keep saying something across that gap or it blinks out
       and back once per connector, so the frame carries the last arrival separately. */
    const landed = frameAtPhase(trace, nodeBeat(1))
    const moving = frameAtPhase(trace, edgeBeat(2))
    expect(moving.current).toEqual([])
    expect(moving.arrived.map((step) => step.nodeId)).toEqual(
      landed.arrived.map((step) => step.nodeId),
    )
  })

  it('has the arrival and the current position agree on an arriving beat', () => {
    const frame = frameAtPhase(trace, nodeBeat(2))
    expect(frame.arrived).toEqual(frame.current)
  })

  it('has no arrival before anything has landed', () => {
    expect(frameAtPhase(trace, -1).arrived).toEqual([])
  })

  it('is a pure function of the beat', () => {
    const forward = frameAtPhase(trace, 1)
    frameAtPhase(trace, trace.phases.length - 1)
    expect(frameAtPhase(trace, 1)).toEqual(forward)
  })

  it('clamps out of range and defaults to finished', () => {
    expect(frameAtPhase(trace, -5).index).toBe(-1)
    expect(frameAtPhase(trace, 999).index).toBe(trace.phases.length - 1)
    expect(frameAtPhase(trace, 999).done).toBe(true)
    expect(frameAtPhase(trace, undefined).index).toBe(trace.phases.length - 1)
  })

  it('is an empty frame for a trace with nothing in it', () => {
    const empty = simulate({ nodes: [], edges: [] }, TRACK)
    expect(frameAtPhase(empty, 0).current).toEqual([])
    expect(frameAtPhase(empty, 0).total).toBe(0)
  })
})

describe('summarize', () => {
  const graph = chain()
  const trace = simulate(graph, TRACK, { sourceId: 'src' })
  const summary = summarize(trace, graph)

  it('counts delivered and withheld terminals', () => {
    expect(summary.delivered).toBe(1)
    expect(summary.withheld).toBe(1)
  })

  it('names the event', () => {
    expect(summary.eventName).toBe('Order Completed')
  })

  /* Worst news first: someone opens the results panel because something is
     missing, not to admire what worked. */
  it('sorts the worst outcome to the top', () => {
    expect(summary.rows[0].status).toBe(STATUS.dropped)
  })

  it('includes every visited node with a reason', () => {
    /* One row per *component*, which is one step per component except for a rejoin -- a second
       connector into something already accounted for carries no new verdict. This fixture has
       none, but stating it as `steps.length` would make the test pass here for a reason that
       stops being true the moment a diagram fans in. */
    expect(summary.rows).toHaveLength(trace.steps.filter((step) => !step.rejoin).length)
    expect(summary.rows.every((row) => Boolean(row.reason))).toBe(true)
  })
})

describe('a path that begins outside Segment', () => {
  /*
   * The commonest shape of a real diagram: the customer's own app or warehouse sits in
   * a region outside the Segment zone and hands events in. Both of these were broken
   * until the connector allowlist went, because there was no way to draw the edge --
   * and then still broken, because the reducer had rules written on the assumption
   * that the only thing upstream of a source was another source.
   */
  const outside = () => ({
    nodes: [
      { id: 'app', kind: 'custom', name: 'Their app', zone: 'custom:upstream' },
      { id: 'src', kind: 'source', name: 'Web source', zone: 'sources' },
      { id: 'dest', kind: 'destination', name: 'Braze', zone: 'destinations' },
    ],
    edges: [
      { id: 'e1', source: 'app', target: 'src' },
      { id: 'e2', source: 'src', target: 'dest' },
    ],
  })

  it('flows from a custom component into the source and on to the destination', () => {
    const trace = simulate(outside(), TRACK, { sourceId: 'app' })
    expect(trace.steps.map((step) => step.nodeId)).toEqual(['app', 'src', 'dest'])
    expect(statusOf(trace, 'src')).toBe(STATUS.passed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('does not claim Segment validated an event it never saw', () => {
    /* The origin sentence used to say "Segment validates it against the source schema"
       whatever the origin was, which invents a stage that does not exist when the
       walkthrough starts at the customer's own app. */
    const trace = simulate(outside(), TRACK, { sourceId: 'app' })
    expect(reasonOf(trace, 'app')).toMatch(/not a source/)
    expect(reasonOf(trace, 'app')).not.toMatch(/source schema/)
  })

  it('still says what a source origin does, when the origin is one', () => {
    const trace = simulate(outside(), TRACK, { sourceId: 'src' })
    expect(reasonOf(trace, 'src')).toMatch(/source schema/)
  })

  it('says the source is where the event entered rather than blocking it', () => {
    const trace = simulate(outside(), TRACK, { sourceId: 'app' })
    expect(reasonOf(trace, 'src')).toMatch(/Collected by/)
  })

  it('reads source -> source as the same source drawn twice, not a second collection', () => {
    /*
     * This used to assert `blocked`, on the reasoning that an event is collected once and a second
     * collection is not a thing Segment does. Right about the product, wrong about the drawing -- and
     * the shipped `end-to-end-full-pipeline` template is where that showed. A source in Connections is
     * *also* a Profile Source in Unify; those are different ideas, so the template draws the source
     * twice and joins the two copies. The edge never claimed data flows from one source into another.
     *
     * Enforcing the plumbing over the concept cost that template its entire Unify and Engage half:
     * Profile, Audience, Computed Trait and Journey all reported as never reached, from one edge that
     * was a drawing convention. So the walk carries on, and the sentence says which of the two things
     * the edge is -- the honesty is in the wording, not in a dead end.
     */
    const graph = outside()
    graph.nodes.push({ id: 'src2', kind: 'source', name: 'Second source' })
    graph.edges.push({ id: 'e3', source: 'src', target: 'src2' })
    const trace = simulate(graph, TRACK, { sourceId: 'app' })
    expect(statusOf(trace, 'src2')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'src2')).toMatch(/same source shown again/)
    expect(reasonOf(trace, 'src2')).toMatch(/No second collection/)
  })

  it('routes a custom component mid-path, not only as the origin', () => {
    const graph = outside()
    graph.nodes.push({ id: 'queue', kind: 'custom', name: 'Their queue' })
    graph.edges = [
      { id: 'e1', source: 'app', target: 'queue' },
      { id: 'e2', source: 'queue', target: 'src' },
      { id: 'e3', source: 'src', target: 'dest' },
    ]
    const trace = simulate(graph, TRACK, { sourceId: 'app' })
    expect(trace.steps.map((step) => step.nodeId)).toEqual(['app', 'queue', 'src', 'dest'])
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })
})

/*
 * A tracking plan drawn *on* the path.
 *
 * It used to be `notApplicable` and stop the walk dead -- factually defensible (a plan is a list;
 * enforcement is the source's schema controls) and the wrong call for a diagram. Someone who draws
 * `app -> plan -> source` has drawn the question "does this event get in?", and the most interesting
 * component on the canvas was answering it with a greyed box.
 *
 * What these pin is the line between "reports a verdict" and "invents authority it does not have".
 */
describe('a tracking plan on the path', () => {
  const planned = (planData = {}, event = TRACK) => {
    const graph = {
      nodes: [
        { id: 'app', kind: 'custom', name: 'Mobile app' },
        { id: 'plan', kind: 'tracking_plan', name: 'Core plan', ...planData },
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'dest', kind: 'destination', name: 'Braze', sourceId: 'S1' },
      ],
      edges: [
        { id: 'e1', source: 'app', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'src' },
        { id: 'e3', source: 'src', target: 'dest' },
      ],
    }
    return simulate(graph, event, { sourceId: 'app' })
  }

  it('lets the event travel through it and on to the source', () => {
    /* The whole point. The plan is a stage now, so everything downstream of it gets a verdict
       instead of sitting grey behind a component that refused to propagate. */
    const trace = planned({ plannedEvents: ['Order Completed'] })
    expect(hasArrived(statusOf(trace, 'plan'))).toBe(true)
    expect(hasArrived(statusOf(trace, 'src'))).toBe(true)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  it('says the event is planned when the plan lists it', () => {
    const trace = planned({ plannedEvents: ['Order Completed'] })
    expect(statusOf(trace, 'plan')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'plan')).toMatch(/planned event/i)
  })

  it('checks only the name, and says so', () => {
    /* The API returns a plan's event names, not its rules. Claiming the properties validate would be
       inventing a verdict the data cannot support. */
    expect(reasonOf(planned({ plannedEvents: ['Order Completed'] }), 'plan')).toMatch(
      /only the name is checked/i,
    )
  })

  it('reads an event list under any of the three spellings', () => {
    /* A plan reaches this diagram three ways -- read from the API, seeded by a template, or typed
       into the inspector -- and the walkthrough must not depend on which. */
    for (const key of ['plannedEvents', 'events', 'rules']) {
      const trace = planned({ [key]: ['Order Completed'] })
      expect(reasonOf(trace, 'plan'), key).toMatch(/planned event/i)
    }
  })

  it('blocks an unplanned event when the plan records that policy', () => {
    const trace = planned({ plannedEvents: ['Something Else'], unplanned: 'block' })
    expect(statusOf(trace, 'plan')).toBe(STATUS.dropped)
    /* And nothing downstream is claimed to have received it -- which is the visualisation the
       request was asking for. */
    expect(hasArrived(statusOf(trace, 'src'))).toBe(false)
    expect(statusOf(trace, 'dest')).not.toBe(STATUS.delivered)
  })

  it('honours allow and omit as well', () => {
    const allowed = planned({ plannedEvents: ['Other'], unplanned: 'allow' })
    expect(statusOf(allowed, 'plan')).toBe(STATUS.passed)
    expect(reasonOf(allowed, 'plan')).toMatch(/violation/i)

    const omitted = planned({ plannedEvents: ['Other'], unplanned: 'omit' })
    expect(statusOf(omitted, 'plan')).toBe(STATUS.transformed)
    expect(hasArrived(statusOf(omitted, 'src'))).toBe(true)
  })

  it('passes an unplanned event on when no policy is recorded, and says where enforcement lives', () => {
    /* Deliberately different from `source_schema_control`'s equivalent branch, which refuses to
       guess. A *source* with no recorded policy genuinely might block, so claiming anything past it
       would be a guess. A plan has no enforcement of its own, so "it carries on and the source
       decides" is not a guess -- it is what happens. */
    const trace = planned({ plannedEvents: ['Something Else'] })
    expect(statusOf(trace, 'plan')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'plan')).toMatch(/unplanned event/i)
    expect(reasonOf(trace, 'plan')).toMatch(/schema controls/)
    expect(hasArrived(statusOf(trace, 'src'))).toBe(true)
  })

  it('does not treat an empty plan as evidence the event is unplanned', () => {
    /* A plan with no events on the diagram is a placeholder. Reading it as "this event is not in the
       plan" would make every template's blank plan flag a violation. */
    const trace = planned({})
    expect(statusOf(trace, 'plan')).toBe(STATUS.passed)
    expect(reasonOf(trace, 'plan')).toMatch(/no event list/i)
    expect(reasonOf(trace, 'plan')).not.toMatch(/violation/i)
  })

  it('names the plan when the node records one', () => {
    expect(
      reasonOf(planned({ trackingPlan: 'Checkout v2', plannedEvents: ['Order Completed'] }), 'plan'),
    ).toMatch(/Checkout v2/)
  })

  it('still accounts for an unconnected plan without claiming the event reached it', () => {
    /* The case the old behaviour was right about, kept. Pass three calls `visit` with no `from`, and
       reporting `passed` there would say the event went through a component it never touched. */
    const trace = simulate(
      {
        nodes: [
          { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
          { id: 'plan', kind: 'tracking_plan', name: 'Core plan', plannedEvents: ['Order Completed'] },
        ],
        edges: [],
      },
      TRACK,
      { sourceId: 'src' },
    )
    expect(statusOf(trace, 'plan')).toBe(STATUS.notApplicable)
    expect(hasArrived(statusOf(trace, 'plan'))).toBe(false)
    expect(reasonOf(trace, 'plan')).toMatch(/schema controls/)
  })
})

/*
 * Past a destination, when the diagram says the data goes further.
 *
 * A destination is the end of Segment's story and not necessarily the end of the customer's. One real
 * diagram runs five more components past Adobe Analytics -- an Adobe formatting step, an AEP HTTP
 * endpoint, an AEP dataset, a CJA connection, the CJA report -- all drawn deliberately, and the
 * walkthrough used to report every one of them as never reached. The diagram asserted the data goes
 * there; the tool contradicted it.
 *
 * So an outgoing connector is taken at its word. The care needed is in *not* taking every other reason
 * to stop at its word too, which is what most of these tests are about.
 */
describe('a destination that feeds something further on', () => {
  const beyond = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'dest', kind: 'destination', name: 'Adobe Analytics' },
      { id: 'fmt', kind: 'destination_insert_function', name: 'Adds AA formatting' },
      { id: 'aep', kind: 'source', name: 'AEP HTTP endpoint' },
      { id: 'cja', kind: 'custom', name: 'CJA reports' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'dest' },
      { id: 'e2', source: 'dest', target: 'fmt' },
      { id: 'e3', source: 'fmt', target: 'aep' },
      { id: 'e4', source: 'aep', target: 'cja' },
    ],
  })

  it('carries the event on to everything drawn past it', () => {
    const trace = simulate(beyond(), TRACK, { sourceId: 'src' })
    for (const id of ['fmt', 'aep', 'cja']) {
      expect(hasArrived(statusOf(trace, id)), id).toBe(true)
    }
  })

  it('still reads as delivered, because it is', () => {
    /* The change is about where the walk stops, not about what happened at the destination. Turning
       this into `passed` would lose the delivery from the results panel's count. */
    expect(statusOf(simulate(beyond(), TRACK, { sourceId: 'src' }), 'dest')).toBe(STATUS.delivered)
  })

  it('says which claim it is making, rather than leaving it implicit', () => {
    /* "Delivered to Adobe Analytics", followed by the event turning up three components later, reads
       as the simulator not knowing what a destination is unless it explains itself. */
    expect(reasonOf(simulate(beyond(), TRACK, { sourceId: 'src' }), 'dest')).toMatch(
      /carries on past|your architecture/i,
    )
  })

  it('leaves a destination with nothing after it terminal', () => {
    const leaf = {
      nodes: [
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'dest', kind: 'destination', name: 'Braze' },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'dest' }],
    }
    const trace = simulate(leaf, TRACK, { sourceId: 'src' })
    expect(trace.visited.dest.propagate).toBe(false)
    expect(reasonOf(trace, 'dest')).not.toMatch(/carries on past/i)
  })

  /*
   * The tests that keep this honest. Every other reason to stop has to survive it, or "the event never
   * reaches X" stops meaning anything.
   */
  it('does not carry on past a destination wired to a different source', () => {
    const graph = beyond()
    graph.nodes.find((node) => node.id === 'dest').sourceId = 'OTHER'
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
    expect(hasArrived(statusOf(trace, 'fmt'))).toBe(false)
  })

  it('does not carry on past a component that dropped the event', () => {
    const graph = beyond()
    graph.nodes.splice(1, 0, { id: 'fn', kind: 'source_insert_function', name: 'Enrich' })
    graph.edges = [
      { id: 'a', source: 'src', target: 'fn' },
      { id: 'b', source: 'fn', target: 'dest' },
    ]
    const trace = simulate(graph, TRACK, { sourceId: 'src', functionBehaviour: { fn: 'drop' } })
    expect(hasArrived(statusOf(trace, 'dest'))).toBe(false)
  })

  it('does not carry on past a switched-off destination', () => {
    const trace = simulate(beyond(), TRACK, { sourceId: 'src', disabled: ['dest'] })
    expect(hasArrived(statusOf(trace, 'dest'))).toBe(false)
    expect(hasArrived(statusOf(trace, 'fmt'))).toBe(false)
  })

  it('records the effective answer, so pass two does not contradict it', () => {
    /* Pass two records "the event never got here" one hop past anything that did not propagate. If
       the destination's stored `propagate` still said false while the walk went on through it, the
       same connector would carry both an arrival and a never-reached verdict. */
    const trace = simulate(beyond(), TRACK, { sourceId: 'src' })
    expect(trace.visited.dest.propagate).toBe(true)
    expect(trace.steps.filter((step) => step.nodeId === 'fmt')).toHaveLength(1)
  })
})

/*
 * Which tick each step plays on, and the order a path takes its forks in.
 *
 * `wave` and `depth` used to be the same number, written as `depth + 1` while the walk ran. That is
 * correct for a plain breadth-first reading and wrong the moment a path wants one arm of a fork before
 * the other, so they are now decided separately -- `depth` by the walk, `wave` by `scheduleWaves`.
 *
 * The first test is the one that matters. Every diagram and every saved path in existence has no fork
 * order on it, so the change has to be *inert*: unsequenced, the schedule must reproduce exactly what
 * the walk used to write. Since that was `depth + 1` on a step whose own depth is `depth + 1`, the
 * invariant is simply `wave === depth` -- which checks every shape at once, and would catch a
 * scheduler that got any of them subtly wrong.
 */
describe('scheduling the ticks', () => {
  const waveOf = (trace, id) => trace.steps.find((step) => step.nodeId === id && !step.rejoin)?.wave

  /* A fork whose arms are different depths, so sequencing has something to shift. */
  const forked = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'long1', kind: 'source_insert_function', name: 'Long one' },
      { id: 'long2', kind: 'destination', name: 'Long two' },
      { id: 'short', kind: 'destination', name: 'Short arm' },
    ],
    edges: [
      { id: 'a', source: 'src', target: 'long1' },
      { id: 'b', source: 'long1', target: 'long2' },
      { id: 'c', source: 'src', target: 'short' },
    ],
  })

  describe('with no fork order set', () => {
    /* The regression guard for every path that already exists. */
    it.each([
      ['a chain with a fork and a filter', chain()],
      ['a fork with arms of different lengths', forked()],
      [
        'a diamond, so a rejoin is in the trace',
        {
          nodes: [
            { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
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
        },
      ],
    ])('plays %s exactly as breadth-first did', (_label, graph) => {
      const trace = simulate(graph, TRACK, { sourceId: 'src' })
      /* Pass-one steps only: passes two and three schedule themselves relative to what stopped and to
         the end of the run, and never had a depth to speak of. */
      const walked = trace.steps.filter((step) => step.status !== STATUS.blocked || step.propagate)
      for (const step of walked) {
        expect(step.wave, `${step.nodeId}${step.rejoin ? ' (rejoin)' : ''}`).toBe(step.depth)
      }
    })

    it('puts both arms of a fork on one tick', () => {
      const trace = simulate(forked(), TRACK, { sourceId: 'src' })
      expect(waveOf(trace, 'long1')).toBe(waveOf(trace, 'short'))
    })
  })

  describe('with a fork ordered one arm at a time', () => {
    const run = (order) =>
      simulate(forked(), TRACK, { sourceId: 'src', branches: { src: order } })

    it('takes the arms in the order given', () => {
      const first = run(['short', 'long1'])
      expect(waveOf(first, 'short')).toBeLessThan(waveOf(first, 'long1'))

      const other = run(['long1', 'short'])
      expect(waveOf(other, 'long1')).toBeLessThan(waveOf(other, 'short'))
    })

    /*
     * The property that makes a sequence readable. Staggering only the arms themselves would put the
     * second arm *between* the first arm and its own continuation, so the event would alternate
     * between two branches a row at a time -- which reads as a fault, not as an order.
     */
    it('finishes an arm’s whole subtree before starting the next', () => {
      const trace = run(['long1', 'short'])
      expect(waveOf(trace, 'long2')).toBeLessThan(waveOf(trace, 'short'))
    })

    it('gives the run more ticks than playing them together', () => {
      const together = simulate(forked(), TRACK, { sourceId: 'src' })
      expect(run(['long1', 'short']).phases.length).toBeGreaterThan(together.phases.length)
    })

    /* `phasesOf` and everything downstream of it read `wave` and nothing else, so a sequenced fork
       animates as two hops with one event rather than one hop with two -- with no change to any of
       them. This is what makes the whole approach worth it. */
    it('still gives every tick something to do', () => {
      const trace = run(['long1', 'short'])
      for (const [wave, indices] of trace.waves.entries()) {
        if (wave >= trace.waves.length) continue
        expect(indices.length, `wave ${wave} is empty`).toBeGreaterThan(0)
      }
    })

    it('leaves an arm the order has never heard of at the end rather than dropping it', () => {
      /* A connector drawn after the order was saved. */
      const trace = run(['short'])
      expect(waveOf(trace, 'long1')).toBeGreaterThan(waveOf(trace, 'short'))
    })

    it('ignores an order naming a component that is no longer a child', () => {
      const trace = run(['deleted', 'short', 'long1'])
      expect(waveOf(trace, 'short')).toBeLessThan(waveOf(trace, 'long1'))
    })
  })

  describe('a component reached by two routes', () => {
    const diamond = (branches) =>
      simulate(
        {
          nodes: [
            { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
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
        },
        TRACK,
        { sourceId: 'src', ...(branches ? { branches } : {}) },
      )

    it('gets one verdict however the arms are ordered', () => {
      const trace = diamond({ src: ['b', 'a'] })
      expect(trace.steps.filter((step) => step.nodeId === 'dest' && !step.rejoin)).toHaveLength(1)
    })

    /* The second connector still lights up, and on the tick the branch carrying it gets there --
       a wave after the component it leaves, exactly like any other hop. */
    it('travels the second connector one tick after the component it leaves', () => {
      const trace = diamond()
      const rejoin = trace.steps.find((step) => step.rejoin)
      const parent = trace.steps.find((step) => step.nodeId === rejoin.fromId && !step.rejoin)
      expect(rejoin.wave).toBe(parent.wave + 1)
    })

    it('still reaches the shared component when the arms are sequenced', () => {
      expect(hasArrived(statusOf(diamond({ src: ['b', 'a'] }), 'dest'))).toBe(true)
    })
  })
})

/*
 * Beats with nothing in them.
 *
 * `phasesOf` splits each wave into travelling and arriving, and skips either where the wave has nothing
 * for it to show -- a beat with nothing in it is a second of stillness the reader sits through for no
 * reason. The rejoin case below was invisible until fork order existed: a rejoin always used to share
 * its wave with a real arrival, so the missing guard never showed. Sequencing a fork puts it on a wave
 * of its own, and every such run ended on a dead second.
 */
describe('the beats a wave is worth', () => {
  const diamond = (branches) =>
    simulate(
      {
        nodes: [
          { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
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
      },
      TRACK,
      { sourceId: 'src', ...(branches ? { branches } : {}) },
    )

  it('gives the origin no travelling beat, because it arrives from nowhere', () => {
    const trace = simulate(chain(), TRACK, { sourceId: 'src' })
    expect(trace.phases.filter((beat) => beat.wave === 0)).toEqual([{ kind: 'node', wave: 0 }])
  })

  /* A rejoin travels a connector and reaches nothing new: the component at the far end already has its
     verdict from the route that got there first. */
  it('gives a wave of nothing but rejoins no arriving beat', () => {
    const trace = diamond({ src: ['a', 'b'] })
    const rejoin = trace.steps.find((step) => step.rejoin)
    const alone = (trace.waves[rejoin.wave] ?? []).every((index) => trace.steps[index].rejoin)
    expect(alone, 'fixture no longer isolates the rejoin').toBe(true)

    const beats = trace.phases.filter((beat) => beat.wave === rejoin.wave)
    expect(beats).toEqual([{ kind: 'edge', wave: rejoin.wave }])
  })

  it('leaves no beat at the end of a sequenced run with nothing to show', () => {
    const trace = diamond({ src: ['a', 'b'] })
    const last = trace.phases.at(-1)
    const shown = (trace.waves[last.wave] ?? []).filter((index) =>
      last.kind === 'edge' ? trace.steps[index].edgeId : !trace.steps[index].rejoin,
    )
    expect(shown.length).toBeGreaterThan(0)
  })

  it('keeps the arriving beat where a rejoin shares its wave with a real arrival', () => {
    /* Played together, which is the case that always worked -- pinned so the guard above cannot be
       tightened into dropping a beat that is needed. */
    const trace = diamond()
    const rejoin = trace.steps.find((step) => step.rejoin)
    expect(trace.phases.filter((beat) => beat.wave === rejoin.wave)).toEqual([
      { kind: 'edge', wave: rejoin.wave },
      { kind: 'node', wave: rejoin.wave },
    ])
  })
})

/*
 * Components a path stops at twice.
 *
 * The default is once and the second arrival is a `rejoin` -- a connector that lights up while the
 * component keeps the one verdict it already had. That is right for two routes converging on one
 * destination, and wrong for an architecture that genuinely doubles back: the real case is an insert
 * function that consults a tracking plan and carries on with the answer, where the return leg had no
 * verdict, no card, and -- because a rejoin owns no subtree -- nothing downstream of it either.
 *
 * Two properties carry the whole feature, and they pull against each other:
 *
 *   inertness    a path that has not named anything must walk exactly as it did before. Every saved
 *                path is in that category, so this is the guard that matters most, and it is held by
 *                `wave === depth` in the block above rather than restated here.
 *   termination  a component may be stopped at `STOPS_PER_NODE` times and no more, which is what stops
 *                a cycle in the diagram from spinning the walk. `scheduleWaves` is the half of this
 *                most likely to be got wrong: it groups children by parent *step*, and a version keyed
 *                by parent *component* pools both stops' children and recurses for ever.
 */
describe('a component the path stops at twice', () => {
  /* fn -> plan -> fn, plus fn -> dest. The shape of the real diagram this was built for. */
  const roundTrip = () => ({
    nodes: [
      { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
      { id: 'fn', kind: 'destination_insert_function', name: 'Insert fn' },
      { id: 'plan', kind: 'tracking_plan', name: 'Actions plan' },
      { id: 'dest', kind: 'destination', name: 'Adobe' },
    ],
    edges: [
      { id: 'sf', source: 'src', target: 'fn' },
      { id: 'fp', source: 'fn', target: 'plan' },
      { id: 'pf', source: 'plan', target: 'fn' },
      { id: 'fd', source: 'fn', target: 'dest' },
    ],
  })

  const stopsAt = (trace, id) => trace.steps.filter((step) => step.nodeId === id && !step.rejoin)

  it('records the return leg as a connector when nothing is named', () => {
    /* The behaviour every existing path has. The event goes out to the plan and comes back, and the
       coming back is a line lighting up rather than a second verdict. */
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src' })
    expect(stopsAt(trace, 'fn')).toHaveLength(1)

    const rejoin = trace.steps.find((step) => step.rejoin)
    expect(rejoin.nodeId).toBe('fn')
    expect(rejoin.reason).toContain('more than one route')
  })

  it('records it as a second stop when the path asks for one', () => {
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    const both = stopsAt(trace, 'fn')
    expect(both).toHaveLength(2)
    expect(both[0].revisit).toBeUndefined()
    expect(both[1].revisit).toBe(true)
    /* No rejoin left for it: the arrival that used to be flattened into one is now the stop above. */
    expect(trace.steps.filter((step) => step.rejoin && step.nodeId === 'fn')).toHaveLength(0)
  })

  it('says which pass the reader is looking at', () => {
    /* The clause is written by the reducer and not by the narrator, because `describeStep` quotes
       `reason` verbatim -- so a second card with the first card's sentence on it would read as the
       walkthrough having lost its place. */
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    const second = stopsAt(trace, 'fn')[1]
    expect(second.reason).toContain('comes back through')
    expect(second.reason).toContain('a second time on this path')
  })

  it('plays the second stop after the leg that brought the event back', () => {
    /* The ordering the reader asked for: out to the plan, then back. A rejoin is scheduled the same
       way, so what this pins is that promoting one to a stop did not move it. */
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    const plan = trace.steps.find((step) => step.nodeId === 'plan' && !step.rejoin)
    expect(stopsAt(trace, 'fn')[1].wave).toBeGreaterThan(plan.wave)
  })

  it('still records every connector out of the second stop', () => {
    /* A second stop's outgoing connectors lead back to components already visited, so they are
       rejoins -- but they have to be *there*. Dropping them is the bug that made a line on the canvas
       never light up, which is what the rejoin was introduced to fix in the first place. */
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    const second = stopsAt(trace, 'fn')[1]
    const out = trace.steps.filter((step) => step.fromIndex === second.index)
    expect(out.map((step) => step.nodeId).sort()).toEqual(['dest', 'plan'])
    expect(out.every((step) => step.rejoin)).toBe(true)
  })

  it('re-evaluates rather than repeating the first verdict', () => {
    /* The point of running `visit` again: the payload has moved on between the two passes, so a
       function with code on it acts on what it is given now. Carrying the first verdict forward would
       make the second pass a decoration. */
    const counting = roundTrip()
    counting.nodes[1] = {
      ...counting.nodes[1],
      code: 'async function onTrack(e) { e.properties.passes = (e.properties.passes ?? 0) + 1; return e }',
    }

    const trace = simulate(counting, TRACK, { sourceId: 'src', revisit: ['fn'] })
    const [first, second] = stopsAt(trace, 'fn')
    expect(first.payload.properties.passes).toBe(1)
    expect(second.payload.properties.passes).toBe(2)
  })

  it('stops at two and does not spin on a cycle', () => {
    /* Termination, on the shape that would expose its absence: a 2-cycle with both ends named. Bounded
       rather than merely finished, because a scheduler keyed by component recurses here instead of
       returning, and a test that only checked the output would hang rather than fail. */
    const cycle = {
      nodes: [
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'a', kind: 'destination_insert_function', name: 'A' },
        { id: 'b', kind: 'destination_insert_function', name: 'B' },
      ],
      edges: [
        { id: 'sa', source: 'src', target: 'a' },
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'ba', source: 'b', target: 'a' },
      ],
    }

    const trace = simulate(cycle, TRACK, { sourceId: 'src', revisit: ['a', 'b'] })
    expect(stopsAt(trace, 'a')).toHaveLength(2)
    expect(stopsAt(trace, 'b')).toHaveLength(2)
    expect(trace.steps.length).toBeLessThan(10)
  })

  it('keeps one row per component in the results panel', () => {
    /* `summarize` is a list of components rather than of arrivals, so two stops are one row -- which
       is why `visited` goes on holding the first stop per component. The relationship it used to have
       with the step count ("one row per non-rejoin step") is what stops being true here. */
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    const summary = summarize(trace, roundTrip())
    expect(summary.rows.filter((row) => row.nodeId === 'fn')).toHaveLength(1)
    expect(summary.rows.length).toBeLessThan(
      trace.steps.filter((step) => !step.rejoin).length,
    )
  })

  it('lets a fork order put the return leg before the arm that carries on', () => {
    /* The two features together, which is what the diagram this was built for actually needs: the
       event goes out to the plan and back *before* the destination's other arm is taken, so the story
       is told one leg at a time rather than as a fan-out. */
    const trace = simulate(roundTrip(), TRACK, {
      sourceId: 'src',
      revisit: ['fn'],
      branches: { fn: ['plan', 'dest'] },
    })

    const waveOfNode = (id) => trace.steps.find((s) => s.nodeId === id && !s.rejoin).wave
    const second = stopsAt(trace, 'fn')[1]
    expect(waveOfNode('plan')).toBeLessThan(second.wave)
    expect(second.wave).toBeLessThan(waveOfNode('dest'))
  })

  it('is capped per component, so naming one does not license the other', () => {
    const trace = simulate(roundTrip(), TRACK, { sourceId: 'src', revisit: ['fn'] })
    expect(stopsAt(trace, 'plan')).toHaveLength(1)
  })

  /*
   * Which components the setting is worth offering on.
   *
   * This block exists because of a bug that only the running app showed. The first version derived it
   * from the trace's rejoins, which reads as *better* evidence -- a rejoin is exactly the arrival being
   * promoted. But a rejoin only exists if the walk reached the second connector, and the diagram this
   * was built for has a destination filter that drops the event three components upstream. So the walk
   * stopped, no rejoin was ever recorded, and the control was offered on nothing at all: the feature was
   * unreachable from the UI on precisely the diagram it was for. Unit tests all passed.
   */
  describe('where the setting is offered', () => {
    it('offers it wherever more than one connector is drawn in', () => {
      expect([...revisitable(roundTrip())]).toEqual(['fn'])
    })

    it('offers nothing on a graph where every component has one way in', () => {
      expect([...revisitable(chain())]).toEqual([])
    })

    it('offers it even where the walk never reaches the second connector', () => {
      /* The regression. The filter drops everything, so `fn` is never walked to and there is no rejoin
         anywhere in the trace -- and the setting still has to be offered on it, because the connector
         is drawn and the reader is entitled to say what happens when it is followed. */
      const graph = roundTrip()
      graph.nodes.splice(1, 0, {
        id: 'filter',
        kind: 'destination_filter',
        name: 'Drops everything',
        condition: 'type = "track"',
        actions: [{ type: 'DROP' }],
      })
      graph.edges = [
        { id: 'sfl', source: 'src', target: 'filter' },
        { id: 'flf', source: 'filter', target: 'fn' },
        { id: 'fp', source: 'fn', target: 'plan' },
        { id: 'pf', source: 'plan', target: 'fn' },
        { id: 'fd', source: 'fn', target: 'dest' },
      ]

      const trace = simulate(graph, TRACK, { sourceId: 'src' })
      expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
      expect(trace.steps.some((step) => step.rejoin)).toBe(false)
      expect(revisitable(graph).has('fn')).toBe(true)
    })
  })

  it('has a further connector report the second verdict, not the first', () => {
    /*
     * A rejoin says "the verdict above is the one that settles it", and on a component stopped at
     * twice the verdict above is the second one. Reading the first is not a cosmetic slip: `frameAtPhase`
     * decides whether a connector draws as dropped from the status on its step, so a stale verdict
     * would light a line as delivered into a component that had just dropped the event.
     *
     * The fixture makes the two stops genuinely differ -- pass one rewrites the event, pass two throws
     * DropEvent -- because two stops with the same verdict cannot tell the two readings apart.
     */
    const graph = roundTrip()
    graph.nodes[1] = {
      ...graph.nodes[1],
      code: `async function onTrack(e) {
        e.properties.passes = (e.properties.passes ?? 0) + 1
        if (e.properties.passes > 1) throw new DropEvent('already seen')
        return e
      }`,
    }
    /* A third connector in, so there is still a rejoin once the plan's arrival has become the second
       stop. Added here rather than to the shared fixture, which other tests read as having two. */
    graph.edges.push({ id: 'df', source: 'dest', target: 'fn' })

    const trace = simulate(graph, TRACK, { sourceId: 'src', revisit: ['fn'] })
    const [first, second] = stopsAt(trace, 'fn')
    expect(first.status).toBe(STATUS.transformed)
    expect(second.status).toBe(STATUS.dropped)

    const rejoin = trace.steps.find((step) => step.rejoin && step.nodeId === 'fn')
    expect(rejoin.fromId).toBe('dest')
    expect(rejoin.status).toBe(STATUS.dropped)
  })
})

/*
 * What the walkthrough assumes where the diagram does not say.
 *
 * The behaviour this replaces read absence of configuration as an architectural finding: a destination
 * filter with no condition and no actions matched every event, found no action to take, and dropped it.
 * That is true of the real product and wrong for this tool, because a filter's actions are read-only in
 * the inspector -- they arrive from a live workspace or not at all. So every hand-drawn filter dropped
 * every event and there was no way to argue with it. Measured across the diagrams this tool actually
 * holds, not one filter, audience, computed trait, journey or mapping carried any rules: the finding was
 * unanimous and meaningless.
 *
 * Two rules carry the replacement, and the second is what stops it becoming a lie:
 *
 *   silence   ->  the reader's fallback, defaulting to `allow`
 *   knowledge ->  the recorded rules, always, whatever the fallback says
 */
describe('what the walkthrough assumes where the diagram does not say', () => {
  /* A filter carrying nothing at all, which is what every hand-drawn one looks like. */
  const bare = () => chain({ condition: '', actions: [] })

  describe('a filter with no rules recorded', () => {
    it('lets the event through by default, and says why', () => {
      const trace = simulate(bare(), TRACK, { sourceId: 'src' })
      expect(statusOf(trace, 'filter')).toBe(STATUS.passed)
      expect(hasArrived(statusOf(trace, 'filter'))).toBe(true)
      expect(reasonOf(trace, 'filter')).toMatch(/Nothing on this diagram records/)
      expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
    })

    it('stops the event when the reader sets Block', () => {
      const trace = simulate(bare(), TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.block } })
      expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
      expect(reasonOf(trace, 'filter')).toMatch(/You set/)
      expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
    })

    it('carries the event on with the payload flagged when the reader sets Modify', () => {
      const trace = simulate(bare(), TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.modify } })
      expect(statusOf(trace, 'filter')).toBe(STATUS.transformed)
      expect(trace.visited.filter.transform).toEqual({ unread: true })
      expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
    })

    it('records which assumption was used, so a reader can tell a guess from a finding', () => {
      expect(simulate(bare(), TRACK, { sourceId: 'src' }).visited.filter.assumed).toBe(FALLBACK.allow)
      expect(
        simulate(bare(), TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.block } }).visited
          .filter.assumed,
      ).toBe(FALLBACK.block)
    })
  })

  /*
   * The rule that keeps this honest. A fallback fills silence; it must never overrule something the
   * diagram actually says, or every real finding becomes negotiable and the tool stops being worth
   * running.
   */
  describe('recorded rules beat any assumption', () => {
    it('still drops where a matching condition has a DROP action, whatever the fallback says', () => {
      const trace = simulate(chain(), TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.allow } })
      expect(statusOf(trace, 'filter')).toBe(STATUS.dropped)
      expect(reasonOf(trace, 'filter')).toMatch(/properties\.revenue > 10/)
    })

    it('still passes where the condition does not match, even when the fallback says Block', () => {
      /* The inversion worth pinning: Block must not drop an event the recorded rules say this filter
         never touches. It is an assumption about the unknown, not a veto over the known. */
      const graph = chain({ condition: 'properties.revenue > 1000' })
      const trace = simulate(graph, TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.block } })
      expect(statusOf(trace, 'filter')).toBe(STATUS.passed)
      expect(reasonOf(trace, 'filter')).toMatch(/does not match/)
      expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
    })

    it('still reports a definite audience non-match as unmatched under Allow', () => {
      const graph = {
        nodes: [
          { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
          { id: 'aud', kind: 'audience', name: 'Purchasers', query: "event('Order Completed').count() = 0" },
        ],
        edges: [{ id: 'e1', source: 'src', target: 'aud' }],
      }
      const trace = simulate(graph, TRACK, { sourceId: 'src', fallback: { aud: FALLBACK.allow } })
      expect(statusOf(trace, 'aud')).toBe(STATUS.unmatched)
    })
  })

  describe('components that are not stages, but are drawn feeding something', () => {
    /* These keep their amber verdict -- a scheduled job is not a stage an event passes through, and
       `passed` would be false -- but they no longer report whatever they feed as never reached, which
       was a claim about the reader's diagram rather than about Segment. */
    it('walks past a Reverse ETL model to what it feeds', () => {
      const graph = {
        nodes: [
          { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
          { id: 'wh', kind: 'warehouse', name: 'Snowflake' },
          { id: 'model', kind: 'reverse_etl_model', name: 'VIP model' },
          { id: 'dest', kind: 'destination', name: 'Braze' },
        ],
        edges: [
          { id: 'e1', source: 'src', target: 'wh' },
          { id: 'e2', source: 'wh', target: 'model' },
          { id: 'e3', source: 'model', target: 'dest' },
        ],
      }
      const trace = simulate(graph, TRACK, { sourceId: 'src' })
      expect(statusOf(trace, 'model')).toBe(STATUS.notApplicable)
      expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
    })
  })

  it('assumes rather than truncates for a kind it has no rules for', () => {
    /* `custom` used to fall through to this branch and the comment there records what it cost: every
       path that ran through one was silently cut off. */
    const graph = {
      nodes: [
        { id: 'src', kind: 'source', name: 'Web', segmentId: 'S1' },
        { id: 'mystery', kind: 'some_future_kind', name: 'Mystery box' },
        { id: 'dest', kind: 'destination', name: 'Braze' },
      ],
      edges: [
        { id: 'e1', source: 'src', target: 'mystery' },
        { id: 'e2', source: 'mystery', target: 'dest' },
      ],
    }
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'mystery')).toBe(STATUS.passed)
    expect(statusOf(trace, 'dest')).toBe(STATUS.delivered)
  })

  describe('which components are offered the setting', () => {
    it('offers it where rules may be unreadable and not where they cannot be', () => {
      const offered = indeterminate(chain())
      expect(offered.has('filter')).toBe(true)
      expect(offered.has('fn')).toBe(true)
      /* A destination receives, and that is all there is to know about it. */
      expect(offered.has('dest')).toBe(false)
      expect(offered.has('src')).toBe(false)
    })

    it('offers it for a kind it has no rules for at all', () => {
      const graph = { nodes: [{ id: 'x', kind: 'some_future_kind', name: 'X' }], edges: [] }
      expect(indeterminate(graph).has('x')).toBe(true)
    })

    it('keeps offering it after a Block has truncated the path', () => {
      /* The trap this helper exists to avoid, and the third time it has come up in this file: a list
         derived from the trace loses the row for every component behind the block -- including the one
         that was blocked -- so the control would delete its own undo. `indeterminate` reads the graph. */
      const trace = simulate(bare(), TRACK, { sourceId: 'src', fallback: { filter: FALLBACK.block } })
      expect(statusOf(trace, 'dest')).toBe(STATUS.blocked)
      expect(indeterminate(bare()).has('filter')).toBe(true)
    })

    it('offers Modify only where the component could reshape a payload', () => {
      expect(acceptsModify('destination_insert_function')).toBe(true)
      expect(acceptsModify('destination_filter')).toBe(true)
      /* An audience decides whether a profile is in a set; it does not rewrite an event. */
      expect(acceptsModify('audience')).toBe(false)
      expect(acceptsModify('journey')).toBe(false)
    })
  })

  describe('the legacy functionBehaviour spelling', () => {
    it('reads drop as block and pass as allow', () => {
      expect(foldLegacyBehaviour({ a: 'drop', b: 'pass' })).toEqual({
        a: FALLBACK.block,
        b: FALLBACK.allow,
      })
    })

    it('ignores a value it does not recognise rather than inventing one', () => {
      expect(foldLegacyBehaviour({ a: 'sideways' })).toEqual({})
      expect(foldLegacyBehaviour(undefined)).toEqual({})
    })
  })
})
