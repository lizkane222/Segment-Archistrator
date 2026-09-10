/*
 * The Data tab: a SQL Table's CSV and query, or a Data Graph's entity model.
 *
 * Both are free text that has to be *pasted*, which is why they are not fields on the Overview tab: a
 * textarea holding forty lines of CSV beside a name input is a panel doing two different jobs, and the
 * one that needs room would lose.
 *
 * The query runs as you type, and the result -- including its errors -- is shown right here rather than
 * only on the card. Typing a query and then hunting for the component on the canvas to find out whether
 * it parsed is the loop this panel exists to close.
 */

import { useMemo, useRef } from 'react'
import { AlertCircle, Upload } from 'lucide-react'

import { EmptyNote, Section } from './primitives.jsx'
import { MAX_ROWS, SUPPORTED, parseCsv, runQuery } from './sqlTable.js'

export default function DataTab({ node, onUpdate, onNotify }) {
  const data = node.data
  if (data.kind === 'data_graph') return <DataGraphEditor data={data} onUpdate={onUpdate} />
  return <SqlTableEditor data={data} onUpdate={onUpdate} onNotify={onNotify} />
}

function SqlTableEditor({ data, onUpdate, onNotify }) {
  const file = useRef(null)
  const parsed = useMemo(() => parseCsv(data.csv), [data.csv])
  const result = useMemo(() => runQuery(data.query, parsed), [data.query, parsed])

  const load = (event) => {
    const chosen = event.target.files?.[0]
    if (!chosen) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const read = parseCsv(text)
      if (!read.columns.length) {
        onNotify?.({ tone: 'error', message: `${chosen.name} has no readable header row.` })
        return
      }
      onUpdate({ csv: text })
      onNotify?.({
        tone: 'success',
        message: `Loaded ${read.rows.length} row${read.rows.length === 1 ? '' : 's'} from ${chosen.name}.`,
      })
    }
    /* Read in the browser and stored in the document. Nothing is uploaded: a warehouse export is
       customer data, and the one place it belongs is the diagram the user chose to put it in. */
    reader.onerror = () => onNotify?.({ tone: 'error', message: `Could not read ${chosen.name}.` })
    reader.readAsText(chosen)
    /* Cleared, so choosing the same file twice in a row fires `change` the second time. */
    event.target.value = ''
  }

  return (
    <>
      <Section
        title="Table data"
        note="A CSV, held in this diagram. Nothing is uploaded — it is read in the browser and saved with the document, so treat it as customer data."
        actions={
          <button
            type="button"
            onClick={() => file.current?.click()}
            className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
          >
            <Upload size={11} aria-hidden="true" />
            Load CSV
          </button>
        }
      >
        <input ref={file} type="file" accept=".csv,text/csv,text/plain" onChange={load} className="hidden" />
        <textarea
          value={data.csv ?? ''}
          onChange={(event) => onUpdate({ csv: event.target.value })}
          rows={6}
          spellCheck={false}
          placeholder={'account_id,name,plan,mrr\n1,Acme,pro,1200'}
          className="w-full resize-y rounded border border-twilio-gray-20 p-2 font-mono text-[11px] outline-none focus:border-twilio-blue"
        />
        {parsed.columns.length > 0 && (
          <p className="mt-1 text-[10px] text-twilio-gray-60">
            {parsed.columns.length} column{parsed.columns.length === 1 ? '' : 's'},{' '}
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'}:{' '}
            <span className="font-mono">{parsed.columns.join(', ')}</span>
          </p>
        )}
      </Section>

      <Section
        title="Query"
        note="Run in the browser against the CSV above. A subset of SELECT — anything outside it is refused rather than ignored, so a filter never silently passes everything."
      >
        <textarea
          value={data.query ?? ''}
          onChange={(event) => onUpdate({ query: event.target.value })}
          rows={3}
          spellCheck={false}
          placeholder="SELECT name, mrr FROM accounts WHERE mrr > 500 ORDER BY mrr DESC"
          className="w-full resize-y rounded border border-twilio-gray-20 p-2 font-mono text-[11px] outline-none focus:border-twilio-blue"
        />

        {result.error ? (
          /* Here as well as on the card. Typing a query and then hunting for the component on the canvas
             to find out whether it parsed is the loop this panel closes. */
          <p
            role="alert"
            className="mt-2 flex items-start gap-1.5 rounded bg-twilio-red-light p-2 text-[11px] text-twilio-red-dark"
          >
            <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" />
            {result.error}
          </p>
        ) : (
          <p className="mt-2 text-[10px] text-twilio-gray-60">
            {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
            {result.note ? ` — ${result.note}` : ''}
          </p>
        )}

        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-twilio-gray-60">
            What the query language supports
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] leading-snug text-twilio-gray-60">
            {SUPPORTED.map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>
              An empty cell counts as <span className="font-mono">NULL</span> — a CSV has no other way
              to say it.
            </li>
            <li>At most {MAX_ROWS} rows are rendered, whatever the query asks for.</li>
          </ul>
        </details>
      </Section>
    </>
  )
}

function DataGraphEditor({ data, onUpdate }) {
  return (
    <Section
      title="Entity model"
      note="Segment publishes no API for a Data Graph, so this is transcribed by hand. Paste the config as it is authored — it is shown as written rather than reformatted, because reformatting would mean parsing a shape this tool has no reason to understand."
    >
      <textarea
        value={data.config ?? ''}
        onChange={(event) => onUpdate({ config: event.target.value })}
        rows={14}
        spellCheck={false}
        placeholder={'entities:\n  account:\n    table: PROD.CRM.ACCOUNTS\n    primary_key: id\n  order:\n    table: PROD.CRM.ORDERS\n    relationship:\n      account: account_id'}
        className="w-full resize-y rounded border border-twilio-gray-20 p-2 font-mono text-[11px] outline-none focus:border-twilio-blue"
      />
      {!data.config?.trim() && (
        <EmptyNote>
          The card shows the entity names it can pick out of this, so an <span className="font-mono">entities:</span>{' '}
          block is what makes it useful at a glance.
        </EmptyNote>
      )}
    </Section>
  )
}
