/*
 * A CSV, and a SELECT over it.
 *
 * The SQL Table component shows warehouse columns on a diagram, filtered by a query someone typed. So
 * this needs to parse a CSV and run a query against it, entirely in the browser.
 *
 * ## Why a hand-written subset and not a real engine
 *
 * The honest options were sql.js (a 1.5MB WebAssembly build of SQLite) or AlaSQL (~500KB), against a
 * ~4KB subset here. Both would give real SQL, and both would be the wrong trade for this feature:
 *
 *   - The data is a CSV somebody pasted to *illustrate* a table on a diagram. It is tens of rows, not
 *     millions. Nothing here needs a query planner.
 *   - A megabyte and a half of WASM would more than double this app's bundle for a panel most
 *     diagrams never open, and the shapes library already added 580KB.
 *   - A real engine's error messages are about SQL. The useful message here is about *this CSV* --
 *     "there is no column called `emial`, did you mean `email`" -- which a general engine cannot say.
 *
 * What is supported is stated in `SUPPORTED` and surfaced in the UI, so the boundary is visible rather
 * than discovered by a query silently returning nothing. Anything outside it is *refused with a
 * reason*, never quietly ignored: a WHERE clause that parsed as "true" because the parser did not
 * understand it would show the reader a filtered table that is not filtered, which is worse than an
 * error.
 *
 * ## The shape of a result
 *
 * `{columns, rows, error, note}`. `error` means nothing is shown; `note` means the result is real but
 * something about it is worth saying (a LIMIT applied, a column that could not be sorted). Two fields
 * rather than one, because a table with a caveat still has to render.
 */

/* What the query language covers, in the order the UI lists it. Written as data so the panel's help
   text and the parser cannot drift apart. */
export const SUPPORTED = [
  'SELECT col, col AS alias, or *',
  'FROM (any table name — there is only one table)',
  'WHERE with = != <> > >= < <= LIKE IN IS NULL',
  'AND / OR, and parentheses',
  'ORDER BY col [ASC|DESC]',
  'LIMIT n',
]

/* A hard ceiling on rows rendered, whatever the query says. A node on a canvas cannot usefully show a
   thousand rows, and trying to makes the whole diagram scroll badly. Applied as a `note`, not
   silently, so a reader knows they are looking at the top of something longer. */
export const MAX_ROWS = 200

/* --- CSV ------------------------------------------------------------------- */

/**
 * Parse a CSV into `{columns, rows}`, where a row is an object keyed by column name.
 *
 * Handles quoted fields, embedded commas, embedded newlines and doubled quotes -- all four turn up in
 * a real warehouse export and any one of them breaks a `split(',')`. Deliberately does *not* try to
 * detect a delimiter: a semicolon-separated file is a different thing, and guessing wrong produces one
 * enormous column that looks like the file was corrupted.
 *
 * Values stay strings. Typing them here would mean deciding whether `007` is a number (it is a zip
 * code) and whether `1.0` is an integer -- questions the CSV does not answer. Comparison coerces
 * instead, per operator, where the query says what kind of comparison it wants.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '')
  if (!source.trim()) return { columns: [], rows: [] }

  const cells = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (quoted) {
      if (char === '"') {
        /* A doubled quote inside a quoted field is one literal quote. Checked before closing the
           field, or `"a""b"` parses as two fields. */
        if (source[index + 1] === '"') {
          value += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        value += char
      }
      continue
    }

    if (char === '"' && value === '') {
      quoted = true
    } else if (char === ',') {
      row.push(value)
      value = ''
    } else if (char === '\n' || char === '\r') {
      /* CRLF is one break, not two. Without this every other row is empty. */
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(value)
      cells.push(row)
      row = []
      value = ''
    } else {
      value += char
    }
  }
  row.push(value)
  cells.push(row)

  const header = (cells.shift() ?? []).map((name, position) => {
    const trimmed = name.trim()
    /* A blank header still needs a name, or the column cannot be selected or referred to. */
    return trimmed || `column_${position + 1}`
  })

  const rows = cells
    /* A trailing newline produces a final row of one empty cell. Dropping it here rather than
       trimming the input, because a *genuinely* empty row in the middle of a file is data. */
    .filter((entry) => entry.length > 1 || (entry[0] ?? '').trim() !== '')
    .map((entry) => {
      const record = {}
      header.forEach((name, position) => {
        record[name] = (entry[position] ?? '').trim()
      })
      return record
    })

  return { columns: header, rows }
}

/* --- the query ------------------------------------------------------------- */

const COMPARATORS = ['<=', '>=', '<>', '!=', '=', '<', '>']

/**
 * Run a SELECT over parsed rows.
 *
 * @returns `{columns, rows, error, note}` -- `error` set means show nothing, `note` means the result
 *   is real but something about it is worth saying.
 */
export function runQuery(query, { columns, rows }) {
  const text = String(query ?? '').trim().replace(/;\s*$/, '')
  if (!text) {
    /* No query is not an error: it is the state a table starts in, and the whole CSV is the honest
       answer to "show me this table". */
    return limit({ columns, rows: rows ?? [] })
  }

  if (!/^select\b/i.test(text)) {
    return fail(
      'Only SELECT is supported. This is a drawing of a table, so there is nothing here to write to.',
    )
  }

  const parsed = split(text)
  if (parsed.error) return fail(parsed.error)

  const projection = projectionOf(parsed.select, columns)
  if (projection.error) return fail(projection.error)

  let out = rows ?? []

  if (parsed.where) {
    const predicate = compile(parsed.where, columns)
    if (predicate.error) return fail(predicate.error)
    out = out.filter((row) => predicate.test(row))
  }

  let note = null
  if (parsed.orderBy) {
    const { column, descending } = parsed.orderBy
    if (!columns.includes(column)) {
      return fail(unknownColumn(column, columns))
    }
    /* Copied before sorting: `rows` is the parsed CSV and is shared with every other query run against
       it, so an in-place sort would reorder the source and make the *next* query's unsorted result
       depend on this one. */
    out = [...out].sort((a, b) => compare(a[column], b[column]) * (descending ? -1 : 1))
  }

  if (parsed.limit !== null) {
    if (out.length > parsed.limit) note = `Showing ${parsed.limit} of ${out.length} matching rows.`
    out = out.slice(0, parsed.limit)
  }

  const shaped = out.map((row) => {
    const record = {}
    for (const field of projection.fields) record[field.alias] = row[field.column]
    return record
  })

  return limit({ columns: projection.fields.map((field) => field.alias), rows: shaped, note })
}

const fail = (error) => ({ columns: [], rows: [], error, note: null })

/* The row ceiling, applied last and reported. A node cannot usefully show a thousand rows, and a
   reader has to know they are looking at the top of something longer rather than all of it. */
function limit({ columns, rows, note = null }) {
  if (rows.length <= MAX_ROWS) return { columns, rows, error: null, note }
  return {
    columns,
    rows: rows.slice(0, MAX_ROWS),
    error: null,
    note: note ?? `Showing the first ${MAX_ROWS} of ${rows.length} rows.`,
  }
}

/**
 * Break a statement into its clauses.
 *
 * A scan for keywords at the top level rather than a regex over the whole statement, because a
 * keyword can appear *inside* a quoted value -- `WHERE plan LIKE '%order by%'` is a legitimate query
 * that a regex split would tear in half.
 */
function split(text) {
  const upper = text.toUpperCase()
  const marks = []
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "'") quoted = !quoted
    if (quoted) continue
    for (const word of ['FROM', 'WHERE', 'ORDER BY', 'LIMIT', 'GROUP BY', 'HAVING', 'JOIN']) {
      if (!upper.startsWith(word, index)) continue
      /* Word boundaries, or `FROM` matches inside a column called `from_email`. */
      const before = index === 0 || /[\s(),]/.test(text[index - 1])
      const after = index + word.length >= text.length || /[\s(*]/.test(text[index + word.length])
      if (before && after) marks.push({ word, index })
    }
  }

  for (const mark of marks) {
    if (mark.word === 'GROUP BY' || mark.word === 'HAVING' || mark.word === 'JOIN') {
      return {
        error: `${mark.word} is not supported. There is one table here, made from one CSV — so there is nothing to join and nothing to aggregate across.`,
      }
    }
  }

  const at = (word) => marks.find((mark) => mark.word === word)?.index ?? -1
  const from = at('FROM')
  const where = at('WHERE')
  const order = at('ORDER BY')
  const lim = at('LIMIT')

  const bounds = [from, where, order, lim].filter((index) => index > 0)
  const selectEnd = bounds.length ? Math.min(...bounds) : text.length
  const select = text.slice(6, selectEnd).trim()
  if (!select) return { error: 'SELECT needs at least one column, or *.' }

  const nextAfter = (start) =>
    Math.min(
      ...[where, order, lim, text.length].filter((index) => index > start).concat(text.length),
    )

  const parsedLimit = lim > 0 ? Number(text.slice(lim + 5).trim()) : null
  if (lim > 0 && (!Number.isInteger(parsedLimit) || parsedLimit < 0)) {
    return { error: 'LIMIT needs a whole number.' }
  }

  let orderBy = null
  if (order > 0) {
    const clause = text.slice(order + 8, nextAfter(order)).trim()
    const parts = clause.split(/\s+/)
    if (!parts[0]) return { error: 'ORDER BY needs a column.' }
    orderBy = { column: unquote(parts[0]), descending: /^desc$/i.test(parts[1] ?? '') }
  }

  return {
    select,
    where: where > 0 ? text.slice(where + 5, nextAfter(where)).trim() : null,
    orderBy,
    limit: parsedLimit,
  }
}

/** `SELECT a, b AS c, *` -> the fields to show, or an error naming a column that is not there. */
function projectionOf(select, columns) {
  if (select.trim() === '*') {
    return { fields: columns.map((column) => ({ column, alias: column })) }
  }

  const fields = []
  for (const raw of splitTopLevel(select)) {
    const piece = raw.trim()
    if (!piece) continue
    const [, column, alias] = piece.match(/^(.+?)(?:\s+as\s+(.+))?$/i) ?? []
    const name = unquote((column ?? '').trim())
    if (!columns.includes(name)) return { error: unknownColumn(name, columns) }
    fields.push({ column: name, alias: unquote((alias ?? name).trim()) })
  }
  if (!fields.length) return { error: 'SELECT needs at least one column, or *.' }
  return { fields }
}

/**
 * Compile a WHERE clause into a predicate.
 *
 * Recursive descent over OR, then AND, then parentheses, then one comparison -- which is the whole
 * grammar. Returning `{error}` rather than throwing, so a half-typed query shows a message under the
 * field instead of unmounting the panel.
 */
function compile(clause, columns) {
  const text = clause.trim()
  if (!text) return { error: 'WHERE needs a condition.' }

  const or = splitOperator(text, 'OR')
  if (or.length > 1) {
    const parts = or.map((part) => compile(part, columns))
    const broken = parts.find((part) => part.error)
    if (broken) return broken
    return { test: (row) => parts.some((part) => part.test(row)) }
  }

  const and = splitOperator(text, 'AND')
  if (and.length > 1) {
    const parts = and.map((part) => compile(part, columns))
    const broken = parts.find((part) => part.error)
    if (broken) return broken
    return { test: (row) => parts.every((part) => part.test(row)) }
  }

  if (text.startsWith('(') && text.endsWith(')')) {
    return compile(text.slice(1, -1), columns)
  }

  return comparison(text, columns)
}

function comparison(text, columns) {
  const nullMatch = text.match(/^(.+?)\s+is\s+(not\s+)?null$/i)
  if (nullMatch) {
    const column = unquote(nullMatch[1].trim())
    if (!columns.includes(column)) return { error: unknownColumn(column, columns) }
    const negated = Boolean(nullMatch[2])
    /* A CSV has no NULL -- it has an empty cell. Treating empty as null is the only reading that makes
       `IS NULL` useful on this data, and it is stated in the help text so it is not a surprise. */
    return { test: (row) => (isBlank(row[column]) ? !negated : negated) }
  }

  const inMatch = text.match(/^(.+?)\s+(not\s+)?in\s*\((.*)\)$/i)
  if (inMatch) {
    const column = unquote(inMatch[1].trim())
    if (!columns.includes(column)) return { error: unknownColumn(column, columns) }
    const negated = Boolean(inMatch[2])
    const values = splitTopLevel(inMatch[3]).map((value) => unquote(value.trim()).toLowerCase())
    return {
      test: (row) => {
        const found = values.includes(String(row[column] ?? '').toLowerCase())
        return negated ? !found : found
      },
    }
  }

  const likeMatch = text.match(/^(.+?)\s+(not\s+)?like\s+(.+)$/i)
  if (likeMatch) {
    const column = unquote(likeMatch[1].trim())
    if (!columns.includes(column)) return { error: unknownColumn(column, columns) }
    const negated = Boolean(likeMatch[2])
    const pattern = likePattern(unquote(likeMatch[3].trim()))
    return {
      test: (row) => {
        const found = pattern.test(String(row[column] ?? ''))
        return negated ? !found : found
      },
    }
  }

  for (const operator of COMPARATORS) {
    const at = indexOfTopLevel(text, operator)
    if (at < 0) continue
    const column = unquote(text.slice(0, at).trim())
    const literal = unquote(text.slice(at + operator.length).trim())
    if (!columns.includes(column)) return { error: unknownColumn(column, columns) }
    return { test: (row) => evaluate(row[column], operator, literal) }
  }

  return {
    error: `Could not read “${text}”. Supported comparisons are ${COMPARATORS.join(' ')}, LIKE, IN and IS NULL.`,
  }
}

function evaluate(actual, operator, literal) {
  const left = String(actual ?? '')
  /* Numeric when *both* sides look numeric, textual otherwise. Deciding per comparison rather than
     per column, because a CSV column can hold `12` and `unknown` and there is no answer that is right
     for the whole column -- what matters is that `total > 100` compares numbers and `plan > 'b'`
     compares text. */
  const asNumbers = isNumeric(left) && isNumeric(literal)
  const a = asNumbers ? Number(left) : left.toLowerCase()
  const b = asNumbers ? Number(literal) : literal.toLowerCase()

  switch (operator) {
    case '=':
      return a === b
    case '!=':
    case '<>':
      return a !== b
    case '>':
      return a > b
    case '>=':
      return a >= b
    case '<':
      return a < b
    default:
      return a <= b
  }
}

/* SQL's `%` and `_`, with everything else escaped so a value containing `.` or `(` is matched
   literally rather than as a regex. */
function likePattern(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')
}

function compare(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (isNumeric(left) && isNumeric(right)) return Number(left) - Number(right)
  return left.localeCompare(right)
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === ''
const isNumeric = (value) => !isBlank(value) && Number.isFinite(Number(value))

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length > 1 && /^['"`[]/.test(text)) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * A column name that is not in the CSV, with the nearest match when there is one.
 *
 * The reason this parser exists rather than a general SQL engine: a real engine can say "no such
 * column: emial", and this can say "did you mean email". On a hand-typed query against a
 * hand-pasted CSV, the typo is the overwhelmingly likely cause.
 */
function unknownColumn(name, columns) {
  const near = nearest(name, columns)
  if (near) return `There is no column “${name}”. Did you mean “${near}”?`
  return `There is no column “${name}”. This table has: ${columns.join(', ') || 'no columns yet'}.`
}

/**
 * The closest column name to `name`, or null when nothing is close enough.
 *
 * Edit distance, not a normalised-string comparison. The first version compared case and stripped
 * underscores, which catches `Email` and `e_mail` and misses `emial` -- and a transposition is the most
 * common typo there is, so it missed the case the suggestion exists for.
 *
 * Damerau-Levenshtein rather than plain Levenshtein, because a *transposition* is the commonest typo
 * there is and plain Levenshtein charges two edits for it -- so `emial` scored 2 against `email` and
 * fell outside the threshold, missing the exact case the suggestion exists for.
 *
 * The threshold scales with length: one edit in a four-letter name is a quarter of it and might be a
 * different column entirely, where two edits in `anonymous_id` is obviously the same word. Capped at
 * two, because beyond that "did you mean" starts guessing.
 */
function nearest(name, columns) {
  const needle = String(name ?? '').toLowerCase()
  if (!needle) return null

  let best = null
  let bestDistance = Infinity
  for (const column of columns) {
    const distance = editDistance(needle, column.toLowerCase())
    if (distance < bestDistance) {
      best = column
      bestDistance = distance
    }
  }
  const allowed = Math.min(2, Math.max(1, Math.floor(needle.length / 4)))
  return bestDistance <= allowed ? best : null
}

/*
 * Damerau-Levenshtein: insertions, deletions, substitutions, and adjacent transpositions, each costing
 * one.
 *
 * Three rows rather than two, because a transposition needs the row *before* the previous one. Column
 * names are short and there are few of them, so this is written carefully only because it runs on every
 * keystroke in the query field and a full matrix allocation there would be real work for no reason.
 */
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let twoBack = null
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      /* The transposition case: this character and the last one are the previous two, swapped. */
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], twoBack[j - 2] + 1)
      }
    }
    twoBack = previous
    previous = current
  }
  return previous[b.length]
}

/* Split on commas that are not inside quotes or parentheses. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let quoted = false
  let current = ''
  for (const char of String(text ?? '')) {
    if (char === "'") quoted = !quoted
    if (!quoted && char === '(') depth += 1
    if (!quoted && char === ')') depth -= 1
    if (char === ',' && !quoted && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/* Split on a keyword at paren depth zero and outside quotes. */
function splitOperator(text, keyword) {
  const upper = text.toUpperCase()
  const parts = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'") quoted = !quoted
    if (!quoted && char === '(') depth += 1
    if (!quoted && char === ')') depth -= 1
    if (quoted || depth !== 0) continue
    if (!upper.startsWith(keyword, index)) continue
    const before = index === 0 || /\s|\)/.test(text[index - 1])
    const after = /\s|\(/.test(text[index + keyword.length] ?? ' ')
    if (!before || !after) continue
    parts.push(text.slice(start, index))
    start = index + keyword.length
    index += keyword.length - 1
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/* The index of an operator at paren depth zero and outside quotes, or -1. */
function indexOfTopLevel(text, operator) {
  let depth = 0
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'") quoted = !quoted
    if (!quoted && char === '(') depth += 1
    if (!quoted && char === ')') depth -= 1
    if (quoted || depth !== 0) continue
    if (text.startsWith(operator, index)) return index
  }
  return -1
}
