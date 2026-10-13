import { describe, expect, it } from 'vitest'

import { buildLayout } from './layout.js'
import { rowsFor, visualizeWorkspace } from './visualize.js'

const topology = {
  zones: [
    { id: 'segment', label: 'Segment', order: 0, parent: null },
    { id: 'connections', label: 'Connections', order: 0, parent: 'segment' },
    { id: 'protocols', label: 'Protocols', order: 0, parent: 'connections' },
    { id: 'unify', label: 'Unify', order: 1, parent: 'segment' },
    { id: 'engage', label: 'Engage', order: 2, parent: 'segment' },
  ],
}

function workspace({ sources = 90, destinationsPerSource = 3 } = {}) {
  const nodes = []
  const edges = []
  for (let i = 0; i < sources; i += 1) {
    nodes.push({ id: `source:s${i}`, kind: 'source', zone: 'connections', name: `Source ${i}`, segmentId: `s${i}` })
    for (let j = 0; j < destinationsPerSource; j += 1) {
      const id = `destination:d${i}-${j}`
      nodes.push({ id, kind: 'destination', zone: 'connections', name: `Dest ${i}-${j}`, segmentId: `d${i}-${j}`, sourceId: `s${i}` })
      edges.push({ id: `source:s${i}->${id}`, source: `source:s${i}`, target: id })
    }
  }
  nodes.push({ id: 'space:a', kind: 'space', zone: 'unify', name: 'A', segmentId: 'a' })
  nodes.push({ id: 'audience:x', kind: 'audience', zone: 'engage', name: 'X', segmentId: 'x', spaceId: 'a' })
  return { nodes, edges }
}

describe('visualizeWorkspace', () => {
  it('wraps large stages into a grid instead of one tall column', () => {
    const graph = visualizeWorkspace(workspace(), topology)
    const connections = graph.zones.find((zone) => zone.id === 'connections')
    // 360 cards in one column would be ~31,000px tall.
    expect(connections.height).toBeLessThan(3000)
    expect(connections.width).toBeGreaterThan(connections.height / 2)
  })

  it('draws only the zones that hold components, nested in Segment', () => {
    const graph = visualizeWorkspace(workspace(), topology)
    expect(graph.zones.map((zone) => zone.id).sort()).toEqual(['connections', 'engage', 'segment', 'unify'])
    expect(graph.zones.find((zone) => zone.id === 'unify').parent).toBe('segment')
  })

  it('keeps a source and the destinations hanging off it adjacent', () => {
    const graph = visualizeWorkspace(workspace({ sources: 4, destinationsPerSource: 2 }), topology)
    const dests = graph.nodes.filter((node) => node.kind === 'destination')
    const order = [...dests].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
    expect(order.map((node) => node.sourceId)).toEqual(['s0', 's0', 's1', 's1', 's2', 's2', 's3', 's3'])
  })

  it('places sources left of destinations', () => {
    const graph = visualizeWorkspace(workspace({ sources: 3 }), topology)
    const maxSourceX = Math.max(...graph.nodes.filter((n) => n.kind === 'source').map((n) => n.position.x))
    const minDestX = Math.min(...graph.nodes.filter((n) => n.kind === 'destination').map((n) => n.position.x))
    expect(minDestX).toBeGreaterThan(maxSourceX)
  })

  it('round-trips through buildLayout with every card inside its zone', () => {
    const graph = visualizeWorkspace(workspace(), topology)
    const positions = Object.fromEntries(graph.nodes.map((node) => [node.id, node.position]))
    const layout = buildLayout(graph, { existingPositions: positions })
    const zones = new Map(layout.nodes.filter((n) => n.type === 'zone').map((n) => [n.id, n]))
    for (const node of layout.nodes.filter((n) => n.type !== 'zone')) {
      const zone = zones.get(node.parentId)
      expect(zone).toBeTruthy()
      expect(node.position.x + 200).toBeLessThanOrEqual(zone.width)
      expect(node.position.y + 60).toBeLessThanOrEqual(zone.height)
    }
    expect(layout.edges).toHaveLength(graph.edges.length)
  })

  it('handles an empty workspace', () => {
    expect(visualizeWorkspace({ nodes: [], edges: [] }, topology)).toEqual({
      nodes: [],
      edges: [],
      zones: [],
      scenarios: [],
    })
  })

  it('chooses a bounded row count', () => {
    expect(rowsFor(1)).toBe(6)
    expect(rowsFor(10000)).toBe(24)
  })
})
