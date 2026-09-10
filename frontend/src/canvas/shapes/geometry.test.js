/*
 * Shape geometry.
 *
 * Same reasoning as the connector's routing tests: a wrong path is a bug you can only *see*. Nothing
 * throws, the shape just looks subtly wrong -- a star with the wrong valley depth, a hexagon rotated
 * a face, corners that overlap into a visible loop. So the invariants are asserted against the path
 * strings rather than left to be noticed.
 *
 * The one that matters most: **every path stays inside the viewBox**. A shape that overflows is
 * clipped on the canvas, and a clipped edge looks like a rendering fault rather than a wrong number.
 */

import { describe, expect, it } from 'vitest'

import { SHAPES, VIEW, polygon, shapeById, shapePath } from './geometry.js'

/** Every coordinate in a path string, as numbers. */
function coordinates(path) {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

describe('the catalogue', () => {
  it('gives every shape an id, a name, an aspect and a builder', () => {
    for (const shape of SHAPES) {
      expect(typeof shape.id, shape.id).toBe('string')
      expect(shape.name, shape.id).toBeTruthy()
      expect(typeof shape.build, shape.id).toBe('function')
      expect(typeof shape.rounds, shape.id).toBe('boolean')
      expect(shape.aspect, shape.id).toBeGreaterThan(0)
    }
  })

  it('has no duplicate ids', () => {
    const ids = SHAPES.map((shape) => shape.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offers at least the twenty the request asked for', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(20)
  })

  it('draws something for every shape, at every radius', () => {
    for (const shape of SHAPES) {
      for (const radius of [0, 0.5, 1]) {
        const path = shape.build(radius)
        expect(path, `${shape.id} @ ${radius}`).toMatch(/^M/)
        expect(path, `${shape.id} @ ${radius}`).not.toMatch(/NaN|Infinity|undefined/)
      }
    }
  })

  it('keeps every shape inside the viewBox', () => {
    /* The invariant that matters. An overflowing shape is clipped on the canvas, and a clipped edge
       reads as a rendering fault rather than as a wrong number. Half a unit of slack for rounding. */
    for (const shape of SHAPES) {
      for (const radius of [0, 0.5, 1]) {
        for (const value of coordinates(shape.build(radius))) {
          expect(value, `${shape.id} @ ${radius}: ${value}`).toBeGreaterThanOrEqual(-0.5)
          expect(value, `${shape.id} @ ${radius}: ${value}`).toBeLessThanOrEqual(VIEW + 0.5)
        }
      }
    }
  })

  it('closes every filled shape', () => {
    /* An unclosed path fills unpredictably -- the browser closes it implicitly along a straight line
       that is nobody's intention. The open ones are the annotation marks, which are strokes. */
    const strokes = new Set(['check', 'cross', 'plus', 'link', 'flag'])
    for (const shape of SHAPES) {
      if (strokes.has(shape.id)) continue
      expect(shape.build(0), shape.id).toMatch(/Z\s*$|Z /)
    }
  })
})

describe('corner rounding', () => {
  it('changes the path for a shape with corners', () => {
    for (const shape of SHAPES.filter((entry) => entry.rounds)) {
      expect(shape.build(0), shape.id).not.toBe(shape.build(1))
    }
  })

  it('is ignored by a shape with no corners', () => {
    /* A drag handle that silently does nothing is worse than one that is not offered, which is why
       `rounds` exists for the UI to read -- but the builder has to agree with it. */
    for (const shape of SHAPES.filter((entry) => !entry.rounds)) {
      expect(shapePath(shape.id, 0), shape.id).toBe(shapePath(shape.id, 1))
    }
  })

  it('is a fraction, not a pixel count', () => {
    /* A pixel radius looks completely different on a 90px chip and a 340px card and would have to be
       re-dragged after every resize. Checked by the arithmetic being monotonic in 0..1 and clamped
       outside it. */
    const at = (radius) => polygon([[0, 0], [100, 0], [100, 100], [0, 100]], radius)
    expect(at(2)).toBe(at(1))
    expect(at(-1)).toBe(at(0))
  })

  it('never lets two corners overlap into a loop', () => {
    /* Unclamped, two fillets on a short leg each consume more than the leg between them and the path
       visibly loops. Checked on a deliberately thin polygon. */
    const thin = polygon([[0, 48], [100, 48], [100, 52], [0, 52]], 1)
    expect(thin).not.toMatch(/NaN/)
    for (const value of coordinates(thin)) {
      expect(value).toBeGreaterThanOrEqual(-0.5)
      expect(value).toBeLessThanOrEqual(100.5)
    }
  })

  it('does not round a square into a circle', () => {
    /* The handle rounds corners; it must not change which shape the user picked. At full radius a
       square still has four straight runs and four arcs -- three of the runs are `L`s and the fourth
       is the closing `Z`, which joins the last arc's end back to the point the `M` started on. */
    const full = polygon([[0, 0], [100, 0], [100, 100], [0, 100]], 1)
    expect((full.match(/L/g) ?? []).length + 1).toBe(4)
    expect((full.match(/Q/g) ?? []).length).toBe(4)
  })
})

describe('polygon', () => {
  it('draws a plain closed polygon at radius zero', () => {
    expect(polygon([[0, 0], [10, 0], [10, 10]], 0)).toBe('M 0 0 L 10 0 L 10 10 Z')
  })

  it('refuses fewer than three points', () => {
    expect(polygon([[0, 0], [1, 1]], 0)).toBe('')
    expect(polygon([], 0)).toBe('')
  })

  it('rounds every vertex, not only the first', () => {
    /* One quadratic per vertex. Rounding only some is the bug that makes a hexagon look like it has
       been sat on. */
    const rounded = polygon([[0, 0], [100, 0], [100, 100], [0, 100]], 0.5)
    expect((rounded.match(/Q/g) ?? []).length).toBe(4)
  })
})

describe('shapePath', () => {
  it('answers null for a shape this build does not have', () => {
    /* Not a fallback square: a node naming an unknown shape is a document from a newer version, and
       drawing a square would silently misrepresent it. */
    expect(shapePath('nonsense')).toBeNull()
    expect(shapeById('nonsense')).toBeNull()
  })

  it('answers a path for every id in the catalogue', () => {
    for (const shape of SHAPES) expect(shapePath(shape.id, 0.3), shape.id).toBeTruthy()
  })
})
