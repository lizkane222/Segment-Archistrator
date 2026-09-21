/*
 * The connecting line, with one coloured overlay per scenario travelling it.
 *
 * Two jobs that pull in different directions, which is why this is a custom edge rather than a
 * styled builtin:
 *
 *  1. A builtin draws exactly one stroke, and two scenarios sharing an edge -- the same path with
 *     the insert function on and off -- have to both be visible on it. So: one grey base path,
 *     then a thin coloured path per scenario stacked on top, each offset along the dash cycle so
 *     they read as separate lines rather than as one line whose colour is whichever scenario
 *     happened to be drawn last.
 *  2. The route is the user's to edit. Line style and waypoints come off `data`, and the geometry
 *     is `edges/routing.js` -- pure, and tested against coordinates, because a line through the
 *     wrong place is a bug you can only see.
 *
 * ## The handles, and why they are DOM rather than SVG
 *
 * The waypoint controls go through `EdgeLabelRenderer`, which portals into the viewport. So they
 * pan and zoom with the diagram, they are inside what an export captures, and -- the reason that
 * settles it -- they are ordinary elements with ordinary pointer events. Dragging an SVG element
 * inside the edge layer means fighting React Flow's own pane handlers for the pointer, and the
 * `nodrag nopan` classes that opt out of those only work on DOM.
 *
 * Only drawn when the edge is selected. Handles on every edge all the time is a canvas covered in
 * dots, and worse, dots that sit exactly where the lines cross -- so clicking a line to select it
 * would be competing with the handles of the four edges near it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useNodesData,
  useReactFlow,
} from '@xyflow/react'

import { useChrome } from '../chrome.js'
import { flowsAlong } from '../direction.js'
import { parseFreeHandle, pointOnBorder } from '../handles.js'
import { borderColorFor } from '../kinds.js'
import { zoneNodeId } from '../layout.js'
import {
  cleanWaypoints,
  cornerHandles,
  dragCorner,
  dragSegment,
  insertWaypoint,
  lineStyleOf,
  moveWaypoint,
  removeWaypoint,
  routeEdge,
  segmentHandles,
} from './routing.js'

/*
 * Length of one colour's segment when several scenarios share an edge.
 *
 * They cannot be drawn side by side -- there is one path string and no perpendicular to offset
 * along -- so they interleave along it instead: each overlay dashes with a gap wide enough for all
 * the others and starts one segment further on. Two scenarios on one edge therefore alternate
 * blue, violet, blue, violet, and both are visibly present. Stacking them without this would draw
 * whichever one came last and silently hide the comparison.
 */
const SEGMENT = 11

/*
 * How long the line takes to take up its travelled colour, and to give it back.
 *
 * Comfortably shorter than the ~1s beat it sits inside, or the change would still be running when
 * the event had moved on. Long enough to be a fade rather than a cut: this is the trail the event
 * leaves, and a trail that snapped into place would read as the line switching on -- which is the
 * thing the moving event replaced.
 */
const GLOW_FADE_MS = 420

/*
 * What one drag gesture resolves to, given where the pointer is.
 *
 * One function, used for both the frame-by-frame preview and the value finally committed, so the two
 * cannot disagree about what the drag meant -- the bug where a line follows the cursor and then snaps
 * somewhere else on release.
 *
 * Three modes, and which one applies is a property of what was grabbed rather than a mode the user
 * chooses: a bar on an axis-aligned segment slides it, a dot on a real bend drags the corner (moving
 * both segments that meet there), and a dot on anything else moves a free waypoint.
 */
/**
 * Where one end of an edge sits when its handle is a free border anchor, or null for a fixed one.
 *
 * Returns null for an unmeasured node as well: a node reports no size for the frame after it mounts,
 * and a fraction of zero height is `NaN` -- which in a path string makes the entire edge disappear
 * rather than look wrong, and is far harder to diagnose than a line briefly on the wrong side.
 */
function anchorPoint(node, handleId) {
  const anchor = parseFreeHandle(handleId)
  if (!anchor || !node) return null
  const at = node.internals?.positionAbsolute
  const width = node.measured?.width
  const height = node.measured?.height
  if (!at || !width || !height) return null
  return pointOnBorder({ x: at.x, y: at.y, width, height }, anchor)
}

/**
 * Where this end sits once its side has been shared out between several connectors, or null when it
 * has not been -- see `fanOutAnchors` in canvas/handles.js.
 *
 * Separate from `anchorPoint` because the two answer different questions and must not be confused: an
 * anchor is a *stored* decision the reader made and always wins, while this is a derived arrangement
 * that exists only for as long as the siblings do. Nothing here is written to the document, so adding
 * or deleting a connector re-balances the rest with no migration and no dirty diagram.
 */
function spreadPoint(node, position, t) {
  if (t == null || !node || !position) return null
  const at = node.internals?.positionAbsolute
  const width = node.measured?.width
  const height = node.measured?.height
  if (!at || !width || !height) return null
  return pointOnBorder({ x: at.x, y: at.y, width, height }, { side: position, t })
}

/**
 * A node's centre in flow coordinates, or null while it is unmeasured.
 *
 * Centres rather than the border anchors the line is actually drawn between, because the menu
 * command that commits the change works from centres too (it has positions and chosen sizes,
 * not measured handle geometry). Both have to agree or the preview would animate one way and
 * the click would do the other -- which is the one thing a preview must not do.
 */
function centre(node) {
  const at = node?.internals?.positionAbsolute
  const width = node?.measured?.width
  const height = node?.measured?.height
  if (!at || !width || !height) return null
  return { x: at.x + width / 2, y: at.y + height / 2 }
}

function resolveDrag(gesture, point) {
  if (gesture.mode === 'slide') return dragSegment(gesture.points, gesture.index, point)
  if (gesture.mode === 'corner') return dragCorner(gesture.points, gesture.index, point)
  return moveWaypoint(gesture.list, gesture.index, point)
}

/* The three patterns the Edge Style tab offers. `undefined` for solid, matching how
   every other "unstyled" property in this app resolves -- an absent dash array is
   what a plain line is, not a fourth case for the renderer to carry. */
function dashArrayFor(strokeStyle) {
  if (strokeStyle === 'dashed') return '10 6'
  if (strokeStyle === 'dotted') return '2 4'
  return undefined
}

export default function FlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  selected,
}) {
  const { screenToFlowPosition } = useReactFlow()
  const { onWaypoints, adjustingEdgeId, walkthroughActive, flowPreview, routes, fanAnchors } =
    useChrome()
  /* Double-clicking the line puts it in adjust mode -- see Canvas's `onEdgeDoubleClick`. Held there
     rather than here so only one connector is ever in it: two edges showing handles at once means two
     sets of dots competing for the same few pixels wherever the lines cross. */
  const adjusting = adjustingEdgeId === id

  const line = lineStyleOf(data)
  const waypoints = cleanWaypoints(data?.waypoints)

  /*
   * The line's own colour, and the arrowheads that have to match it -- one fact, not two,
   * because an arrow in a different colour from the line it tips would read as a second
   * decision rather than a detail of the first.
   *
   * `data.color` is a manual override; short of that it is the *source* component's own
   * resolved border colour (see `borderColorFor`), read live off React Flow's store via
   * `useNodesData` rather than copied onto the edge -- so a source recoloured by dragging
   * it into a different zone changes every line leaving it without anything writing to
   * the edges themselves.
   */
  const sourceData = useNodesData(source)?.data
  const sourceZoneData = useNodesData(sourceData?.zone ? zoneNodeId(sourceData.zone) : null)?.data
  const color = data?.color ?? borderColorFor(sourceData, sourceZoneData)
  const dashArray = dashArrayFor(data?.strokeStyle)
  const arrowEnd = data?.arrowEnd ?? true
  const arrowStart = data?.arrowStart ?? false

  /*
   * A hand-placed anchor somewhere along a node's border, resolved here rather than by React Flow.
   *
   * It has to be here, and it has to come from `data.sourceAnchor` rather than `sourceHandleId`:
   * `sourceHandle`/`targetHandle` always name one of the four fixed handles now (see
   * `fixedHandleForSide` in canvas/handles.js) precisely so React Flow's own lookup always finds
   * something -- naming the free anchor's own handle there instead used to mean the edge never
   * drew at all, because that handle exists only for the instant it is being dragged. The precise
   * point still has to come from somewhere once the drag is over, which is `data`.
   *
   * `useInternalNode` is what makes it possible: it gives the node's absolute position and measured
   * size, which is exactly what `pointOnBorder` needs. No anchor parses as null and falls straight
   * through to the coordinates React Flow already worked out.
   */
  const fromNode = useInternalNode(source)
  const toNode = useInternalNode(target)
  /*
   * A hand-placed anchor first, then the share of the side this connector was given because it has
   * siblings arriving at the same one -- see `fanOutAnchors` in canvas/handles.js, computed once per
   * render in Canvas because no single edge can see its own siblings.
   *
   * Both fall through to React Flow's own coordinates below, which are the side's midpoint. That is
   * still the answer for a side with one connector on it, which is most sides on most diagrams.
   */
  const fromAnchor =
    anchorPoint(fromNode, data?.sourceAnchor) ??
    spreadPoint(fromNode, sourcePosition, fanAnchors?.get(`${id}:source`))
  const toAnchor =
    anchorPoint(toNode, data?.targetAnchor) ??
    spreadPoint(toNode, targetPosition, fanAnchors?.get(`${id}:target`))

  /* `?? 0` on the coordinates, not just on the anchor -- a floor that keeps `NaN` out of the path
     string on the frame before a node is measured, which would make the whole edge vanish. */
  const start = fromAnchor ?? { x: sourceX ?? 0, y: sourceY ?? 0, position: sourcePosition }
  const end = toAnchor ?? { x: targetX ?? 0, y: targetY ?? 0, position: targetPosition }

  const { path, labelX, labelY, points } = routeEdge({
    source: { x: start.x, y: start.y },
    target: { x: end.x, y: end.y },
    sourcePosition: start.position,
    targetPosition: end.position,
    waypoints,
    line,
  })

  const paths = data?.paths ?? null

  /* One line standing for several, because a group at one end of them is collapsed. The number is
     not decoration: without it this line claims one connection where there are forty, which is a
     wrong diagram rather than a simplified one. */
  const merged = data?.count > 1 ? data.count : null

  /*
   * A waypoint being dragged, held locally so the line follows the pointer at frame rate without
   * a store write per mousemove.
   *
   * `{index, point}` -- the index into the *waypoint* list, and where it is now. A drag that
   * creates a new point inserts it into local state first and commits on release, so a bend made
   * and abandoned leaves nothing behind and puts nothing on the undo stack.
   */
  const [dragging, setDragging] = useState(null)
  /* Whether the pointer is on this connector, which is what reveals its route handles -- see
     `editable` below. Local, because no other component and no other edge needs to know. */
  const [hovered, setHovered] = useState(false)
  const committed = useRef(waypoints)
  committed.current = waypoints

  /*
   * What to draw: the dragged route while a drag is live, the stored one otherwise.
   *
   * Two kinds of drag, which is the whole shape of this component's interaction model:
   *
   *  - `slide` moves a whole segment sideways, keeping every angle square. This is what a
   *    right-angle connector wants -- the interesting number on a Z is where the crossbar sits, not
   *    where one corner is, and moving a single corner turns the Z into a diagonal staircase.
   *  - `bend` moves one point freely. This is what a curve or a straight line wants, where there
   *    are no angles to keep.
   *
   * `dragSegment` reads the *rendered* corner list, so a slide on an unedited right-angle route
   * materialises the derived corners into waypoints as a side effect. That is deliberate; see its
   * own comment for why a partly-derived route cannot be re-derived.
   */
  const shown = dragging ? resolveDrag(dragging, dragging.point) : waypoints
  const live =
    dragging &&
    routeEdge({
      source: { x: start.x, y: start.y },
      target: { x: end.x, y: end.y },
      sourcePosition: start.position,
      targetPosition: end.position,
      waypoints: shown,
      line,
    })
  const drawnPath = live ? live.path : path
  const drawnPoints = live ? live.points : points

  /*
   * Publish where this connector runs, for the travelling event to follow.
   *
   * Centre to centre, not the border-to-border line that is actually stroked. The event has to
   * arrive at a component, dwell there and leave from the same point, and a token that stopped at
   * the near border and resumed at the far one would jump the width of the card at every hop. The
   * segments inside the two cards are never drawn -- the token is simply over the card while it
   * covers them, which reads as the event being *in* the component.
   *
   * `drawnPoints` and not `points`, so a route being dragged carries the event with it: the line and
   * the thing travelling it must not be able to disagree about where it goes, which is the entire
   * reason this is published rather than re-derived. See `edgeRoutes` in canvas/chrome.js.
   */
  const fromCentre = centre(fromNode)
  const toCentre = centre(toNode)

  /* No dependency array, deliberately. The route is derived from this render's own output -- a fresh
     points array and two freshly computed centres -- so every value it depends on is a new object
     every time and a dependency list would be a list that always fires while pretending to be a
     filter. Writing one entry into a Map is cheaper than the comparison would be. */
  useEffect(() => {
    if (!routes) return
    /* Nothing published while a node is unmeasured (the frame after it mounts), rather than a route
       through NaN. The overlay falls back to a straight line between what it can find, which is
       wrong for one frame instead of wrong permanently. */
    if (!fromCentre || !toCentre) routes.forget(id)
    else routes.publish(id, [fromCentre, ...drawnPoints, toCentre])
  })

  /* Unmount only, so a deleted connector cannot leave a route behind for the overlay to keep
     drawing an event along. */
  useEffect(() => () => routes?.forget(id), [routes, id])

  /*
   * The Flow preview: what this connector would do if the hovered menu row were chosen.
   *
   * `forward` is the whole answer. The path string always runs source-to-target, so a preview
   * that agrees with the connector's current direction travels along it and one that does not
   * travels back up it -- and travelling back up it is exactly the information the reader
   * wants, because it means choosing this row will turn the line round.
   *
   * Reversed with `keyPoints` rather than by building a second reversed path string. The path
   * may carry hand-dragged bends and a rounded polyline, and re-deriving it backwards would be
   * a second implementation of the router that could disagree with the line on screen.
   */
  const previewing =
    flowPreview && (flowPreview.edgeIds === null || flowPreview.edgeIds.includes(id))
  const previewForward = previewing
    ? flowsAlong(fromCentre, toCentre, flowPreview.direction)
    : true

  /*
   * One drag, for both moving an existing waypoint and creating a new one.
   *
   * Listeners on `window`, not on the handle itself. The handle a gesture starts on is not
   * guaranteed to still be mounted a moment later -- every other handle of its kind is hidden
   * by `!dragging` while one is live, and a `bend` drag replaces its own segment-handle div with
   * a waypoint dot the instant `dragging` becomes truthy. `setPointerCapture` on that element
   * would be silently dropped the moment it leaves the DOM, orphaning the very listeners meant
   * to finish the gesture -- which is why the corner and segment handles used to be draggable in
   * name only. `window` keeps receiving pointer events regardless of what, if anything, is
   * currently under the pointer.
   */
  const startDrag = useCallback(
    (event, gesture) => {
      /* Or React Flow takes the gesture as a click on the edge and then a pan of the pane. */
      event.stopPropagation()
      event.preventDefault()

      const at = (moveEvent) => screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
      /* The result of the gesture, given a pointer position -- one function so the frame-by-frame
         preview and the value finally committed cannot disagree about what the drag meant. */
      setDragging({ ...gesture, point: at(event) })

      const onMove = (moveEvent) => setDragging({ ...gesture, point: at(moveEvent) })
      const onUp = (upEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        setDragging(null)
        /* Committed once, on release. A write per frame would put one undo entry on the history
           stack per pixel dragged and re-run the whole change pipeline mid-gesture. */
        onWaypoints?.(id, resolveDrag(gesture, at(upEvent)))
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [screenToFlowPosition, onWaypoints, id],
  )

  /* Selected *or* in adjust mode. Selection is how you get here by accident and find the handles;
     the double-click is the deliberate way in, and is what the request asked for. */
  /*
   * Whether the bend, corner and segment handles are shown.
   *
   * `hovered` is the addition, and it is the whole of the fix for "I'm not able to edit these
   * connectors route on the diagram". The handles were always here and always worked -- they were
   * gated on the connector being *selected*, with nothing anywhere advertising that. So a reader who
   * did not already know to click a line first had no way to discover that its route was adjustable,
   * and reasonably concluded it was not. Revealing them under the pointer costs nothing and answers
   * the question before it is asked.
   */
  const editable = (hovered || selected || adjusting) && Boolean(onWaypoints)

  return (
    <>
      {/* Edge-scoped rather than one shared definition: the colour is per-connector, and a
          marker id built from anything less would have two differently-coloured lines fighting
          over one arrowhead. Same geometry as React Flow's own ArrowClosed marker (down to the
          viewBox and the polyline points), so a styled connector's arrow is the same size and
          shape it always was -- only the colour is no longer fixed. `orient="auto-start-reverse"`
          is what lets the one definition serve both ends: referenced from `markerStart` it is
          drawn rotated 180 degrees automatically, so it points outward there too. */}
      <defs>
        <marker
          id={`${id}-arrow`}
          markerWidth="12.5"
          markerHeight="12.5"
          viewBox="-10 -10 20 20"
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
          refX="0"
          refY="0"
        >
          <polyline
            points="-5,-4 0,0 -5,4 -5,-4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: color, fill: color, strokeWidth: 1 }}
          />
        </marker>
      </defs>
      {/*
        * Hover, so the route handles have an affordance before anyone thinks to click.
        *
        * The handlers go on a wrapper `g` rather than on a hit path of this component's own, and that
        * detail was the difference between working and not. `BaseEdge` already draws a 20-unit
        * `strokeOpacity: 0` interaction path, and SVG hit-testing takes the topmost element -- so a
        * ribbon of ours rendered before it was simply underneath it and never saw the pointer, while one
        * rendered after it would have stolen the clicks React Flow needs for selection. Letting the
        * library's own hit area bubble up to a wrapper gets both: the same generous reach that selects
        * the edge, and no interference with it.
        */}
      <g onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <BaseEdge
        id={id}
        path={drawnPath}
        markerStart={arrowStart ? `url(#${id}-arrow)` : undefined}
        markerEnd={arrowEnd ? `url(#${id}-arrow)` : undefined}
        style={{
          /* Faded under its own overlays so the colours read against it. Edges no scenario
             touched are left alone: dimming those would need this component to know that
             something is playing somewhere else, and an edge should not depend on the state of
             edges it cannot see. */
          ...style,
          stroke: color,
          strokeDasharray: dashArray,
          /* Three cases. Under its own overlays it fades so the colours read against it; with a
             walkthrough running and no path on it, it recedes with the rest of the diagram the event
             never touched; otherwise it is left alone. */
          opacity: paths ? 0.2 : walkthroughActive ? 0.3 : style?.opacity,
          /* Thicker with what it stands for, capped: a merged line has to look heavier than a
             single connection at a glance, and unbounded growth would make one edge into a band
             across the diagram. */
          strokeWidth: merged ? Math.min(1 + Math.log2(merged), 4) : style?.strokeWidth,
        }}
      />
      </g>

      {/*
        * The Flow preview, drawn above the base line and below the scenario overlays.
        *
        * Three dots rather than one, evenly spaced around the cycle: a single dot on a long
        * connector is off-screen most of the time at the zoom a whole architecture is read at,
        * and the direction is the entire message. Dashed stroke moving with them for the same
        * reason -- on a short line the dots are what reads, on a long one the dashes are.
        *
        * `flowPreviewDash` animates the offset so the dashes crawl the same way the dots do.
        * Sign flips with `previewForward`, which is what makes a preview that would turn the
        * line round visibly run against it.
        */}
      {previewing && (
        <g style={{ pointerEvents: 'none' }} aria-hidden="true">
          <path
            d={drawnPath}
            fill="none"
            stroke="#0263e0"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray="6 8"
            strokeOpacity={0.75}
          >
            <animate
              attributeName="stroke-dashoffset"
              values={previewForward ? '14;0' : '0;14'}
              dur="0.6s"
              repeatCount="indefinite"
            />
          </path>
          {[0, 1, 2].map((slot) => (
            <circle key={slot} r={3} fill="#0263e0">
              <animateMotion
                dur="1.5s"
                repeatCount="indefinite"
                path={drawnPath}
                keyPoints={previewForward ? '0;1' : '1;0'}
                keyTimes="0;1"
                calcMode="linear"
                begin={`${slot * 0.5}s`}
              />
            </circle>
          ))}
        </g>
      )}

      {paths?.map((entry, index) => (
        <g key={entry.scenarioId} style={{ pointerEvents: 'none' }}>
          {/*
            * The line the event came along, and nothing more.
            *
            * There used to be a wide faint copy underneath, switched on for the hop being crossed and
            * off again once it was done. That halo is gone, and its removal is the point: a band of
            * colour appearing under a whole connector at once and vanishing a second later is a line
            * being turned on, not an event moving along it. The event is now a thing with a position
            * of its own (simulation/EventLayer.jsx), so the connector's only job is to say afterwards
            * that the event went this way -- which a coloured stroke does on its own.
            *
            * Still transitioned, because the thickening as the event enters a connector is the cue
            * that it has *begun* to cross it, and a step change there reads as a flicker.
            */}
          <path
            d={drawnPath}
            fill="none"
            stroke={entry.color}
            strokeLinecap="round"
            strokeDasharray={
              paths.length > 1 ? `${SEGMENT} ${SEGMENT * (paths.length - 1)}` : undefined
            }
            strokeDashoffset={paths.length > 1 ? -index * SEGMENT : undefined}
            style={{
              strokeWidth: entry.status === 'active' ? 3.5 : 2.5,
              /* Dropped is dimmed rather than recoloured: the colour is the scenario's identity,
                 and turning it red to mean "dropped" would make one path look like another. */
              strokeOpacity: entry.status === 'dropped' ? 0.5 : 1,
              transition: `stroke-width ${GLOW_FADE_MS}ms ease-out, stroke-opacity ${GLOW_FADE_MS}ms ease-out`,
            }}
          />
          {/* No event drawn here. It used to be a `<circle>` with an `animateMotion`, mounted only
              while this connector's beat was current -- which meant it did not exist during the
              arrival beat that followed, so for a full second there was no event anywhere on screen
              and a component appeared to light up by itself. An event that exists for half of a run
              cannot be watched travelling, so it moved out to a layer of its own that spans the whole
              route: simulation/EventLayer.jsx. */}
        </g>
      ))}

      {editable && (
        <EdgeLabelRenderer>
          {/* Existing bends: drag to move, double-click to straighten out. */}
          {shown.map((point, index) => (
            <div
              key={`bend-${index}`}
              className="nodrag nopan absolute h-2.5 w-2.5 cursor-move rounded-full border-2 border-white bg-twilio-blue shadow"
              style={{
                transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`,
                pointerEvents: 'all',
              }}
              title="Drag to move this bend. Double-click to remove it."
              onPointerDown={(event) => startDrag(event, { index, list: committed.current })}
              onDoubleClick={(event) => {
                event.stopPropagation()
                onWaypoints?.(id, removeWaypoint(committed.current, index))
              }}
            />
          ))}

          {/* One dot per real bend. Dragging it moves *both* segments that meet there, so the
              angle stays square -- see `dragCorner`. Drawn as a diamond so it is not mistaken for a
              waypoint dot, which moves freely and would break the angle. */}
          {!dragging &&
            line === 'orthogonal' &&
            cornerHandles(drawnPoints).map((handle) => (
              <div
                key={`corner-${handle.index}`}
                className="nodrag nopan absolute h-2.5 w-2.5 rotate-45 cursor-move border-2 border-twilio-blue bg-white opacity-70 shadow transition-opacity hover:opacity-100"
                style={{
                  transform: `translate(-50%, -50%) translate(${handle.x}px, ${handle.y}px) rotate(45deg)`,
                  pointerEvents: 'all',
                }}
                title="Drag to move this corner. Both sides of the angle follow it."
                onPointerDown={(event) =>
                  startDrag(event, { mode: 'corner', index: handle.index, points: drawnPoints })
                }
              />
            ))}

          {/* One handle per segment. Suppressed while a drag is live -- the segments are being
              recomputed every frame, so the handles would jump around under the pointer. */}
          {!dragging &&
            segmentHandles(drawnPoints).map((handle) => {
              /*
               * A right-angle segment slides; anything else bends.
               *
               * `handle.axis` is the axis the segment runs along, and only an axis-aligned segment
               * has a perpendicular to slide on -- so a diagonal (which is every segment of a
               * straight or curved route) falls through to inserting a free waypoint. That is why
               * the two gestures need no mode switch in the UI: which one applies is a property of
               * the segment under the pointer, and the cursor says which.
               */
              const slide = line === 'orthogonal' && handle.axis
              return (
                <div
                  key={`seg-${handle.index}`}
                  className={`nodrag nopan absolute rounded-full border-2 border-twilio-blue bg-white shadow transition-opacity hover:opacity-100 ${
                    slide
                      ? /* A bar, not a dot, lying along the segment: it says "this whole length
                           moves" where a dot says "this point moves", which is the one thing a
                           user has to understand before dragging it. */
                        handle.axis === 'x'
                        ? 'h-1.5 w-6 cursor-ns-resize rounded-sm opacity-60'
                        : 'h-6 w-1.5 cursor-ew-resize rounded-sm opacity-60'
                      : 'h-2.5 w-2.5 cursor-move opacity-40'
                  }`}
                  style={{
                    transform: `translate(-50%, -50%) translate(${handle.x}px, ${handle.y}px)`,
                    pointerEvents: 'all',
                  }}
                  title={
                    slide
                      ? handle.axis === 'x'
                        ? 'Drag up or down to move this part of the line.'
                        : 'Drag left or right to move this part of the line.'
                      : 'Drag to bend the connector here.'
                  }
                  onPointerDown={(event) =>
                    startDrag(
                      event,
                      slide
                        ? /* The rendered corners, which is what a slide operates on -- including
                             the ones the router derived. */
                          { mode: 'slide', index: handle.index, points: drawnPoints }
                        : /* The new point is inserted *before* the drag starts, so the index the
                             drag then moves is the new point's own -- which is what makes the
                             handle turn into a bend that follows the pointer rather than jumping
                             into place on release. */
                          {
                            mode: 'bend',
                            index: handle.index,
                            list: insertWaypoint(committed.current, handle.index, {
                              x: handle.x,
                              y: handle.y,
                            }),
                          },
                    )
                  }
                />
              )
            })}
        </EdgeLabelRenderer>
      )}

      {/* EdgeLabelRenderer portals into the viewport, so the badge pans and zooms with the
          diagram and is inside what an export captures -- unlike a Panel. */}
      {merged && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-full border border-twilio-gray-20 bg-white px-1.5 text-[10px] font-bold tabular-nums text-twilio-gray-90 shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${live ? live.labelX : labelX}px, ${
                live ? live.labelY : labelY
              }px)`,
            }}
            title={`${merged} connections, merged because a group at one end is collapsed`}
          >
            {merged}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
