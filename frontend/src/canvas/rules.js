/*
 * Client-side enforcement of the architecture rules.
 *
 * Every function here reads the topology payload fetched from
 * /api/meta/topology. None of the rules are written down in this file -- that is
 * the point. Hardcoding an adjacency table here would create a second source of
 * truth that drifts from the server's, and the canvas would start permitting
 * diagrams the backend rejects.
 *
 * These checks are for immediate feedback, not security. The server re-validates
 * on save.
 *
 * Edge kind-pairs are the one thing this file deliberately does not enforce: any
 * component may connect to any other, including back to itself. ALLOWED_EDGES in
 * topology.py still exists for template linting, but the canvas no longer reads
 * it as a rule for a user-drawn edge.
 */

import { componentSize, zoneNodeId, zoneSize } from './layout.js'

/* Kinds with no topology entry, so no zone and no adjacency table. A custom
   component stands for something the customer runs themselves -- their own
   service, a warehouse they own outright -- and there is nothing for Segment's
   rules to say about it. Listed here rather than read from kinds.js: whether a
   kind has rules is a rules question, and importing the icon table to answer it
   would make the two files circular in spirit if not yet in fact. */
export const RULE_FREE_KINDS = new Set(['custom'])

/* Zones that hold products rather than components -- see CONTAINER_ZONES in
   topology.py, which is where the reasoning lives. Hardcoded here for the same
   reason RULE_FREE_KINDS is: it is not in the topology payload, and it is a
   statement about one zone id that has been the root of the tree since there was
   a tree. */
export const CONTAINER_ZONES = new Set(['segment'])

export function kindOf(node) {
  return node?.data?.kind ?? null
}

export function zoneOfParent(parentId) {
  return parentId?.startsWith('zone-') ? parentId.slice('zone-'.length) : null
}

/** The zone a kind is allowed to live in, or null if the kind is unknown. */
export function expectedZone(topology, kind) {
  return topology?.kinds?.[kind]?.zone ?? null
}

export function zoneLabel(topology, zoneId) {
  return topology?.zones?.find((zone) => zone.id === zoneId)?.label ?? zoneId
}

/**
 * A zone and its ancestors, innermost first.
 *
 * Walks topology.py's tree rather than the document's own `parent` links, matching
 * what validate_architecture does and for the same reason: product zones nest one
 * way only, and honouring a document's claim about the tree would let a stale tab
 * declare Unify a child of Connections. Cycle-guarded because the chain is walked
 * on every drag frame and a bad table should fail a test, not hang the canvas.
 */
export function zoneChain(topology, zone) {
  const chain = []
  const seen = new Set()
  let current = zone
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current.id)
    const parentId = current.parent
    current = parentId ? topology?.zones?.find((entry) => entry.id === parentId) : null
  }
  return chain
}

/**
 * Every zone a kind may be dropped straight into, innermost first.
 *
 * Mirrors topology.py's `placement_zones`. The kind's home, plus whatever that home
 * merely subdivides: a profile source is homed in Profile Sources, which is a
 * `subdivision` of Unify, so Unify itself takes one too. The ascent stops at the
 * first zone that is not a subdivision, which is what keeps a component from landing
 * on the Segment backdrop in no product at all.
 *
 * The `subdivision` flag comes from the topology payload rather than being decided
 * here, per this file's header -- which zones are optional refinements is a rules
 * question and has one answer, in Python.
 */
export function placementZones(topology, kind) {
  const expected = expectedZone(topology, kind)
  if (expected === null) return []

  const zones = [expected]
  const byId = new Map((topology?.zones ?? []).map((zone) => [zone.id, zone]))
  let current = expected
  // Cycle-guarded via `zones`, for the same reason zoneChain is.
  while (byId.get(current)?.subdivision) {
    const parent = byId.get(current)?.parent
    if (!parent || zones.includes(parent)) break
    zones.push(parent)
    current = parent
  }
  return zones
}

/**
 * May `kind` live in `zone`?
 *
 * Takes the zone itself, not its id, because the answer depends on more than the
 * id: a custom zone is somewhere outside Segment -- the customer's app, a
 * warehouse they own -- and Segment's pipeline zones have no jurisdiction there.
 * Mirrored by validate_architecture, which skips the same rule for the same
 * reason.
 *
 * A rule-free kind is accepted anywhere for the converse reason: the topology has
 * no zone to compare against, so there is no rule to break.
 *
 * Otherwise, two ways to be satisfied. Downward: the kind's own zone is the drop
 * target or one of its ancestors -- a computed trait belongs in Unify and Unify's
 * Profiles sub-zone is still Unify. Upward, and only over subdivisions: a profile
 * dropped on the bare Unify backdrop rather than inside the optional Profiles box is
 * filed correctly, and used to be warned about against a zone that need not even
 * exist on the canvas.
 *
 * Checked as two rules rather than one combined chain, which would make a profile
 * legal in Profile Sources -- the sideways move between sibling subdivisions, and the
 * one misfiling among them that is real.
 */
export function isValidPlacement(topology, kind, zone) {
  if (zone?.custom) return true
  /* A container zone holds products, not components. The Segment backdrop says "this
     is inside Segment" and deliberately does not answer which product owns it, which
     is the only honest answer for something that belongs to two -- Profiles Sync, or
     a Reverse ETL model spanning the customer's warehouse and Segment's delivery.
     Mirrors CONTAINER_ZONES in topology.py. */
  if (CONTAINER_ZONES.has(zone?.id)) return true
  if (RULE_FREE_KINDS.has(kind)) return true
  const expected = expectedZone(topology, kind)
  if (expected === null) return false
  return (
    zoneChain(topology, zone).includes(expected) ||
    placementZones(topology, kind).includes(zone?.id ?? null)
  )
}

/**
 * React Flow's `isValidConnection` callback.
 *
 * Rejects, in order: a missing endpoint, and duplicates. A self-connection is
 * allowed -- each node has exactly one fixed target handle and one fixed source
 * handle, so the only way to draw one is deliberate, and there is no rule left
 * that would say no to it. A zone backdrop is a legal endpoint too, so one zone
 * can be drawn feeding another. Returning false means the edge never renders and
 * the handle shows as invalid mid-drag, so the user gets the answer before
 * releasing the mouse.
 */
export function makeConnectionValidator({ topology, getNode, edges }) {
  return function isValidConnection(connection) {
    const { source, target } = connection
    if (!source || !target) return false

    /* Fail closed until the rules have loaded. Permitting everything for the first
       few hundred milliseconds would let a user draw an edge the server then
       rejects at save time, long after they stopped thinking about it. */
    if (!topology?.kinds) return false

    const from = getNode(source)
    const to = getNode(target)
    if (!from || !to) return false

    const duplicate = edges.some((e) => e.source === source && e.target === target)
    if (duplicate) return false

    return true
  }
}

/**
 * Why a connection was refused, in words a user can act on.
 *
 * React Flow's isValidConnection is a boolean, so this is called separately from
 * onConnect's failure path to produce the toast. Kept beside the validator so the
 * two cannot disagree about the reason.
 */
export function explainRejection({ from, to, edges }) {
  if (!from || !to) return 'One end of that connection is missing.'
  if (edges.some((e) => e.source === from.id && e.target === to.id)) {
    return 'Those two are already connected.'
  }

  return 'That connection is not allowed.'
}

/**
 * Why a drop was refused. Names the correct zone, per the brief.
 *
 * `attemptedZone` is the zone descriptor, matching `isValidPlacement`. Its own
 * label is preferred over a topology lookup because a custom zone is named by the
 * user and the topology has never heard of it.
 */
export function explainMisplacement({ topology, kind, attemptedZone }) {
  const kindLabel = topology?.kinds?.[kind]?.label ?? kind
  const correct = expectedZone(topology, kind)
  if (!correct) return `${kindLabel} is not a component this canvas knows about.`
  const attempted = attemptedZone?.label ?? zoneLabel(topology, attemptedZone?.id)
  return `${kindLabel} belongs in ${zoneLabel(topology, correct)}, not ${attempted}.`
}

/*
 * Where a zone actually sits, and how deep it is nested.
 *
 * A sub-zone's `position` is relative to its parent -- that is how React Flow
 * stores any child -- so a point in flow coordinates cannot be compared against it
 * without summing the chain first. Cycle-guarded for the same reason zoneChain is:
 * the chain here comes from live canvas state, and a bad `parentId` should fail a
 * test rather than hang a drop.
 */
function zoneAnchor(zone, byId) {
  let x = 0
  let y = 0
  let depth = -1
  const seen = new Set()
  let current = zone
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    x += current.position?.x ?? 0
    y += current.position?.y ?? 0
    depth += 1
    current = current.parentId ? byId.get(current.parentId) : null
  }
  return { x, y, depth }
}

/** A zone's origin in flow coordinates, resolved through its ancestors. */
export function zoneOrigin(zone, nodes) {
  const { x, y } = zoneAnchor(zone, new Map((nodes ?? []).map((node) => [node.id, node])))
  return { x, y }
}

/**
 * Any node's position in flow coordinates.
 *
 * The same sum as `zoneOrigin` -- a node's stored position is relative to whatever it
 * is a child of, at every level -- but named for the question a drag asks: the drag
 * ended *there*, on screen, and what has to be worked out is which zone `there` is
 * inside. Comparing the raw `position` against a zone's box is the bug this exists to
 * stop, and it is invisible until something is nested two deep.
 */
export function absolutePosition(node, nodes) {
  return zoneOrigin(node, nodes)
}

/**
 * Every node's position in flow coordinates, in one pass.
 *
 * The same answer as calling `absolutePosition` per node, but the id map is built once
 * rather than once per node. That matters for the callers that run on a whole array
 * instead of on the one node a drag is about -- the anchor gutter recomputes on every
 * frame of a pan, and quadratic there is a frame budget spent resolving parents that
 * have not moved.
 */
export function absolutePositions(nodes) {
  const all = nodes ?? []
  const byId = new Map(all.map((node) => [node.id, node]))
  return new Map(
    all.map((node) => {
      const { x, y } = zoneAnchor(node, byId)
      return [node.id, { x, y }]
    }),
  )
}

/**
 * A node's centre, in flow coordinates.
 *
 * A chosen size beats a measured one for the same reason it does in `childExtent`: the
 * frame after a resize, `measured` still describes the old box. Getting that wrong here
 * re-homes a component by the centre it used to have, which on a card dragged narrow
 * next to a zone edge is the difference between Connections and bare canvas.
 */
export function centreOf(node, nodes, { width = 0, height = 0 } = {}) {
  const { x, y } = absolutePosition(node, nodes)
  const chosen = componentSize(node)
  const w =
    node.type === 'zone' ? zoneSize(node).width : (chosen.width ?? node.measured?.width ?? width)
  const h =
    node.type === 'zone'
      ? zoneSize(node).height
      : (chosen.height ?? node.measured?.height ?? height)
  return { x: x + w / 2, y: y + h / 2 }
}

/** Is `candidateId` inside `nodeId`'s own subtree? */
export function isDescendant(nodes, nodeId, candidateId) {
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]))
  const seen = new Set()
  let current = byId.get(candidateId)
  while (current && !seen.has(current.id)) {
    if (current.id === nodeId) return true
    seen.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : null
  }
  return false
}

/**
 * Which zone a node should belong to after being dropped, and where that puts it.
 *
 * Returns `{zone, position}` -- `zone` being the zone *node* or null for the working
 * area outside every zone -- or null when nothing needs to change.
 *
 * Decided by the node's centre rather than by its top-left corner. Dropping by corner
 * means a component half in Unify and half on bare canvas goes wherever its corner
 * happens to be, which from the user's side is a coin toss; the centre is the part
 * they aimed.
 *
 * A zone is never reparented into its own subtree. Dragging Segment onto Unify would
 * otherwise make Segment a child of a zone inside Segment, and everything that walks
 * the chain -- the coordinate sums here, `growZones`, React Flow's own renderer --
 * would recurse until it gave up.
 */
export function reparentTarget(node, nodes, { size } = {}) {
  const centre = centreOf(node, nodes, size ?? {})
  const candidates = (nodes ?? []).filter(
    (entry) => entry.id !== node.id && !isDescendant(nodes, node.id, entry.id),
  )
  const zone = zoneAtPosition(candidates, centre)

  const currentParent = node.parentId ?? null
  const nextParent = zone?.id ?? null
  if (currentParent === nextParent) return null

  const absolute = absolutePosition(node, nodes)
  const origin = zone ? zoneOrigin(zone, nodes) : { x: 0, y: 0 }
  return {
    zone: zone ?? null,
    position: { x: Math.round(absolute.x - origin.x), y: Math.round(absolute.y - origin.y) },
  }
}

/**
 * Which destination a dropped mapping should auto-attach to, or null.
 *
 * Containment, not proximity: a mapping dragged past a destination toward
 * something else on the far side of it should not attach just for having passed
 * close by. Ties -- two destinations happen to overlap at the drop point -- go to
 * the nearer centre, the same tie-break `zoneAtPosition` uses depth for.
 */
export function attachTargetFor(node, nodes, { size } = {}) {
  const centre = centreOf(node, nodes, size ?? {})
  const candidates = (nodes ?? []).filter(
    (entry) =>
      entry.id !== node.id &&
      (kindOf(entry) === 'destination' || kindOf(entry) === 'destination_function'),
  )

  let best = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const box = absolutePosition(candidate, nodes)
    const chosen = componentSize(candidate)
    const w = chosen.width ?? candidate.measured?.width ?? size?.width ?? 0
    const h = chosen.height ?? candidate.measured?.height ?? size?.height ?? 0
    if (centre.x < box.x || centre.x > box.x + w) continue
    if (centre.y < box.y || centre.y > box.y + h) continue

    const candidateCentre = centreOf(candidate, nodes, size ?? {})
    const dx = candidateCentre.x - centre.x
    const dy = candidateCentre.y - centre.y
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Which zone backdrop contains a point, in flow coordinates.
 *
 * Used on drop from the palette: React Flow tells us where the pointer landed, and
 * this decides whose child the new node becomes. The deepest containing zone wins,
 * so a drop inside Profiles lands in Profiles rather than in Unify, which contains
 * it and is therefore also a hit. Depth ties go to the zone declared last -- the
 * same rule the renderer's paint order follows, and the only sensible answer for
 * two hand-drawn zones that overlap.
 */
export function zoneAtPosition(nodes, position) {
  const all = nodes ?? []
  const byId = new Map(all.map((node) => [node.id, node]))

  let found = null
  let foundDepth = -1
  for (const zone of all) {
    if (zone.type !== 'zone') continue
    const anchor = zoneAnchor(zone, byId)
    if (anchor.depth < foundDepth) continue
    const { width, height } = zoneSize(zone)
    if (
      position.x >= anchor.x &&
      position.x <= anchor.x + width &&
      position.y >= anchor.y &&
      position.y <= anchor.y + height
    ) {
      found = zone
      foundDepth = anchor.depth
    }
  }
  return found
}

/**
 * Flow coordinates -> zone-local, for a node about to become a zone's child.
 *
 * `nodes` is what resolves a sub-zone's ancestors; pass the canvas's node list, not
 * just the zone. Omitting it is only correct for a zone with no parent.
 */
export function toZoneLocal(zone, position, nodes) {
  const origin = zoneOrigin(zone, nodes)
  return { x: position.x - origin.x, y: position.y - origin.y }
}

export { zoneNodeId }
