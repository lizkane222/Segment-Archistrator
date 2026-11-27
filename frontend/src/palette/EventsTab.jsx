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
  GripVertical,
  Pencil,
  Play,
  Plus,
  UserRound,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
  Wand2,
} from 'lucide-react'

import { DRAG_MIME } from '../canvas/Canvas.jsx'
import { EVENT_KINDS } from '../canvas/kinds.js'
import { sampleCardData } from '../simulation/eventCard.js'
import {
  ACTIVE_PROFILE,
  SAVED_PROFILES,
  applyProfile,
  newProfile,
  profileFromSnapshot,
  profilesIn,
  summary as profileSummary,
} from '../simulation/profileLibrary.js'
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
  const profiles = profilesIn(useSyncExternalStore(SAVED_PROFILES.subscribe, SAVED_PROFILES.get))
  const activeId = useSyncExternalStore(ACTIVE_PROFILE.subscribe, ACTIVE_PROFILE.get)
  const active = profiles.find((entry) => entry.id === activeId) ?? null

  const { identifiers, defaults } = useMemo(() => identifiersFrom(diagram), [diagram])
  const match = useMemo(() => identityMatcher(identifiers), [identifiers])

  const setDraft = (type, text) => {
    const next = { ...(drafts ?? {}) }
    if (text == null) delete next[type]
    else next[type] = text
    EVENT_DRAFTS.set(next)
  }

  const run = (type, payload, name) => onStartSimulation?.(type, { event: payload, name })

  /*
   * Choosing a profile pours its ids and traits into every payload already being edited, and into the
   * ones opened after. A draft that is not valid JSON yet is left as it is: it is mid-edit, and a merge
   * into half a document would be a guess.
   */
  const chooseProfile = (id) => {
    const next = id === activeId ? null : id
    ACTIVE_PROFILE.set(next)
    const profile = profiles.find((entry) => entry.id === next)
    if (!profile) return
    const merged = { ...(drafts ?? {}) }
    for (const [type, text] of Object.entries(merged)) {
      const check = prepareEvent(text, type)
      if (check.ok) merged[type] = formatPayload(applyProfile(check.payload, profile))
    }
    EVENT_DRAFTS.set(merged)
  }

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

      {active && (
        <p className="flex items-center gap-1.5 rounded-md bg-twilio-gray-10 px-2 py-1.5 text-[10px] text-twilio-gray-60">
          <ProfileBadge profile={active} />
          <span className="min-w-0 flex-1">
            Payloads use <span className="font-semibold text-twilio-navy">{active.name}</span>’s ids and traits, and
            saved events are filed under them.
          </span>
          <button type="button" onClick={() => chooseProfile(active.id)} className="shrink-0 text-twilio-blue hover:underline">
            Show all
          </button>
        </p>
      )}

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
            profile={active}
            profiles={profiles}
            onRun={(payload, name) => run(type, payload, name)}
          />
        ))}
      </div>

      <ProfilesSection profiles={profiles} activeId={activeId} onChoose={chooseProfile} diagram={diagram} />
    </div>
  )
}

function EventTypeCard({ type, spec, open, onToggle, draft, onDraft, saved, match, profile, profiles, onRun }) {
  const Icon = spec.icon
  /* With a profile chosen, only its events: switching profile switches the list. Spec examples belong to
     nobody and stay. */
  const list = savedFor(saved, type).filter((entry) => !profile || entry.profileId === profile.id || entry.spec)

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
          profiles={profiles}
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
          profile={profile}
          onRun={onRun}
        />
      )}
    </section>
  )
}

/* Everything a drag from this tab carries: a card for the event, on its own copy of the payload. */
function startCardDrag(event, type, name, payload) {
  event.dataTransfer.setData(
    DRAG_MIME,
    JSON.stringify({ kind: 'event', name, data: sampleCardData({ type, payload, name }) }),
  )
  event.dataTransfer.effectAllowed = 'copy'
}

function SavedList({ type, list, saved, profiles = [], onRun, onEdit }) {
  const owner = (entry) => profiles.find((profile) => profile.id === entry.profileId)
  /* Re-checked on the way out: the list lives in browser storage, which a reader (or an older build)
     can have left in any shape. */
  const runEntry = (entry) => {
    const result = normalizeEvent(entry.payload, type)
    if (result.ok) onRun(result.payload, entry.name)
  }

  return (
    <ul className="space-y-1 border-t border-twilio-gray-10 px-2.5 py-1.5">
      {list.map((entry) => (
        <li
          key={entry.id}
          draggable
          onDragStart={(event) => {
            const result = normalizeEvent(entry.payload, type)
            if (!result.ok) return event.preventDefault()
            startCardDrag(event, type, entry.name, result.payload)
          }}
          title="Drag onto the canvas to show this event as a card"
          className="flex cursor-grab items-center gap-0.5 active:cursor-grabbing"
        >
          <GripVertical size={11} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
          <button
            type="button"
            onClick={() => runEntry(entry)}
            title={`Run “${entry.name}” through the walkthrough`}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-twilio-navy transition-colors hover:bg-twilio-blue-light"
          >
            <Play size={10} className="shrink-0 text-twilio-blue" aria-hidden="true" />
            {owner(entry) && <ProfileBadge profile={owner(entry)} small />}
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

function EventEditor({ type, label, draft, onDraft, saved, match, profile, onRun }) {
  const text = draft ?? formatPayload(profile ? applyProfile(skeleton(type), profile) : skeleton(type))
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
        /* Filed under the profile it was written for, so choosing that profile brings it back. */
        ...(profile ? { profileId: profile.id } : {}),
      }),
    )
    setName('')
  }

  return (
    <div className="space-y-2 border-t border-twilio-gray-10 px-2.5 pb-2.5 pt-2">
      <SpecPicker type={type} saved={saved} />

      <PayloadEditor value={text} onChange={edit} match={match} label={`${label} payload`} />

      <EditorStatus check={check} report={report} />

      <div
        draggable={check.ok}
        onDragStart={(event) => {
          if (!check.ok) return event.preventDefault()
          startCardDrag(event, type, name.trim() || suggestName(check.payload, type), check.payload)
        }}
        title={check.ok ? 'Drag onto the canvas to show this payload as a card' : 'Fix the payload to drag it'}
        className={`flex items-center gap-1.5 rounded border border-dashed px-2 py-1 text-[11px] ${
          check.ok
            ? 'cursor-grab border-twilio-blue/50 text-twilio-blue active:cursor-grabbing'
            : 'border-twilio-gray-20 text-twilio-gray-40'
        }`}
      >
        <GripVertical size={11} aria-hidden="true" />
        Drag onto the canvas as an event card
      </div>

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

/* --- profiles ------------------------------------------------------------- */

/* The "P" in a profile's colour: on the profile itself, and beside every event saved under it. */
function ProfileBadge({ profile, small = false }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${
        small ? 'h-3.5 w-3.5 text-[8px]' : 'h-5 w-5 text-[10px]'
      }`}
      style={{ background: profile.color }}
      title={`Profile: ${profile.name}`}
    >
      P
    </span>
  )
}

/*
 * The profiles kept in the sidebar, below the events. Click one to use it: its identifiers and traits go
 * into the payloads above and its events are the ones listed. Click it again for everyone's.
 */
function ProfilesSection({ profiles, activeId, onChoose, diagram }) {
  const [editing, setEditing] = useState(null) // null | 'new' | profile id
  const fromCanvas = useMemo(
    () =>
      (diagram?.nodes ?? []).filter(
        (node) =>
          node.kind === 'profile' &&
          (node.profileSnapshot?.identifiers?.length || Object.keys(node.profileSnapshot?.traits ?? {}).length),
      ),
    [diagram],
  )

  const remove = (id) => {
    if (id === activeId) ACTIVE_PROFILE.set(null)
    SAVED_PROFILES.set(profiles.filter((entry) => entry.id !== id))
  }

  return (
    <section className="rounded-md border border-twilio-gray-20 bg-white">
      <div className="flex items-center gap-2 border-b border-twilio-gray-10 px-2.5 py-2">
        <UserRound size={14} className="shrink-0 text-twilio-gray-60" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-twilio-navy">Profiles</span>
          <span className="block text-[10px] text-twilio-gray-60">One person’s ids and traits, to build their events from.</span>
        </span>
        <button
          type="button"
          onClick={() => setEditing(editing === 'new' ? null : 'new')}
          title="Save a new profile"
          aria-label="Save a new profile"
          className="rounded p-1 text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-blue"
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>

      {editing && (
        <ProfileForm
          key={editing}
          initial={editing === 'new' ? null : profiles.find((entry) => entry.id === editing)}
          onCancel={() => setEditing(null)}
          onSave={(profile) => {
            const exists = profiles.some((entry) => entry.id === profile.id)
            SAVED_PROFILES.set(exists ? profiles.map((entry) => (entry.id === profile.id ? profile : entry)) : [...profiles, profile])
            setEditing(null)
          }}
          profiles={profiles}
        />
      )}

      {profiles.length === 0 && !editing && (
        <p className="px-2.5 py-2 text-[11px] italic text-twilio-gray-60">
          None saved. Add one, or copy one from a Profile on the diagram.
        </p>
      )}

      <ul className="divide-y divide-twilio-gray-10">
        {profiles.map((profile) => (
          <li key={profile.id} className={`flex items-center gap-1 px-1.5 py-1 ${profile.id === activeId ? 'bg-twilio-blue-light/50' : ''}`}>
            <button
              type="button"
              onClick={() => onChoose(profile.id)}
              aria-pressed={profile.id === activeId}
              title={profile.id === activeId ? 'In use — click to show everyone’s events' : 'Use this profile'}
              className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-twilio-gray-10"
            >
              <ProfileBadge profile={profile} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-twilio-navy">{profile.name}</span>
                <span className="block truncate text-[10px] text-twilio-gray-60">{profileSummary(profile)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setEditing(profile.id)}
              aria-label={`Edit ${profile.name}`}
              title="Edit"
              className="rounded p-1 text-twilio-gray-40 hover:text-twilio-blue"
            >
              <Pencil size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => remove(profile.id)}
              aria-label={`Remove ${profile.name}`}
              title="Remove"
              className="rounded p-1 text-twilio-gray-40 hover:text-twilio-error"
            >
              <Trash2 size={11} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {fromCanvas.length > 0 && (
        <div className="border-t border-twilio-gray-10 px-2.5 py-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">On this diagram</p>
          {fromCanvas.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => SAVED_PROFILES.set([...profiles, profileFromSnapshot(node.profileSnapshot, node.name || 'Profile', profiles)])}
              className="mt-1 flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-twilio-navy hover:bg-twilio-blue-light"
              title="Copy this profile’s identifiers and traits into the list above"
            >
              <Plus size={10} className="shrink-0 text-twilio-blue" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Save “{node.name || 'Profile'}”</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/* Small on purpose: a name, the two ids that matter most, an email, and traits as JSON. Anything fancier
   is a Profile component on the diagram, whose snapshot can be copied in. */
function ProfileForm({ initial, profiles, onSave, onCancel }) {
  const idOf = (...types) => initial?.identifiers?.find((entry) => types.includes(entry.type))?.id ?? ''
  const [name, setName] = useState(initial?.name ?? '')
  const [userId, setUserId] = useState(idOf('user_id', 'userId'))
  const [anonymousId, setAnonymousId] = useState(idOf('anonymous_id', 'anonymousId'))
  const [email, setEmail] = useState(idOf('email'))
  const [traits, setTraits] = useState(initial?.traits && Object.keys(initial.traits).length ? JSON.stringify(initial.traits, null, 2) : '')
  const [error, setError] = useState(null)

  const save = () => {
    let parsed = {}
    if (traits.trim()) {
      try {
        parsed = JSON.parse(traits)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      } catch {
        setError('Traits need to be a JSON object, like {"plan": "pro"}.')
        return
      }
    }
    const identifiers = [
      { type: 'user_id', id: userId.trim() },
      { type: 'anonymous_id', id: anonymousId.trim() },
      { type: 'email', id: email.trim() },
      /* Identifiers of other types the profile already had survive an edit. */
      ...(initial?.identifiers ?? []).filter((entry) => !['user_id', 'userId', 'anonymous_id', 'anonymousId', 'email'].includes(entry.type)),
    ]
    if (!identifiers.some((entry) => entry.id)) {
      setError('Give it at least one identifier.')
      return
    }
    const built = newProfile({ name: name || userId || email || anonymousId, identifiers, traits: parsed }, profiles)
    onSave(initial ? { ...built, id: initial.id, color: initial.color } : built)
  }

  const field = 'nodrag w-full rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px] text-twilio-navy focus:border-twilio-blue focus:outline-none'
  return (
    <div className="space-y-1.5 border-b border-twilio-gray-10 px-2.5 py-2">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (Avery)" className={field} aria-label="Profile name" />
      <div className="grid grid-cols-2 gap-1.5">
        <input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="user_id" className={`${field} font-mono`} aria-label="user_id" />
        <input value={anonymousId} onChange={(event) => setAnonymousId(event.target.value)} placeholder="anonymous_id" className={`${field} font-mono`} aria-label="anonymous_id" />
      </div>
      <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email" className={`${field} font-mono`} aria-label="email" />
      <textarea value={traits} onChange={(event) => setTraits(event.target.value)} placeholder='Traits, as JSON: {"plan": "pro"}' rows={3} className={`${field} font-mono`} aria-label="Traits" />
      {error && <p className="text-[10px] text-twilio-error">{error}</p>}
      <div className="flex gap-1.5">
        <button type="button" onClick={save} className="nodrag flex-1 rounded-md bg-twilio-blue px-2 py-1 text-[11px] font-medium text-white hover:bg-twilio-blue-dark">
          {initial ? 'Save changes' : 'Save profile'}
        </button>
        <button type="button" onClick={onCancel} className="nodrag rounded-md border border-twilio-gray-20 px-2 py-1 text-[11px] text-twilio-gray-60 hover:text-twilio-navy">
          Cancel
        </button>
      </div>
    </div>
  )
}
