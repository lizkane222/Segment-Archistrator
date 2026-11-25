/*
 * Paste data into a table: CSV, tab-separated, JSON, or a plain list.
 *
 * Paste (or drop a file), see what grid it makes, say how it was meant to be cut up if the guess is wrong,
 * and choose whether it replaces the table or is added to it. Nothing is written until Apply, so every option
 * can be tried against the preview. The reading is in canvas/tablePaste.js.
 */

import { useMemo, useRef, useState } from 'react'
import { ClipboardPaste, FileUp } from 'lucide-react'

import { Section } from './primitives.jsx'
import { DEFAULT_OPTIONS, DELIMITERS, applyRows, parsePaste } from '../canvas/tablePaste.js'
import { tableText } from '../canvas/tables.js'

const PREVIEW_ROWS = 8
const PREVIEW_COLUMNS = 8

const MODES = [
  ['replace', 'Replace the table', 'Start over with a grid sized to this data.'],
  ['rows', 'Add as new rows', 'Put it underneath what is there.'],
  ['columns', 'Add as new columns', 'Put it beside what is there.'],
]

function Check({ label, hint, checked, onChange }) {
  return (
    <label className="flex items-start gap-2 py-0.5 text-xs text-twilio-navy" title={hint}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="nodrag mt-0.5" />
      <span>{label}</span>
    </label>
  )
}

export default function TablePasteTab({ node, onUpdate, onNotify }) {
  const [text, setText] = useState('')
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [mode, setMode] = useState('replace')
  const file = useRef(null)

  const set = (patch) => setOptions((current) => ({ ...current, ...patch }))
  const read = useMemo(() => parsePaste(text, options), [text, options])
  const hasData = read.rows.length > 0
  const existing = node.data.table
  const replacing = mode === 'replace'

  const apply = () => {
    if (!hasData) return
    const table = applyRows(existing, read.rows, { mode, header: read.header })
    /* `size` cleared: a table's box is its columns, and a width chosen for the old grid would be wrong
       for this one. */
    onUpdate({ table, name: tableText(table) || 'Table', size: undefined })
    onNotify?.({
      tone: 'success',
      message: replacing
        ? `Filled the table with ${read.rows.length} row${read.rows.length === 1 ? '' : 's'}.`
        : mode === 'rows'
          ? `Added ${read.rows.length} row${read.rows.length === 1 ? '' : 's'} to the table.`
          : `Added ${width} column${width === 1 ? '' : 's'} to the table.`,
    })
    setText('')
  }

  const loadFile = async (picked) => {
    if (!picked) return
    setText(await picked.text())
    /* A file says what it is: .json is JSON, .tsv is tabs, .csv is commas. */
    const name = picked.name.toLowerCase()
    if (name.endsWith('.json')) set({ format: 'json' })
    else if (name.endsWith('.tsv')) set({ format: 'text', delimiter: 'tab' })
    else if (name.endsWith('.csv')) set({ format: 'text', delimiter: 'comma' })
  }

  const shown = read.rows.slice(0, PREVIEW_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS))
  const width = read.rows[0]?.length ?? 0

  return (
    <>
      <Section title="Paste" note="CSV, tab-separated (straight from a spreadsheet), JSON, or a list. Or drop a file.">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            loadFile(event.dataTransfer.files?.[0])
          }}
          rows={7}
          spellCheck={false}
          placeholder={'name,plan\nAvery,pro\n\n— or —\n[{"name":"Avery","plan":"pro"}]'}
          aria-label="Data to paste"
          className="nodrag w-full rounded border border-twilio-gray-20 px-2 py-1.5 font-mono text-[11px] text-twilio-navy outline-none focus:border-twilio-blue"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => file.current?.click()}
            className="nodrag flex items-center gap-1 text-[11px] text-twilio-gray-60 hover:text-twilio-blue"
          >
            <FileUp size={12} aria-hidden="true" />
            Choose a file
          </button>
          <input ref={file} type="file" accept=".csv,.tsv,.json,.txt,text/*,application/json" className="hidden" onChange={(event) => { loadFile(event.target.files?.[0]); event.target.value = '' }} />
          {text && (
            <button type="button" onClick={() => setText('')} className="nodrag text-[11px] text-twilio-gray-60 hover:text-twilio-blue">
              Clear
            </button>
          )}
        </div>
      </Section>

      <Section title="How to read it">
        <label className="flex items-center gap-2 py-1 text-xs">
          <span className="w-24 shrink-0 text-twilio-gray-60">Format</span>
          <select value={options.format} onChange={(event) => set({ format: event.target.value })} className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-xs">
            <option value="auto">Detect</option>
            <option value="json">JSON</option>
            <option value="text">CSV / text</option>
          </select>
        </label>

        <label className="flex items-center gap-2 py-1 text-xs">
          <span className="w-24 shrink-0 text-twilio-gray-60">Split cells by</span>
          <select value={options.delimiter} onChange={(event) => set({ delimiter: event.target.value })} className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-xs">
            {Object.entries(DELIMITERS).map(([key, entry]) => (
              <option key={key} value={key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {options.delimiter === 'custom' && (
          <label className="flex items-center gap-2 py-1 text-xs">
            <span className="w-24 shrink-0 text-twilio-gray-60">Split by</span>
            <input
              value={options.custom}
              onChange={(event) => set({ custom: event.target.value })}
              placeholder="e.g.  ::   or   \t"
              aria-label="Split cells by"
              className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-xs focus:border-twilio-blue focus:outline-none"
            />
          </label>
        )}

        <label className="flex items-center gap-2 py-1 text-xs">
          <span className="w-24 shrink-0 text-twilio-gray-60">Split rows by</span>
          <select value={options.rowSeparator} onChange={(event) => set({ rowSeparator: event.target.value })} className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-xs">
            <option value="newline">New line</option>
            <option value="custom">Other…</option>
          </select>
        </label>
        {options.rowSeparator === 'custom' && (
          <label className="flex items-center gap-2 py-1 text-xs">
            <span className="w-24 shrink-0 text-twilio-gray-60">Split by</span>
            <input
              value={options.customRows}
              onChange={(event) => set({ customRows: event.target.value })}
              placeholder="e.g.  ;   or   ||"
              aria-label="Split rows by"
              className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-xs focus:border-twilio-blue focus:outline-none"
            />
          </label>
        )}

        <div className="mt-1.5 space-y-0.5">
          <label className="flex items-center gap-2 py-0.5 text-xs">
            <span className="w-24 shrink-0 text-twilio-gray-60">First row is</span>
            <select
              value={options.header === null ? 'auto' : options.header ? 'header' : 'data'}
              onChange={(event) => set({ header: event.target.value === 'auto' ? null : event.target.value === 'header' })}
              className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-xs"
            >
              <option value="auto">Detect</option>
              <option value="header">A header</option>
              <option value="data">Data</option>
            </select>
          </label>
          <Check label="Trim spaces around each cell" checked={options.trim} onChange={(trim) => set({ trim })} />
          <Check label="Skip empty rows" checked={options.skipEmpty} onChange={(skipEmpty) => set({ skipEmpty })} />
          <Check label="Swap rows and columns" hint="A list across becomes a list down, and the other way round." checked={options.transpose} onChange={(transpose) => set({ transpose })} />
          <Check label="Flatten nested JSON into columns (a.b)" hint="Off keeps a nested object whole in one cell." checked={options.flatten} onChange={(flatten) => set({ flatten })} />
        </div>
      </Section>

      <Section title="Preview" note={hasData ? `${read.rows.length} row${read.rows.length === 1 ? '' : 's'} × ${width} column${width === 1 ? '' : 's'}, read as ${read.format === 'json' ? 'JSON' : 'text'}${read.header ? ', with a header' : ''}.` : 'Nothing to show yet.'}>
        {hasData && (
          <div className="overflow-x-auto rounded border border-twilio-gray-20">
            <table className="w-full border-collapse text-[10px]">
              <tbody>
                {shown.map((row, index) => (
                  <tr key={index} className={index === 0 && read.header ? 'bg-twilio-gray-10 font-semibold' : ''}>
                    {row.map((cell, column) => (
                      <td key={column} className="max-w-[8rem] truncate border border-twilio-gray-10 px-1.5 py-0.5 text-twilio-navy" title={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(read.rows.length > PREVIEW_ROWS || width > PREVIEW_COLUMNS) && (
          <p className="mt-1 text-[10px] text-twilio-gray-60">Showing the first {PREVIEW_ROWS} rows and {PREVIEW_COLUMNS} columns.</p>
        )}
        {read.problems.map((problem) => (
          <p key={problem} className="mt-1 text-[11px] text-twilio-warning">{problem}</p>
        ))}

        <div className="mt-3 space-y-1" role="radiogroup" aria-label="What to do with it">
          {MODES.map(([id, label, hint]) => (
            <label key={id} className="flex items-start gap-2 text-xs text-twilio-navy" title={hint}>
              <input type="radio" name="paste-mode" checked={mode === id} onChange={() => setMode(id)} className="nodrag mt-0.5" />
              <span>
                {label} <span className="text-twilio-gray-60">— {hint}</span>
              </span>
            </label>
          ))}
        </div>

        <button
          type="button"
          onClick={apply}
          disabled={!hasData}
          className="nodrag mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-twilio-blue px-3 py-2 text-xs font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-40"
        >
          <ClipboardPaste size={13} aria-hidden="true" />
          {replacing ? 'Fill the table' : mode === 'rows' ? 'Add the rows' : 'Add the columns'}
        </button>
      </Section>
    </>
  )
}
