/*
 * Where the shared chrome gets drawn.
 *
 * Small, and worth its own file because the failure mode is silent: this project has no jsdom, so
 * nothing here renders, and returning `none` where it should return `portal` produces a workbench
 * with no palette and no inspector and no error anywhere to say why. The layout bug in `SplitView`
 * that shipped once was the same shape.
 */

import { describe, expect, it } from 'vitest'

import { chromePlacement, editTable } from './AppShell.jsx'
import {
  cellText,
  columnCount,
  newTable,
  resizeRow,
  rowCount,
  setCell,
} from './canvas/tables.js'

const slots = { top: {}, left: {}, right: {} }

describe('chromePlacement', () => {
  it('portals into a mounted slot for the pane that owns the chrome', () => {
    expect(chromePlacement({ chromeOwner: true, slots, slot: slots.left })).toBe('portal')
  })

  it('draws nothing at all for a pane that does not own the chrome', () => {
    /* Not `visibility: hidden`, and not a second copy portalled elsewhere: a second Inspector would
       mount a second copy of every per-kind branch against the same node and race the first one's
       edits. */
    expect(chromePlacement({ chromeOwner: false, slots, slot: slots.left })).toBe('none')
    expect(chromePlacement({ chromeOwner: false, slots: null, slot: null })).toBe('none')
  })

  it('draws in place when no slots were supplied', () => {
    /* A `Workbench` mounted on its own -- a test, a future embed -- has to be a whole workbench, not
       a canvas with its sidebars missing. */
    expect(chromePlacement({ chromeOwner: true, slots: null, slot: null })).toBe('inline')
    expect(chromePlacement({ chromeOwner: true, slots: undefined, slot: undefined })).toBe('inline')
  })

  it('waits rather than drawing in place when the slot has not mounted yet', () => {
    /* One frame, between AppShell's first render and its callback refs landing. Falling back to
       inline for that frame would put the palette inside the pane and then move it, which is a
       visible jump. */
    expect(chromePlacement({ chromeOwner: true, slots, slot: null })).toBe('none')
    expect(chromePlacement({ chromeOwner: true, slots, slot: undefined })).toBe('none')
  })

  it('never portals into a slot it was not given', () => {
    /* `createPortal(content, null)` throws, so this is the one case that would be loud rather than
       silent -- and it would take the whole app down on the first render. */
    for (const chromeOwner of [true, false]) {
      for (const slot of [null, undefined, false, 0, '']) {
        expect(chromePlacement({ chromeOwner, slots, slot }), `${chromeOwner}/${slot}`).not.toBe(
          'portal',
        )
      }
    }
  })
})

/*
 * The right-click menu's table verbs, mapped onto the model.
 *
 * Six menu rows, and the mapping is where their labels either tell the truth or do not: "insert row
 * below" and "insert row above" differ by one, which is the sort of thing that is easy to write
 * backwards and invisible until someone notices new rows arriving on the wrong side.
 */
describe('editTable', () => {
  const table = newTable({ rows: 3, columns: 3 })
  const filled = setCell(table, 1, 1, { text: 'middle' })
  const cell = { row: 1, column: 1, rows: 3, columns: 3 }

  it('inserts above and below the row that was clicked', () => {
    /* Above: the clicked row's text moves down a row. Below: it stays where it is. */
    expect(cellText(editTable(filled, 'insert-row-above', cell), 2, 1)).toBe('middle')
    expect(cellText(editTable(filled, 'insert-row-below', cell), 1, 1)).toBe('middle')
    expect(rowCount(editTable(filled, 'insert-row-above', cell))).toBe(4)
  })

  it('inserts left and right of the column that was clicked', () => {
    expect(cellText(editTable(filled, 'insert-column-left', cell), 1, 2)).toBe('middle')
    expect(cellText(editTable(filled, 'insert-column-right', cell), 1, 1)).toBe('middle')
    expect(columnCount(editTable(filled, 'insert-column-right', cell))).toBe(4)
  })

  it('deletes the row and the column that were clicked', () => {
    expect(rowCount(editTable(filled, 'delete-row', cell))).toBe(2)
    expect(cellText(editTable(filled, 'delete-row', cell), 1, 1)).toBe('')
    expect(columnCount(editTable(filled, 'delete-column', cell))).toBe(2)
  })

  it('hands a row back to its own text', () => {
    const fixed = resizeRow(table, 1, 200)
    expect(editTable(fixed, 'fit-row', cell).rows[1]).toBe(null)
  })

  /* A menu from a newer build. Null rather than an empty table, so the caller leaves the node
     alone instead of replacing its contents with nothing. */
  it('says nothing for a verb it does not know', () => {
    expect(editTable(table, 'reticulate', cell)).toBe(null)
  })
})
