/*
 * One-click tidying: nudge components and zones that are *almost* aligned the rest of the
 * way, without moving anything far enough to look like a relayout.
 *
 * This is not a layout engine. It never decides where anything belongs -- it only notices
 * when several boxes are already close to sharing an edge or a spacing, and finishes the
 * job by the few pixels a mouse would have missed. Two passes, run over the whole diagram
 * rather than a selection, because that is the shape of the request: "tidy this up", not
 * "tidy what I have selected".
 *
 *   1. Within each zone, at any depth: that zone's own direct child components are
 *      clustered by left edge and by top edge. A cluster of two or more whose edges
 *      already sit within a few pixels of each other is snapped to their shared median --
 *      this is what turns three components eyeballed into "roughly a column" into one
 *      that is actually left-aligned. A cluster of three or more that is also already
 *      roughly evenly spaced on the other axis is additionally snapped to perfectly even
 *      spacing on that axis, the same way `distributeNodes` would.
 *   2. One level up: the same clustering, over each top-level zone and each parentless
 *      component treated as a single box, with a larger tolerance because zones are
 *      bigger than the components inside them.
 *
 * Every nudge is capped, independently, at a few pixels: a member whose edge is close but
 * whose move would exceed the cap is left exactly where it was rather than forced. That
 * cap is what keeps this from ever becoming a relayout -- a diagram that is not roughly
 * tidy already comes back from this function unchanged, on purpose.
 *
 * Sub-zones and locked nodes never move and are never used as another node's alignment
 * target -- excluded from the candidate lists entirely, the same way a locked node is
 * simply absent from what `alignNodes` and `distributeNodes` are handed. Nothing is
 * resized. Connector geometry needs no attention here: every edge is already derived from
 * its endpoints' current positions on every render (see edges/routing.js), so a small
 * nudge of an endpoint is a line that redraws correctly on its own.
 */

import { absolutePositions } from './rules.js'
import { boxOf } from './selection.js'

/** How close two edges have to already be, within one zone, to count as "meant to align". */
const WITHIN_ZONE_TOLERANCE = 24

/** The same, one level up, where the boxes being compared are zones rather than cards. */
const ACROSS_ZONE_TOLERANCE = 40

/** How much daylight a gap can vary by and still read as "already evenly spaced". */
const SPACING_TOLERANCE = 16

/** The most any one node is nudged. Anything needing more is left alone rather than forced. */
const NUDGE_CAP = 16

/**
 * Chain-clusters a set of `{id, value}` entries: sort by `value`, then group consecutive
 * entries whose gap to the previous one is within `tolerance`. Singletons are dropped --
 * there is nothing to align a lone box to.
 *
 * Chaining rather than a tighter definition (e.g. every pair within tolerance of every
 * other) on purpose: with a tolerance this small the difference only matters for a cluster
 * already spanning more than the tolerance end-to-end, which the per-node nudge cap below
 * would refuse the far end of anyway.
 */
function clusterByEdge(entries, tolerance) {
  const sorted = [...entries].sort((a, b) => a.value - b.value)
  const clusters = []
  let current = sorted.length ? [sorted[0]] : []
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].value - sorted[i - 1].value <= tolerance) {
      current.push(sorted[i])
    } else {
      if (current.length >= 2) clusters.push(current)
      current = [sorted[i]]
    }
  }
  if (current.length >= 2) clusters.push(current)
  return clusters
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Snaps a cluster to its shared median along `axis`, skipping any member the cap refuses. */
function alignCluster(cluster, axis, addDelta) {
  const target = median(cluster.map((entry) => entry.value))
  for (const entry of cluster) {
    const delta = Math.round(target - entry.value)
    if (delta === 0 || Math.abs(delta) > NUDGE_CAP) continue
    addDelta(entry.id, axis, delta)
    entry.value += delta
  }
}

/**
 * If a cluster of three or more is already roughly evenly spaced on the cross axis, snaps
 * it the rest of the way to perfectly even gaps -- same idea as `distributeNodes`, and for
 * the same reason its two ends stay put: they are what the user placed on purpose, and the
 * interior is what a mouse could not quite line up.
 */
function evenlySpaceCluster(cluster, crossAxis, addDelta) {
  if (cluster.length < 3) return
  const sorted = [...cluster].sort((a, b) => a.cross - b.cross)
  const gaps = []
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].cross - sorted[i - 1].cross)
  const average = gaps.reduce((total, gap) => total + gap, 0) / gaps.length
  if (gaps.some((gap) => Math.abs(gap - average) > SPACING_TOLERANCE)) return

  let cursor = sorted[0].cross
  for (let i = 1; i < sorted.length - 1; i++) {
    cursor += average
    const delta = Math.round(cursor - sorted[i].cross)
    if (delta === 0 || Math.abs(delta) > NUDGE_CAP) continue
    addDelta(sorted[i].id, crossAxis, delta)
    sorted[i].cross += delta
  }
}

/** Both axes of one clustering pass over one set of boxes. */
function alignGroup(entries, tolerance, addDelta) {
  const byLeft = entries.map((entry) => ({ id: entry.id, value: entry.box.x, cross: entry.box.y }))
  for (const cluster of clusterByEdge(byLeft, tolerance)) {
    alignCluster(cluster, 'x', addDelta)
    evenlySpaceCluster(cluster, 'y', addDelta)
  }

  const byTop = entries.map((entry) => ({ id: entry.id, value: entry.box.y, cross: entry.box.x }))
  for (const cluster of clusterByEdge(byTop, tolerance)) {
    alignCluster(cluster, 'y', addDelta)
    evenlySpaceCluster(cluster, 'x', addDelta)
  }
}

/**
 * Nudges the whole diagram towards clean alignment and spacing. Pure, and total: run over
 * every node rather than a selection, since "tidy this up" has no notion of what is
 * selected.
 */
export function autoAlignNodes(nodes) {
  const list = nodes ?? []
  if (!list.length) return list

  const positions = absolutePositions(list)
  const boxFor = (node) => boxOf(node, positions)

  const deltas = new Map()
  const addDelta = (id, axis, amount) => {
    const entry = deltas.get(id) ?? { x: 0, y: 0 }
    entry[axis] += amount
    deltas.set(id, entry)
  }

  for (const zone of list) {
    if (zone.type !== 'zone' || zone.data?.locked) continue
    const members = list
      .filter((node) => node.type !== 'zone' && node.parentId === zone.id && !node.data?.locked)
      .map((node) => ({ id: node.id, box: boxFor(node) }))
    alignGroup(members, WITHIN_ZONE_TOLERANCE, addDelta)
  }

  const topLevel = list
    .filter((node) => !node.parentId && !node.data?.locked)
    .map((node) => ({ id: node.id, box: boxFor(node) }))
  alignGroup(topLevel, ACROSS_ZONE_TOLERANCE, addDelta)

  if (deltas.size === 0) return list

  return list.map((node) => {
    const delta = deltas.get(node.id)
    if (!delta) return node
    return {
      ...node,
      position: {
        x: Math.round((node.position?.x ?? 0) + delta.x),
        y: Math.round((node.position?.y ?? 0) + delta.y),
      },
    }
  })
}
