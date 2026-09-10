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

import { useCallback, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, useReactFlow } from '@xyflow/react'

import { useChrome } from '../chrome.js'
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
function resolveDrag(gesture, point) {
  if (gesture.mode === 'slide') return dragSegment(gesture.points, gesture.index, point)
  if (gesture.mode === 'corner') return dragCorner(gesture.points, gesture.index, point)
  return moveWaypoint(gesture.list, gesture.index, point)
}

export default function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
  selected,
}) {
  const { screenToFlowPosition } = useReactFlow()
  const { onWaypoints, adjustingEdgeId } = useChrome()
  /* Double-clicking the line puts it in adjust mode -- see Canvas's `onEdgeDoubleClick`. Held there
     rather than here so only one connector is ever in it: two edges showing handles at once means two
     sets of dots competing for the same few pixels wherever the lines cross. */
  const adjusting = adjustingEdgeId === id

  const line = lineStyleOf(data)
  const waypoints = cleanWaypoints(data?.waypoints)

  const { path, labelX, labelY, points } = routeEdge({
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
    sourcePosition,
    targetPosition,
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
      source: { x: sourceX, y: sourceY },
      target: { x: targetX, y: targetY },
      sourcePosition,
      targetPosition,
      waypoints: shown,
      line,
    })
  const drawnPath = live ? live.path : path
  const drawnPoints = live ? live.points : points

  /*
   * One pointer-capture drag, for both moving an existing waypoint and creating a new one.
   *
   * `setPointerCapture` rather than window listeners: the pointer stays with this element even
   * when it leaves it, which is what makes a fast drag not fall off the handle -- and the capture
   * is released for us if the gesture is interrupted, so there is no listener to leak.
   */
  const startDrag = useCallback(
    (event, gesture) => {
      /* Or React Flow takes the gesture as a click on the edge and then a pan of the pane. */
      event.stopPropagation()
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture?.(event.pointerId)

      const at = (moveEvent) => screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
      /* The result of the gesture, given a pointer position -- one function so the frame-by-frame
         preview and the value finally committed cannot disagree about what the drag meant. */
      setDragging({ ...gesture, point: at(event) })

      const onMove = (moveEvent) => setDragging({ ...gesture, point: at(moveEvent) })
      const onUp = (upEvent) => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', onUp)
        element.removeEventListener('pointercancel', onUp)
        setDragging(null)
        /* Committed once, on release. A write per frame would put one undo entry on the history
           stack per pixel dragged and re-run the whole change pipeline mid-gesture. */
        onWaypoints?.(id, resolveDrag(gesture, at(upEvent)))
      }
      /* On the element rather than the window, because the pointer capture above routes events
         here even once the pointer has left it -- and a capture that is broken by the browser
         releases these with it, so there is no listener to leak. */
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', onUp)
      element.addEventListener('pointercancel', onUp)
    },
    [screenToFlowPosition, onWaypoints, id],
  )

  /* Selected *or* in adjust mode. Selection is how you get here by accident and find the handles;
     the double-click is the deliberate way in, and is what the request asked for. */
  const editable = (selected || adjusting) && Boolean(onWaypoints)

  return (
    <>
      <BaseEdge
        id={id}
        path={drawnPath}
        markerEnd={markerEnd}
        style={{
          /* Faded under its own overlays so the colours read against it. Edges no scenario
             touched are left alone: dimming those would need this component to know that
             something is playing somewhere else, and an edge should not depend on the state of
             edges it cannot see. */
          ...style,
          opacity: paths ? 0.2 : style?.opacity,
          /* Thicker with what it stands for, capped: a merged line has to look heavier than a
             single connection at a glance, and unbounded growth would make one edge into a band
             across the diagram. */
          strokeWidth: merged ? Math.min(1 + Math.log2(merged), 4) : style?.strokeWidth,
        }}
      />

      {paths?.map((entry, index) => (
        <g key={entry.scenarioId} style={{ pointerEvents: 'none' }}>
          <path
            d={drawnPath}
            fill="none"
            stroke={entry.color}
            strokeWidth={entry.status === 'active' ? 3 : 2}
            strokeLinecap="round"
            /* Dropped is dimmed rather than recoloured: the colour is the scenario's identity,
               and turning it red to mean "dropped" would make one path look like another. */
            strokeOpacity={entry.status === 'dropped' ? 0.5 : 1}
            strokeDasharray={
              paths.length > 1 ? `${SEGMENT} ${SEGMENT * (paths.length - 1)}` : undefined
            }
            strokeDashoffset={paths.length > 1 ? -index * SEGMENT : undefined}
          />
          {/* The event itself, on the hop it is making right now. animateMotion rather than a CSS
              dash animation, which would fight the interleaving offset above. */}
          {entry.status === 'active' && (
            <circle r={3.5} fill={entry.color}>
              <animateMotion dur="0.9s" repeatCount="indefinite" path={drawnPath} />
            </circle>
          )}
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
