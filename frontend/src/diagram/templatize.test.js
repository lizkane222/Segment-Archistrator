import { describe, expect, it } from 'vitest'

import {
  PATHS_ROW,
  allCells,
  applyTemplatize,
  buildMatrix,
  carriesWorkspaceIdentity,
  cellKey,
  invertSelection,
  removedCells,
  summarize,
} from './templatize.js'
import { buildDiagramFile } from './diagramFile.js'

const topology = { kinds: { source: { label: 'Source' }, destination: { label: 'Destination' } } }

const graph = () => ({
  nodes: [
    {
      id: 'source:src_123',
      kind: 'source',
      name: 'Acme web',
      description: 'Our storefront',
      slug: 'javascript',
      segmentId: 'src_123',
      workspaceUrl: 'https://app.segment.com/acme/sources/web',
      linkVerified: true,
      writeKeyMasked: '••••ab12',
      enabled: true,
      labels: [{ key: 'env', value: 'prod' }],
      bound: true,
      bindable: true,
      templateName: 'Web source',
      binds: { kind: 'source' },
      placeholder: { name: 'Web source', description: 'A website' },
      zone: 'connections',
      position: { x: 10, y: 20 },
    },
    {
      id: 'destination:dst_9',
      kind: 'destination',
      name: 'Braze (prod)',
      segmentId: 'dst_9',
      workspaceUrl: 'https://app.segment.com/acme/destinations/braze',
      bound: true,
      zone: 'connections',
      position: { x: 300, y: 20 },
    },
    { id: 'custom:1', kind: 'source', name: 'Placeholder', bound: false, bindable: true, binds: { kind: 'source' }, position: { x: 0, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'source:src_123', target: 'destination:dst_9', discovered: true }],
  scenarios: [{ id: 's1', name: 'Path', sourceId: 'source:src_123', excluded: ['destination:dst_9'], event: { type: 'track' } }],
})

const everything = (g) => allCells(buildMatrix(g, topology))

describe('the grid', () => {
  it('has a row per component and only the columns somebody has data in', () => {
    const matrix = buildMatrix(graph(), topology)
    expect(matrix.rows.map((row) => row.nodeId)).toEqual(['source:src_123', 'destination:dst_9', 'custom:1'])
    expect(matrix.columns.map((c) => c.id)).toEqual(['name', 'description', 'ids', 'links', 'keys', 'config'])
    expect(matrix.paths).toBe(1)
  })

  it('leaves a cell with nothing in it empty and not selectable', () => {
    const matrix = buildMatrix(graph(), topology)
    const destination = matrix.rows[1]
    expect(destination.cells.keys).toBeNull()
    expect(allCells(matrix).has(cellKey('destination:dst_9', 'keys'))).toBe(false)
  })

  it('does not offer to remove a link-verified flag that has no link beside it', () => {
    const matrix = buildMatrix({ nodes: [{ id: 'a', kind: 'source', linkVerified: true }], edges: [] }, topology)
    expect(matrix.rows[0].cells.links).toBeNull()
  })
})

describe('what a tick means', () => {
  const g = graph()
  const matrix = buildMatrix(g, topology)
  const all = allCells(matrix)

  it('removes what is ticked in remove mode', () => {
    const removed = removedCells(matrix, new Set([cellKey('source:src_123', 'name')]), 'remove')
    expect([...removed]).toEqual([cellKey('source:src_123', 'name')])
  })

  it('removes everything *except* what is ticked in keep mode', () => {
    const keepOnly = new Set([cellKey('source:src_123', 'name')])
    const removed = removedCells(matrix, keepOnly, 'keep')
    expect(removed.has(cellKey('source:src_123', 'name'))).toBe(false)
    expect(removed.size).toBe(all.size - 1)
  })

  it('keep with everything ticked removes nothing, and remove with everything ticked removes everything', () => {
    expect(removedCells(matrix, all, 'keep').size).toBe(0)
    expect(removedCells(matrix, all, 'remove').size).toBe(all.size)
  })

  it('inverting the ticks preserves the outcome when the mode flips', () => {
    const ticks = new Set([cellKey('source:src_123', 'name'), cellKey('source:src_123', 'ids')])
    const before = removedCells(matrix, ticks, 'remove')
    const after = removedCells(matrix, invertSelection(matrix, ticks), 'keep')
    expect([...after].sort()).toEqual([...before].sort())
  })

  it('ignores a tick on an empty cell', () => {
    expect(removedCells(matrix, new Set([cellKey('destination:dst_9', 'keys')]), 'remove').size).toBe(0)
  })
})

describe('applying it', () => {
  it('keeping everything changes nothing, and the template stays tied to its workspace', () => {
    const g = graph()
    const out = applyTemplatize(g, removedCells(buildMatrix(g, topology), everything(g), 'keep'), { topology })
    expect(out).toEqual(g)
    expect(carriesWorkspaceIdentity(out)).toBe(true)
  })

  it('removing everything leaves nothing that names the workspace', () => {
    const g = graph()
    const out = applyTemplatize(g, removedCells(buildMatrix(g, topology), everything(g), 'remove'), { topology })
    const text = JSON.stringify(out)
    for (const leak of ['src_123', 'dst_9', 'Acme', 'acme', 'Braze', 'ab12', 'storefront', 'prod', 'Our ']) {
      expect(text).not.toContain(leak)
    }
    expect(carriesWorkspaceIdentity(out)).toBe(false)
    expect(out.scenarios).toBeUndefined()
  })

  it('falls a removed name back to the template name, then to the kind', () => {
    const g = graph()
    const out = applyTemplatize(g, new Set([cellKey('source:src_123', 'name'), cellKey('destination:dst_9', 'name')]), { topology })
    expect(out.nodes[0].name).toBe('Web source')
    expect(out.nodes[1].name).toBe('Destination')
  })

  it('turns a component whose resource id was removed back into a placeholder to bind', () => {
    const g = graph()
    const out = applyTemplatize(g, new Set([cellKey('destination:dst_9', 'ids')]), { topology })
    const node = out.nodes[1]
    expect(node.bound).toBe(false)
    expect(node.bindable).toBe(true)
    expect(node.binds).toEqual({ kind: 'destination' })
    expect(node.segmentId).toBeUndefined()
    expect(node.id).toBe('destination:tpl2')
  })

  it('rewrites the id everywhere it was referenced', () => {
    const g = graph()
    const out = applyTemplatize(g, new Set([cellKey('source:src_123', 'ids')]), { topology })
    expect(out.edges[0].source).toBe('source:tpl1')
    expect(out.scenarios[0].sourceId).toBe('source:tpl1')
    expect(out.nodes[0].id).toBe('source:tpl1')
  })

  it('stops an edge from being a read-only workspace edge once an end is a placeholder', () => {
    const g = graph()
    const out = applyTemplatize(g, new Set([cellKey('source:src_123', 'ids')]), { topology })
    expect(out.edges[0].discovered).toBe(false)
  })

  it('never touches what the template is made of', () => {
    const g = graph()
    const out = applyTemplatize(g, removedCells(buildMatrix(g, topology), everything(g), 'remove'), { topology })
    const node = out.nodes[0]
    expect(node.kind).toBe('source')
    expect(node.slug).toBe('javascript')
    expect(node.zone).toBe('connections')
    expect(node.position).toEqual({ x: 10, y: 20 })
    expect(out.edges).toHaveLength(1)
  })

  it('removes saved paths only when asked to', () => {
    const g = graph()
    const kept = applyTemplatize(g, new Set([cellKey('source:src_123', 'name')]), { topology })
    expect(kept.scenarios).toHaveLength(1)
    const dropped = applyTemplatize(g, new Set([cellKey(PATHS_ROW, 'paths')]), { topology })
    expect(dropped.scenarios).toBeUndefined()
  })

  it('does not mutate the diagram it was given', () => {
    const g = graph()
    const before = JSON.stringify(g)
    applyTemplatize(g, removedCells(buildMatrix(g, topology), everything(g), 'remove'), { topology })
    expect(JSON.stringify(g)).toBe(before)
  })

  it('works on a node that keeps its fields under data', () => {
    const g = { nodes: [{ id: 'a', data: { kind: 'source', name: 'Mine', segmentId: 's1', bound: true } }], edges: [] }
    const matrix = buildMatrix(g, topology)
    const out = applyTemplatize(g, removedCells(matrix, allCells(matrix), 'remove'), { topology })
    expect(out.nodes[0].data.name).toBe('Source')
    expect(out.nodes[0].data.segmentId).toBeUndefined()
  })
})

describe('the outcome summary', () => {
  it('says how many are going and whether the template is generic', () => {
    const g = graph()
    const matrix = buildMatrix(g, topology)
    const removed = removedCells(matrix, allCells(matrix), 'remove')
    const out = applyTemplatize(g, removed, { topology })
    expect(summarize(matrix, removed, out)).toMatchObject({ removed: removed.size, kept: 0, generic: true })
    const none = applyTemplatize(g, new Set(), { topology })
    expect(summarize(matrix, new Set(), none)).toMatchObject({ removed: 0, generic: false })
  })
})

describe('exporting as JSON', () => {
  it('keeps every field of the diagram, whatever a template would remove', () => {
    const g = graph()
    const file = buildDiagramFile({ name: 'D', description: '', sourceTemplate: '', graph: g })
    expect(file.graph).toEqual(graph())
    applyTemplatize(g, removedCells(buildMatrix(g, topology), everything(g), 'remove'), { topology })
    expect(buildDiagramFile({ name: 'D', graph: g }).graph).toEqual(graph())
  })
})
