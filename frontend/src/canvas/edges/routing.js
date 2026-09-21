/*
 * Where a connector goes, as pure geometry.
 *
 * Three line styles, and a list of waypoints the user has dragged. All of it is a function from
 * `(endpoints, waypoints, style)` to an SVG path string, with no React and no canvas -- which
 * matters more here than anywhere else in this app, because "the line goes through the wrong
 * place" is a bug you can only see and never read, and a path builder that can be unit-tested
 * against coordinates is the only way to pin it down.
 *
 * ## Why the styles are not interchangeable
 *
 * A Segment architecture is drawn left to right, and for the common case -- source feeds
 * destination, both in the same row -- React Flow's `smoothstep` is right: the line leaves
 * horizontally, turns once, and arrives horizontally, so it reads as a pipeline. It is wrong for
 * two other real cases, which is why the choice exists:
 *
 *   - `straight` for a short hop between two things sitting side by side, where a stepped line
 *     spends its whole length turning corners it does not need.
 *   - `curved` for a long connector that has to get past something, because a bezier's bulge
 *     makes it obvious which line is which where several cross. Stepped lines that cross look
 *     like a circuit board and you cannot follow one with your eye.
 *
 * ## Waypoints are absolute, in flow coordinates
 *
 * Not relative to either endpoint, and not relative to a parent zone. A waypoint exists because
 * the user put the line *there* -- usually in the gap between two zones -- and the whole point
 * is that it stays there when the components at either end move. Storing it relative to an
 * endpoint would make the line re-route itself every time either card was nudged, which is
 * exactly the hand-routing this feature exists to preserve.
 *
 * The consequence, stated so it is a decision and not a surprise: dragging a *component* does
 * not drag the waypoints of its edges. Its line will bend to reach the new position. That is
 * the right way round -- a hand-placed bend is a statement about the empty space it occupies,
 * and empty space does not move when a card does.
 */

/* The three, as ids rather than as free strings, so a typo in a menu entry fails a test rather
   than silently falling through to the default. */
export const LINE_STYLES = ['orthogonal', 'curved', 'straight']

/* What an edge with nothing stored on it draws. `orthogonal` because it is what every edge in
   every saved diagram is already drawn as -- `getSmoothStepPath` -- so the default has to be
   that or opening an old diagram would silently re-route all of it. */
export const DEFAULT_LINE_STYLE = 'orthogonal'

/* How far a curve leans out of an endpoint. In flow units at zoom 1.

   26 is a little more than the 20px `CHILD_MARGIN` a zone keeps around its contents, so a line
   leaving a card that sits flush against its zone's padding still clears the backdrop's border
   before it turns -- otherwise the first corner lands on the dashed edge and reads as the line
   touching the zone rather than passing it. */
const LEAN = 26

/*
 * How far an orthogonal line runs straight out of a handle before it may turn.
 *
 * 20, which is React Flow's own `offset` default for `smoothstep`. Deliberately *its* number and
 * not the 26 above: the orthogonal router below reproduces smoothstep's corner arithmetic exactly
 * so that an edge with no waypoints is drawn pixel-for-pixel as it was before this module
 * existed. A first attempt used a single L-shaped bend instead, which arrived at the target from
 * above rather than horizontally into its handle -- every right-angle connector on every diagram
 * changed shape, which is what "the right angles were working better before" was reporting.
 */
const STEP_OFFSET = 20

/* The radius an orthogonal corner is rounded by. Matches React Flow's own `smoothstep` default,
   for the same reason `STEP_OFFSET` does. */
const CORNER = 5

const round = (value) => Math.round(value * 100) / 100

/** `{x, y}` pairs, with anything malformed dropped. Waypoints are hand-edited and persisted. */
export function cleanWaypoints(waypoints) {
  if (!Array.isArray(waypoints)) return []
  return waypoints
    .filter(
      (point) =>
        point &&
        Number.isFinite(Number(point.x)) &&
        Number.isFinite(Number(point.y)),
    )
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
}

export function lineStyleOf(data) {
  const style = data?.line
  return LINE_STYLES.includes(style) ? style : DEFAULT_LINE_STYLE
}

/**
 * The direction a line leaves or enters at, as a unit vector.
 *
 * React Flow gives `sourcePosition`/`targetPosition` as one of its four `Position` strings, and
 * every style here needs them as arithmetic: a curve leans along them and an orthogonal line
 * takes its first step along them. Defaulting to rightward rather than to zero, because a zero
 * vector would collapse a curve's control point onto its endpoint and draw a straight line
 * while claiming to be a curve.
 */
export function directionOf(position) {
  switch (position) {
    case 'left':
      return { x: -1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
    default:
      return { x: 1, y: 0 }
  }
}

/* --- the three builders ----------------------------------------------------- */

/**
 * A polyline through every point.
 *
 * The simplest of the three and the one the other two are checked against: whatever the style,
 * the line has to *visit* the waypoints, and a path that does not pass through a point the user
 * dragged it to is broken regardless of how smooth it is.
 */
function straightPath(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)},${round(point.y)}`).join(' ')
}

/**
 * A smooth curve through every point, as a Catmull-Rom spline converted to cubic beziers.
 *
 * Catmull-Rom rather than fitting one bezier per pair, because a per-pair bezier is only smooth
 * *within* a segment: at each waypoint the two curves arrive with different tangents and the
 * line visibly kinks at exactly the points the user placed by hand. Catmull-Rom is defined by
 * the points it passes through and is C1 continuous across them, which is the property being
 * bought here.
 *
 * The endpoint tangents are the handle directions rather than the neighbouring point, so a line
 * still leaves a component's right-hand side going right. Without that a curve to a component
 * up and to the left would leave the right-hand handle heading left, crossing back over the card
 * it just left.
 */
function curvedPath(points, fromDirection, toDirection) {
  if (points.length === 2) {
    /* Two points: a plain cubic leaning out of both ends. Identical in spirit to React Flow's
       `getBezierPath`, written here so the lean distance matches the multi-point case. */
    const [from, to] = points
    const lean = Math.max(LEAN, Math.hypot(to.x - from.x, to.y - from.y) * 0.35)
    const c1 = { x: from.x + fromDirection.x * lean, y: from.y + fromDirection.y * lean }
    const c2 = { x: to.x + toDirection.x * lean, y: to.y + toDirection.y * lean }
    return (
      `M ${round(from.x)},${round(from.y)} ` +
      `C ${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(to.x)},${round(to.y)}`
    )
  }

  /*
   * Phantom points either end, placed along the handle directions, so the spline's first and
   * last tangents come from the handles instead of from the second and second-to-last points.
   * Catmull-Rom needs a neighbour on both sides of every point it interpolates, and the two
   * endpoints have only one -- the usual fix is to duplicate them, which makes the line leave
   * flat and ignore which side of the component it is attached to.
   */
  const first = points[0]
  const last = points[points.length - 1]
  const padded = [
    { x: first.x + fromDirection.x * LEAN, y: first.y + fromDirection.y * LEAN },
    ...points,
    { x: last.x + toDirection.x * LEAN, y: last.y + toDirection.y * LEAN },
  ]

  let path = `M ${round(first.x)},${round(first.y)}`
  for (let index = 1; index < padded.length - 2; index += 1) {
    const p0 = padded[index - 1]
    const p1 = padded[index]
    const p2 = padded[index + 1]
    const p3 = padded[index + 2]
    /* The standard Catmull-Rom to cubic-bezier conversion, at tension 1/6. Lower tension
       overshoots at sharp bends and the line bulges past the component it was routed around,
       which defeats the point of the waypoint. */
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    path += ` C ${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(p2.x)},${round(p2.y)}`
  }
  return path
}

/**
 * The corners of an orthogonal route between two points with known handle directions.
 *
 * This is a faithful reimplementation of React Flow's own `getPoints` (the arithmetic behind
 * `getSmoothStepPath`), and it is a reimplementation rather than a call because that function is
 * not exported and the *corners* are what everything else here needs: the segment handles are
 * drawn from them, and dragging a segment turns them into waypoints. Delegating for the path
 * string while computing corners separately would let the two drift, and a handle a few pixels
 * off its own line is worse than no handle.
 *
 * The shape it produces, for the common left-to-right case: out of the handle by `STEP_OFFSET`,
 * across at the midpoint, and back in horizontally. A Z, not an L -- an L arrives at the target
 * from above or below, which for a left-facing handle means the line meets the card's edge
 * instead of its handle.
 *
 * @returns the interior corners only -- source and target are added by the caller.
 */
export function orthogonalCorners({ source, target, sourcePosition, targetPosition }) {
  const sourceDirection = directionOf(sourcePosition)
  const targetDirection = directionOf(targetPosition)

  const fromGap = {
    x: source.x + sourceDirection.x * STEP_OFFSET,
    y: source.y + sourceDirection.y * STEP_OFFSET,
  }
  const toGap = {
    x: target.x + targetDirection.x * STEP_OFFSET,
    y: target.y + targetDirection.y * STEP_OFFSET,
  }

  /* The axis the route mostly travels along, and its sign. Taken from the *gapped* points, as
     smoothstep does, so a very short backwards edge does not flip direction because the raw
     endpoints happen to be a pixel apart. */
  const horizontal = sourcePosition === 'left' || sourcePosition === 'right'
  const axis = horizontal ? 'x' : 'y'
  const sign = horizontal
    ? fromGap.x < toGap.x
      ? 1
      : -1
    : fromGap.y < toGap.y
      ? 1
      : -1

  const centre = {
    x: (fromGap.x + toGap.x) / 2,
    y: (fromGap.y + toGap.y) / 2,
  }

  let middle
  if (sourceDirection[axis] * targetDirection[axis] === -1) {
    /* Handles facing each other -- right into left, or bottom into top. The overwhelmingly common
       case, and the one with two corners: cross over on the perpendicular axis halfway along. */
    const verticalSplit = [
      { x: centre.x, y: fromGap.y },
      { x: centre.x, y: toGap.y },
    ]
    const horizontalSplit = [
      { x: fromGap.x, y: centre.y },
      { x: toGap.x, y: centre.y },
    ]
    if (sourceDirection[axis] === sign) {
      middle = horizontal ? verticalSplit : horizontalSplit
    } else {
      /* Facing each other but pointing *away*: the target is behind the source. The route has to
         come back on itself, so it splits on the other axis and goes round. */
      middle = horizontal ? horizontalSplit : verticalSplit
    }
  } else {
    /* Same side, or a mixed pair like right-into-bottom. One corner, and which one depends on
       whether the source's own direction agrees with the way the route is travelling. */
    const fromSource = [{ x: fromGap.x, y: toGap.y }]
    const fromTarget = [{ x: toGap.x, y: fromGap.y }]
    if (horizontal) middle = sourceDirection.x === sign ? fromTarget : fromSource
    else middle = sourceDirection.y === sign ? fromSource : fromTarget
  }

  /*
   * Deduplicated, which React Flow's own version only does for the two gapped points.
   *
   * The crossbar itself can collapse: a very short backwards edge puts both of its corners at the
   * same place, because the two gapped points end up on the same coordinate. That is a zero-length
   * segment -- harmless to draw, since the fillet is clamped to zero and the leg degenerates to a
   * straight line, but not harmless to *edit*. `segmentHandles` would offer a handle for it that
   * cannot be aimed at, and `dragSegment` would be asked to slide a segment with no direction.
   */
  const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
  const corners = []
  for (const point of [fromGap, ...middle, toGap]) {
    if (corners.length && same(corners[corners.length - 1], point)) continue
    corners.push(point)
  }
  return corners
}

/**
 * Axis-aligned corners through a list of user waypoints, leaving and arriving perpendicular.
 *
 * Between two consecutive points the line turns once. Which axis it travels first is taken from
 * the direction the line is already going: a line that left a component's right-hand side goes
 * horizontal first, and after each turn the next segment starts on the axis the last one ended
 * on. Choosing per segment by "whichever delta is larger" -- the obvious alternative -- makes the
 * line change its mind halfway along and produce a staircase.
 *
 * ## The stubs, and why they were missing
 *
 * This used to take `fromDirection` only, and its own docstring said so: "with none,
 * `orthogonalCorners` above is the router, because it knows about both handle directions and this
 * does not." That reads as a note about a helper's scope and was in fact a rendering bug. The moment
 * an edge had a single waypoint -- which every auto-avoided and every hand-adjusted route has -- the
 * arrival direction stopped being considered at all, so the last leg came in along whatever axis the
 * preceding corner happened to leave it on. A connector landing on the *top* of a component would
 * approach horizontally and stop, putting its arrowhead flat against the border pointing *along* it
 * rather than into it. Visually the line ran alongside the component instead of meeting it, which is
 * exactly what it looked like: a connector attached to nothing.
 *
 * So both ends are now bracketed with a `STEP_OFFSET` stub along their own outward normal, the same
 * two points `orthogonalCorners` builds as `fromGap`/`toGap`. Those stubs are axis-aligned by
 * construction, so the corner walk below passes them through its "already aligned" branch untouched
 * and the first and last segments are guaranteed perpendicular to the sides they touch.
 */
function orthogonalThrough(points, fromDirection, toDirection) {
  const source = points[0]
  const target = points[points.length - 1]
  const middle = points.slice(1, -1)

  const fromGap = {
    x: source.x + fromDirection.x * STEP_OFFSET,
    y: source.y + fromDirection.y * STEP_OFFSET,
  }
  /* Tolerated rather than required, so a caller with no target side still gets the old behaviour
     instead of a route through NaN. */
  const toGap = toDirection
    ? { x: target.x + toDirection.x * STEP_OFFSET, y: target.y + toDirection.y * STEP_OFFSET }
    : null

  const through = [source, fromGap, ...middle, ...(toGap ? [toGap] : []), target]
  let horizontal = Math.abs(fromDirection.x) >= Math.abs(fromDirection.y)

  const corners = [through[0]]
  for (let index = 1; index < through.length; index += 1) {
    const from = corners[corners.length - 1]
    const to = through[index]
    if (Math.abs(to.x - from.x) < 0.5 && Math.abs(to.y - from.y) < 0.5) {
      /* A stub that collapsed, because a waypoint already sits where the gap would go. Dropped
         rather than emitted, for the same reason the dogleg below is: a zero-length segment is a
         handle `segmentHandles` cannot aim and `dragSegment` cannot slide. */
      continue
    }
    if (Math.abs(to.x - from.x) < 0.5 || Math.abs(to.y - from.y) < 0.5) {
      /* Already aligned on one axis: one straight segment, no corner, and the axis of travel is
         whichever one actually changed. Emitting a zero-length dogleg here is what produces the
         stray 1px nubs on an otherwise clean orthogonal route. */
      horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      corners.push(to)
      continue
    }
    corners.push(horizontal ? { x: to.x, y: from.y } : { x: from.x, y: to.y })
    corners.push(to)
    /* The next segment starts on the other axis, because this one ended on it. */
    horizontal = !horizontal
  }
  return corners
}

/**
 * A polyline with each interior vertex replaced by a small arc.
 *
 * Written here rather than reusing React Flow's `getSmoothStepPath` because that function routes
 * *between two points* and has no way to be told to pass through a list -- calling it per
 * segment would re-derive its own corners at every waypoint and produce a different shape from
 * the one this function's corner list describes.
 */
function roundedPolyline(points) {
  if (points.length < 3) return straightPath(points)

  let path = `M ${round(points[0].x)},${round(points[0].y)}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const corner = points[index]
    const next = points[index + 1]

    /* Clamped to half of the shorter leg, so two corners close together cannot each eat more
       than the segment between them and cross over -- which draws a visible loop at the bend. */
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(CORNER, inLength / 2, outLength / 2)
    if (radius < 0.5) {
      path += ` L ${round(corner.x)},${round(corner.y)}`
      continue
    }

    const towards = (a, b, distance) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
      return { x: a.x + ((b.x - a.x) / length) * distance, y: a.y + ((b.y - a.y) / length) * distance }
    }
    const start = towards(corner, previous, radius)
    const end = towards(corner, next, radius)

    path += ` L ${round(start.x)},${round(start.y)}`
    /* A quadratic with the corner as its control point, which is exactly a circular fillet for
       two perpendicular legs and degrades gracefully for any other angle. */
    path += ` Q ${round(corner.x)},${round(corner.y)} ${round(end.x)},${round(end.y)}`
  }
  path += ` L ${round(points[points.length - 1].x)},${round(points[points.length - 1].y)}`
  return path
}

/* --- the one entry point ---------------------------------------------------- */

/**
 * The path for one connector, and where to hang its label.
 *
 * @param source/target       `{x, y}` in flow coordinates, from React Flow
 * @param sourcePosition      which side it leaves, as React Flow's `Position` string
 * @param targetPosition      which side it arrives at
 * @param waypoints           points the user dragged it through, absolute, in order
 * @param line                one of LINE_STYLES
 * @returns `{path, labelX, labelY, points}` -- `points` is the full list including endpoints,
 *   which is what the waypoint handles are drawn from, so the handles and the line cannot
 *   disagree about where the route goes.
 */
export function routeEdge({
  source,
  target,
  sourcePosition,
  targetPosition,
  waypoints,
  line = DEFAULT_LINE_STYLE,
}) {
  const middle = cleanWaypoints(waypoints)
  const through = [source, ...middle, target]
  const fromDirection = directionOf(sourcePosition)
  const toDirection = directionOf(targetPosition)

  let path
  /*
   * `points` is the route as *drawn*, which for an orthogonal line is not the same list as the
   * waypoints: the router adds corners of its own. Everything downstream reads this rather than
   * the waypoints -- the segment handles, the label, and the drag that turns a segment into
   * waypoints -- so a handle can never sit somewhere the line does not go.
   */
  let points = through
  if (line === 'straight') {
    path = straightPath(through)
  } else if (line === 'curved') {
    path = curvedPath(through, fromDirection, toDirection)
  } else if (middle.length === 0) {
    points = [source, ...orthogonalCorners({ source, target, sourcePosition, targetPosition }), target]
    path = roundedPolyline(points)
  } else {
    points = orthogonalThrough(through, fromDirection, toDirection)
    path = roundedPolyline(points)
  }

  /*
   * The label sits halfway along the route by arc length. Not the bounding-box centre, which is
   * what React Flow's own helpers return: on a route bent around a zone the bounding-box centre is
   * frequently *inside* the zone, so the "40 connections" badge lands on top of a component.
   */
  const label = midpointOf(points)

  return { path, labelX: label.x, labelY: label.y, points }
}

/**
 * A fraction of the way along the route, measured by arc length over the polyline.
 *
 * By length and not by index, so a route with one long leg and one short one is traversed at a
 * steady speed rather than spending half the journey on each -- which is what both readers of this
 * need. The label wants the middle of the *line* and not the joint between two segments, and the
 * travelling event has to cross a bent connector without slowing down at every corner.
 *
 * `t` is clamped, so a caller may hand it a progress value that has drifted a hair past 1.
 *
 * Measured over the polyline, which for an orthogonal or straight route is exactly the line as
 * drawn. A curved route is a bezier through these same points, so this cuts its corners slightly --
 * accepted here for the same reason the label already accepts it: the deviation is small, it is
 * confined to a non-default line style, and the alternative is measuring a real `SVGPathElement`,
 * which would put DOM in the one part of the canvas that is currently pure and tested.
 */
export function pointAlong(points, t) {
  const list = points ?? []
  if (!list.length) return { x: 0, y: 0 }
  if (list.length === 1) return list[0]

  const lengths = []
  let total = 0
  for (let index = 1; index < list.length; index += 1) {
    const length = Math.hypot(list[index].x - list[index - 1].x, list[index].y - list[index - 1].y)
    lengths.push(length)
    total += length
  }
  if (total === 0) return list[0]

  const target = total * Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  let travelled = 0
  for (let index = 0; index < lengths.length; index += 1) {
    if (travelled + lengths[index] >= target) {
      const along = (target - travelled) / (lengths[index] || 1)
      const from = list[index]
      const to = list[index + 1]
      return { x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along }
    }
    travelled += lengths[index]
  }
  return list[list.length - 1]
}

/** The point halfway along the route. */
export function midpointOf(points) {
  return pointAlong(points, 0.5)
}

/* --- editing the route ------------------------------------------------------ */

/**
 * Where a new waypoint belongs when the user drags the handle on segment `index`.
 *
 * `index` counts segments of the *current* route, endpoints included -- so segment 0 runs from
 * the source to the first waypoint, and a route with no waypoints has exactly one segment. The
 * new point is therefore inserted at `index`, which is the only position that keeps the order
 * the route is travelled in.
 *
 * Returns a new array; never mutates.
 */
export function insertWaypoint(waypoints, index, point) {
  const list = cleanWaypoints(waypoints)
  const at = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, at), { x: Math.round(point.x), y: Math.round(point.y) }, ...list.slice(at)]
}

/** The same list with waypoint `index` moved. Rounded, because a sub-pixel drag is a save diff. */
export function moveWaypoint(waypoints, index, point) {
  const list = cleanWaypoints(waypoints)
  if (index < 0 || index >= list.length) return list
  const next = [...list]
  next[index] = { x: Math.round(point.x), y: Math.round(point.y) }
  return next
}

/** The same list without waypoint `index`. */
export function removeWaypoint(waypoints, index) {
  const list = cleanWaypoints(waypoints)
  if (index < 0 || index >= list.length) return list
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

/**
 * The midpoint of every segment of the route, for drawing its drag handle.
 *
 * @returns `[{x, y, index, axis}]` where `index` is the segment's index and `axis` is `'x'` for a
 *   segment that runs horizontally (and so is dragged vertically), `'y'` for one that runs
 *   vertically, and `null` for a diagonal. The axis is what lets an orthogonal segment be dragged
 *   perpendicular and locked to that -- see `dragSegment`.
 *
 * Computed from the `points` the path was built from, so a handle can never appear somewhere the
 * line does not go.
 */
export function segmentHandles(points) {
  const handles = []
  for (let index = 1; index < (points?.length ?? 0); index += 1) {
    const from = points[index - 1]
    const to = points[index]
    /* Skipped when the segment is too short to hold a handle: two handles 3px apart cannot be
       aimed at, and on an orthogonal route the little legs either side of a corner are exactly
       that. */
    if (Math.hypot(to.x - from.x, to.y - from.y) < 24) continue
    const horizontal = Math.abs(to.y - from.y) < 0.5
    const vertical = Math.abs(to.x - from.x) < 0.5
    handles.push({
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      index: index - 1,
      axis: horizontal ? 'x' : vertical ? 'y' : null,
    })
  }
  return handles
}

/**
 * Slide one whole segment of an orthogonal route sideways, and return the waypoints that produce
 * the result.
 *
 * This is the operation the request calls *"adjust the height of each part of the line"*, and it is
 * a different gesture from adding a bend. On a right-angle connector the interesting number is not
 * where a corner is, it is where the crossbar sits: how far out the line runs before it turns, and
 * at what height it travels across. Dragging a *point* cannot express that -- moving one corner of
 * a Z turns it into a diagonal staircase. Moving the segment moves both of its corners at once and
 * keeps every angle square.
 *
 * ## Why this materialises the whole route
 *
 * The corners of an unedited orthogonal route are derived, not stored. The moment one segment is
 * moved by hand the rest can no longer be re-derived around it -- there is no formula that says
 * "midpoint, except this bit" -- so the whole corner list becomes explicit waypoints. That is what
 * a hand-routed connector *is*, and it is why `Straighten` exists to give the derived route back.
 *
 * The consequence, stated so it is a decision: once a segment has been dragged, moving a component
 * at either end bends the line to reach it rather than re-routing. Same tradeoff as any waypoint;
 * see the module header.
 *
 * @param points  the route as drawn, endpoints included -- `routeEdge`'s `points`
 * @param index   which segment, as `segmentHandles` reports it
 * @param to      where the pointer is now, in flow coordinates
 * @returns the new waypoint list (the interior corners), never mutating anything
 */
export function dragSegment(points, index, to) {
  return interiorOf(slide(Array.isArray(points) ? points : [], index, to))
}

/**
 * Drag one *corner* of an orthogonal route, moving both of the segments that meet there.
 *
 * The gesture the request calls out specifically -- *"particular to the angles, dragging a corner
 * updates both"* -- and it cannot be a plain point move. A corner joins a horizontal segment to a
 * vertical one; moving the point alone would leave the horizontal one no longer horizontal, turning
 * a right angle into a diagonal and quietly destroying the thing that makes the style worth
 * choosing.
 *
 * What it is instead: sliding *both* adjacent segments at once. Taking the corner to `(x, y)` means
 * sliding the segment before it to `y` and the one after it to `x` -- so each stays axis-aligned, the
 * corner lands under the pointer, and the two segments beyond them stretch to meet it. Which of the
 * pair is horizontal does not need to be worked out here, because `slide` reads that off each
 * segment and ignores the coordinate that does not apply to it.
 *
 * @param index  the index of the corner *within `points`*, not within the waypoints -- the corner
 *   handles are drawn from `points`, so this is the index they already have.
 */
export function dragCorner(points, index, to) {
  const list = Array.isArray(points) ? points : []
  /* Endpoints are excluded: a route's ends are its handles, and moving one of those is
     reconnecting the edge rather than bending it. */
  if (index <= 0 || index >= list.length - 1) return interiorOf(list)
  return interiorOf(slide(slide(list, index - 1, to), index, to))
}

/*
 * One segment slid perpendicular to itself, as a whole point list.
 *
 * Shared by `dragSegment` and `dragCorner` -- the second is literally the first applied twice -- and
 * returning the full list rather than the interior is what makes that composition possible: chaining
 * two calls that had each dropped the endpoints would lose them on the first hop.
 *
 * The perpendicular is read off the segment, so a caller can hand in a pointer position with both
 * coordinates and this takes only the one that applies. A diagonal is left alone: there is no
 * perpendicular to slide along, and guessing one would turn a curve's control point into a corner.
 */
function slide(points, index, to) {
  if (index < 0 || index + 1 >= points.length) return points

  const from = points[index]
  const next = points[index + 1]
  const horizontal = Math.abs(next.y - from.y) < 0.5
  const vertical = Math.abs(next.x - from.x) < 0.5
  if (!horizontal && !vertical) return points

  const moved = points.map((point, at) => {
    if (at !== index && at !== index + 1) return point
    return horizontal
      ? { x: point.x, y: Math.round(to.y) }
      : { x: Math.round(to.x), y: point.y }
  })

  /*
   * The endpoints are where the handles are, and no bend gesture may move them. When the dragged
   * segment touches one, the moved copy stays as a *new* corner and the original endpoint is put
   * back in front of it -- which is what turns "slide the stub out of the source" into "leave the
   * source, step across, then run along at the new height".
   */
  if (index === 0) moved[0] = points[0]
  if (index + 1 === points.length - 1) moved[moved.length - 1] = points[points.length - 1]
  return moved
}

/**
 * The interior corners of a route, as `[{x, y, index}]` -- what the corner handles are drawn from.
 *
 * `index` is the position within `points`, which is exactly what `dragCorner` takes, so the handle
 * and the gesture cannot disagree about which corner is being moved.
 *
 * A corner where the two segments are collinear is skipped. Those exist -- the gapped stub out of a
 * handle is collinear with the leg after it whenever the route runs straight out -- and they are not
 * corners in any sense the user would recognise: dragging one bends a line that visibly has no bend
 * there.
 */
export function cornerHandles(points) {
  const list = Array.isArray(points) ? points : []
  const out = []
  for (let index = 1; index < list.length - 1; index += 1) {
    const previous = list[index - 1]
    const corner = list[index]
    const next = list[index + 1]
    const straight =
      (Math.abs(previous.x - corner.x) < 0.5 && Math.abs(corner.x - next.x) < 0.5) ||
      (Math.abs(previous.y - corner.y) < 0.5 && Math.abs(corner.y - next.y) < 0.5)
    if (straight) continue
    out.push({ x: corner.x, y: corner.y, index })
  }
  return out
}

/* Everything except the two endpoints, rounded, with any corner that has collapsed onto its
   neighbour dropped -- a duplicate corner is a zero-length segment, which draws as a nub and
   gives the user a handle they cannot aim at. */
function interiorOf(points) {
  const out = []
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = { x: Math.round(points[index].x), y: Math.round(points[index].y) }
    const last = out[out.length - 1]
    if (last && last.x === point.x && last.y === point.y) continue
    out.push(point)
  }
  return out
}

/* --- keeping the line off the components ------------------------------------ */

/*
 * How far a re-routed line is kept clear of a component it is going around.
 *
 * 12 rather than flush: a line that grazes a card's border reads as touching it, which on a
 * diagram whose whole subject is what connects to what is a claim rather than a near miss.
 */
const CLEARANCE = 12

/** Does the axis-aligned segment `a`-`b` pass through `box`? Inclusive of the border. */
export function segmentHitsBox(a, b, box) {
  const left = Math.min(a.x, b.x)
  const right = Math.max(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const bottom = Math.max(a.y, b.y)
  /* Axis-aligned only, which every orthogonal segment is -- so this is a rectangle overlap and
     not a general line/box intersection. A diagonal would need the slab test; nothing here has
     one, and pretending otherwise would be untested code. */
  return (
    left <= box.x + box.width &&
    right >= box.x &&
    top <= box.y + box.height &&
    bottom >= box.y
  )
}

/** Does any segment of this polyline pass through any of the boxes? */
export function routeHitsAny(points, boxes) {
  for (let index = 1; index < (points?.length ?? 0); index += 1) {
    for (const box of boxes ?? []) {
      if (segmentHitsBox(points[index - 1], points[index], box)) return true
    }
  }
  return false
}

/**
 * Waypoints that keep a right-angle connector off the components between its ends, or `[]` when
 * the default route is already clear.
 *
 * Best-effort by design, and the request asked for exactly that -- *"automatically try to avoid"*.
 * A guaranteed shortest orthogonal route is a visibility-graph search with a cost model for
 * bends, which is a great deal of machinery to run on every connection and produces routes nobody
 * predicted. What this does instead is try a handful of candidates a person would try, in the
 * order a person would try them, and take the first that is clear:
 *
 *   1. The default route. Most connections are between adjacent components with nothing in the way.
 *   2. The same Z with its crossbar moved to just clear each obstacle, nearest first. This is the
 *      one that fixes the common case -- a line from a source to a destination two columns over,
 *      with one card in the gap.
 *   3. Over the top of everything in the way, then under the bottom. The fallback for a route
 *      crossing a crowded band, and the two are tried in the order that gives the shorter detour.
 *
 * If none is clear the default is kept and `[]` returned. A line through a card is a legible
 * problem the user can fix by dragging; a line that has taken a bizarre six-bend detour to avoid
 * something is not.
 *
 * `boxes` must already exclude the two components being connected -- a route to a card
 * necessarily touches it -- and every zone, which are regions rather than things a line avoids.
 */
export function avoidingWaypoints({
  source,
  target,
  sourcePosition,
  targetPosition,
  boxes,
  line = DEFAULT_LINE_STYLE,
}) {
  /* Only the right-angle style. A curve's whole shape is its lean and a straight line has no
     freedom at all, so there is nothing to solve for either -- and quietly bending a straight
     connector into a dogleg would be ignoring what the user asked it to be. */
  if (line !== 'orthogonal') return []
  const obstacles = (boxes ?? []).filter((box) => box && box.width > 0 && box.height > 0)
  if (!obstacles.length) return []

  const corners = orthogonalCorners({ source, target, sourcePosition, targetPosition })
  const base = [source, ...corners, target]
  if (!routeHitsAny(base, obstacles)) return []

  const horizontal = sourcePosition === 'left' || sourcePosition === 'right'
  const hit = obstacles.filter((box) =>
    base.some((_, index) => index > 0 && segmentHitsBox(base[index - 1], base[index], box)),
  )

  const candidates = []

  /*
   * Move the crossbar. On a horizontal route the crossbar is vertical, so the candidates are x
   * positions just clear of each blocking card's left and right edges; on a vertical route, the
   * mirror. Sorted by how far the bar has to move, so the answer is the least surprising one that
   * works rather than whichever obstacle happened to be first in the array.
   */
  const barAt = horizontal ? (source.x + target.x) / 2 : (source.y + target.y) / 2
  const bars = []
  for (const box of hit) {
    if (horizontal) {
      bars.push(box.x - CLEARANCE, box.x + box.width + CLEARANCE)
    } else {
      bars.push(box.y - CLEARANCE, box.y + box.height + CLEARANCE)
    }
  }
  bars.sort((a, b) => Math.abs(a - barAt) - Math.abs(b - barAt))
  for (const bar of bars) {
    candidates.push(
      horizontal
        ? [
            { x: bar, y: source.y },
            { x: bar, y: target.y },
          ]
        : [
            { x: source.x, y: bar },
            { x: target.x, y: bar },
          ],
    )
  }

  /*
   * Go round the outside. `STEP_OFFSET` out of each handle first, so the line still leaves and
   * arrives on the axis its handle faces, then along a lane clear of everything in the way.
   */
  const lanes = horizontal
    ? [
        Math.min(...hit.map((box) => box.y)) - CLEARANCE,
        Math.max(...hit.map((box) => box.y + box.height)) + CLEARANCE,
      ]
    : [
        Math.min(...hit.map((box) => box.x)) - CLEARANCE,
        Math.max(...hit.map((box) => box.x + box.width)) + CLEARANCE,
      ]
  /* Shorter detour first: which way round is closer depends on where the two ends already are. */
  const reference = horizontal ? (source.y + target.y) / 2 : (source.x + target.x) / 2
  lanes.sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference))

  const fromDirection = directionOf(sourcePosition)
  const toDirection = directionOf(targetPosition)
  const fromStub = {
    x: source.x + fromDirection.x * STEP_OFFSET,
    y: source.y + fromDirection.y * STEP_OFFSET,
  }
  const toStub = {
    x: target.x + toDirection.x * STEP_OFFSET,
    y: target.y + toDirection.y * STEP_OFFSET,
  }
  for (const lane of lanes) {
    candidates.push(
      horizontal
        ? [fromStub, { x: fromStub.x, y: lane }, { x: toStub.x, y: lane }, toStub]
        : [fromStub, { x: lane, y: fromStub.y }, { x: lane, y: toStub.y }, toStub],
    )
  }

  for (const waypoints of candidates) {
    const route = orthogonalThrough([source, ...waypoints, target], fromDirection, toDirection)
    if (!routeHitsAny(route, obstacles)) return interiorOf([source, ...waypoints, target])
  }

  /* Nothing worked. The straight-through route is kept: a line crossing a card is an obvious
     problem with an obvious fix, and a desperate detour is neither. */
  return []
}
