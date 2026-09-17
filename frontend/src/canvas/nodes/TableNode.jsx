/*
 * A table whose cells can be typed into.
 *
 * There is a table in the shapes library already and it is a *drawing*: `SHAPES.table` in
 * shapes/geometry.js is a rectangle with four lines through it, which meant a real table on a
 * diagram was nine text shapes kept in line by hand. This is the same picture with the cells being
 * real. The old geometry stays so saved diagrams still render, but the palette's Table tile drops
 * one of these.
 *
 * ## Why a CSS grid and not a `<table>`
 *
 * The row heights are the whole point -- "each cell wraps and expands the row to fit all the text"
 * -- and a grid says that declaratively: `grid-template-rows` of `auto` is a row as tall as its own
 * content, recomputed by the browser as characters arrive. Nothing here measures anything or writes
 * a height back, which is the loop SegmentNode's comment on `MAX_AUTO_NODE_WIDTH` warns about: it
 * has to be damped to stop oscillating, it bakes one browser's font metrics into the saved
 * document, and it marks the diagram dirty the moment it finishes loading.
 *
 * A `<table>` would do the same job for the rows and get in the way everywhere else: the dividers
 * are absolutely-positioned hit strips over the whole grid, which a table's own layout would fight,
 * and a cell has to hold a `contentEditable` with its own padding rather than a `<td>`'s.
 *
 * ## The dividers
 *
 * Every internal boundary is a five-pixel strip laid over the grid, and so is each outer edge that
 * a column or row can be dragged from. They are in flow coordinates via `screenToFlowPosition`, so
 * a drag means the same thing at 40% zoom as at 200% -- the same correction the shape corner handle
 * makes, and for the same reason.
 */

import { memo, useCallback, useRef, useState } from 'react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { Lock, Plus } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import RichEditor from './RichEditor.jsx'
import RichLabel from './RichLabel.jsx'
import { useChrome } from '../chrome.js'
import { labelLayout } from '../labelStyle.js'
import { styleFor } from '../kinds.js'
import {
  MIN_COLUMN,
  MIN_ROW,
  cellRich,
  insertColumn,
  insertRow,
  nextCell,
  normalizeTable,
  resizeColumn,
  resizeRow,
  setCell,
  tableSize,
  tableText,
} from '../tables.js'

/* How wide a divider's hit area is, in screen pixels. Wider than the line it sits on, because the
   line is one pixel and a one-pixel drag target is a fight. */
const GRIP = 5

function TableNode({ id, data, selected }) {
  const { screenToFlowPosition, getZoom } = useReactFlow()
  const { walkthroughActive, updateData } = useChrome()

  const table = normalizeTable(data.table)
  const style = styleFor(data.kind, data.style)
  const label = labelLayout(data.style, { align: 'left', valign: 'top' })
  const locked = Boolean(data.locked)

  /* Which cell is being typed into, as `{row, column}` or null. One at a time -- a second caret
     is not a thing a keyboard can produce, and holding one per cell would mean nine editors
     mounted with nine sessions competing to own the toolbar. */
  const [editing, setEditing] = useState(null)

  const paths = data.paths ?? null
  const here = paths?.find((entry) => entry.current) ?? null
  const arrived = paths?.some((entry) => entry.arrived) ?? false
  const aside = walkthroughActive && !here && !arrived

  /*
   * Any edit to the grid, written as one patch.
   *
   * `name` rides along with every one of them, because a table's name is derived from its contents
   * (`tableText`) and it is what the console, the minimap tooltip, search and the save advisories
   * have to call this node. Keeping the two in one write is what stops them drifting.
   */
  const write = useCallback(
    (next) => updateData?.(id, { table: next, name: tableText(next) || 'Table' }),
    [updateData, id],
  )

  const commitCell = ({ rich, text }) => {
    const at = editing
    setEditing(null)
    if (!at) return
    write(setCell(table, at.row, at.column, { rich, text }))
  }

  /* The grid itself, so a drag can measure from the table's own top-left rather than from the
     node's -- they differ by whatever padding and border the wrapper has, and reading the box the
     offsets are actually relative to is what keeps a divider under the pointer. */
  const grid = useRef(null)

  /*
   * Dragging a divider.
   *
   * The size being set is measured from the column's (or row's) own leading edge to the pointer, in
   * flow units, so it ends up exactly as wide as the gap the user has dragged out. A delta applied
   * per frame would be the obvious alternative and drifts: rounding accumulates over a long drag,
   * and the line ends up somewhere the pointer is not.
   */
  const dragDivider = useCallback(
    (event, { axis, index, before }) => {
      event.stopPropagation()
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture?.(event.pointerId)

      /* Read once, at the start: the grid does not move during the drag, and reading its box every
         frame would make each frame's answer depend on the growth the previous frame caused. */
      const box = grid.current?.getBoundingClientRect()
      if (!box) return
      const origin = screenToFlowPosition({ x: box.left, y: box.top })

      const onMove = (moveEvent) => {
        const at = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
        if (axis === 'column') write(resizeColumn(table, index, at.x - origin.x - before))
        else write(resizeRow(table, index, at.y - origin.y - before))
      }
      const stop = () => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', stop)
        element.removeEventListener('pointercancel', stop)
      }
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', stop)
      element.addEventListener('pointercancel', stop)
    },
    [screenToFlowPosition, table, write],
  )

  const size = tableSize(table)
  /* Offsets of each boundary from the node's own top-left, which is what positions the grips.
     Recomputed on every render rather than stored: they are the running sums of the column widths
     and would be a second copy of the same numbers. */
  const columnEdges = offsets(table.columns)
  const rowEdges = offsets(table.rows.map((row) => row ?? MIN_ROW))

  return (
    <>
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={MIN_COLUMN * table.columns.length}
        minHeight={MIN_ROW * table.rows.length}
        color={style.border}
        handleStyle={{ width: 12, height: 12, borderRadius: 3 }}
        lineStyle={{ borderWidth: 1, opacity: 0.35 }}
      />

      <div
        className={`group relative ${aside ? 'walkthrough-aside' : ''} ${
          here ? 'walkthrough-here' : arrived ? 'walkthrough-trail' : ''
        }`}
        style={{
          /* The chosen width when there is one, or the columns' own sum. Height is never fixed
             from here: the rows decide it, which is what lets a row grow as text is typed. */
          width: data.size?.width ?? size.width,
          '--path-colour': here?.color ?? undefined,
        }}
        onContextMenu={(event) => event.preventDefault()}
        data-kind="table"
        data-node-id={id}
      >
        <ConnectionHandles border={style.border} />

        <div
          ref={grid}
          className="grid overflow-hidden rounded-sm"
          style={{
            gridTemplateColumns: table.columns.map((column) => `${column}px`).join(' '),
            /*
             * `minmax(MIN_ROW, auto)` for a row nobody has dragged. The `auto` half is the whole
             * mechanism -- the row is as tall as its tallest wrapped cell and the browser recomputes
             * it as characters arrive, with nothing measuring or storing a height. The floor is what
             * makes an *empty* row a row: `auto` alone on a grid of empty cells is zero, so a table
             * dropped on the canvas came out as a 2px grey strip with no cells to click into.
             *
             * A dragged row keeps the same shape with its own floor, so text that outgrows a height
             * someone chose pushes it open rather than being clipped invisibly.
             */
            gridTemplateRows: table.rows
              .map((row) => `minmax(${row ?? MIN_ROW}px, auto)`)
              .join(' '),
            background: style.bg,
            outline: `${style.borderWidth ?? 1}px ${style.borderStyle ?? 'solid'} ${style.border}`,
            outlineOffset: -1,
          }}
        >
          {table.cells.map((cells, row) =>
            cells.map((cell, column) => {
              const isEditing = editing?.row === row && editing?.column === column
              const header = row === 0 && table.header
              return (
                <div
                  key={`${row}:${column}`}
                  /* Read by Canvas's `openMenu` off the event target, so "Delete row" acts on the
                     row that was right-clicked. The alternative is arithmetic on the pointer
                     position against the column widths, which is the same answer computed twice --
                     the browser has already done this hit test. */
                  data-cell={`${row}:${column}`}
                  className={`min-w-0 px-1.5 py-1 text-[12px] ${header ? 'font-semibold' : ''} ${
                    label.itemsClass
                  } flex`}
                  style={{
                    color: style.text,
                    /* Drawn as insets rather than as borders on the grid, so a one-pixel line
                       lands between two cells instead of doubling where they meet. */
                    boxShadow: `inset -1px -1px 0 0 ${gridLine(style.border)}`,
                    background: header ? gridLine(style.border, 0.08) : undefined,
                  }}
                  onDoubleClick={(event) => {
                    if (!updateData) return
                    event.stopPropagation()
                    setEditing({ row, column })
                  }}
                >
                  {isEditing ? (
                    <RichEditor
                      value={cellRich(table, row, column)}
                      sessionKey={`cell:${id}:${row}:${column}`}
                      nodeId={id}
                      /* A cell is prose like a shape's label: a note in a table wants two lines
                         and an emphasised word as much as anywhere else. */
                      multiline
                      align={label.align}
                      onCommit={commitCell}
                      onCancel={() => setEditing(null)}
                      className="w-full"
                      style={{ color: style.text, ...label.textStyle }}
                      onTab={(direction) => {
                        /* Filling in nine cells should not be nine double-clicks. Handled here
                           rather than in the editor because only the table knows what is next. */
                        const target = nextCell(table, { row, column }, direction)
                        if (target) setEditing(target)
                      }}
                    />
                  ) : (
                    <RichLabel
                      value={cell?.rich}
                      text={cell?.text ?? ''}
                      align={label.align}
                      /* `break-all` as well as wrapping: a column is a width the user chose, and a
                         single long token -- a write key, a URL -- has to wrap inside it rather
                         than widen it. */
                      className="w-full break-all"
                      style={{ color: style.text, ...label.textStyle }}
                    />
                  )}
                </div>
              )
            }),
          )}
        </div>

        {/* The dividers. Only while selected and unlocked: they sit over the cells, and a grid of
            invisible drag strips on an unselected table would swallow the double-click that opens
            a cell. */}
        {selected && !locked && (
          <>
            {columnEdges.slice(1).map((edge, index) => (
              <div
                key={`col:${index}`}
                role="separator"
                aria-orientation="vertical"
                aria-label={`Column ${index + 1} width`}
                title="Drag to set the width."
                onPointerDown={(event) =>
                  /* `before` is how far this column's own left edge is from the grid's, which is
                     what turns a pointer position into a width. */
                  dragDivider(event, { axis: 'column', index, before: columnEdges[index] })
                }
                className="nodrag nopan absolute top-0 z-[6] h-full cursor-col-resize"
                style={{ left: edge - GRIP / 2 / getZoom(), width: GRIP / getZoom() }}
              />
            ))}
            {rowEdges.slice(1).map((edge, index) => (
              <div
                key={`row:${index}`}
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Row ${index + 1} height`}
                onPointerDown={(event) =>
                  dragDivider(event, { axis: 'row', index, before: rowEdges[index] })
                }
                onDoubleClick={(event) => {
                  /* Double-click a row divider to hand the row back to its content, which is the
                     only way out of a height dragged too short for the text in it. */
                  event.stopPropagation()
                  write(resizeRow(table, index, null))
                }}
                title="Drag to set the height. Double-click to fit the text."
                className="nodrag nopan absolute left-0 z-[6] w-full cursor-row-resize"
                style={{ top: edge - GRIP / 2 / getZoom(), height: GRIP / getZoom() }}
              />
            ))}

            {/* Add a column or a row. On the two outer edges, where Lucid and Google Docs both put
                them, and only while selected -- so a table being read carries no furniture. */}
            <AddButton
              label="Add a column"
              className="-right-6 top-1/2 -translate-y-1/2"
              onClick={() => write(insertColumn(table, table.columns.length))}
            />
            <AddButton
              label="Add a row"
              className="-bottom-6 left-1/2 -translate-x-1/2"
              onClick={() => write(insertRow(table, table.rows.length))}
            />
          </>
        )}

        {locked && (
          <span className="absolute right-1 top-1" title="Placement locked. Right-click to unlock.">
            <Lock size={11} className="opacity-50" aria-hidden="true" />
          </span>
        )}
      </div>
    </>
  )
}

function AddButton({ label, className, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`nodrag nopan absolute flex h-5 w-5 items-center justify-center rounded-full border border-twilio-gray-20 bg-white text-twilio-gray-60 opacity-0 shadow-sm transition-opacity hover:text-twilio-blue group-hover:opacity-100 ${className}`}
    >
      <Plus size={12} aria-hidden="true" />
    </button>
  )
}

/* Running sums: `[0, w0, w0+w1, ...]`, one more entry than there are columns, so `slice(1)` is
   every boundary including the outer edge. */
function offsets(sizes) {
  const out = [0]
  for (const size of sizes) out.push(out[out.length - 1] + size)
  return out
}

/* The grid lines: the border colour, faded. A separate hue would be a second colour to keep in
   step with the border every time either is themed. */
function gridLine(border, alpha = 0.35) {
  const value = /^#([\da-f]{6})$/i.exec(String(border ?? '').trim())
  if (!value) return `rgba(53, 64, 82, ${alpha})`
  const int = parseInt(value[1], 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

export default memo(TableNode)
