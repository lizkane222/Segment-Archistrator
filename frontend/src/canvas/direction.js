/*
 * Which way a connector points, and how to put it right.
 *
 * A connector is directed: the walkthrough walks `source -> target` and nothing else, so a
 * line drawn the wrong way round is not a cosmetic problem -- it is a component the event
 * can never reach. That is worth its own module because the wrong way round is the *easy*
 * way to draw one.
 *
 * ## Why the diagrams in the database are full of backwards connectors
 *
 * Not because the user drew them backwards. Every side of every card carries a source handle
 * *and* a target handle, stacked under one id (canvas/handles.js) -- and React Flow reports a
 * drag begun on a `target` handle with the ends the other way round. The target is the one
 * painted second, so it is the one the pointer lands on, so *every* connector drawn by
 * grabbing a handle came out reversed. Consistently, not half the time.
 *
 * `orientConnection` at the foot of this file is the fix, and it is a fix at the source:
 * direction now comes from the gesture -- data flows the way you dragged -- rather than from
 * which of two invisible, identically-placed handles happened to be on top. Diagrams drawn
 * before it exists still need the tools below.
 *
 * The arrowheads (canvas/layout.js) are the other half of the answer: they make the
 * direction readable, so a reversed connector is something you can see rather than
 * something you discover when a path stops halfway.
 *
 * ## Why there is no "work out the directions for me"
 *
 * The obvious tool -- walk out from the component the reader starts at and point every
 * connector the way it was first reached -- was written, tested, and removed. It forces the
 * diagram into a tree rooted at the start, and a Segment architecture is not a tree: two
 * sources feeding one destination is the commonest shape there is, and orienting outward
 * turns the second source's connector round so the *destination* feeds it. That is a wrong
 * diagram produced silently from a right one, which is worse than the backwards connector
 * it set out to fix.
 *
 * No heuristic gets out of this. Rescuing a chain drawn entirely end-to-start requires
 * traversing against the arrows to discover components; preserving a fan-in requires
 * refusing to. Those are the same operation on the same shape, so nothing local to a
 * connector can tell them apart.
 *
 * So every tool here for *repairing* direction is a thing the user says rather than a thing the
 * code guesses:
 *
 *   - `reversible` backs "reverse these connectors", from one connector up to the whole
 *     diagram. A diagram drawn end-to-start is exactly one click, and the click means what
 *     it says.
 *   - `flowsAlong`/`orientAlong` back "data flows left / right / up / down along this
 *     connector". This is the one to reach for, and it is stated in the vocabulary the
 *     reader already has: a diagram is laid out on a screen, so "downward" is a fact about
 *     it that needs no graph theory. It reads the two components' positions rather than
 *     their kinds, so it is right about a diagram drawn top-to-bottom, one drawn
 *     right-to-left, and one drawn by hand in no particular order.
 *   - `orientSide` backs "the connectors on this side of this card flow this way", for the
 *     rarer case where one component's lines disagree with each other.
 *   - `routeToReach` backs "put this component on that path". Also a thing the user says:
 *     naming the component to reach is the missing piece of information no heuristic had, and
 *     with it the ambiguity above disappears -- only the connectors on the route to *that*
 *     component are touched, so every fan-in elsewhere on the diagram is left alone.
 *
 * Everything here is pure and returns *ids to reverse* rather than new edge arrays. The
 * caller owns the edge state and has one write path for it (`reverseEdges` in AppShell),
 * so a reversal made from the connector menu, from a bulk action, or from the diagnostics
 * report is one code path and one undo entry.
 */

import { LEGACY_SOURCE, LEGACY_TARGET, SIDES, parseFreeHandle } from './handles.js'

/** Side id (`'e'`) to the label a free anchor and `Position` both use (`'right'`). */
const LABEL_BY_ID = new Map(SIDES.map((side) => [side.id, side.label]))

export const SIDE_LABELS = SIDES.map((side) => side.label)

/**
 * One connector, pointing the other way.
 *
 * Three things move together, and missing any one of them leaves the diagram looking
 * edited rather than corrected:
 *
 *   - `source`/`target`, which is the actual fix.
 *   - `sourceHandle`/`targetHandle`, or the line jumps to the default pair of sides and
 *     the hand-placed anchors are lost. Every side carries both a source and a target
 *     handle under the same id (canvas/handles.js), so the ids swap directly.
 *   - `data.sourceAnchor`/`data.targetAnchor`, the same swap for the same reason: each
 *     names a precise point on *that* end's side, so it has to move with the handle it
 *     describes or the line keeps its old fine-grained placement on the wrong end.
 *   - `data.waypoints`, reversed. They are absolute flow coordinates listed from source to
 *     target, so the same list read from the new source is the same bends in the same
 *     places -- the line is visually identical and only its arrowhead moves.
 *
 * `id` deliberately does not change. It keys `data.paths` during playback and the waypoint
 * writes in Canvas, and it is opaque everywhere it is read; minting a new one would make a
 * reversal look like a delete plus an insert to everything holding an id.
 */
export function reverseEdge(edge) {
  const waypoints = edge.data?.waypoints
  const sourceAnchor = edge.data?.sourceAnchor
  const targetAnchor = edge.data?.targetAnchor
  return {
    ...edge,
    source: edge.target,
    target: edge.source,
    sourceHandle: edge.targetHandle ?? null,
    targetHandle: edge.sourceHandle ?? null,
    ...((waypoints?.length || sourceAnchor || targetAnchor)
      ? {
          data: {
            ...edge.data,
            ...(waypoints?.length ? { waypoints: [...waypoints].reverse() } : {}),
            ...(sourceAnchor || targetAnchor
              ? { sourceAnchor: targetAnchor ?? null, targetAnchor: sourceAnchor ?? null }
              : {}),
          },
        }
      : {}),
  }
}

/** A connector read from the customer's workspace is a fact, not a drawing decision. */
function isDiscovered(edge) {
  return (edge.data?.discovered ?? edge.discovered) === true
}

/**
 * Which side of `nodeId` this connector meets, and whether it currently leaves or arrives.
 *
 * Returns `null` for a connector that does not touch the node, and for a self-loop -- both
 * ends are the same card there, so "which side" has two answers and no useful one.
 *
 * A null handle is the pre-four-sides default and resolves the way React Flow resolves it:
 * the first source handle (east) and the first target handle (west). Getting this wrong
 * would silently file every old connector under the wrong side.
 */
export function sideOf(edge, nodeId) {
  const isSource = edge.source === nodeId
  const isTarget = edge.target === nodeId
  if (isSource === isTarget) return null

  const handle = isSource ? edge.sourceHandle : edge.targetHandle
  const fallback = isSource ? LEGACY_SOURCE : LEGACY_TARGET
  const free = parseFreeHandle(handle)
  const side = free ? free.side : (LABEL_BY_ID.get(handle) ?? LABEL_BY_ID.get(fallback))

  return { side, flow: isSource ? 'out' : 'in', edgeId: edge.id }
}

/**
 * Which of `ids` can actually be reversed, and which are facts rather than choices.
 *
 * Split rather than filtered, so the caller can say "8 reversed, 2 came from your workspace
 * and were left alone" instead of appearing to have quietly missed two. Given no ids it
 * considers every connector, which is what "reverse all connectors" passes.
 *
 * A self-loop is dropped: both ends are the same card, so reversing it is a write that
 * changes nothing and would mark the document dirty for no visible reason.
 */
export function reversible(edges, ids = null) {
  const wanted = ids ? new Set(ids) : null
  const reverse = []
  const blocked = []
  for (const edge of edges ?? []) {
    if (wanted && !wanted.has(edge.id)) continue
    if (edge.source === edge.target) continue
    ;(isDiscovered(edge) ? blocked : reverse).push(edge.id)
  }
  return { reverse, blocked }
}

/*
 * The four directions data can be said to flow across a diagram, in menu order.
 *
 * Right and down first because they are the two a diagram is actually read in, and the two
 * that fix a real one: a Segment architecture drawn left-to-right wants "right", and one
 * drawn as a vertical stack wants "down".
 */
export const FLOW_DIRECTIONS = [
  { id: 'right', label: 'Left to right', axis: 'x', sign: 1 },
  { id: 'down', label: 'Top to bottom', axis: 'y', sign: 1 },
  { id: 'left', label: 'Right to left', axis: 'x', sign: -1 },
  { id: 'up', label: 'Bottom to top', axis: 'y', sign: -1 },
]

const DIRECTION_BY_ID = new Map(FLOW_DIRECTIONS.map((entry) => [entry.id, entry]))

/**
 * Does `from -> to` already carry data in `direction`?
 *
 * Positions are component *centres*. Both callers -- the menu command and the hover preview
 * inside FlowEdge -- have to compute them the same way or the preview would animate one way
 * and the click would do the other; centres are what they can both get at, since the edge
 * knows a node's absolute position and measured size and the command knows its position and
 * chosen size.
 *
 * Two components level on the axis asked about return `true`, so the command is a no-op
 * rather than an arbitrary flip. "Flow downward" between two cards at the same height is not
 * a thing either orientation satisfies, and picking one would move a line for no reason the
 * user could see.
 */
export function flowsAlong(from, to, direction) {
  const spec = DIRECTION_BY_ID.get(direction)
  if (!spec || !from || !to) return true
  const delta = (to[spec.axis] ?? 0) - (from[spec.axis] ?? 0)
  if (delta === 0) return true
  return Math.sign(delta) === spec.sign
}

/**
 * The connectors that would have to be reversed for data to flow `direction` along them.
 *
 * @param positions  Map of node id to its centre. A connector whose ends are not both in it
 *   is skipped rather than guessed at -- an unmeasured node reports no size for a frame after
 *   it mounts, and flipping a line on the strength of a position that is about to change is
 *   the kind of edit nobody can attribute to anything they did.
 * @param ids        which connectors to consider; `null` means all of them.
 */
export function orientAlong(edges, positions, direction, ids = null) {
  const { reverse, blocked } = reversible(edges, ids)
  const eligible = new Set(reverse)
  const byId = new Map((edges ?? []).map((edge) => [edge.id, edge]))

  return {
    reverse: reverse.filter((id) => {
      const edge = byId.get(id)
      const from = positions?.get(edge.source)
      const to = positions?.get(edge.target)
      if (!from || !to) return false
      return !flowsAlong(from, to, direction)
    }),
    blocked,
    /* Everything eligible, so a caller can report "6 of 10 were already flowing that way"
       rather than looking as though it only found six connectors. */
    considered: eligible.size,
  }
}

/**
 * Connectors that point *into* `startId`.
 *
 * Not a fix and deliberately not wired to one -- this is what the diagnostics report and
 * the "this path cannot go anywhere" message name, so the reader is told which lines are
 * the problem and can decide. A walkthrough starting at a component with nothing leaving it
 * has nowhere to go, and this is the list that explains why.
 */
export function pointingInto(edges, startId) {
  return (edges ?? [])
    .filter((edge) => edge.target === startId && edge.source !== startId)
    .map((edge) => edge.id)
}

/**
 * Every connector touching `nodeId`, grouped by the side of the card it meets.
 *
 * What the per-side control renders. `flow` per side is `'out'`, `'in'`, or `'mixed'` --
 * mixed is not a failure to decide, it is a side with lines going both ways, which is a
 * real thing to draw and a thing the user may well want to make uniform in one click.
 *
 * Sides with no connectors are omitted: offering "the top of this card flows out" where
 * there is no line on the top is a control that cannot do anything.
 */
export function connectorSides(edges, nodeId) {
  const found = new Map()
  for (const edge of edges ?? []) {
    const at = sideOf(edge, nodeId)
    if (!at) continue
    if (!found.has(at.side)) found.set(at.side, [])
    found.get(at.side).push({ ...at, discovered: isDiscovered(edge) })
  }

  return SIDE_LABELS.filter((side) => found.has(side)).map((side) => {
    const entries = found.get(side)
    const out = entries.filter((entry) => entry.flow === 'out').length
    return {
      side,
      count: entries.length,
      flow: out === entries.length ? 'out' : out === 0 ? 'in' : 'mixed',
      edgeIds: entries.map((entry) => entry.edgeId),
    }
  })
}

/**
 * The connectors on one side of one component that are not flowing `flow` yet.
 *
 * Returns ids to reverse, so a side already uniform returns nothing and the caller's write
 * is a no-op rather than a document marked dirty for a click that changed no direction.
 */
export function orientSide(edges, nodeId, side, flow) {
  return (edges ?? [])
    .filter((edge) => {
      if (isDiscovered(edge)) return false
      const at = sideOf(edge, nodeId)
      return at?.side === side && at.flow !== flow
    })
    .map((edge) => edge.id)
}

/**
 * What would have to turn round for `targetId` to be reachable from `reached`.
 *
 * The question behind "add this component to my path". A path is not a list -- it is walked, from
 * its start, along the arrows -- so a component nothing points at cannot be added to one. What can be
 * done is to make it reachable, and this says at what cost.
 *
 * Searched *undirected*: which components are wired to which is a fact about the diagram the user
 * drew, and only the arrowheads are in question. The shortest such route is taken, then each
 * connector along it is checked against the direction of travel, and the ones facing backwards are
 * returned. Shortest by hop count so the smallest number of arrowheads is disturbed -- reaching a
 * component the long way round would turn connectors the user never asked about.
 *
 * This is the operation the module header says no heuristic can do safely, and it is safe here for
 * one reason: the user named the destination. Orienting *outward* from a start has to guess whether a
 * second connector into a component is a fan-in to preserve or a backwards line to fix, and cannot.
 * Orienting *towards* a named component never asks that question, because it only ever touches the
 * connectors between the path and that one component.
 *
 * @param edges     every connector on the diagram
 * @param reached   node ids the path already gets to -- normally `Object.keys(trace.visited)`
 * @param targetId  the component to make reachable
 * @returns `{found, from, reverse, blocked, route}`.
 *   `found` false means no chain of connectors joins them at all, in which case the answer is not a
 *   reversal but a connector the user has yet to draw -- and the caller has to say so rather than
 *   appearing to do nothing. `from` is the component on the path the route leaves, which the caller
 *   needs because turning connectors round is useless if the event *stops* there -- a destination
 *   delivers and goes no further, and reporting "fixed" while the path still ends one component
 *   earlier would be the worst of the possible answers. `reverse` is the ids to flip (empty when the
 *   route already runs the right way). `blocked` names connectors on the route that came from the
 *   workspace and cannot be turned. `route` is the connectors from the path to the component, in
 *   order.
 */
export function routeToReach(edges, reached, targetId) {
  const list = edges ?? []
  const start = new Set(reached ?? [])
  const empty = { found: false, from: null, reverse: [], blocked: [], route: [] }
  if (!targetId || start.size === 0 || start.has(targetId)) {
    /* Already on the path is `found` with nothing to do, which is a different answer from "no route
       exists" and the caller says different things about them. */
    return start.has(targetId) ? { ...empty, found: true, from: targetId } : empty
  }

  /* Adjacency in both directions, each entry remembering which way the connector actually points so
     the check below can compare it against the direction of travel. */
  const links = new Map()
  for (const edge of list) {
    if (edge.source === edge.target) continue
    if (!links.has(edge.source)) links.set(edge.source, [])
    if (!links.has(edge.target)) links.set(edge.target, [])
    links.get(edge.source).push({ edge, to: edge.target, forward: true })
    links.get(edge.target).push({ edge, to: edge.source, forward: false })
  }

  /* Breadth-first from the whole reached set at once, not from one component in it: the nearest way
     onto the path is the one to take, and which component it joins at is not something the user
     should have to work out and name. */
  const cameBy = new Map()
  const seen = new Set(start)
  let frontier = [...start]

  while (frontier.length > 0 && !cameBy.has(targetId)) {
    const next = []
    for (const at of frontier) {
      for (const link of links.get(at) ?? []) {
        if (seen.has(link.to)) continue
        seen.add(link.to)
        cameBy.set(link.to, { ...link, from: at })
        next.push(link.to)
      }
    }
    frontier = next
  }

  if (!cameBy.has(targetId)) return empty

  const route = []
  for (let at = targetId; cameBy.has(at); at = cameBy.get(at).from) route.unshift(cameBy.get(at))

  const reverse = []
  const blocked = []
  for (const hop of route) {
    /* `forward` means the connector already points the way the event needs to travel. */
    if (hop.forward) continue
    ;(isDiscovered(hop.edge) ? blocked : reverse).push(hop.edge.id)
  }

  return {
    found: true,
    /* The component on the path the route leaves from -- `route[0].from` is by construction a member
       of `reached`, since the search started there. */
    from: route[0]?.from ?? null,
    reverse,
    blocked,
    route: route.map((hop) => hop.edge.id),
  }
}

/**
 * A connection as the user drew it: from the component the drag started at, to the one it ended on.
 *
 * ## Why this is needed at all
 *
 * Every side of every card carries a source handle *and* a target handle, stacked and sharing an id --
 * that is what puts each side in both of React Flow's handle-geometry lists, so a connector can both
 * leave and arrive there (see canvas/handles.js). The pointer lands on whichever of the pair is on top.
 *
 * And when a drag begins on a handle of type `target`, React Flow reports the finished connection with
 * the *dropped-on* node as `source` and the *started-from* node as `target` -- which is correct on its
 * own terms and backwards from what the person dragging meant. So the direction of a hand-drawn
 * connector was decided by which of two invisible, identically-positioned handles happened to be
 * painted last. Consistently the target, as it turns out, which is why whole diagrams came out stored
 * end-to-start and every walkthrough on them stopped after one component.
 *
 * So direction is taken from the gesture instead: **data flows the way you dragged**. Nothing about it
 * depends on handle types, paint order, or which half of a side the pointer found.
 *
 * @param connection  React Flow's `{source, target, sourceHandle, targetHandle}`
 * @param from        `{nodeId}` from `onConnectStart` -- the end the drag began at
 */
export function orientConnection(connection, from) {
  const startedAt = from?.nodeId
  if (!connection || !startedAt) return connection
  /* Already the right way round, or a connection neither end of which is where the drag began -- which
     should not happen, and is left alone rather than guessed at. */
  if (connection.source === startedAt || connection.target !== startedAt) return connection

  return {
    ...connection,
    source: connection.target,
    target: connection.source,
    /* The handles swap with the ends, or the line jumps to a different pair of sides than the one it
       was drawn between. Every side carries both types under one id, so the ids move across directly. */
    sourceHandle: connection.targetHandle ?? null,
    targetHandle: connection.sourceHandle ?? null,
  }
}
