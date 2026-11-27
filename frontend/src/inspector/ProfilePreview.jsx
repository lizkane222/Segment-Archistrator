/*
 * The Profile preview: a real Unify profile, pasted in.
 *
 * Swaps in for the Palette in the left sidebar when a Profile node is selected --
 * see AppShell.jsx -- because a profile has more to show than the 96px right-hand
 * Inspector column has room for, and because the Palette is not useful while looking
 * at one.
 *
 * `data.profileSnapshot` is part of the node's data, so it is saved with the diagram
 * and carried into templates and exports along with everything else on the node.
 *
 * Traits are the one endpoint with no signal in the response for which of Unify's
 * categories a trait belongs to -- see profileSnapshot.js's `classifyTraits` for how
 * that question gets answered by reading the diagram instead of the trait's name.
 */

import { useMemo, useState } from 'react'
import {
  ClipboardPaste,
  Fingerprint,
  Link2,
  Sigma,
  Target,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react'

import { EmptyNote, IdRow, Row, Section } from './primitives.jsx'
import {
  PROFILE_KIND_LABELS,
  PROFILE_KIND_TEMPLATES,
  addField,
  classifyTraits,
  emptySnapshot,
  groupJourneys,
  importPaste,
  linkedCollections,
  profileIdentity,
} from './profileSnapshot.js'
import { iconFor, styleFor } from '../canvas/kinds.js'
import CopyButton from '../ui/CopyButton.jsx'

export default function ProfilePreview({ node, nodes, onUpdateNode, onClose, onNotify }) {
  const data = node.data
  const snapshot = data.profileSnapshot ?? emptySnapshot()
  const style = styleFor(data.kind, data.style)
  const Icon = iconFor(data.kind)
  const identity = profileIdentity(snapshot)

  const hasAnything =
    snapshot.identifiers.length > 0 ||
    Object.keys(snapshot.traits).length > 0 ||
    snapshot.events.length > 0 ||
    snapshot.links.length > 0 ||
    Object.keys(snapshot.metadata).length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-start gap-2 border-b border-twilio-gray-20 px-4 py-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded"
          style={{ background: style.bg, color: style.text, boxShadow: `inset 0 0 0 1px ${style.border}` }}
        >
          <Icon size={13} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-twilio-navy">{data.name || 'Profile'}</p>
          {/* The thing that tells this profile apart from every other Profile node on the
              canvas -- derived from the pasted data itself, never from `data.name`. See
              the file comment and profileSnapshot.js's `profileIdentity`. */}
          {identity && (
            <p className="truncate text-[11px] font-medium text-twilio-blue" title={`${identity.label}: ${identity.value}`}>
              {identity.label} · {identity.value}
            </p>
          )}
          <p className="text-[11px] text-twilio-gray-60">
            {snapshot.importedAt
              ? `Last pasted ${new Date(snapshot.importedAt).toLocaleString()}`
              : 'Nothing pasted yet'}
          </p>
        </div>
        {hasAnything && (
          <CopyButton text={JSON.stringify(snapshot, null, 2)} label="Copy the whole profile as JSON" size={14} />
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close profile preview"
          className="nodrag shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-navy"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PasteBox
          snapshot={snapshot}
          onAdd={(kind, field, value) => {
            onUpdateNode(node.id, { profileSnapshot: addField(snapshot, kind, field, value) })
            onNotify?.({ tone: 'info', message: `Added “${field}” to ${PROFILE_KIND_LABELS[kind]}.` })
          }}
          onImport={(kind, next) => {
            onUpdateNode(node.id, { profileSnapshot: next })
            onNotify?.({ tone: 'info', message: `Imported ${PROFILE_KIND_LABELS[kind]} from the Profile API.` })
          }}
        />

        {!hasAnything ? (
          <Section title="Profile">
            <EmptyNote>
              Nothing pasted yet. Paste a response from any of the Profile API's five
              endpoints above -- traits, external_ids, metadata, events, or links -- to
              preview it here. Each paste fills in the section it came from; paste all
              five to see the whole profile.
            </EmptyNote>
          </Section>
        ) : (
          <>
            <IdentifiersSection identifiers={snapshot.identifiers} />
            <TraitSections traits={snapshot.traits} nodes={nodes} />
            <EventsSection events={snapshot.events} />
            <LinksSection links={snapshot.links} />
            <MetadataSection metadata={snapshot.metadata} />
          </>
        )}
      </div>
    </div>
  )
}

/* What the two inputs ask for, per section: [field, value]. */
const FIELD_HINTS = {
  traits: ['trait name', 'value'],
  external_ids: ['id type (user_id)', 'id value'],
  metadata: ['key', 'value'],
  events: ['event name', 'property value or {json}'],
  links: ['collection (accounts)', 'linked id'],
}

function PasteBox({ snapshot, onImport, onAdd }) {
  const [text, setText] = useState('')
  /* Which section the chips are pointing at: filled by Import's templates and by the field below. */
  const [kind, setKind] = useState('traits')
  const [field, setField] = useState('')
  const [fieldValue, setFieldValue] = useState('')
  const [fieldError, setFieldError] = useState(null)

  const add = () => {
    try {
      onAdd(kind, field, fieldValue)
      setField('')
      setFieldValue('')
      setFieldError(null)
    } catch (err) {
      setFieldError(err.message)
    }
  }
  const [error, setError] = useState(null)

  const submit = () => {
    if (!text.trim()) return
    try {
      const { kind, snapshot: next } = importPaste(snapshot, text)
      onImport(kind, next)
      setText('')
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Section
      title="Paste profile data"
      note="From a Profile API call -- traits, external_ids, metadata, events, or links. Saved with the diagram."
    >
      {/* A starting point for whichever endpoint you're populating, so this doesn't
          require already knowing the exact envelope a real Profile API call returns.
          Replaces the textarea outright -- nothing is imported until Import is
          pressed, so there's nothing to lose by trying a different one. */}
      <div className="mb-1.5 flex flex-wrap gap-1">
        {Object.entries(PROFILE_KIND_LABELS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={kind === key}
            onClick={() => {
              setKind(key)
              setText(PROFILE_KIND_TEMPLATES[key])
              setError(null)
            }}
            className={`nodrag rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
              kind === key
                ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                : 'border-twilio-gray-20 text-twilio-slate hover:border-twilio-blue hover:text-twilio-blue'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        placeholder='{ "traits": { ... } }'
        rows={4}
        className="nodrag w-full rounded border border-twilio-gray-20 px-2 py-1.5 font-mono text-[11px] text-twilio-navy outline-none focus:border-twilio-blue"
      />
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-twilio-error">
          <TriangleAlert size={12} className="mt-px shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="nodrag mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-twilio-blue px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-40"
      >
        <ClipboardPaste size={13} aria-hidden="true" />
        Import
      </button>

      {/* The quick way in: one field and its value, added to whichever section is highlighted above. */}
      <div className="mt-3 border-t border-twilio-gray-10 pt-2">
        <p className="mb-1 text-[11px] font-semibold text-twilio-navy">
          Add a field to {PROFILE_KIND_LABELS[kind]}
        </p>
        <div className="flex gap-1">
          <input
            value={field}
            onChange={(event) => setField(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && add()}
            placeholder={FIELD_HINTS[kind][0]}
            className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-2 py-1 text-[11px] text-twilio-navy outline-none focus:border-twilio-blue"
          />
          <input
            value={fieldValue}
            onChange={(event) => setFieldValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && add()}
            placeholder={FIELD_HINTS[kind][1]}
            className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-2 py-1 text-[11px] text-twilio-navy outline-none focus:border-twilio-blue"
          />
          <button
            type="button"
            onClick={add}
            disabled={!field.trim()}
            className="nodrag shrink-0 rounded-md border border-twilio-blue px-2 py-1 text-[11px] font-medium text-twilio-blue transition-colors hover:bg-twilio-blue-light disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {fieldError && <p className="mt-1 text-[11px] text-twilio-error">{fieldError}</p>}
      </div>
    </Section>
  )
}

function IdentifiersSection({ identifiers }) {
  return (
    <Section title={`Identifiers (${identifiers.length})`}>
      {identifiers.length === 0 ? (
        <EmptyNote>No external_ids pasted yet.</EmptyNote>
      ) : (
        identifiers.map((entry, index) => (
          <div key={entry.id ?? index} className="border-b border-twilio-gray-10 py-1 last:border-b-0">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <IdRow label={entry.type ?? 'id'} value={entry.id} />
              </div>
              <CopyButton text={entry.type ?? 'id'} label={`Copy the key “${entry.type ?? 'id'}”`} size={12} />
            </div>
            <Row label="Collection" value={entry.collection} />
            <Row label="Source" value={entry.source_id} mono />
            <Row label="Created" value={entry.created_at} />
          </div>
        ))
      )}
    </Section>
  )
}

/* Journeys before Custom, the same "most decided about the profile first" ordering the
   real Unify explorer uses: audience and computed-trait membership, then journey
   progress, then the traits nothing else could vouch for. */
function TraitSections({ traits, nodes }) {
  const classified = useMemo(() => classifyTraits(traits, nodes), [traits, nodes])
  const total = Object.keys(traits ?? {}).length

  if (total === 0) {
    return (
      <Section title="Traits">
        <EmptyNote>No traits pasted yet.</EmptyNote>
      </Section>
    )
  }

  return (
    <>
      <TraitList
        title="Audiences"
        icon={Users}
        entries={classified.audiences}
        empty="None of the pasted traits match an audience component on this canvas."
      />
      <TraitList
        title="Computed traits"
        icon={Sigma}
        entries={classified.computedTraits}
        empty="None of the pasted traits match a computed trait component on this canvas."
      />
      <JourneysList journeyTraits={classified.journeys} />
      <TraitList
        title="Custom traits"
        icon={Fingerprint}
        entries={classified.custom}
        empty="Every pasted trait matched an audience, computed trait, or journey step."
        note={
          classified.custom.length > 0
            ? "Whatever's left after matching against this diagram's own audience and computed trait components -- see the note on the canvas's own Profile section for why there is nothing more precise than that to go on."
            : undefined
        }
      />
    </>
  )
}

/* A trait value straight off the API can be a string, number, boolean, null, or --
   Clearbit enrichment traits especially -- an array or a nested object. Stringifying
   those with `String()` produces "[object Object]" or an unbroken comma-joined blob
   with nowhere to wrap, which is what was happening before this. Object/array values
   get their own block below the key instead of squeezed into the same line. */
function isScalar(value) {
  return value === null || typeof value !== 'object'
}

function TraitValue({ value }) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-[11px] italic text-twilio-gray-60">Empty list</span>
    }
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          <span
            key={index}
            className="rounded border border-twilio-gray-20 bg-twilio-gray-10 px-1.5 py-0.5 font-mono text-[10px] text-twilio-slate"
          >
            {isScalar(item) ? String(item) : JSON.stringify(item)}
          </span>
        ))}
      </div>
    )
  }
  if (value !== null && typeof value === 'object') {
    return (
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-twilio-gray-20 bg-twilio-gray-10 p-1.5 font-mono text-[10px] leading-relaxed text-twilio-slate">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  if (value === null) return <span className="text-[11px] italic text-twilio-gray-60">null</span>
  return <span className="shrink-0 break-words text-[11px] text-twilio-gray-60">{String(value)}</span>
}

function TraitList({ title, icon: TraitIcon, entries, empty, note }) {
  return (
    <Section title={`${title} (${entries.length})`} note={note}>
      {entries.length === 0 ? (
        <EmptyNote>{empty}</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => {
            const scalar = isScalar(entry.value)
            return (
              <li key={entry.key} className="flex flex-col gap-1 py-0.5 text-xs">
                <div className="flex items-start gap-1.5">
                  <TraitIcon size={12} className="mt-0.5 shrink-0 text-twilio-gray-40" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-twilio-navy">
                    {entry.key}
                  </span>
                  <CopyButton text={entry.key} label={`Copy key “${entry.key}”`} size={11} />
                  {scalar && <TraitValue value={entry.value} />}
                  <CopyButton text={copyText(entry.value)} label={`Copy value of “${entry.key}”`} size={11} />
                </div>
                {!scalar && (
                  <div className="pl-[18px]">
                    <TraitValue value={entry.value} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

function JourneysList({ journeyTraits }) {
  const journeys = useMemo(() => groupJourneys(journeyTraits), [journeyTraits])

  return (
    <Section
      title={`Journeys (${journeys.length})`}
      note="Inferred from the j_o_<journey>__<step> computed traits a journey leaves behind -- Segment publishes no Journeys API, so this is the only signal there is."
    >
      {journeys.length === 0 ? (
        <EmptyNote>No journey-step traits (j_o_*) among the pasted traits.</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-2">
          {journeys.map(({ journey, steps }) => (
            <li key={journey}>
              <p className="text-xs font-semibold text-twilio-navy">{journey}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {steps.map((step) => (
                  <span
                    key={step.key}
                    title={step.key}
                    className="rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-slate"
                  >
                    {step.step}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const EVENTS_SHOWN = 8

function EventsSection({ events }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const [showAll, setShowAll] = useState(false)

  const visible = showAll ? events : events.slice(0, EVENTS_SHOWN)
  const hidden = events.length - visible.length

  const toggle = (id) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Section title={`Events (${events.length})`}>
      {events.length === 0 ? (
        <EmptyNote>No events pasted yet.</EmptyNote>
      ) : (
        <>
          <ul className="flex flex-col">
            {visible.map((event, index) => {
              const id = event.message_id ?? index
              const isOpen = expanded.has(id)
              return (
                <li key={id} className="flex items-start gap-1 border-b border-twilio-gray-10 py-1.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    className="nodrag flex w-full items-start justify-between gap-2 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-twilio-navy">
                        <Target size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
                        {event.event ?? 'Untitled event'}
                      </span>
                      {event.timestamp && (
                        <span className="text-[10px] text-twilio-gray-60">
                          {new Date(event.timestamp).toLocaleString()}
                        </span>
                      )}
                    </span>
                  </button>
                  {isOpen && (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-twilio-gray-20 bg-twilio-gray-10 p-2 font-mono text-[10px] leading-relaxed text-twilio-slate">
                      {JSON.stringify(event.properties ?? {}, null, 2)}
                    </pre>
                  )}
                  </div>
                  <CopyButton text={event.event ?? ''} label="Copy event name" size={11} />
                  <CopyButton text={copyText(event.properties ?? {})} label="Copy event properties as JSON" size={11} />
                </li>
              )
            })}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="nodrag mt-1 text-[10px] text-twilio-blue hover:underline"
            >
              Show {hidden} more
            </button>
          )}
        </>
      )}
    </Section>
  )
}

function LinksSection({ links }) {
  const groups = useMemo(() => linkedCollections(links), [links])

  return (
    <Section title={`Linked profiles (${links.length})`}>
      {groups.length === 0 ? (
        <EmptyNote>No links pasted yet.</EmptyNote>
      ) : (
        groups.map(({ collection, entries }) => (
          <div key={collection} className="py-1">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-twilio-gray-60">
              <Link2 size={11} aria-hidden="true" />
              {collection} ({entries.length})
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {entries.map((entry, index) =>
                (entry.external_ids ?? []).map((external, subIndex) => (
                  <li key={`${index}:${subIndex}`} className="rounded border border-twilio-gray-20 px-1.5 py-1">
                    <Row label={external.type ?? 'id'} value={external.id} mono copy />
                  </li>
                )),
              )}
            </ul>
          </div>
        ))
      )}
    </Section>
  )
}

function MetadataSection({ metadata }) {
  if (Object.keys(metadata).length === 0) {
    return (
      <Section title="Metadata">
        <EmptyNote>No metadata pasted yet.</EmptyNote>
      </Section>
    )
  }

  return (
    <Section title="Metadata">
      {metadata.segment_id && <IdRow label="Profile ID" value={metadata.segment_id} />}
      <Row label="Created" value={metadata.created_at} copy />
      <Row label="Updated" value={metadata.updated_at} copy />
      <Row label="First source" value={metadata.first_source_id} mono copy />
      <Row label="First message" value={metadata.first_message_id} mono copy />
      <Row label="Last message" value={metadata.last_message_id} mono copy />
    </Section>
  )
}

/* A value as text for the clipboard: scalars as they read, lists and objects as JSON. */
function copyText(value) {
  return value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')
}
