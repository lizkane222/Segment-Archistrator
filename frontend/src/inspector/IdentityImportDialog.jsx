/*
 * Fill an identity resolution rule from a screenshot of Segment's settings table.
 *
 * Three steps in one dialog: give it the picture (drop, paste or browse), watch it read, then *check what
 * it read* before anything is written. The check is not optional politeness -- OCR gets underscores wrong
 * -- so the rows come back as editable fields beside the picture they came from, and only Apply touches
 * the diagram.
 */

import { useEffect, useRef, useState } from 'react'
import { ImageUp, Loader2, Plus, Trash2, TriangleAlert, X } from 'lucide-react'

import { parseRuleTable } from './identityScreenshot.js'
import { readWords } from './readScreenshot.js'
import { LIMIT_FREQUENCIES } from '../canvas/nodes/IdentityRuleTable.jsx'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export default function IdentityImportDialog({ targetName, existingCount = 0, onApply, onClose }) {
  const [stage, setStage] = useState('idle') // idle | reading | review
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [rows, setRows] = useState([])
  const [problems, setProblems] = useState([])
  const [over, setOver] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview])

  const read = async (file) => {
    if (!file || !file.type?.startsWith('image/')) {
      setError('That is not an image. Use a PNG, JPEG or WebP screenshot.')
      return
    }
    setError(null)
    setPreview(URL.createObjectURL(file))
    setStage('reading')
    setProgress(0)
    try {
      const { words } = await readWords(file, (fraction, label) => {
        setProgress(fraction)
        setStatus(label)
      })
      const result = parseRuleTable(words)
      setRows(result.rows)
      setProblems(result.problems)
      setStage('review')
    } catch (err) {
      setError(`Could not read that image: ${err?.message ?? err}`)
      setStage('idle')
    }
  }

  /* A screenshot is usually on the clipboard already; pasting it is quicker than saving it to a file. */
  useEffect(() => {
    const onPaste = (event) => {
      const image = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/'))
      if (image) {
        event.preventDefault()
        read(image)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (index, patch) => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  const usable = rows.filter((row) => row.externalId.trim())

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="text-sm font-semibold text-twilio-navy">Import identity rules from a screenshot</h2>
          <button type="button" onClick={onClose} title="Close" className="text-twilio-gray-40 hover:text-twilio-navy">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {stage !== 'review' && (
            <div
              onDragOver={(event) => {
                event.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault()
                setOver(false)
                read(event.dataTransfer.files?.[0])
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                over ? 'border-twilio-blue bg-twilio-blue-light/40' : 'border-twilio-gray-20'
              }`}
            >
              {stage === 'reading' ? (
                <>
                  <Loader2 size={22} className="animate-spin text-twilio-blue" aria-hidden="true" />
                  <p className="text-sm text-twilio-navy">Reading the table…</p>
                  <p className="text-[11px] text-twilio-gray-60">
                    {status || 'Starting'} {progress > 0 && `· ${Math.round(progress * 100)}%`}
                  </p>
                  <p className="max-w-sm text-[11px] text-twilio-gray-60">
                    The first time takes a few seconds while the text reader loads. The picture stays on this computer.
                  </p>
                </>
              ) : (
                <>
                  <ImageUp size={24} className="text-twilio-gray-40" aria-hidden="true" />
                  <p className="text-sm text-twilio-navy">Drop a screenshot here, or paste one</p>
                  <p className="max-w-md text-[11px] text-twilio-gray-60">
                    The identity resolution table from Segment's settings: Priority, Identifier, Seen, Value limit.
                    Priority becomes the row number, Identifier the external_id, and Value limit the limit.
                  </p>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="mt-1 rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 hover:border-twilio-blue hover:text-twilio-blue"
                  >
                    Choose an image
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept={ACCEPT}
                    className="hidden"
                    onChange={(event) => {
                      read(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </>
              )}
            </div>
          )}

          {error && (
            <p className="mt-3 flex items-start gap-2 rounded-md bg-twilio-red-light px-3 py-2 text-xs text-twilio-red-dark">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          {stage === 'review' && (
            <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
              <div>
                <p className="mb-2 text-xs text-twilio-gray-60">
                  Read {rows.length} row{rows.length === 1 ? '' : 's'}. Check them against the picture — underscores
                  are what get misread most — then apply.
                </p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-twilio-gray-60">
                      <th className="w-8 pb-1">#</th>
                      <th className="pb-1">External_id</th>
                      <th className="w-16 pb-1">Limit</th>
                      <th className="w-24 pb-1">Per</th>
                      <th className="w-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className="border-t border-twilio-gray-10">
                        <td className="py-1 tabular-nums text-twilio-gray-60">{index + 1}</td>
                        <td className="py-1 pr-1">
                          <input
                            value={row.externalId}
                            onChange={(event) => update(index, { externalId: event.target.value })}
                            spellCheck={false}
                            className="w-full rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-[11px] focus:border-twilio-blue focus:outline-none"
                          />
                        </td>
                        <td className="py-1 pr-1">
                          <input
                            type="number"
                            min={1}
                            value={row.limit}
                            onChange={(event) => update(index, { limit: Math.max(1, Number.parseInt(event.target.value, 10) || 1) })}
                            className="w-full rounded border border-twilio-gray-20 px-1.5 py-1 tabular-nums focus:border-twilio-blue focus:outline-none"
                          />
                        </td>
                        <td className="py-1 pr-1">
                          <select
                            value={row.frequency}
                            onChange={(event) => update(index, { frequency: event.target.value })}
                            className="w-full rounded border border-twilio-gray-20 px-1 py-1 focus:border-twilio-blue focus:outline-none"
                          >
                            {LIMIT_FREQUENCIES.map((entry) => (
                              <option key={entry}>{entry}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1">
                          <button
                            type="button"
                            onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
                            title="Remove this row"
                            className="text-twilio-gray-40 hover:text-twilio-error"
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  onClick={() => setRows((current) => [...current, { externalId: '', limit: 1, frequency: 'Ever' }])}
                  className="mt-2 flex items-center gap-1 text-[11px] text-twilio-blue hover:underline"
                >
                  <Plus size={11} aria-hidden="true" />
                  Add a row
                </button>
                {problems.length > 0 && (
                  <ul className="mt-3 space-y-1 rounded-md bg-orange-50 px-3 py-2 text-[11px] text-twilio-navy">
                    {problems.map((problem) => (
                      <li key={problem} className="flex items-start gap-1.5">
                        <TriangleAlert size={11} className="mt-px shrink-0 text-twilio-warning" aria-hidden="true" />
                        {problem}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {preview && (
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-twilio-gray-60">Your screenshot</p>
                  <img src={preview} alt="The screenshot that was read" className="w-full rounded border border-twilio-gray-20" />
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-twilio-gray-20 bg-twilio-gray-10 px-4 py-2.5">
          <p className="text-[11px] text-twilio-gray-60">
            {stage === 'review' && existingCount > 0
              ? `Replaces the ${existingCount} row${existingCount === 1 ? '' : 's'} now in ${targetName}.`
              : `Fills in ${targetName}.`}
          </p>
          <div className="flex items-center gap-2">
            {stage === 'review' && (
              <button
                type="button"
                onClick={() => {
                  setStage('idle')
                  setRows([])
                  setProblems([])
                }}
                className="rounded-md border border-twilio-gray-20 bg-white px-3 py-1.5 text-xs text-twilio-gray-60 hover:text-twilio-navy"
              >
                Use a different image
              </button>
            )}
            <button
              type="button"
              disabled={stage !== 'review' || usable.length === 0}
              onClick={() => onApply(usable.map((row) => ({ ...row, externalId: row.externalId.trim() })))}
              className="rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-40"
            >
              Apply {usable.length > 0 ? `${usable.length} row${usable.length === 1 ? '' : 's'}` : ''}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
