/*
 * A reader for Mermaid's flowchart syntax -- just enough of it to rebuild a diagram from.
 *
 * Not a port of Mermaid's own grammar, and deliberately not a dependency on Mermaid: the library is
 * a couple of megabytes of renderer to get at a parser, and what an import needs is the structure --
 * which nodes, in which subgraphs, joined by which links, styled how -- not a picture. So this reads
 * the statements a flowchart is made of and returns them as plain data, and `mermaid.js` decides what
 * each one means for this app.
 *
 * What it understands:
 *   - `flowchart LR` / `graph TD` headers, a `---\ntitle: ...\n---` front-matter block, and a
 *     surrounding ```mermaid code fence (pasting from a Markdown file is the common case)
 *   - nodes in every bracket shape, quoted and unquoted labels, `:::class`, and the newer
 *     `id@{ shape: ..., label: ... }` form
 *   - links of every weight (`-->`, `---`, `-.->`, `==>`, `<-->`, `~~~`), at any length, with a label
 *     either piped (`-->|text|`) or inline (`-- text -->`), chained (`a --> b --> c`) and fanned out
 *     with `&`
 *   - `subgraph` blocks, nested, with or without a separate title
 *   - `classDef`, `class`, `style` and `linkStyle`
 *   - `%%` comments, which are returned rather than dropped, because that is where an export from
 *     this app keeps everything Mermaid has no syntax for
 *
 * Anything else -- `click`, accessibility lines, a statement this does not recognise -- is skipped and
 * reported in `warnings`, so a diagram with one unusual line still imports rather than failing whole.
 */

/* Shape delimiters, longest opener first: `((` has to be tried before `(`, or every circle would read
   as a round node whose label starts with a parenthesis. */
const SHAPES = [
  ['(((', ')))', 'double-circle'],
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['[/', '/]', 'lean-right'],
  ['[\\', '\\]', 'lean-left'],
  ['[/', '\\]', 'trapezoid'],
  ['[\\', '/]', 'trapezoid-alt'],
  ['{{', '}}', 'hexagon'],
  ['{', '}', 'diamond'],
  ['(', ')', 'round'],
  ['[', ']', 'rect'],
  ['>', ']', 'flag'],
]

/* The newer `@{ shape: ... }` names, mapped onto the bracket shapes above so the rest of the import
   only has one vocabulary to deal with. Names not listed fall back to `rect`. */
const NAMED_SHAPES = {
  rect: 'rect',
  rectangle: 'rect',
  proc: 'rect',
  process: 'rect',
  rounded: 'round',
  event: 'round',
  stadium: 'stadium',
  pill: 'stadium',
  terminal: 'stadium',
  subproc: 'subroutine',
  subroutine: 'subroutine',
  'framed-rectangle': 'subroutine',
  cyl: 'cylinder',
  cylinder: 'cylinder',
  database: 'cylinder',
  db: 'cylinder',
  circle: 'circle',
  circ: 'circle',
  'dbl-circ': 'double-circle',
  'double-circle': 'double-circle',
  diam: 'diamond',
  diamond: 'diamond',
  decision: 'diamond',
  question: 'diamond',
  hex: 'hexagon',
  hexagon: 'hexagon',
  prepare: 'hexagon',
  'lean-r': 'lean-right',
  'lean-right': 'lean-right',
  'lean-l': 'lean-left',
  'lean-left': 'lean-left',
  'trap-b': 'trapezoid',
  trapezoid: 'trapezoid',
  'trap-t': 'trapezoid-alt',
  'inv-trapezoid': 'trapezoid-alt',
  flag: 'flag',
  'odd': 'flag',
  doc: 'document',
  document: 'document',
  docs: 'documents',
  documents: 'documents',
  cloud: 'cloud',
  tri: 'triangle',
  triangle: 'triangle',
}

const DIRECTIONS = new Set(['LR', 'RL', 'TB', 'TD', 'BT'])

/* A node id: letters, digits and underscores, with single dashes or dots allowed *between* them --
   `api-gateway` is an id, but the `-` in `a-->b` is the start of a link. */
const ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u

/** Mermaid's entity codes and `<br>` back into plain text. */
export function decodeLabel(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/#(quot|amp|lt|gt|apos|nbsp);/g, (_, name) => NAMED_ENTITIES[name])
    .replace(/&(quot|amp|lt|gt|apos|nbsp);/g, (_, name) => NAMED_ENTITIES[name])
}

const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' }

/* A label as written: quoted (possibly a backtick "markdown string") or bare. */
function cleanLabel(raw) {
  let text = String(raw ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1)
  return decodeLabel(text).trim()
}

/** `fill:#fff,stroke:#333` -> `{fill: '#fff', stroke: '#333'}`. A `\,` is a comma inside a value. */
export function parseStyle(text) {
  const props = {}
  for (const part of String(text ?? '').split(/(?<!\\),/)) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const key = part.slice(0, at).trim().toLowerCase()
    const value = part
      .slice(at + 1)
      .replace(/\\,/g, ',')
      .replace(/;$/, '')
      .trim()
    if (key && value) props[key] = value
  }
  return props
}

/* Statements end at a newline or a `;`, but not a `;` inside a quoted label or a bracket -- `A["x;
   y"]` is one statement. */
function splitStatements(line) {
  const out = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') quoted = !quoted
    else if (!quoted && '([{'.includes(char)) depth++
    else if (!quoted && ')]}'.includes(char)) depth = Math.max(0, depth - 1)
    else if (!quoted && depth === 0 && char === ';') {
      out.push(line.slice(start, index))
      start = index + 1
    }
  }
  out.push(line.slice(start))
  return out.map((part) => part.trim()).filter(Boolean)
}

/* Code fence and front matter off the top; the title is the only front-matter key an import uses. */
function unwrap(text) {
  let body = String(text ?? '').replace(/\r\n?/g, '\n')
  const fenced = /```\s*mermaid[^\n]*\n([\s\S]*?)```/i.exec(body)
  if (fenced) body = fenced[1]

  let title = null
  const front = /^\s*---\s*\n([\s\S]*?)\n\s*---\s*(?:\n|$)/.exec(body)
  if (front) {
    const named = /^\s*title\s*:\s*(.*)$/m.exec(front[1])
    if (named) title = named[1].trim().replace(/^(["'])(.*)\1$/, '$2')
    body = body.slice(front[0].length)
  }
  return { body, title }
}

/**
 * Parse flowchart text.
 *
 * @returns {{
 *   direction: string,
 *   title: string | null,
 *   nodes: Map<string, {id, label, shape, classes: string[], subgraph: string | null}>,
 *   subgraphs: Map<string, {id, label, parent: string | null, direction: string | null}>,
 *   links: Array<{source, target, kind, arrowStart, arrowEnd, label, id, index}>,
 *   classDefs: Map<string, object>,
 *   styles: Map<string, object>,
 *   linkStyles: Map<number | 'default', object>,
 *   comments: string[],
 *   warnings: string[],
 * }}
 * `nodes`, `subgraphs` and `links` are in the order they first appeared, which is the order Mermaid
 * itself numbers links in -- and the order `linkStyle 3` refers to.
 */
export function parseMermaid(text) {
  const { body, title } = unwrap(text)
  const result = {
    direction: 'TB',
    title,
    nodes: new Map(),
    subgraphs: new Map(),
    links: [],
    classDefs: new Map(),
    styles: new Map(),
    linkStyles: new Map(),
    comments: [],
    warnings: [],
  }

  const stack = []
  let header = false

  const lines = body.split('\n')
  for (let number = 0; number < lines.length; number++) {
    const line = lines[number].trim()
    if (!line) continue
    if (line.startsWith('%%')) {
      /* `%%{init: ...}%%` is a directive, not a comment, and says nothing about structure. */
      if (!line.startsWith('%%{')) result.comments.push(line.slice(2).trim())
      continue
    }

    if (!header) {
      const head = /^(flowchart|graph)\b\s*([A-Za-z]{2})?\s*;?\s*(.*)$/i.exec(line)
      if (!head) {
        const kind = line.split(/\s/)[0]
        throw new Error(
          `That is a Mermaid ${kind} diagram. Only flowcharts (\`flowchart\` or \`graph\`) can be imported.`,
        )
      }
      header = true
      const direction = head[2]?.toUpperCase()
      if (direction && DIRECTIONS.has(direction)) result.direction = direction === 'TD' ? 'TB' : direction
      /* `graph LR; A --> B` -- statements on the header line itself. */
      if (head[3]) for (const statement of splitStatements(head[3])) readStatement(statement, number)
      continue
    }

    for (const statement of splitStatements(line)) readStatement(statement, number)
  }

  if (!header) throw new Error('There is no flowchart in that text. It should start with `flowchart LR` or `graph TD`.')
  if (stack.length) result.warnings.push(`${stack.length} subgraph${stack.length === 1 ? ' was' : 's were'} never closed with \`end\`.`)
  return result

  function readStatement(statement, number) {
    const where = `line ${number + 1}`

    if (/^end$/i.test(statement)) {
      if (!stack.length) result.warnings.push(`An \`end\` on ${where} closes nothing; ignored.`)
      stack.pop()
      return
    }

    const subgraph = /^subgraph\s+(.*)$/i.exec(statement)
    if (subgraph) return openSubgraph(subgraph[1].trim(), where)

    const direction = /^direction\s+([A-Za-z]{2})$/i.exec(statement)
    if (direction) {
      const current = stack.at(-1)
      if (current) result.subgraphs.get(current).direction = direction[1].toUpperCase()
      return
    }

    const classDef = /^classDef\s+(\S+)\s+(.+)$/i.exec(statement)
    if (classDef) {
      for (const name of classDef[1].split(',')) result.classDefs.set(name.trim(), parseStyle(classDef[2]))
      return
    }

    const classLine = /^class\s+(\S+)\s+(\S+)$/i.exec(statement)
    if (classLine) {
      for (const id of classLine[1].split(',')) {
        const node = touch(id.trim())
        for (const name of classLine[2].split(',')) addClass(node, name.trim())
      }
      return
    }

    const style = /^style\s+(\S+)\s+(.+)$/i.exec(statement)
    if (style) {
      result.styles.set(style[1], { ...(result.styles.get(style[1]) ?? {}), ...parseStyle(style[2]) })
      return
    }

    const linkStyle = /^linkStyle\s+(\S+)\s+(.+)$/i.exec(statement)
    if (linkStyle) {
      const props = parseStyle(linkStyle[2])
      for (const entry of linkStyle[1].split(',')) {
        const key = entry.trim().toLowerCase() === 'default' ? 'default' : Number(entry)
        if (key === 'default' || Number.isInteger(key)) {
          result.linkStyles.set(key, { ...(result.linkStyles.get(key) ?? {}), ...props })
        }
      }
      return
    }

    if (/^(click|accTitle|accDescr|callback|interpolate)\b/i.test(statement)) {
      result.warnings.push(`\`${statement.split(/\s/)[0]}\` on ${where} has no equivalent here; ignored.`)
      return
    }

    /* Transactional: a statement that fails halfway must not leave behind the nodes it named before
       it failed, or an unreadable line would add a stray box to the diagram. */
    const before = { nodes: new Map([...result.nodes].map(([id, node]) => [id, { ...node, classes: [...node.classes] }])), links: result.links.length }
    if (!readChain(statement)) {
      result.nodes = before.nodes
      result.links.length = before.links
      result.warnings.push(`Could not read ${where}: \`${statement.slice(0, 60)}\`; skipped.`)
    }
  }

  function openSubgraph(rest, where) {
    let id
    let label
    const titled = /^([^\s[\]"]+)\s*\[\s*(.*)\s*\]$/.exec(rest)
    if (titled) {
      id = titled[1]
      label = cleanLabel(titled[2])
    } else if (/^".*"$/.test(rest)) {
      label = cleanLabel(rest)
      id = label
    } else {
      id = rest
      label = cleanLabel(rest)
    }
    if (result.subgraphs.has(id)) {
      result.warnings.push(`Subgraph \`${id}\` on ${where} is declared twice; its contents are merged.`)
    } else {
      result.subgraphs.set(id, { id, label, parent: stack.at(-1) ?? null, direction: null })
    }
    stack.push(id)
  }

  /*
   * A node the statement mentions. The first mention inside a subgraph is what files it there, the way
   * Mermaid does it: a node first named at the top level and later listed inside a subgraph moves in,
   * but one already inside a subgraph is not moved out again by a later mention elsewhere.
   */
  function touch(id) {
    if (result.subgraphs.has(id)) return null
    let node = result.nodes.get(id)
    if (!node) {
      node = { id, label: null, shape: null, classes: [], subgraph: stack.at(-1) ?? null }
      result.nodes.set(id, node)
    } else if (!node.subgraph && stack.length) {
      node.subgraph = stack.at(-1)
    }
    return node
  }

  function addClass(node, name) {
    if (node && name && !node.classes.includes(name)) node.classes.push(name)
  }

  /* `a & b --> c -->|x| d & e`: node groups joined by links. Returns false when it is not one. */
  function readChain(statement) {
    let rest = statement
    const first = readGroup(rest)
    if (!first) return false
    rest = first.rest

    let previous = first.ids
    while (rest.trim()) {
      const link = readLink(rest)
      if (!link) return false
      const next = readGroup(link.rest)
      if (!next) return false
      for (const source of previous) {
        for (const target of next.ids) {
          result.links.push({
            source,
            target,
            kind: link.kind,
            arrowStart: link.arrowStart,
            arrowEnd: link.arrowEnd,
            label: link.label,
            id: link.id,
            index: result.links.length,
          })
        }
      }
      previous = next.ids
      rest = next.rest
    }
    return true
  }

  function readGroup(text) {
    const ids = []
    let rest = text
    for (;;) {
      const node = readNode(rest)
      if (!node) return ids.length ? { ids, rest } : null
      ids.push(node.id)
      rest = node.rest
      const amp = /^\s*&\s*/.exec(rest)
      if (!amp) return { ids, rest }
      rest = rest.slice(amp[0].length)
    }
  }

  function readNode(text) {
    let rest = text.replace(/^\s+/, '')
    const match = ID.exec(rest)
    if (!match) return null
    const id = match[0]
    rest = rest.slice(id.length)

    /* `subgraph` ids are legal link endpoints and are not nodes. */
    const node = result.subgraphs.has(id) ? null : touch(id)

    const shaped = readShape(rest)
    if (shaped) {
      rest = shaped.rest
      if (node) {
        node.label = shaped.label
        node.shape = shaped.shape
      }
    }

    const extended = /^@\{([^}]*)\}/.exec(rest)
    if (extended) {
      rest = rest.slice(extended[0].length)
      const props = readExtended(extended[1])
      if (node) {
        if (props.label != null) node.label = cleanLabel(props.label)
        if (props.shape) node.shape = NAMED_SHAPES[props.shape.toLowerCase()] ?? 'rect'
      }
    }

    const classed = /^:::([\w-]+)/.exec(rest)
    if (classed) {
      rest = rest.slice(classed[0].length)
      addClass(node, classed[1])
    }

    return { id, rest }
  }

  function readShape(text) {
    /* A space between id and bracket is tolerated: Mermaid accepts `A [label]`. */
    const lead = /^\s*/.exec(text)[0]
    const body = text.slice(lead.length)
    for (const [open, close, shape] of SHAPES) {
      if (!body.startsWith(open)) continue
      /* `>` opens an asymmetric node only straight after an id; after a space it is an arrow
         somebody typed oddly, and reading it as a shape would swallow the rest of the line. */
      if (open === '>' && lead) continue
      const inner = body.slice(open.length)
      let label
      let after
      const quoted = /^\s*("(?:[^"]|"(?!\s*[)\]}>/\\]))*")\s*/.exec(inner)
      if (quoted && inner.slice(quoted[0].length).startsWith(close)) {
        label = quoted[1]
        after = inner.slice(quoted[0].length + close.length)
      } else {
        const end = inner.indexOf(close)
        if (end < 0) continue
        label = inner.slice(0, end)
        after = inner.slice(end + close.length)
      }
      return { shape, label: cleanLabel(label), rest: after }
    }
    return null
  }

  function readExtended(text) {
    const props = {}
    const pattern = /(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|[^,]+)/g
    let match
    while ((match = pattern.exec(text))) props[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1')
    return props
  }

  function readLink(text) {
    let rest = text.replace(/^\s+/, '')
    let id = null
    const named = /^([\w-]+)@(?=[<ox]?[-=~.])/.exec(rest)
    if (named) {
      id = named[1]
      rest = rest.slice(named[0].length)
    }

    /* The inline-label forms first: `-- text -->`, `== text ==>`, `-. text .->`. */
    const inline =
      /^([<ox])?--(?!\s*[->])(?![ox]\s)\s*((?:(?!--).)+?)\s*(-{2,})(>|[ox](?=\s))?/.exec(rest) ??
      /^([<ox])?==(?!\s*[=>])(?![ox]\s)\s*((?:(?!==).)+?)\s*(={2,})(>|[ox](?=\s))?/.exec(rest) ??
      /^([<ox])?-\.(?![-.>])\s*((?:(?!\.-).)+?)\s*(\.-+)(>|[ox](?=\s))?/.exec(rest)
    if (inline) {
      return finishLink(inline[0], inline[1], inline[3], inline[4], cleanLabel(inline[2]), rest, id)
    }

    const plain = /^([<ox])?(-{2,}|={2,}|-\.+-|~{3,})(>|[ox](?=\s))?/.exec(rest)
    if (!plain) return null
    let after = rest.slice(plain[0].length)
    let label = null
    const piped = /^\s*\|([^|]*)\|/.exec(after)
    if (piped) {
      label = cleanLabel(piped[1])
      after = after.slice(piped[0].length)
    }
    return finishLink('', plain[1], plain[2], plain[3], label, after, id)
  }

  function finishLink(consumed, start, body, end, label, rest, id) {
    const kind = body.startsWith('~')
      ? 'invisible'
      : body.startsWith('=')
        ? 'thick'
        : body.includes('.')
          ? 'dotted'
          : 'solid'
    return {
      kind,
      arrowStart: Boolean(start),
      arrowEnd: Boolean(end),
      label: label || null,
      id,
      rest: consumed ? rest.slice(consumed.length) : rest,
    }
  }
}
