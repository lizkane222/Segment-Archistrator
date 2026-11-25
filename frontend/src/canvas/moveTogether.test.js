import { describe, expect, it } from 'vitest'

import { adoptInside, carryBends, insideButNotParented, movedBy, movedTogether, snapshotPositions } from './moveTogether.js'

const zone = (id, x, y, width, height, parentId) => ({ id, type: 'zone', position: { x, y }, width, height, ...(parentId ? { parentId } : {}), data: { id: id.replace('zone-', '') } })
const card = (id, x, y, parentId, data = {}) => ({ id, position: { x, y }, width: 100, height: 40, ...(parentId ? { parentId } : {}), data: { kind: 'source', ...data } })

const nodes = [
  zone('zone-outer', 100, 100, 600, 400),
  zone('zone-child', 10, 10, 200, 200, 'zone-outer'),
  zone('zone-loose', 350, 150, 200, 200), // physically inside outer, but not its child
  card('inside', 120, 420), // centre inside outer
  card('outside', 900, 900),
  card('kid', 10, 10, 'zone-child'),
]

describe('everything inside a zone moves with it', () => {
  it('finds what is inside the box and not yet a child', () => {
    expect(insideButNotParented(nodes, 'zone-outer').sort()).toEqual(['inside', 'zone-loose'])
  })
  it('adopts it, keeping every position where it was drawn', () => {
    const out = adoptInside(nodes, 'zone-outer')
    const loose = out.find((node) => node.id === 'zone-loose')
    expect(loose.parentId).toBe('zone-outer')
    expect(loose.data.parent).toBe('outer')
    expect(loose.position).toEqual({ x: 250, y: 50 })
    expect(out.find((node) => node.id === 'inside').data.zone).toBe('outer')
    expect(out.find((node) => node.id === 'outside').parentId).toBeUndefined()
  })
  it('leaves the array alone when there is nothing to adopt', () => {
    const settled = adoptInside(nodes, 'zone-outer')
    expect(adoptInside(settled, 'zone-outer')).toBe(settled)
  })
})

describe('connectors between things that moved together', () => {
  /* The order a drag has: what is inside is adopted at the start, then the zone is moved. */
  const adopted = adoptInside(nodes, 'zone-outer')
  const before = snapshotPositions(adopted)
  const moved = adopted.map((node) => (node.id === 'zone-outer' ? { ...node, position: { x: 150, y: 80 } } : node))
  const deltaOf = movedBy(before, snapshotPositions(moved))

  it('knows who moved and by how much, children included', () => {
    expect(deltaOf('zone-child')).toEqual({ dx: 50, dy: -20 })
    expect(deltaOf('outside')).toBeNull()
  })
  it('carries the bends of a connector whose ends both moved', () => {
    const edges = [
      { id: 'in', source: 'kid', target: 'inside', data: { waypoints: [{ x: 1, y: 2 }] } },
      { id: 'out', source: 'kid', target: 'outside', data: { waypoints: [{ x: 1, y: 2 }] } },
    ]
    const together = new Set()
    const out = carryBends(edges, deltaOf, together)
    expect(out[0].data.waypoints).toEqual([{ x: 51, y: -18 }])
    expect(out[1].data.waypoints).toEqual([{ x: 1, y: 2 }])
    expect([...together]).toEqual(['in'])
  })
  it('is not "together" when only one end moved', () => {
    expect(movedTogether({ source: 'kid', target: 'outside' }, deltaOf)).toBeNull()
  })
})
