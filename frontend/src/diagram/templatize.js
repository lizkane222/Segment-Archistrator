/*
 * Turning a diagram into a template: which of this workspace's own data comes along.
 *
 * A diagram drawn against a workspace carries that workspace in it -- the names it gave its
 * sources, their ids, links into its console, masked write keys, each component's settings. A
 * template made from it is useful to other workspaces only once that is gone, and useful to this
 * one only while it is kept. So the person chooses, per component and per kind of data, and this
 * module is the whole of what that choice does. Pure, so it is tested rather than clicked through.
 *
 * ## One selection, two meanings
 *
 * The grid has a set of ticked cells and a `mode`. In `remove` mode a tick means "take this out";
 * in `keep` mode it means "this stays, everything else goes". The ticks are the same set either
 * way and `removedCells` is the only place that reads them -- so the dialog's wording, its summary
 * and the result cannot disagree about which way round it is.
 *
 * ## What "generic" means
 *
 * A template is generic when no component still carries a workspace *identity*: a resource id, a
 * link into the workspace, a write key. That is the same test the server runs on save
 * (`carries_workspace_identity`), and the server's answer is the one that counts -- it locks the
 * template to the saving workspace, however the client describes it. Names and settings do not
 * lock a template: they are what someone chose to keep.
 *
 * A removed name falls back to what the component *is*: the name the template it was bound from
 * gave it, else its kind's own label ("Source", "Destination").
 */

import { labelForKind } from '../canvas/kinds.js'

/* Keys that say "this is a particular resource in a particular workspace". Mirrors
   WORKSPACE_IDENTITY_KEYS in apps/diagrams/models.py. */
export const IDENTITY_KEYS = [
  'segmentId',
  'sourceId',
  'destinationId',
  'spaceId',
  'workspaceUrl',
  'previewWebhookUrl',
  'writeKeyMasked',
  'writeKeyLast4',
]

/*
 * The columns of the grid. `keys` are exactly the node fields a column owns, and nothing outside
 * every column's `keys` is ever touched: position, style, zone, kind, slug, categories, docs link
 * and the `binds` hint are what the *template* is made of and always stay.
 */
export const COLUMNS = [
  {
    id: 'name',
    label: 'Name',
    hint: "The workspace's own name for it. Falls back to what the component is.",
    keys: ['name', 'nameRich'],
  },
  {
    id: 'description',
    label: 'Description',
    hint: 'Free text describing this component in this workspace.',
    keys: ['description'],
  },
  {
    id: 'ids',
    label: 'Resource IDs',
    hint: 'Ties the component to a real resource. Without it the component becomes a placeholder to bind.',
    keys: ['segmentId', 'sourceId', 'destinationId', 'spaceId'],
    identity: true,
  },
  {
    id: 'links',
    label: 'Workspace links',
    hint: "Links into this workspace's console and preview URLs.",
    keys: ['workspaceUrl', 'linkVerified', 'previewWebhookUrl'],
    identity: true,
  },
  {
    id: 'keys',
    label: 'Write keys',
    hint: 'The masked write key shown on a source.',
    keys: ['writeKeyMasked', 'writeKeyLast4'],
    identity: true,
  },
  {
    id: 'config',
    label: 'Settings & config',
    hint: 'Enabled state, labels, tracking plan, audience and journey definitions, function code and settings.',
    keys: [
      'enabled',
      'status',
      'labels',
      'trackingPlanId',
      'deployedAt',
      'actions',
      'condition',
      'query',
      'audienceKey',
      'audienceType',
      'computeCadence',
      'definitionType',
      'includeAnonymousUsers',
      'includeHistoricalData',
      'scheduleStrategy',
      'size',
      'traitKey',
      'steps',
      'raw',
      'functionSettings',
      'code',
      'checklist',
    ],
  },
]

/* The one row that is not a component. Saved walkthrough paths carry example events someone typed
   against this workspace, so they get a cell of their own. */
export const PATHS_ROW = '__paths__'

const cellKey = (nodeId, columnId) => `${nodeId}|${columnId}`
export { cellKey }

/* A flat document node keeps its fields on itself; a fixture-shaped one under `data`. */
const fieldsOf = (node) => (node?.data && typeof node.data === 'object' ? node.data : node)

const present = (value) =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)

function preview(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (value && typeof value === 'object') return '{…}'
  const text = String(value)
  return text.length > 28 ? `${text.slice(0, 27)}…` : text
}

/** The first value a column holds on a node, for the grid to show; null when it holds none. */
function columnValue(fields, column) {
  for (const key of column.keys) {
    if (present(fields[key])) {
      /* `linkVerified: true` alone is not worth a cell: it only means something beside a link. */
      if (key === 'linkVerified' && !present(fields.workspaceUrl)) continue
      return preview(fields[key])
    }
  }
  return null
}

/**
 * The grid: one row per component, one cell per column, each saying whether the component has
 * anything there to keep or remove. A cell with nothing in it is shown as empty and cannot be
 * ticked, because ticking it would be a choice about nothing.
 */
export function buildMatrix(graph, topology) {
  const rows = (graph?.nodes ?? []).map((node) => {
    const fields = fieldsOf(node)
    return {
      nodeId: node.id,
      kind: fields.kind,
      label: fields.name || labelForKind(topology, fields.kind),
      kindLabel: labelForKind(topology, fields.kind),
      bound: Boolean(fields.bound && fields.segmentId),
      cells: Object.fromEntries(
        COLUMNS.map((column) => [column.id, columnValue(fields, column)]),
      ),
    }
  })
  return {
    rows,
    columns: COLUMNS.filter((column) => rows.some((row) => row.cells[column.id] !== null)),
    paths: (graph?.scenarios ?? []).length,
  }
}

/** Every cell that has something in it -- what "select all" means. */
export function allCells(matrix) {
  const out = new Set()
  for (const row of matrix.rows) {
    for (const column of matrix.columns) {
      if (row.cells[column.id] !== null) out.add(cellKey(row.nodeId, column.id))
    }
  }
  if (matrix.paths) out.add(cellKey(PATHS_ROW, 'paths'))
  return out
}

/**
 * The cells that will be taken out, given what is ticked and which way round the tick means.
 *
 * Only cells that hold something count, so the same ticks over a grid with empty cells in it
 * cannot make a "remove" of nothing look like a removal.
 */
export function removedCells(matrix, selected, mode) {
  const everything = allCells(matrix)
  if (mode === 'keep') return new Set([...everything].filter((key) => !selected.has(key)))
  return new Set([...everything].filter((key) => selected.has(key)))
}

/** Flip the meaning without changing the outcome: what was ticked becomes what is not. */
export function invertSelection(matrix, selected) {
  return new Set([...allCells(matrix)].filter((key) => !selected.has(key)))
}

function fallbackName(fields, topology) {
  return (
    fields.templateName ||
    fields.placeholder?.name ||
    labelForKind(topology, fields.kind)
  )
}

/**
 * The graph a template is made from. Never mutates its input -- the diagram on the canvas and the
 * JSON export are both made from the original, which keeps every field.
 */
export function applyTemplatize(graph, removed, { topology } = {}) {
  const next = JSON.parse(JSON.stringify(graph ?? { nodes: [], edges: [] }))
  const idMap = new Map()
  const unbound = new Set()

  next.nodes = (next.nodes ?? []).map((node, index) => {
    const fields = fieldsOf(node)
    const dropped = COLUMNS.filter((column) => removed.has(cellKey(node.id, column.id)))
    if (!dropped.length) return node

    const target = fields
    const original = { ...fields }
    for (const column of dropped) {
      for (const key of column.keys) delete target[key]
    }
    const gone = new Set(dropped.map((column) => column.id))

    if (gone.has('name')) target.name = fallbackName(original, topology)
    if (gone.has('description')) target.description = original.placeholder?.description ?? ''

    if (gone.has('ids')) {
      /* No resource behind it any more, so it is something to bind -- exactly what a component of
         a built-in template is. The pre-binding stash is dropped: it has served its purpose and
         would otherwise let "unbind" restore the data that was just removed. */
      target.bound = false
      target.bindable = true
      target.binds = original.binds ?? { kind: original.kind }
      delete target.placeholder
      delete target.templateName
      /* The canvas id embeds the resource id (`source:src_123`), so it would leak it. */
      if (original.segmentId && String(node.id).includes(original.segmentId)) {
        idMap.set(node.id, `${original.kind}:tpl${index + 1}`)
      }
      unbound.add(node.id)
    }
    return node
  })

  if (removed.has(cellKey(PATHS_ROW, 'paths'))) delete next.scenarios

  /* An edge that was read from the workspace cannot be deleted on the canvas; once either end is
     only a placeholder it is a line somebody drew. */
  next.edges = (next.edges ?? []).map((edge) =>
    unbound.has(edge.source) || unbound.has(edge.target) ? { ...edge, discovered: false } : edge,
  )

  if (!idMap.size) return next
  /* Ids are referenced from edges, zones, scenarios and collapsed groups; a text replace is the
     only rewrite that cannot miss one. The ids are unique strings with a kind prefix. */
  let text = JSON.stringify(next)
  for (const [from, to] of idMap) text = text.split(JSON.stringify(from)).join(JSON.stringify(to))
  return JSON.parse(text)
}

/** Does anything in this graph still say which workspace it came from? Same test as the server's. */
export function carriesWorkspaceIdentity(graph) {
  return (graph?.nodes ?? []).some((node) => {
    const fields = fieldsOf(node)
    return IDENTITY_KEYS.some((key) => present(fields[key]))
  })
}

/** What the dialog says about the outcome, in one place. */
export function summarize(matrix, removed, graph) {
  const total = allCells(matrix).size
  return {
    removed: removed.size,
    kept: total - removed.size,
    total,
    /* Whether the template can be used from any workspace, or only the one it was made in. */
    generic: !carriesWorkspaceIdentity(graph),
  }
}
