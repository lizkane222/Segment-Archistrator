/*
 * Pasted data, made into table cells.
 *
 * Filling a table cell by cell is nine double-clicks for a three-by-three and nothing anyone would do for
 * forty rows. The data is nearly always already somewhere else -- a spreadsheet, a query result, a JSON body
 * out of an API response -- so this reads whatever was copied and says what grid it makes.
 *
 * ## What it reads
 *
 *   - **JSON**: an array of objects (keys become the header, nested objects flatten to `a.b` columns), an
 *     array of arrays, an array of plain values, a single object (a key / value pair per row), or the
 *     comma-separated body with its brackets left off.
 *   - **Delimited text**: CSV with quoted fields, tab-separated (what a spreadsheet copies), semicolon or
 *     pipe separated, and any separator you name. The rows can be split on something other than a new line
 *     too -- a list pasted as `a, b, c` is one row of three, or a column of three.
 *
 * Everything is a function of the text and the options, and returns strings: the table stores text, and
 * deciding what a `42` means is not a table's job. Pure, like `tables.js`, so it can be tested without a
 * browser.
 */

import { DEFAULT_COLUMN_WIDTH, MIN_COLUMN, normalizeTable } from './tables.js'

/* More than this is a paste that went wrong (the wrong clipboard, a whole log file), and a table that
   size is not something this canvas can draw usefully. */
export const MAX_ROWS = 500
export const MAX_COLUMNS = 40

export const DELIMITERS = {
  auto: { label: 'Detect' },
  comma: { label: 'Comma ,', value: ',' },
  tab: { label: 'Tab', value: '\t' },
  semicolon: { label: 'Semicolon ;', value: ';' },
  pipe: { label: 'Pipe |', value: '|' },
  space: { label: 'Spaces', value: ' ' },
  custom: { label: 'Other…' },
}

export const DEFAULT_OPTIONS = Object.freeze({
  format: 'auto', // auto | json | text
  delimiter: 'auto',
  custom: '',
  rowSeparator: 'newline', // newline | custom
  customRows: '',
  /* null: decide from the data. true/false: what the reader said. */
  header: null,
  trim: true,
  skipEmpty: true,
  transpose: false,
  flatten: true,
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `\t` and `\n` typed into a box mean a tab and a new line, which cannot be typed into one. */
const unescape = (text) => String(text).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r')

/** A cell's text: strings bare, everything else as JSON, null and undefined empty. */
function cellOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/* --- JSON ------------------------------------------------------------------- */

function flattenKeys(value, prefix, out) {
  if (isPlainObject(value) && Object.keys(value).length) {
    for (const [key, inner] of Object.entries(value)) flattenKeys(inner, prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value
  }
  return out
}

/** Parse JSON, or the same with its brackets left off (`{"a":1},{"a":2}` or `"x","y"`). Null when neither. */
export function parseJsonLoosely(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return { value: JSON.parse(trimmed), wrapped: false }
  } catch {
    /* fall through */
  }
  try {
    return { value: JSON.parse(`[${trimmed.replace(/,\s*$/, '')}]`), wrapped: true }
  } catch {
    return null
  }
}

function rowsFromJson(value, { flatten }) {
  if (Array.isArray(value)) {
    if (value.length && value.every(isPlainObject)) {
      const records = value.map((record) => (flatten ? flattenKeys(record, '', {}) : record))
      const keys = []
      for (const record of records) for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key)
      return { rows: [keys, ...records.map((record) => keys.map((key) => cellOf(record[key])))], header: true }
    }
    if (value.length && value.every(Array.isArray)) {
      return { rows: value.map((row) => row.map(cellOf)), header: null }
    }
    return { rows: value.map((item) => [cellOf(item)]), header: false }
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    /* An object of objects -- `{"u1": {...}, "u2": {...}}` -- is a table keyed by its own keys. */
    if (entries.length && entries.every(([, inner]) => isPlainObject(inner))) {
      const records = entries.map(([, inner]) => (flatten ? flattenKeys(inner, '', {}) : inner))
      const keys = []
      for (const record of records) for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key)
      return {
        rows: [['key', ...keys], ...entries.map(([key], index) => [key, ...keys.map((name) => cellOf(records[index][name]))])],
        header: true,
      }
    }
    const flat = flatten ? flattenKeys(value, '', {}) : value
    return { rows: [['key', 'value'], ...Object.entries(flat).map(([key, inner]) => [key, cellOf(inner)])], header: true }
  }
  return { rows: [[cellOf(value)]], header: false }
}

/* --- delimited text --------------------------------------------------------- */

/**
 * Split text into records and fields, honouring double quotes: a quoted field may contain the delimiter,
 * new lines, and `""` for a quote -- which is what a spreadsheet writes when a cell has a comma in it.
 */
function parseQuoted(text, delimiter, recordSeparator) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let touched = false
  const endField = () => {
    row.push(field)
    field = ''
    touched = false
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && !touched) {
      quoted = true
      touched = true
    } else if (delimiter && text.startsWith(delimiter, i)) {
      endField()
      i += delimiter.length - 1
    } else if (recordSeparator && text.startsWith(recordSeparator, i)) {
      endRow()
      i += recordSeparator.length - 1
    } else {
      field += char
      touched = true
    }
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/** The delimiter a block of text most plausibly uses: the one that splits the first lines evenly. */
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8)
  if (!lines.length) return null
  let best = null
  let bestScore = 0
  for (const key of ['tab', 'comma', 'semicolon', 'pipe']) {
    const delimiter = DELIMITERS[key].value
    const counts = lines.map((line) => line.split(delimiter).length - 1)
    if (counts[0] === 0) continue
    /* Consistent across lines beats merely frequent: a sentence with commas in it is not a CSV. */
    const consistent = counts.every((count) => count === counts[0])
    const score = counts[0] * (consistent ? 2 : 1) + (lines.length === 1 ? 0 : consistent ? 5 : 0)
    if (score > bestScore) {
      best = key
      bestScore = score
    }
  }
  return best
}

function rowsFromText(text, options) {
  const recordSeparator = options.rowSeparator === 'custom' && options.customRows ? unescape(options.customRows) : null
  let key = options.delimiter
  let delimiter = null
  if (key === 'auto') key = detectDelimiter(text)
  if (key === 'custom') delimiter = options.custom ? unescape(options.custom) : null
  else if (key && key !== 'space') delimiter = DELIMITERS[key].value

  /* A custom row separator is not quote-aware (a new line is what a quote is guarding), so the text is
     cut on it first and each record read on its own. */
  let rows
  if (recordSeparator) {
    rows = text.split(recordSeparator).map((record) =>
      key === 'space' ? record.trim().split(/\s+/) : delimiter ? parseQuoted(record, delimiter, null)[0] ?? [] : [record],
    )
  } else if (key === 'space') {
    rows = text.split(/\r?\n/).map((line) => (line.trim() ? line.trim().split(/\s+/) : []))
  } else if (delimiter) {
    rows = parseQuoted(text.replace(/\r\n?/g, '\n'), delimiter, '\n')
  } else {
    rows = text.split(/\r?\n/).map((line) => [line])
  }
  return { rows, key }
}

/* --- the whole read ---------------------------------------------------------- */

const looksNumeric = (cell) => cell !== '' && Number.isFinite(Number(cell))

/** Whether the first row reads as a header: all text, none numeric, with data under it. */
export function guessHeader(rows) {
  if (rows.length < 2) return false
  const first = rows[0]
  return first.length > 0 && first.every((cell) => cell !== '' && !looksNumeric(cell))
}

/**
 * @returns `{rows, header, format, delimiter, problems}` -- `rows` a rectangular array of strings.
 */
export function parsePaste(text, given = {}) {
  const options = { ...DEFAULT_OPTIONS, ...given }
  const problems = []
  const source = String(text ?? '')
  if (!source.trim()) return { rows: [], header: false, format: null, delimiter: null, problems }

  let rows
  let header = null
  let format = 'text'
  let delimiter = null

  const asJson = options.format === 'text' ? null : parseJsonLoosely(source)
  const startsLikeJson = /^\s*[[{"]/.test(source)
  if (asJson && (options.format === 'json' || startsLikeJson)) {
    const read = rowsFromJson(asJson.value, options)
    rows = read.rows
    header = read.header
    format = 'json'
  } else {
    if (options.format === 'json') problems.push('That is not valid JSON, so it was read as text instead.')
    const read = rowsFromText(source, options)
    rows = read.rows
    delimiter = read.key
  }

  if (options.trim) rows = rows.map((row) => row.map((cell) => String(cell).trim()))
  if (options.skipEmpty) rows = rows.filter((row) => row.some((cell) => cell !== ''))

  if (options.transpose) {
    const width = Math.max(0, ...rows.map((row) => row.length))
    rows = Array.from({ length: width }, (_, column) => rows.map((row) => row[column] ?? ''))
  }

  let truncated = false
  if (rows.length > MAX_ROWS) {
    rows = rows.slice(0, MAX_ROWS)
    truncated = true
  }
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...rows.map((row) => row.length)))
  if (rows.some((row) => row.length > MAX_COLUMNS)) truncated = true
  rows = rows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ''))
  if (truncated) problems.push(`Only the first ${MAX_ROWS} rows and ${MAX_COLUMNS} columns were kept.`)

  const decided = options.header === null ? (header === null ? guessHeader(rows) : header && !options.transpose) : options.header
  return { rows, header: Boolean(decided), format, delimiter, problems }
}

/* --- into a table ------------------------------------------------------------ */

const widthFor = (cells) => {
  const longest = Math.min(40, Math.max(0, ...cells.map((cell) => String(cell).length)))
  return Math.max(MIN_COLUMN, Math.min(260, Math.max(DEFAULT_COLUMN_WIDTH * 0.7, longest * 7 + 24)))
}

const cellFor = (text) => (text ? { text } : {})

/**
 * The table with `rows` put into it.
 *
 * `replace` makes a new grid sized to the data. `rows` adds the data under what is there, and `columns`
 * beside it; both leave the existing cells, heights and header alone and grow the grid where the new data
 * is bigger than it.
 */
export function applyRows(existing, rows, { mode = 'replace', header = false } = {}) {
  if (!rows.length) return existing
  const columnCount = Math.max(...rows.map((row) => row.length))

  if (mode === 'replace') {
    return {
      columns: Array.from({ length: columnCount }, (_, column) => Math.round(widthFor(rows.map((row) => row[column] ?? '')))),
      rows: rows.map(() => null),
      cells: rows.map((row) => Array.from({ length: columnCount }, (_, column) => cellFor(row[column] ?? ''))),
      ...(header ? { header: true } : {}),
    }
  }

  const table = normalizeTable(existing)
  if (mode === 'rows') {
    const width = Math.max(table.columns.length, columnCount)
    const columns = [
      ...table.columns,
      ...Array.from({ length: width - table.columns.length }, (_, i) =>
        Math.round(widthFor(rows.map((row) => row[table.columns.length + i] ?? ''))),
      ),
    ]
    const pad = (cells) => [...cells, ...Array.from({ length: width - cells.length }, () => ({}))]
    return {
      ...table,
      columns,
      rows: [...table.rows, ...rows.map(() => null)],
      cells: [...table.cells.map(pad), ...rows.map((row) => Array.from({ length: width }, (_, column) => cellFor(row[column] ?? '')))],
    }
  }

  /* columns: beside what is there */
  const height = Math.max(table.rows.length, rows.length)
  const added = Array.from({ length: columnCount }, (_, column) => Math.round(widthFor(rows.map((row) => row[column] ?? ''))))
  return {
    ...table,
    columns: [...table.columns, ...added],
    rows: Array.from({ length: height }, (_, index) => table.rows[index] ?? null),
    cells: Array.from({ length: height }, (_, row) => [
      ...(table.cells[row] ?? table.columns.map(() => ({}))),
      ...Array.from({ length: columnCount }, (_, column) => cellFor(rows[row]?.[column] ?? '')),
    ]),
  }
}
