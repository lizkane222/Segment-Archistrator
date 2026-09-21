/*
 * React Flow state <-> the stored `{nodes, edges, zones, viewport}` document.
 *
 * The canvas holds more than the diagram: per-node runtime state React Flow owns
 * (selected, dragging, measured widths, the parent/extent wiring). None of that
 * is worth persisting, and some of it is actively harmful to persist -- storing
 * `measured` would bake one browser's text metrics into a document another
 * browser then re-measures.
 *
 * Zones *are* part of the document, in their own array rather than mixed into
 * `nodes`. Two reasons: a zone can be one the customer drew for something outside
 * Segment, so it cannot be regenerated from the topology; and keeping it out of
 * `nodes` means `validate_architecture`, `node_count` and `countPlaceholders` all
 * go on meaning "components" without each having to filter.
 *
 * So this module is the one place that knows the difference between the document
 * and the canvas, and it is pure so the round-trip can be tested without a DOM.
 * The round-trip is the whole point: Phase 5's requirement is "open, bind, save,
 * reload identical", and identical means positions and zone geometry too.
 */

import { zoneSize } from '../canvas/layout.js'
import { zoneOfParent } from '../canvas/rules.js'

/* Fields React Flow adds or manages. Persisting them is either meaningless or
   wrong on the next load, so they are dropped on the way out. */
const RUNTIME_NODE_KEYS = new Set([
  'type',
  'parentId',
  'extent',
  'zIndex',
  'selected',
  'dragging',
  'resizing',
  'measured',
  'width',
  'height',
  'sourcePosition',
  'targetPosition',
  'positionAbsolute',
  'internals',
  /* Which scenarios are lighting this node, and the verdict each of them reached here.
     Runtime in the same sense as `selected`: leaving them in would put a simulation's
     transient state in Postgres, and -- because `graphFingerprint` reads node data --
     would mark the document dirty simply for playing an event through it. The scenarios
     themselves *are* stored; one frame of one playthrough of them is not.

     `anchor` and `anchorStep` are no longer written by anything: the walkthrough used to
     pin a note open on the playhead's component, and those notes now stack in a lane above
     the diagram instead (simulation/NotesLane.jsx). Kept in the list, and under test, because
     the cost is two strings and the failure they guard against is silent. */
  'anchor',
  'anchorStep',
  'paths',
  /* A profile pasted in from the real Profile API -- see inspector/ProfilePreview.jsx.
     Deliberately never saved: it is real customer traits and identifiers, and this is
     the same rule `PROFILE_SECTIONS` in canvas/grouping.js was written under -- a
     diagram that gets exported to PDF is not where that belongs. It survives a reload
     no better than `paths` does, and for the same reason. */
  'profileSnapshot',
])

/* Mirrors apps/diagrams/models.py SECRET_KEY_PATTERN. The server strips these on
   write regardless -- this is here so a secret does not even leave the tab, and
   so that what gets saved is what the client believes it saved. */
const SECRET_KEY = /(write[_-]?key|api[_-]?key|token|secret|password|credential)/i
const ALLOWED_MASKED = new Set(['writeKeyMasked', 'writeKeyLast4'])

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (ALLOWED_MASKED.has(key)) {
        out[key] = entry
        continue
      }
      if (SECRET_KEY.test(key)) continue
      out[key] = stripSecrets(entry)
    }
    return out
  }
  return value
}

/**
 * A canvas node -> a document node.
 *
 * Zone membership is stored as `zone`, not as `parentId`: the zone group node ids
 * are an implementation detail of the layout, and a document that referenced them
 * would break the day the zones are rendered differently.
 *
 * `zone: null` is a real answer, not a missing one -- it is a component in the working
 * area outside every zone. This used to fall back to `'connections'`, which was safe
 * while every component had to be inside a zone and is data loss now: a component
 * parked on bare canvas would reload inside Connections, somewhere the user never put
 * it.
 */
export function serializeNode(node) {
  const flat = { ...(node.data ?? {}) }
  for (const key of RUNTIME_NODE_KEYS) delete flat[key]

  return stripSecrets({
    ...flat,
    id: node.id,
    zone: zoneOfParent(node.parentId) ?? node.data?.zone ?? null,
    /* Rounded on purpose. Sub-pixel drag positions produce diffs on every save
       and make "did this change?" impossible to answer by eye. */
    position: {
      x: Math.round(node.position?.x ?? 0),
      y: Math.round(node.position?.y ?? 0),
    },
  })
}

/**
 * A zone backdrop -> a document zone.
 *
 * Geometry is read back off the React Flow node rather than out of `data`, because
 * dragging and resizing a zone updates the node and never touches `data`. `data`
 * carries only the meaning: label, description, order, and whether it is a region
 * of the customer's own making.
 */
export function serializeZone(node) {
  const { kindCount, parent: declared, ...meta } = node.data ?? {}
  const { width, height } = zoneSize(node)

  /* Read off the live `parentId` when there is one, exactly as serializeNode derives
     a component's `zone`: the canvas is what the user manipulated. Falls back to the
     declared parent only when the node has none, which is the case buildLayout
     creates for a zone whose parent is not in this document -- forgetting it there
     would mean re-adding Segment later left Unify beside it rather than inside it.
     Omitted rather than written as null, because a zone saved before zones nested has
     no such key and emitting one would mark every such diagram dirty on open. */
  const parent = node.parentId ? zoneOfParent(node.parentId) : (declared ?? null)

  return stripSecrets({
    ...meta,
    ...(parent ? { parent } : {}),
    id: meta.id ?? zoneOfParent(node.id) ?? node.id,
    position: {
      x: Math.round(node.position?.x ?? 0),
      y: Math.round(node.position?.y ?? 0),
    },
    width: Math.round(width),
    height: Math.round(height),
  })
}

export function serializeEdge(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    /*
     * Which side of each node the connector meets, when the user has chosen one.
     *
     * Every node has four sides now (canvas/handles.js), and the side is a deliberate
     * drawing decision -- routing a Reverse ETL model's line out of the *top* so it does not
     * cross the card it is about is exactly the kind of thing someone arranges by hand and
     * would be furious to lose. Without these two keys the edge came back on the default
     * pair on every open, and the diagram silently re-routed itself.
     *
     * Omitted rather than written as null when absent, so an edge nobody has re-routed
     * serializes byte-identically to how it did before sides existed -- otherwise every
     * diagram in the database would read as dirty the moment it was opened.
     */
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    /* Where along that side, when a connector was dragged to a precise point rather than the
       midpoint -- see `fixedHandleForSide` in canvas/handles.js. */
    ...(edge.data?.sourceAnchor ? { sourceAnchor: edge.data.sourceAnchor } : {}),
    ...(edge.data?.targetAnchor ? { targetAnchor: edge.data.targetAnchor } : {}),
    /*
     * How the line is drawn, and the bends the user dragged into it.
     *
     * Both omitted when absent rather than written as defaults, for the same reason the handles
     * are: an edge nobody has re-routed has to serialize byte-identically to the way it did
     * before routing existed, or `graphFingerprint` reads every diagram in the database as dirty
     * the moment it is opened.
     *
     * Waypoints are absolute flow coordinates. That is deliberate and is the whole reason they
     * are worth storing -- a bend exists because the user put the line in a particular piece of
     * empty space, and it has to stay there when the components at either end move.
     */
    ...(edge.data?.line ? { line: edge.data.line } : {}),
    ...(edge.data?.waypoints?.length
      ? {
          waypoints: edge.data.waypoints.map((point) => ({
            /* Rounded, like every other stored coordinate: a sub-pixel drag produces a diff on
               every save and makes "did this change?" unanswerable by eye. */
            x: Math.round(point.x),
            y: Math.round(point.y),
          })),
        }
      : {}),
    /*
     * Who put those bends there: `'auto'` for the router's own obstacle-avoidance, absent for a hand.
     *
     * Needed because the two used to be indistinguishable and the app has to treat them completely
     * differently -- a computed route should be recomputed when a component moves, and a hand-placed
     * bend is a statement about a piece of empty space and must never be touched. Absent means hand,
     * which is the safe reading: every route already in the database predates this field, so none of
     * them is rewritten on open.
     *
     * Only ever written alongside waypoints, and omitted otherwise, so an unbent connector still
     * serializes byte-identically -- the `graphFingerprint` rule the whole block obeys.
     */
    ...(edge.data?.waypoints?.length && edge.data?.routed ? { routed: edge.data.routed } : {}),
    /*
     * Line colour, dash pattern and arrow direction -- the same omit-when-absent reasoning as
     * `line`/`waypoints` above, so an edge nobody has styled serializes byte-identically to how
     * it did before styling existed. `arrowEnd` is the one exception: its *default* is `true`
     * (every connector wears an arrow unless told otherwise), so it is only written when the
     * user turned it off, not when it is merely absent.
     */
    ...(edge.data?.color ? { color: edge.data.color } : {}),
    ...(edge.data?.strokeStyle ? { strokeStyle: edge.data.strokeStyle } : {}),
    ...(edge.data?.arrowStart ? { arrowStart: edge.data.arrowStart } : {}),
    ...(edge.data?.arrowEnd === false ? { arrowEnd: false } : {}),
    phase: edge.data?.phase ?? null,
    discovered: edge.data?.discovered ?? false,
  }
}

/**
 * The whole document.
 *
 * @param nodes      React Flow nodes, zone backdrops included (they are split out)
 * @param edges      React Flow edges
 * @param viewport   optional pan/zoom, so reopening a diagram frames it the same way
 * @param scenarios  saved walkthrough paths. Omitted when there are none, rather
 *   than written as `[]`: absent and empty mean the same thing here -- unlike
 *   `zones`, where empty has to mean "the user deleted them all" -- so emitting the
 *   key regardless would add a field to every diagram that never uses the feature.
 * @param collapsed  group keys the reader folded away, per canvas/grouping.js. Stored
 *   here rather than on the nodes for two reasons: a stack stands for several nodes so
 *   there is no one node it belongs to, and `serializeNode` spreads all of `data`, so
 *   a per-node flag would ride along into the document whether or not it was meant to.
 *   Omitted when empty on the same grounds as `scenarios`.
 *
 * Note what must never be passed in: a *collapsed* view. Stack nodes are not zones,
 * so the filter below would take them for components and persist them -- along with
 * the aggregate edges, and without the members they replaced. Serialization reads the
 * document; collapsing is what the canvas is handed.
 */
export function serializeGraph({
  nodes = [],
  edges = [],
  viewport = null,
  scenarios = [],
  collapsed = [],
} = {}) {
  const componentNodes = nodes.filter((node) => node.type !== 'zone')
  const zoneNodes = nodes.filter((node) => node.type === 'zone')
  /* Zone ids count as kept too, even though zones serialize separately below --
     a zone is a legal edge endpoint now, and an edge to one is real, not orphaned. */
  const kept = new Set([...componentNodes, ...zoneNodes].map((node) => node.id))

  return {
    nodes: componentNodes.map(serializeNode),
    /* An edge whose endpoint is gone would fail the server's validation and, more
       to the point, cannot be drawn. React Flow normally deletes these with the
       node; this guards the case where it did not. */
    edges: edges.filter((e) => kept.has(e.source) && kept.has(e.target)).map(serializeEdge),
    /* Always present, even when empty. A saved document with no `zones` key means
       "written before zones were part of the document" and `buildLayout` falls back
       to the topology; an empty array has to mean "the user deleted them all". */
    zones: zoneNodes.map(serializeZone),
    /* Through stripSecrets like everything else. A scenario's event is a payload the
       user typed, so `properties.api_key` is a thing they can write -- the server
       strips it on write regardless, and doing it here too means what gets saved is
       what the client believes it saved. */
    ...(scenarios.length ? { scenarios: scenarios.map(stripSecrets) } : {}),
    /* Sorted, so ticking two groups in either order produces one document and the
       unsaved-changes dot does not light up for a reordering nobody performed. */
    ...(collapsed.length ? { collapsed: [...collapsed].sort() } : {}),
    ...(viewport ? { viewport: roundViewport(viewport) } : {}),
  }
}

function roundViewport({ x = 0, y = 0, zoom = 1 }) {
  return { x: Math.round(x), y: Math.round(y), zoom: Number(zoom.toFixed(3)) }
}

/**
 * Saved positions, keyed by node id, for `buildLayout`'s `existingPositions`.
 *
 * Without this, loading a saved diagram would re-run the column layout and throw
 * away every position the user arranged by hand -- which looks exactly like the
 * save having silently failed.
 */
export function positionsFromGraph(graph) {
  const positions = {}
  for (const node of graph?.nodes ?? []) {
    if (node?.id && node.position) {
      positions[node.id] = { x: node.position.x, y: node.position.y }
    }
  }
  return positions
}

/**
 * A canonical string for "has this diagram changed since it was saved?".
 *
 * `JSON.stringify` will not do: key order follows insertion order, so the same
 * graph stringifies differently coming back from Postgres than it does out of
 * `serializeNode`, and every freshly-opened diagram would look dirty. This sorts
 * object keys recursively and nodes/edges by id, so the comparison is about
 * content only.
 *
 * The viewport is excluded deliberately -- panning around a diagram is not an edit,
 * though whatever the viewport happens to be does get stored on the next save.
 *
 * Zones, scenarios and the collapse state are included, so moving or resizing a zone,
 * saving or renaming a walkthrough path, and folding a group of forty destinations away
 * all mark the document dirty. Leaving any of them out would mean work the user spent
 * time on could be lost by navigating away with no warning, since the unsaved-changes
 * guard reads this. Collapsing earns its place on those grounds and not on the grounds
 * of being an edit -- it changes no component -- but arranging a diagram so a customer
 * can follow it is the work this tool is for.
 *
 * Note what is *not* here: playing a scenario changes no stored field at all -- see
 * RUNTIME_NODE_KEYS.
 */
export function graphFingerprint(graph) {
  const byId = (a, b) => String(a?.id).localeCompare(String(b?.id))
  return stableStringify({
    nodes: [...(graph?.nodes ?? [])].sort(byId),
    edges: [...(graph?.edges ?? [])].sort(byId),
    zones: [...(graph?.zones ?? [])].sort(byId),
    scenarios: [...(graph?.scenarios ?? [])].sort(byId),
    /* Sorted here too, not merely on the way out: this is also called on graphs
       assembled ad hoc rather than through serializeGraph, where the keys arrive in
       whatever order a Set iterated. */
    collapsed: [...(graph?.collapsed ?? [])].sort(),
  })
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      /* Drop undefined the way JSON.stringify does, so an explicitly-absent field
         and a missing one compare equal. */
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Nodes still waiting to be bound to a real component.
 *
 * `bindable: false` is excluded: a journey has no Public API resource behind it,
 * so counting it would leave a "1 placeholder to bind" banner that no amount of
 * binding could ever clear. Mirrors is_placeholder() in apps/diagrams/models.py.
 */
export function isPlaceholder(node) {
  const data = node?.data ?? node ?? {}
  if (data.bound) return false
  return data.bindable !== false
}

export function countPlaceholders(nodes) {
  return (nodes ?? []).filter((node) => node.type !== 'zone' && isPlaceholder(node)).length
}
