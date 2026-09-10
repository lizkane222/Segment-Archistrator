/*
 * Where a connector may leave or arrive on a component or a zone.
 *
 * There used to be two handles: a target on the left and a source on the right. That encodes
 * a left-to-right pipeline, which a Segment architecture mostly is -- and then a connector
 * that has to go *back* (a Reverse ETL model feeding a source, an audience feeding a
 * destination that sits to its left) leaves the right edge, loops all the way round the card
 * and comes back in on the left. The line crosses the component it is about, which is the
 * one thing a connector must not do.
 *
 * So: four sides, and each of them is both an exit and an entrance.
 *
 * ## Why eight handles and not four
 *
 * React Flow stores a node's handle geometry as two lists, `handleBounds.source` and
 * `handleBounds.target`, and an edge end resolves its position by looking in the list for
 * *its* end's type. A side declared only as a source therefore has no geometry an edge can
 * arrive at -- the edge would be in the store, valid, and drawn with one end nowhere. Two
 * stacked handles per side, one of each type sharing an id, is what puts every side in both
 * lists.
 *
 * `ConnectionMode.Loose` is the other half (set on the ReactFlow element). With eight
 * overlapping handles, whichever of a stacked pair is on top is what the pointer lands on --
 * so a drop aimed at a side would be refused half the time under Strict mode, depending on
 * which type happened to be painted last. Loose lets either of the pair accept the
 * connection, which makes "drop on this side" mean the side rather than one of two invisible
 * halves of it.
 *
 * ## Why the order in this list matters
 *
 * An edge saved before this existed has `sourceHandle: null` and `targetHandle: null`, and
 * React Flow resolves a null handle id to the *first* entry in the relevant list. So the
 * first side rendered as a source has to be the one the old single source handle was on
 * (east), and the first rendered as a target has to be west -- otherwise every edge in every
 * saved diagram would quietly move to a different side of its component on the next open.
 * `SIDES` is in that order and both node renderers iterate it directly; see the tests in
 * canvas/handles.test.js, which pin exactly that.
 */

import { Position } from '@xyflow/react'

/*
 * East and west first, in that order, for the backwards-compatibility reason above. North and
 * south after them, which is also the order they are least often used in -- a diagram read
 * left to right uses the horizontal pair for the flow and the vertical pair for the
 * exceptions.
 */
export const SIDES = [
  { id: 'e', position: Position.Right, label: 'right' },
  { id: 'w', position: Position.Left, label: 'left' },
  { id: 'n', position: Position.Top, label: 'top' },
  { id: 's', position: Position.Bottom, label: 'bottom' },
]

/** The handle id the two legacy handles resolve to, for the migration test to name. */
export const LEGACY_SOURCE = 'e'
export const LEGACY_TARGET = 'w'

/* --- a connector that meets a component anywhere along its border ------------ */

/*
 * The four fixed sides cover the common case and are wrong for one real one: several connectors
 * arriving at the same side of the same component all land on the same pixel, so they overlap for
 * their last 20px and a reader cannot tell which line goes where. Spreading them along the border is
 * the fix, and it needs a point that is not a midpoint.
 *
 * ## Encoded in the handle id, not in a new field
 *
 * A free anchor is `free:<side>:<t>` -- `free:right:0.73` is 73% of the way down the right-hand
 * edge. It rides in `sourceHandle`/`targetHandle`, which already persist and already round-trip
 * (see `serializeEdge`), so this needs no new document key and no migration.
 *
 * The alternative was `data.sourceAnchor = {side, t}`, which reads better and would have been a
 * second place the same fact lives: React Flow puts the handle a connection was drawn from into
 * `sourceHandle` whatever we do, so an anchor stored beside it could disagree with it. One field.
 *
 * ## Why the *edge* has to resolve it
 *
 * The handle a free anchor names exists only while the pointer is near that border -- it follows the
 * cursor and then goes away. React Flow resolves an edge end by looking the handle id up in the
 * node's registered bounds, so a moment after the drag it would find nothing and draw that end at
 * the node's origin. So `FlowEdge` computes the point itself from the node's box; see
 * `pointOnBorder`.
 */

const FREE_PREFIX = 'free'

/** `('right', 0.73)` -> `'free:right:0.73'`. Rounded to two places: a diagram does not need more, and
    an unrounded float makes the stored handle id differ on every save. */
export function encodeFreeHandle(side, t) {
  const clamped = Math.min(1, Math.max(0, Number(t) || 0))
  return `${FREE_PREFIX}:${side}:${clamped.toFixed(2)}`
}

/**
 * `'free:right:0.73'` -> `{side: 'right', t: 0.73}`, or null for a fixed handle.
 *
 * Tolerant, because a handle id is persisted and therefore hand-editable: an unknown side or an
 * out-of-range fraction resolves to null rather than to a point off the side of the component, so a
 * malformed anchor falls back to the fixed handle React Flow already has instead of drawing an edge
 * end into empty space.
 */
export function parseFreeHandle(id) {
  if (typeof id !== 'string' || !id.startsWith(`${FREE_PREFIX}:`)) return null
  const [, side, raw] = id.split(':')
  if (!SIDE_BY_POSITION.has(side)) return null
  const t = Number(raw)
  if (!Number.isFinite(t) || t < 0 || t > 1) return null
  return { side, t }
}

/* Keyed by React Flow's `Position` string, which is what a free handle stores -- the same vocabulary
   `sourcePosition` uses, so the edge can hand it straight back to the router. */
const SIDE_BY_POSITION = new Map(SIDES.map((side) => [side.position, side]))

/**
 * Where on a node's border a free anchor sits, in flow coordinates.
 *
 * @param box  `{x, y, width, height}` -- the node's absolute box
 * @returns `{x, y, position}`, where `position` is the side, so a caller gets the direction the line
 *   should leave along as well as the point it leaves from.
 */
export function pointOnBorder(box, { side, t }) {
  const { x, y, width, height } = box
  switch (side) {
    case 'left':
      return { x, y: y + height * t, position: 'left' }
    case 'right':
      return { x: x + width, y: y + height * t, position: 'right' }
    case 'top':
      return { x: x + width * t, y, position: 'top' }
    default:
      return { x: x + width * t, y: y + height, position: 'bottom' }
  }
}

/**
 * The nearest border to a point inside a node's box, as a side and a fraction along it.
 *
 * Used while hovering: the dot that appears under the cursor is this, and dragging from it is what
 * creates the anchor. Distance to each of the four edges, nearest wins -- so the dot snaps to the
 * border the pointer is closest to rather than jumping between two when the cursor is near a corner.
 *
 * @param local  the pointer, relative to the node's top-left
 */
export function nearestBorder(local, size) {
  const { x, y } = local
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)

  const distances = [
    { side: 'left', distance: x, t: y / height },
    { side: 'right', distance: width - x, t: y / height },
    { side: 'top', distance: y, t: x / width },
    { side: 'bottom', distance: height - y, t: x / width },
  ]
  const nearest = distances.reduce((best, entry) => (entry.distance < best.distance ? entry : best))
  return {
    side: nearest.side,
    t: Math.min(1, Math.max(0, nearest.t)),
    distance: nearest.distance,
  }
}
