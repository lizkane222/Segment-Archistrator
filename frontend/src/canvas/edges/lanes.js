/*
 * The route "Straighten" picks: the simplest right-angle path around the components that runs in the
 * corridors *between* zones.
 *
 * `avoidingWaypoints` (routing.js) is a handful of candidates tried in order, and exists for the
 * moment a connector is drawn. This is the deliberate one, run when someone asks for a clean line, so
 * it can afford to search: an A* over the grid of x and y positions that matter (the edges of every
 * component and zone, a lane just outside each zone, the middle of every gap between two zones), with
 *
 *   - a cost per bend, so the answer is the one with the fewest turns rather than the shortest -- the
 *     staircases come from minimising length alone;
 *   - a cost per unit of length run *inside a zone the connector has no business in*, which is what
 *     pushes a line out into the gap beside it. A zone holding both ends is free to cross; a zone
 *     holding one end is cheap, because the line has to leave or enter it; a zone holding neither is
 *     expensive.
 *
 * Pure: boxes in, waypoints out. `null` means no route exists on the grid (an end boxed in), and the
 * caller keeps what it had.
 */

import { STEP_OFFSET, directionOf, orthogonalCorners, routeEdge } from './routing.js'

const CLEARANCE = 12
const LANE = 10
/* Two zones closer than this have a corridor between them worth a lane of its own. */
const GAP_REACH = 160
const BEND = 80
const ONE_END_ZONE = 0.35
const FOREIGN_ZONE = 3
/* Components are blocked a little beyond their border, so a line never reads as touching one. */
const BLOCK = 6
const BORDER = 0.4

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
]
const dirIndex = (vector) => DIRS.findIndex((d) => d.x === Math.sign(vector.x) && d.y === Math.sign(vector.y))

const contains = (box, point) =>
  point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

function hits(a, b, box, margin) {
  return (
    Math.min(a.x, b.x) <= box.x + box.width + margin &&
    Math.max(a.x, b.x) >= box.x - margin &&
    Math.min(a.y, b.y) <= box.y + box.height + margin &&
    Math.max(a.y, b.y) >= box.y - margin
  )
}

/** Binary min-heap on `priority`. */
class Heap {
  constructor() {
    this.items = []
  }
  get size() {
    return this.items.length
  }
  push(item) {
    const items = this.items
    items.push(item)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].priority <= items[i].priority) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }
  pop() {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < items.length && items[l].priority < items[m].priority) m = l
        if (r < items.length && items[r].priority < items[m].priority) m = r
        if (m === i) break
        ;[items[m], items[i]] = [items[i], items[m]]
        i = m
      }
    }
    return top
  }
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b)
}

/**
 * @param source/target   handle positions
 * @param sourcePosition/targetPosition   React Flow side strings
 * @param sourceBox/targetBox   the two components being connected
 * @param boxes   every *other* component
 * @param zones   every zone
 * @returns waypoints (absolute, rounded), `[]` when the default route is already the answer, or null
 */
export function laneWaypoints({ source, target, sourcePosition, targetPosition, sourceBox, targetBox, boxes, zones }) {
  const fromDirection = directionOf(sourcePosition)
  const toDirection = directionOf(targetPosition)
  const stubS = { x: source.x + fromDirection.x * STEP_OFFSET, y: source.y + fromDirection.y * STEP_OFFSET }
  const stubT = { x: target.x + toDirection.x * STEP_OFFSET, y: target.y + toDirection.y * STEP_OFFSET }

  const blockers = [
    ...(boxes ?? []).map((box) => ({ box, margin: BLOCK })),
    ...[sourceBox, targetBox].filter(Boolean).map((box) => ({ box, margin: 1 })),
  ]
  const allBoxes = blockers.map((entry) => entry.box)
  const zoneBoxes = (zones ?? []).filter((zone) => zone.width > 0 && zone.height > 0)

  const sourceAt = sourceBox ? centre(sourceBox) : source
  const targetAt = targetBox ? centre(targetBox) : target
  const zoneKind = zoneBoxes.map((zone) => {
    const hasSource = contains(zone, sourceAt)
    const hasTarget = contains(zone, targetAt)
    return hasSource && hasTarget ? 0 : hasSource || hasTarget ? ONE_END_ZONE : FOREIGN_ZONE
  })

  const xs = [stubS.x, stubT.x, source.x, target.x]
  const ys = [stubS.y, stubT.y, source.y, target.y]
  for (const box of allBoxes) {
    xs.push(box.x - CLEARANCE, box.x + box.width + CLEARANCE)
    ys.push(box.y - CLEARANCE, box.y + box.height + CLEARANCE)
  }
  for (const zone of zoneBoxes) {
    const right = zone.x + zone.width
    const bottom = zone.y + zone.height
    xs.push(zone.x, right, zone.x - LANE, right + LANE, zone.x + LANE, right - LANE)
    ys.push(zone.y, bottom, zone.y - LANE, bottom + LANE, zone.y + LANE, bottom - LANE)
  }
  /* The middle of every corridor between two zones: where one ends and another begins nearby. */
  for (const a of zoneBoxes) {
    for (const b of zoneBoxes) {
      if (a === b) continue
      const aRight = a.x + a.width
      const aBottom = a.y + a.height
      if (b.x >= aRight && b.x - aRight < GAP_REACH) xs.push((aRight + b.x) / 2)
      if (b.y >= aBottom && b.y - aBottom < GAP_REACH) ys.push((aBottom + b.y) / 2)
    }
  }
  const X = sortedUnique(xs)
  const Y = sortedUnique(ys)
  const nx = X.length
  const ny = Y.length
  const indexOf = (list, value) => {
    const rounded = Math.round(value)
    let best = 0
    for (let i = 0; i < list.length; i += 1) if (Math.abs(list[i] - rounded) < Math.abs(list[best] - rounded)) best = i
    return best
  }
  const startNode = indexOf(X, stubS.x) * ny + indexOf(Y, stubS.y)
  const endNode = indexOf(X, stubT.x) * ny + indexOf(Y, stubT.y)
  const at = (node) => ({ x: X[Math.floor(node / ny)], y: Y[node % ny] })

  const penaltyOf = (a, b) => {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    let penalty = 0
    for (let i = 0; i < zoneBoxes.length; i += 1) {
      const zone = zoneBoxes[i]
      if (mid.x > zone.x && mid.x < zone.x + zone.width && mid.y > zone.y && mid.y < zone.y + zone.height) {
        penalty += zoneKind[i]
      }
      /* Not *on* a zone's border either: a line drawn along the dashes reads as part of the zone. */
      const vertical = Math.abs(a.x - b.x) < 0.5
      const edges = vertical ? [zone.x, zone.x + zone.width] : [zone.y, zone.y + zone.height]
      const along = vertical ? a.x : a.y
      const spans = vertical
        ? Math.max(a.y, b.y) > zone.y && Math.min(a.y, b.y) < zone.y + zone.height
        : Math.max(a.x, b.x) > zone.x && Math.min(a.x, b.x) < zone.x + zone.width
      if (spans && edges.some((edge) => Math.abs(edge - along) < 2)) penalty += BORDER
    }
    return penalty
  }
  const blocked = (a, b) => blockers.some((entry) => hits(a, b, entry.box, entry.margin))

  const arrive = dirIndex({ x: -toDirection.x, y: -toDirection.y })
  const leave = dirIndex(fromDirection)
  const stateCount = nx * ny * 4
  const best = new Float64Array(stateCount).fill(Infinity)
  const from = new Int32Array(stateCount).fill(-1)
  const heap = new Heap()
  const start = startNode * 4 + leave
  best[start] = 0
  heap.push({ state: start, priority: 0 })

  const heuristic = (node) => Math.abs(at(node).x - stubT.x) + Math.abs(at(node).y - stubT.y)
  let goal = -1
  let goalCost = Infinity

  while (heap.size) {
    const { state, priority } = heap.pop()
    const node = state >> 2
    const heading = state & 3
    const cost = best[state]
    if (priority > cost + heuristic(node) + 1e-6) continue
    if (priority >= goalCost) break
    if (node === endNode) {
      /* Into the card along the normal: free. Across it: one more bend. Away from it would mean
         doubling back at the arrowhead. */
      const finish = heading === arrive ? 0 : DIRS[heading].x * DIRS[arrive].x + DIRS[heading].y * DIRS[arrive].y === 0 ? BEND : Infinity
      if (cost + finish < goalCost) {
        goalCost = cost + finish
        goal = state
      }
    }
    const here = at(node)
    const ix = Math.floor(node / ny)
    const iy = node % ny
    for (let d = 0; d < 4; d += 1) {
      /* Never straight back the way it came. */
      if (DIRS[d].x === -DIRS[heading].x && DIRS[d].y === -DIRS[heading].y) continue
      const jx = ix + DIRS[d].x
      const jy = iy + DIRS[d].y
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue
      const next = jx * ny + jy
      const there = at(next)
      if (blocked(here, there)) continue
      const length = Math.abs(there.x - here.x) + Math.abs(there.y - here.y)
      const step = length * (1 + penaltyOf(here, there)) + (d === heading ? 0 : BEND)
      const nextState = next * 4 + d
      if (cost + step < best[nextState]) {
        best[nextState] = cost + step
        from[nextState] = state
        heap.push({ state: nextState, priority: cost + step + heuristic(next) })
      }
    }
  }
  if (goal < 0) return null

  /* Walk back to the corners. */
  const chain = []
  for (let state = goal; state >= 0; state = from[state]) chain.push(state)
  chain.reverse()
  const corners = []
  for (let i = 0; i < chain.length; i += 1) {
    const point = at(chain[i] >> 2)
    const isEnd = i === 0 || i === chain.length - 1
    const turns = !isEnd && (chain[i] & 3) !== (chain[i + 1] & 3)
    if (isEnd || turns) corners.push(point)
  }
  /* Corners within a pixel of a stub's line are put exactly on it: the grid is whole numbers and the
     handles are not, and a half-pixel miss is a visible jog at the arrowhead. */
  const snap = (value, ...exact) => exact.find((candidate) => Math.abs(candidate - value) < 1) ?? value
  const waypoints = corners.slice(1, -1).map((point) => ({
    x: snap(point.x, stubS.x, stubT.x),
    y: snap(point.y, stubS.y, stubT.y),
  }))

  /* Nothing to store when the default route is already this one. */
  const defaults = [source, ...orthogonalCorners({ source, target, sourcePosition, targetPosition }), target]
  const chosen = routeEdge({ source, target, sourcePosition, targetPosition, waypoints }).points
  const same =
    defaults.length === chosen.length &&
    defaults.every((point, i) => Math.abs(point.x - chosen[i].x) < 1 && Math.abs(point.y - chosen[i].y) < 1)
  return same ? [] : waypoints
}
