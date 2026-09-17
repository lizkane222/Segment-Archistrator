/*
 * The table model.
 *
 * Two properties carry most of the weight:
 *
 *   - `rows: null` means auto, and has to *stay* null through every other edit. It is what makes a
 *     row grow to fit its text with no measuring, and the moment something writes a number into it
 *     the row stops growing -- silently, and only for that row.
 *   - a cell typed into and never formatted stores a plain string, not a tree of runs. Otherwise
 *     every table in every diagram carries a nest of objects for a word, and the fingerprint
 *     changes shape the first time anyone touches one.
 *
 * And every function is total: these are called from pointer handlers, where the alternative to a
 * no-op on a bad index is a canvas that unmounts mid-drag.
 */

import { describe, expect, it } from 'vitest'

import { applyMark, richFromText } from './richText.js'
import {
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN,
  MIN_ROW,
  canRemoveColumn,
  canRemoveRow,
  cellRich,
  cellText,
  columnCount,
  insertColumn,
  insertRow,
  newTable,
  nextCell,
  normalizeTable,
  removeColumn,
  removeRow,
  resizeColumn,
  resizeRow,
  rowCount,
  scaleTable,
  setCell,
  tableSize,
  tableText,
} from './tables.js'

describe('newTable', () => {
  it('is three by three with a header, and every row on auto', () => {
    const table = newTable()
    expect(columnCount(table)).toBe(3)
    expect(rowCount(table)).toBe(3)
    expect(table.rows).toEqual([null, null, null])
    expect(table.header).toBe(true)
    expect(table.columns).toEqual([DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH])
  })

  it('takes a size', () => {
    const table = newTable({ rows: 2, columns: 5, header: false })
    expect([rowCount(table), columnCount(table)]).toEqual([2, 5])
    expect('header' in table).toBe(false)
  })

  it('never produces a table with nothing in it', () => {
    expect(rowCount(newTable({ rows: 0, columns: 0 }))).toBe(1)
    expect(columnCount(newTable({ rows: 0, columns: 0 }))).toBe(1)
  })

  it('gives every cell its own object', () => {
    const table = newTable({ rows: 2, columns: 2 })
    expect(table.cells[0][0]).not.toBe(table.cells[0][1])
    expect(table.cells[0][0]).not.toBe(table.cells[1][0])
  })
})

describe('normalizeTable', () => {
  /* A table arrives out of a saved document that a different build may have written, and a `cells`
     array one row short is a renderer reading `undefined[0]`. */
  it('fills in cells a stored table is missing', () => {
    const table = normalizeTable({ columns: [100, 100], rows: [null, null], cells: [[{ text: 'a' }]] })
    expect(table.cells).toHaveLength(2)
    expect(table.cells[0]).toHaveLength(2)
    expect(table.cells[1]).toHaveLength(2)
    expect(table.cells[0][0]).toEqual({ text: 'a' })
  })

  it('takes the row count from whichever of rows and cells is longer', () => {
    expect(rowCount({ columns: [100], rows: [null], cells: [[{}], [{}], [{}]] })).toBe(3)
  })

  it('rounds and floors the sizes, so a drag cannot store a sliver', () => {
    const table = normalizeTable({ columns: [10, 120.4], rows: [4, 44.6], cells: [] })
    expect(table.columns).toEqual([MIN_COLUMN, 120])
    expect(table.rows).toEqual([MIN_ROW, 45])
  })

  it('keeps auto as auto through every representation of absent', () => {
    const table = normalizeTable({ columns: [100], rows: [null, undefined, ''], cells: [] })
    expect(table.rows).toEqual([null, null, null])
  })

  it('survives being handed nothing at all', () => {
    const table = normalizeTable(undefined)
    expect(columnCount(table)).toBe(3)
    expect(rowCount(table)).toBe(3)
  })
})

describe('setCell and reading it back', () => {
  const table = () => newTable({ rows: 2, columns: 2 })

  /* The property that keeps a typed-in table small: plain text stays a string. */
  it('stores unformatted text as plain text', () => {
    const next = setCell(table(), 0, 0, { text: 'Region' })
    expect(next.cells[0][0]).toEqual({ text: 'Region' })
    expect(cellText(next, 0, 0)).toBe('Region')
  })

  it('stores formatted text as runs', () => {
    const rich = applyMark(richFromText('Region'), 0, 6, 'b')
    const next = setCell(table(), 0, 0, { rich, text: 'Region' })
    expect(next.cells[0][0].rich).toEqual(rich)
    expect(cellText(next, 0, 0)).toBe('Region')
  })

  it('stores an emptied cell as empty rather than as an empty string', () => {
    const filled = setCell(table(), 0, 0, { text: 'x' })
    expect(setCell(filled, 0, 0, { text: '' }).cells[0][0]).toEqual({})
  })

  it('takes the text from the rich value when it is not given one', () => {
    const next = setCell(table(), 1, 1, { rich: richFromText('EU') })
    expect(cellText(next, 1, 1)).toBe('EU')
  })

  it('leaves every other cell alone, and the original untouched', () => {
    const before = table()
    const next = setCell(before, 0, 1, { text: 'x' })
    expect(cellText(next, 0, 0)).toBe('')
    expect(cellText(before, 0, 1)).toBe('')
  })

  it('ignores a cell that is not there', () => {
    const before = table()
    expect(setCell(before, 9, 9, { text: 'x' })).toBe(before)
  })

  it('hands the editor a rich value whichever way the cell was stored', () => {
    const plain = setCell(table(), 0, 0, { text: 'Region' })
    expect(cellRich(plain, 0, 0)).toEqual(richFromText('Region'))
    expect(cellRich(table(), 1, 1)).toEqual(richFromText(''))
  })
})

describe('tableText', () => {
  it('reads the cells in order, so a table is findable by what is in it', () => {
    let table = newTable({ rows: 2, columns: 2 })
    table = setCell(table, 0, 0, { text: 'Region' })
    table = setCell(table, 0, 1, { text: 'MTU' })
    table = setCell(table, 1, 0, { text: 'EU' })
    expect(tableText(table)).toBe('Region MTU · EU')
  })

  it('is empty for an empty table, rather than a row of separators', () => {
    expect(tableText(newTable())).toBe('')
  })
})

describe('tableSize', () => {
  it('is exact across, and a floor down', () => {
    const table = { columns: [100, 60], rows: [null, 50], cells: [] }
    /* Width is the sum of the columns and nothing else knows better. Height counts an auto row at
       the minimum, because only the DOM knows how tall its text is -- the caller uses this as the
       node's floor and lets the content grow the rest. */
    expect(tableSize(table)).toEqual({ width: 160, height: MIN_ROW + 50 })
  })
})

describe('resizeColumn', () => {
  it('changes only the column dragged, so the table grows with it', () => {
    const table = newTable({ rows: 1, columns: 3 })
    const next = resizeColumn(table, 1, 200)
    expect(next.columns).toEqual([DEFAULT_COLUMN_WIDTH, 200, DEFAULT_COLUMN_WIDTH])
    expect(tableSize(next).width).toBe(DEFAULT_COLUMN_WIDTH * 2 + 200)
  })

  it('will not drag a column below the floor', () => {
    expect(resizeColumn(newTable(), 0, 4).columns[0]).toBe(MIN_COLUMN)
  })

  it('rounds, and returns an unchanged table for a no-op drag', () => {
    const table = newTable({ rows: 1, columns: 1 })
    expect(resizeColumn(table, 0, 140.6).columns[0]).toBe(141)
    expect(resizeColumn(table, 5, 200)).toBe(table)
  })
})

describe('resizeRow', () => {
  it('sets an explicit height, which is the user overriding auto', () => {
    expect(resizeRow(newTable(), 1, 80).rows).toEqual([null, 80, null])
  })

  /* Without a way back to auto, one accidental drag freezes a row at a height its text then
     overflows, and nothing on screen says why the text is cut off. */
  it('hands a row back to its content when set to null', () => {
    const fixed = resizeRow(newTable(), 1, 80)
    expect(resizeRow(fixed, 1, null).rows).toEqual([null, null, null])
  })

  it('will not drag a row below the floor', () => {
    expect(resizeRow(newTable(), 0, 2).rows[0]).toBe(MIN_ROW)
  })
})

describe('scaleTable', () => {
  it('scales the columns in proportion', () => {
    const table = { columns: [100, 100], rows: [null], cells: [] }
    const next = scaleTable(table, { width: 200, height: 40 }, { width: 300, height: 40 })
    expect(next.columns).toEqual([150, 150])
  })

  /* The one that would be invisible: an auto row given a number stops growing with its text, so
     resizing the node sideways would freeze every row's height as a side effect. */
  it('leaves an auto row on auto', () => {
    const table = { columns: [100], rows: [null, 50], cells: [] }
    const next = scaleTable(table, { width: 100, height: 100 }, { width: 100, height: 200 })
    expect(next.rows[0]).toBe(null)
    expect(next.rows[1]).toBe(100)
  })

  it('does nothing when the box has not changed, or is not measurable yet', () => {
    const table = newTable()
    expect(scaleTable(table, { width: 100, height: 100 }, { width: 100, height: 100 })).toEqual(
      normalizeTable(table),
    )
    expect(scaleTable(table, { width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(
      normalizeTable(table),
    )
  })
})

describe('insertRow and insertColumn', () => {
  it('inserts a row of empty cells, on auto', () => {
    const table = insertRow(newTable({ rows: 2, columns: 2 }), 1)
    expect(rowCount(table)).toBe(3)
    expect(table.rows[1]).toBe(null)
    expect(table.cells[1]).toEqual([{}, {}])
  })

  it('appends when the index is the count', () => {
    const table = newTable({ rows: 2, columns: 2 })
    expect(rowCount(insertRow(table, 2))).toBe(3)
  })

  it('keeps the cells in the rows they were in', () => {
    let table = newTable({ rows: 2, columns: 1 })
    table = setCell(table, 0, 0, { text: 'first' })
    table = setCell(table, 1, 0, { text: 'second' })
    const next = insertRow(table, 1)
    expect([cellText(next, 0, 0), cellText(next, 1, 0), cellText(next, 2, 0)]).toEqual([
      'first',
      '',
      'second',
    ])
  })

  it('inserts a column into every row at once', () => {
    let table = newTable({ rows: 2, columns: 2 })
    table = setCell(table, 0, 1, { text: 'right' })
    const next = insertColumn(table, 1)
    expect(columnCount(next)).toBe(3)
    expect(next.cells.every((row) => row.length === 3)).toBe(true)
    expect(cellText(next, 0, 2)).toBe('right')
  })

  it('gives a new column the width of the one beside it', () => {
    const table = { columns: [60, 60], rows: [null], cells: [[{}, {}]] }
    expect(insertColumn(table, 1).columns).toEqual([60, 60, 60])
  })
})

describe('removeRow and removeColumn', () => {
  it('takes a row out with its cells', () => {
    let table = newTable({ rows: 3, columns: 1 })
    table = setCell(table, 2, 0, { text: 'last' })
    const next = removeRow(table, 1)
    expect(rowCount(next)).toBe(2)
    expect(cellText(next, 1, 0)).toBe('last')
  })

  it('takes a column out of every row', () => {
    let table = newTable({ rows: 2, columns: 3 })
    table = setCell(table, 0, 2, { text: 'third' })
    const next = removeColumn(table, 1)
    expect(next.columns).toHaveLength(2)
    expect(cellText(next, 0, 1)).toBe('third')
  })

  /* A table with no rows has nothing to click on and no way back -- it would have to be deleted
     and redrawn -- so one of each is the floor, and the menu greys the item there. */
  it('keeps the last row and the last column', () => {
    const single = newTable({ rows: 1, columns: 1 })
    expect(rowCount(removeRow(single, 0))).toBe(1)
    expect(columnCount(removeColumn(single, 0))).toBe(1)
    expect(canRemoveRow(single)).toBe(false)
    expect(canRemoveColumn(single)).toBe(false)
    expect(canRemoveRow(newTable())).toBe(true)
  })

  it('ignores an index that is not there', () => {
    const table = newTable()
    expect(removeRow(table, 9)).toEqual(normalizeTable(table))
    expect(removeColumn(table, -1)).toEqual(normalizeTable(table))
  })
})

describe('nextCell', () => {
  const table = newTable({ rows: 2, columns: 2 })

  it('walks in reading order', () => {
    expect(nextCell(table, { row: 0, column: 0 })).toEqual({ row: 0, column: 1 })
    expect(nextCell(table, { row: 0, column: 1 })).toEqual({ row: 1, column: 0 })
  })

  it('walks backwards too', () => {
    expect(nextCell(table, { row: 1, column: 0 }, -1)).toEqual({ row: 0, column: 1 })
  })

  /* Null rather than wrapping: a Tab that jumps back to the first cell reads as the table having
     been reset. */
  it('stops at both ends', () => {
    expect(nextCell(table, { row: 1, column: 1 })).toBe(null)
    expect(nextCell(table, { row: 0, column: 0 }, -1)).toBe(null)
  })
})
