/*
 * A table on the canvas: the grid, and every edit that can be made to it.
 *
 * There was a table before this, and it was a drawing: `SHAPES.table` in shapes/geometry.js is a
 * rectangle with four lines through it. Nothing could be typed into it, so a table on a diagram
 * meant a text shape per cell, nine of them, kept in line by hand and re-aligned every time a
 * word changed. This is the same picture with the cells being real.
 *
 * ## The document
 *
 *   {columns: [120, 160, 90], rows: [null, null, 44], cells: [[{rich}, ...], ...]}
 *
 * `columns` is widths in pixels, always explicit -- a column has to be draggable, and a width
 * negotiated by content cannot be dragged to a size the content disagrees with.
 *
 * `rows` is heights, and `null` means **auto**: the row is as tall as its own wrapped text. That
 * is what makes "the row expands to fit all the text" true without any measuring. CSS already
 * knows how tall wrapped text is; a row is `auto` in the grid template, the node's box follows its
 * content, and nothing has to read `scrollHeight` and write a number back. That loop -- render,
 * measure, store, re-render -- is what SegmentNode's comment about `MAX_AUTO_NODE_WIDTH` warns
 * against: it has to be damped to stop oscillating, it bakes one browser's font metrics into the
 * saved file, and it marks the diagram dirty the moment it finishes loading. Dragging a row
 * divider sets a number, which is the user overriding the automatic height on purpose.
 *
 * `cells` is a rectangular array of `{rich}` -- the same rich value every other label uses, so a
 * cell gets bold, italic, lists and the shared toolbar for free (see canvas/richText.js).
 *
 * ## Pure, and every edit returns a new table
 *
 * Every function here takes a table and returns one, so a table edit is an ordinary node-data
 * write: it lands on the same undo stack as everything else and the same dirty check. None of them
 * mutate, and all of them are total -- an index out of range returns the table unchanged rather
 * than throwing, because these are called from pointer handlers where the alternative to a no-op
 * is a canvas that unmounts mid-drag.
 */

import { hasFormatting, richFromText, richToText } from './richText.js'

/* A column narrower than this cannot hold two characters and a padding, and a row shorter than
   this has nowhere to put a caret. Both are floors on the *drag*, not on the content: a row left
   on `auto` is as short as one empty line, which is smaller than MIN_ROW and correct. */
export const MIN_COLUMN = 40
export const MIN_ROW = 24

/* What a table arrives as. Three by three is the smallest grid that reads as a table rather than
   as a pair of boxes, and wide enough by default that the first thing typed into it does not
   immediately wrap. */
export const DEFAULT_COLUMNS = 3
export const DEFAULT_ROWS = 3
export const DEFAULT_COLUMN_WIDTH = 120

/** An empty cell. Its own object, so two cells never share one. */
const newCell = () => ({})

/**
 * A fresh table.
 *
 * `header: true` marks the first row for the renderer to draw in bold on a tint. A flag rather
 * than formatting written into the cells, because it is a statement about the *table* -- adding a
 * column has to extend the header, and a row inserted above the first has to become the header or
 * not, which is a question about structure that per-cell bold cannot answer.
 */
export function newTable({ rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS, header = true } = {}) {
  return {
    columns: Array.from({ length: Math.max(1, columns) }, () => DEFAULT_COLUMN_WIDTH),
    rows: Array.from({ length: Math.max(1, rows) }, () => null),
    cells: Array.from({ length: Math.max(1, rows) }, () =>
      Array.from({ length: Math.max(1, columns) }, newCell),
    ),
    ...(header ? { header: true } : {}),
  }
}

/**
 * A table with its shape guaranteed: as many columns as widths, as many rows as heights.
 *
 * Everything else here goes through this first, and it is not defensive programming for its own
 * sake -- a table arrives from a saved document that may have been written by a different build,
 * and a `cells` array one row short is a renderer reading `undefined[0]`. Repairing on read means
 * one place knows the invariant instead of every caller checking it.
 */
export function normalizeTable(table) {
  const columns = (table?.columns ?? []).map(toWidth)
  const width = columns.length || DEFAULT_COLUMNS
  const filledColumns = columns.length
    ? columns
    : Array.from({ length: width }, () => DEFAULT_COLUMN_WIDTH)

  const rows = (table?.rows ?? []).map(toHeight)
  const cellRows = table?.cells ?? []
  const height = Math.max(rows.length, cellRows.length) || DEFAULT_ROWS

  return {
    columns: filledColumns,
    rows: Array.from({ length: height }, (_, index) => rows[index] ?? null),
    cells: Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, column) => cellRows[row]?.[column] ?? newCell()),
    ),
    ...(table?.header ? { header: true } : {}),
  }
}

/* A stored width or height, sanitised. Rounded because a sub-pixel size produces a diff on every
   save, and floored because a zero-width column is a table with an invisible column in it. */
const toWidth = (value) => Math.max(MIN_COLUMN, Math.round(Number(value) || DEFAULT_COLUMN_WIDTH))
const toHeight = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(MIN_ROW, Math.round(number)) : null
}

export const columnCount = (table) => normalizeTable(table).columns.length
export const rowCount = (table) => normalizeTable(table).rows.length

/**
 * The box a table needs, as far as it can be known without a browser.
 *
 * The width is exact -- it is the sum of the columns. The height is a *floor*: rows on `auto` are
 * as tall as their text, which only the DOM knows, so this counts them at `MIN_ROW`. Callers use
 * it for the node's minimum size and let the content grow the rest, which is the same division of
 * labour a card already has between `data.size` and `fit-content`.
 */
export function tableSize(table) {
  const shape = normalizeTable(table)
  return {
    width: shape.columns.reduce((sum, column) => sum + column, 0),
    height: shape.rows.reduce((sum, row) => sum + (row ?? MIN_ROW), 0),
  }
}

/** One cell's rich value, or null. */
export function cellAt(table, row, column) {
  return normalizeTable(table).cells[row]?.[column] ?? null
}

/** One cell's plain text, which is what a search or an export reads. */
export function cellText(table, row, column) {
  const cell = cellAt(table, row, column)
  return cell?.text ?? richToText(cell?.rich)
}

/**
 * Every cell's text, in reading order, joined.
 *
 * What a table node puts in `data.name` -- so a table is findable by what is written in it, and so
 * the console, the minimap tooltip and the save advisories have something to call it other than
 * "table". Empty cells are skipped rather than producing a run of separators.
 */
export function tableText(table) {
  return normalizeTable(table)
    .cells.map((row) =>
      row
        .map((cell) => cell?.text ?? richToText(cell?.rich))
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' · ')
}

/**
 * Write one cell.
 *
 * Stores `rich` only when there is formatting to keep and `text` only when there is not, for the
 * same reason a node stores `nameRich` conditionally: a table typed into and never formatted has
 * to serialize the way the simplest possible model would, or every table in every diagram carries
 * a nest of runs for a word.
 */
export function setCell(table, row, column, { rich, text }) {
  const shape = normalizeTable(table)
  if (!shape.cells[row]?.[column]) return table

  const plain = text ?? richToText(rich)
  const cell = hasFormatting(rich) ? { rich } : plain ? { text: plain } : {}

  return {
    ...shape,
    cells: shape.cells.map((cells, index) =>
      index === row ? cells.map((entry, at) => (at === column ? cell : entry)) : cells,
    ),
  }
}

/** One cell as a rich value, whichever way it was stored. What the editor is seeded from. */
export function cellRich(table, row, column) {
  const cell = cellAt(table, row, column)
  return cell?.rich ?? richFromText(cell?.text ?? '')
}

/* --- resizing ---------------------------------------------------------------- */

/**
 * Set one column's width.
 *
 * The column being dragged is the only one that changes, so the table's total width changes with
 * it. The alternative -- taking the difference out of the next column -- keeps the outer edge
 * still and means the last divider cannot be dragged at all, and that dragging any divider
 * silently reshapes a column the user was not pointing at.
 */
export function resizeColumn(table, index, width) {
  const shape = normalizeTable(table)
  if (index < 0 || index >= shape.columns.length) return table
  const next = toWidth(width)
  if (shape.columns[index] === next) return shape
  return { ...shape, columns: shape.columns.map((entry, at) => (at === index ? next : entry)) }
}

/**
 * Set one row's height, or hand it back to its content.
 *
 * `null` is the interesting value: it restores `auto`, so the row goes back to being as tall as
 * its text and starts growing again when more is typed. Without a way back, one accidental drag
 * would freeze a row at a height its content then overflows.
 */
export function resizeRow(table, index, height) {
  const shape = normalizeTable(table)
  if (index < 0 || index >= shape.rows.length) return table
  const next = height === null ? null : toHeight(height)
  if (shape.rows[index] === next) return shape
  return { ...shape, rows: shape.rows.map((entry, at) => (at === index ? next : entry)) }
}

/**
 * Scale the whole grid to a new box. What dragging the node's outer edge does.
 *
 * Columns scale in proportion, so the shape of the table is kept and the outer edge stays where
 * it was dropped. Rows are scaled only if they have an explicit height -- an `auto` row has no
 * number to scale and must not acquire one here, or resizing the node sideways would freeze every
 * row's height as a side effect.
 */
export function scaleTable(table, from, to) {
  const shape = normalizeTable(table)
  const scaleX = from?.width > 0 && to?.width > 0 ? to.width / from.width : 1
  const scaleY = from?.height > 0 && to?.height > 0 ? to.height / from.height : 1
  if (scaleX === 1 && scaleY === 1) return shape

  return {
    ...shape,
    columns: shape.columns.map((column) => toWidth(column * scaleX)),
    rows: shape.rows.map((row) => (row === null ? null : toHeight(row * scaleY))),
  }
}

/* --- adding and removing ------------------------------------------------------ */

/**
 * A row inserted at `index`, or appended when that is the row count.
 *
 * The new row copies the width of nothing and the height of nothing: widths are per column, and
 * the height starts as `auto` so the row is as tall as whatever is typed into it.
 */
export function insertRow(table, index) {
  const shape = normalizeTable(table)
  const at = clamp(index, 0, shape.rows.length)
  return {
    ...shape,
    rows: insertAt(shape.rows, at, null),
    cells: insertAt(shape.cells, at, shape.columns.map(newCell)),
  }
}

export function insertColumn(table, index) {
  const shape = normalizeTable(table)
  const at = clamp(index, 0, shape.columns.length)
  return {
    ...shape,
    /* The new column takes the width of the one it was added beside rather than the default, so
       inserting into a table of narrow columns does not produce one twice their size. */
    columns: insertAt(shape.columns, at, shape.columns[Math.max(0, at - 1)] ?? DEFAULT_COLUMN_WIDTH),
    cells: shape.cells.map((row) => insertAt(row, at, newCell())),
  }
}

/**
 * A row removed. The last row is kept.
 *
 * A table with no rows has nothing to click on and no way back -- it would have to be deleted and
 * redrawn -- so the floor is one row and one column, and the menu item that calls this is disabled
 * at that point rather than this silently doing nothing.
 */
export function removeRow(table, index) {
  const shape = normalizeTable(table)
  if (shape.rows.length <= 1 || index < 0 || index >= shape.rows.length) return shape
  return {
    ...shape,
    rows: shape.rows.filter((_, at) => at !== index),
    cells: shape.cells.filter((_, at) => at !== index),
  }
}

export function removeColumn(table, index) {
  const shape = normalizeTable(table)
  if (shape.columns.length <= 1 || index < 0 || index >= shape.columns.length) return shape
  return {
    ...shape,
    columns: shape.columns.filter((_, at) => at !== index),
    cells: shape.cells.map((row) => row.filter((_, at) => at !== index)),
  }
}

/** Can a row or column be taken out? What the menu reads to grey its own item. */
export const canRemoveRow = (table) => rowCount(table) > 1
export const canRemoveColumn = (table) => columnCount(table) > 1

/* --- moving about with the keyboard ------------------------------------------ */

/**
 * The next cell in reading order, or null at the end.
 *
 * Tab through a table is the one keyboard gesture a grid of text inputs has to have: without it,
 * filling in nine cells is nine double-clicks. Null at the last cell rather than wrapping to the
 * first, because a Tab that jumps back to the top looks like the table has been reset.
 */
export function nextCell(table, { row, column }, direction = 1) {
  const shape = normalizeTable(table)
  const columns = shape.columns.length
  const index = row * columns + column + direction
  if (index < 0 || index >= columns * shape.rows.length) return null
  return { row: Math.floor(index / columns), column: index % columns }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0))

function insertAt(list, index, value) {
  const out = [...list]
  out.splice(index, 0, value)
  return out
}
