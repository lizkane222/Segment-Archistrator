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

import { LEGACY_SOURCE, LEGACY_TARGET, SIDES } from './handles.js'
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
