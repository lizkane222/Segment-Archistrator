import { describe, expect, it } from 'vitest'

import { dragLabelTo, nearestOnRoute, placeLabel, placementPatch } from './labelPlacement.js'

const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }]

describe('label placement', () => {
  it('sits halfway, on the line, by default', () => {
    expect(placeLabel(line, {})).toMatchObject({ x: 50, y: 0, side: 'on' })
  })

  it('moves along the route and off it', () => {
    expect(placeLabel(line, { labelT: 0.25, labelOffset: { x: 0, y: -12 } })).toMatchObject({ x: 25, y: -12 })
  })

  it('hangs to a side of the anchor', () => {
    expect(placeLabel(line, { labelSide: 'above' }).y).toBeLessThan(0)
    expect(placeLabel(line, { labelSide: 'right' }).x).toBeGreaterThan(50)
    expect(placeLabel(line, { labelSide: 'nonsense' }).side).toBe('on')
  })

  it('finds the nearest point on a bent route', () => {
    const bent = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    const near = nearestOnRoute(bent, { x: 110, y: 50 })
    expect(near.point).toEqual({ x: 100, y: 50 })
    expect(near.t).toBeCloseTo(0.75)
  })

  it('snaps a drag close to the line onto it, and keeps a far one as an offset', () => {
    expect(dragLabelTo(line, { x: 30, y: 4 }).offset).toEqual({ x: 0, y: 0 })
    expect(dragLabelTo(line, { x: 30, y: -20 })).toMatchObject({ t: 0.3, offset: { x: 0, y: -20 } })
  })

  it('stores nothing for the defaults', () => {
    expect(placementPatch({ t: 0.5, offset: { x: 0, y: 0 }, side: 'on' })).toEqual({
      labelT: undefined,
      labelOffset: undefined,
      labelSide: undefined,
    })
  })
})
