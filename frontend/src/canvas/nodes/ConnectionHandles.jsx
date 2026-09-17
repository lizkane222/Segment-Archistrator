/*
 * The four sides a connector can leave from or arrive at, drawn.
 *
 * One component for both node renderers, because a component and a zone have to agree about
 * this exactly: an edge between them stores a handle id, and if the two disagreed about what
 * `n` means the edge would be drawn to a different side depending on which end you looked
 * from. See canvas/handles.js for why each side is two stacked handles rather than one.
 *
 * ## Hidden until something is reaching for them
 *
 * The dots appear when the pointer is at this node's border, or when a connection drag comes
 * within reach of it, and are invisible otherwise. See the note on the component itself for why
 * that test rather than hover, and why they fade rather than unmount.
 *
 * ## Always dead centre
 *
 * The four fixed handles sit at the midpoint of their side, on every node, with no exceptions.
 * Zones used to take them at 70% along the edge to dodge the resize handles NodeResizer draws
 * at the same midpoints -- which meant a connector between a zone and a component met the two
 * at visibly different heights, and the line acquired a kink that looked like a routing bug.
 *
 * The collision is real but it costs nothing to lose: `NodeResizer` on a zone is given a
 * visible `lineStyle`, and that line is draggable along its whole length. So an edge-resize
 * still works anywhere on the border except the pixels at the midpoint, and the corners are
 * untouched. The connection handle wins that overlap deliberately, via `zIndex` -- it is the
 * smaller target and the one with no alternative.
 *
 * ## And one that is not fixed at all -- but is not a sixth thing to hover into being either
 *
 * A connector can still meet a component anywhere along its border, not only at a midpoint --
 * that matters as soon as three lines arrive at the same side, where they would otherwise overlap
 * for their last 20px with no way to tell which goes where. But that free anchor used to be its
 * own always-mounted overlay across the whole card, tracking the pointer on every hover regardless
 * of whether anyone meant to start a connection. Two things were paid for that: a zone's header sat
 * *under* it (an absolutely-positioned sibling always wins the paint order over a static one,
 * regardless of source order), so the header could not be dragged or show its own cursor; and the
 * fixed handles' own hover state fought the overlay for the same pixels.
 *
 * So a free anchor is drag-only now, and only ever follows a drag that started on *this* node's own
 * fixed handle: while `useConnection()` reports this node as the drag's origin, the dot tracks
 * wherever the pointer is nearest this node's border and stops updating (rather than disappearing)
 * once the pointer leaves that node for good. It is purely a visual now, `pointer-events: none` --
 * the gesture is already underway, captured on the fixed handle it actually began on -- and the
 * point it last found is instead spliced into the finished edge's `sourceHandle` by Canvas's
 * `onConnect`, via the registry in canvas/chrome.js. See `dragAnchor` there.
 *
 * A free anchor's handle still exists only for the moment it is drawn, which is why the *edge*
 * resolves its geometry rather than React Flow: a moment after the drag the handle is gone, and
 * React Flow's own lookup would put that end of the line at the node's origin. See canvas/handles.js
 * and `anchorPoint` in edges/FlowEdge.jsx.
 */

import { useEffect, useMemo, useRef, Fragment } from 'react'
import { Handle, useConnection, useInternalNode, useNodeId, useReactFlow } from '@xyflow/react'

import { useChrome, useHandlesRevealed } from '../chrome.js'
import { SIDES, distanceToBox, encodeFreeHandle, nearestBorder } from '../handles.js'

/*
 * How close to a border a drag has to pass before it counts as "along this border" rather than
 * "crossing the middle of the card on its way out".
 *
 * In flow units, divided by the current zoom at the moment it matters: a fixed number of flow units
 * is a strip that shrinks to nothing zoomed out and swamps the whole card zoomed in, and dividing by
 * zoom keeps it the same width to the pointer at every zoom level.
 *
 * The comment here used to say `connection.to` "is already in flow coordinates". It is not, and that
 * mistaken premise was the whole bug. React Flow draws the connection line into an *untransformed*
 * container sized to the viewport, so `to` and `pointer` are container-relative screen pixels, while
 * a node's `positionAbsolute` is flow units. Subtracting one from the other only agrees at zoom 1
 * with no pan; at anything else the "nearest border point" was computed from two different coordinate
 * systems and clamped to whichever corner the arithmetic fell off -- which is why the anchors already
 * in the database cluster at exactly 0.00 and 1.00. `toFlow` below is the missing conversion.
 */
const BORDER_REACH = 14

/*
 * How far outside a node a connection drag counts as "coming here".
 *
 * Wider than the node, which is the point: the dots have to be showing *before* the pointer
 * arrives, or the drop target appears at the moment it is being aimed at and the user is
 * aiming at nothing. Paired with `connectionRadius` on the flow itself (Canvas.jsx), which is
 * the other half -- this decides when the target is *visible*, that decides how close the
 * release has to be to land on it, and a visible target that cannot be hit is worse than none.
 *
 * In flow units, divided by the zoom where it is used, for the same reason BORDER_REACH is.
 */
const DRAG_REACH = 90

/**
 * @param border  the node's border colour, so the dots read as belonging to it
 *
 * The dots are hidden until something is reaching for them, and there are exactly two things
 * that count: the pointer at this node's border (`useHandlesRevealed`, published by the canvas
 * -- see `handleReveal` in canvas/chrome.js) and a connection drag within `DRAG_REACH` of this
 * node's box.
 *
 * They used to be permanently visible -- faint on a card, solid on a zone. Two problems, and
 * the second is why the fix is not simply `group-hover`: four dim marks on a 200px card are
 * furniture on every one of them at once, and a zone is a backdrop the pointer crosses on its
 * way to everything else, so hover alone flickered its handles across the whole region. Border
 * proximity is the test that means the same thing on both.
 */
export default function ConnectionHandles({ border, free = true }) {
  const nodeId = useNodeId()
  const node = useInternalNode(nodeId)
  const connection = useConnection()
  const { getZoom, getViewport } = useReactFlow()
  const { dragAnchor } = useChrome()

  /*
   * A point React Flow reported during a connection, in flow units.
   *
   * `getViewport()` rather than a `useViewport()` subscription on purpose: this is only ever read
   * inside a render that a connection update already triggered, so an imperative read is enough and a
   * subscription would re-render every node on the canvas on every pan and zoom.
   */
  const toFlow = (point) => {
    if (!point) return null
    const view = getViewport()
    return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom }
  }

  /* The pointer is at this node's border. A boolean off an external store, so the other 299
     nodes do not re-render to find out it was not them. */
  const hovered = useHandlesRevealed(nodeId)

  const box = useMemo(() => {
    const at = node?.internals?.positionAbsolute
    const width = node?.measured?.width
    const height = node?.measured?.height
    if (!at || !width || !height) return null
    return { x: at.x, y: at.y, width, height }
  }, [node?.internals?.positionAbsolute, node?.measured?.width, node?.measured?.height])

  /*
   * A connection drag is in the neighbourhood.
   *
   * A *selector* returning a boolean rather than the whole connection state, which is what
   * keeps this affordable: `connection.to` changes on every pointer frame of a drag, so an
   * unselected subscription re-renders every node on the canvas sixty times a second for the
   * length of the gesture. A boolean changes twice -- when the drag comes into reach and when
   * it leaves -- and React Flow compares snapshots shallowly, so that is how often this node
   * re-renders.
   */
  const dragNearby = useConnection((state) => {
    if (!state.inProgress || !state.pointer || !box) return false
    return distanceToBox(box, toFlow(state.pointer)) <= DRAG_REACH / getZoom()
  })

  /*
   * This node is part of the live gesture: either it is where the drag began, or the pointer is
   * currently at its border and it is where the drag may land.
   *
   * `dragNearby` is the second half, and including it here is what finally lets an *arriving* end
   * remember where it was dropped. Only the origin used to qualify, so `data.targetAnchor` -- read,
   * stored, reversed and tested everywhere else in the app -- was written by nothing at all, and every
   * connector's target end snapped to one of four side midpoints however carefully it was placed.
   *
   * A node cannot be both ends of one connection, so the two cases cannot fight over the same entry.
   */
  const origin = connection.fromNode?.id === nodeId
  const dragging = free && connection.inProgress && (origin || dragNearby)
  /* The node the drag started from keeps its dots throughout, even once the pointer has left:
     the gesture is anchored there, and its own handles disappearing mid-drag reads as the
     connection having been dropped. */
  const visible = hovered || dragNearby || dragging

  /*
   * The last border point a live drag from this node passed near, kept once the pointer moves on
   * rather than cleared -- the whole point is that the connection ends up attached to wherever the
   * drag *was*, not to wherever it happens to be when it finally lands on some other node.
   *
   * A ref, not state: nothing outside this render needs a re-render when it changes, only this
   * component's own next paint of the dot -- the same reasoning as `committed` in FlowEdge.jsx.
   */
  const lastAnchor = useRef(null)
  if (!dragging) {
    lastAnchor.current = null
  } else if (box && connection.pointer) {
    /*
     * `pointer`, not `to`. React Flow snaps `to` onto the nearest handle inside `connectionRadius`
     * once it finds a valid one -- so an end dropped a third of the way down a border reported the
     * *midpoint*, and the anchor recorded the snap instead of the intent. `pointer` is the raw
     * position, published for exactly this kind of need, and the snapping stays where it is useful:
     * deciding which node and which side the connection lands on.
     */
    const at = toFlow(connection.pointer)
    const found = nearestBorder(
      { x: at.x - box.x, y: at.y - box.y },
      { width: box.width, height: box.height },
    )
    /*
     * The two ends want different rules, because the pointer does different things at each.
     *
     * At the *arriving* end it comes from outside and may be released without ever crossing the
     * border, so anywhere within `BORDER_REACH` of it counts -- that is the drop.
     *
     * At the *origin* it starts on a handle and then leaves, and "within reach of the border" stays
     * true for part of the way out. A drag heading off diagonally therefore kept re-recording, and the
     * last sample before it went out of range was wherever it happened to clip the edge -- so a
     * connector grabbed by the middle handle left from a corner instead. That is what put nearly every
     * stored `sourceAnchor` at exactly 0.00 or 1.00. Restricting it to while the pointer is still
     * *on* the node keeps the intended gesture (slide along the border to choose where to leave from)
     * and drops the accidental one.
     */
    const inReach =
      origin
        ? distanceToBox(box, at) === 0
        : found.distance <= BORDER_REACH / getZoom()
    if (inReach) {
      lastAnchor.current = { side: found.side, t: found.t }
    }
  }
  const anchor = dragging ? lastAnchor.current : null

  /* Published for Canvas's `onConnect` to read once, on release -- see canvas/chrome.js. No
     dependency array, deliberately, the same reasoning as the route publish in FlowEdge.jsx: this
     is derived entirely from this render's own output, so a dependency list would only ever be a
     list that always fires while pretending to be a filter. */
  useEffect(() => {
    if (anchor) dragAnchor?.set(nodeId, anchor.side, anchor.t)
  })

  /* Shared by the two markers below, so the dot the drag leaves behind looks the same at either end. */
  const markerStyle = anchor
    ? {
        borderColor: border,
        /* Above the four fixed dots and above the resizer. */
        zIndex: 6,
        ...(anchor.side === 'left' || anchor.side === 'right'
          ? { top: `${anchor.t * 100}%` }
          : { left: `${anchor.t * 100}%` }),
      }
    : null

  return (
    <>
      {/*
        * The origin end's marker is a real `Handle`; the arriving end's is a plain div that looks
        * identical.
        *
        * Not a stylistic choice. A `Handle` registers itself in the node's `handleBounds`, and
        * `connectionRadius` resolves a drop to the *nearest registered handle* -- so a `free:...`
        * handle mounted on the node being dropped onto would sit right under the cursor, win that
        * contest, and put a free id into the finished edge's `targetHandle`. React Flow cannot resolve
        * such an id on a later render (the dot is gone by then), which makes the edge undrawable: it
        * raises `008` and returns null before `FlowEdge` is ever mounted. The precise point belongs in
        * `data.targetAnchor`, and nowhere near a handle field.
        *
        * The origin end is safe because its gesture was already captured by the fixed handle it began
        * on, which is why that one can stay as it was.
        */}
      {anchor && origin && (
        <Handle
          type="source"
          id={encodeFreeHandle(anchor.side, anchor.t)}
          position={anchor.side}
          className="pointer-events-none !h-3 !w-3 !border-2 !bg-white"
          style={markerStyle}
        />
      )}
      {anchor && !origin && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white"
          style={{
            ...markerStyle,
            /* A `Handle` gets its side offset from `position`; a bare div has to be told. */
            ...(anchor.side === 'left' ? { left: 0 } : {}),
            ...(anchor.side === 'right' ? { left: '100%' } : {}),
            ...(anchor.side === 'top' ? { top: 0 } : {}),
            ...(anchor.side === 'bottom' ? { top: '100%' } : {}),
          }}
        />
      )}

      <FixedHandles border={border} visible={visible} />
    </>
  )
}

function FixedHandles({ border, visible }) {
  return SIDES.map((side) => {
    /*
     * Both types per side, sharing an id, with the **source painted last** so the pointer lands on
     * the exit. Starting a connection is what the dot is mostly for, and `Loose` mode means the drop
     * end works regardless of which of the pair is on top.
     *
     * This used to be the other way round, and the comment here claimed the opposite of what the order
     * achieved: later means on top, so the pointer was landing on the *target*. React Flow reports a
     * drag begun on a target handle with the ends swapped, so every connector drawn by grabbing a dot
     * came out pointing backwards -- which is why whole saved diagrams read end-to-start.
     *
     * Direction no longer depends on this: `orientConnection` (canvas/direction.js) takes it from the
     * gesture. The order is right anyway, so the common case needs no correcting and the correction is
     * a safety net rather than the mechanism.
     */
    const shared = {
      id: side.id,
      position: side.position,
      /*
       * Faded out rather than unmounted, and that is not a detail. A handle React Flow has never
       * mounted has no geometry in `handleBounds`, so an edge naming it draws that end at the
       * node's origin (see the module header, and canvas/handles.js) -- every connector on the
       * canvas would jump to the corner of its card until the pointer visited it. Opacity zero
       * keeps the geometry and the hit area, so a drop still lands and the transition has
       * something to animate.
       *
       * `!h-3 !w-3` while visible: 8px was the size that made these hard to hit, and the moment
       * they are on screen is the moment they are being aimed at.
       */
      className: `pointer-events-auto !border-2 !bg-white transition-all duration-150 ${
        visible ? 'opacity-100 !h-3 !w-3' : 'opacity-0 !h-2 !w-2'
      }`,
      /* Above the resizer's own handles, which land on the same four midpoints while a zone is
         selected. Without this the user gets whichever was painted last, which is not something
         they can see or predict. */
      style: { borderColor: border, zIndex: 5 },
      title: `Drag to connect from the ${side.label}`,
    }
    return (
      <Fragment key={side.id}>
        <Handle type="target" {...shared} />
        <Handle type="source" {...shared} />
      </Fragment>
    )
  })
}
