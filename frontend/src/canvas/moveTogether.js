/*
 * Moving a group of things without rearranging what joins them.
 *
 * Two jobs, both about a zone (or a selection) being moved as one piece.
 *
 * ## Everything inside a zone goes with it
 *
 * A zone only carries what is *parented* to it. A component drawn inside a zone's box before the zone
 * existed, or a sub-zone dropped there, can sit entirely within the backdrop and still be nobody's child --
 * so dragging the zone left it behind and the diagram came apart. `adoptInside` makes what is physically
 * inside a zone belong to it, which is what the box was already saying.
 *
 * ## Connectors between things that moved together keep their shape
 *
 * A connector's bends are stored as absolute coordinates. Move both of its ends by the same distance and
 * the bends stay where they were, so the line re-routes round them and changes shape -- and `onNodeDragStop`
 * then re-faced the ends and re-ran the router on top of that. When both ends moved by the same amount the
 * whole line moved, so its bends are shifted by that amount and nothing else is touched.
 */

import { absolutePositions, toZoneLocal } from './rules.js'
import { componentSize, zoneSize } from './layout.js'

const DEFAULT_WIDTH = 200
const DEFAULT_HEIGHT = 60

function boxOf(node, positions) {
  const at = positions.get(node.id) ?? { x: 0, y: 0 }
  if (node.type === 'zone') {
    const { width, height } = zoneSize(node)
    return { x: at.x, y: at.y, width, height }
  }
  const chosen = componentSize(node)
  return {
    x: at.x,
    y: at.y,
    width: chosen.width ?? node.measured?.width ?? DEFAULT_WIDTH,
    height: chosen.height ?? node.measured?.height ?? DEFAULT_HEIGHT,
  }
}

const within = (inner, outer, slack = 2) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack

const centreIn = (inner, outer) => {
  const cx = inner.x + inner.width / 2
  const cy = inner.y + inner.height / 2
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height
}

/**
 * The ids of what is inside `zoneId`'s box but is not its descendant, at the zone's own level.
 *
 * A component counts when its centre is inside, a zone when it is wholly inside -- a zone that merely
 * overlaps the edge is a neighbour, not a child. Never an ancestor, never a node at some other level
 * (a different zone's child is that zone's business).
 */
export function insideButNotParented(nodes, zoneId) {
  const all = nodes ?? []
  const zone = all.find((node) => node.id === zoneId && node.type === 'zone')
  if (!zone) return []
  const positions = absolutePositions(all)
  const outer = boxOf(zone, positions)
  const parents = new Map(all.map((node) => [node.id, node.parentId ?? null]))

  const ancestors = new Set()
  for (let at = zone.parentId; at && !ancestors.has(at); at = parents.get(at)) ancestors.add(at)

  return all
    .filter((node) => {
      if (node.id === zone.id || ancestors.has(node.id)) return false
      if ((node.parentId ?? null) !== (zone.parentId ?? null)) return false
      const box = boxOf(node, positions)
      return node.type === 'zone' ? within(box, outer) : centreIn(box, outer)
    })
    .map((node) => node.id)
}

/**
 * The nodes with everything physically inside `zoneId` made its child. Returns the same array when there
 * was nothing to adopt.
 *
 * Both halves of the fact are written -- `parentId` for the canvas, `data.zone` or `data.parent` for the
 * document -- and the position is converted to the zone's own coordinates, so nothing visibly moves.
 */
export function adoptInside(nodes, zoneId) {
  const ids = new Set(insideButNotParented(nodes, zoneId))
  if (!ids.size) return nodes
  const zone = nodes.find((node) => node.id === zoneId)
  const positions = absolutePositions(nodes)
  const zoneKey = zone.data?.id
  return nodes.map((node) => {
    if (!ids.has(node.id)) return node
    const local = toZoneLocal(zone, positions.get(node.id), nodes)
    return {
      ...node,
      parentId: zone.id,
      position: { x: Math.round(local.x), y: Math.round(local.y) },
      data: node.type === 'zone' ? { ...node.data, parent: zoneKey } : { ...node.data, zone: zoneKey },
    }
  })
}

/** Every node's absolute position, rounded -- the snapshot a drag compares itself against. */
export function snapshotPositions(nodes) {
  const out = new Map()
  for (const [id, at] of absolutePositions(nodes)) out.set(id, { x: Math.round(at.x), y: Math.round(at.y) })
  return out
}

/** How far each node has moved since `before`, as a function of id: `{dx, dy}` or null. */
export function movedBy(before, after) {
  return (id) => {
    const a = before.get(id)
    const b = after.get(id)
    if (!a || !b) return null
    const dx = b.x - a.x
    const dy = b.y - a.y
    return dx || dy ? { dx, dy } : null
  }
}

/** Did both ends of this connector move by the same amount? Returns that amount, or null. */
export function movedTogether(edge, deltaOf) {
  const a = deltaOf(edge.source)
  const b = edge.target ? deltaOf(edge.target) : null
  return a && b && a.dx === b.dx && a.dy === b.dy ? a : null
}

/**
 * The connectors with the bends of every one that moved as a whole carried along by that amount. The same
 * array when none did. `together` is filled with the ids of those, so the caller can leave them alone
 * afterwards.
 */
export function carryBends(edges, deltaOf, together = new Set()) {
  let changed = false
  const next = edges.map((edge) => {
    const delta = movedTogether(edge, deltaOf)
    if (!delta) return edge
    together.add(edge.id)
    const bends = edge.data?.waypoints
    if (!bends?.length) return edge
    changed = true
    return {
      ...edge,
      data: { ...edge.data, waypoints: bends.map((point) => ({ x: point.x + delta.dx, y: point.y + delta.dy })) },
    }
  })
  return changed ? next : edges
}
