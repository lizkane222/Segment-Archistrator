import { describe, expect, it } from 'vitest'

import { cascadeEdges, cascadeNodes, descendantsOf } from './zoneColour.js'

const zone = (id, parentId, data = {}) => ({ id, type: 'zone', ...(parentId ? { parentId } : {}), data: { id, ...data } })
const card = (id, parentId, style) => ({ id, ...(parentId ? { parentId } : {}), data: { kind: 'source', ...(style ? { style } : {}) } })

const nodes = [
  zone('outer'),
  zone('inner', 'outer', { style: { border: '#111111' } }),
  card('a', 'outer', { border: '#ff0000', shape: 'rounded' }),
  card('b', 'inner', { border: '#00ff00' }),
  card('c', 'inner'),
  card('elsewhere', null, { border: '#123456' }),
]

describe('handing a zone colour down', () => {
  it('finds everything below, at any depth', () => {
    expect([...descendantsOf(nodes, ['outer'])].sort()).toEqual(['a', 'b', 'c', 'inner'])
  })
  it('takes the borders off components, keeps the rest of their style, and recolours inner zones', () => {
    const out = cascadeNodes(nodes, ['outer'], '#0263e0')
    const byId = Object.fromEntries(out.map((node) => [node.id, node]))
    expect(byId.a.data.style).toEqual({ shape: 'rounded' })
    expect(byId.b.data.style).toEqual({})
    expect(byId.inner.data.style.border).toBe('#0263e0')
    expect(byId.elsewhere.data.style.border).toBe('#123456')
  })
  it('returns the same array when nothing below needed changing', () => {
    const settled = cascadeNodes(nodes, ['outer'], '#0263e0')
    expect(cascadeNodes(settled, ['outer'], '#0263e0')).toBe(settled)
  })
  it('takes a hand-picked colour off connectors that start inside', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'x', data: { color: '#abcdef' } },
      { id: 'e2', source: 'elsewhere', target: 'x', data: { color: '#abcdef' } },
    ]
    const out = cascadeEdges(edges, nodes, ['outer'])
    expect(out[0].data.color).toBeUndefined()
    expect(out[1].data.color).toBe('#abcdef')
  })
})
