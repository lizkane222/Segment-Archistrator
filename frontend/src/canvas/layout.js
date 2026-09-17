/*
 * Turn the server's `{nodes, edges, zones}` into React Flow nodes and edges.
 *
 * Two jobs, both pure so they can be unit-tested without a DOM:
 *
 *  1. Zone containment. Each zone becomes a React Flow group node and a component
 *     inside one gets `parentId`, so moving the zone moves its contents. Zones
 *     themselves nest the same way, which is what puts Connections, Unify and
 *     Engage inside Segment.
 *
 *     Note what is *absent*: `extent: 'parent'`. It used to be here, and it made
 *     containment a hard guarantee -- React Flow clamps a child's drag to its
 *     parent's box, so a component could not be moved out of its product. That is
 *     no longer wanted. Some components genuinely belong to two products at once
 *     (identity resolution settings are Unify's and Engage's both), the canvas
 *     outside every zone is now a legitimate working area, and zones have to be
 *     movable enough to sit side by side. Containment became advice -- see
 *     `isValidPlacement`'s callers -- and the clamp had to go with it.
 *
 *  2. Column layout. Nodes are bucketed into pipeline columns by kind (inputs
 *     left, outputs right) and stacked vertically within a column. It is not a
 *     general graph layout algorithm and does not try to be: a Segment
 *     architecture is a left-to-right flow, and columns read the way the
 *     reference LucidChart diagrams do. Users drag from there.
 *
 * The column layout is a *fallback*. A zone that carries its own geometry -- one
 * that has been dragged, resized, or drawn by hand outside Segment entirely --
 * is placed verbatim, because for those the arrangement is the document.
 *
 * Positions inside a group node are relative to the group's own origin. That
 * catches everyone once, so: child x/y are zone-local, zone x/y are absolute.
 */

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 60

/* The floor a component's resize handle stops at, and deliberately far below the
   default size: a card shrunk to a labelled chip is a legitimate thing to want in a
   diagram that has forty of them. Low enough for that, high enough that the icon and
   the two connection handles still have somewhere to sit. */
export const MIN_NODE_WIDTH = 90
export const MIN_NODE_HEIGHT = 36

/*
 * How wide a card is allowed to grow to fit its own text before it wraps instead.
 *
 * A component's name comes from the workspace, and Segment names are frequently long --
 * "Javascript Website (Production)" does not fit in 200px, and it was being cut off with an
 * ellipsis, which on a diagram whose purpose is to say which component is which is the one thing
 * a label must not do. So a card with no size of its own now grows to fit.
 *
 * It cannot grow without limit: one source called something enormous would become a card wider
 * than the zone holding it, and every other card would look tiny beside it. Past this width the
 * text wraps and the card gets taller instead -- which is the "or height, if text-wrap" half of
 * the request, and is the right trade because vertical space on this canvas is cheap and
 * horizontal space is what the pipeline columns are made of.
 *
 * 340 is a little under twice the default, which fits the great majority of real Segment names on
 * one line while still being narrower than the 4-column zone span.
 */
export const MAX_AUTO_NODE_WIDTH = 340

/*
 * Paint order, and it is a hit-testing order too -- a node's z goes onto the wrapper div
 * React Flow puts the hit target on, so anything painted over a component is also
 * intercepting its clicks.
 *
 * The gap between the two is the whole point and 1 will not do. React Flow lifts a child
 * above its parent by *adding* to it (`calculateChildXYZ`: `parentZ >= childZ ? parentZ + 1
 * : childZ`), so a zone nested one deep resolves to 1 and a zone nested twice to 2. With
 * components at 1 a sub-zone ties with them and a sub-sub-zone beats them, which is a
 * region's backdrop swallowing the clicks of the cards in the zone beside it. At 10 every
 * component and every collapsed stack stays above every zone until zones nest nine deep,
 * and the topology nests two.
 *
 * Zones stay at 0 rather than being spread out as well, so which of two *zones* is on top
 * is decided by array order in `orderForFlow` -- where the rule can be about their sizes,
 * which is what was asked for, rather than about a number fixed when they were built.
 *
 * ## Connectors are in the component band, and had to be told so
 *
 * A connector used to have no z at all, and the result was the worst kind of bug: correct most of
 * the time. React Flow derived one as `edge.zIndex + max(z of each endpoint that has a parent)`, so
 * an edge between two components inside a zone landed at 10 and was fine, while an edge between two
 * components on the bare canvas landed at *0* -- the same as a zone backdrop, whose fill is a solid
 * hex and not a tint. At a tie the painter takes DOM order, and React Flow renders the node layer
 * after the edge layer, so the backdrop covered the line. Clicking either end lifted the edge and it
 * reappeared, which is what made it look like a rendering glitch rather than a layer.
 *
 * So the canvas runs `zIndexMode="manual"` and every band is stated rather than derived. Two things
 * make that cheap: node z is unaffected (the `parentZ + 1` nesting bump in `calculateChildXYZ` is not
 * gated on the mode -- only selection elevation is, and `elevateNodesOnSelect` was already off), and
 * a connector in the same band as a component is what a reader expects, because a connector should
 * not be crossing a component in the first place. Where one does, that is the router's problem to
 * solve and not the paint order's to hide.
 */
export const ZONE_Z = 0
export const COMPONENT_Z = 10

/*
 * How far a *selected* connector rises above its band.
 *
 * Load-bearing, and the reason `zIndexMode="manual"` could not simply be switched on and left there.
 * An edge's reconnect anchors sit at its two ends, directly over the components it attaches to and
 * over those components' own connection handles -- which take the pointer first and start drawing a
 * new connection instead of moving the existing end. React Flow used to grant this lift itself via
 * `elevateEdgesOnSelect`; under manual mode it returns `edge.zIndex` untouched, so the lift is ours
 * to apply. Losing it silently would have broken endpoint dragging, which is the thing this whole
 * change exists to make work.
 *
 * Only the selected edge rises, which is the only one whose ends anyone is trying to grab.
 */
export const SELECTED_EDGE_LIFT = 1000

/**
 * A connector's paint layer: the component band, lifted while it is selected.
 *
 * Applied where the edges are handed to React Flow rather than in `toFlowEdge`, because an edge
 * created by a live drag never passes through `toFlowEdge` at all -- it is built by `addEdge` in
 * `onConnect`. Doing it at the boundary means every edge gets a z whatever made it.
 */
export function edgeZFor(edge) {
  return edge?.selected ? COMPONENT_Z + SELECTED_EDGE_LIFT : COMPONENT_Z
}

const COLUMN_GAP = 90
const ROW_GAP = 26
const ZONE_PADDING_X = 32
const ZONE_PADDING_TOP = 52 // room for the zone's own label
const ZONE_PADDING_BOTTOM = 32
const ZONE_GAP = 48

/* The size an "empty" zone gets, wherever the canvas got there from: drawn from the
   palette, arrived from a template, or emptied out. Sized from its contents alone an
   empty zone is one column wide, so the second component dropped into it would
   have nowhere to land. */
export const DEFAULT_ZONE_SPAN = { columns: 4, rows: 2 }

/* Column index per kind, within its zone. Gaps in the numbering are intentional
   -- they leave room to insert a stage without renumbering everything. */
const COLUMN = {
  // Connections: source -> pre-processing -> post-processing -> output
  source: 0,
  source_function: 1,
  source_insert_function: 1,
  destination_filter: 3,
  destination_insert_function: 4,
  destination_function: 5,
  destination: 5,
  warehouse: 5,
  reverse_etl_model: 6,

  // Unify: the space fans out into what it computes
  space: 0,
  identity_resolution: 1,
  computed_trait: 2,
  profile_api: 2,

  // Engage
  audience: 0,
  journey: 1,
}

export const zoneNodeId = (zoneId) => `zone-${zoneId}`

/* Which kinds are drawn by something other than `SegmentNode`. A table, like a shape, is
   deliberately a `kind` rather than a React Flow `type`: the type is not stored, so the kind is what
   makes the choice survive a save. Anything absent here is a labelled card. */
const NODE_TYPE_FOR_KIND = {
  shape: 'shape',
  table: 'table',
}

function columnFor(kind) {
  return COLUMN[kind] ?? 0
}

/** The pixel size of a zone that holds `columns` x `rows` components. */
export function zoneSpanSize({ columns = 1, rows = 1 } = {}) {
  return {
    width: columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP + ZONE_PADDING_X * 2,
    height: rows * NODE_HEIGHT + (rows - 1) * ROW_GAP + ZONE_PADDING_TOP + ZONE_PADDING_BOTTOM,
  }
}

/**
 * A zone node's current size.
 *
 * The top-level `width`/`height` pair, not `style.width`: NodeResizer writes the
 * top-level one and React Flow prefers it over the style when rendering, so a
 * zone carrying both would render at one size and serialize at the other the
 * moment anyone dragged a handle. `measured` is the last resort, for a zone that
 * has been through the DOM but never given explicit dimensions.
 */
export function zoneSize(node) {
  return {
    width: node?.width ?? node?.style?.width ?? node?.measured?.width ?? 0,
    height: node?.height ?? node?.style?.height ?? node?.measured?.height ?? 0,
  }
}

/**
 * A component's explicitly-chosen size, or nulls when it has none.
 *
 * Kept in `data.size` rather than in `data.width`/`data.height` because
 * serialize.js's RUNTIME_NODE_KEYS deletes `width` and `height` out of node data --
 * those are React Flow's own measurement fields, and a document that stored the
 * user's sizes under those names would lose every one of them on the first save.
 *
 * Nulls rather than the defaults, because "no size" is a state the rest of the
 * layout has to be able to see: a node that has never been resized keeps growing
 * with its contents (an Identity Resolver's buckets make it taller than
 * NODE_HEIGHT), and baking a height in at load would freeze that.
 *
 * Reads a React Flow node or a raw document payload -- buildLayout needs it on both
 * sides of `toFlowNode`.
 */
export function componentSize(node) {
  const size = node?.data?.size ?? node?.size ?? null
  return { width: size?.width ?? null, height: size?.height ?? null }
}

/* A zone smaller than this has no room for its own label, let alone a component. */
export const MIN_ZONE_WIDTH = 260
export const MIN_ZONE_HEIGHT = 150

/* The one zone that keeps the full span, and it is not a special case so much as the
   only zone whose job is to contain the others: a quarter-width Segment could not hold
   Connections, and every drop into it would immediately grow it back. */
const FULL_SPAN_ZONE = 'segment'

/**
 * The size a zone gets when it is dragged in from the palette.
 *
 * A quarter of the full span's width for everything except Segment, asked for directly.
 * The four-column default is the room a whole Connections pipeline needs, which is far
 * more than a zone dropped to divide up one corner of the canvas needs -- so dropping
 * Unify used to cover most of the viewport and had to be resized before anything could
 * be placed beside it. Growth is cheap in the other direction: `growZones` widens a zone
 * the moment a component is dropped that does not fit.
 *
 * Height is untouched. A quarter-height zone has no room for a component under its own
 * label -- MIN_ZONE_HEIGHT exists for that reason -- and it was the width that was asked
 * about.
 */
export function droppedZoneSize(zoneId, descriptor) {
  const full = zoneSpanSize(DEFAULT_ZONE_SPAN)
  /*
   * A divider arrives big, on both axes, and it is the one case where that is right: it is a
   * division of the working surface rather than a region within it, so every section has to have
   * room for a whole diagram from the moment it lands. A quarter-width divider would have to be
   * dragged out before anything could be put either side of the line.
   */
  if (descriptor?.frame) {
    return { width: full.width * 2, height: Math.max(full.height * 2, MIN_ZONE_HEIGHT * 4) }
  }
  if (zoneId === FULL_SPAN_ZONE) return full
  return {
    width: Math.max(MIN_ZONE_WIDTH, Math.round(full.width / 4)),
    height: full.height,
  }
}

/* Breathing room kept below and to the right of the last child, so resizing to the
   floor does not leave a component flush against the dashed border. */
const CHILD_MARGIN = 20

/*
 * The gap a shrinking zone will not pull two of its children closer than.
 *
 * `scaleZoneChildren` scales positions but not sizes, so without a floor the arithmetic
 * runs all the way down: drag a zone's edge far enough and its components end up
 * touching, then overlapping, and the connectors between them have nowhere to be drawn.
 * A diagram whose edges cannot be seen is the thing the zone was being tidied up *for*.
 *
 * 24px is two things at once: enough for an edge and its arrowhead to read as a line
 * between two cards rather than a seam, and comfortably more than the 8px handles that
 * sit on the facing borders of the pair. Below it the two cards' handles would touch
 * before the cards did.
 *
 * So a zone stops shrinking once its contents are this tight -- see `scaleFloor`. That is
 * a floor on the *contents*, not on the zone, which is why it is enforced here and not as
 * a `minWidth` on the resizer: the zone's own minimum depends on what is in it, and the
 * handle is allowed to keep moving while the arrangement still has slack to give up.
 */
export const MIN_CHILD_GAP = 24

/*
 * A child's footprint, for sizing the zone that has to cover it.
 *
 * A nested zone is a child like any other, but its size is explicit rather than
 * measured -- React Flow does not measure group nodes from their contents -- so
 * reading `measured` first would floor a parent at NODE_WIDTH on the render before
 * the sub-zone is laid out, and Unify would briefly clamp Profiles to a node's
 * width.
 */
function childExtent(child) {
  if (child.type === 'zone') {
    const { width, height } = zoneSize(child)
    return { width: width || MIN_ZONE_WIDTH, height: height || MIN_ZONE_HEIGHT }
  }
  /* Chosen size before measured size. A resize the user has just dragged is in the
     document a frame before the DOM reports it, so reading `measured` first would size
     the zone from the card's previous footprint and leave it one gesture behind. */
  const chosen = componentSize(child)
  return {
    width: chosen.width ?? child.measured?.width ?? NODE_WIDTH,
    height: chosen.height ?? child.measured?.height ?? NODE_HEIGHT,
  }
}

/**
 * The smallest box that still covers a zone's contents.
 *
 * No longer the resize floor -- a zone can now be dragged smaller than its
 * contents, and `scaleZoneChildren` moves them in with it. What this is for is
 * growth: after a child has been dragged or a sub-zone moved out to sit beside its
 * sibling, the parent has to be big enough to still contain what it contains, or
 * the child renders outside a box it is nonetheless a child of.
 *
 * @param zoneId  the React Flow node id (`zone-<zone>`), which is what children
 *   carry as `parentId` -- not the zone's own id. Sub-zones carry it too, so
 *   Unify's floor already accounts for Profiles with nothing added here.
 */
export function minZoneSize(zoneId, nodes) {
  let width = MIN_ZONE_WIDTH
  let height = MIN_ZONE_HEIGHT
  for (const child of nodes ?? []) {
    if (child.parentId !== zoneId) continue
    const extent = childExtent(child)
    width = Math.max(width, child.position.x + extent.width + CHILD_MARGIN)
    height = Math.max(height, child.position.y + extent.height + CHILD_MARGIN)
  }
  return { width, height }
}

/* Geometry belongs to React Flow, not to the payload: a copy of it in `data`
   would go stale the first time anyone dragged a handle. */
function zoneMeta({ position, width, height, ...meta }) {
  return meta
}

/**
 * A zone -> a React Flow group node.
 *
 * Shared with the palette's zone drop so there is one definition of what makes a
 * zone a zone, rather than two that drift.
 *
 * `parentZoneId` is the *zone* id of the containing zone, not its node id, and it
 * is passed in rather than read from `zone.parent` because a parent that is not in
 * this document has to be treated as absent: a zone whose declared parent is
 * missing must render as a root, not vanish inside a group node that does not
 * exist. Only buildLayout knows which zones are present.
 */
export function toZoneNode(zone, { position, width, height, kindCount = 0, parentZoneId = null }) {
  return {
    id: zoneNodeId(zone.id),
    type: 'zone',
    position,
    /* No `extent: 'parent'`. A sub-zone clamped to its parent's box cannot be moved
       to sit beside its sibling, and Segment is sized snugly around the three
       products -- which is why zones read as locked in place. The parent grows to
       cover them instead (`growZones`). */
    ...(parentZoneId ? { parentId: zoneNodeId(parentZoneId) } : {}),
    /* React Flow needs explicit dimensions on a group node -- it does not
       measure them from children. */
    width,
    height,
    data: { ...zoneMeta(zone), kindCount },
    /* Movable and resizable, but only by its header strip. Dragging from the
       backdrop would turn every click on empty space inside a zone into a move
       of the whole region, and the backdrop has to stay click-through for
       palette drops to land. */
    dragHandle: '.zone-handle',
    draggable: true,
    selectable: true,
    // Behind the components it contains.
    zIndex: ZONE_Z,
  }
}

/**
 * Group nodes by zone, then by column, preserving input order within a column.
 * Returns `{ [zoneId]: { [column]: node[] } }`.
 *
 * A node with no zone is not bucketed at all -- it belongs to the working area
 * outside every zone, where the column layout has no say. `buildLayout` places
 * those separately.
 */
function bucket(nodes) {
  const byZone = {}
  for (const node of nodes) {
    if (!node.zone) continue
    const column = columnFor(node.kind)
    byZone[node.zone] ??= {}
    byZone[node.zone][column] ??= []
    byZone[node.zone][column].push(node)
  }
  return byZone
}

/**
 * Build React Flow nodes from a server graph.
 *
 * @param graph  `{nodes, edges, zones}` as returned by /api/workspace/graph or
 *   stored in a diagram. A zone's own `position`/`width`/`height` win over the
 *   computed layout when present.
 * @param existingPositions  optional map of nodeId -> {x, y} to preserve
 *   hand-placed positions across a refresh. Without this, re-fetching the
 *   workspace would throw away every manual adjustment the user made.
 * @param existingZones  the same, for zone geometry: `captureZones` output. A
 *   refresh must not undo a resize any more than it undoes a drag.
 * @param minZoneSpan  optional `{columns, rows}` floor on a *computed* zone size.
 *   Deliberately not applied to a zone that carries its own geometry -- there the
 *   size is something the user chose.
 */
export function buildLayout(graph, { existingPositions, existingZones, minZoneSpan } = {}) {
  const zones = [...(graph.zones ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const buckets = bucket(graph.nodes ?? [])

  /* A zone naming a parent this document does not contain is laid out as a root. A
     diagram saved before zones nested has no `parent` anywhere and so comes out
     flat, exactly as it did -- and a partial one, Unify without Segment, still shows
     Unify rather than losing it inside a group node that was never created. */
  const present = new Set(zones.map((zone) => zone.id))
  const subZones = {}
  const roots = []
  for (const zone of zones) {
    const parent = zone.parent && present.has(zone.parent) ? zone.parent : null
    if (parent) (subZones[parent] ??= []).push(zone)
    else roots.push(zone)
  }

  const zoneNodes = []
  const componentNodes = []
  /* Cycle guard, for the same reason rules.js's zoneChain has one: `zones` arrives
     inside a saved document and nothing validates that its parent links form a tree,
     so a hand-edited one claiming Unify's parent is Profiles would recurse forever. */
  const placedZones = new Set()

  /*
   * Lay a zone out, then its sub-zones inside it. Returns the footprint the caller
   * needs to cover.
   *
   * Pushed to `zoneNodes` on the way in and resized on the way out, which is why it
   * mutates a node it has already pushed: React Flow requires a parent to precede
   * its children in the nodes array, but a parent's size is not known until the
   * children it has to contain are placed.
   */
  function placeZone(zone, parentZoneId, offered) {
    placedZones.add(zone.id)

    const columns = buckets[zone.id] ?? {}
    const columnIndices = Object.keys(columns)
      .map(Number)
      .sort((a, b) => a - b)

    const tallestColumn = Math.max(
      1,
      minZoneSpan?.rows ?? 1,
      ...columnIndices.map((index) => columns[index].length),
    )
    const widestColumn = Math.max(
      minZoneSpan?.columns ?? 1,
      columnIndices.length ? Math.max(...columnIndices) + 1 : 1,
    )
    const computed = zoneSpanSize({ columns: widestColumn, rows: tallestColumn })

    /* Live canvas state first, then whatever the document stored, then the
       computed column layout. The order matters on a workspace refresh: the
       server's zones payload carries no geometry, so without the live values a
       refresh would snap every resized zone back to its computed size.

       A sub-zone's stored and live positions are already parent-local, because
       captureZones reads them straight off a React Flow child node -- so nothing is
       translated here, and `offered` is only ever the fallback. */
    const live = existingZones?.[zone.id]
    let zoneWidth = live?.width ?? zone.width ?? computed.width
    let zoneHeight = live?.height ?? zone.height ?? computed.height
    const placed = live?.position ?? zone.position ?? null
    const position = placed ? { x: placed.x, y: placed.y } : offered

    const zoneMembers = (graph.nodes ?? []).filter((node) => node.zone === zone.id)

    const zoneNode = toZoneNode(zone, {
      position,
      width: zoneWidth,
      height: zoneHeight,
      kindCount: zoneMembers.length,
      parentZoneId,
    })
    zoneNodes.push(zoneNode)

    for (const columnIndex of columnIndices) {
      columns[columnIndex].forEach((node, rowIndex) => {
        const fallback = {
          x: ZONE_PADDING_X + columnIndex * (NODE_WIDTH + COLUMN_GAP),
          y: ZONE_PADDING_TOP + rowIndex * (NODE_HEIGHT + ROW_GAP),
        }
        componentNodes.push(toFlowNode(node, zone.id, existingPositions?.[node.id] ?? fallback))
      })
    }

    /* Grow the zone to cover restored positions. The size above is what the column
       layout needs, which is usually narrower than where someone dragged things, and a
       node outside its zone's box renders past the backdrop's edge -- so a saved diagram
       would come back looking broken in a way it was not when it was saved. */
    for (const node of zoneMembers) {
      const restored = existingPositions?.[node.id]
      if (!restored) continue
      const chosen = componentSize(node)
      zoneWidth = Math.max(zoneWidth, restored.x + (chosen.width ?? NODE_WIDTH) + ZONE_PADDING_X)
      zoneHeight = Math.max(
        zoneHeight,
        restored.y + (chosen.height ?? NODE_HEIGHT) + ZONE_PADDING_BOTTOM,
      )
    }

    /* Sub-zones stack below whatever components the zone holds itself, measured from
       the rows rather than from `computed.height` -- that carries a one-row floor, and
       the Segment zone holds no components at all, so starting its children below a
       phantom row would open a band of empty backdrop under the label. */
    const ownRows = columnIndices.reduce((rows, index) => Math.max(rows, columns[index].length), 0)
    let subZoneTop = ownRows
      ? ZONE_PADDING_TOP + ownRows * NODE_HEIGHT + (ownRows - 1) * ROW_GAP + ZONE_GAP
      : ZONE_PADDING_TOP

    for (const child of subZones[zone.id] ?? []) {
      if (placedZones.has(child.id)) continue
      const box = placeZone(child, zone.id, { x: ZONE_PADDING_X, y: subZoneTop })
      zoneWidth = Math.max(zoneWidth, box.position.x + box.width + ZONE_PADDING_X)
      zoneHeight = Math.max(zoneHeight, box.position.y + box.height + ZONE_PADDING_BOTTOM)
      subZoneTop = Math.max(subZoneTop, box.position.y + box.height + ZONE_GAP)
    }

    zoneNode.width = zoneWidth
    zoneNode.height = zoneHeight
    return { position, width: zoneWidth, height: zoneHeight }
  }

  let zoneTop = 0
  for (const zone of roots) {
    if (placedZones.has(zone.id)) continue
    const box = placeZone(zone, null, { x: 0, y: zoneTop })
    /* Auto-placed zones stack. Advancing past an explicitly-placed one too means a
       mix of the two leaves a gap rather than an overlap -- a zone hidden under
       another one reads as having vanished. */
    zoneTop = Math.max(zoneTop, box.position.y + box.height + ZONE_GAP)
  }

  /*
   * Everything the zones did not claim, on bare canvas.
   *
   * Two kinds of node land here: one deliberately dropped in the working area, which
   * has no zone at all; and one whose zone is not in this document, which happens
   * when a zone was deleted or a graph is opened against a topology that no longer
   * has it. The second used to be dropped silently -- `bucket` keyed on the zone id
   * and only the zones present were ever read back -- so a deleted zone took its
   * contents out of the diagram with it and the save afterwards made that permanent.
   */
  const claimed = new Set(componentNodes.map((node) => node.id))
  let looseX = 0
  for (const node of graph.nodes ?? []) {
    if (claimed.has(node.id)) continue
    const stored = existingPositions?.[node.id] ?? node.position ?? null
    const fallback = { x: looseX, y: zoneTop }
    if (!stored) looseX += NODE_WIDTH + COLUMN_GAP
    componentNodes.push(toFlowNode({ ...node, zone: null }, null, stored ?? fallback))
  }

  return {
    nodes: [...zoneNodes, ...componentNodes],
    edges: (graph.edges ?? []).map(toFlowEdge),
  }
}

/**
 * Grow every zone to cover its children, innermost first.
 *
 * The counterpart to zones being movable. A sub-zone dragged out to sit beside its
 * sibling, or a component dragged to the far corner of one, leaves a parent that no
 * longer contains what it contains -- and a child drawn outside its parent's
 * backdrop reads as a rendering bug rather than as a diagram.
 *
 * Only ever grows. Shrinking a zone because its contents moved inward would undo a
 * size the user chose by dragging a handle, and there is no way to tell the two
 * apart after the fact.
 *
 * Depth-first from the leaves, because a parent's floor is computed from its
 * children's *current* sizes -- growing Profiles has to be what Unify then measures,
 * or Segment settles a frame behind on every drag.
 */
export function growZones(nodes) {
  const list = nodes ?? []
  const grown = new Map()
  /* Cycle guard, for the same reason rules.js's zoneChain has one: the parent links
     come from live canvas state, and a bad one should fail a test rather than
     overflow the stack on a drag frame. */
  const visiting = new Set()

  const sizeOf = (id) => {
    if (grown.has(id)) return grown.get(id)
    if (visiting.has(id)) return list.find((node) => node.id === id)
    visiting.add(id)
    /* Children first: `minZoneSize` reads sizes off the array, so a nested zone has to
       have been grown before its parent measures it. */
    for (const child of list) {
      if (child.parentId === id && child.type === 'zone') sizeOf(child.id)
    }
    const zone = list.find((node) => node.id === id)
    const current = zoneSize(zone)
    const floor = minZoneSize(id, list.map((node) => grown.get(node.id) ?? node))
    const size = {
      ...zone,
      width: Math.max(current.width, floor.width),
      height: Math.max(current.height, floor.height),
    }
    grown.set(id, size)
    return size
  }

  for (const node of list) {
    if (node.type === 'zone' && !grown.has(node.id)) sizeOf(node.id)
  }

  let changed = false
  const next = list.map((node) => {
    const size = grown.get(node.id)
    if (!size) return node
    if (size.width === zoneSize(node).width && size.height === zoneSize(node).height) return node
    changed = true
    return size
  })
  /* Same array back when nothing moved. This runs from a node-change handler, and a
     new array every frame is a re-render of every node on the canvas. */
  return changed ? next : list
}

/**
 * Move a zone's contents with it as it is resized.
 *
 * What the resize handles used to do instead was refuse: the floor was the zone's
 * own contents, so dragging the right edge left stopped dead at the last component.
 * That makes a zone laid out once impossible to tighten up. Scaling the contents
 * instead means the handle always moves and the arrangement inside is preserved
 * proportionally.
 *
 * Positions scale; component *sizes* do not. A 200x60 card at 60% is unreadable, and
 * the thing being adjusted is the arrangement, not the type size. Nested zones are
 * the exception -- they are boxes, their size is explicit, and a sub-zone that kept
 * its width while its parent halved would hang out of it. Their own contents scale
 * with them, recursively, so shrinking Segment tightens the whole tree at once
 * rather than leaving Profiles' components hanging out of a smaller Profiles.
 *
 * Because sizes do not scale, a scaled position alone is not enough: a card whose
 * right edge fitted at the old width can have its top-left scale inward and its right
 * edge still land outside the new one. So each child is also clamped into the new box.
 * Without that clamp the shrink does not stick -- `growZones` runs on the next drag,
 * finds a child overhanging, and snaps the zone back out, which is the "the resize
 * floor is the contents" behaviour this function exists to get rid of, only deferred
 * to a later gesture and therefore harder to understand. Clamping to exactly
 * `size - extent - CHILD_MARGIN` is what makes `minZoneSize` come back with the size
 * the user dragged to, so there is nothing left to grow.
 */
export function scaleZoneChildren(nodes, zoneId, from, to, seen = new Set()) {
  const rawX = from?.width ? to.width / from.width : 1
  const rawY = from?.height ? to.height / from.height : 1
  if (rawX === 1 && rawY === 1) return nodes ?? []
  // Cycle guard, as in growZones.
  if (seen.has(zoneId)) return nodes ?? []
  seen.add(zoneId)

  let out = nodes ?? []
  const children = out.filter((node) => node.parentId === zoneId)

  /* Only a shrink is floored. Growing a zone spreads its contents out, which cannot make
     two of them harder to tell apart, and flooring the factor either way would stop a
     zone being widened past whatever ratio its tightest pair happened to have. */
  const fx = rawX < 1 ? Math.max(rawX, scaleFloor(children, 'x')) : rawX
  const fy = rawY < 1 ? Math.max(rawY, scaleFloor(children, 'y')) : rawY

  /*
   * The box the clamp below is allowed to squeeze children into.
   *
   * The clamp pulls an overhanging child back inside, which is what makes a shrink stick
   * (see below). But it clamps each child independently, so two cards side by side can both
   * be pulled to the same limit and land on top of each other -- which would undo the gap
   * floor above by a different route, on exactly the pair it just protected.
   *
   * So the clamp works against whichever is larger: the size the user dragged to, or the
   * smallest box the children still fit in side by side. When the contents are already as
   * tight as they go, that makes the clamp a no-op, the children keep their gaps, and
   * `growZones` grows the zone back out to hold them -- so the handle stops moving. That is
   * the honest answer to "shrink this below what its contents can readably occupy", and it
   * is a floor on the *contents*, so a zone holding one card still shrinks to that card.
   */
  const room = {
    width: Math.max(to.width, minRoom(children, 'x')),
    height: Math.max(to.height, minRoom(children, 'y')),
  }

  out = out.map((node) => {
    if (node.parentId !== zoneId) return node

    let sized = node
    if (node.type === 'zone') {
      const { width, height } = zoneSize(node)
      sized = {
        ...node,
        width: Math.max(MIN_ZONE_WIDTH, Math.round(width * fx)),
        height: Math.max(MIN_ZONE_HEIGHT, Math.round(height * fy)),
      }
    }

    /* Read off `sized`, so a nested zone is clamped by the size it just became rather
       than the one it is leaving. */
    const extent = childExtent(sized)

    /* Floored at 0 rather than at the zone's padding: 0 is the zone's own box, which
       is what `minZoneSize` measures and therefore all this has to satisfy. Only
       reachable at all when the child is wider than the room its parent has, which
       after a scale means a sub-zone already at MIN -- a component has 40px of slack
       even in the narrowest zone React Flow's resizer allows. */
    const fit = (value, size, childSize) =>
      Math.max(0, Math.min(value, size - childSize - CHILD_MARGIN))

    return {
      ...sized,
      position: {
        x: fit(Math.round((node.position?.x ?? 0) * fx), room.width, extent.width),
        y: fit(Math.round((node.position?.y ?? 0) * fy), room.height, extent.height),
      },
    }
  })

  for (const child of children) {
    if (child.type !== 'zone') continue
    const before = zoneSize(child)
    const after = zoneSize(out.find((node) => node.id === child.id))
    out = scaleZoneChildren(out, child.id, before, after, seen)
  }
  return out
}

/*
 * A zone's children projected onto one axis, with the other axis kept so rows can be told
 * apart. Shared by the two floors below, which ask different questions of the same shape.
 */
function axisBoxes(children, axis) {
  const horizontal = axis === 'x'
  return (children ?? []).map((child) => {
    const extent = childExtent(child)
    return {
      start: horizontal ? (child.position?.x ?? 0) : (child.position?.y ?? 0),
      size: horizontal ? extent.width : extent.height,
      crossStart: horizontal ? (child.position?.y ?? 0) : (child.position?.x ?? 0),
      crossSize: horizontal ? extent.height : extent.width,
    }
  })
}

/** Do two projected boxes overlap on the axis that is *not* being measured? */
function sameRow(a, b) {
  return (
    b.crossStart < a.crossStart + a.crossSize && a.crossStart < b.crossStart + b.crossSize
  )
}

/**
 * The smallest extent along one axis that still holds a zone's children side by side.
 *
 * Measured per row -- the set of children that overlap each other on the *other* axis, and
 * so genuinely have to be laid out along this one. Cards in different rows are free to
 * occupy the same span, and counting them as competing for it would floor a tall zone's
 * width at the sum of every card in it.
 *
 * The gap demanded between two of them is `MIN_CHILD_GAP` or their current gap, whichever is
 * smaller. Two cards the user placed touching stay touching: this is a limit on how much
 * crowding a *resize* introduces, not an opinion about a layout somebody arranged by hand.
 *
 * Rows are not transitive here -- A may share a row with B and B with C without A and C
 * overlapping -- so this is a lower bound rather than an exact packing. That is the right
 * shape for a floor: too small merely allows a tighter shrink than ideal, whereas too large
 * would stop a zone shrinking at all.
 */
function minRoom(children, axis) {
  const boxes = axisBoxes(children, axis)
  let room = 0

  for (const anchor of boxes) {
    const row = boxes.filter((box) => sameRow(anchor, box)).sort((a, b) => a.start - b.start)
    let needed = 0
    let previous = null
    for (const box of row) {
      if (previous) {
        const gap = Math.max(0, box.start - (previous.start + previous.size))
        needed += Math.min(MIN_CHILD_GAP, gap)
      }
      needed += box.size
      previous = box
    }
    room = Math.max(room, needed + CHILD_MARGIN)
  }

  return room
}

/**
 * The smallest factor a zone's contents may be scaled by on one axis, or 0 when nothing
 * constrains it.
 *
 * Only pairs that are genuinely *beside* each other on this axis are counted. Two cards in
 * different rows slide past one another as a zone narrows without either becoming harder to
 * read, and treating them as a constraining pair would floor the width of a tall zone at
 * the width of its widest row -- which would stop most vertical shrinking dead.
 *
 * A pair already closer than the gap is skipped rather than pushed apart. This is a floor
 * on how much crowding a *resize* may introduce, not an opinion about a layout the user
 * arranged by hand; enforcing the gap on the way in would move cards someone deliberately
 * placed touching.
 *
 * @param axis  'x' or 'y' -- the axis being scaled
 */
export function scaleFloor(children, axis) {
  const boxes = axisBoxes(children, axis)

  let floor = 0
  for (const first of boxes) {
    for (const second of boxes) {
      if (second.start <= first.start) continue
      // Not side by side on this axis, so narrowing cannot bring them into contact.
      if (!sameRow(first, second)) continue
      // Already tighter than the gap: not this resize's doing, and not its to fix.
      if (second.start - (first.start + first.size) < MIN_CHILD_GAP) continue
      /* Positions scale and sizes do not, so the gap after scaling by f is
         `separation * f - first.size`. Solving that for MIN_CHILD_GAP gives the factor
         below which this pair would be closer than the gap. */
      floor = Math.max(floor, (first.size + MIN_CHILD_GAP) / (second.start - first.start))
    }
  }

  /* Capped at 1. A floor above it would mean the tightest pair is *already* closer than
     the gap, which the skip above has excluded -- but a rounding error here would turn a
     shrink into a grow, which is worth being unable to express. */
  return Math.min(1, floor)
}

/**
 * The same nodes, in an order React Flow can read: every parent before its children.
 *
 * React Flow resolves parents by walking the array once, so a child that comes first is
 * treated as having *no* parent -- "Parent node zone-engage not found. Please make sure
 * that parent nodes are in front of their child nodes", logged on every render (hundreds
 * of times during one drag), with the child's parent-relative position then read as
 * absolute so it draws somewhere other than where it is.
 *
 * `buildLayout` emits the right order, and nothing that edits the canvas afterwards
 * preserves it: dropping a zone appends it *after* the components already there, and
 * dragging one of those in then makes a child that precedes its parent. Paste and
 * duplicate append too. Rather than each of those remembering to re-sort -- which is
 * exactly the kind of invariant that holds until the next feature -- the order is
 * established here, once, where React Flow reads the list.
 *
 * Ordering only. A `parentId` naming a node that is genuinely absent is left alone: the
 * fix for that is not to quietly drop the link (whose stored position is parent-relative,
 * so the node would move) but for no such node to be built, which is what the drop and
 * paste guards are for.
 *
 * Among siblings the order is *largest first*, which is the rule "drag a big zone over a
 * small one and the small one stays on top" -- array order is paint order for two nodes at
 * the same z, and every zone is at the same z. Deliberately not "whichever is being
 * dragged goes on top", which is the other obvious answer and the one that loses the
 * request: dragging the big zone is exactly when it must *not* come forward, or it lands
 * covering the region it was moved next to and takes its clicks with it.
 *
 * `data.arrange` overrides that, and is checked before it. It is what Bring forward / Send
 * backward write (see canvas/selection.js): the size rule is a *default* -- a guess at
 * which of two overlapping regions the reader wants to see -- and once someone has said
 * which one they want in front, a guess must not keep overruling them. Absent on almost
 * every node, which is why it reads as 0 and leaves the size rule deciding.
 */
export function orderForFlow(nodes) {
  const list = nodes ?? []
  if (list.length < 2) return list

  const byId = new Map(list.map((node) => [node.id, node]))
  const depths = new Map()

  const depthOf = (node) => {
    if (depths.has(node.id)) return depths.get(node.id)
    /* Provisional, and it is the cycle guard: a parent chain that comes back round to
       here reads this instead of recursing. The links come from live canvas state, so a
       bad one should draw a diagram in the wrong order rather than overflow the stack
       mid-drag. */
    depths.set(node.id, 0)
    const parent = node.parentId ? byId.get(node.parentId) : null
    const depth = parent ? depthOf(parent) + 1 : 0
    depths.set(node.id, depth)
    return depth
  }

  const ordered = list
    .map((node, index) => ({ node, index, depth: depthOf(node), area: nodeArea(node) }))
    /* Depth first, and depth alone would satisfy React Flow -- a parent is always
       shallower than its child. Then whatever the user arranged, then area descending as
       the default arrangement rule; the index tiebreak keeps two nodes of equal size where
       the user last left them. */
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        arrangeOf(a.node) - arrangeOf(b.node) ||
        b.area - a.area ||
        a.index - b.index,
    )
    .map((entry) => entry.node)

  /* Same array back when it was already in order. This runs on every render of the
     canvas, and a new array each time is a new prop identity for React Flow. */
  return ordered.some((node, index) => node !== list[index]) ? ordered : list
}

/**
 * Where the user put this node in the stack, as a plain integer.
 *
 * 0 for the overwhelming majority -- `arrange` is written only onto the siblings of
 * something that has actually been brought forward or sent back, so an untouched diagram
 * sorts entirely by the size rule and stores no stacking data at all.
 */
export const arrangeOf = (node) => node?.data?.arrange ?? 0

/**
 * How big a node is on screen, for the arrangement rule above.
 *
 * `width` before `measured` -- a resize writes the top-level width and `measured` still
 * describes the old box for a frame, so reading `measured` first re-sorts the canvas one
 * frame behind the drag. Falls back to a component's default box rather than to zero,
 * because an unmeasured card sorting as area 0 would come out on top of everything
 * including the cards it overlaps.
 *
 * Exported because `arrangeNodes` has to reproduce this exact ordering to work out what
 * "one level forward" means -- two sorts that disagree would make the menu item move a
 * node somewhere other than where the canvas then draws it.
 */
export function nodeArea(node) {
  const width = node.width ?? node.measured?.width ?? node.data?.size?.width ?? NODE_WIDTH
  const height = node.height ?? node.measured?.height ?? node.data?.size?.height ?? NODE_HEIGHT
  return width * height
}

/**
 * A component -> a React Flow node.
 *
 * @param zoneId  the zone it belongs to, or null for one sitting on bare canvas.
 *   Null is meaningful and distinct from omitted: a component in the working area
 *   outside every zone has no parent and an absolute position, and defaulting it
 *   into Connections would move something the user put somewhere on purpose. An
 *   *omitted* zone still falls back to the payload's own, for documents written
 *   before the working area existed.
 */
export function toFlowNode(node, zoneId, position) {
  const zone = zoneId === undefined ? (node.zone ?? null) : zoneId
  const chosen = componentSize(node)
  return {
    id: node.id,
    /* Two kinds have a renderer of their own, and the `kind` is what decides -- so each survives a
       save and reload as itself, since `type` is React Flow's and is not stored.
         - a shape, whose outline *is* the content where a component's box is furniture around
           fields (canvas/nodes/ShapeNode.jsx)
         - a table, whose content is a grid of editable cells rather than a label
           (canvas/nodes/TableNode.jsx) */
    type: NODE_TYPE_FOR_KIND[node.kind] ?? 'segmentNode',
    position,
    ...(zone ? { parentId: zoneNodeId(zone) } : {}),
    /* Only when the user chose one. React Flow prefers a top-level `width` over
       everything else when it renders, so a default written here would stop a card
       ever growing with its own contents -- and `measured` would then agree with it,
       which makes the freeze invisible. */
    ...(chosen.width ? { width: chosen.width } : {}),
    ...(chosen.height ? { height: chosen.height } : {}),
    zIndex: COMPONENT_Z,
    data: {
      /* Spread the server payload wholesale: the inspector renders whatever
         fields came back, so dropping unknown ones here would silently hide
         them. */
      ...node,
      /* After the spread, so the resolved zone wins over whatever the payload
         claimed. `parentId` above and `data.zone` are the same fact stored twice --
         React Flow needs the one, the document stores the other -- and the two
         disagreeing is how a node ends up drawn in Unify and saved into Engage. */
      zone,
      collapsed: node.collapsed ?? false,
      /* Template placeholders arrive with bound: false. Anything from the live
         workspace is bound by definition. */
      bound: node.bound ?? true,
      style: node.style ?? null,
    },
  }
}

/*
 * The arrowhead every connector wears.
 *
 * A connector is directed -- the walkthrough walks `source -> target` and nothing else --
 * and until this existed nothing on screen said which way. That is not a missing nicety: the
 * four-sided handles need `ConnectionMode.Loose`, and under Loose React Flow makes `source`
 * whichever end the *drag started from*, so drawing a line from a destination back to the
 * source that feeds it stores it reversed. Both gestures look identical, so a diagram fills
 * up with connectors pointing the wrong way and the first symptom is a walkthrough that
 * stops halfway with nothing to explain why. The arrowhead is what makes that visible while
 * it is being drawn rather than days later; canvas/direction.js is what fixes one.
 *
 * There is no top-level `markerEnd` here any more: the arrowhead's colour has to match the
 * line's, and the line's colour is a live fact about the source component (see
 * `borderColorFor`), not something this function can resolve once at load time. FlowEdge
 * draws its own marker per edge instead, and defaults `arrowEnd` below so a connector
 * with no explicit choice still wears one -- which is what preserves the guarantee this
 * used to provide.
 */
export function toFlowEdge(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    /* Which side of each node this connector meets, when the document says. Absent means
       "the default pair", which React Flow resolves to the first source and first target
       handle -- east and west, in that order, which is why SIDES is ordered as it is. */
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    /* canvas/edges/FlowEdge.jsx -- the same geometry as the builtin `smoothstep`
       it replaces, plus room for a coloured overlay per scenario. */
    type: 'flow',
    /* Server-discovered edges are facts about the workspace; the user should not
       be able to silently delete one and think they changed something. Manual
       edges are created without this flag. */
    deletable: edge.discovered !== true,
    data: {
      phase: edge.phase ?? null,
      discovered: edge.discovered ?? true,
      /* Only when the document says. Absent means "the default style, no bends", and writing
         those in here would make every edge carry a route nobody chose -- which `serializeEdge`
         would then persist, marking every diagram dirty on open. */
      ...(edge.line ? { line: edge.line } : {}),
      ...(edge.waypoints?.length ? { waypoints: edge.waypoints } : {}),
      /* The precise point along `sourceHandle`'s side a free anchor sits at -- see
         `fixedHandleForSide` in canvas/handles.js for why the fixed id above and this exact
         point are two separate facts rather than one. */
      ...(edge.sourceAnchor ? { sourceAnchor: edge.sourceAnchor } : {}),
      ...(edge.targetAnchor ? { targetAnchor: edge.targetAnchor } : {}),
      /* Same omit-when-absent reasoning for the styling fields: an unstyled connector has to
         serialize byte-identically to one that was never touched, or every diagram reads as
         dirty on open. FlowEdge supplies the actual defaults (source colour, solid, arrowEnd
         only) when these are missing. */
      ...(edge.color ? { color: edge.color } : {}),
      ...(edge.strokeStyle ? { strokeStyle: edge.strokeStyle } : {}),
      ...(edge.arrowStart ? { arrowStart: edge.arrowStart } : {}),
      ...(edge.arrowEnd === false ? { arrowEnd: false } : {}),
    },
  }
}

/** Snapshot current positions so a refresh can preserve manual placement. */
export function capturePositions(nodes) {
  const positions = {}
  for (const node of nodes) {
    if (node.type === 'zone') continue
    positions[node.id] = { x: node.position.x, y: node.position.y }
  }
  return positions
}

/**
 * A zone node -> the descriptor `buildLayout` consumes.
 *
 * The inverse of `toZoneNode`, and lossy in the one way that matters: `kindCount`
 * is dropped because it is counted from the graph, not stored.
 */
export function zoneDescriptor(node) {
  const { kindCount, ...meta } = node.data ?? {}
  return {
    ...meta,
    position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
    ...zoneSize(node),
  }
}

/** The same for zone geometry, keyed by zone id rather than by node id. */
export function captureZones(nodes) {
  const zones = {}
  for (const node of nodes) {
    if (node.type !== 'zone') continue
    const { width, height } = zoneSize(node)
    zones[node.data.id] = {
      position: { x: node.position.x, y: node.position.y },
      width,
      height,
    }
  }
  return zones
}
