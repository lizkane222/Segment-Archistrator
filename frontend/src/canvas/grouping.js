/*
 * Grouping and collapsing, so a real workspace stays readable.
 *
 * Retiring the `segment_core` hub made the canvas draw the connections a workspace
 * actually has instead of N+M edges through a middle node -- see the comment above
 * ALLOWED_EDGES in apps/segmentapi/topology.py. Thirty sources each feeding twenty
 * destinations is six hundred edges. This module is what makes that legible: the
 * document keeps every node and every edge, and a *view* of it collapses whole
 * groups down to one node with their edges merged.
 *
 * Everything here is pure. The collapse state is a list of group keys, so what a
 * reader chose to fold away survives a save, and the arithmetic that decides "forty
 * edges became one, labelled 40" is unit-testable without a canvas.
 *
 * Two consequences of the view being derived rather than stored, both deliberate:
 *
 *   - A stack node's id is not in the document, so React Flow's change stream has
 *     nothing to write it back to. Dragging one is translated onto its members
 *     (`translateGroupDrag`) and selecting one is not offered at all.
 *   - Collapsing is not an edit to the graph. It marks the document dirty because
 *     it is a reading someone arranged, but it can never lose a component.
 */

import { COMPONENT_Z, NODE_WIDTH } from './layout.js'

export const GROUP_PREFIX = 'group:'
export const AGGREGATE_PREFIX = 'agg:'

/* The bucket for a component whose type facet is missing. One explicit bucket
   rather than a null header: `sync_catalog` has never been run against a real
   token, so an empty `categories` is the expected case and not an anomaly worth a
   different-looking group. */
export const UNCATEGORISED = 'uncategorised'

/* A group of one collapses to something the same size holding strictly less, so it
   is left expanded however the collapse state reads. */
export const MIN_GROUP_SIZE = 2

/* Members named on the face of a collapsed stack before it says "+N more". Enough
   to recognise the group, few enough that the node stays node-sized. */
export const GROUP_PEEK = 3

const GROUP_HEADER_HEIGHT = 36
const GROUP_ROW_HEIGHT = 17
const GROUP_PADDING = 8

/*
 * The sub-type facet, per kind.
 *
 * "order by source/destination type, then name" -- so the facet is whatever a
 * Twilion would call that component's type, read off the node rather than stored:
 * a destination's `categories` comes from the catalog's `raw.categories` at read
 * time, and adding a column for it would mean a catalog sync this project has never
 * been able to run.
 *
 * A kind absent from this table groups by kind alone. That is not an oversight --
 * an audience or a journey has no second axis anyone sorts by, and inventing one
 * would split a group of six into six groups of one.
 */
const TYPE_OF = {
  source: (data) => data.sourceType,
  destination: (data) => data.categories?.[0],
  warehouse: (data) => data.warehouseType,
}

const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * Which group a node belongs to.
 *
 * Takes a React Flow node or a document node -- `data` when there is one, the node
 * itself otherwise -- because the canvas and the palette hold the same components
 * in the two different shapes and must agree about the grouping.
 */
export function groupKey(node) {
  const data = node?.data ?? node ?? {}
  const kind = data.kind ?? null
  if (!kind) return { kind: null, type: null, key: null }

  const facet = TYPE_OF[kind]
  const type = facet ? (trimmed(facet(data)) ?? UNCATEGORISED) : null
  return { kind, type, key: type ? `${kind}:${type}` : kind }
}

export const isGroupStackId = (id) => String(id ?? '').startsWith(GROUP_PREFIX)

/** `javascript-website` -> `Javascript website`. Leaves `Email Marketing` alone. */
function humanise(value) {
  const words = String(value ?? '').replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : ''
}

/** The header a group is read under: the kind, then the type it was split by. */
export function groupLabel(topology, { kind, type } = {}) {
  const kindLabel = topology?.kinds?.[kind]?.label ?? humanise(kind) ?? 'Component'
  if (!type) return kindLabel
  return `${kindLabel} · ${type === UNCATEGORISED ? 'Uncategorised' : humanise(type)}`
}

/* Alphabetical by kind, then by type. These are lookup lists -- "where is the
   Braze destination" -- and pipeline order is what the canvas itself already draws
   left to right, so repeating it here would only make the list harder to scan. */
function compareGroups(topology) {
  return (a, b) =>
    groupLabel(topology, { kind: a.kind }).localeCompare(groupLabel(topology, { kind: b.kind })) ||
    String(a.type ?? '').localeCompare(String(b.type ?? ''))
}

const byName = (a, b) =>
  String(a?.data?.name ?? a?.name ?? a?.id).localeCompare(String(b?.data?.name ?? b?.name ?? b?.id))

/**
 * The groups on the canvas that are worth offering a collapse control for.
 *
 * Counted per parent as well as per key, because that is how `collapseGraph`
 * partitions: two audiences in two different zones cannot become one stack node, so
 * offering the group would give the user a control that visibly does nothing.
 */
export function groupsOf(nodes, topology) {
  const found = new Map()

  for (const node of nodes ?? []) {
    if (node.type === 'zone' || isGroupStackId(node.id)) continue
    const { kind, type, key } = groupKey(node)
    if (!key) continue

    const entry = found.get(key) ?? { key, kind, type, count: 0, byParent: new Map() }
    entry.count += 1
    const parent = node.parentId ?? ''
    entry.byParent.set(parent, (entry.byParent.get(parent) ?? 0) + 1)
    found.set(key, entry)
  }

  return [...found.values()]
    .filter((entry) => [...entry.byParent.values()].some((count) => count >= MIN_GROUP_SIZE))
    .map(({ byParent, ...entry }) => ({ ...entry, label: groupLabel(topology, entry) }))
    .sort(compareGroups(topology))
}

/**
 * The same grouping as a list with headers, for the palette's Workspace tab.
 *
 * Every group, not only the collapsible ones: a header over a single source is
 * still where a reader looks for it, and unlike on the canvas it costs nothing.
 */
export function groupSections(nodes, topology) {
  const sections = new Map()

  for (const node of nodes ?? []) {
    const { kind, type, key } = groupKey(node)
    if (!key) continue
    const section = sections.get(key) ?? { key, kind, type, items: [] }
    section.items.push(node)
    sections.set(key, section)
  }

  return [...sections.values()]
    .map((section) => ({
      ...section,
      label: groupLabel(topology, section),
      items: [...section.items].sort(byName),
    }))
    .sort(compareGroups(topology))
}

/** A stack node's box. Explicit, because React Flow does not measure a node it
    cannot write a dimensions change back for -- see the header. */
export function groupStackSize(count) {
  const peek = Math.min(count, GROUP_PEEK) + (count > GROUP_PEEK ? 1 : 0)
  return {
    width: NODE_WIDTH,
    height: GROUP_HEADER_HEIGHT + peek * GROUP_ROW_HEIGHT + GROUP_PADDING,
  }
}

/*
 * Scenarios that touched any member.
 *
 * `arrived` is a disjunction on purpose. A collapsed group of forty destinations
 * where thirty-nine received the event and one was withheld has to read as
 * "reached" -- dimming it would say the opposite of what the trace says. The
 * withheld one is still in the trace and the drawer still counts it.
 */
function mergePaths(members) {
  const merged = new Map()
  for (const member of members) {
    for (const entry of member.data?.paths ?? []) {
      const seen = merged.get(entry.scenarioId)
      if (!seen) merged.set(entry.scenarioId, { ...entry })
      else if (entry.arrived) seen.arrived = true
    }
  }
  return merged.size ? [...merged.values()] : undefined
}

/**
 * The canvas, with every collapsed group folded into one node.
 *
 * @param nodes      React Flow nodes, zone backdrops included
 * @param edges      React Flow edges
 * @param collapsed  group keys, as stored in `graph.collapsed`
 *
 * Returns the *same* arrays when nothing collapses, so an expanded canvas is not
 * rebuilt on every render -- the same identity contract `applyPathsToNodes` keeps,
 * and for the same reason: React Flow re-renders what it is handed.
 */
export function collapseGraph(nodes, edges, collapsed) {
  const keys = collapsed instanceof Set ? collapsed : new Set(collapsed ?? [])
  const allNodes = nodes ?? []
  const allEdges = edges ?? []
  if (keys.size === 0) return { nodes: allNodes, edges: allEdges }

  /* Bucketed by (key, parent), not by key alone: a stack is a React Flow node and a
     node has exactly one parent, so one stack spanning two zones could not be
     drawn. Collapsing "Destinations" therefore folds each zone's destinations
     separately, which is also what a reader means by it. */
  const buckets = new Map()
  for (const node of allNodes) {
    if (node.type === 'zone') continue
    const { kind, type, key } = groupKey(node)
    if (!key || !keys.has(key)) continue

    const parentId = node.parentId ?? null
    const stackId = `${GROUP_PREFIX}${key}@${parentId ?? 'canvas'}`
    const bucket = buckets.get(stackId) ?? { stackId, key, kind, type, parentId, members: [] }
    bucket.members.push(node)
    buckets.set(stackId, bucket)
  }

  const live = [...buckets.values()].filter((bucket) => bucket.members.length >= MIN_GROUP_SIZE)
  if (!live.length) return { nodes: allNodes, edges: allEdges }

  const stackOf = new Map()
  const stacks = new Map()
  for (const bucket of live) {
    for (const member of bucket.members) stackOf.set(member.id, bucket.stackId)
    stacks.set(bucket.stackId, buildStack(bucket))
  }

  /* A stack takes the place of its first member so it lands in the reading order
     the nodes it replaced had -- and, since components always follow the zones in
     the array, after the parent React Flow requires it to follow. */
  const outNodes = []
  const emitted = new Set()
  for (const node of allNodes) {
    const stackId = stackOf.get(node.id)
    if (!stackId) {
      outNodes.push(node)
      continue
    }
    if (emitted.has(stackId)) continue
    emitted.add(stackId)
    outNodes.push(stacks.get(stackId))
  }

  const resolve = (id) => stackOf.get(id) ?? id
  const merged = new Map()
  const outEdges = []

  for (const edge of allEdges) {
    const source = resolve(edge.source)
    const target = resolve(edge.target)
    if (source === edge.source && target === edge.target) {
      outEdges.push(edge)
      continue
    }

    if (source === target) {
      /* Both ends landed in the same stack. An edge needs two nodes, so there is
         nothing to draw -- but it is counted on the stack rather than dropped
         quietly, because a diagram that lost edges while looking tidier is the
         failure mode this whole module could most plausibly have. */
      stacks.get(source).data.internalEdges += 1
      continue
    }

    const pair = `${source}->${target}`
    const existing = merged.get(pair)
    if (existing) {
      existing.data.count += 1
      existing.data.aggregated.push(edge.id)
      continue
    }

    const created = {
      ...edge,
      id: `${AGGREGATE_PREFIX}${pair}`,
      source,
      target,
      /* Not deletable: one click would delete every real edge underneath it, and
         the thing clicked is not any one of them. Expand the group and delete the
         edge that is actually meant. */
      deletable: false,
      data: { ...(edge.data ?? {}), count: 1, aggregated: [edge.id] },
    }
    merged.set(pair, created)
    outEdges.push(created)
  }

  return { nodes: outNodes, edges: outEdges }
}

function buildStack({ stackId, key, kind, type, parentId, members }) {
  const sorted = [...members].sort(byName)

  /* The bounding-box corner of the members, which makes one invariant hold for
     free: the stack's own `extent: 'parent'` clamp keeps it inside the zone, and
     since no member sits above or left of this corner, translating them all by the
     stack's clamped delta cannot push one out through the zone's top or left edge.

     The clamp below is the last one left on the canvas -- components and sub-zones both
     shed theirs, so that they can be moved between products and out onto the working
     area. A stack keeps it for two reasons. It is a *reading* of the diagram rather than
     a component, and `onNodeDragStop` deliberately does not reparent one (which zone
     forty destinations belong to is not a question one drop can answer). And without the
     clamp the invariant above goes with it: an unclamped drag up or left gives a member
     a negative position, and `growZones` only ever grows down and right, so the member
     would render outside the backdrop of the zone it is still a child of. Expand the
     group to move its members somewhere else. */
  const position = {
    x: Math.min(...sorted.map((member) => member.position?.x ?? 0)),
    y: Math.min(...sorted.map((member) => member.position?.y ?? 0)),
  }

  return {
    id: stackId,
    type: 'groupStack',
    position,
    ...(parentId ? { parentId, extent: 'parent' } : {}),
    ...groupStackSize(sorted.length),
    draggable: true,
    /* Neither selectable nor deletable, because neither could be written back: the
       id exists only in this view, so React Flow's change for it would be applied
       to a document that has never heard of it and silently dropped. A stack that
       could be selected but never showed a selection ring would look broken. */
    selectable: false,
    deletable: false,
    /* The same z as the components it stands in for. A stack is a component as far as the
       canvas is concerned, and one at a lower z would be a folded group of forty that a
       zone dragged over it could not be clicked out of. */
    zIndex: COMPONENT_Z,
    data: {
      key,
      kind,
      type,
      count: sorted.length,
      members: sorted.map((member) => ({
        id: member.id,
        name: member.data?.name ?? member.id,
        kind: member.data?.kind ?? kind,
        bound: member.data?.bound !== false,
      })),
      memberIds: sorted.map((member) => member.id),
      paths: mergePaths(sorted),
      internalEdges: 0,
    },
  }
}

/**
 * React Flow position changes on a stack, rewritten onto the members it stands for.
 *
 * Without this a collapsed group could not be moved at all: the change carries the
 * stack's id, `applyNodeChanges` finds nothing to apply it to, and the node springs
 * back to where the members still are. Translating by the delta rather than
 * assigning positions is what keeps the members' arrangement -- expanding the group
 * again has to give back the layout the user built, moved.
 *
 * @param changes    what React Flow emitted
 * @param viewNodes  the collapsed view, which is where the stack's current position is
 * @param docNodes   the document's nodes, which is where the members' positions are
 */
export function translateGroupDrag(changes, viewNodes, docNodes) {
  const list = changes ?? []
  if (!list.some((change) => change.type === 'position' && isGroupStackId(change.id))) return list

  const view = new Map((viewNodes ?? []).map((node) => [node.id, node]))
  const doc = new Map((docNodes ?? []).map((node) => [node.id, node]))
  const out = []

  for (const change of list) {
    if (change.type !== 'position' || !isGroupStackId(change.id)) {
      out.push(change)
      continue
    }

    const stack = view.get(change.id)
    if (!stack) continue

    const delta = change.position
      ? {
          x: change.position.x - (stack.position?.x ?? 0),
          y: change.position.y - (stack.position?.y ?? 0),
        }
      : null

    for (const id of stack.data?.memberIds ?? []) {
      const member = doc.get(id)
      if (!member) continue
      out.push({
        id,
        type: 'position',
        dragging: change.dragging,
        /* The drag-stop change carries no position, only `dragging: false`. Passing
           it through unpositioned is what clears the members' dragging flag;
           dropping it would leave them rendering as mid-drag for good. */
        ...(delta
          ? {
              position: {
                x: (member.position?.x ?? 0) + delta.x,
                y: (member.position?.y ?? 0) + delta.y,
              },
            }
          : {}),
      })
    }
  }

  return out
}

/* --- expandable internals -------------------------------------------------- */

/* A profile's sections, in the order the Segment UI shows them. Listed rather than
   read from the node so an empty profile still says what it would hold -- a
   placeholder profile with no traits yet is the normal case in a template. */
const PROFILE_SECTIONS = [
  ['identifiers', 'Identifiers'],
  ['traits', 'Traits'],
  ['events', 'Events'],
]

/*
 * Whatever the section was written as, as rows.
 *
 * Deliberately tolerant. Nothing populates these yet -- there is no endpoint
 * listing a space's profile sources, and putting a real profile in a diagram that
 * gets exported to PDF would put customer PII in a slide deck -- so they are
 * hand-authored or seeded by a template, and both shapes turn up.
 */
function asRows(value) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      entry && typeof entry === 'object'
        ? { id: entry.id ?? entry.key ?? entry.name ?? `row:${index}`, label: entry.name ?? entry.label ?? entry.key ?? entry.id ?? '' }
        : { id: `row:${index}`, label: String(entry) },
    )
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, entry]) => ({
      id: key,
      label: typeof entry === 'string' ? `${key}: ${entry}` : key,
    }))
  }
  return []
}

/**
 * A component's expandable internals: the Identity Resolver's buckets, a profile's
 * identifiers / traits / events.
 *
 * These are internals, not sub-zones. A third and fourth level of nesting would mean
 * re-sizing every ancestor on every child drag, and neither is a region you drop
 * components into -- they are what one component decided to do.
 * Which sections a kind has comes from the topology (`buckets`, `expandable`), so
 * adding one is a server-side edit like every other rule in this app.
 */
export function internalSections(data, topology) {
  const spec = topology?.kinds?.[data?.kind]
  if (!spec) return []

  if (Array.isArray(spec.buckets)) {
    return spec.buckets.map((bucket) => ({
      id: bucket,
      label: humanise(bucket),
      rows: asRows(data?.buckets?.[bucket]),
    }))
  }

  if (spec.expandable) {
    return PROFILE_SECTIONS.map(([field, label]) => ({
      id: field,
      label,
      rows: asRows(data?.[field]),
    }))
  }

  return []
}
