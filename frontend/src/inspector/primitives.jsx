/*
 * The shared row/section primitives every inspector tab is built from.
 *
 * They live together because they carry the panel's two conventions:
 *
 *   1. A label/value row is a definition list, not a table. Values wrap and can
 *      be long (a 400-character FQL condition, a URL), and labels never should.
 *   2. Anything sensitive is masked until asked for. `IdRow` and `WriteKeyRow`
 *      are the only paths by which an id or a key reaches the screen, so the
 *      obfuscation requirement is satisfied by construction rather than by each
 *      tab remembering.
 */

import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2, Pencil } from 'lucide-react'

import CopyButton from '../ui/CopyButton.jsx'
import { workspace as workspaceApi } from '../services/api.js'

export function Section({ title, note, children, actions }) {
  return (
    <section className="border-b border-twilio-gray-20 px-4 py-3 last:border-b-0">
      {title && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60">
            {title}
          </h3>
          {actions}
        </div>
      )}
      {note && <p className="mb-2 text-[11px] leading-relaxed text-twilio-gray-60">{note}</p>}
      {children}
    </section>
  )
}

export function Row({ label, value, mono = false, copy = false, children, field = null }) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      {/* The eye goes *before* the label, in the gutter, so the column of them lines up and can be
          scanned as a list of what the card shows. After the value it would sit at a different
          x on every row, depending how long the value was. */}
      <FieldEye field={field} label={label} />
      <span className="w-28 shrink-0 pt-px text-twilio-gray-60">{label}</span>
      <span className="flex min-w-0 flex-1 items-start gap-1">
        {children ?? (
          <span
            className={`min-w-0 break-words ${mono ? 'font-mono text-[11px]' : ''} ${
              empty ? 'text-twilio-gray-40 italic' : 'text-twilio-navy'
            }`}
          >
            {empty ? 'not set' : String(value)}
          </span>
        )}
        {copy && !empty && <CopyButton text={String(value)} />}
      </span>
    </div>
  )
}

/**
 * A Segment resource id, masked until revealed.
 *
 * The id is not a credential -- it is in every deep link -- but it is
 * customer-identifying, and these panels get screen-shared and screenshotted in
 * customer-facing sessions. Hidden by default costs one click and removes a whole
 * category of accident.
 */
export function IdRow({ label, value, field = null }) {
  const [shown, setShown] = useState(false)
  if (!value) return <Row label={label} value={null} field={field} />

  return (
    <Row label={label} field={field}>
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-twilio-navy">
        {shown ? value : '•'.repeat(Math.min(value.length, 22))}
      </span>
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        title={shown ? `Hide ${label}` : `Show ${label}`}
        className="nodrag shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-blue"
      >
        {shown ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
      </button>
      {shown && <CopyButton text={value} label={`Copy ${label}`} />}
    </Row>
  )
}

/* How long a revealed write key stays on screen. A key revealed during a
   screen-share and then forgotten is the exact failure this guards against, so it
   re-masks itself rather than relying on anyone remembering. */
const REVEAL_SECONDS = 30

/**
 * The source write key: masked, with an explicit audited reveal.
 *
 * The real key is never in the graph payload. Revealing it is a POST to
 * `/api/workspace/sources/:id/reveal-write-key`, which fetches it live from
 * Segment, writes an audit row, and does not cache it. This component holds the
 * result in state only, and drops it on unmount or on timeout.
 */
export function WriteKeyRow({ sourceId, masked, onNotify }) {
  const [key, setKey] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [loading, setLoading] = useState(false)
  const timer = useRef(null)

  /* Drop the key when the inspector moves to another node. Without this, keeping
     a stale key in state across selections is one careless render away from
     showing it on the wrong node. */
  useEffect(() => {
    setKey(null)
    setRemaining(0)
  }, [sourceId])

  useEffect(() => {
    if (!key) return undefined
    timer.current = setInterval(() => {
      setRemaining((current) => {
        if (current <= 1) {
          setKey(null)
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => clearInterval(timer.current)
  }, [key])

  const reveal = async () => {
    setLoading(true)
    try {
      const result = await workspaceApi.revealWriteKey(sourceId)
      setKey(result.writeKey)
      setRemaining(REVEAL_SECONDS)
      onNotify?.({
        tone: 'info',
        message: `Write key revealed and logged. It hides again in ${REVEAL_SECONDS}s.`,
      })
    } catch (err) {
      onNotify?.({ tone: 'error', message: err.message })
    } finally {
      setLoading(false)
    }
  }

  if (!masked && !key) return null

  return (
    <Row label="Write key">
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-twilio-navy">
        {key ?? masked}
      </span>
      {key ? (
        <>
          <span className="shrink-0 text-[10px] tabular-nums text-twilio-warning">
            {remaining}s
          </span>
          <CopyButton text={key} label="Copy write key" />
        </>
      ) : (
        <button
          type="button"
          onClick={reveal}
          disabled={loading || !sourceId}
          title="Fetch the real write key. This is logged."
          className="nodrag flex shrink-0 items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-warning hover:text-twilio-warning disabled:opacity-40"
        >
          {loading ? (
            <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          ) : (
            <KeyRound size={11} aria-hidden="true" />
          )}
          Reveal
        </button>
      )}
    </Row>
  )
}

export function EmptyNote({ children }) {
  return <p className="py-1 text-xs italic leading-relaxed text-twilio-gray-60">{children}</p>
}

/**
 * Click-to-edit text.
 *
 * Committing on blur rather than on every keystroke: each commit replaces the
 * node in React Flow's store, and doing that per character makes typing in a
 * 300-node diagram visibly lag.
 *
 * `resetKey` is what the draft is discarded on -- the node id, so the next
 * selection does not inherit this one's half-typed value.
 */
/**
 * The show-on-card toggle that sits beside a field.
 *
 * Renders a fixed-width spacer when the field is not toggleable, rather than nothing: `Name` has no
 * eye, and without the spacer its label would sit 17px left of every other label in the panel, which
 * reads as a rendering fault rather than as an absence.
 *
 * @param field  `{shown, onToggle}`, or null for a field that is not toggleable
 */
export function FieldEye({ field, label }) {
  if (!field) return <span className="w-[17px] shrink-0" aria-hidden="true" />
  return (
    <button
      type="button"
      onClick={() => field.onToggle(!field.shown)}
      aria-pressed={field.shown}
      title={
        field.shown
          ? `${label} is shown on the component. Click to hide it.`
          : `${label} is hidden from the component. Click to show it.`
      }
      className={`nodrag mt-px shrink-0 transition-colors ${
        field.shown
          ? 'text-twilio-blue hover:text-twilio-blue-dark'
          : 'text-twilio-gray-40 hover:text-twilio-navy'
      }`}
    >
      {field.shown ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
    </button>
  )
}

export function EditableText({
  resetKey,
  label,
  value,
  placeholder,
  multiline = false,
  onCommit,
  field = null,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
    setEditing(false)
  }, [resetKey, value])

  const commit = () => {
    setEditing(false)
    if (draft !== value) onCommit(draft)
  }

  if (!editing) {
    return (
      <Row label={label} field={field}>
        <span
          className={`min-w-0 flex-1 break-words ${
            value ? 'text-twilio-navy' : 'italic text-twilio-gray-40'
          }`}
        >
          {value || placeholder}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={`Edit ${label.toLowerCase()}`}
          className="nodrag shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-blue"
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      </Row>
    )
  }

  const Field = multiline ? 'textarea' : 'input'
  return (
    <Row label={label} field={field}>
      <Field
        autoFocus
        value={draft}
        rows={multiline ? 3 : undefined}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !multiline) commit()
          if (event.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        className="nodrag min-w-0 flex-1 rounded border border-twilio-blue px-1.5 py-1 text-xs text-twilio-navy outline-none"
      />
    </Row>
  )
}
