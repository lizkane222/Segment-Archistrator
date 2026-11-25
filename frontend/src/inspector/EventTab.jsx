/*
 * The Event tab: which of an event's fields its card shows.
 *
 * Every key:value pair of the payload is a row with an eye. Nothing is on to begin with. The choice is
 * stored on this card alone, so a duplicate -- or a preview of the same event further down the path --
 * can show a different set: the customer id where it enters, the mapped fields where it leaves.
 *
 * A *sample* card owns its payload and can start a path from it. A *preview* card owns no payload: it
 * names a path and a place on it, and shows what the walkthrough holds there.
 */

import { useMemo } from 'react'
import { useState } from 'react'
import { Eye, EyeOff, Play, Plus, Trash2 } from 'lucide-react'

import { EmptyNote, Section } from './primitives.jsx'
import {
  coerceLike,
  displayValue,
  flattenPayload,
  removeAt,
  setValueAt,
  toggleField,
} from '../simulation/eventCard.js'

export default function EventTab({ node, nodes, scenarios, onUpdate, onStartSimulation }) {
  const data = node.data
  const preview = data.preview ?? null
  const payload = preview ? data.eventNow : data.eventPayload
  const rows = useMemo(() => flattenPayload(payload), [payload])
  const shown = data.shownFields ?? []

  const anchorName = useMemo(() => {
    if (!preview?.anchor) return null
    if (preview.anchor.type === 'edge') return 'a connector'
    return nodes?.find((candidate) => candidate.id === preview.anchor.id)?.data?.name ?? 'a component'
  }, [preview, nodes])

  const setShown = (next) => onUpdate({ shownFields: next })
  /* A sample card owns its payload, so its values can be edited here. A preview shows what a path holds at
     a place and has no payload of its own to change. */
  const editable = !preview
  const stacked = data.eventLayout === 'stacked'
  const writePayload = (next) => onUpdate({ eventPayload: next })
  const [newPath, setNewPath] = useState('')
  const [newValue, setNewValue] = useState('')

  return (
    <>
      <Section
        title={preview ? 'Event at this point' : 'Event'}
        note={
          preview
            ? `Shows the event as it stands at ${anchorName}, on the path chosen below.`
            : 'A copy of this event. Edit its values, add or remove fields, and pick which the card shows.'
        }
      >
        <label className="block text-xs">
          <span className="text-twilio-gray-60">Card title</span>
          <input
            defaultValue={data.name ?? ''}
            key={node.id}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next && next !== data.name) onUpdate({ name: next })
            }}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            className="nodrag mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1 text-xs text-twilio-navy focus:border-twilio-blue focus:outline-none"
          />
        </label>

        {preview && (
          <label className="mt-2 block text-xs">
            <span className="text-twilio-gray-60">Path</span>
            <select
              value={preview.scenarioId ?? ''}
              onChange={(event) => onUpdate({ preview: { ...preview, scenarioId: event.target.value } })}
              className="nodrag mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1 text-xs text-twilio-navy focus:border-twilio-blue focus:outline-none"
            >
              {(scenarios ?? []).map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {!preview && onStartSimulation && (
          <button
            type="button"
            onClick={() =>
              onStartSimulation(data.eventType ?? data.eventPayload?.type ?? 'track', {
                event: data.eventPayload,
                name: data.name,
              })
            }
            className="nodrag mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-twilio-blue px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark"
          >
            <Play size={12} aria-hidden="true" />
            Run as a path
          </button>
        )}
      </Section>

      <Section title="Layout" note="How the fields read on the card.">
        <div className="flex gap-1" role="group" aria-label="Field layout">
          {[
            ['inline', 'Key and value on one line', 'A longer, shorter card.'],
            ['stacked', 'Value under its key', 'A narrower, taller card.'],
          ].map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              onClick={() => onUpdate({ eventLayout: id === 'inline' ? undefined : id })}
              aria-pressed={(id === 'stacked') === stacked}
              title={hint}
              className={`nodrag flex-1 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                (id === 'stacked') === stacked
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                  : 'border-twilio-gray-20 text-twilio-gray-60 hover:text-twilio-navy'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title={`Fields (${shown.length}/${rows.length} shown)`}
        actions={
          rows.length > 0 && (
            <span className="flex gap-2 text-[10px]">
              <button
                type="button"
                onClick={() => setShown(rows.map((row) => row.path))}
                className="nodrag text-twilio-gray-60 hover:text-twilio-blue"
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => setShown([])}
                className="nodrag text-twilio-gray-60 hover:text-twilio-blue"
              >
                Hide all
              </button>
            </span>
          )
        }
      >
        {rows.length === 0 ? (
          <EmptyNote>
            {preview
              ? 'No event reaches this point on the chosen path, or no path has been run yet.'
              : 'This event has no fields.'}
          </EmptyNote>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => {
              const on = shown.includes(row.path)
              return (
                <li key={row.path} className="flex items-start gap-1.5 border-b border-twilio-gray-10 py-1 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setShown(toggleField(shown, row.path))}
                    aria-pressed={on}
                    aria-label={`${on ? 'Hide' : 'Show'} ${row.path} on the card`}
                    title={on ? 'Shown on the card' : 'Hidden'}
                    className={`nodrag mt-px shrink-0 rounded p-0.5 transition-colors ${
                      on ? 'text-twilio-blue' : 'text-twilio-gray-40 hover:text-twilio-navy'
                    }`}
                  >
                    {on ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
                  </button>
                  <span className="w-2/5 shrink-0 break-all font-mono text-[10px] text-twilio-gray-60">{row.path}</span>
                  {editable ? (
                    <input
                      key={`${row.path}:${displayValue(row.value)}`}
                      defaultValue={displayValue(row.value)}
                      aria-label={`Value of ${row.path}`}
                      spellCheck={false}
                      onBlur={(event) => {
                        const next = coerceLike(row.value, event.target.value)
                        if (JSON.stringify(next) !== JSON.stringify(row.value)) writePayload(setValueAt(payload, row.path, next))
                      }}
                      onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                      className="nodrag min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 font-mono text-[11px] text-twilio-navy hover:border-twilio-gray-20 focus:border-twilio-blue focus:outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-twilio-navy">
                      {displayValue(row.value)}
                    </span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      onClick={() => {
                        writePayload(removeAt(payload, row.path))
                        if (on) setShown(shown.filter((entry) => entry !== row.path))
                      }}
                      title={`Remove ${row.path}`}
                      aria-label={`Remove ${row.path}`}
                      className="nodrag mt-px shrink-0 rounded p-0.5 text-twilio-gray-40 hover:text-twilio-error"
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {editable && (
          <div className="mt-2 flex gap-1 border-t border-twilio-gray-10 pt-2">
            <input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="traits.plan"
              aria-label="New field path"
              className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-[11px] focus:border-twilio-blue focus:outline-none"
            />
            <input
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="value"
              aria-label="New field value"
              className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-[11px] focus:border-twilio-blue focus:outline-none"
            />
            <button
              type="button"
              disabled={!newPath.trim()}
              onClick={() => {
                writePayload(setValueAt(payload, newPath.trim(), coerceLike(null, newValue)))
                setNewPath('')
                setNewValue('')
              }}
              title="Add this field to the event"
              aria-label="Add field"
              className="nodrag shrink-0 rounded-md border border-twilio-blue px-2 text-twilio-blue hover:bg-twilio-blue-light disabled:opacity-40"
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>
        )}
      </Section>
    </>
  )
}
