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
 * ## Encoded as a string, but carried in `data`, not in the handle id
 *
 * A free anchor is `free:<side>:<t>` -- `free:right:0.73` is 73% of the way down the right-hand
 * edge. It used to ride in `sourceHandle` itself, which seemed like the one place the fact needed
 * to live -- until it turned out React Flow will not draw an edge end from a handle id it cannot
 * find in the node's *registered* bounds, and a free anchor's own handle exists only for the
 * instant it is being dragged (see ConnectionHandles.jsx). Putting the anchor there meant every
 * connector that used one silently failed to render the moment the drag ended: not misplaced, not
 * degraded, simply never drawn, forever. `sourceHandle`/`targetHandle` therefore always carry a
 * fixed id (`fixedHandleForSide` below), so React Flow's own resolution always succeeds, and the
 * precise point rides in `data.sourceAnchor` instead -- see `serializeEdge` and `toFlowEdge`.
 *
 * ## Why the *edge* has to resolve it
 *
 * `data.sourceAnchor` only ever names a handle that is not currently mounted, so `FlowEdge`
 * computes the point itself from the node's box rather than asking React Flow to; see
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
 * Where several connectors meeting the same side of the same component should each sit on it.
 *
 * ## The problem
 *
 * Every connector attaching to a side landed on that side's *midpoint*, because that is where the
 * handle is. So four edges leaving one card's right-hand side shared an identical start point and an
 * identical first 20px, and -- since the router puts its crossbar halfway between the two gapped
 * points, and a column of targets shares an x -- frequently an identical crossbar as well. Four lines
 * were drawn as one line with four stubs, and no reader could tell which went where. The free border
 * anchor was built to fix this by hand, one drag at a time; this does it for the default case, which
 * is the case nearly every diagram is in.
 *
 * ## The rules that matter
 *
 * A side with **one** connector gets no entry at all, so it keeps the midpoint and every diagram that
 * has no fan-out is untouched. `(i + 1) / (n + 1)` spreads n of them evenly and symmetrically about
 * the middle, so two sit at 1/3 and 2/3 rather than one of them staying put and the other moving.
 *
 * `order` decides which connector gets which slot, and it has to be a property of the *geometry* --
 * the opposite end's position along the side's perpendicular axis -- so that lines fan out without
 * crossing each other. Ties break on `key`, which is stable, because two edges to the same place must
 * not swap slots between renders. Anything already carrying a hand-placed anchor is excluded by the
 * caller and keeps it: this fills silence, it does not overrule a choice.
 *
 * Pure, and takes plain attachment records rather than edges, so the geometry it needs is the caller's
 * problem and this stays testable against numbers.
 *
 * @param attachments `[{key, nodeId, side, order}]` -- one per edge *end*, hand-anchored ends omitted
 * @returns Map of `key` to the fraction along that side
 */
export function fanOutAnchors(attachments) {
  const bySide = new Map()
  for (const item of attachments ?? []) {
    if (!item || item.nodeId == null || !item.side) continue
    const at = `${item.nodeId}|${item.side}`
    if (!bySide.has(at)) bySide.set(at, [])
    bySide.get(at).push(item)
  }

  const spread = new Map()
  for (const group of bySide.values()) {
    /* One connector keeps the midpoint. This is what makes the whole thing inert for a diagram with
       no fan-out, and it is why there is no entry rather than an entry of 0.5. */
    if (group.length < 2) continue
    group.sort(
      (a, b) =>
        (Number(a.order) || 0) - (Number(b.order) || 0) ||
        String(a.key).localeCompare(String(b.key)),
    )
    group.forEach((item, index) => spread.set(item.key, (index + 1) / (group.length + 1)))
  }
  return spread
}

/**
 * Which side of `from` faces `to` -- a `Position` string, ready for `fixedHandleForSide`.
 *
 * ## What this is for
 *
 * A connector's handle says which side of a component the line leaves or arrives on, and it is stored
 * once. Move either component afterwards and that side can end up pointing the wrong way: draw A to a B
 * on its right, then drag B to the far left, and the line still leaves A's *east* side -- so it exits
 * east, turns, and crosses back over the component it just left. Measured across the saved diagrams, 13
 * connector ends were in that state, one of them facing away by 2095px.
 *
 * The event was never going backwards -- the walk only ever follows connectors out of a component, and
 * that holds for all 294 hops in those diagrams. It is the first *leg of the line* that doubles back,
 * which is what reads as backflow.
 *
 * ## The rule, and what it must not touch
 *
 * Whichever axis the two centres are further apart on wins, and then the sign picks the side. Centres
 * rather than nearest edges, so the answer does not flip when two components overlap slightly.
 *
 * Applied only where the reader has expressed no preference: an end carrying a hand-placed anchor is a
 * decision and is left exactly as it is, and no stored diagram is rewritten on open. A handle chosen
 * deliberately to route a line around something would otherwise be undone by the tool.
 */
export function facingSide(from, to) {
  if (!from || !to) return null
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/**
 * A registry anchor as the string an edge stores, or `undefined` when the drag left no point.
 *
 * `undefined` rather than `null` on purpose: the caller spreads the result into `edge.data`, and this
 * is the value that makes an anchor *go away* -- `serializeEdge` omits a falsy one, and `anchorPoint`
 * in edges/FlowEdge.jsx falls back to the fixed handle. Clearing matters as much as setting, because
 * an anchor left over from where an end used to be attached outvotes the handle it was just moved to.
 */
export function anchorStringFor(anchor) {
  return anchor ? encodeFreeHandle(anchor.side, anchor.t) : undefined
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
 * The fixed handle id a free anchor's `side` names -- `'right'` -> `'e'` and so on.
 *
 * React Flow resolves an edge end by looking `sourceHandle`/`targetHandle` up in the node's
 * *registered* handle bounds, and a free anchor's own handle is only ever mounted for the
 * instant it is being dragged (see ConnectionHandles.jsx) -- a moment later there is nothing
 * registered under `free:right:0.73`, and React Flow does not fall back to drawing the edge
 * from *somewhere*, it declines to draw the edge at all. So the id that actually goes into
 * `sourceHandle`/`targetHandle` has to be one of the four fixed ids that stay registered for
 * the node's whole lifetime; the free anchor's precise point travels separately, in the edge's
 * `data` (see `anchorPoint` in edges/FlowEdge.jsx).
 */
export function fixedHandleForSide(side) {
  return SIDE_BY_POSITION.get(side)?.id ?? null
}

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

/* --- how close the pointer is ------------------------------------------------ */

/*
 * Two proximity tests, because "is the pointer near this node" has two useful answers and
 * they are not the same question.
 *
 * `distanceToBox` is about the node as a whole -- how far away is it? That is what a
 * connection drag asks: a drag crossing the middle of a card is heading for that card, so
 * its handles have to be showing by then.
 *
 * `alongBorder` is about the edge specifically -- is the pointer where a connector would
 * leave? That is what an idle hover asks. The distinction matters most on a zone, which is
 * hundreds of pixels of backdrop the pointer crosses on its way to everything else: showing
 * its four dots because the pointer passed through the middle of Connections is what made
 * them flicker on and off across the whole region.
 *
 * Both take a box and a point in the *same* coordinate space -- flow units, absolute. The
 * caller converts, because only it knows the zoom.
 */

/** How far `point` is from `box`. Zero when it is inside. */
export function distanceToBox(box, point) {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width))
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height))
  return Math.hypot(dx, dy)
}

/**
 * Is `point` within `reach` of `box`'s border, from either side of it?
 *
 * Deliberately both sides. Approaching a card from outside and sliding along the inside of
 * its edge are the same gesture to the person doing it, and a test that only counted one of
 * them would make the handles appear at a different moment depending on which direction the
 * pointer arrived from.
 *
 * The middle of a large box is not near its border, which is the whole point: `inset` is the
 * distance to the *nearest* edge, so a point in the centre of a 900px zone is 450 from the
 * border and fails, while every point in a 60px-tall card passes -- which is right, because
 * on a card that small there is no middle to speak of.
 */
export function alongBorder(box, point, reach) {
  if (distanceToBox(box, point) > reach) return false
  const local = { x: point.x - box.x, y: point.y - box.y }
  const inset = Math.min(
    Math.max(local.x, 0),
    Math.max(local.y, 0),
    Math.max(box.width - local.x, 0),
    Math.max(box.height - local.y, 0),
  )
  return inset <= reach
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
