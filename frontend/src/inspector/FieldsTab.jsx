/*
 * Fields: the customer's real event and profile schema, from the Space Schema API.
 *
 * This is the tab that turns a diagram into something you can work from. Rather
 * than a generic "a Track call has properties", it shows *this* workspace's events,
 * their actual property paths, and sample values from real traffic.
 *
 * Nothing loads until this tab is opened, and an event's properties load only when
 * that event is expanded. The whole Space Schema surface allows 25 requests per
 * minute, which is the tightest budget in the API -- see useSpaceSchema.js.
 */

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search, TriangleAlert } from 'lucide-react'

import FieldTree from './FieldTree.jsx'
import { EmptyNote, Section } from './primitives.jsx'
import {
  buildFieldTree,
  countFields,
  filterFieldTree,
  normalizeEvent,
  pathsToExpand,
} from './fieldTree.js'
import { useEventProperties, useSpaceSchema } from './useSpaceSchema.js'

export default function FieldsTab({ node, spaces, space }) {
  const [spaceId, setSpaceId] = useState(space.spaceId)
  const schema = useSpaceSchema(spaceId)
  const properties = useEventProperties(spaceId)

  if (!spaces.length) {
    return (
      <Section title="Fields">
        <EmptyNote>
          No Unify space in this workspace, so there is no profile schema to read.
          Load the workspace first if you have not — spaces come from
          <span className="font-mono"> /api/workspace/graph</span>.
        </EmptyNote>
      </Section>
    )
  }

  if (!spaceId) {
    return (
      <Section
        title="Fields"
        note="This component is not tied to one space, and the workspace has several. Pick which schema to read."
      >
        <div className="flex flex-col gap-1">
          {spaces.map((option) => (
            <button
              key={option.segmentId}
              type="button"
              onClick={() => setSpaceId(option.segmentId)}
              className="rounded border border-twilio-gray-20 px-2 py-1.5 text-left text-xs text-twilio-navy transition-colors hover:border-twilio-blue hover:bg-twilio-blue-light"
            >
              {option.name}
            </button>
          ))}
        </div>
      </Section>
    )
  }

  const activeSpace = spaces.find((option) => option.segmentId === spaceId)

  return (
    <>
      <Section
        title="Space"
        actions={
          <button
            type="button"
            onClick={() => schema.load({ refresh: true })}
            disabled={schema.status === 'loading'}
            title="Re-read the schema from Segment, bypassing the cache"
            className="nodrag flex items-center gap-1 text-[10px] text-twilio-gray-60 hover:text-twilio-blue disabled:opacity-40"
          >
            <RefreshCw size={11} className={schema.status === 'loading' ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
      >
        <div className="flex items-center gap-2">
          <select
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
            className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 text-xs text-twilio-navy"
          >
            {spaces.map((option) => (
              <option key={option.segmentId} value={option.segmentId}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        {space.inferred && spaceId === space.spaceId && (
          <EmptyNote>
            {node.data.kind === 'source' ? 'This source' : 'This component'} carries no space
            of its own; {activeSpace?.name} is the workspace&rsquo;s only one.
          </EmptyNote>
        )}
        {schema.status === 'idle' && (
          <button
            type="button"
            onClick={() => schema.load()}
            className="nodrag mt-2 w-full rounded-md bg-twilio-blue px-2 py-1.5 text-xs font-medium text-white hover:bg-twilio-blue-dark"
          >
            Load schema
          </button>
        )}
      </Section>

      {schema.status === 'loading' && (
        <Section>
          <p className="flex items-center gap-2 text-xs text-twilio-gray-60">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            Reading events and traits…
          </p>
        </Section>
      )}

      {schema.status === 'error' && (
        <Section title="Fields">
          <p className="flex items-start gap-2 text-xs text-twilio-error">
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
            {schema.error?.message}
          </p>
          <EmptyNote>
            The Space Schema API is Alpha and rate-limited to 25 requests a minute.
            If this is a 429, waiting a minute is the fix.
          </EmptyNote>
        </Section>
      )}

      {schema.status === 'ready' && (
        <>
          <EventList
            events={schema.events}
            properties={properties}
            onExpand={(name) => properties.load(name)}
          />
          <TraitList traits={schema.traits} />
        </>
      )}
    </>
  )
}

function EventList({ events, properties, onExpand }) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(null)

  const normalized = useMemo(() => (events ?? []).map(normalizeEvent), [events])
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return normalized
    return normalized.filter((event) => event.name.toLowerCase().includes(needle))
  }, [normalized, search])

  const toggle = (name) => {
    if (open === name) {
      setOpen(null)
      return
    }
    setOpen(name)
    /* Load on expand, not on render. Loading all of them would be one request per
       event against a 25/minute budget. */
    onExpand(name)
  }

  return (
    <Section title={`Events (${normalized.length})`}>
      {normalized.length === 0 ? (
        <EmptyNote>
          No events in this space&rsquo;s schema yet. A new space stays empty until
          traffic flows through it.
        </EmptyNote>
      ) : (
        <>
          {normalized.length > 8 && (
            <label className="mb-2 flex items-center gap-1.5 rounded border border-twilio-gray-20 px-1.5 py-1">
              <Search size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter events"
                className="nodrag min-w-0 flex-1 text-xs outline-none"
              />
            </label>
          )}
          <ul className="flex flex-col">
            {visible.map((event) => (
              <EventRow
                key={event.name}
                event={event}
                isOpen={open === event.name}
                onToggle={() => toggle(event.name)}
                state={properties.byEvent[event.name]}
              />
            ))}
          </ul>
          {visible.length === 0 && <EmptyNote>No event matches &ldquo;{search}&rdquo;.</EmptyNote>}
        </>
      )}
    </Section>
  )
}

function EventRow({ event, isOpen, onToggle, state }) {
  return (
    <li className="border-b border-twilio-gray-20 py-1 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="nodrag flex w-full items-center gap-1 text-left"
      >
        {isOpen ? (
          <ChevronDown size={12} className="shrink-0 text-twilio-gray-40" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-twilio-gray-40" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-twilio-navy" title={event.name}>
          {event.name}
        </span>
        {event.count !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-twilio-gray-40">
            {event.count.toLocaleString?.() ?? event.count}
          </span>
        )}
      </button>
      {isOpen && <EventProperties state={state} />}
    </li>
  )
}

function EventProperties({ state }) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  const tree = useMemo(() => buildFieldTree(state?.items ?? []), [state?.items])
  const filtered = useMemo(() => filterFieldTree(tree, search), [tree, search])

  /* A search match buried three levels down would otherwise be filtered *in* but
     still collapsed out of sight. */
  const effectiveExpanded = useMemo(() => {
    if (!search.trim()) return expanded
    return new Set([...expanded, ...pathsToExpand(filtered)])
  }, [search, expanded, filtered])

  const toggle = (path) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (!state || state.status === 'loading') {
    return (
      <p className="ml-4 flex items-center gap-1.5 py-1 text-[11px] text-twilio-gray-60">
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        Loading properties…
      </p>
    )
  }

  if (state.status === 'error') {
    return <p className="ml-4 py-1 text-[11px] text-twilio-error">{state.error?.message}</p>
  }

  if (!tree.length) {
    return (
      <p className="ml-4 py-1 text-[11px] italic text-twilio-gray-60">
        No properties recorded for this event.
      </p>
    )
  }

  return (
    <div className="ml-4 mt-1">
      {countFields(tree) > 10 && (
        <label className="mb-1 flex items-center gap-1.5 rounded border border-twilio-gray-20 px-1.5 py-0.5">
          <Search size={11} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Filter ${countFields(tree)} fields`}
            className="nodrag min-w-0 flex-1 text-[11px] outline-none"
          />
        </label>
      )}
      <FieldTree nodes={filtered} expanded={effectiveExpanded} onToggle={toggle} />
      {filtered.length === 0 && (
        <p className="py-1 text-[11px] italic text-twilio-gray-60">No field matches.</p>
      )}
    </div>
  )
}

function TraitList({ traits }) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  const tree = useMemo(() => buildFieldTree(traits ?? []), [traits])
  const filtered = useMemo(() => filterFieldTree(tree, search), [tree, search])
  const effectiveExpanded = useMemo(() => {
    if (!search.trim()) return expanded
    return new Set([...expanded, ...pathsToExpand(filtered)])
  }, [search, expanded, filtered])

  const toggle = (path) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <Section
      title={`Profile traits (${countFields(tree)})`}
      note="Every trait on a user profile in this space, computed and set alike."
    >
      {tree.length === 0 ? (
        <EmptyNote>No profile traits recorded in this space.</EmptyNote>
      ) : (
        <>
          {countFields(tree) > 8 && (
            <label className="mb-1 flex items-center gap-1.5 rounded border border-twilio-gray-20 px-1.5 py-0.5">
              <Search size={11} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter traits"
                className="nodrag min-w-0 flex-1 text-[11px] outline-none"
              />
            </label>
          )}
          <FieldTree nodes={filtered} expanded={effectiveExpanded} onToggle={toggle} />
        </>
      )}
    </Section>
  )
}
