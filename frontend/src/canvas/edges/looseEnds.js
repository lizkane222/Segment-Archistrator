/*
 * A connector with one end attached to nothing yet.
 *
 * A diagram is drawn before it is finished. "Events go from here to a destination we have not
 * picked" is a real thing to draw, and the only way to draw it used to be a placeholder component
 * nobody wanted, because an edge needed a node at both ends. A *loose end* is the honest version:
 * the connector leaves its component and stops at a point on the canvas, arrow and all, and can be
 * dropped onto the component later.
 *
 * ## How it is stored
 *
 * In the document, and in app state: `target: null` (or `source: null`) plus `data.targetPoint`
 * `{x, y}`, absolute flow coordinates -- the same frame waypoints use, for the same reason: the point
 * is a place on the canvas, and it must not move when the component at the other end does.
 *
 * Null, and not some sentinel id, so that everything that asks "what does this connect?" -- the
 * walkthrough, the path router, the diagnostics -- sees no component at that end, which is the truth.
 *
 * ## How it is drawn
 *
 * React Flow will not draw an edge without a node at each end. So the canvas, and only the canvas,
 * hands it one: a hidden, 1px *pin* node sitting on the point, whose id is derived from the edge
 * (`loose:<edgeId>:<end>`). The pin never reaches the document and never renders; `FlowEdge` reads
 * the stored point directly and draws the end there. The pin exists purely so React Flow's own edge
 * machinery -- selection, clicking, the right-click menu, keyboard delete -- works for a loose
 * connector exactly as for any other.
 *
 * At most one end may be loose. A connector attached to nothing at all is not a connector.
 */

export const PIN_PREFIX = 'loose:'
export const PIN_TYPE = 'pin'
/* The one handle a pin registers, of both types -- see `pinNodesFor`. */
export const PIN_HANDLE = 'pin'

const ENDS = ['source', 'target']

/** `'sourcePoint'` / `'targetPoint'` -- where a loose end's position is kept, in `edge.data`. */
export function pointKey(end) {
  return end === 'source' ? 'sourcePoint' : 'targetPoint'
}

/** The pin id standing in for one loose end, on the canvas only. */
export function pinId(edgeId, end) {
  return `${PIN_PREFIX}${edgeId}:${end}`
}

export function isPinId(id) {
  return typeof id === 'string' && id.startsWith(PIN_PREFIX)
}

/** A finite `{x, y}`, or null. Points are persisted and hand-edited, like waypoints. */
export function cleanPoint(point) {
  if (!point) return null
  const x = Number(point.x)
  const y = Number(point.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/**
 * Where one end of `edge` sits when it is loose, or null when it is attached.
 *
 * Loose means *no component and a usable point*. An end with no component and no point is a broken
 * edge rather than a loose one, and is left to the save path to drop -- inventing a point for it would
 * be drawing something nobody placed.
 *
 * A pin id counts as no component, so this reads the canvas's rendered edges as well as the document's.
 */
export function loosePoint(edge, end) {
  const id = edge?.[end]
  if (id != null && !isPinId(id)) return null
  return cleanPoint(edge?.data?.[pointKey(end)] ?? edge?.[pointKey(end)])
}

/** `{source, target}` booleans -- which ends of `edge` are loose. */
export function looseEnds(edge) {
  return {
    source: Boolean(loosePoint(edge, 'source')),
    target: Boolean(loosePoint(edge, 'target')),
  }
}

export function isLoose(edge) {
  const free = looseEnds(edge)
  return free.source || free.target
}

/**
 * The same edges with every loose end pointed at its pin, for React Flow.
 *
 * Returns the *same* array when no edge is loose, so a diagram without any does not rebuild its
 * edge list on every render -- the identity contract the rest of the canvas keeps.
 */
export function pinnedEdges(edges) {
  const list = edges ?? []
  if (!list.some(isLoose)) return list
  return list.map((edge) => {
    const free = looseEnds(edge)
    if (!free.source && !free.target) return edge
    return {
      ...edge,
      ...(free.source ? { source: pinId(edge.id, 'source'), sourceHandle: PIN_HANDLE } : {}),
      ...(free.target ? { target: pinId(edge.id, 'target'), targetHandle: PIN_HANDLE } : {}),
    }
  })
}

/**
 * One hidden pin node per loose end.
 *
 * Every property here is load-bearing for React Flow and none of it is visual:
 *
 *   - `handles` + `width`/`height` are what `isNodeInitialized` checks. A hidden node is never
 *     measured, so without both stated up front `getEdgePosition` returns null and the edge is not
 *     drawn at all -- the one failure worse than drawing it wrong.
 *   - `hidden` keeps it out of the DOM, the minimap and `fitView`.
 *   - not selectable, draggable, connectable or deletable, because the pin is not a thing the
 *     reader can see; the loose end is moved by the grip `FlowEdge` draws on it.
 */
export function pinNodesFor(edges) {
  const pins = []
  for (const edge of edges ?? []) {
    for (const end of ENDS) {
      const point = loosePoint(edge, end)
      if (!point) continue
      pins.push({
        id: pinId(edge.id, end),
        type: PIN_TYPE,
        position: point,
        width: 1,
        height: 1,
        hidden: true,
        selectable: false,
        draggable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        data: {},
        handles: ['source', 'target'].map((type) => ({
          id: PIN_HANDLE,
          type,
          position: 'left',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })),
      })
    }
  }
  return pins
}

/**
 * The edge with one end let go of, at `point`.
 *
 * Everything that described *where on a component* that end was attached goes with the component:
 * the handle, the anchor. A route the router computed goes too, because it was computed for an
 * attachment that no longer exists; a route a hand placed stays.
 */
export function detachEnd(edge, end, point) {
  const at = cleanPoint(point)
  if (!edge || !at) return edge
  const handleKey = end === 'source' ? 'sourceHandle' : 'targetHandle'
  const anchorKey = end === 'source' ? 'sourceAnchor' : 'targetAnchor'
  const { [anchorKey]: _anchor, ...data } = edge.data ?? {}
  const auto = data.routed === 'auto'
  return {
    ...edge,
    [end]: null,
    [handleKey]: null,
    data: {
      ...data,
      [pointKey(end)]: { x: Math.round(at.x), y: Math.round(at.y) },
      ...(auto ? { waypoints: undefined, routed: undefined } : {}),
    },
  }
}

/** The edge with its `end` point cleared, for an end that has just been attached. */
export function withoutPoint(data, end) {
  const { [pointKey(end)]: _point, ...rest } = data ?? {}
  return rest
}

/**
 * Which side a loose end should be treated as meeting, so the router has a direction to arrive in.
 *
 * A loose end has no component and so no side, but every line style needs a direction at each end.
 * The answer is the side of an imaginary zero-size box at the point that faces the other end -- so a
 * line arriving from the left comes in travelling right, and its arrowhead points the way it was
 * going rather than being turned to face a border that does not exist.
 *
 * @param point  the loose end
 * @param toward the point it is approached from: the last bend, or the other end
 */
export function looseSide(point, toward) {
  if (!point || !toward) return 'left'
  /* The same rule as `facingSide` in canvas/handles.js, for two points -- written out rather than
     imported because handles.js imports this module, and a cycle between the two is one refactor away
     from an undefined at load time. */
  const dx = toward.x - point.x
  const dy = toward.y - point.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/**
 * The box an end occupies, for the geometry that decides which side the *other* end faces.
 *
 * A component's measured box when attached, a zero-size box on the point when loose, null when
 * neither is known yet.
 */
export function endBox(edge, end, boxOf) {
  const point = loosePoint(edge, end)
  if (point) return { x: point.x, y: point.y, width: 0, height: 0 }
  const id = edge?.[end]
  return id ? (boxOf?.(id) ?? null) : null
}
