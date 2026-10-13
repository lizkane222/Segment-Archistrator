/*
 * The Events tab: one editable payload per call type, a list of saved ones under each, and the Spec's
 * own examples to add to that list.
 *
 * Events are not components -- they flow through the diagram -- so nothing here is draggable. Every
 * action ends in the walkthrough: Run starts a path with the payload in the editor, and clicking a
 * saved event starts one with that event.
 *
 * Nothing reaches the walkthrough uncorrected. What is typed goes through `prepareEvent`
 * (simulation/eventLibrary.js), the corrected text replaces what was typed, and the corrections are
 * listed -- so the reader can see that `{event: 'X',}` ran as `{"type": "track", "event": "X", ...}`
 * rather than wondering why the payload changed under them.
 *
 * Keys that identity resolution matches on are coloured in the editor. They are the fields that
 * decide which profile an event lands on, and in a thirty-line payload they are otherwise the easiest
 * thing to miss.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Fingerprint,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
  Wand2,
} from 'lucide-react'

import { EVENT_KINDS } from '../canvas/kinds.js'
import { skeleton } from '../simulation/payload.js'
import {
  EVENT_DRAFTS,
  SAVED_EVENTS,
  SPEC_LABELS,
  formatPayload,
  highlightRuns,
  identifiersFrom,
  identityMatcher,
  normalizeEvent,
  prepareEvent,
  savedFor,
  specDocsUrl,
  specEventsFor,
  specLabel,
  suggestName,
  toggleSpec,
  withSaved,
  withoutSaved,
} from '../simulation/eventLibrary.js'

/* The identity resolution colour, the same purple the Identity Resolution component wears on the
   canvas -- so a highlighted key reads as "this is what that component keys on". */
const IDENTITY_TEXT = 'text-[#6f42c1]'
const IDENTITY_MARK = 'rounded-sm bg-[#6f42c1]/10 text-[#6f42c1]'

export default function EventsTab({ diagram, onStartSimulation }) {
  const saved = useSyncExternalStore(SAVED_EVENTS.subscribe, SAVED_EVENTS.get)
  const drafts = useSyncExternalStore(EVENT_DRAFTS.subscribe, EVENT_DRAFTS.get)
  const [openType, setOpenType] = useState(null)

  const { identifiers, defaults } = useMemo(() => identifiersFrom(diagram), [diagram])
  const match = useMemo(() => identityMatcher(identifiers), [identifiers])

  const setDraft = (type, text) => {
    const next = { ...(drafts ?? {}) }
    if (text == null) delete next[type]
    else next[type] = text
    EVENT_DRAFTS.set(next)
  }

  const run = (type, payload, name) => onStartSimulation?.(type, { event: payload, name })

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-twilio-gray-60">
        Events are not components — they flow through the diagram. Open a type to edit its payload
        and run it, or click a saved event to run that one.
      </p>

      <p className="flex items-start gap-1.5 rounded-md bg-twilio-gray-10 px-2 py-1.5 text-[10px] leading-relaxed text-twilio-gray-60">
        <Fingerprint size={11} className={`mt-px shrink-0 ${IDENTITY_TEXT}`} aria-hidden="true" />
        <span>
          Fields identity resolution matches on are{' '}
          <span className={`${IDENTITY_MARK} px-0.5 font-mono`}>highlighted</span>:{' '}
          <span className="font-mono">{identifiers.join(', ')}</span>.{' '}
          {defaults
            ? 'These are Segment’s defaults — add an Identity Resolution Rule to the diagram to use your own.'
            : 'Read from the Identity Resolution Rules on this diagram.'}
        </span>
      </p>

      <div className="space-y-1.5">
        {Object.entries(EVENT_KINDS).map(([type, spec]) => (
          <EventTypeCard
            key={type}
            type={type}
            spec={spec}
            open={openType === type}
            onToggle={() => setOpenType((current) => (current === type ? null : type))}
            draft={drafts?.[type]}
            onDraft={(text) => setDraft(type, text)}
            saved={saved}
            match={match}
            onRun={(payload, name) => run(type, payload, name)}
          />
        ))}
      </div>
    </div>
  )
}

function EventTypeCard({ type, spec, open, onToggle, draft, onDraft, saved, match, onRun }) {
  const Icon = spec.icon
  const list = savedFor(saved, type)

  return (
    <section className="rounded-md border border-twilio-gray-20 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-twilio-blue-light"
      >
        <Icon size={14} className="shrink-0 text-twilio-gray-60" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-twilio-navy">{spec.label}</span>
          <span className="block truncate text-[10px] text-twilio-gray-60">{spec.hint}</span>
        </span>
        {list.length > 0 && (
          <span className="shrink-0 rounded-full bg-twilio-gray-10 px-1.5 text-[10px] tabular-nums text-twilio-gray-60">
            {list.length}
          </span>
        )}
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
        )}
      </button>

      {/* The saved list shows whether or not the card is open: it is the quick way to run something,
          and making it a click further away than the editor would invert which one is the shortcut. */}
      {list.length > 0 && (
        <SavedList
          type={type}
          list={list}
          saved={saved}
          onRun={onRun}
          onEdit={(entry) => {
            onDraft(formatPayload(entry.payload))
            if (!open) onToggle()
          }}
        />
      )}

      {open && (
        <EventEditor
          type={type}
          label={spec.label}
          draft={draft}
          onDraft={onDraft}
          saved={saved}
          match={match}
          onRun={onRun}
        />
      )}
    </section>
  )
}

function SavedList({ type, list, saved, onRun, onEdit }) {
  /* Re-checked on the way out: the list lives in browser storage, which a reader (or an older build)
     can have left in any shape. */
  const runEntry = (entry) => {
    const result = normalizeEvent(entry.payload, type)
    if (result.ok) onRun(result.payload, entry.name)
  }

  return (
    <ul className="space-y-1 border-t border-twilio-gray-10 px-2.5 py-1.5">
      {list.map((entry) => (
        <li key={entry.id} className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => runEntry(entry)}
            title={`Run “${entry.name}” through the walkthrough`}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-twilio-navy transition-colors hover:bg-twilio-blue-light"
          >
            <Play size={10} className="shrink-0 text-twilio-blue" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.spec && (
              <span className="shrink-0 rounded bg-twilio-gray-10 px-1 text-[9px] uppercase tracking-wide text-twilio-gray-60">
                Spec
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onEdit(entry)}
            title="Open this payload in the editor"
            aria-label={`Edit ${entry.name}`}
            className="rounded p-1 text-twilio-gray-40 hover:text-twilio-blue"
          >
            <Pencil size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => SAVED_EVENTS.set(withoutSaved(saved, type, entry.id))}
            title="Remove from this list"
            aria-label={`Remove ${entry.name}`}
            className="rounded p-1 text-twilio-gray-40 hover:text-twilio-error"
          >
            <Trash2 size={11} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function EventEditor({ type, label, draft, onDraft, saved, match, onRun }) {
  const text = draft ?? formatPayload(skeleton(type))
  /* Recomputed as they type, so the status line can say what Run will do before it is pressed. */
  const check = useMemo(() => prepareEvent(text, type), [text, type])
  /* What the last Run or Save actually corrected, kept until the next edit so it can be read. */
  const [report, setReport] = useState(null)
  const [name, setName] = useState('')

  const edit = (value) => {
    setReport(null)
    onDraft(value)
  }

  /* The gate. Returns the corrected payload, or null and an explanation. */
  const commit = () => {
    if (!check.ok) {
      setReport({ error: check.error, fixes: check.fixes })
      return null
    }
    if (check.text !== text) onDraft(check.text)
    setReport({ fixes: check.fixes })
    return check.payload
  }

  const runNow = () => {
    const payload = commit()
    if (payload) onRun(payload, name.trim() || suggestName(payload, type))
  }

  const save = () => {
    const payload = commit()
    if (!payload) return
    SAVED_EVENTS.set(
      withSaved(saved, type, {
        id: `saved:${crypto.randomUUID().slice(0, 8)}`,
        name: name.trim() || suggestName(payload, type),
        payload,
      }),
    )
    setName('')
  }

  return (
    <div className="space-y-2 border-t border-twilio-gray-10 px-2.5 pb-2.5 pt-2">
      <SpecPicker type={type} saved={saved} />

      <PayloadEditor value={text} onChange={edit} match={match} label={`${label} payload`} />

      <EditorStatus check={check} report={report} />

      <div className="flex items-center gap-1">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={check.ok ? suggestName(check.payload, type) : 'Name'}
          aria-label="Name for this event"
          className="min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px] placeholder:text-twilio-gray-40"
        />
        <button
          type="button"
          onClick={save}
          title="Correct the payload and add it to the list above"
          className="flex shrink-0 items-center gap-1 rounded border border-twilio-gray-20 px-2 py-1 text-[11px] text-twilio-gray-80 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
        >
          <Save size={11} aria-hidden="true" />
          Save
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={runNow}
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-twilio-blue px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-twilio-blue-dark"
        >
          <Play size={11} aria-hidden="true" />
          Run in walkthrough
        </button>
        <button
          type="button"
          onClick={() => {
            setReport(null)
            onDraft(null)
          }}
          title="Put the sample payload back"
          aria-label="Reset to the sample payload"
          className="rounded-md border border-twilio-gray-20 p-1.5 text-twilio-gray-60 transition-colors hover:text-twilio-navy"
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/*
 * What will happen to the payload, said before and after.
 *
 * Before (`check`, live): valid, will be corrected, or cannot be read. After (`report`, from the last
 * Run or Save): the list of corrections that were applied, so they are not lost the moment the
 * corrected text replaces what was typed.
 */
function EditorStatus({ check, report }) {
  if (report?.error || !check.ok) {
    return (
      <p className="flex items-start gap-1.5 rounded-md border border-twilio-error/40 bg-red-50 px-2 py-1.5 text-[10px] leading-snug text-twilio-red-dark">
        <TriangleAlert size={11} className="mt-px shrink-0" aria-hidden="true" />
        <span>{report?.error ?? check.error} Nothing will run until it can be read.</span>
      </p>
    )
  }

  if (report?.fixes?.length) {
    return (
      <div className="rounded-md border border-twilio-warning/40 bg-orange-50 px-2 py-1.5 text-[10px] leading-snug text-twilio-gray-80">
        <p className="flex items-center gap-1.5 font-semibold">
          <Wand2 size={11} className="shrink-0 text-twilio-warning" aria-hidden="true" />
          Corrected before running
        </p>
        <ul className="mt-0.5 list-disc pl-5">
          {report.fixes.map((fix) => (
            <li key={fix}>{fix}</li>
          ))}
        </ul>
      </div>
    )
  }

  if (check.fixes.length) {
    return (
      <p className="flex items-start gap-1.5 text-[10px] leading-snug text-twilio-warning">
        <Wand2 size={11} className="mt-px shrink-0" aria-hidden="true" />
        <span>
          Not valid yet — {check.fixes.length} correction{check.fixes.length === 1 ? '' : 's'} will be
          applied when you run or save it.
        </span>
      </p>
    )
  }

  return (
    <p className="flex items-center gap-1.5 text-[10px] text-twilio-success">
      <Check size={11} className="shrink-0" aria-hidden="true" />
      Valid {check.payload.type} call.
    </p>
  )
}

/*
 * A textarea with the identity fields coloured.
 *
 * A textarea cannot colour its own text, so the text is drawn twice: once in a `pre` underneath with
 * the colours, and once in the textarea on top with transparent glyphs and a visible caret. The two
 * have to lay out identically or the colours drift off the characters, which is why they share one
 * class string and both always reserve a scrollbar.
 */
function PayloadEditor({ value, onChange, match, label }) {
  const backdrop = useRef(null)
  const runs = useMemo(() => highlightRuns(value, match), [value, match])
  const shared =
    'absolute inset-0 m-0 h-full w-full overflow-y-scroll whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-[15px]'

  return (
    <div className="relative h-56 overflow-hidden rounded border border-twilio-gray-20 bg-white focus-within:border-twilio-blue">
      <pre ref={backdrop} aria-hidden="true" className={`${shared} pointer-events-none text-twilio-navy`}>
        {runs.map((run, index) =>
          run.identifier ? (
            <mark key={index} className={IDENTITY_MARK}>
              {run.text}
            </mark>
          ) : (
            <span key={index}>{run.text}</span>
          ),
        )}
        {/* A trailing newline in a textarea opens a line; in a `pre` it does not, without this. */}
        {'\n'}
      </pre>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (!backdrop.current) return
          backdrop.current.scrollTop = event.target.scrollTop
          backdrop.current.scrollLeft = event.target.scrollLeft
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={label}
        className={`${shared} resize-none border-0 bg-transparent text-transparent caret-twilio-navy outline-none selection:bg-twilio-blue/20`}
      />
    </div>
  )
}

/*
 * The Spec's documented examples for this type, as a multi-select.
 *
 * Ticking one adds it to the saved list under the type and unticking removes it, so the list above
 * *is* the selection -- there is no second "apply" step to forget. Stays open while ticking, since
 * picking several is the point, and closes on a click anywhere outside it or on Escape.
 */
function SpecPicker({ type, saved }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const entries = specEventsFor(type)
  const ticked = new Set(savedFor(saved, type).map((entry) => entry.spec).filter(Boolean))
  const groups = useMemo(() => {
    const byGroup = new Map()
    for (const entry of entries) {
      if (!byGroup.has(entry.spec)) byGroup.set(entry.spec, [])
      byGroup.get(entry.spec).push(entry)
    }
    return [...byGroup]
  }, [entries])

  if (!entries.length) return null

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded border border-twilio-gray-20 px-2 py-1 text-left text-[11px] text-twilio-gray-80 transition-colors hover:border-twilio-gray-40"
      >
        <span className="min-w-0 flex-1 truncate">Segment Spec examples</span>
        {ticked.size > 0 && (
          <span className="shrink-0 text-[10px] text-twilio-gray-60">{ticked.size} added</span>
        )}
        <ChevronDown size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Segment Spec examples"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-twilio-gray-20 bg-white py-1 shadow-lg"
        >
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[9px] font-bold uppercase tracking-widest text-twilio-gray-60">
                <span className="flex-1">{SPEC_LABELS[group] ?? group}</span>
                <a
                  href={specDocsUrl(group)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this part of the Spec in Segment’s docs"
                  className="text-twilio-gray-40 hover:text-twilio-blue"
                >
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              </div>
              {items.map((entry) => {
                const on = ticked.has(entry.key)
                return (
                  <label
                    key={entry.key}
                    role="option"
                    aria-selected={on}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] text-twilio-navy hover:bg-twilio-gray-10"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => SAVED_EVENTS.set(toggleSpec(SAVED_EVENTS.get(), entry))}
                      className="accent-twilio-blue"
                    />
                    <span className="truncate">{specLabel(entry)}</span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
