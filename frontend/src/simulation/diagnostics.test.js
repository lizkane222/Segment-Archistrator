/*
 * The pasteable report.
 *
 * What it has to get right is the headline. The bug it was written for -- a diagram whose
 * connectors are stored pointing the wrong way -- shows up as a path that reaches one component
 * and stops, and the report is worth having only if that case is unmissable in the first few lines
 * rather than inferable from a connector list further down.
 */

import { describe, expect, it } from 'vitest'

import { pathReport, pathsReport } from './diagnostics.js'
import { newScenario } from './scenarios.js'
import { simulate } from './router.js'

const TRACK = { type: 'track', event: 'Order Completed', userId: 'u1' }

const chain = () => ({
  nodes: [
    { id: 'src', kind: 'source', name: 'Website' },
    { id: 'fn', kind: 'source_insert_function', name: 'Enrich' },
    { id: 'dest', kind: 'destination', name: 'Braze' },
  ],
  edges: [
    { id: 'e1', source: 'src', target: 'fn' },
    { id: 'e2', source: 'fn', target: 'dest' },
  ],
})

/* The same three components wired end-to-start, which is the real shape out of the database. */
const backwards = () => ({
  nodes: chain().nodes,
  edges: [
    { id: 'e1', source: 'fn', target: 'src' },
    { id: 'e2', source: 'dest', target: 'fn' },
  ],
})

const scenario = (overrides) => ({
  ...newScenario({ id: 'p1', name: 'Happy path', event: TRACK }),
  ...overrides,
})

const reportFor = (graph, overrides = {}) => {
  const entry = scenario({ sourceId: 'src', ...overrides })
  return pathReport({
    scenario: entry,
    trace: simulate(graph, entry.event, {
      sourceId: entry.sourceId,
      disabled: entry.disabled,
      excluded: entry.excluded,
    }),
    graph,
    diagramName: 'Test diagram',
  })
}

describe('pathReport', () => {
  it('names the diagram, the path and the event', () => {
    const text = reportFor(chain())
    expect(text).toContain('Test diagram')
    expect(text).toContain('Happy path')
    expect(text).toContain('Order Completed')
  })

  it('describes components by name and kind, not by id', () => {
    /* "the connector from Braze to Enrich is backwards" is actionable; "e2" is not. */
    const text = reportFor(chain())
    expect(text).toContain('[source] Website')
    expect(text).toContain('[destination] Braze')
  })

  it('leads with the diagnosis when nothing leaves the start', () => {
    const text = reportFor(backwards())
    expect(text).toContain('NOTHING LEAVES THIS COMPONENT')
    /* And names the connectors that point at it instead, which is the actual fault. */
    expect(text).toContain('[source_insert_function] Enrich  ->  THIS')
  })

  it('says how to fix that', () => {
    const text = reportFor(backwards())
    expect(text).toContain('Reverse every connector')
  })

  it('does not cry wolf on a diagram that is wired correctly', () => {
    expect(reportFor(chain())).not.toContain('NOTHING LEAVES')
  })

  it('lists the route a moment at a time', () => {
    const text = reportFor(chain())
    expect(text).toContain('--- ROUTE ---')
    expect(text).toContain('Delivered')
  })

  it('marks every connector used or unused', () => {
    const text = reportFor(chain())
    expect(text).toMatch(/used\s+\[source\] Website\s+->\s+\[source_insert_function\] Enrich/)
  })

  it('reports connectors the event never travelled', () => {
    const graph = chain()
    graph.nodes.push({ id: 'other', kind: 'destination', name: 'Orphan' })
    graph.edges.push({ id: 'e3', source: 'other', target: 'dest' })
    const text = reportFor(graph)
    expect(text).toContain('CONNECTORS THE EVENT NEVER TRAVELLED')
  })

  it('reports components the path never reached', () => {
    const graph = chain()
    graph.nodes.push({ id: 'lonely', kind: 'destination', name: 'Nowhere' })
    expect(reportFor(graph)).toContain('[destination] Nowhere')
  })

  it('records the assumptions the run was made under', () => {
    const text = reportFor(chain(), { disabled: ['fn'] })
    expect(text).toContain('switched off:  [source_insert_function] Enrich')
  })

  it('distinguishes leaving out from switching off', () => {
    /* The two mean different things to the reducer, so a report that blurred them would send
       somebody looking for a bug in the wrong half of the run. */
    const text = reportFor(chain(), { excluded: ['fn'] })
    expect(text).toContain('left out:')
    expect(text).toContain('steps over it')
  })

  it('handles a path with no start chosen', () => {
    const text = pathReport({ scenario: scenario({ sourceId: null }), trace: null, graph: chain() })
    expect(text).toContain('No start chosen')
    expect(text).toContain('(no route')
  })

  it('handles an empty diagram without throwing', () => {
    const text = pathReport({ scenario: scenario(), trace: null, graph: { nodes: [], edges: [] } })
    expect(text).toContain('components: 0')
  })

  it('counts what was reached', () => {
    expect(reportFor(chain())).toMatch(/reached 3 of 3 components/)
  })
})

describe('pathsReport', () => {
  it('concatenates one report per path', () => {
    const graph = chain()
    const entries = ['A', 'B'].map((name) => {
      const entry = scenario({ id: name, name, sourceId: 'src' })
      return { scenario: entry, trace: simulate(graph, TRACK, { sourceId: 'src' }) }
    })
    const text = pathsReport(entries, { graph })
    expect(text).toContain('path:      A')
    expect(text).toContain('path:      B')
  })

  it('says so when there is nothing to report', () => {
    expect(pathsReport([], { graph: chain() })).toContain('No paths to report on')
  })
})
