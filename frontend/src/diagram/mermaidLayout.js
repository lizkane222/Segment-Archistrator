/*
 * Positions for whatever an imported Mermaid flowchart brought in without one.
 *
 * Two very different situations arrive here, and they want different things:
 *
 *   - A flowchart someone wrote by hand, or one from another tool. Nothing has a position, and the
 *     only intent there is to honour is the flowchart's own direction -- `flowchart LR` means data
 *     reads left to right. So the whole thing is laid out as a layered graph along that direction:
 *     each component one rank further along than whatever feeds it, zones sized to what they hold,
 *     sub-zones laid out inside their parents the same way. That is what Mermaid itself would draw,
 *     which is the picture the author already has in their head.
 *
 *   - An export from this app, edited and brought back. Almost everything has the position it was
 *     saved with, and moving any of it would be throwing away an arrangement somebody made by hand.
 *     So only what is new is placed: a node someone typed in goes beside the component it is connected
 *     to, a zone someone added goes beside its siblings, and nothing that already had a place moves.
 *
 * Coordinates follow the document's rules -- a component's `position` is relative to its zone, a
 * zone's relative to its parent zone, loose-end points and waypoints are absolute -- so what comes out
 * of here is exactly what `buildLayout` expects to be handed. buildLayout then grows every zone to
 * cover its contents, which is why this never has to resize an existing zone itself.
 */

import { facingSide, fixedHandleForSide } from '../canvas/handles.js'
import { KIND_STYLES } from '../canvas/kinds.js'
import {
  COLUMN_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  ZONE_GAP,
  ZONE_PADDING_BOTTOM,
  ZONE_PADDING_TOP,
  ZONE_PADDING_X,
  zoneSpanSize,
} from '../canvas/layout.js'

/* Room between ranks and between neighbours in one rank. Wider than the palette-drop column gap,
   because these lines carry labels and a label needs somewhere to sit. */
const RANK_GAP = { x: COLUMN_GAP + 30, y: 70 }
const ITEM_GAP = { x: 60, y: 34 }

/* How far a loose end sits from the component it leaves. */
const LOOSE_REACH = 160

const AXES = {
  LR: { main: 'x', cross: 'y', sign: 1 },
  RL: { main: 'x', cross: 'y', sign: -1 },
  TB: { main: 'y', cross: 'x', sign: 1 },
  BT: { main: 'y', cross: 'x', sign: -1 },
}

/** The size a component will draw at, near enough for laying out. */
function nodeBox(node) {
  const width = node.size?.width ?? KIND_STYLES[node.kind]?.defaultWidth ?? NODE_WIDTH
  const height = node.size?.height ?? NODE_HEIGHT
  return { width, height }
}

/**
 * Fill in missing positions and zone geometry.
 *
 * @param graph  `{nodes, edges, zones, ...}` from `mermaidToGraph`
 * @param options.direction  the flowchart's `LR` / `TB` / `RL` / `BT`
 * @param options.directions  per-zone overrides, from a subgraph's own `direction` line
 */
export function layoutMermaidGraph(graph, { direction = 'LR', directions = {}, freshEdges = [] } = {}) {
  /* Connectors the Mermaid introduced (or re-attached), by id: the only ones whose sides are invented
     here. A restored connector with no side keeps having none, so it comes back byte-identical. */
  const fresh = new Set(freshEdges)
  const nodes = graph.nodes.map((node) => ({ ...node }))
  const zones = graph.zones.map((zone) => ({ ...zone }))
  const edges = graph.edges.map((edge) => ({ ...edge }))

  const zoneById = new Map(zones.map((zone) => [zone.id, zone]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  /* Every item's container: a zone, or `null` for the bare canvas. */
  const containerOf = (item) => {
    const parent = 'kind' in item ? item.zone : item.parent
    return parent && zoneById.has(parent) ? parent : null
  }
  const childZones = new Map()
  const childNodes = new Map()
  for (const zone of zones) push(childZones, containerOf(zone), zone)
  for (const node of nodes) push(childNodes, containerOf(node), node)

  /* Which direct child of `container` an item sits in, at any depth -- what an edge between two
     deeply nested components amounts to, one level up. */
  const itemIn = (container, id) => {
    let current = nodeById.get(id) ?? zoneById.get(id) ?? zoneById.get(String(id).replace(/^zone-/, ''))
    const seen = new Set()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      const parent = containerOf(current)
      if (parent === container) return current.id
      current = zoneById.get(parent)
    }
    return null
  }

  const placed = (item) => Boolean(item.position)
  const zoneSized = (zone) => Boolean(zone.position && zone.width && zone.height)

  /* --- a container laid out from nothing --------------------------------------------------- */

  /*
   * Lay out everything directly inside `container` (and, recursively, inside its sub-zones), giving
   * every item a position relative to it. Returns the extent of what was placed.
   *
   * Only called on a container none of whose contents had a position: mixing a layered layout with
   * hand-placed items would put new boxes on top of old ones.
   */
  function layoutFresh(container, flow) {
    const axis = AXES[flow] ?? AXES.LR
    const items = [
      ...(childZones.get(container) ?? []).map((zone) => ({ id: zone.id, zone })),
      ...(childNodes.get(container) ?? []).map((node) => ({ id: node.id, node })),
    ]

    for (const item of items) {
      if (item.zone) {
        const inner = layoutFresh(item.zone.id, directions[item.zone.id] ?? flow)
        const floor = zoneSpanSize({ columns: 1, rows: 1 })
        item.zone.width = Math.max(floor.width, inner.width + ZONE_PADDING_X * 2)
        item.zone.height = Math.max(floor.height, inner.height + ZONE_PADDING_TOP + ZONE_PADDING_BOTTOM)
        item.box = { width: item.zone.width, height: item.zone.height }
      } else {
        item.box = nodeBox(item.node)
      }
    }

    const ranks = rankItems(items, container)
    const extent = placeRanks(ranks, axis)
    /* Inside a zone, clear of its label and its border. */
    const inset = container ? { x: ZONE_PADDING_X, y: ZONE_PADDING_TOP } : { x: 0, y: 0 }
    for (const item of items) {
      const position = { x: Math.round(item.at.x + inset.x), y: Math.round(item.at.y + inset.y) }
      if (item.zone) item.zone.position = position
      else item.node.position = position
    }
    return extent
  }

  /* Longest-path ranks over the edges between this container's items, cycles broken by DFS. */
  function rankItems(items, container) {
    const ids = new Set(items.map((item) => item.id))
    const out = new Map(items.map((item) => [item.id, new Set()]))
    const into = new Map(items.map((item) => [item.id, new Set()]))
    for (const edge of edges) {
      if (edge.source == null || edge.target == null) continue
      const from = itemIn(container, edge.source)
      const to = itemIn(container, edge.target)
      if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) continue
      out.get(from).add(to)
      into.get(to).add(from)
    }

    /* Back edges, found depth-first from items in declaration order, are left out of the ranking -- a
       loop has no first member, and this makes the one written first come first. */
    const state = new Map()
    const back = new Set()
    const visit = (id) => {
      state.set(id, 'open')
      for (const next of out.get(id)) {
        if (state.get(next) === 'open') back.add(`${id}>${next}`)
        else if (!state.has(next)) visit(next)
      }
      state.set(id, 'done')
    }
    for (const item of items) if (!state.has(item.id)) visit(item.id)

    const rank = new Map()
    const rankOf = (id, trail = new Set()) => {
      if (rank.has(id)) return rank.get(id)
      trail.add(id)
      let value = 0
      for (const from of into.get(id)) {
        if (back.has(`${from}>${id}`) || trail.has(from)) continue
        value = Math.max(value, rankOf(from, trail) + 1)
      }
      rank.set(id, value)
      return value
    }
    for (const item of items) rankOf(item.id)

    const byRank = []
    for (const item of items) (byRank[rank.get(item.id)] ??= []).push(item)

    /* One ordering sweep: each rank sorted by where its feeders sit in the rank before. Enough to
       untangle the fan-outs a Segment diagram is made of without a full crossing-minimisation pass. */
    const order = new Map()
    byRank.forEach((list = [], index) => {
      if (index > 0) {
        const score = (item) => {
          const feeders = [...into.get(item.id)].filter((from) => order.has(from))
          return feeders.length ? feeders.reduce((sum, from) => sum + order.get(from), 0) / feeders.length : Infinity
        }
        list.sort((a, b) => score(a) - score(b))
      }
      list.forEach((item, at) => order.set(item.id, at))
    })
    return byRank.filter(Boolean)
  }

  /* Ranks along the main axis, items across it, each rank centred on the widest. */
  function placeRanks(ranks, axis) {
    const mainSize = axis.main === 'x' ? 'width' : 'height'
    const crossSize = axis.cross === 'x' ? 'width' : 'height'
    const rankGap = RANK_GAP[axis.main]
    const itemGap = ITEM_GAP[axis.cross]

    const spans = ranks.map((list) => ({
      main: Math.max(...list.map((item) => item.box[mainSize])),
      cross: list.reduce((sum, item) => sum + item.box[crossSize], 0) + itemGap * (list.length - 1),
    }))
    const crossTotal = Math.max(0, ...spans.map((span) => span.cross))
    const mainTotal = spans.reduce((sum, span) => sum + span.main, 0) + rankGap * Math.max(0, ranks.length - 1)

    let along = 0
    ranks.forEach((list, index) => {
      const span = spans[index]
      let across = (crossTotal - span.cross) / 2
      for (const item of list) {
        /* Centred within its rank's band, so a narrow card beside a wide zone lines up on its middle. */
        const main = along + (span.main - item.box[mainSize]) / 2
        const at = axis.sign > 0 ? main : mainTotal - main - item.box[mainSize]
        item.at = axis.main === 'x' ? { x: at, y: across } : { x: across, y: at }
        across += item.box[crossSize] + itemGap
      }
      along += span.main + rankGap
    })

    return axis.main === 'x'
      ? { width: mainTotal, height: crossTotal }
      : { width: crossTotal, height: mainTotal }
  }

  /* --- an existing diagram with a few new things in it ------------------------------------- */

  const subtreeEmpty = (container) =>
    (childNodes.get(container) ?? []).every((node) => !placed(node)) &&
    (childZones.get(container) ?? []).every((zone) => !zoneSized(zone) && subtreeEmpty(zone.id))

  const anyPlaced =
    nodes.some(placed) || zones.some(zoneSized)

  if (!anyPlaced) {
    layoutFresh(null, direction)
  } else {
    const flow = AXES[direction] ?? AXES.LR
    /* New zones first, outermost first, so a new component inside a new zone is laid out with it. */
    const walk = (container) => {
      for (const zone of childZones.get(container) ?? []) {
        if (!zoneSized(zone) && subtreeEmpty(zone.id)) {
          const inner = layoutFresh(zone.id, directions[zone.id] ?? direction)
          const floor = zoneSpanSize({ columns: 1, rows: 1 })
          zone.width = zone.width ?? Math.max(floor.width, inner.width + ZONE_PADDING_X * 2)
          zone.height = zone.height ?? Math.max(floor.height, inner.height + ZONE_PADDING_TOP + ZONE_PADDING_BOTTOM)
          zone.position = zone.position ?? besideSiblings(container, zone, flow)
        } else {
          if (!zone.position) zone.position = besideSiblings(container, zone, flow)
          if (!zone.width || !zone.height) {
            const floor = zoneSpanSize({ columns: 1, rows: 1 })
            zone.width = zone.width ?? floor.width
            zone.height = zone.height ?? floor.height
          }
          walk(zone.id)
        }
      }
    }
    walk(null)
    for (const node of nodes) if (!placed(node)) node.position = besideNeighbour(node, flow)
  }

  /* Siblings of a container -- its zones and components -- as boxes in its own coordinates. */
  function siblingBoxes(container, except) {
    const boxes = []
    for (const zone of childZones.get(container) ?? []) {
      if (zone === except || !zone.position) continue
      boxes.push({ ...zone.position, width: zone.width ?? 0, height: zone.height ?? 0 })
    }
    for (const node of childNodes.get(container) ?? []) {
      if (node === except || !node.position) continue
      boxes.push({ ...node.position, ...nodeBox(node) })
    }
    return boxes
  }

  function besideSiblings(container, zone, flow) {
    const boxes = siblingBoxes(container, zone)
    const inset = container ? { x: ZONE_PADDING_X, y: ZONE_PADDING_TOP } : { x: 0, y: 0 }
    if (!boxes.length) return inset
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    return flow.main === 'x'
      ? { x: Math.round(right + ZONE_GAP), y: Math.round(top) }
      : { x: Math.round(left), y: Math.round(bottom + ZONE_GAP) }
  }

  /*
   * A new component, beside the already-placed component it is connected to in the same container --
   * one rank downstream of what feeds it, or upstream of what it feeds -- then nudged across the flow
   * until it overlaps nothing. With no placed neighbour, after everything else in its container.
   */
  function besideNeighbour(node, flow) {
    const container = containerOf(node)
    const box = nodeBox(node)
    const siblings = (childNodes.get(container) ?? []).filter((other) => other !== node && other.position)
    let start = null
    for (const edge of edges) {
      const upstream = edge.target === node.id ? edge.source : null
      const downstream = edge.source === node.id ? edge.target : null
      const other = siblings.find((candidate) => candidate.id === (upstream ?? downstream))
      if (!other) continue
      const otherBox = nodeBox(other)
      const step = (upstream ? 1 : -1) * flow.sign
      start =
        flow.main === 'x'
          ? { x: other.position.x + step * (step > 0 ? otherBox.width + RANK_GAP.x : box.width + RANK_GAP.x), y: other.position.y }
          : { x: other.position.x, y: other.position.y + step * (step > 0 ? otherBox.height + RANK_GAP.y : box.height + RANK_GAP.y) }
      break
    }
    if (!start) {
      const boxes = siblingBoxes(container, node)
      const inset = container ? { x: ZONE_PADDING_X, y: ZONE_PADDING_TOP } : { x: 0, y: 0 }
      start = boxes.length
        ? { x: Math.min(...boxes.map((b) => b.x)), y: Math.max(...boxes.map((b) => b.y + b.height)) + ITEM_GAP.y }
        : inset
    }
    /* Never into negative space inside a zone: a child left of its zone's origin draws outside it. */
    if (container) start = { x: Math.max(ZONE_PADDING_X, start.x), y: Math.max(ZONE_PADDING_TOP, start.y) }

    const boxes = siblingBoxes(container, node)
    const position = { ...start }
    for (let guard = 0; guard < 200 && boxes.some((other) => overlaps(other, { ...position, ...box })); guard++) {
      position[flow.cross] += (flow.cross === 'y' ? box.height : box.width) / 2 + ITEM_GAP[flow.cross] / 2
    }
    return { x: Math.round(position.x), y: Math.round(position.y) }
  }

  /* --- loose ends --------------------------------------------------------------------------- */

  /* A component's absolute position: its own plus every enclosing zone's. */
  const absolute = (item) => {
    let x = item.position?.x ?? 0
    let y = item.position?.y ?? 0
    let parent = containerOf(item)
    const seen = new Set()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const zone = zoneById.get(parent)
      x += zone.position?.x ?? 0
      y += zone.position?.y ?? 0
      parent = containerOf(zone)
    }
    return { x, y }
  }

  const flow = AXES[direction] ?? AXES.LR
  for (const edge of edges) {
    for (const [end, other] of [['source', 'target'], ['target', 'source']]) {
      if (edge[end] != null || edge[`${end}Point`]) continue
      const anchor = nodeById.get(edge[other]) ?? zoneById.get(String(edge[other]).replace(/^zone-/, ''))
      if (!anchor) continue
      const at = absolute(anchor)
      const box = 'kind' in anchor ? nodeBox(anchor) : { width: anchor.width ?? 0, height: anchor.height ?? 0 }
      /* Downstream of its source, upstream of its target. */
      const step = (end === 'target' ? 1 : -1) * flow.sign
      edge[`${end}Point`] =
        flow.main === 'x'
          ? { x: Math.round(at.x + (step > 0 ? box.width + LOOSE_REACH : -LOOSE_REACH)), y: Math.round(at.y + box.height / 2) }
          : { x: Math.round(at.x + box.width / 2), y: Math.round(at.y + (step > 0 ? box.height + LOOSE_REACH : -LOOSE_REACH)) }
    }
  }

  /* --- connector sides ---------------------------------------------------------------------- */

  /*
   * Each end of a connector the Mermaid introduced meets the side that faces the other end -- the same
   * rule `facingFor` applies to a connector drawn on the canvas. Without it, an end with no handle falls
   * back to React Flow's first handle, so every imported line leaves the right side of its source and
   * arrives on the right side of its target too, and hooks back on itself to do it.
   *
   * Only for connectors in `freshEdges`, and only an end with no handle of its own: anything restored
   * from the round-trip data is left exactly as it was saved.
   */
  const boxOf = (id) => {
    if (id == null) return null
    const node = nodeById.get(id)
    if (node) return { ...absolute(node), ...nodeBox(node) }
    const zone = zoneById.get(String(id).replace(/^zone-/, ''))
    return zone ? { ...absolute(zone), width: zone.width ?? 0, height: zone.height ?? 0 } : null
  }
  const pointBox = (point) => (point ? { x: point.x, y: point.y, width: 0, height: 0 } : null)
  for (const edge of edges) {
    if (!fresh.has(edge.id)) continue
    const from = boxOf(edge.source) ?? pointBox(edge.sourcePoint)
    const to = boxOf(edge.target) ?? pointBox(edge.targetPoint)
    if (!from || !to) continue
    if (edge.source != null && !edge.sourceHandle && !edge.sourceAnchor) {
      edge.sourceHandle = fixedHandleForSide(facingSide(from, to))
    }
    if (edge.target != null && !edge.targetHandle && !edge.targetAnchor) {
      edge.targetHandle = fixedHandleForSide(facingSide(to, from))
    }
  }

  return { ...graph, nodes, zones, edges }
}

function overlaps(a, b) {
  const pad = 8
  return a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}
