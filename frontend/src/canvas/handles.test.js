/*
 * Which side a connector meets a node on.
 *
 * There is one thing here worth a whole file, and it is a migration hazard rather than a
 * feature: React Flow resolves an edge end with no handle id to the *first* entry in the
 * node's handle list for that end's type. Every edge in every diagram saved before four-sided
 * handles existed has `sourceHandle: null` and `targetHandle: null`. So the order of `SIDES`
 * silently decides whether those diagrams come back looking the way they were saved, and
 * nothing about the code makes that visible -- reordering this list to read more nicely would
 * move every connector in the database onto a different side of its component.
 */

import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'

import {
  LEGACY_SOURCE,
  LEGACY_TARGET,
  SIDES,
  encodeFreeHandle,
  nearestBorder,
  parseFreeHandle,
  pointOnBorder,
} from './handles.js'
import { toFlowEdge } from './layout.js'
import { serializeEdge } from '../diagram/serialize.js'

describe('SIDES', () => {
  it('covers all four sides exactly once', () => {
    expect(SIDES.map((side) => side.id).sort()).toEqual(['e', 'n', 's', 'w'])
    expect(SIDES.map((side) => side.position).sort()).toEqual(
      [Position.Bottom, Position.Left, Position.Right, Position.Top].sort(),
    )
  })

  it('puts east first, which is where the old single source handle was', () => {
    /* An edge saved with `sourceHandle: null` leaves from `SIDES[0]`. That used to be a
       handle on the right, so `SIDES[0]` has to be the right or every saved diagram
       re-routes itself on open. */
    expect(SIDES[0].id).toBe(LEGACY_SOURCE)
    expect(SIDES[0].position).toBe(Position.Right)
  })

  it('puts west second, which is where the old single target handle was', () => {
    /* Both node renderers emit a source and a target per side in `SIDES` order, so the first
       *target* in the list is the second side -- west. Same argument as above for the
       arriving end of every pre-existing edge. */
    expect(SIDES[1].id).toBe(LEGACY_TARGET)
    expect(SIDES[1].position).toBe(Position.Left)
  })

  it('gives every side a label a tooltip can use', () => {
    for (const side of SIDES) expect(side.label).toBeTruthy()
  })
})

describe('a connector remembers which side it uses', () => {
  const edge = (extra = {}) => ({
    id: 'e1',
    source: 'src:1',
    target: 'dest:1',
    data: { discovered: false, phase: null },
    ...extra,
  })

  it('saves the handles when the user chose sides', () => {
    const saved = serializeEdge(edge({ sourceHandle: 'n', targetHandle: 's' }))
    expect(saved.sourceHandle).toBe('n')
    expect(saved.targetHandle).toBe('s')
  })

  it('omits them entirely when it did not', () => {
    /* Not written as null. An edge nobody re-routed has to serialize byte-identically to the
       way it did before sides existed, or every diagram in the database reads as dirty the
       moment it is opened -- `graphFingerprint` compares the document. */
    const saved = serializeEdge(edge())
    expect('sourceHandle' in saved).toBe(false)
    expect('targetHandle' in saved).toBe(false)
  })

  it('omits them for an explicit null, which is what React Flow puts there', () => {
    const saved = serializeEdge(edge({ sourceHandle: null, targetHandle: null }))
    expect('sourceHandle' in saved).toBe(false)
    expect('targetHandle' in saved).toBe(false)
  })

  it('round-trips a hand-routed connector', () => {
    const routed = serializeEdge(edge({ sourceHandle: 'n', targetHandle: 'w' }))
    const back = toFlowEdge(routed)
    expect(back.sourceHandle).toBe('n')
    expect(back.targetHandle).toBe('w')
  })

  it('leaves an un-routed connector on the default pair', () => {
    const back = toFlowEdge(serializeEdge(edge()))
    expect('sourceHandle' in back).toBe(false)
    expect('targetHandle' in back).toBe(false)
  })
})

/*
 * The hand-drawn route: line style and waypoints.
 *
 * Same migration hazard as the handles above, and the same fix -- both keys are omitted when
 * absent rather than written as defaults. `graphFingerprint` compares the serialized document, so
 * an edge that emitted `line: "orthogonal", waypoints: []` would make every diagram in the
 * database read as dirty the moment it was opened, with an unsaved-changes dot nobody could
 * account for.
 */
describe('a connector remembers how it was routed', () => {
  const edge = (data = {}) => ({
    id: 'e1',
    source: 'src:1',
    target: 'dest:1',
    data: { discovered: false, phase: null, ...data },
  })

  it('saves the line style and the bends', () => {
    const saved = serializeEdge(
      edge({ line: 'curved', waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }),
    )
    expect(saved.line).toBe('curved')
    expect(saved.waypoints).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }])
  })

  it('omits both when the connector was never re-routed', () => {
    const saved = serializeEdge(edge())
    expect('line' in saved).toBe(false)
    expect('waypoints' in saved).toBe(false)
  })

  it('omits the bends when the last one has been removed', () => {
    /* Straightening a connector has to leave it byte-identical to one that was never bent, or the
       diagram stays permanently dirty after an edit that undid itself. */
    const saved = serializeEdge(edge({ waypoints: [] }))
    expect('waypoints' in saved).toBe(false)
  })

  it('rounds the bends, like every other stored coordinate', () => {
    const saved = serializeEdge(edge({ waypoints: [{ x: 10.4, y: 20.6 }] }))
    expect(saved.waypoints).toEqual([{ x: 10, y: 21 }])
  })

  it('round-trips a bent, curved connector', () => {
    const routed = serializeEdge(edge({ line: 'curved', waypoints: [{ x: 5, y: 6 }] }))
    const back = toFlowEdge(routed)
    expect(back.data.line).toBe('curved')
    expect(back.data.waypoints).toEqual([{ x: 5, y: 6 }])
    /* And back out again unchanged, which is the property that actually matters: a save, an open
       and a second save must produce the same bytes. */
    expect(serializeEdge(back)).toEqual(routed)
  })

  it('leaves an un-routed connector carrying neither key through the round trip', () => {
    const back = toFlowEdge(serializeEdge(edge()))
    expect(back.data.line).toBeUndefined()
    expect(back.data.waypoints).toBeUndefined()
    expect(serializeEdge(back)).toEqual(serializeEdge(edge()))
  })
})

/*
 * Free anchors: a connector that meets a component anywhere along its border.
 *
 * The encoding rides in `sourceHandle`/`targetHandle`, which already persist -- so what needs pinning
 * is that a *fixed* handle never parses as a free one (or every existing edge would be re-resolved
 * from a fraction it does not have) and that a malformed one fails closed rather than drawing an edge
 * end into empty space.
 */
describe('free border anchors', () => {
  it('round-trips a side and a fraction', () => {
    expect(parseFreeHandle(encodeFreeHandle('right', 0.73))).toEqual({ side: 'right', t: 0.73 })
    expect(parseFreeHandle(encodeFreeHandle('top', 0))).toEqual({ side: 'top', t: 0 })
    expect(parseFreeHandle(encodeFreeHandle('bottom', 1))).toEqual({ side: 'bottom', t: 1 })
  })

  it('rounds to two places, so a saved handle id does not differ every save', () => {
    expect(encodeFreeHandle('left', 0.7333333)).toBe('free:left:0.73')
  })

  it('clamps a fraction outside the border', () => {
    expect(parseFreeHandle(encodeFreeHandle('right', 4)).t).toBe(1)
    expect(parseFreeHandle(encodeFreeHandle('right', -2)).t).toBe(0)
  })

  it('does not mistake a fixed handle for a free one', () => {
    /* The load-bearing case. Every edge in every saved diagram has `e`, `w`, `n`, `s` or null here,
       and reading one as a free anchor would re-resolve it from a fraction it does not have. */
    for (const id of [...SIDES.map((side) => side.id), null, undefined, '', 'freehand']) {
      expect(parseFreeHandle(id), String(id)).toBeNull()
    }
  })

  it('fails closed on a malformed anchor', () => {
    /* Handle ids are persisted and therefore hand-editable. Falling back to null puts the edge on the
       fixed handle React Flow already has, instead of drawing an end off the side of the card. */
    for (const id of ['free:sideways:0.5', 'free:right:abc', 'free:right:2', 'free:right:-1', 'free:']) {
      expect(parseFreeHandle(id), id).toBeNull()
    }
  })
})

describe('pointOnBorder', () => {
  const box = { x: 100, y: 200, width: 200, height: 60 }

  it('places a point along each side', () => {
    expect(pointOnBorder(box, { side: 'left', t: 0.5 })).toEqual({ x: 100, y: 230, position: 'left' })
    expect(pointOnBorder(box, { side: 'right', t: 0.5 })).toEqual({ x: 300, y: 230, position: 'right' })
    expect(pointOnBorder(box, { side: 'top', t: 0.25 })).toEqual({ x: 150, y: 200, position: 'top' })
    expect(pointOnBorder(box, { side: 'bottom', t: 1 })).toEqual({ x: 300, y: 260, position: 'bottom' })
  })

  it('reports the side, so the router gets a direction as well as a point', () => {
    /* Without this the line would leave a right-hand anchor heading whichever way the default handle
       faced, which for a hand-placed anchor is the one thing it must not do. */
    for (const side of ['left', 'right', 'top', 'bottom']) {
      expect(pointOnBorder(box, { side, t: 0.5 }).position).toBe(side)
    }
  })

  it('agrees with the fixed handle at the midpoint', () => {
    /* A free anchor at t=0.5 is the fixed handle. If the two disagreed, dragging an anchor to the
       middle of a side would visibly jump. */
    expect(pointOnBorder(box, { side: 'right', t: 0.5 })).toEqual({
      x: box.x + box.width,
      y: box.y + box.height / 2,
      position: 'right',
    })
  })
})

describe('nearestBorder', () => {
  const size = { width: 200, height: 60 }

  it('snaps to whichever border the pointer is closest to', () => {
    expect(nearestBorder({ x: 4, y: 30 }, size).side).toBe('left')
    expect(nearestBorder({ x: 196, y: 30 }, size).side).toBe('right')
    expect(nearestBorder({ x: 100, y: 2 }, size).side).toBe('top')
    expect(nearestBorder({ x: 100, y: 58 }, size).side).toBe('bottom')
  })

  it('reports the fraction along that border', () => {
    expect(nearestBorder({ x: 2, y: 15 }, size).t).toBeCloseTo(0.25)
    expect(nearestBorder({ x: 150, y: 1 }, size).t).toBeCloseTo(0.75)
  })

  it('reports the distance, so the caller can decide the dot is not close enough', () => {
    expect(nearestBorder({ x: 100, y: 30 }, size).distance).toBe(30)
    expect(nearestBorder({ x: 1, y: 30 }, size).distance).toBe(1)
  })

  it('clamps the fraction and survives a zero-sized node', () => {
    /* An unmeasured node reports no size, and dividing by it would put the anchor at NaN -- which in
       a path string makes the whole edge vanish. */
    const zero = nearestBorder({ x: 0, y: 0 }, { width: 0, height: 0 })
    expect(Number.isFinite(zero.t)).toBe(true)
    expect(zero.t).toBeGreaterThanOrEqual(0)
    expect(zero.t).toBeLessThanOrEqual(1)
  })
})
