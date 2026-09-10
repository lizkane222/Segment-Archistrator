/*
 * Connector geometry.
 *
 * The reason this file is as long as it is: a wrong path is a bug you can only *see*. There is no
 * error, nothing throws, the diagram just looks subtly wrong -- a line clipping the corner of a
 * card, a bend that ignores the point it was dragged to, a staircase where there should be one
 * turn. None of that is reportable from a screenshot after the fact, so the invariants are
 * asserted against coordinates here instead.
 *
 * The invariant that matters most, and the one every style is checked against: **the line visits
 * the points the user dragged it to.** A route that does not pass through its own waypoints is
 * broken however smooth it looks.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LINE_STYLE,
  LINE_STYLES,
  avoidingWaypoints,
  cleanWaypoints,
  cornerHandles,
  directionOf,
  dragCorner,
  dragSegment,
  insertWaypoint,
  lineStyleOf,
  midpointOf,
  moveWaypoint,
  orthogonalCorners,
  removeWaypoint,
  routeEdge,
  routeHitsAny,
  segmentHandles,
  segmentHitsBox,
} from './routing.js'

const from = { x: 0, y: 0 }
const to = { x: 400, y: 200 }

const route = (extra = {}) =>
  routeEdge({
    source: from,
    target: to,
    sourcePosition: 'right',
    targetPosition: 'left',
    ...extra,
  })

/** Every coordinate pair in a path string, in order, as numbers. */
function coordinates(path) {
  return [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }))
}

/** Is `point` one of the path's coordinate pairs, within a pixel? */
function visits(path, point) {
  return coordinates(path).some(
    (found) => Math.abs(found.x - point.x) <= 1 && Math.abs(found.y - point.y) <= 1,
  )
}

describe('the styles on offer', () => {
  it('defaults to the one every existing diagram is already drawn as', () => {
    /* `orthogonal` is `getSmoothStepPath`, which is what every saved edge renders as today.
       Any other default would silently re-route every diagram in the database on open. */
    expect(DEFAULT_LINE_STYLE).toBe('orthogonal')
    expect(LINE_STYLES).toContain(DEFAULT_LINE_STYLE)
  })

  it('falls back to the default for anything it does not recognise', () => {
    expect(lineStyleOf(null)).toBe(DEFAULT_LINE_STYLE)
    expect(lineStyleOf({})).toBe(DEFAULT_LINE_STYLE)
    expect(lineStyleOf({ line: 'squiggly' })).toBe(DEFAULT_LINE_STYLE)
    expect(lineStyleOf({ line: 'curved' })).toBe('curved')
  })
})

describe('directionOf', () => {
  it('turns each side into the vector a line leaves along', () => {
    expect(directionOf('right')).toEqual({ x: 1, y: 0 })
    expect(directionOf('left')).toEqual({ x: -1, y: 0 })
    expect(directionOf('top')).toEqual({ x: 0, y: -1 })
    expect(directionOf('bottom')).toEqual({ x: 0, y: 1 })
  })

  it('never returns a zero vector', () => {
    /* A zero direction collapses a curve's control point onto its endpoint, drawing a straight
       line while claiming to be a curve -- so an unknown side has to default to a real
       direction rather than to nothing. */
    for (const value of [undefined, null, '', 'sideways']) {
      const direction = directionOf(value)
      expect(Math.hypot(direction.x, direction.y)).toBeGreaterThan(0)
    }
  })
})

describe('a route with no waypoints', () => {
  it('starts at the source and ends at the target, in every style', () => {
    for (const line of LINE_STYLES) {
      const { path } = route({ line })
      expect(path.startsWith('M 0,0'), line).toBe(true)
      expect(visits(path, to), line).toBe(true)
    }
  })

  it('draws a straight line as exactly two points', () => {
    const { path } = route({ line: 'straight' })
    expect(coordinates(path)).toEqual([from, to])
  })

  it('draws a curve that leans out along the handle directions', () => {
    /* The first control point has to be to the *right* of a source on the right-hand side. A
       curve whose control point leans the other way crosses back over the card it just left. */
    const { path } = route({ line: 'curved' })
    const points = coordinates(path)
    expect(points[1].x).toBeGreaterThan(from.x)
    expect(points[2].x).toBeLessThan(to.x)
  })
})

describe('a route through waypoints', () => {
  const waypoints = [
    { x: 120, y: -80 },
    { x: 300, y: 320 },
  ]

  it('visits every waypoint, in every style', () => {
    /* The invariant the whole feature rests on. A line that does not pass through the point it
       was dragged to has not been routed, it has been decorated. */
    for (const line of LINE_STYLES) {
      const { path } = route({ line, waypoints })
      for (const point of waypoints) {
        expect(visits(path, point), `${line} @ ${point.x},${point.y}`).toBe(true)
      }
    }
  })

  it('visits them in order', () => {
    const { path } = route({ line: 'straight', waypoints })
    expect(coordinates(path)).toEqual([from, ...waypoints, to])
  })

  it('reports the points it routed through, endpoints included', () => {
    /* The handles are drawn from this list, so it has to be the same list the path was built
       from -- otherwise a handle can sit somewhere the line does not go. */
    const { points } = route({ line: 'straight', waypoints })
    expect(points).toEqual([from, ...waypoints, to])
  })

  it('reports the derived corners too, on a right-angle route', () => {
    /* `points` is the route as *drawn*, which for a right-angle line is not the waypoint list --
       the router adds its own corners. The handles have to be on those as well, because the
       corners are exactly what a segment drag moves. */
    const { points } = route({ line: 'orthogonal', waypoints })
    expect(points.length).toBeGreaterThan(waypoints.length + 2)
    expect(points[0]).toEqual(from)
    expect(points.at(-1)).toEqual(to)
    for (const point of waypoints) {
      expect(points.some((found) => found.x === point.x && found.y === point.y)).toBe(true)
    }
  })

  it('keeps a curve continuous across a waypoint', () => {
    /* Catmull-Rom rather than one bezier per pair. A per-pair bezier is smooth only *within* a
       segment: at each waypoint the two curves arrive with different tangents and the line
       visibly kinks at exactly the points placed by hand. Checked structurally -- one `M` and
       then only `C` commands, all joined end to end. */
    const { path } = route({ line: 'curved', waypoints })
    expect(path.match(/M/g)).toHaveLength(1)
    expect(path.match(/C/g).length).toBeGreaterThanOrEqual(2)
    expect(path).not.toMatch(/L/)
  })

  it('keeps an orthogonal route axis-aligned', () => {
    /* Every segment horizontal or vertical, allowing for the rounded corners -- which is what
       "orthogonal" has to mean to be worth choosing over the other two. */
    const { path } = route({ line: 'orthogonal', waypoints })
    const points = coordinates(path)
    for (let index = 1; index < points.length; index += 1) {
      const dx = Math.abs(points[index].x - points[index - 1].x)
      const dy = Math.abs(points[index].y - points[index - 1].y)
      // One axis is (near) unchanged, or this is one leg of a corner fillet.
      const aligned = dx < 1 || dy < 1
      const fillet = dx <= 5.01 && dy <= 5.01
      expect(aligned || fillet, `segment ${index}: ${dx},${dy}`).toBe(true)
    }
  })

  it('leaves an orthogonal route on the axis its handle points along', () => {
    /* Out of a right-hand handle the first move is horizontal; out of a bottom handle it is
       vertical. Choosing per segment by "whichever delta is larger" instead makes the line
       change its mind halfway along and produce a staircase. */
    const sideways = routeEdge({
      source: from,
      target: to,
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints: [{ x: 200, y: 100 }],
      line: 'orthogonal',
    })
    const first = coordinates(sideways.path).slice(0, 2)
    expect(Math.abs(first[1].y - first[0].y)).toBeLessThan(1)

    const downward = routeEdge({
      source: from,
      target: to,
      sourcePosition: 'bottom',
      targetPosition: 'top',
      waypoints: [{ x: 200, y: 100 }],
      line: 'orthogonal',
    })
    const firstDown = coordinates(downward.path).slice(0, 2)
    expect(Math.abs(firstDown[1].x - firstDown[0].x)).toBeLessThan(1)
  })

  it('emits no zero-length dogleg for an already-aligned waypoint', () => {
    /* A waypoint dragged onto the same row as the source needs one straight segment and no
       corner. Emitting the corner anyway is what produces the stray 1px nubs on an otherwise
       clean route. */
    const { path } = routeEdge({
      source: { x: 0, y: 0 },
      target: { x: 400, y: 0 },
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints: [{ x: 200, y: 0 }],
      line: 'orthogonal',
    })
    for (const point of coordinates(path)) expect(point.y).toBe(0)
  })

  it('does not let two close corners eat each other', () => {
    /* The fillet radius is clamped to half the shorter leg. Unclamped, two bends a few pixels
       apart each consume more than the segment between them and the path visibly loops. */
    const { path } = routeEdge({
      source: { x: 0, y: 0 },
      target: { x: 100, y: 100 },
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints: [
        { x: 50, y: 2 },
        { x: 52, y: 4 },
      ],
      line: 'orthogonal',
    })
    expect(path).not.toMatch(/NaN/)
    expect(Number.isFinite(coordinates(path).at(-1).x)).toBe(true)
  })

  it('produces no NaN for a degenerate route', () => {
    /* Every endpoint on the same point. Reachable by dropping both ends of a connector on one
       component, and a NaN in a path string makes the *whole* SVG element vanish -- so the edge
       disappears rather than looking wrong, which is much harder to diagnose. */
    for (const line of LINE_STYLES) {
      const { path } = routeEdge({
        source: { x: 10, y: 10 },
        target: { x: 10, y: 10 },
        sourcePosition: 'right',
        targetPosition: 'left',
        waypoints: [{ x: 10, y: 10 }],
        line,
      })
      expect(path, line).not.toMatch(/NaN/)
    }
  })
})

describe('cleanWaypoints', () => {
  it('drops anything that is not a finite pair', () => {
    /* Waypoints are persisted and hand-editable, so a malformed one is a real input -- and one
       bad entry must not take the whole edge's geometry with it. */
    expect(
      cleanWaypoints([
        { x: 1, y: 2 },
        null,
        { x: 'nope', y: 4 },
        { x: 5 },
        { x: Infinity, y: 0 },
        { x: 7, y: 8 },
      ]),
    ).toEqual([
      { x: 1, y: 2 },
      { x: 7, y: 8 },
    ])
  })

  it('coerces numeric strings, which is what JSON round-tripping can leave', () => {
    expect(cleanWaypoints([{ x: '10', y: '20' }])).toEqual([{ x: 10, y: 20 }])
  })

  it('answers an empty list for anything that is not an array', () => {
    for (const value of [undefined, null, 'x', 42, {}]) expect(cleanWaypoints(value)).toEqual([])
  })
})

describe('editing the route', () => {
  const points = [
    { x: 10, y: 10 },
    { x: 20, y: 20 },
  ]

  it('inserts a new waypoint into the segment it was dragged from', () => {
    /* Segment 0 runs from the source to the first waypoint, so a bend made there has to land
       *before* the existing point or the route doubles back on itself. */
    expect(insertWaypoint(points, 0, { x: 5, y: 5 })).toEqual([{ x: 5, y: 5 }, ...points])
    expect(insertWaypoint(points, 1, { x: 15, y: 15 })).toEqual([points[0], { x: 15, y: 15 }, points[1]])
    expect(insertWaypoint(points, 2, { x: 30, y: 30 })).toEqual([...points, { x: 30, y: 30 }])
  })

  it('clamps an out-of-range index rather than dropping the point', () => {
    expect(insertWaypoint(points, 99, { x: 1, y: 1 })).toHaveLength(3)
    expect(insertWaypoint(points, -5, { x: 1, y: 1 })[0]).toEqual({ x: 1, y: 1 })
  })

  it('rounds, because a sub-pixel drag is a diff on every save', () => {
    expect(insertWaypoint([], 0, { x: 1.4, y: 2.6 })).toEqual([{ x: 1, y: 3 }])
    expect(moveWaypoint(points, 0, { x: 9.5, y: 9.4 })).toEqual([{ x: 10, y: 9 }, points[1]])
  })

  it('never mutates its input', () => {
    const original = [{ x: 1, y: 1 }]
    insertWaypoint(original, 0, { x: 2, y: 2 })
    moveWaypoint(original, 0, { x: 3, y: 3 })
    removeWaypoint(original, 0)
    expect(original).toEqual([{ x: 1, y: 1 }])
  })

  it('ignores a move or a removal aimed at a waypoint that is not there', () => {
    expect(moveWaypoint(points, 5, { x: 0, y: 0 })).toEqual(points)
    expect(removeWaypoint(points, 5)).toEqual(points)
    expect(removeWaypoint(points, -1)).toEqual(points)
  })

  it('removes the one named and leaves the order of the rest', () => {
    const three = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]
    expect(removeWaypoint(three, 1)).toEqual([{ x: 1, y: 1 }, { x: 3, y: 3 }])
  })
})

describe('segmentHandles', () => {
  it('puts one handle at the midpoint of each long enough segment', () => {
    const handles = segmentHandles([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ])
    /* `axis` is the axis the segment *runs* along, which is what makes a drag perpendicular to
       it and locked to one coordinate. */
    expect(handles).toEqual([
      { x: 50, y: 0, index: 0, axis: 'x' },
      { x: 100, y: 50, index: 1, axis: 'y' },
    ])
  })

  it('skips a segment too short to aim at', () => {
    /* On an orthogonal route the little legs either side of a corner are a few pixels long. Two
       handles 3px apart cannot be hit, and a cluster of them over a bend hides the bend. */
    const handles = segmentHandles([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 200, y: 0 },
    ])
    expect(handles).toEqual([{ x: 102, y: 0, index: 1, axis: 'x' }])
  })

  it('gives each handle the index insertWaypoint expects', () => {
    /* The two have to agree, or dragging the third handle bends the second segment. Checked by
       round-tripping rather than by reading the number. */
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ]
    // points = source, one waypoint, target -> one existing waypoint at index 0.
    const existing = [points[1]]
    const handles = segmentHandles(points)
    const bent = insertWaypoint(existing, handles[1].index, { x: 150, y: 50 })
    expect(bent).toEqual([{ x: 100, y: 0 }, { x: 150, y: 50 }])
  })

  it('answers nothing for a route with no segments', () => {
    expect(segmentHandles([])).toEqual([])
    expect(segmentHandles([{ x: 0, y: 0 }])).toEqual([])
    expect(segmentHandles(undefined)).toEqual([])
  })
})

describe('where the label goes', () => {
  it('sits halfway along the line by length, not by segment count', () => {
    /* A route with one long leg and one short one has to label the middle of the *line*, or the
       badge lands at the joint between them. */
    const { x, y } = midpointOf([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 210, y: 0 },
    ])
    expect(x).toBe(105)
    expect(y).toBe(0)
  })

  it('stays on the route when it is bent', () => {
    /* Not the bounding-box centre, which is what React Flow's own helpers return: on a route
       bent around a zone the bounding-box centre is often *inside* the zone, so the merged-count
       badge lands on top of a component. */
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 200 },
      { x: 200, y: 200 },
    ]
    const label = midpointOf(points)
    expect(label).toEqual({ x: 0, y: 200 })
  })

  it('survives a zero-length route', () => {
    expect(midpointOf([{ x: 5, y: 5 }, { x: 5, y: 5 }])).toEqual({ x: 5, y: 5 })
    expect(midpointOf([])).toEqual({ x: 0, y: 0 })
  })
})

/*
 * The shape a right-angle connector takes with nothing stored on it.
 *
 * This is the regression these tests exist for. A first version built a single L-shaped bend --
 * across, then down -- which arrives at the target from *above*. For a left-facing handle that
 * means the line meets the card's top edge rather than its handle, and every right-angle connector
 * on every diagram changed shape at once. The router now reproduces React Flow's own `getPoints`
 * arithmetic, so the default is what it always was.
 */
describe('the default right-angle shape', () => {
  it('is a Z: out, across, and back in on the handle axis', () => {
    const corners = orthogonalCorners({
      source: { x: 0, y: 0 },
      target: { x: 400, y: 200 },
      sourcePosition: 'right',
      targetPosition: 'left',
    })
    /* Four corners, and this is React Flow's own list rather than a tidied version of it: the
       gapped points either end (20 out of the source, 20 back from the target) plus the crossbar at
       the midpoint of the gapped span, x=200. The first three are collinear, so the gapped source
       costs nothing to draw -- but it is a real corner as far as editing goes, which is why it is
       kept rather than trimmed. */
    expect(corners).toEqual([
      { x: 20, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 380, y: 200 },
    ])
  })

  it("arrives travelling along the target handle's own axis", () => {
    /* The property the L-shape broke. The last segment of a route into a left-facing handle has to
       be horizontal, or the line touches the card instead of the handle. */
    const { points } = route({ line: 'orthogonal' })
    const last = points.at(-1)
    const before = points.at(-2)
    expect(Math.abs(last.y - before.y)).toBeLessThan(0.5)
  })

  it("leaves travelling along the source handle's own axis", () => {
    const { points } = route({ line: 'orthogonal' })
    expect(Math.abs(points[1].y - points[0].y)).toBeLessThan(0.5)
  })

  it('goes round when the target is behind the source', () => {
    /* A backwards edge -- right handle to a card on the left. It cannot cross over on the
       perpendicular axis, so it splits the other way and loops. What must not happen is a
       diagonal, or a line that runs back through the card it came from. */
    const { points } = routeEdge({
      source: { x: 400, y: 0 },
      target: { x: 0, y: 0 },
      sourcePosition: 'right',
      targetPosition: 'left',
      line: 'orthogonal',
    })
    for (let index = 1; index < points.length; index += 1) {
      const dx = Math.abs(points[index].x - points[index - 1].x)
      const dy = Math.abs(points[index].y - points[index - 1].y)
      expect(dx < 0.5 || dy < 0.5, `segment ${index}`).toBe(true)
    }
    // And it does leave rightwards before turning back.
    expect(points[1].x).toBeGreaterThan(400)
  })

  it('turns once for a mixed pair of handles', () => {
    /* Right into top: one corner, not two. Emitting a crossbar here would put a needless dogleg on
       what should be a single elbow. */
    const corners = orthogonalCorners({
      source: { x: 0, y: 0 },
      target: { x: 200, y: 200 },
      sourcePosition: 'right',
      targetPosition: 'top',
    })
    expect(corners).toHaveLength(3)
  })

  it('emits no duplicate corner when the crossbar collapses', () => {
    /* A very short backwards edge puts both crossbar corners on the same coordinate. Harmless to
       draw -- the fillet clamps to zero -- but not harmless to edit: `segmentHandles` would offer a
       handle for a zero-length segment, and `dragSegment` would be asked to slide something with no
       direction. React Flow's own version only dedupes the gapped points; this dedupes throughout. */
    const corners = orthogonalCorners({
      source: { x: 0, y: 0 },
      target: { x: 40, y: 100 },
      sourcePosition: 'right',
      targetPosition: 'left',
    })
    for (let index = 1; index < corners.length; index += 1) {
      const dx = Math.abs(corners[index].x - corners[index - 1].x)
      const dy = Math.abs(corners[index].y - corners[index - 1].y)
      expect(dx + dy, `corners ${index - 1}->${index}`).toBeGreaterThan(0.4)
    }
  })
})

/*
 * Sliding a whole segment.
 *
 * The operation the request calls "adjust the height of each part of the line", and it is not the
 * same gesture as adding a bend: moving one *corner* of a Z turns it into a diagonal staircase,
 * where moving the *segment* moves both its corners at once and keeps every angle square.
 */
describe('dragSegment', () => {
  /* A Z: out to x=200, down to y=200, in to the target. Segment 1 is the crossbar. */
  const zed = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 400, y: 200 },
  ]

  it('slides the crossbar sideways without tilting anything', () => {
    const waypoints = dragSegment(zed, 1, { x: 320, y: 999 })
    /* Both corners moved, and only on x -- the y of each is untouched, which is what keeps the two
       horizontal legs horizontal. The 999 is deliberate: a vertical segment must ignore the
       pointer's y entirely, or the drag is not axis-locked. */
    expect(waypoints).toEqual([
      { x: 320, y: 0 },
      { x: 320, y: 200 },
    ])
  })

  it('slides a horizontal segment vertically', () => {
    const stair = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
    ]
    expect(dragSegment(stair, 1, { x: 999, y: 40 })).toEqual([
      { x: 0, y: 40 },
      { x: 300, y: 40 },
    ])
  })

  it('never moves the endpoints, because that is where the handles are', () => {
    /* Dragging the stub segment out of the source is a legitimate gesture -- it means "leave, then
       run across at a new height" -- but it must not drag the handle off the component. */
    const waypoints = dragSegment(zed, 0, { x: 999, y: 60 })
    const route = routeEdge({
      source: zed[0],
      target: zed.at(-1),
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints,
      line: 'orthogonal',
    })
    expect(route.points[0]).toEqual(zed[0])
    expect(route.points.at(-1)).toEqual(zed.at(-1))
  })

  it('refuses a diagonal segment, which has no perpendicular to slide along', () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 0 },
    ]
    /* Unchanged interior, rather than a guess. The caller offers "add a bend" for these. */
    expect(dragSegment(diagonal, 0, { x: 50, y: 500 })).toEqual([{ x: 100, y: 100 }])
  })

  it('drops a corner that collapsed onto its neighbour', () => {
    /* Sliding a crossbar all the way onto the next corner leaves two identical points, which is a
       zero-length segment: a nub on the line and a handle nobody can hit. */
    const waypoints = dragSegment(zed, 1, { x: 400, y: 0 })
    expect(waypoints).toEqual([{ x: 400, y: 0 }, { x: 400, y: 200 }])
    const collapsed = dragSegment(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 100, y: 200 },
        { x: 400, y: 200 },
      ],
      2,
      { x: 100, y: 0 },
    )
    for (let index = 1; index < collapsed.length; index += 1) {
      expect(collapsed[index]).not.toEqual(collapsed[index - 1])
    }
  })

  it('rounds, and ignores an index that is not a segment', () => {
    expect(dragSegment(zed, 1, { x: 320.4, y: 0 })[0].x).toBe(320)
    expect(dragSegment(zed, 99, { x: 0, y: 0 })).toEqual(zed.slice(1, -1))
    expect(dragSegment(zed, -1, { x: 0, y: 0 })).toEqual(zed.slice(1, -1))
    expect(dragSegment([], 0, { x: 0, y: 0 })).toEqual([])
  })

  it('produces waypoints the router then actually draws through', () => {
    /* The round trip that matters: the drag returns waypoints, the router takes them, and the line
       has to end up where the drag put it. A dragSegment that returned coordinates the router then
       re-derived away would look like the drag snapping back. */
    const waypoints = dragSegment(zed, 1, { x: 320, y: 0 })
    const { path } = routeEdge({
      source: zed[0],
      target: zed.at(-1),
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints,
      line: 'orthogonal',
    })
    expect(visits(path, { x: 320, y: 0 })).toBe(true)
    expect(visits(path, { x: 320, y: 200 })).toBe(true)
  })
})

/*
 * Getting out of the way of the components.
 *
 * Best-effort by design -- the request asked it to "try to avoid" -- so what is pinned here is that
 * it clears the obvious cases, that it leaves a clear route alone, and that it gives up rather than
 * inventing a six-bend detour.
 */
describe('avoidingWaypoints', () => {
  const between = (extra = {}) => ({
    source: { x: 0, y: 0 },
    target: { x: 400, y: 0 },
    sourcePosition: 'right',
    targetPosition: 'left',
    ...extra,
  })
  /* A card sitting squarely in the gap, straddling the default crossbar at x=200. */
  const inTheWay = { x: 150, y: -30, width: 100, height: 60 }

  it('leaves a clear route alone', () => {
    expect(avoidingWaypoints({ ...between(), boxes: [] })).toEqual([])
    expect(
      avoidingWaypoints({ ...between(), boxes: [{ x: 0, y: 400, width: 100, height: 60 }] }),
    ).toEqual([])
  })

  it('routes around a component in the gap', () => {
    const waypoints = avoidingWaypoints({ ...between(), boxes: [inTheWay] })
    expect(waypoints.length).toBeGreaterThan(0)

    const { points } = routeEdge({ ...between(), waypoints, line: 'orthogonal' })
    expect(routeHitsAny(points, [inTheWay])).toBe(false)
  })

  it('moves the crossbar rather than looping, when moving it is enough', () => {
    /* The common case and the least surprising fix. A route that went over the top of a card it
       could simply have stepped around reads as the app being clever at the user's expense.

       The two ends are at *different* heights here, deliberately. With both at the same y the
       crossbar is degenerate -- the line is already straight and no bar position changes it -- so
       going over or under really is the only answer, and that case is the next test. */
    const staggered = between({ target: { x: 400, y: 160 } })
    const waypoints = avoidingWaypoints({ ...staggered, boxes: [inTheWay] })

    expect(waypoints).toHaveLength(2)
    // One vertical bar: both corners share an x, and they span the two handle heights.
    expect(waypoints[0].x).toBe(waypoints[1].x)
    expect(waypoints[0].y).toBe(0)
    expect(waypoints[1].y).toBe(160)

    const { points } = routeEdge({ ...staggered, waypoints, line: 'orthogonal' })
    expect(routeHitsAny(points, [inTheWay])).toBe(false)
  })

  it('goes over or under when the two ends are level and the gap is blocked', () => {
    /* Both handles at the same height with a card straddling that line: there is no crossbar
       position that helps, so the only routes left are above and below. */
    const waypoints = avoidingWaypoints({ ...between(), boxes: [inTheWay] })
    expect(waypoints.length).toBeGreaterThan(2)
    const { points } = routeEdge({ ...between(), waypoints, line: 'orthogonal' })
    expect(routeHitsAny(points, [inTheWay])).toBe(false)
  })

  it('goes over or under when the whole band is blocked', () => {
    /* Nothing to step around: the obstacle spans the entire gap horizontally, so the only way past
       is above it or below it. */
    const wall = { x: 40, y: -30, width: 320, height: 60 }
    const waypoints = avoidingWaypoints({ ...between(), boxes: [wall] })
    const { points } = routeEdge({ ...between(), waypoints, line: 'orthogonal' })
    expect(routeHitsAny(points, [wall])).toBe(false)
  })

  it('gives up rather than inventing a detour it cannot justify', () => {
    /* Boxed in on every side. A line through a card is a legible problem with an obvious fix; a
       line that has taken six bends to avoid something is not. */
    const boxed = [
      { x: -1000, y: -1000, width: 3000, height: 990 },
      { x: -1000, y: 10, width: 3000, height: 990 },
      { x: 40, y: -30, width: 320, height: 60 },
    ]
    expect(avoidingWaypoints({ ...between(), boxes: boxed })).toEqual([])
  })

  it('only applies to the right-angle style', () => {
    /* A curve's whole shape is its lean and a straight line has no freedom at all. Bending a
       connector the user asked to be straight would be ignoring the instruction. */
    for (const line of ['curved', 'straight']) {
      expect(avoidingWaypoints({ ...between(), boxes: [inTheWay], line }), line).toEqual([])
    }
  })

  it('ignores a zero-sized box', () => {
    /* A node that has not been measured yet reports no width. Treating that as an obstacle at the
       origin would make every new connector detour around the top-left corner of the canvas. */
    expect(
      avoidingWaypoints({ ...between(), boxes: [{ x: 200, y: 0, width: 0, height: 0 }] }),
    ).toEqual([])
  })
})

describe('segmentHitsBox', () => {
  const box = { x: 100, y: 100, width: 100, height: 100 }

  it('sees a segment crossing the box', () => {
    expect(segmentHitsBox({ x: 0, y: 150 }, { x: 300, y: 150 }, box)).toBe(true)
    expect(segmentHitsBox({ x: 150, y: 0 }, { x: 150, y: 300 }, box)).toBe(true)
  })

  it('sees one that merely touches the border', () => {
    /* Inclusive on purpose: a line flush against a card's edge reads as touching it, and on a
       diagram about what connects to what that is a claim rather than a near miss. */
    expect(segmentHitsBox({ x: 0, y: 100 }, { x: 300, y: 100 }, box)).toBe(true)
  })

  it('lets a segment clear of the box past', () => {
    expect(segmentHitsBox({ x: 0, y: 50 }, { x: 300, y: 50 }, box)).toBe(false)
    expect(segmentHitsBox({ x: 0, y: 0 }, { x: 50, y: 300 }, box)).toBe(false)
  })
})

/*
 * Dragging a corner.
 *
 * The gesture the request calls out specifically, and the one where the obvious implementation is
 * wrong: moving the corner *point* leaves the segment before it no longer axis-aligned, turning a
 * right angle into a diagonal and destroying the thing that makes the style worth choosing. So a
 * corner drag is two segment slides, and what is asserted here is that every angle survives it.
 */
describe('dragCorner', () => {
  /* A Z: out to x=200, down to y=200, in to the target. Corners at indices 1 and 2. */
  const zed = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 400, y: 200 },
  ]

  const route = (waypoints) =>
    routeEdge({
      source: zed[0],
      target: zed.at(-1),
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints,
      line: 'orthogonal',
    })

  it('moves both segments that meet at the corner', () => {
    /* Corner 1 joins the horizontal leg out of the source to the vertical crossbar. Taking it to
       (260, 60) has to slide the horizontal leg down to y=60 *and* the crossbar right to x=260. */
    const waypoints = dragCorner(zed, 1, { x: 260, y: 60 })
    expect(waypoints).toEqual([
      { x: 260, y: 60 },
      { x: 260, y: 200 },
    ])
  })

  it('keeps every angle square', () => {
    /* The property the whole gesture exists to preserve. Checked on the rendered path, not on the
       waypoints, because it is the drawn line that has to stay orthogonal. */
    for (const corner of [1, 2]) {
      const waypoints = dragCorner(zed, corner, { x: 137, y: 83 })
      const { points } = route(waypoints)
      for (let index = 1; index < points.length; index += 1) {
        const dx = Math.abs(points[index].x - points[index - 1].x)
        const dy = Math.abs(points[index].y - points[index - 1].y)
        expect(dx < 0.5 || dy < 0.5, `corner ${corner}, segment ${index}`).toBe(true)
      }
    }
  })

  it('puts the corner under the pointer', () => {
    /* Otherwise the handle drifts away from the cursor as you drag, which makes it feel broken even
       though the geometry is fine. */
    const waypoints = dragCorner(zed, 1, { x: 260, y: 60 })
    const { path } = route(waypoints)
    expect(visits(path, { x: 260, y: 60 })).toBe(true)
  })

  it('never moves the endpoints, which are the handles', () => {
    /* Moving a route's end is reconnecting the edge, which is a different gesture with a different
       affordance -- and one that has to go through the connection validator. */
    for (const corner of [1, 2]) {
      const { points } = route(dragCorner(zed, corner, { x: -500, y: -500 }))
      expect(points[0]).toEqual(zed[0])
      expect(points.at(-1)).toEqual(zed.at(-1))
    }
  })

  it('refuses an endpoint index rather than dragging the handle off the component', () => {
    expect(dragCorner(zed, 0, { x: 50, y: 50 })).toEqual(zed.slice(1, -1))
    expect(dragCorner(zed, zed.length - 1, { x: 50, y: 50 })).toEqual(zed.slice(1, -1))
    expect(dragCorner(zed, 99, { x: 50, y: 50 })).toEqual(zed.slice(1, -1))
    expect(dragCorner([], 1, { x: 0, y: 0 })).toEqual([])
  })

  it('rounds, like every other stored coordinate', () => {
    expect(dragCorner(zed, 1, { x: 260.4, y: 59.6 })[0]).toEqual({ x: 260, y: 60 })
  })
})

describe('cornerHandles', () => {
  it('offers one handle per real bend, indexed into the drawn route', () => {
    const handles = cornerHandles([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 400, y: 200 },
    ])
    expect(handles).toEqual([
      { x: 200, y: 0, index: 1 },
      { x: 200, y: 200, index: 2 },
    ])
  })

  it('skips a point where the line does not actually bend', () => {
    /* These exist: the gapped stub out of a handle is collinear with the leg after it whenever the
       route runs straight out. A handle there would offer to bend a line that visibly has no bend. */
    const handles = cornerHandles([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 400, y: 200 },
    ])
    expect(handles.map((handle) => handle.index)).toEqual([2, 3])
  })

  it('gives an index dragCorner accepts', () => {
    /* Round-tripped rather than read, so the two cannot drift apart. */
    const points = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 400, y: 200 },
    ]
    for (const handle of cornerHandles(points)) {
      const waypoints = dragCorner(points, handle.index, { x: handle.x + 40, y: handle.y + 40 })
      expect(waypoints).not.toEqual(points.slice(1, -1))
    }
  })

  it('answers nothing for a route with no interior points', () => {
    expect(cornerHandles([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toEqual([])
    expect(cornerHandles([])).toEqual([])
    expect(cornerHandles(undefined)).toEqual([])
  })
})
