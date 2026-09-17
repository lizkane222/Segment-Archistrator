import { describe, expect, it } from 'vitest'

import { buildLayout } from '../canvas/layout.js'
import {
  DIAGRAM_FILE_FORMAT,
  DIAGRAM_FILE_VERSION,
  buildDiagramFile,
  parseDiagramFile,
} from './diagramFile.js'
import { graphFingerprint, positionsFromGraph, serializeGraph } from './serialize.js'

const GRAPH = {
  nodes: [{ id: 'a', name: 'Website', kind: 'source', zone: 'connections', bound: true }],
  edges: [],
  zones: [{ id: 'connections', label: 'Connections', order: 0, position: { x: 0, y: 0 }, width: 100, height: 100 }],
}

describe('buildDiagramFile', () => {
  it('stamps the format, version and export time', () => {
    const file = buildDiagramFile({ name: 'Acme', description: '', sourceTemplate: '', graph: GRAPH })
    expect(file.format).toBe(DIAGRAM_FILE_FORMAT)
    expect(file.version).toBe(DIAGRAM_FILE_VERSION)
    expect(Number.isNaN(new Date(file.exportedAt).getTime())).toBe(false)
    expect(file.graph).toEqual(GRAPH)
  })

  it('defaults name, description and sourceTemplate to empty strings', () => {
    const file = buildDiagramFile({ graph: GRAPH })
    expect(file.name).toBe('')
    expect(file.description).toBe('')
    expect(file.sourceTemplate).toBe('')
  })
})

describe('parseDiagramFile', () => {
  it('round-trips name, description, sourceTemplate and graph through JSON', () => {
    const file = buildDiagramFile({
      name: 'Acme Corp',
      description: 'A demo',
      sourceTemplate: 'web-mobile',
      graph: GRAPH,
    })
    const parsed = parseDiagramFile(JSON.stringify(file))

    expect(parsed.name).toBe('Acme Corp')
    expect(parsed.description).toBe('A demo')
    expect(parsed.sourceTemplate).toBe('web-mobile')
    expect(parsed.graph).toEqual(GRAPH)
  })

  it('rejects text that is not valid JSON', () => {
    expect(() => parseDiagramFile('not json')).toThrow(/not valid JSON/)
  })

  it('rejects well-formed JSON that is not an object', () => {
    expect(() => parseDiagramFile('[1, 2, 3]')).toThrow(/not a diagram export/)
    expect(() => parseDiagramFile('"a string"')).toThrow(/not a diagram export/)
  })

  it('rejects a file with the wrong format', () => {
    const file = buildDiagramFile({ graph: GRAPH })
    const wrong = { ...file, format: 'some-other-tool' }
    expect(() => parseDiagramFile(JSON.stringify(wrong))).toThrow(/not a diagram exported from this app/)
  })

  it('rejects a version newer than this client understands', () => {
    const file = buildDiagramFile({ graph: GRAPH })
    const future = { ...file, version: DIAGRAM_FILE_VERSION + 1 }
    expect(() => parseDiagramFile(JSON.stringify(future))).toThrow(/newer version/)
  })

  it('rejects a file with no graph, or a graph missing nodes/edges arrays', () => {
    const file = buildDiagramFile({ graph: GRAPH })
    expect(() => parseDiagramFile(JSON.stringify({ ...file, graph: undefined }))).toThrow(
      /not a diagram export/,
    )
    expect(() =>
      parseDiagramFile(JSON.stringify({ ...file, graph: { nodes: [] } })),
    ).toThrow(/not a diagram export/)
    expect(() =>
      parseDiagramFile(JSON.stringify({ ...file, graph: { nodes: 'nope', edges: [] } })),
    ).toThrow(/not a diagram export/)
  })

  it('coerces a non-string name/description/sourceTemplate to an empty string rather than throwing', () => {
    const file = buildDiagramFile({ graph: GRAPH })
    const odd = { ...file, name: 42, description: null, sourceTemplate: {} }
    const parsed = parseDiagramFile(JSON.stringify(odd))
    expect(parsed).toMatchObject({ name: '', description: '', sourceTemplate: '' })
  })
})

describe('export then import, end to end', () => {
  const ZONES = [
    { id: 'connections', label: 'Connections', order: 0 },
    { id: 'unify', label: 'Unify', order: 1 },
  ]
  const DOCUMENT = {
    zones: ZONES,
    nodes: [
      { id: 'source:a', kind: 'source', name: 'Website', zone: 'connections', bound: true },
      { id: 'space:b', kind: 'space', name: 'Production', zone: 'unify', bound: true },
    ],
    edges: [{ id: 'e1', source: 'source:a', target: 'space:b', discovered: false }],
  }
  const open = (graph) => buildLayout(graph, { existingPositions: positionsFromGraph(graph) })

  it('rebuilds a diagram, and its name, exactly as it was before it was exported', () => {
    const saved = serializeGraph(open(DOCUMENT))
    const exported = buildDiagramFile({
      name: 'Customer walkthrough',
      description: 'Shown on the call',
      sourceTemplate: '',
      graph: saved,
    })

    /* What actually crosses the file boundary: a string on the way out, parsed back
       on the way in -- not the in-memory object, which would hide a key JSON drops
       (like `undefined`) or reorders. */
    const imported = parseDiagramFile(JSON.stringify(exported))

    expect(imported.name).toBe('Customer walkthrough')
    expect(imported.description).toBe('Shown on the call')

    const reopened = serializeGraph(open(imported.graph))
    expect(graphFingerprint(reopened)).toBe(graphFingerprint(saved))
  })
})

describe('what an exported file carries', () => {
  /* The graph handed to `buildDiagramFile` is whatever `saveGraph()` produced, which is
     `serializeGraph({nodes, edges, scenarios, collapsed, viewport})` -- the same object a
     Save would have sent. These pin the parts that are easy to lose sight of, because
     they live outside `nodes`/`edges` and a reader checking "did my diagram survive"
     looks at the shapes first. */
  const WITH_EXTRAS = {
    nodes: [
      { id: 'source:a', kind: 'source', name: 'Website', zone: 'connections', bound: true },
      { id: 'space:b', kind: 'space', name: 'Production', zone: 'unify', bound: true },
    ],
    edges: [{ id: 'e1', source: 'source:a', target: 'space:b', discovered: false }],
    zones: [{ id: 'connections', label: 'Connections', order: 0 }],
    scenarios: [
      {
        id: 'path-1',
        name: 'Signed-up user',
        color: '#06B6D4',
        sourceId: 'source:a',
        event: { name: 'Signed Up', properties: { plan: 'pro' } },
        excluded: ['space:b'],
        /* A component the path doubles back through. Here for the same reason `excluded` is: it lives
           outside `nodes`/`edges`, so a serialiser that grew a field allowlist would drop it silently
           and the walkthrough would come back from a save having quietly lost a beat. */
        revisit: ['source:a'],
        forks: [],
      },
    ],
    collapsed: ['group:destinations'],
    viewport: { x: -120, y: 40, zoom: 0.75 },
  }

  it('includes the configured paths, with their events and exclusions', () => {
    const file = buildDiagramFile({ name: 'Acme', graph: WITH_EXTRAS })
    const imported = parseDiagramFile(JSON.stringify(file))

    expect(imported.graph.scenarios).toHaveLength(1)
    const [path] = imported.graph.scenarios
    expect(path).toMatchObject({
      id: 'path-1',
      name: 'Signed-up user',
      sourceId: 'source:a',
      excluded: ['space:b'],
    })
    /* The event payload is the part someone typed by hand, so losing it means retyping
       the scenario rather than just re-selecting it. */
    expect(path.event).toEqual({ name: 'Signed Up', properties: { plan: 'pro' } })
  })

  it('includes which groups were folded, and the viewport', () => {
    const imported = parseDiagramFile(
      JSON.stringify(buildDiagramFile({ name: 'Acme', graph: WITH_EXTRAS })),
    )
    /* A diagram saved with forty destinations folded was saved that way because that is
       the readable version of it -- see `applyGraph`. */
    expect(imported.graph.collapsed).toEqual(['group:destinations'])
    expect(imported.graph.viewport).toEqual({ x: -120, y: 40, zoom: 0.75 })
  })

  it('survives the file boundary with the paths byte-identical', () => {
    const file = buildDiagramFile({ name: 'Acme', graph: WITH_EXTRAS })
    const imported = parseDiagramFile(JSON.stringify(file))
    expect(JSON.stringify(imported.graph.scenarios)).toBe(JSON.stringify(WITH_EXTRAS.scenarios))
  })
})
