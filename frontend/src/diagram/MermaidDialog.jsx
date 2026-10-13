/*
 * Mermaid in and out: the flowchart for what is on the canvas, and a box to paste one into.
 *
 * A dialog rather than a straight download because Mermaid is text people paste -- into a README, a
 * GitHub comment, a Notion page, an LLM prompt -- far more often than a file they keep, and a download
 * makes the commonest use two steps longer. The file is one button away for when it is wanted.
 *
 * The "Keep round-trip data" switch exists because the two audiences for the text disagree. Pasted
 * somewhere a person reads it, the one long `%% segment-builder:` line at the bottom is noise; brought
 * back into this app, it is the difference between the diagram as it was drawn and a fresh auto-layout
 * of it. On by default, because losing an arrangement is the expensive mistake and a comment line is
 * the cheap one -- and Mermaid renders the same picture either way.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, FileUp, Info, TriangleAlert, X } from 'lucide-react'

import { fileNameFor } from './exportImage.js'
import { convertIfLucid } from './lucid.js'
import { graphToMermaid } from './mermaid.js'

const DIRECTIONS = [
  ['auto', 'Auto'],
  ['LR', 'Left → right'],
  ['TB', 'Top → bottom'],
]

export default function MermaidDialog({
  initialTab = 'export',
  /* Text to start the Import tab with, and sentences about where it came from -- set when a Lucid
     export was converted, so the reader sees the flowchart (and what did not come across) before
     anything is drawn. */
  initialText = '',
  initialNotes = [],
  doc,
  getGraph,
  onImport,
  onClose,
}) {
  const [tab, setTab] = useState(initialTab)
  const [direction, setDirection] = useState('auto')
  const [embed, setEmbed] = useState(true)
  const [copied, setCopied] = useState(null)
  const [pasted, setPasted] = useState(initialText)
  const [notes, setNotes] = useState(initialNotes)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* Read once, when the dialog opens, rather than on every render: the dialog covers the canvas, so
     nothing on it changes while this is up -- and `getGraph` is a fresh function on every AppShell
     render, so depending on it would rebuild the text for nothing. */
  const [graph] = useState(getGraph)
  const text = useMemo(
    () =>
      graphToMermaid(graph, doc, {
        direction: direction === 'auto' ? undefined : direction,
        embed,
      }),
    [graph, doc, direction, embed],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied(null), 2000)
  }

  const download = () => {
    const blob = new Blob([text], { type: 'text/vnd.mermaid' })
    const url = URL.createObjectURL(blob)
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = fileNameFor(doc?.name, 'mmd')
      link.click()
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const runImport = (source) => {
    setError(null)
    try {
      onImport(source)
    } catch (err) {
      setError(err.message)
    }
  }

  const pickFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const body = await file.text()
    setError(null)
    /* A Lucid JSON export is shown converted rather than imported straight away: it carries no layout,
       so seeing the flowchart first is the chance to tidy names or regroup before it is drawn. */
    const lucid = convertIfLucid(body)
    if (lucid) {
      setPasted(lucid.text)
      setNotes(lucid.notes)
      return
    }
    setNotes([])
    setPasted(body)
    runImport(body)
  }

  const lines = text.split('\n').length

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-twilio-gray-20 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-twilio-navy">Mermaid</h2>
            <p className="text-[11px] text-twilio-gray-60">
              Zones become subgraphs, components keep their kind’s shape and colours, connectors keep
              their labels and dashes.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-navy"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-twilio-gray-20 px-4 pt-2">
          {[
            ['export', 'Export'],
            ['import', 'Import'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-xs transition-colors ${
                tab === value
                  ? 'border-twilio-gray-20 border-b-white bg-white font-medium text-twilio-navy'
                  : 'border-transparent text-twilio-gray-60 hover:text-twilio-navy'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'export' ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2 text-[11px] text-twilio-gray-60">
              <span className="flex items-center gap-1.5">
                Direction
                <span className="flex overflow-hidden rounded border border-twilio-gray-20">
                  {DIRECTIONS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDirection(value)}
                      aria-pressed={direction === value}
                      className={`border-l border-twilio-gray-20 px-2 py-0.5 first:border-l-0 ${
                        direction === value ? 'bg-twilio-blue text-white' : 'bg-white hover:bg-twilio-gray-10'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </span>
              <label
                className="flex cursor-pointer items-center gap-1.5"
                title="One comment line Mermaid ignores, holding positions, sizes, connector routes, walkthroughs and binding details -- so importing this text back rebuilds the diagram exactly."
              >
                <input type="checkbox" checked={embed} onChange={(event) => setEmbed(event.target.checked)} />
                Keep round-trip data
              </label>
              <span className="ml-auto tabular-nums text-twilio-gray-40">{lines} lines</span>
            </div>
            <textarea
              readOnly
              value={text}
              spellCheck={false}
              className="min-h-[320px] flex-1 resize-none border-y border-twilio-gray-20 bg-twilio-gray-10 px-4 py-3 font-mono text-[11px] leading-relaxed text-twilio-navy focus:outline-none"
              onFocus={(event) => event.target.select()}
              data-testid="mermaid-export"
            />
            <footer className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
              <p className="text-[11px] text-twilio-gray-60">
                {embed
                  ? 'Renders anywhere Mermaid does. Importing it here restores the diagram exactly — edits to the Mermaid are applied.'
                  : 'A plain flowchart. Importing it here lays it out afresh.'}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={download}
                  className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
                >
                  <Download size={13} aria-hidden="true" />
                  .mmd file
                </button>
                <button
                  type="button"
                  onClick={copy}
                  className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark"
                >
                  {copied === 'ok' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Clipboard blocked' : 'Copy'}
                </button>
              </div>
            </footer>
          </>
        ) : (
          <>
            <textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              spellCheck={false}
              placeholder={'flowchart LR\n  subgraph Connections\n    web[Website] --> braze[Braze]\n  end'}
              className="min-h-[320px] flex-1 resize-none border-b border-twilio-gray-20 px-4 py-3 font-mono text-[11px] leading-relaxed text-twilio-navy placeholder:text-twilio-gray-40 focus:outline-none"
              data-testid="mermaid-import"
            />
            {notes.length > 0 && (
              <div className="shrink-0 space-y-1 border-b border-twilio-gray-20 bg-twilio-blue-light/40 px-4 py-2 text-[11px] leading-relaxed text-twilio-navy" data-testid="lucid-notes">
                <p className="flex items-center gap-1.5 font-medium">
                  <Info size={12} className="shrink-0 text-twilio-blue" aria-hidden="true" />
                  Converted from Lucid — review, then Import.
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-twilio-gray-60">
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <p className="flex shrink-0 items-start gap-2 bg-twilio-red-light px-4 py-2 text-xs text-twilio-navy">
                <TriangleAlert size={13} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
                {error}
              </p>
            )}
            <footer className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
              <p className="text-[11px] text-twilio-gray-60">
                Paste Mermaid, or pick a .mmd file or a Lucid JSON export. Opens as a new, unsaved
                diagram; Segment products and components are recognised by name.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
                >
                  <FileUp size={13} aria-hidden="true" />
                  From file
                </button>
                <button
                  type="button"
                  onClick={() => runImport(pasted)}
                  disabled={!pasted.trim()}
                  className="rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-50"
                >
                  Import
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".mmd,.mermaid,.md,.txt,.json,text/plain,text/markdown,application/json"
                className="hidden"
                onChange={pickFile}
              />
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
