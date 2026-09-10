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

import {
  STATUS,
  defaultSourceId,
  eligibleSources,
  eligibleStarts,
  frameAt,
  simulate,
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

  it('does not claim a pass for a condition it cannot parse', () => {
    const graph = chain({ condition: 'properties.revenue ~= 100' })
    const trace = simulate(graph, TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'filter')).toBe(STATUS.notEvaluated)
    expect(statusOf(trace, 'dest')).not.toBe(STATUS.delivered)
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

  it('claims nothing for a trigger it cannot read', () => {
    const trace = simulate(withMapping({ trigger: 'properties.revenue >' }), TRACK, {
      sourceId: 'src',
    })
    expect(statusOf(trace, 'map')).toBe(STATUS.notEvaluated)
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
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

  it('reports an audience needing history as undecided, and its destination too', () => {
    const trace = simulate(unifyGraph("event('Order Completed').count() >= 5"), TRACK, { sourceId: 'src' })
    expect(statusOf(trace, 'aud')).toBe(STATUS.undecided)
    expect(statusOf(trace, 'dest')).toBe(STATUS.undecided)
    expect(reasonOf(trace, 'dest')).toMatch(/could not settle/)
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
    const trace = simulate(chain(), TRACK, { sourceId: 'src', functionBehaviour: { fn: 'drop' } })
    expect(statusOf(trace, 'fn')).toBe(STATUS.dropped)
    expect(reasonOf(trace, 'fn')).toMatch(/You told the simulator/)
    expect(statusOf(trace, 'filter')).toBe(STATUS.blocked)
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
    expect(summary.rows).toHaveLength(trace.steps.length)
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

  it('still refuses source -> source, which is the case that rule was for', () => {
    /* An event is collected once. This is the assertion that keeps the relaxation
       narrow -- without it, "anything may feed a source" would have swallowed the one
       real dead end too. */
    const graph = outside()
    graph.nodes.push({ id: 'src2', kind: 'source', name: 'Second source' })
    graph.edges.push({ id: 'e3', source: 'src', target: 'src2' })
    const trace = simulate(graph, TRACK, { sourceId: 'app' })
    expect(statusOf(trace, 'src2')).toBe(STATUS.blocked)
    expect(reasonOf(trace, 'src2')).toMatch(/from one source into another/)
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
