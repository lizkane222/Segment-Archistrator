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
