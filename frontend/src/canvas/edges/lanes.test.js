import { describe, expect, it } from 'vitest'

import { laneWaypoints } from './lanes.js'
import { orthogonalCorners, routeEdge } from './routing.js'

const box = (x, y, width, height, id = 'b') => ({ id, x, y, width, height })

describe('jogs', () => {
  it('closes a few-pixel step between parallel legs instead of drawing two extra corners', () => {
    const source = { x: 0, y: 100 }
    const target = { x: 400, y: 100 }
    const { points } = routeEdge({
      source,
      target,
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints: [{ x: 200, y: 100 }, { x: 200, y: 104 }, { x: 300, y: 104 }, { x: 300, y: 100 }],
    })
    // Every interior vertex is a real turn, none is a 4px step.
    for (let i = 1; i < points.length; i += 1) {
      const length = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
      expect(length >= 12).toBe(true)
    }
  })
})

describe('laneWaypoints', () => {
  const sourceBox = box(0, 0, 100, 40, 's')
  const targetBox = box(600, 0, 100, 40, 't')
  const geometry = {
    source: { x: 100, y: 20 },
    target: { x: 600, y: 20 },
    sourcePosition: 'right',
    targetPosition: 'left',
    sourceBox,
    targetBox,
  }

  it('leaves a clear default route alone', () => {
    expect(laneWaypoints({ ...geometry, boxes: [], zones: [] })).toEqual([])
  })

  it('goes round a blocking component with as few turns as it can', () => {
    const waypoints = laneWaypoints({ ...geometry, boxes: [box(300, -20, 100, 80)], zones: [] })
    const { points } = routeEdge({ ...geometry, waypoints })
    expect(points.length).toBeLessThanOrEqual(8)
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]
      const b = points[i]
      expect(a.x === b.x || a.y === b.y).toBe(true)
    }
  })

  it('prefers the gap between two zones to cutting through a zone it has no business in', () => {
    // A foreign zone sits across the straight route; a gap lies below it.
    const foreign = box(250, -200, 200, 260, 'z1')
    const waypoints = laneWaypoints({ ...geometry, boxes: [], zones: [foreign] })
    const { points } = routeEdge({ ...geometry, waypoints })
    const insideForeign = points.some(
      (p) => p.x > foreign.x && p.x < foreign.x + foreign.width && p.y > foreign.y && p.y < foreign.y + foreign.height,
    )
    expect(insideForeign).toBe(false)
    expect(orthogonalCorners).toBeTypeOf('function')
  })
})

describe('dashPieces', () => {
  it('starts the pattern at the same page coordinate for two lines sharing a row, whichever way they run', async () => {
    const { dashPieces } = await import('./routing.js')
    const left = dashPieces([{ x: 3, y: 50 }, { x: 200, y: 50 }], 16)
    const right = dashPieces([{ x: 400, y: 50 }, { x: 37, y: 50 }], 16)
    // Both are drawn low-to-high, so the phase at any shared x is the same function of x.
    expect(left[0].d.startsWith('M 3,50')).toBe(true)
    expect(right[0].d.startsWith('M 37,50')).toBe(true)
    expect((left[0].offset + (37 - 3)) % 16).toBe(right[0].offset)
  })
})
