import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildLayout } from '../canvas/layout.js'
import { graphToMermaid, looksLikeMermaid, mermaidToGraph } from './mermaid.js'
import { parseMermaid } from './mermaidParse.js'
import { graphFingerprint, positionsFromGraph, serializeGraph } from './serialize.js'

/* A template exactly as the app holds it once opened: through buildLayout and back out, which is the
   document an export is ever made from. */
function opened(graph) {
  const layout = buildLayout(graph, { existingPositions: positionsFromGraph(graph) })
  return serializeGraph({ ...layout, scenarios: graph.scenarios ?? [], collapsed: graph.collapsed ?? [] })
}

const roundTrip = (graph, meta) => mermaidToGraph(graphToMermaid(graph, meta))

/* Which line of the Mermaid an alias's declaration is on, so a test can edit it. */
const visible = (text) => text.split('\n').filter((line) => !line.includes('segment-builder:'))

const SMALL = {
  nodes: [
    { id: 'ph:web', kind: 'source', name: 'Website', zone: 'connections', bound: false, bindable: true, position: { x: 32, y: 52 } },
    { id: 'ph:braze', kind: 'destination', name: 'Braze', zone: 'connections', bound: true, position: { x: 400, y: 52 } },
    { id: 'ph:aud', kind: 'audience', name: 'High value', zone: 'engage', bound: false, position: { x: 32, y: 52 } },
  ],
  edges: [
    { id: 'e1', source: 'ph:web', target: 'ph:braze', sourceHandle: 'e', targetHandle: 'w', phase: null, discovered: false },
    { id: 'e2', source: 'ph:web', target: 'ph:aud', label: 'identify', strokeStyle: 'dashed', color: '#ff0000', phase: null, discovered: false },
  ],
  zones: [
    { id: 'connections', label: 'Connections', order: 0, position: { x: 0, y: 0 }, width: 700, height: 200 },
    { id: 'engage', label: 'Engage', order: 1, position: { x: 0, y: 260 }, width: 400, height: 200 },
  ],
}

describe('parseMermaid', () => {
  it('reads shapes, chains, fan-out, labels and subgraphs', () => {
    const parsed = parseMermaid(`flowchart LR
      subgraph seg["Segment"]
        direction TB
        A[Web site] -->|track| B(("Hub")):::src
        B -.-> C[(Warehouse)] & D{Decide}
      end
      A -- inline label --> D
      E>flag] ==> F([pill]) --- G
      H@{ shape: cyl, label: "DB" } <--> A`)

    expect(parsed.direction).toBe('LR')
    expect(parsed.nodes.get('A')).toMatchObject({ label: 'Web site', shape: 'rect', subgraph: 'seg' })
    expect(parsed.nodes.get('B')).toMatchObject({ shape: 'circle', classes: ['src'] })
    expect(parsed.nodes.get('C').shape).toBe('cylinder')
    expect(parsed.nodes.get('H')).toMatchObject({ shape: 'cylinder', label: 'DB', subgraph: null })
    expect(parsed.subgraphs.get('seg')).toMatchObject({ label: 'Segment', direction: 'TB' })

    const links = parsed.links.map((link) => `${link.source}${link.kind}${link.target}:${link.label ?? ''}`)
    expect(links).toEqual([
      'AsolidB:track',
      'BdottedC:',
      'BdottedD:',
      'AsolidD:inline label',
      'EthickF:',
      'FsolidG:',
      'HsolidA:',
    ])
    expect(parsed.links[5].arrowEnd).toBe(false)
    expect(parsed.links[6]).toMatchObject({ arrowStart: true, arrowEnd: true })
  })

  it('reads a code fence and front-matter title', () => {
    const parsed = parseMermaid('```mermaid\n---\ntitle: Acme\n---\ngraph TD\n  a --> b\n```')
    expect(parsed.title).toBe('Acme')
    expect(parsed.direction).toBe('TB')
    expect(parsed.links).toHaveLength(1)
  })

  it('refuses a diagram type that is not a flowchart, with a reason', () => {
    expect(() => parseMermaid('sequenceDiagram\n  A->>B: hi')).toThrow(/sequenceDiagram.*Only flowcharts/)
  })

  it('skips a line it cannot read without leaving a stray node behind', () => {
    const parsed = parseMermaid('flowchart LR\n  a --> b\n  c --> ???')
    expect([...parsed.nodes.keys()]).toEqual(['a', 'b'])
    expect(parsed.warnings[0]).toMatch(/line 3/)
  })
})

describe('looksLikeMermaid', () => {
  it('tells a flowchart from a JSON export', () => {
    expect(looksLikeMermaid('flowchart LR\n a-->b')).toBe(true)
    expect(looksLikeMermaid('---\ntitle: x\n---\ngraph TD')).toBe(true)
    expect(looksLikeMermaid('# Notes\n```mermaid\nflowchart LR\n```')).toBe(true)
    expect(looksLikeMermaid('{"format":"segment-builder-diagram"}')).toBe(false)
  })
})

describe('graphToMermaid', () => {
  const text = graphToMermaid(SMALL, { name: 'Acme' })

  it('writes zones as subgraphs, kinds as classes and connectors as styled links', () => {
    const lines = visible(text)
    expect(lines).toContain('title: "Acme"')
    expect(lines).toContain('  subgraph connections["Connections"]')
    expect(lines).toContain('    ph_web("Website"):::source')
    expect(lines).toContain('  ph_web --> ph_braze')
    expect(lines).toContain('  ph_web -.->|"identify"| ph_aud')
    expect(lines).toContain('  linkStyle 1 stroke:#ff0000')
    expect(lines.some((line) => line.startsWith('  classDef destination fill:#ffffff,stroke:#0e7c3a'))).toBe(true)
    /* An unbound placeholder draws dashed here, so it does in Mermaid too. */
    expect(lines.some((line) => line.startsWith('  style ph_web') && line.includes('stroke-dasharray'))).toBe(true)
  })

  it('leaves the round-trip comment out when asked', () => {
    expect(text).toContain('%% segment-builder:')
    expect(graphToMermaid(SMALL, {}, { embed: false })).not.toContain('segment-builder:')
  })

  it('escapes labels Mermaid would read as syntax', () => {
    const tricky = { ...SMALL, nodes: [{ ...SMALL.nodes[0], name: 'A "quoted" | <b>tag</b>\nline' }], edges: [] }
    const out = graphToMermaid(tricky)
    expect(out).toContain('"A #quot;quoted#quot; #124; #lt;b#gt;tag#lt;/b#gt;<br>line"')
    expect(mermaidToGraph(out).graph.nodes[0].name).toBe('A "quoted" | <b>tag</b>\nline')
  })
})

describe('round trip', () => {
  it('brings a diagram back byte-identical', () => {
    const graph = opened(SMALL)
    const back = roundTrip(graph, { name: 'Acme', description: 'demo', sourceTemplate: 'tpl' })
    expect(graphFingerprint(back.graph)).toBe(graphFingerprint(graph))
    expect(back).toMatchObject({ name: 'Acme', description: 'demo', sourceTemplate: 'tpl', restored: true, warnings: [] })
  })

  it('brings every shipped template back byte-identical', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../../apps/diagrams/fixtures/templates.json', import.meta.url), 'utf8'),
    )
    expect(fixture.length).toBeGreaterThan(0)
    for (const template of fixture) {
      const graph = opened(template)
      const back = roundTrip(graph, { name: template.name })
      expect(graphFingerprint(back.graph), template.key).toBe(graphFingerprint(graph))
    }
  })

  it('brings the hand-arranged end-to-end export back byte-identical, viewport included', () => {
    const file = JSON.parse(readFileSync(new URL('../../../scripts/end-to-end-export.json', import.meta.url), 'utf8'))
    const graph = { ...file.graph, viewport: { x: 10, y: 20, zoom: 0.8 } }
    const back = roundTrip(graph, file)
    expect(graphFingerprint(back.graph)).toBe(graphFingerprint(graph))
    expect(back.graph.viewport).toEqual(graph.viewport)
    expect(back.name).toBe(file.name)
  })

  it('keeps connectors to zones, loose ends and backwards-only arrows', () => {
    const graph = {
      ...SMALL,
      edges: [
        { id: 'z', source: 'ph:aud', target: 'zone-connections', phase: null, discovered: false },
        { id: 'loose', source: 'ph:braze', target: null, targetPoint: { x: 900, y: 80 }, phase: null, discovered: false },
        { id: 'back', source: 'ph:web', target: 'ph:aud', arrowStart: true, arrowEnd: false, phase: null, discovered: false },
      ],
    }
    const text = graphToMermaid(graph)
    expect(visible(text)).toContain('  ph_aud --> connections')
    /* Mermaid cannot put an arrow on the source end alone, so it is drawn reversed. */
    expect(visible(text)).toContain('  ph_aud --> ph_web')
    expect(graphFingerprint(mermaidToGraph(text).graph)).toBe(graphFingerprint(graph))
  })
})

describe('edits made in the Mermaid', () => {
  const graph = opened(SMALL)
  const text = graphToMermaid(graph, { name: 'Acme' })
  const node = (result, name) => result.graph.nodes.find((entry) => entry.name === name)

  it('applies a rename, and keeps everything else about the node', () => {
    const back = mermaidToGraph(text.replace('ph_braze("Braze")', 'ph_braze("Braze EU")'))
    expect(node(back, 'Braze EU')).toMatchObject({ id: 'ph:braze', kind: 'destination', position: { x: 400, y: 52 } })
  })

  it('moves a node to the subgraph it was moved into, and places it afresh there', () => {
    const lines = text.split('\n')
    const at = lines.findIndex((line) => line.includes('ph_braze("Braze")'))
    const [moved] = lines.splice(at, 1)
    lines.splice(lines.findIndex((line) => line.includes('ph_aud(')) + 1, 0, moved)
    const back = mermaidToGraph(lines.join('\n'))
    const braze = node(back, 'Braze')
    expect(braze.zone).toBe('engage')
    expect(braze.position).toBeDefined()
    expect(braze.position).not.toEqual({ x: 400, y: 52 })
  })

  it('drops a link deleted from the text, and restyles one that was edited', () => {
    const back = mermaidToGraph(text.replace('  ph_web --> ph_braze\n', '').replace('-.->|"identify"|', '-->|"identify v2"|'))
    expect(back.graph.edges).toHaveLength(1)
    const [edge] = back.graph.edges
    /* The stored colour still applies -- `linkStyle 1` now points past the end and is ignored, which
       is what Mermaid itself does -- but the dash came from the link operator and is gone. */
    expect(edge).toMatchObject({ id: 'e2', label: 'identify v2' })
    expect(edge.strokeStyle).toBeUndefined()
  })

  it('adds a node typed in by hand as a placeholder of the kind its class names, beside its neighbour', () => {
    const edited = text.replace('  ph_web --> ph_braze', '  ph_web --> ph_braze\n  ph_braze --> amp["Amplitude"]:::destination')
    const back = mermaidToGraph(edited)
    const added = node(back, 'Amplitude')
    expect(added).toMatchObject({ kind: 'destination', zone: null, bound: false })
    expect(added.id).toMatch(/^manual:destination:/)
    expect(back.graph.edges.some((edge) => edge.source === 'ph:braze' && edge.target === added.id)).toBe(true)
    /* Importing the same text twice mints the same id, so a re-import is not a different diagram. */
    expect(node(mermaidToGraph(edited), 'Amplitude').id).toBe(added.id)
  })

  it('re-sides a connector whose end moved to a different component', () => {
    /* Re-attached to a different component, the connector's old side is about a box it no longer
       touches, so both ends are given the sides that face each other afresh. */
    const back = mermaidToGraph(text.replace('  ph_web --> ph_braze', '  ph_aud --> ph_braze'))
    const edge = back.graph.edges.find((entry) => entry.source === 'ph:aud' && entry.target === 'ph:braze')
    /* The audience is at (32, 312) in Engage, Braze at (400, 52) in Connections: further apart across
       than down, so out of the east side and into the west. */
    expect(edge.sourceHandle).toBe('e')
    expect(edge.targetHandle).toBe('w')
    expect(edge.sourceAnchor).toBeUndefined()
  })

  it('imports only the flowchart when the round-trip line is damaged, and says so', () => {
    const back = mermaidToGraph(text.replace(/segment-builder:\{/, 'segment-builder:{oops'))
    expect(back.restored).toBe(false)
    expect(back.warnings.join(' ')).toMatch(/damaged/)
    expect(back.graph.nodes).toHaveLength(3)
  })
})

describe('a flowchart written by hand', () => {
  const result = mermaidToGraph(`flowchart LR
    subgraph Segment
      subgraph Connections
        web[Website] --> fn[[Enrich function]]
        fn --> dest[Braze]
        fn --> wh[(Snowflake)]
      end
      subgraph Unify
        prof[Profile] --> trait[Computed Trait]
      end
      subgraph team["Growth team"]
        aud[High value users]
      end
    end
    app[Customer app] --> web
    web -->|identify| prof
    trait -.-> aud
    aud --> ok{Approved?}
  `)
  const byName = (name) => result.graph.nodes.find((node) => node.name === name)

  it('recognises Segment zones by name and keeps the rest as custom zones', () => {
    const zones = Object.fromEntries(result.graph.zones.map((zone) => [zone.label, zone]))
    expect(zones.Segment.id).toBe('segment')
    expect(zones.Connections).toMatchObject({ id: 'connections', parent: 'segment' })
    expect(zones.Unify.id).toBe('unify')
    expect(zones['Growth team']).toMatchObject({ custom: true, parent: 'segment' })
    expect(zones['Growth team'].id).toMatch(/^custom:zone:/)
  })

  it('infers component kinds from names, shapes and zones', () => {
    expect(byName('Website').kind).toBe('source')
    expect(byName('Enrich function').kind).toBe('source_function')
    expect(byName('Braze').kind).toBe('destination')
    expect(byName('Snowflake').kind).toBe('warehouse')
    expect(byName('Profile').kind).toBe('profile')
    expect(byName('Computed Trait').kind).toBe('computed_trait')
    expect(byName('Customer app').kind).toBe('custom')
    /* A decision diamond outside every zone is flowchart punctuation, not a component. */
    expect(byName('Approved?')).toMatchObject({ kind: 'shape', shape: 'diamond' })
    /* A hand-drawn function starts with working code, like a palette drop. */
    expect(byName('Enrich function').code).toBeTruthy()
  })

  it('carries link labels and dashes', () => {
    const edge = (from, to) =>
      result.graph.edges.find((entry) => entry.source === byName(from).id && entry.target === byName(to).id)
    expect(edge('Website', 'Profile').label).toBe('identify')
    expect(edge('Computed Trait', 'High value users').strokeStyle).toBe('dashed')
  })

  it('lays everything out along the flowchart direction, without overlaps, and opens cleanly', () => {
    for (const node of result.graph.nodes) expect(node.position, node.name).toBeDefined()
    for (const zone of result.graph.zones) expect(zone.width, zone.label).toBeGreaterThan(0)
    const x = (name) => byName(name).position.x
    /* Same zone, so the positions are comparable: each step is further right than what feeds it. */
    expect(x('Enrich function')).toBeGreaterThan(x('Website'))
    expect(x('Braze')).toBeGreaterThan(x('Enrich function'))

    const layout = buildLayout(result.graph, { existingPositions: positionsFromGraph(result.graph) })
    expect(layout.nodes).toHaveLength(result.graph.nodes.length + result.graph.zones.length)
    /* What the app would save straight away is what was imported -- nothing is re-invented on open. */
    const saved = serializeGraph(layout)
    expect(graphFingerprint(saved)).toBe(graphFingerprint(result.graph))
  })

  it('meets each component on the side facing the other end', () => {
    const edge = (from, to) =>
      result.graph.edges.find((entry) => entry.source === byName(from).id && entry.target === byName(to).id)
    /* Left to right: out of the east side, into the west -- not React Flow's default pair, which hooks
       every line back round onto the east side of its target. */
    expect(edge('Website', 'Enrich function')).toMatchObject({ sourceHandle: 'e', targetHandle: 'w' })
    expect(edge('Customer app', 'Website')).toMatchObject({ sourceHandle: 'e', targetHandle: 'w' })
  })

  it('places a loose end it has to invent', () => {
    const back = mermaidToGraph('flowchart LR\n  a[Website] --> loose_x_target')
    expect(back.graph.edges[0]).toMatchObject({ target: null })
    expect(back.graph.edges[0].targetPoint).toBeDefined()
  })
})
