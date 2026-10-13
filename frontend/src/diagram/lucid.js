/*
 * A Lucid document's JSON export -> a Mermaid flowchart, for the Mermaid importer to draw.
 *
 * ## What Lucid's JSON is, and is not
 *
 * Lucidchart's File > Export > JSON (and a Lucidspark board opened in Lucidchart and exported the same
 * way) writes the document's *contents*, not its drawing:
 *
 *     {id, title, product, pages: [{id, title, index, items: {shapes, lines, groups, layers}}]}
 *
 *     shape  {id, class, textAreas: [{label, text}], customData, linkedData}
 *     line   {id, endpoint1: {style, connectedTo}, endpoint2: {...}, textAreas}
 *     group  {id, members: [shape id, ...]}
 *
 * There are no coordinates, sizes or colours anywhere in it. So it can say what the boxes are called,
 * what kind of box each is, which arrows join which and which way they point -- and nothing about where
 * anything was. A converter that promised "as it looked in Lucid" from this file would be inventing
 * the layout; this one says plainly that it lays the diagram out afresh, and does it along the flow of
 * the arrows the way Mermaid would, which is usually close to how the author drew it anyway.
 *
 * ## Why through Mermaid rather than straight to a document
 *
 * Because the Mermaid importer already does every hard part: recognising Segment zones and component
 * kinds from names, laying out along a direction, giving connectors facing sides, and producing a
 * document `applyGraph` accepts. Converting Lucid to Mermaid text means Lucid gets all of that for free
 * and stays correct as the importer improves -- and the intermediate text is a useful artefact in its
 * own right, shown to the user so they can tidy it before importing.
 */

/* Lucid's block classes, by what they draw. Matched on the class with its product prefix and version
   suffix stripped (`SparkDatabaseBlock`, `DatabaseBlock`, `TerminatorBlockV2` all reduce to the same
   word), so Lucidchart and Lucidspark documents read alike. */
const LUCID_SHAPES = {
  rectangle: 'rect',
  process: 'rect',
  roundedrectangle: 'round',
  database: 'cylinder',
  storeddata: 'cylinder',
  cylinder: 'cylinder',
  terminator: 'stadium',
  predefinedprocess: 'subroutine',
  subprocess: 'subroutine',
  decision: 'diamond',
  diamond: 'diamond',
  circle: 'circle',
  ellipse: 'circle',
  hexagon: 'hexagon',
  preparation: 'hexagon',
  cloud: 'cloud',
  document: 'document',
  multipledocuments: 'documents',
  data: 'lean-right',
  inputoutput: 'lean-right',
  parallelogram: 'lean-right',
  manualoperation: 'trapezoid-alt',
  triangle: 'triangle',
}

/* Classes that are words on the canvas rather than boxes: free text and sticky notes. They become
   annotations -- a text-only shape -- rather than components, because they are not part of the flow. */
const TEXT_CLASSES = /^(autogrowtext|text|textblock|stickiesstickynote|stickynote|sticky)$/
const STICKY = /stick/

/* Lucid's arrowhead names that mean "no arrowhead". Everything else (`Arrow`, `Equilateral Arrow`,
   `Hollow Arrow`, `Diamond`, crow's-foot variants...) draws something, which Mermaid can only say as an
   arrow. */
const NO_HEAD = new Set(['', 'none', 'null'])

function baseClass(cls) {
  return String(cls ?? '')
    .replace(/^(Spark|Lucid|Flowchart|Basic|Default)/, '')
    .replace(/(Block)?(V\d+)?$/i, '')
    .replace(/Block$/, '')
    .toLowerCase()
}

/** Is this parsed JSON a Lucid document export? */
export function isLucidDocument(doc) {
  return Boolean(
    doc &&
      typeof doc === 'object' &&
      !Array.isArray(doc) &&
      Array.isArray(doc.pages) &&
      doc.pages.some((page) => page?.items && Array.isArray(page.items.shapes)),
  )
}

/* A shape's visible text: its "Text" area, falling back to the first non-placeholder one. Placeholder
   and attribution areas ("Type something", the sticky's author) are Lucid chrome, not content. */
function shapeText(shape) {
  const areas = shape?.textAreas ?? []
  const main =
    areas.find((area) => area?.label === 'Text') ??
    areas.find((area) => !/placeholder|attribution/i.test(area?.label ?? ''))
  return String(main?.text ?? '').trim()
}

function lineText(line) {
  return (line?.textAreas ?? [])
    .map((area) => String(area?.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

const quote = (text) =>
  `"${String(text)
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\|/g, '#124;')
    .replace(/\r?\n/g, '<br>')}"`

/* Mermaid ids from Lucid ids, which contain `.`, `~` and `_` freely. Prefixed by page so two pages can
   both have a shape called `abc` without merging. */
function makeAliaser() {
  const used = new Set()
  const out = new Map()
  return (key) => {
    if (out.has(key)) return out.get(key)
    const base = `l_${String(key).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'n'}`
    let alias = base
    for (let n = 2; used.has(alias.toLowerCase()); n++) alias = `${base}_${n}`
    used.add(alias.toLowerCase())
    out.set(key, alias)
    return alias
  }
}

const BRACKETS = {
  rect: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  'lean-right': ['[/', '/]'],
  'trapezoid-alt': ['[\\', '/]'],
}
const NAMED = { cloud: 'cloud', document: 'doc', documents: 'docs', triangle: 'tri' }

function nodeDecl(alias, shape, label) {
  if (NAMED[shape]) return `${alias}@{ shape: ${NAMED[shape]}, label: ${quote(label)} }`
  const [open, close] = BRACKETS[shape] ?? BRACKETS.rect
  return `${alias}${open}${quote(label)}${close}`
}

/**
 * A Lucid document export -> `{text, title, stats, notes}`.
 *
 * `text` is a Mermaid flowchart ready for `mermaidToGraph`. `stats` counts what was carried and what was
 * left out, and `notes` says why in sentences, so the UI can be honest about what came across.
 *
 * @param doc  the parsed JSON
 * @param options.direction  the Mermaid direction to lay out along; `LR` by default
 */
export function lucidToMermaid(doc, { direction = 'LR' } = {}) {
  if (!isLucidDocument(doc)) throw new Error('That JSON is not a Lucid document export.')

  const pages = [...doc.pages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const multi = pages.filter((page) => (page.items?.shapes ?? []).length).length > 1
  const alias = makeAliaser()

  const stats = { pages: 0, shapes: 0, notes: 0, lines: 0, groups: 0, skippedShapes: 0, skippedLines: 0 }
  const lines = []
  const title = String(doc.title ?? '').trim()
  if (title) lines.push('---', `title: ${quote(title)}`, '---')
  lines.push(`flowchart ${direction}`)
  const noteStyles = []
  const links = []

  for (const page of pages) {
    const items = page.items ?? {}
    const shapes = items.shapes ?? []
    if (!shapes.length) continue
    stats.pages++

    const byId = new Map(shapes.map((shape) => [shape.id, shape]))
    const connected = new Set()
    for (const line of items.lines ?? []) {
      for (const end of ['endpoint1', 'endpoint2']) if (line?.[end]?.connectedTo) connected.add(line[end].connectedTo)
    }

    /* Which shapes a line or group can name: everything kept, and nothing skipped. */
    const kept = new Map()
    const decls = new Map()
    for (const shape of shapes) {
      const cls = baseClass(shape.class)
      const text = shapeText(shape)
      const isText = TEXT_CLASSES.test(cls)

      /* An empty, unconnected box is a container in Lucid -- a region other shapes were drawn on top
         of -- and the JSON does not say which shapes were inside it, so there is nothing to draw it
         around. A text block with no text is nothing at all. */
      if (!connected.has(shape.id) && (!text || (isText && !text))) {
        stats.skippedShapes++
        continue
      }

      const key = `${page.id}:${shape.id}`
      const id = alias(key)
      kept.set(shape.id, id)

      if (isText && !connected.has(shape.id)) {
        stats.notes++
        /* `:::shape`, so the importer draws it as a drawing rather than guessing a component kind
           from the words -- "Read" or "Delete" written beside an arrow is not a component. Text-only:
           no outline, and the sticky on its own yellow. */
        decls.set(shape.id, `${nodeDecl(id, 'rect', text)}:::shape`)
        noteStyles.push(
          STICKY.test(cls)
            ? `style ${id} fill:#fff4b8,stroke:#e8d27a,color:#4a3d00`
            : `style ${id} fill:transparent,stroke:transparent,color:#354052`,
        )
        continue
      }

      stats.shapes++
      decls.set(shape.id, nodeDecl(id, LUCID_SHAPES[cls] ?? 'rect', text || ' '))
    }

    /* Groups become subgraphs. Lucid groups nest, and a shape is in at most one, so the innermost
       group wins and a group whose members are all in a sub-group is that sub-group's parent. */
    const groups = (items.groups ?? []).filter((group) => Array.isArray(group?.members))
    const groupOf = new Map()
    const groupIds = new Set(groups.map((group) => group.id))
    for (const group of [...groups].sort((a, b) => b.members.length - a.members.length)) {
      for (const member of group.members) groupOf.set(member, group.id)
    }
    const parentOf = new Map()
    for (const group of groups) {
      if (groupOf.has(group.id) && groupOf.get(group.id) !== group.id) parentOf.set(group.id, groupOf.get(group.id))
    }

    const indent = (depth) => '  '.repeat(depth)
    const writeGroup = (groupId, depth, seen) => {
      if (seen.has(groupId)) return
      seen.add(groupId)
      const group = groups.find((entry) => entry.id === groupId)
      const members = group.members.filter((member) => groupOf.get(member) === groupId)
      const shapesIn = members.filter((member) => decls.has(member))
      const subGroups = members.filter((member) => groupIds.has(member))
      if (!shapesIn.length && !subGroups.length) return
      stats.groups++
      /* Lucid groups have no name of their own; the subgraph is labelled by its first member's text,
         which is usually what the author would have called it -- often it *is* the group's title. */
      const named = members.map((member) => shapeText(byId.get(member))).find(Boolean)
      lines.push(`${indent(depth)}subgraph ${alias(`${page.id}:group:${groupId}`)}[${quote(named || 'Group')}]`)
      for (const member of shapesIn) {
        lines.push(`${indent(depth + 1)}${decls.get(member)}`)
        decls.delete(member)
      }
      for (const sub of subGroups) writeGroup(sub, depth + 1, seen)
      lines.push(`${indent(depth)}end`)
    }

    const depth = multi ? 2 : 1
    if (multi) lines.push(`  subgraph ${alias(`${page.id}:page`)}[${quote(page.title || `Page ${(page.index ?? 0) + 1}`)}]`)
    const seen = new Set()
    for (const group of groups) if (!parentOf.has(group.id)) writeGroup(group.id, depth, seen)
    for (const decl of decls.values()) lines.push(`${indent(depth)}${decl}`)
    if (multi) lines.push('  end')

    for (const line of items.lines ?? []) {
      const from = kept.get(line?.endpoint1?.connectedTo)
      const to = kept.get(line?.endpoint2?.connectedTo)
      if (!from || !to) {
        /* A line with a free end, or one attached to a shape that was skipped. Lucid's JSON does not
           say where a free end was, so there is no point to leave it pointing at. */
        stats.skippedLines++
        continue
      }
      stats.lines++
      const headStart = !NO_HEAD.has(String(line.endpoint1?.style ?? '').trim().toLowerCase())
      const headEnd = !NO_HEAD.has(String(line.endpoint2?.style ?? '').trim().toLowerCase())
      const label = lineText(line)
      /* Mermaid has no arrow on the start alone, so that line is written the other way round, which
         draws the same picture and walks the right way. */
      const [a, b] = headStart && !headEnd ? [to, from] : [from, to]
      const op = headStart && headEnd ? '<-->' : headStart || headEnd ? '-->' : '---'
      links.push(`  ${a} ${op}${label ? `|${quote(label)}|` : ''} ${b}`)
    }
  }

  lines.push(...links)
  if (noteStyles.length) lines.push('', ...noteStyles.map((style) => `  ${style}`))

  const notes = []
  notes.push(
    'Lucid’s JSON export holds what is on the board and how it is connected, but no positions, sizes or colours — so the diagram is laid out afresh along its arrows.',
  )
  if (stats.skippedShapes) {
    notes.push(
      `${stats.skippedShapes} empty, unconnected box${stats.skippedShapes === 1 ? ' was' : 'es were'} left out. In Lucid these are usually containers drawn behind other shapes; the export does not say what was inside them.`,
    )
  }
  if (stats.skippedLines) {
    notes.push(`${stats.skippedLines} line${stats.skippedLines === 1 ? '' : 's'} with a free end ${stats.skippedLines === 1 ? 'was' : 'were'} left out.`)
  }
  if (stats.notes) {
    notes.push(`${stats.notes} text label${stats.notes === 1 ? '' : 's'} and sticky note${stats.notes === 1 ? '' : 's'} came across as annotations rather than components.`)
  }

  return { text: `${lines.join('\n')}\n`, title, stats, notes }
}

/**
 * `lucidToMermaid` for raw file text, or null when the text is not a Lucid export -- what lets the
 * import paths try it first without caring what else the text might be.
 */
export function convertIfLucid(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  return isLucidDocument(doc) ? lucidToMermaid(doc) : null
}
