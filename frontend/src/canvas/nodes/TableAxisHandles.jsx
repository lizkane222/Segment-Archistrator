/*
 * A connection point on every row and every column of a table.
 *
 * A table was one thing to connect to, so it could feed a given component once. But a table is usually a
 * list of things -- fields, events, steps -- and the point of drawing one is that this row goes there and
 * that row goes somewhere else, or that three rows all feed the same destination. So each row has a dot
 * on its left and right edge, and each column one on its top and bottom.
 *
 * ## They are real handles, measured
 *
 * A row's height is its text (see tables.js), so where its dot goes is a thing the browser knows and the
 * document does not. The cells are measured after layout and again whenever the grid resizes, the dots
 * are placed at those centres, and React Flow is told (`updateNodeInternals`) so the connector's end
 * follows the dot when a row grows. The edge itself stores nothing but the handle's id -- see
 * `parseTableHandle` in canvas/handles.js.
 *
 * Each is a stacked source and target, for the reason every side is (handles.js): the connection mode is
 * Loose, and an edge end looks its handle up in the list for its own type.
 *
 * Hidden until the pointer is at the table's border, the table is selected, or a connection is being
 * drawn -- a table being read carries none of this.
 */

import { useLayoutEffect, useState } from 'react'
import { Handle, Position, useConnection, useUpdateNodeInternals } from '@xyflow/react'

import { useHandlesRevealed } from '../chrome.js'

const SIDES = [
  { code: 'r', position: Position.Right, axis: 'row' },
  { code: 'l', position: Position.Left, axis: 'row' },
  { code: 't', position: Position.Top, axis: 'col' },
  { code: 'b', position: Position.Bottom, axis: 'col' },
]

const SIZE = 9

export default function TableAxisHandles({ nodeId, grid, rows, columns, border, selected }) {
  const [centres, setCentres] = useState({ rows: [], columns: [] })
  const updateInternals = useUpdateNodeInternals()
  const revealed = useHandlesRevealed(nodeId)
  const drawing = useConnection((state) => state.inProgress)
  const visible = revealed || selected || drawing

  useLayoutEffect(() => {
    const element = grid.current
    if (!element) return undefined

    const measure = () => {
      const next = {
        rows: Array.from({ length: rows }, (_, row) => {
          const cell = element.querySelector(`[data-cell="${row}:0"]`)
          return cell ? Math.round(cell.offsetTop + cell.offsetHeight / 2) : null
        }),
        columns: Array.from({ length: columns }, (_, column) => {
          const cell = element.querySelector(`[data-cell="0:${column}"]`)
          return cell ? Math.round(cell.offsetLeft + cell.offsetWidth / 2) : null
        }),
      }
      setCentres((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const cell of element.children) observer.observe(cell)
    return () => observer.disconnect()
  }, [grid, rows, columns])

  /* The dots moved, so the connectors' ends have to be re-read from them. */
  useLayoutEffect(() => {
    updateInternals(nodeId)
  }, [centres, nodeId, updateInternals])

  const dot = {
    width: SIZE,
    height: SIZE,
    background: border,
    border: '2px solid white',
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
    transition: 'opacity 120ms',
    zIndex: 8,
  }

  return SIDES.flatMap(({ code, position, axis }) =>
    (axis === 'row' ? centres.rows : centres.columns).flatMap((centre, index) => {
      if (centre == null) return []
      const place = axis === 'row' ? { top: centre } : { left: centre }
      return ['source', 'target'].map((type) => (
        <Handle
          key={`${axis}-${code}-${index}-${type}`}
          id={`${axis}-${code}-${index}`}
          type={type}
          position={position}
          title={axis === 'row' ? `Connect from row ${index + 1}` : `Connect from column ${index + 1}`}
          className="nodrag"
          style={{ ...dot, ...place }}
        />
      ))
    }),
  )
}
