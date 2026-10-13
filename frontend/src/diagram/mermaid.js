/*
 * A diagram <-> a Mermaid flowchart, in both directions.
 *
 * ## Two audiences, one file
 *
 * A Mermaid export has to be two things at once. It has to be a *flowchart*: something that renders
 * in GitHub, Notion, a Markdown README or mermaid.live and looks like the diagram it came from --
 * zones as nested subgraphs, each component in its kind's shape and colours, connectors dashed and
 * coloured the way they are here. And it has to *come back*: imported into this app, it should be
 * the same document, not a re-drawing of it.
 *
 * Mermaid can say the first thing and cannot say most of the second. It has no positions, no sizes,
 * no idea which side of a box a line leaves from, no hand-placed bends, no walkthrough scenarios and
 * no binding to a workspace. So the export is a readable flowchart with a single `%% segment-builder:`
 * comment line at the bottom, carrying everything Mermaid has no syntax for. Mermaid ignores
 * comments, so the flowchart renders exactly as if it were not there; this file reads it back.
 *
 * ## The Mermaid wins
 *
 * On import, the visible flowchart is the source of truth and the comment only fills in what it
 * cannot express. That is the whole point of exporting to a text format: someone will edit it. A
 * node renamed in the Mermaid comes back renamed; one moved into another subgraph comes back in that
 * zone; a link deleted from the text is gone; a new node someone typed in arrives as a new component
 * and is laid out beside its neighbours. What the comment holds for a node that has since been
 * deleted is simply never read.
 *
 * And an import with no comment at all -- a flowchart someone wrote by hand, or one from another
 * tool -- still works: kinds are inferred from the labels and subgraphs (a subgraph called
 * "Connections" is the Connections zone; a node called "Snowflake" in it is a warehouse), shapes and
 * colours are taken from the Mermaid, and the whole thing is laid out along the flowchart's
 * direction.
 *
 * ## Ids
 *
 * The app's ids are not Mermaid ids -- `ph:source-web`, `manual:destination:ab12cd` and
 * `connections~2` all contain characters Mermaid reads as syntax. So each gets a short Mermaid-safe
 * alias derived from it (`ph_source_web`), and the comment maps the aliases back. A node typed into
 * the Mermaid by hand has no mapping and gets a fresh `manual:` id, exactly like a palette drop.
 */

import { KIND_STYLES, ZONE_STYLES, labelForKind, styleFor, zoneStyleFor } from '../canvas/kinds.js'
import { zoneProductOf } from '../canvas/frames.js'
import { zoneNodeId } from '../canvas/layout.js'
import { zoneOfParent } from '../canvas/rules.js'
import { richToText } from '../canvas/richText.js'
import { tableText } from '../canvas/tables.js'
import { DROPPED_STYLE } from '../canvas/dropDefaults.js'
import { codeSeed } from '../functions/defaults.js'
import { layoutMermaidGraph } from './mermaidLayout.js'
import { parseMermaid } from './mermaidParse.js'

/* The marker on the one comment line this file owns. Versioned, so a newer build can change what it
   carries and an older one can tell it is looking at something it does not understand. */
export const MERMAID_META_PREFIX = 'segment-builder:'
export const MERMAID_META_VERSION = 1

/* --- the visual vocabulary ------------------------------------------------------------------- */

/*
 * A component's Mermaid shape, from the CSS shape its kind draws with (see SHAPES in kinds.js).
 *
 * `notched` -- the processing steps, functions and filters and mappings -- becomes a subroutine box,
 * the Mermaid shape that already means "a step that does something to what passes through it".
 * Warehouses and Reverse ETL models are the one exception to "by CSS shape": they are square here,
 * but every reader of a flowchart knows a cylinder is a database, and that is what they are.
 */
const KIND_MERMAID_SHAPE = {
  warehouse: 'cylinder',
  reverse_etl_model: 'cylinder',
  sql_table: 'cylinder',
}

const CSS_TO_MERMAID = {
  rounded: 'round',
  pill: 'stadium',
  sharp: 'rect',
  notched: 'subroutine',
}

/* A drawn shape's Mermaid equivalent, where Mermaid has one. Anything else is a plain box. */
const DRAWN_TO_MERMAID = {
  rectangle: 'rect',
  square: 'rect',
  circle: 'circle',
  ellipse: 'stadium',
  diamond: 'diamond',
  hexagon: 'hexagon',
  cylinder: 'cylinder',
  database: 'cylinder',
  flag: 'flag',
  chevron: 'lean-right',
  document: 'rect',
  cloud: 'round',
}

/* The reverse: a hand-written Mermaid shape, as a drawn shape when it is plainly a picture rather than
   a component (a circle, a diamond -- a flowchart's decision point). */
const MERMAID_TO_DRAWN = {
  circle: 'circle',
  'double-circle': 'circle',
  diamond: 'diamond',
  hexagon: 'hexagon',
  triangle: 'triangle',
  document: 'document',
  documents: 'documents',
  cloud: 'cloud',
}

const MERMAID_TO_CSS = {
  round: 'rounded',
  stadium: 'pill',
  rect: 'sharp',
  subroutine: 'notched',
  cylinder: 'sharp',
}

const BRACKETS = {
  rect: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  'double-circle': ['(((', ')))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  'lean-right': ['[/', '/]'],
  'lean-left': ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'],
  'trapezoid-alt': ['[\\', '/]'],
  flag: ['>', ']'],
}

/* The Mermaid shapes with no bracket form, written with the newer `@{ shape: }` syntax instead. */
const NAMED_ONLY = { triangle: 'tri', document: 'doc', documents: 'docs', cloud: 'cloud' }

/* Zone backdrops as concrete colours. kinds.js keeps them as CSS variables, which a browser resolves
   and Mermaid cannot -- so the values are restated here, and tokens.css is the place to look if they
   ever disagree. */
const ZONE_COLOURS = {
  segment: { fill: '#f8f9fb', stroke: '#121c2d' },
  connections: { fill: '#e4f7ff', stroke: '#0263e0' },
  protocols: { fill: '#ffffff', stroke: '#0f7c8a' },
  unify: { fill: '#f3ecff', stroke: '#6f42c1' },
  engage: { fill: '#fdeced', stroke: '#db131a' },
}
const SUB_ZONE_PARENT = {
  sources: 'connections',
  destinations: 'connections',
  warehouses: 'connections',
  linked_events: 'connections',
  profile_sources: 'unify',
  profiles: 'unify',
  identity_settings: 'unify',
  computations: 'engage',
  debugger: 'engage',
  linked_audiences: 'engage',
}

function zoneColours(zone) {
  const product = zoneProductOf(zone.id)
  const resolved = zoneStyleFor(zone)
  const stock = ZONE_COLOURS[product] ?? (SUB_ZONE_PARENT[product] && {
    fill: '#ffffff',
    stroke: ZONE_COLOURS[SUB_ZONE_PARENT[product]].stroke,
  })
  const fill = concrete(zone.style?.bg) ?? (zone.color ? blend(zone.color, 0.06) : null) ?? stock?.fill ?? '#f6f7f9'
  const stroke = concrete(zone.style?.border) ?? concrete(zone.color) ?? stock?.stroke ?? '#606b85'
  return {
    fill,
    stroke,
    dashed: (resolved.borderStyle ?? 'dashed') !== 'solid',
    width: resolved.borderWidth ?? 2,
  }
}

/* A colour Mermaid can use: a hex or an rgb()/named colour, never a `var(--...)` it cannot resolve. */
function concrete(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('var(')) return null
  return value.trim()
}

/* A tint as an opaque hex, because Mermaid's subgraph fill composes badly with alpha. */
function blend(hex, alpha) {
  const match = /^#([\da-f]{6})$/i.exec(String(hex).trim())
  if (!match) return null
  const int = parseInt(match[1], 16)
  const mix = (channel) => Math.round(255 - (255 - channel) * alpha)
  const out = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map(mix)
  return `#${out.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/* --- ids --------------------------------------------------------------------------------------- */

/* Words Mermaid reads as keywords when they stand alone as an id. */
const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'style', 'linkstyle', 'click', 'direction', 'default'])

function aliasBase(id) {
  let base = String(id)
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  if (!base) base = 'n'
  if (/^\d/.test(base) || RESERVED.has(base.toLowerCase())) base = `n_${base}`
  /* `o`/`x` straight after a link's dashes are arrowheads, so an id that *is* one of them would make
     `a --- x` read as an `--x` link. Rarer than it sounds, and cheap to rule out. */
  if (/^[ox]$/i.test(base)) base = `n_${base}`
  return base
}

/** Mermaid-safe aliases for every id, unique across nodes and subgraphs together. */
function assignAliases(ids) {
  const used = new Set()
  const out = new Map()
  for (const id of ids) {
    const base = aliasBase(id)
    let alias = base
    for (let n = 2; used.has(alias.toLowerCase()); n++) alias = `${base}_${n}`
    used.add(alias.toLowerCase())
    out.set(id, alias)
  }
  return out
}

/* --- labels ------------------------------------------------------------------------------------ */

/** Text as a quoted Mermaid label: quotes and the characters Mermaid would read as markup escaped. */
function quote(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\|/g, '#124;')
    .replace(/\r?\n/g, '<br>')
  return `"${escaped}"`
}

/* What a node is called on a flowchart. A table's name is its cells; a shape's may be rich text. */
function nodeLabel(node) {
  if (node.kind === 'table') return node.name || tableText(node.table) || 'Table'
  const name = node.name || (node.nameRich ? richToText(node.nameRich) : '')
  return name || labelForKind(null, node.kind) || 'Untitled'
}

/* --- export ------------------------------------------------------------------------------------ */

/*
 * Mermaid's direction, from the layout of the diagram itself: wider than it is tall reads
 * left-to-right, which is how every Segment template is drawn. Overridable, because a reader exporting
 * for a narrow page may want the stack.
 */
function directionFor(graph) {
  const nodes = graph.nodes ?? []
  const xs = nodes.map((node) => node.position?.x ?? 0)
  const ys = nodes.map((node) => node.position?.y ?? 0)
  if (nodes.length < 2) return 'LR'
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  return height > width * 1.25 ? 'TB' : 'LR'
}

/* Only the id is left out of a node's stored copy. `name` and `zone` are said by the Mermaid too, and
   are kept anyway: comparing them with what the Mermaid now says is how an import tells a node that
   was renamed or moved from one that was not. */
const SAID_IN_MERMAID = new Set(['id'])

/* Edge fields the visible link line already carries. */
const EDGE_SAID = new Set(['id', 'source', 'target', 'label', 'strokeStyle', 'arrowStart', 'arrowEnd', 'color'])

/**
 * A saved document -> Mermaid flowchart text.
 *
 * @param graph  the `serializeGraph` document -- what a save stores, nothing React Flow owns
 * @param meta   `{name, description, sourceTemplate}`, written into front matter and the comment so an
 *   import can restore the title as well as the drawing
 * @param options.direction  `'LR'`, `'TB'`, ... -- defaults to whichever the diagram's own shape suggests
 * @param options.embed  write the round-trip comment (default true). Off gives a plain flowchart for
 *   pasting somewhere a reader would only be confused by a line of JSON.
 */
export function graphToMermaid(graph, meta = {}, { direction, embed = true } = {}) {
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const zones = graph?.zones ?? []
  const flow = direction ?? directionFor(graph ?? {})

  const zoneIds = new Set(zones.map((zone) => zone.id))
  const aliases = assignAliases([...zones.map((zone) => zone.id), ...nodes.map((node) => node.id)])
  /* A loose end has no node to point at, so it gets a point of its own -- a tiny invisible-ish stub
     that keeps the link drawable in Mermaid, and is dropped again on import. */
  const stubs = []

  const lines = []
  const name = meta.name?.trim()
  if (name) lines.push('---', `title: ${quote(name)}`, '---')
  lines.push(`flowchart ${flow}`)

  /* Zones as a tree, children in their declared order. A zone whose parent is not in the document is a
     root, the same rule buildLayout applies. */
  const children = new Map()
  for (const zone of [...zones].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const parent = zone.parent && zoneIds.has(zone.parent) ? zone.parent : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(zone)
  }
  const members = new Map()
  for (const node of nodes) {
    const zone = node.zone && zoneIds.has(node.zone) ? node.zone : null
    if (!members.has(zone)) members.set(zone, [])
    members.get(zone).push(node)
  }

  const classes = new Map()
  const nodeStyles = []

  const writeNode = (node, indent) => {
    const alias = aliases.get(node.id)
    const shape = mermaidShapeFor(node)
    const label = quote(nodeLabel(node))
    const decl = NAMED_ONLY[shape]
      ? `${alias}@{ shape: ${NAMED_ONLY[shape]}, label: ${label} }`
      : `${alias}${BRACKETS[shape][0]}${label}${BRACKETS[shape][1]}`
    const cls = classFor(node)
    if (cls && !classes.has(cls.name)) classes.set(cls.name, cls.style)
    lines.push(`${indent}${decl}${cls ? `:::${cls.name}` : ''}`)
    const own = nodeStyle(node)
    if (own) nodeStyles.push(`style ${alias} ${own}`)
  }

  const visited = new Set()
  const writeZone = (zone, depth) => {
    if (visited.has(zone.id)) return
    visited.add(zone.id)
    const indent = '  '.repeat(depth)
    lines.push(`${indent}subgraph ${aliases.get(zone.id)}[${quote(zone.label || zone.id)}]`)
    for (const node of members.get(zone.id) ?? []) writeNode(node, `${indent}  `)
    for (const child of children.get(zone.id) ?? []) writeZone(child, depth + 1)
    lines.push(`${indent}end`)
  }

  for (const zone of children.get(null) ?? []) writeZone(zone, 1)
  /* A cycle in the parent links leaves zones nothing reached; written at the top level rather than lost. */
  for (const zone of zones) if (!visited.has(zone.id)) writeZone(zone, 1)
  for (const node of members.get(null) ?? []) writeNode(node, '  ')

  const linkStyles = []
  const known = new Set([...nodes.map((node) => node.id), ...zoneIds])
  const written = []
  edges.forEach((edge) => {
    const source = endpoint(edge, 'source')
    const target = endpoint(edge, 'target')
    if (!source || !target) return
    const label = edge.label ? `|${quote(edge.label)}|` : ''
    const [from, to] = flipped(edge) ? [target, source] : [source, target]
    lines.push(`  ${from} ${linkFor(edge)}${label} ${to}`)
    const style = edgeStyle(edge)
    if (style) linkStyles.push(`linkStyle ${written.length} ${style}`)
    written.push(edge)
  })

  for (const stub of stubs) lines.push(`  ${stub}@{ shape: sm-circ }`)

  if (classes.size || nodeStyles.length || linkStyles.length || zones.length) lines.push('')
  for (const [cls, style] of classes) lines.push(`  classDef ${cls} ${style}`)
  for (const zone of zones) {
    const colours = zoneColours(zone)
    const parts = [`fill:${colours.fill}`, `stroke:${colours.stroke}`, `stroke-width:${colours.width}px`]
    if (colours.dashed) parts.push('stroke-dasharray:6 4')
    lines.push(`  style ${aliases.get(zone.id)} ${parts.join(',')}`)
  }
  for (const style of nodeStyles) lines.push(`  ${style}`)
  for (const style of linkStyles) lines.push(`  ${style}`)

  if (embed) {
    lines.push('')
    lines.push(`  %% ${MERMAID_META_PREFIX}${JSON.stringify(metaFor())}`)
  }

  return `${lines.join('\n')}\n`

  function endpoint(edge, end) {
    const id = edge[end]
    /* A connector to a zone names the zone's *canvas* node, `zone-<id>` -- that is what React Flow
       hands `onConnect` -- so it is matched back to the subgraph that zone became. */
    if (id != null) {
      if (known.has(id)) return aliases.get(id)
      const zone = zoneOfParent(id)
      return zone && zoneIds.has(zone) ? aliases.get(zone) : null
    }
    const point = edge[`${end}Point`]
    if (!point) return null
    const stub = `loose_${aliasBase(edge.id)}_${end}`
    stubs.push(stub)
    return stub
  }

  /* The comment: whatever the flowchart could not say, keyed by the alias the flowchart uses. */
  function metaFor() {
    const aliasOf = (id) => aliases.get(id)
    return {
      v: MERMAID_META_VERSION,
      doc: {
        ...(meta.name ? { name: meta.name } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.sourceTemplate ? { sourceTemplate: meta.sourceTemplate } : {}),
      },
      nodes: Object.fromEntries(
        nodes.map((node) => [aliasOf(node.id), { id: node.id, ...omit(node, SAID_IN_MERMAID) }]),
      ),
      zones: Object.fromEntries(
        zones.map((zone) => [aliasOf(zone.id), { id: zone.id, ...omit(zone, new Set(['id'])) }]),
      ),
      /* Edges by position in the link list rather than by id: the link line has no id of its own in
         Mermaid, and "the third link" is how Mermaid itself refers to one (`linkStyle 2`). The two
         ends are kept beside it so an import can tell when the list was edited and the third link is
         no longer the same connector. */
      edges: written.map((edge) => ({
        id: edge.id,
        s: edge.source ?? null,
        t: edge.target ?? null,
        ...(flipped(edge) ? { flip: true } : {}),
        ...omit(edge, EDGE_SAID),
      })),
      ...(graph.scenarios?.length ? { scenarios: graph.scenarios } : {}),
      ...(graph.collapsed?.length ? { collapsed: graph.collapsed } : {}),
      ...(graph.viewport ? { viewport: graph.viewport } : {}),
    }
  }
}

function omit(object, keys) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) if (!keys.has(key) && value !== undefined) out[key] = value
  return out
}

function mermaidShapeFor(node) {
  if (node.kind === 'shape') return DRAWN_TO_MERMAID[node.shape] ?? 'rect'
  if (node.kind === 'table') return 'rect'
  if (KIND_MERMAID_SHAPE[node.kind]) return KIND_MERMAID_SHAPE[node.kind]
  const style = styleFor(node.kind, node.style)
  return CSS_TO_MERMAID[style.shape] ?? 'round'
}

/*
 * One `classDef` per kind, so the Mermaid reads `src_web:::source` and the colours live in one place
 * rather than on every line. The class name *is* the kind -- which is also what lets a hand-edited
 * Mermaid say "this new node is a destination" by writing `:::destination`, and have the import
 * believe it.
 */
function classFor(node) {
  if (!node.kind) return null
  const base = { ...(KIND_STYLES[node.kind] ? styleFor(node.kind) : {}) }
  if (node.kind === 'shape' || node.kind === 'table') {
    return { name: node.kind, style: 'fill:#ffffff,stroke:#354052,color:#354052,stroke-width:2px' }
  }
  const parts = [
    `fill:${concrete(base.bg) ?? '#ffffff'}`,
    `stroke:${concrete(base.border) ?? '#aebbc1'}`,
    `color:${concrete(base.text) ?? '#121c2d'}`,
    'stroke-width:1px',
  ]
  return { name: aliasBase(node.kind), style: parts.join(',') }
}

/* What this node draws that its kind's class does not: a colour the inspector set, a dashed outline. */
function nodeStyle(node) {
  const style = node.style ?? {}
  const parts = []
  if (concrete(style.bg)) parts.push(`fill:${style.bg}`)
  if (concrete(style.border)) parts.push(`stroke:${style.border}`)
  if (concrete(style.text)) parts.push(`color:${style.text}`)
  /* An unbound placeholder draws dashed unless told otherwise -- see `outlineFor`. */
  const dashed = style.borderStyle ? style.borderStyle !== 'solid' : node.bound === false
  if (dashed) parts.push(style.borderStyle === 'dotted' ? 'stroke-dasharray:2 3' : 'stroke-dasharray:5 3')
  const width = style.borderWidth ?? (node.bound === false && !style.borderStyle ? 2 : null)
  if (width && width !== 1) parts.push(`stroke-width:${width}px`)
  return parts.length ? parts.join(',') : null
}

/*
 * The link operator. Mermaid can draw an arrow at both ends or at the target end, but not at the source
 * end alone -- `<--` is not a link -- so a connector pointing only backwards is written with its ends
 * swapped, which draws the same picture, and marked `flip` in the comment so the import swaps them back.
 */
function linkFor(edge) {
  const dashed = edge.strokeStyle === 'dashed' || edge.strokeStyle === 'dotted'
  const end = edge.arrowEnd !== false
  const start = Boolean(edge.arrowStart)
  const head = start || end ? '>' : ''
  const tail = start && end ? '<' : ''
  if (dashed) return `${tail}-.-${head}`
  return `${tail}--${head || '-'}`
}

const flipped = (edge) => Boolean(edge.arrowStart) && edge.arrowEnd === false

function edgeStyle(edge) {
  const parts = []
  if (concrete(edge.color)) parts.push(`stroke:${edge.color}`)
  /* Mermaid has one dotted link; "dotted" here is finer than "dashed", so it gets its own pattern. */
  if (edge.strokeStyle === 'dotted') parts.push('stroke-dasharray:2 4')
  return parts.length ? parts.join(',') : null
}

/* --- import ------------------------------------------------------------------------------------ */

/**
 * Whether text is a Mermaid flowchart rather than a JSON export -- what lets one file picker take both.
 * Not a validation: `mermaidToGraph` is what says whether the flowchart can actually be read.
 */
export function looksLikeMermaid(text) {
  const head = String(text ?? '').trimStart()
  if (head.startsWith('{') || head.startsWith('[')) return false
  return /(^|\n)\s*(flowchart|graph)\b/i.test(head) || /```\s*mermaid/i.test(head)
}

/**
 * Mermaid flowchart text -> `{name, description, sourceTemplate, graph, warnings}`.
 *
 * `graph` is a document in the shape `serializeGraph` produces, ready for the same `applyGraph` every
 * other "open a diagram" path goes through. Throws, with a sentence a person can act on, for text that
 * is not a flowchart at all.
 *
 * @param topology  `/api/meta/topology`, when there is one: used to recognise subgraphs as Segment
 *   zones and to label components. Optional -- without it, kinds are still inferred from names.
 */
export function mermaidToGraph(text, { topology = null } = {}) {
  const parsed = parseMermaid(text)
  const meta = readMeta(parsed.comments, parsed.warnings)
  const warnings = [...parsed.warnings]

  const metaNodes = meta?.nodes ?? {}
  const metaZones = meta?.zones ?? {}

  /* Loose-end stubs from an export: a link to one is a connector loose at that end. */
  const isStub = (alias) => /^loose_.+_(source|target)$/.test(alias) && !metaNodes[alias]

  /* --- zones --- */
  const usedZoneIds = new Set()
  const zoneIdFor = new Map()
  const zones = []
  let order = 0
  for (const subgraph of parsed.subgraphs.values()) {
    const stored = metaZones[subgraph.id]
    const id = uniqueId(stored?.id ?? recogniseZone(subgraph, topology) ?? customZoneId(subgraph.id), usedZoneIds)
    zoneIdFor.set(subgraph.id, id)
  }
  for (const subgraph of parsed.subgraphs.values()) {
    const stored = metaZones[subgraph.id]
    const id = zoneIdFor.get(subgraph.id)
    const product = zoneProductOf(id)
    const known = topology?.zones?.find((zone) => zone.id === product) ?? STOCK_ZONES[product]
    const style = parsed.styles.get(subgraph.id)
    const { id: _ignored, label: _label, ...rest } = stored ?? {}
    zones.push({
      ...(stored
        ? rest
        : {
            order: order,
            description: known?.description ?? (known ? '' : 'Outside Segment'),
            docsUrl: known?.docsUrl ?? null,
            ...(known ? {} : { custom: true }),
            ...zoneStyleFromMermaid(style, product),
          }),
      id,
      ...zoneLabel(subgraph, stored, known),
      ...(subgraph.parent ? { parent: zoneIdFor.get(subgraph.parent) } : {}),
    })
    order++
  }

  /* --- nodes --- */
  const usedNodeIds = new Set()
  const nodeIdFor = new Map()
  const nodes = []
  for (const node of parsed.nodes.values()) {
    if (isStub(node.id)) continue
    const stored = metaNodes[node.id]
    const zone = node.subgraph ? zoneIdFor.get(node.subgraph) : null
    const id = uniqueId(stored?.id ?? null, usedNodeIds) ?? null
    const built = stored
      ? fromStored(node, stored, zone)
      : fromMermaid(node, zone, { parsed, topology, zones })
    const finalId = id ?? uniqueId(`manual:${built.kind}:${shortHash(node.id)}`, usedNodeIds)
    nodeIdFor.set(node.id, finalId)
    /* The two defaults `toFlowNode` fills in on open, stated here so a fresh import already *is* what
       the canvas will save -- otherwise opening it would mark it changed before anyone touched it. */
    nodes.push({ ...(stored ? {} : { collapsed: false, style: null }), ...built, id: finalId })
  }

  /* --- edges --- */
  const metaEdges = meta?.edges ?? []
  const usedEdgeIds = new Set(metaEdges.map((entry) => entry.id).filter((id) => id != null))
  /* Stored connectors already matched to a link, by object rather than id -- a transcribed template's
     connectors may all have no id. */
  const claimed = new Set()
  const edgeOrigins = new Map()
  const freshEdges = []
  const edges = []
  const defaultLinkStyle = parsed.linkStyles.get('default')
  parsed.links.forEach((link, index) => {
    if (link.kind === 'invisible') return
    const looseAt = { source: isStub(link.source), target: isStub(link.target) }
    if (looseAt.source && looseAt.target) return
    /* A subgraph as a link end is a connector to a zone, which the document names by the zone's canvas
       node id -- see `endpoint` in the export. */
    const resolve = (alias, loose) => {
      if (loose) return null
      if (nodeIdFor.has(alias)) return nodeIdFor.get(alias)
      return zoneIdFor.has(alias) ? zoneNodeId(zoneIdFor.get(alias)) : null
    }
    let source = resolve(link.source, looseAt.source)
    let target = resolve(link.target, looseAt.target)
    if ((source == null && !looseAt.source) || (target == null && !looseAt.target)) return

    /* The stored connector at this position, if it is still the same connector: the two ends are
       compared so that a link inserted or deleted earlier in the text does not hand one connector's
       bends to another. When the position does not match, any unclaimed stored connector between the
       same two ends is the next best answer. */
    const stored =
      matchStored(metaEdges[index], source, target, claimed) ??
      metaEdges.find((entry) => matchStored(entry, source, target, claimed))
    const { id: storedId, s: _s, t: _t, flip, ...extra } = stored ?? {}

    /* An arrow that only points backwards was written reversed -- see `linkFor`. Swapped back only
       while the link is still a single-headed arrow; one someone has since edited is taken as written. */
    let arrowStart = link.arrowStart
    let arrowEnd = link.arrowEnd
    if (flip && arrowEnd && !arrowStart) {
      ;[source, target] = [target, source]
      ;[looseAt.source, looseAt.target] = [looseAt.target, looseAt.source]
      arrowStart = true
      arrowEnd = false
    }

    const style = { ...(defaultLinkStyle ?? {}), ...(parsed.linkStyles.get(link.index) ?? {}) }
    const dash = style['stroke-dasharray']
    /* Mermaid has one dotted link. Ours has dashed and dotted, told apart on export by the dash
       pattern -- a short first dash is dotted. A solid link with a dash pattern is dashed too. */
    const strokeStyle =
      link.kind === 'dotted' || dash
        ? dash && /^\s*[0-3](\.\d+)?(px)?[\s,]/.test(dash)
          ? 'dotted'
          : 'dashed'
        : null

    /* A stored connector keeps exactly the id it had -- including none, which a template transcribed
       by hand may have, since the server derives one from the ends. Only a link new in the Mermaid
       is given one. */
    if (stored) {
      claimed.add(stored)
      if (storedId != null) usedEdgeIds.add(storedId)
    }
    const edge = {
      ...extra,
      ...(stored ? (storedId != null ? { id: storedId } : {}) : { id: uniqueId(`mermaid-edge:${index + 1}`, usedEdgeIds) }),
      source,
      target,
      phase: extra.phase ?? null,
      discovered: extra.discovered ?? false,
    }
    /* Mermaid wins over the stored copy for everything it can say: a link someone changed from `-.->`
       to `-->` has to come back solid, even though the stored copy remembers it dashed. */
    for (const key of ['label', 'strokeStyle', 'color', 'arrowStart', 'arrowEnd']) delete edge[key]
    if (link.label) edge.label = link.label
    if (strokeStyle) edge.strokeStyle = strokeStyle
    if (concrete(style.stroke)) edge.color = style.stroke
    if (arrowStart) edge.arrowStart = true
    if (!arrowEnd) edge.arrowEnd = false
    if (!looseAt.source) delete edge.sourcePoint
    if (!looseAt.target) delete edge.targetPoint
    edges.push(edge)
    if (stored) edgeOrigins.set(edge, stored)
    else freshEdges.push(edge)
  })

  /* Hand-placed anchors and bends are about the *old* geometry. A connector whose end moved to a
     different component, or that is new, gets none -- otherwise its line would leave from the side of
     a box it is no longer attached to. */
  for (const [edge, stored] of edgeOrigins) {
    if (stored.s !== edge.source || stored.t !== edge.target) freshEdges.push(edge)
    if (stored.s !== edge.source) {
      delete edge.sourceHandle
      delete edge.sourceAnchor
      delete edge.waypoints
      delete edge.routed
    }
    if (stored.t !== edge.target) {
      delete edge.targetHandle
      delete edge.targetAnchor
      delete edge.waypoints
      delete edge.routed
    }
  }

  /* Scenarios name components by id, and so survive only for components that do. */
  const ids = new Set(nodes.map((node) => node.id))
  const scenarios = (meta?.scenarios ?? []).filter((scenario) => !scenario.sourceId || ids.has(scenario.sourceId))
  const collapsed = meta?.collapsed ?? []

  const graph = layoutMermaidGraph(
    {
      nodes,
      edges,
      zones,
      ...(scenarios.length ? { scenarios } : {}),
      ...(collapsed.length ? { collapsed } : {}),
      ...(meta?.viewport && !nodes.some((node) => !node.position) ? { viewport: meta.viewport } : {}),
    },
    {
      direction: parsed.direction,
      freshEdges: freshEdges.map((edge) => edge.id),
      directions: Object.fromEntries(
        [...parsed.subgraphs.values()]
          .filter((subgraph) => subgraph.direction)
          .map((subgraph) => [zoneIdFor.get(subgraph.id), subgraph.direction === 'TD' ? 'TB' : subgraph.direction]),
      ),
    },
  )

  if (meta && (meta.scenarios?.length ?? 0) > scenarios.length) {
    const lost = meta.scenarios.length - scenarios.length
    warnings.push(`${lost} walkthrough path${lost === 1 ? '' : 's'} started from a component that is no longer in the flowchart, and ${lost === 1 ? 'was' : 'were'} dropped.`)
  }

  return {
    name: meta?.doc?.name ?? parsed.title ?? '',
    description: meta?.doc?.description ?? '',
    sourceTemplate: meta?.doc?.sourceTemplate ?? '',
    graph,
    warnings,
    /* Whether this came back from one of this app's own exports, which the UI words differently:
       "restored" rather than "drawn from a flowchart". */
    restored: Boolean(meta),
  }
}

/* Whether a stored connector is the one this link draws: same two ends, in the order the link was
   written (reversed, for one exported flipped), and not already claimed by an earlier link. */
/* A zone's label: what the subgraph now says, unless that is only what an export wrote for a zone with
   no label of its own (its id), in which case it stays without one. */
function zoneLabel(subgraph, stored, known) {
  if (stored) {
    const written = stored.label || stored.id
    if (subgraph.label === written) return stored.label != null ? { label: stored.label } : {}
    return { label: subgraph.label }
  }
  return { label: subgraph.label || known?.label || subgraph.id }
}

function matchStored(entry, source, target, claimed) {
  if (!entry || claimed.has(entry)) return null
  const [s, t] = entry.flip ? [entry.t, entry.s] : [entry.s, entry.t]
  return s === source && t === target ? entry : null
}

function readMeta(comments, warnings) {
  for (const comment of comments) {
    if (!comment.startsWith(MERMAID_META_PREFIX)) continue
    try {
      const meta = JSON.parse(comment.slice(MERMAID_META_PREFIX.length))
      if (typeof meta?.v === 'number' && meta.v > MERMAID_META_VERSION) {
        warnings.push('This flowchart was exported by a newer version of the app; only what the Mermaid itself shows was imported.')
        return null
      }
      return meta && typeof meta === 'object' ? meta : null
    } catch {
      warnings.push('The segment-builder line at the bottom of the flowchart is damaged, so positions and settings were not restored.')
      return null
    }
  }
  return null
}

function uniqueId(wanted, used) {
  if (wanted == null) return null
  let id = wanted
  for (let n = 2; used.has(id); n++) id = `${wanted}~${n}`
  used.add(id)
  return id
}

/* A short, stable suffix from a Mermaid id, so importing the same flowchart twice mints the same ids. */
function shortHash(text) {
  let hash = 2166136261
  for (const char of String(text)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}

function customZoneId(alias) {
  return `custom:zone:${shortHash(alias)}`
}

/* A node restored from the comment, with whatever the visible Mermaid now says laid over it. */
function fromStored(node, stored, zone) {
  const { id: _id, ...rest } = stored
  const out = { ...rest, zone }
  if (node.label != null) {
    const label = node.label
    /* Compared with what the export *wrote*, not with `name`: a table's label is its cells and a
       shape's may be rich text, and neither is a rename just because it is not the stored `name`. */
    if (label !== nodeLabel(stored)) {
      out.name = label
      /* A rename in the Mermaid loses the rich formatting the old name had -- the alternative is
         keeping formatting for text that no longer exists. */
      delete out.nameRich
    }
  }
  /* A node moved into a different zone in the Mermaid keeps nothing of where it sat in the old one. */
  if (zone !== (stored.zone ?? null)) delete out.position
  return out
}

/* --- recognising Segment in a hand-written flowchart ------------------------------------------ */

/* Zone ids by what a person might call them. Lower-case, punctuation-free. */
const ZONE_NAMES = {
  segment: 'segment',
  'segment cdp': 'segment',
  'twilio segment': 'segment',
  connections: 'connections',
  protocols: 'protocols',
  sources: 'sources',
  destinations: 'destinations',
  warehouses: 'warehouses',
  warehouse: 'warehouses',
  'linked events': 'linked_events',
  unify: 'unify',
  'profile sources': 'profile_sources',
  profiles: 'profiles',
  'identity settings': 'identity_settings',
  'identity resolution settings': 'identity_settings',
  engage: 'engage',
  computations: 'computations',
  debugger: 'debugger',
  'linked audiences': 'linked_audiences',
}

/* What kinds.js and the topology call each zone, when there is no topology to ask. */
const STOCK_ZONES = {
  segment: { label: 'Segment' },
  connections: { label: 'Connections' },
  protocols: { label: 'Protocols' },
  sources: { label: 'Sources' },
  destinations: { label: 'Destinations' },
  warehouses: { label: 'Warehouses' },
  linked_events: { label: 'Linked Events' },
  unify: { label: 'Unify' },
  profile_sources: { label: 'Profile Sources' },
  profiles: { label: 'Profiles' },
  identity_settings: { label: 'Identity Settings' },
  engage: { label: 'Engage' },
  computations: { label: 'Computations' },
  debugger: { label: 'Debugger' },
  linked_audiences: { label: 'Linked Audiences' },
}

const plain = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

function recogniseZone(subgraph, topology) {
  for (const candidate of [subgraph.label, subgraph.id.replace(/_/g, ' ')]) {
    const key = plain(candidate)
    if (ZONE_NAMES[key]) return ZONE_NAMES[key]
    const known = topology?.zones?.find((zone) => plain(zone.label) === key || zone.id === key)
    if (known) return known.id
  }
  return null
}

/*
 * A component kind from a hand-written node, most specific evidence first:
 *   1. a class named after a kind (`:::destination`) -- what this file's own exports write
 *   2. its label naming a kind ("Reverse ETL Model", "Computed Trait")
 *   3. its label naming a product that is always one kind (Snowflake is a warehouse; Braze, wherever
 *      it sits, is a destination)
 *   4. the zone it sits in (anything in Sources is a source)
 * and otherwise a custom component, which is what a box nobody recognised honestly is.
 */
const KIND_WORDS = [
  [/\breverse etl\b/, 'reverse_etl_model'],
  [/\bsource insert function\b/, 'source_insert_function'],
  [/\bdestination insert function\b/, 'destination_insert_function'],
  [/\binsert function\b/, 'destination_insert_function'],
  [/\bsource function\b/, 'source_function'],
  [/\bdestination function\b/, 'destination_function'],
  [/\bdestination filter\b|\bfilter\b/, 'destination_filter'],
  [/\bmapping\b|\bactions? mapping\b/, 'destination_mapping'],
  [/\bschema controls?\b/, 'source_schema_control'],
  [/\btracking plan\b/, 'tracking_plan'],
  [/\bevent library\b/, 'event_library'],
  [/\bproperty library\b/, 'property_library'],
  [/\bidentity resolution rule\b|\bidentity setting\b/, 'identity_setting'],
  [/\bidentity resolution\b|\bidentity resolver\b/, 'identity_resolution'],
  [/\bcomputed traits?\b|\bsql traits?\b|\bpredictive traits?\b/, 'computed_trait'],
  [/\bprofile api\b/, 'profile_api'],
  [/\bprofiles? sync\b/, 'profile_sync'],
  [/\bprofile source\b/, 'profile_source'],
  [/\blinked audience\b/, 'linked_audience'],
  [/\blinked event\b/, 'linked_event'],
  [/\baudiences?\b/, 'audience'],
  [/\bjourneys?\b/, 'journey'],
  [/\bdata graph\b/, 'data_graph'],
  [/\bsql table\b/, 'sql_table'],
  [/\bspace\b/, 'space'],
  [/\bprofiles?\b/, 'profile'],
  [/\bwarehouse\b/, 'warehouse'],
  [/\bdestinations?\b/, 'destination'],
  [/\bsources?\b/, 'source'],
]

const WAREHOUSE_PRODUCTS = /\b(snowflake|bigquery|big query|redshift|databricks|postgres|postgresql|azure synapse|synapse|s3)\b/
const DESTINATION_PRODUCTS = /\b(braze|amplitude|mixpanel|google analytics|ga4|facebook|meta conversions|salesforce|hubspot|marketo|iterable|intercom|zendesk|slack|webhooks?|customer\.?io|optimizely|klaviyo|twilio engage|sendgrid|google ads|linkedin|tiktok|pinterest|snapchat|appsflyer|adjust|branch|heap|fullstory|hotjar|pendo|vwo|launchdarkly)\b/
const SOURCE_PRODUCTS = /\b(javascript|analytics\.js|website|web site|web app|ios|android|react native|flutter|server|node\.?js|python|ruby|java|go|php|http api|mobile app|app)\b/

const ZONE_DEFAULT_KIND = {
  sources: 'source',
  destinations: 'destination',
  warehouses: 'warehouse',
  linked_events: 'linked_event',
  protocols: 'tracking_plan',
  profile_sources: 'profile_source',
  profiles: 'profile',
  identity_settings: 'identity_setting',
  computations: 'computed_trait',
  linked_audiences: 'linked_audience',
}

function inferKind(node, zoneId, { topology }) {
  const kinds = topology?.kinds ?? KIND_STYLES
  for (const cls of node.classes) {
    const kind = cls.toLowerCase()
    if (kind === 'shape' || kind === 'table') return kind
    if (kinds[kind] || KIND_STYLES[kind]) return kind
  }

  const product = zoneProductOf(zoneId)
  const label = plain(node.label ?? node.id.replace(/_/g, ' '))

  /* Shapes Mermaid uses for flowchart punctuation -- a decision diamond, a start/stop circle -- outside
     any Segment zone are drawings, not components. */
  if (!product && MERMAID_TO_DRAWN[node.shape]) return 'shape'

  for (const [pattern, kind] of KIND_WORDS) if (pattern.test(label)) return kind
  if (WAREHOUSE_PRODUCTS.test(label) || node.shape === 'cylinder') {
    return product === 'unify' ? 'sql_table' : 'warehouse'
  }
  if (DESTINATION_PRODUCTS.test(label)) return 'destination'
  if (ZONE_DEFAULT_KIND[product]) return ZONE_DEFAULT_KIND[product]
  if (SOURCE_PRODUCTS.test(label) && (product === 'connections' || product === 'segment')) return 'source'
  if (product === 'connections') return node.shape === 'subroutine' ? 'source_function' : 'destination'
  if (product === 'engage') return 'audience'
  if (product === 'unify') return 'computed_trait'
  return 'custom'
}

/* A node someone typed into the Mermaid: a new component, built the way a palette drop builds one. */
function fromMermaid(node, zone, { parsed, topology }) {
  const kind = inferKind(node, zone, { topology })
  const label = node.label ?? node.id
  const styled = mermaidNodeStyle(node, parsed, kind)

  if (kind === 'shape') {
    const shape = MERMAID_TO_DRAWN[node.shape] ?? 'rectangle'
    const aspect = shape === 'circle' || shape === 'diamond' || shape === 'hexagon' ? 1 : 1.6
    /* A borderless rectangle is a text label, not a picture, and is sized to its words: a 192px box
       around "Read" spaces every neighbour out to make room for nothing. */
    const textOnly = shape === 'rectangle' && styled.border === 'transparent'
    const lines = String(textOnly ? label : '').split('\n')
    const size = textOnly
      ? {
          width: Math.max(80, Math.min(260, Math.round(Math.max(...lines.map((line) => line.length)) * 7.5 + 28))),
          height: Math.max(36, lines.length * 18 + 18),
        }
      : { width: Math.round(120 * aspect), height: 120 }
    return {
      kind: 'shape',
      name: label,
      zone,
      bound: true,
      bindable: false,
      shape,
      radius: 0,
      size,
      ...(Object.keys(styled).length ? { style: styled } : {}),
    }
  }

  const custom = kind === 'custom'
  return {
    kind,
    name: label,
    description: '',
    zone,
    /* A drawn component is a placeholder until bound, exactly like a palette drop -- except a custom
       one, which has nothing in a workspace to bind to. */
    bound: custom,
    ...(custom ? { bindable: false, details: [] } : {}),
    style: { ...DROPPED_STYLE, ...(CSS_SHAPE_FOR(node.shape) ? { shape: CSS_SHAPE_FOR(node.shape) } : {}), ...styled },
    ...(codeSeed(kind, { bound: false }) ?? {}),
  }
}

const CSS_SHAPE_FOR = (shape) => MERMAID_TO_CSS[shape] ?? null

/* A hand-written node's colours: its classes in order, then its own `style` line, as Mermaid applies
   them. Classes named after a kind contribute nothing -- their colours are that kind's defaults, which
   the component already has. */
function mermaidNodeStyle(node, parsed, kind) {
  const props = {}
  for (const cls of node.classes) {
    if (cls === kind) continue
    Object.assign(props, parsed.classDefs.get(cls) ?? {})
  }
  Object.assign(props, parsed.styles.get(node.id) ?? {})
  const style = {}
  if (concrete(props.fill) && !/^(#fff|#ffffff|white)$/i.test(props.fill)) style.bg = props.fill
  if (concrete(props.stroke)) style.border = props.stroke
  if (concrete(props.color)) style.text = props.color
  if (props['stroke-dasharray']) style.borderStyle = 'dashed'
  const width = parseFloat(props['stroke-width'])
  if (Number.isFinite(width) && width > 0) style.borderWidth = Math.round(width)
  return style
}

/* A hand-written subgraph's colours, onto a zone. A product zone keeps its product colour unless the
   Mermaid gave it a different stroke -- otherwise every flowchart with a default grey subgraph would
   arrive with Connections painted grey. */
function zoneStyleFromMermaid(style, product) {
  if (!style) return {}
  const stroke = concrete(style.stroke)
  const stock = ZONE_COLOURS[product]?.stroke ?? (ZONE_STYLES[product] ? null : undefined)
  const out = {}
  if (stroke && stroke.toLowerCase() !== stock?.toLowerCase?.()) out.color = stroke
  if (style['stroke-dasharray'] == null && style.stroke) out.style = { borderStyle: 'solid' }
  return out
}
