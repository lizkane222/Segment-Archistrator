/*
 * "Visualize all": a whole workspace as one readable diagram.
 *
 * `buildLayout`'s own fallback puts every kind in a single column, which is fine for a template's
 * dozen components and unreadable for a real workspace -- three hundred destinations stack into a
 * column tens of thousands of pixels tall. This lays each pipeline stage out as a grid instead,
 * wrapping at a row count chosen from the largest stage so the result is roughly as wide as it is
 * tall, and orders cards so related ones sit together: a destination next to the source it hangs
 * off, an audience next to its space.
 *
 * Pure: it returns a stored-graph shape (zone-local positions, zones with geometry) that the
 * ordinary `replace` path renders as-is.
 */

import { groupKey } from './grouping.js'
import { NODE_HEIGHT, NODE_WIDTH, ROW_GAP, ZONE_GAP, ZONE_PADDING_BOTTOM, ZONE_PADDING_TOP, ZONE_PADDING_X } from './layout.js'

/* Left to right, the order data moves in. A kind not listed gets a stage of its own after these. */
const STAGES = [
  ['source'],
  ['source_function', 'source_insert_function'],
  ['destination_filter'],
  ['destination_insert_function'],
  ['destination_function'],
  ['destination'],
  ['warehouse'],
  ['reverse_etl_model'],
  ['space'],
  ['computed_trait'],
  ['audience'],
  ['journey'],
]

const SUB_COLUMN_GAP = 24
const STAGE_GAP = 120
const MIN_ROWS = 6
const MAX_ROWS = 24
const ROW_PITCH = NODE_HEIGHT + ROW_GAP

/* The products a workspace's components are filed under, in reading order. Connections spans the
   top; the rest sit side by side beneath it. */
const CONTAINER = 'segment'

export function rowsFor(largestStage) {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.ceil(Math.sqrt(largestStage * 1.2))))
}

const byName = (a, b) =>
  String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' })

function stageIndexOf(kind, extra) {
  const index = STAGES.findIndex((kinds) => kinds.includes(kind))
  if (index >= 0) return index
  if (!extra.has(kind)) extra.set(kind, STAGES.length + extra.size)
  return extra.get(kind)
}

/*
 * The order cards are read in.
 *
 * A card that belongs to something else -- a destination to its source, a model to its warehouse
 * source, a trait or audience to its space -- sorts by its owner's position first, so filling the
 * grid column by column keeps each owner's dependents in one block. Then by type, then name.
 */
function ordered(nodes) {
  const sources = nodes.filter((n) => n.kind === 'source').sort(compareByType)
  const sourceIndex = new Map(sources.map((n, i) => [n.segmentId, i]))
  const spaces = nodes.filter((n) => n.kind === 'space').sort(byName)
  const spaceIndex = new Map(spaces.map((n, i) => [n.segmentId, i]))

  const anchor = (node) => {
    if (node.sourceId && sourceIndex.has(node.sourceId)) return sourceIndex.get(node.sourceId)
    if (node.spaceId && spaceIndex.has(node.spaceId)) return spaceIndex.get(node.spaceId)
    return Number.MAX_SAFE_INTEGER
  }

  return (list) =>
    [...list].sort((a, b) => anchor(a) - anchor(b) || compareByType(a, b))
}

function compareByType(a, b) {
  return String(groupKey(a).key).localeCompare(String(groupKey(b).key)) || byName(a, b)
}

/* One zone's components as a grid of stages. Positions are zone-local. */
function layZone(nodes, rows, sort) {
  const extra = new Map()
  const stages = new Map()
  for (const node of nodes) {
    const index = stageIndexOf(node.kind, extra)
    if (!stages.has(index)) stages.set(index, [])
    stages.get(index).push(node)
  }

  const placed = []
  let x = ZONE_PADDING_X
  let usedRows = 0
  for (const index of [...stages.keys()].sort((a, b) => a - b)) {
    const items = sort(stages.get(index))
    const columns = Math.ceil(items.length / rows)
    items.forEach((node, i) => {
      const column = Math.floor(i / rows)
      const row = i % rows
      placed.push({
        ...node,
        position: {
          x: x + column * (NODE_WIDTH + SUB_COLUMN_GAP),
          y: ZONE_PADDING_TOP + row * ROW_PITCH,
        },
      })
    })
    usedRows = Math.max(usedRows, Math.min(rows, items.length))
    x += columns * NODE_WIDTH + (columns - 1) * SUB_COLUMN_GAP + STAGE_GAP
  }

  const width = x - STAGE_GAP + ZONE_PADDING_X
  const height = ZONE_PADDING_TOP + usedRows * ROW_PITCH - ROW_GAP + ZONE_PADDING_BOTTOM
  return { nodes: placed, width, height }
}

/**
 * A workspace graph -> a diagram, ready for `replace`.
 *
 * @param graph     `/api/workspace/graph` output: `{nodes, edges}`
 * @param topology  `/api/meta/topology`, for the zones' labels and nesting
 */
export function visualizeWorkspace(graph, topology) {
  const zoneSpecs = new Map((topology?.zones ?? []).map((zone) => [zone.id, zone]))
  const all = (graph?.nodes ?? []).filter((node) => node?.id)
  const sort = ordered(all)

  const byZone = new Map()
  const loose = []
  for (const node of all) {
    if (node.zone && zoneSpecs.has(node.zone) && node.zone !== CONTAINER) {
      if (!byZone.has(node.zone)) byZone.set(node.zone, [])
      byZone.get(node.zone).push(node)
    } else {
      loose.push({ ...node, zone: null })
    }
  }

  const largest = Math.max(
    1,
    ...[...byZone.values()].flatMap((nodes) => {
      const counts = new Map()
      for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)
      return [...counts.values()]
    }),
  )
  const rows = rowsFor(largest)

  const laid = new Map()
  for (const [zoneId, nodes] of byZone) laid.set(zoneId, layZone(nodes, rows, sort))

  /* Connections across the top when present, every other product beside each other below it, in
     the topology's own order. */
  const zoneOrder = [...byZone.keys()].sort(
    (a, b) => (zoneSpecs.get(a).order ?? 0) - (zoneSpecs.get(b).order ?? 0),
  )
  const head = zoneOrder.includes('connections') ? ['connections'] : zoneOrder.slice(0, 1)
  const rest = zoneOrder.filter((id) => !head.includes(id))

  const insideContainer = zoneSpecs.has(CONTAINER)
  const origin = insideContainer ? { x: ZONE_PADDING_X, y: ZONE_PADDING_TOP } : { x: 0, y: 0 }
  const zones = []
  let bottom = origin.y
  let right = origin.x

  for (const zoneId of head) {
    const box = laid.get(zoneId)
    zones.push(zoneOf(zoneSpecs.get(zoneId), origin, box, insideContainer))
    bottom = origin.y + box.height + ZONE_GAP
    right = Math.max(right, origin.x + box.width)
  }
  let x = origin.x
  let rowBottom = bottom
  for (const zoneId of rest) {
    const box = laid.get(zoneId)
    zones.push(zoneOf(zoneSpecs.get(zoneId), { x, y: bottom }, box, insideContainer))
    x += box.width + ZONE_GAP
    right = Math.max(right, x - ZONE_GAP)
    rowBottom = Math.max(rowBottom, bottom + box.height + ZONE_GAP)
  }

  if (insideContainer && zones.length) {
    const container = zoneSpecs.get(CONTAINER)
    zones.unshift({
      ...withoutGeometry(container),
      parent: null,
      position: { x: 0, y: 0 },
      width: right + ZONE_PADDING_X,
      height: rowBottom - ZONE_GAP + ZONE_PADDING_BOTTOM,
    })
  }

  const containerHeight = zones[0]?.height ?? 0
  const nodes = [
    ...[...laid.values()].flatMap((box) => box.nodes),
    ...loose.map((node, i) => ({
      ...node,
      position: { x: i * (NODE_WIDTH + SUB_COLUMN_GAP), y: containerHeight + ZONE_GAP },
    })),
  ]

  const present = new Set(nodes.map((node) => node.id))
  const edges = (graph?.edges ?? []).filter(
    (edge) => present.has(edge.source) && present.has(edge.target),
  )

  return { nodes, edges, zones, scenarios: [] }
}

function withoutGeometry({ position, width, height, ...spec }) {
  return spec
}

function zoneOf(spec, position, box, insideContainer) {
  return {
    ...withoutGeometry(spec),
    parent: insideContainer ? CONTAINER : null,
    position,
    width: box.width,
    height: box.height,
  }
}
