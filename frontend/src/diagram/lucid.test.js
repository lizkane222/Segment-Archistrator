import { describe, expect, it } from 'vitest'

import { convertIfLucid, isLucidDocument, lucidToMermaid } from './lucid.js'
import { mermaidToGraph } from './mermaid.js'

/* The shape of a real Lucidspark board exported through Lucidchart: contents, connections and groups,
   and no geometry anywhere. */
const shape = (id, cls, text, extra = []) => ({
  id,
  class: cls,
  textAreas: [{ label: 'Text', text }, ...extra],
  customData: [],
  linkedData: [],
})
const line = (id, from, to, { start = 'None', end = 'Equilateral Arrow', text } = {}) => ({
  id,
  endpoint1: { style: start, connectedTo: from },
  endpoint2: { style: end, connectedTo: to },
  textAreas: text ? [{ label: 'Text', text }] : [],
  customData: [],
  linkedData: [],
})

const BOARD = {
  id: 'doc',
  title: 'Calls pipeline',
  product: 'lucidspark',
  pages: [
    {
      id: '0_0',
      title: 'Page 1',
      index: 0,
      items: {
        shapes: [
          shape('gw', 'SparkRectangleBlock', 'Domain gateway\n/Calls'),
          shape('svc', 'SparkRectangleBlock', 'voice-inflight-calls'),
          shape('db', 'SparkDatabaseBlock', 'inflight db'),
          shape('done', 'SparkTerminatorBlockV2', 'Finalized Calls'),
          shape('lake', 'SparkPredefinedProcessBlock', 'Data Lake'),
          shape('cloud', 'SparkCloudBlock', 'voice stack'),
          shape('note', 'AutoGrowTextBlock', 'Voice cell', [{ label: 'Placeholder', text: 'Type something' }]),
          shape('sticky', 'StickiesStickyNoteBlock', 'POST goes to call-service', [
            { label: 'ReadonlyAttributionText', text: 'Someone' },
          ]),
          shape('box', 'SparkRectangleBlock', ''),
        ],
        lines: [
          line('l1', 'gw', 'svc', { text: 'GET' }),
          line('l2', 'svc', 'db'),
          line('l3', 'db', 'done'),
          line('l4', 'done', 'lake', { start: 'Arrow', end: 'None' }),
          line('l5', 'cloud', 'svc'),
          line('l6', 'svc', 'nowhere'),
        ],
        groups: [{ id: 'g', members: ['done', 'lake'], customData: [], linkedData: [] }],
        layers: [],
      },
    },
  ],
}

describe('isLucidDocument / convertIfLucid', () => {
  it('recognises a Lucid export and nothing else', () => {
    expect(isLucidDocument(BOARD)).toBe(true)
    expect(isLucidDocument({ format: 'segment-builder-diagram', graph: {} })).toBe(false)
    expect(convertIfLucid('not json')).toBeNull()
    expect(convertIfLucid(JSON.stringify({ format: 'segment-builder-diagram' }))).toBeNull()
    expect(convertIfLucid(JSON.stringify(BOARD)).text).toMatch(/^---\ntitle: "Calls pipeline"/)
  })
})

describe('lucidToMermaid', () => {
  const { text, stats, notes } = lucidToMermaid(BOARD)

  it('maps Lucid block types to their Mermaid shapes', () => {
    expect(text).toContain('l_0_0_db[("inflight db")]')
    expect(text).toContain('l_0_0_done(["Finalized Calls"])')
    expect(text).toContain('l_0_0_lake[["Data Lake"]]')
    expect(text).toContain('l_0_0_cloud@{ shape: cloud, label: "voice stack" }')
    expect(text).toContain('l_0_0_gw["Domain gateway<br>/Calls"]')
  })

  it('carries arrows, labels and direction, and turns a start-only arrowhead round', () => {
    expect(text).toContain('l_0_0_gw -->|"GET"| l_0_0_svc')
    expect(text).toContain('l_0_0_lake --> l_0_0_done')
    expect(stats).toMatchObject({ lines: 5, skippedLines: 1 })
  })

  it('makes free text and stickies annotations, and leaves out empty containers', () => {
    expect(text).toContain('l_0_0_note["Voice cell"]:::shape')
    expect(text).toContain('style l_0_0_note fill:transparent,stroke:transparent')
    expect(text).toContain('style l_0_0_sticky fill:#fff4b8')
    expect(text).not.toContain('Someone')
    expect(text).not.toContain('Type something')
    expect(text).not.toContain('l_0_0_box')
    expect(stats).toMatchObject({ shapes: 6, notes: 2, skippedShapes: 1, groups: 1 })
    expect(notes.join(' ')).toMatch(/no positions/)
  })

  it('turns groups into subgraphs named after their first member', () => {
    expect(text).toMatch(/subgraph l_0_0_group_g\["Finalized Calls"\]\n\s+l_0_0_done/)
  })

  it('wraps each page in its own subgraph when there are several', () => {
    const two = { ...BOARD, pages: [BOARD.pages[0], { ...BOARD.pages[0], id: '1_0', title: 'Page 2', index: 1 }] }
    const out = lucidToMermaid(two).text
    expect(out).toContain('subgraph l_0_0_page["Page 1"]')
    expect(out).toContain('subgraph l_1_0_page["Page 2"]')
    expect(out).toContain('l_1_0_gw -->|"GET"| l_1_0_svc')
  })
})

describe('Lucid -> Mermaid -> diagram', () => {
  const { graph, warnings } = mermaidToGraph(lucidToMermaid(BOARD).text)
  const byName = (name) => graph.nodes.find((node) => node.name === name)

  it('imports cleanly, with every connection and a layout', () => {
    expect(warnings).toEqual([])
    expect(graph.edges).toHaveLength(5)
    for (const node of graph.nodes) expect(node.position, node.name).toBeDefined()
    expect(byName('inflight db').kind).toBe('warehouse')
    expect(byName('voice stack')).toMatchObject({ kind: 'shape', shape: 'cloud' })
    /* Annotations are sized to their words rather than to a default shape box. */
    expect(byName('Voice cell')).toMatchObject({ kind: 'shape', style: { border: 'transparent' } })
    expect(byName('Voice cell').size.height).toBeLessThan(60)
  })
})
