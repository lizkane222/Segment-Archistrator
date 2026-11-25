/*
 * Save a diagram as a template, choosing what of this workspace's data comes with it.
 *
 * A grid: a row per component, a column per kind of data. A tick is about the *mode* at the top --
 * in Remove it marks what goes, in Keep it marks what stays -- and every cell is drawn by what will
 * actually happen to it (struck through and red when it is going), so there is no mode in which a
 * tick and its outcome have to be reconciled in the reader's head. Switching mode inverts the ticks,
 * which leaves the outcome as it was: the toggle changes how you are choosing, not what you chose.
 *
 * All the decisions are in ./templatize.js; this only draws them.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, Lock, Globe2, X } from 'lucide-react'

import {
  PATHS_ROW,
  allCells,
  applyTemplatize,
  buildMatrix,
  cellKey,
  invertSelection,
  removedCells,
  summarize,
} from './templatize.js'

export default function TemplatizeDialog({
  graph,
  topology,
  initialName,
  workspace,
  busy,
  onSave,
  onClose,
}) {
  const matrix = useMemo(() => buildMatrix(graph, topology), [graph, topology])
  const everything = useMemo(() => allCells(matrix), [matrix])

  const [name, setName] = useState(initialName ? `${initialName} template` : 'Template')
  const [description, setDescription] = useState('')
  const [shared, setShared] = useState(false)
  /* Opens in Remove with everything ticked: the generic template is the one that can be used
     anywhere, so it is what someone gets by pressing Save without thinking. */
  const [mode, setMode] = useState('remove')
  const [selected, setSelected] = useState(() => new Set(everything))

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const removed = useMemo(() => removedCells(matrix, selected, mode), [matrix, selected, mode])
  const result = useMemo(
    () => applyTemplatize(graph, removed, { topology }),
    [graph, removed, topology],
  )
  const summary = summarize(matrix, removed, result)

  const switchMode = (next) => {
    if (next === mode) return
    setSelected((current) => invertSelection(matrix, current))
    setMode(next)
  }

  const toggle = (keys) => {
    setSelected((current) => {
      const next = new Set(current)
      const allOn = keys.every((key) => next.has(key))
      for (const key of keys) {
        if (allOn) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const rowKeys = (row) =>
    matrix.columns.filter((c) => row.cells[c.id] !== null).map((c) => cellKey(row.nodeId, c.id))
  const columnKeys = (column) =>
    matrix.rows.filter((row) => row.cells[column.id] !== null).map((row) => cellKey(row.nodeId, column.id))
  const allKeys = [...everything]

  const verb = mode === 'remove' ? 'Remove' : 'Keep'
  const where = workspace?.slug || workspace?.name || 'this workspace'

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="text-sm font-semibold text-twilio-navy">Save as template</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-twilio-gray-40 hover:bg-twilio-gray-10">
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
                className="mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1.5 text-xs outline-none focus:border-twilio-blue"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">Description</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
                placeholder="What is this a starting point for?"
                className="mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1.5 text-xs outline-none focus:border-twilio-blue"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="What a tick means" className="flex overflow-hidden rounded-md border border-twilio-gray-20 text-xs">
              {['remove', 'keep'].map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => switchMode(value)}
                  className={`px-3 py-1.5 font-medium capitalize transition-colors ${
                    mode === value
                      ? 'bg-twilio-blue text-white'
                      : 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-twilio-gray-60">
              {mode === 'remove'
                ? "Ticked data is taken out of the template. Names fall back to what each component is, and a component with no resource ID becomes a placeholder to bind."
                : "Ticked data stays in the template; everything else is taken out. Keep everything and the template belongs to this workspace only."}
            </p>
          </div>

          <div className="mt-3 overflow-x-auto rounded-md border border-twilio-gray-20">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-twilio-gray-10 text-left text-[10px] uppercase tracking-wide text-twilio-gray-60">
                  <th className="sticky left-0 z-10 min-w-48 bg-twilio-gray-10 px-3 py-2">
                    <Tick
                      state={tickState(allKeys, selected)}
                      onChange={() => toggle(allKeys)}
                      label={`${verb} everything`}
                    />
                    <span className="ml-2 align-middle">Component</span>
                  </th>
                  {matrix.columns.map((column) => (
                    <th key={column.id} className="px-3 py-2" title={column.hint}>
                      <Tick
                        state={tickState(columnKeys(column), selected)}
                        onChange={() => toggle(columnKeys(column))}
                        label={`${verb} every ${column.label}`}
                      />
                      <span className="ml-2 align-middle">{column.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={row.nodeId} className="border-t border-twilio-gray-20">
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-normal">
                      <Tick
                        state={tickState(rowKeys(row), selected)}
                        onChange={() => toggle(rowKeys(row))}
                        label={`${verb} everything about ${row.label}`}
                        disabled={!rowKeys(row).length}
                      />
                      <span className="ml-2 align-middle font-medium text-twilio-navy">{row.label}</span>
                      <span className="ml-1.5 rounded bg-twilio-gray-10 px-1 py-0.5 align-middle text-[9px] uppercase text-twilio-gray-60">
                        {row.kindLabel}
                      </span>
                    </th>
                    {matrix.columns.map((column) => {
                      const value = row.cells[column.id]
                      const key = cellKey(row.nodeId, column.id)
                      if (value === null) {
                        return (
                          <td key={column.id} className="px-3 py-1.5 text-twilio-gray-40">
                            —
                          </td>
                        )
                      }
                      const going = removed.has(key)
                      return (
                        <td key={column.id} className={`px-3 py-1.5 ${going ? 'bg-twilio-red-light/60' : ''}`}>
                          <Tick
                            state={selected.has(key) ? 'on' : 'off'}
                            onChange={() => toggle([key])}
                            label={`${verb} ${column.label} of ${row.label}`}
                          />
                          <span
                            className={`ml-2 align-middle font-mono text-[11px] ${
                              going ? 'text-twilio-red-dark line-through' : 'text-twilio-gray-80'
                            }`}
                          >
                            {value}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {matrix.paths > 0 && (
                  <tr className="border-t border-twilio-gray-20">
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-normal">
                      <Tick
                        state={selected.has(cellKey(PATHS_ROW, 'paths')) ? 'on' : 'off'}
                        onChange={() => toggle([cellKey(PATHS_ROW, 'paths')])}
                        label={`${verb} the saved walkthrough paths`}
                      />
                      <span className="ml-2 align-middle font-medium text-twilio-navy">Saved paths</span>
                    </th>
                    <td
                      colSpan={Math.max(1, matrix.columns.length)}
                      className={`px-3 py-1.5 text-[11px] ${
                        removed.has(cellKey(PATHS_ROW, 'paths'))
                          ? 'bg-twilio-red-light/60 text-twilio-red-dark line-through'
                          : 'text-twilio-gray-80'
                      }`}
                    >
                      {matrix.paths} walkthrough path{matrix.paths === 1 ? '' : 's'}, with their example events
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!matrix.rows.length && (
            <p className="mt-3 text-xs text-twilio-gray-60">This diagram has no components to template.</p>
          )}
        </div>

        <footer className="shrink-0 border-t border-twilio-gray-20 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex items-center gap-1.5 text-xs text-twilio-gray-80">
              {summary.generic ? (
                <Globe2 size={13} className="text-twilio-success" aria-hidden="true" />
              ) : (
                <Lock size={13} className="text-twilio-warning" aria-hidden="true" />
              )}
              <span>
                <strong>{summary.removed}</strong> removed, <strong>{summary.kept}</strong> kept.{' '}
                {summary.generic
                  ? 'Usable from any workspace.'
                  : `Still carries ${where}'s own data, so only people with that workspace connected can use it.`}
              </span>
            </p>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-twilio-gray-80">
              <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
              Share with everyone at Twilio
            </label>
            <button
              type="button"
              disabled={busy || !name.trim() || !matrix.rows.length}
              onClick={() =>
                onSave({ name: name.trim(), description: description.trim(), graph: result, shared })
              }
              className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
              Save template
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function tickState(keys, selected) {
  if (!keys.length) return 'off'
  const on = keys.filter((key) => selected.has(key)).length
  return on === 0 ? 'off' : on === keys.length ? 'on' : 'some'
}

/* A checkbox that can say "some". `indeterminate` is a property, not an attribute, so it is set
   from a ref. */
function Tick({ state, onChange, label, disabled = false }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="align-middle"
    />
  )
}
