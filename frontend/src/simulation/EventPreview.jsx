/*
 * The event, as it currently stands, at the point the walkthrough has reached.
 *
 * The trace has always carried a payload per step -- `frameAt` threads it forward, replacing it
 * wherever a stage rewrote it -- but nothing showed it. So a walkthrough could tell you an insert
 * function transformed the event and never show you into what, which is exactly the question someone
 * runs a walkthrough to answer.
 *
 * It lives over the palette rather than in the drawer with the transport for two reasons. A payload is
 * twenty lines of JSON and the drawer is a strip; and while an animation is playing the reader is
 * watching the canvas, so the payload has to be beside it rather than under it, where following both
 * means looking away from the thing that is moving.
 *
 * ## What it is careful not to claim
 *
 * A transform this simulator cannot read -- a function body, an unplanned-property omission -- is
 * recorded as `{unread: true}`, and the panel says the payload *may* have changed rather than
 * pretending to show the result. That distinction is the whole reason the trace carries a `transform`
 * separately from the payload: the alternative is a panel that shows the event unchanged after a
 * function and lets the reader conclude the function does nothing.
 */

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Sparkles, TriangleAlert, Wand2 } from 'lucide-react'

import { STATUS, componentNodes, dataOf, hasArrived } from './router.js'

/* The keys worth showing before the properties, in the order the Segment spec lists them. A payload
   is an object with no inherent order, and `JSON.stringify` would print it in whatever order the
   object happened to be built -- which for a hand-typed event is the order the user typed. */
const LEAD_KEYS = ['type', 'event', 'userId', 'anonymousId', 'timestamp', 'messageId']

export default function EventPreview({ frame, graph, scenarios }) {
  const [open, setOpen] = useState(true)

  /* Names resolved from the graph rather than read off the step. The trace deliberately stores ids
     and not labels -- a step is a fact about the run, and a component renamed after the run was
     computed would leave a stale name embedded in it. */
  const nameById = useMemo(() => {
    const map = new Map()
    for (const node of componentNodes(graph)) map.set(node.id, dataOf(node).name ?? node.id)
    return map
  }, [graph])

  /*
   * One run's worth of payload, per scenario that is currently mid-flight.
   *
   * Several scenarios can be playing at once, and they can hold *different* payloads by this point --
   * that is the entire reason the comparison feature exists. So this is a list, and each entry names
   * its scenario in its own colour; collapsing them to one would silently show whichever ran last.
   */
  const live = useMemo(() => {
    return (frame?.runs ?? [])
      .filter((run) => run.frame?.current)
      .map((run) => ({
        id: run.scenario.id,
        name: run.scenario.name,
        color: run.scenario.color,
        step: run.frame.current,
        payload: run.frame.payload,
      }))
  }, [frame])

  if (!live.length) return null

  return (
    <div className="border-b border-twilio-gray-20 bg-white">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60 hover:text-twilio-navy"
      >
        <Sparkles size={12} aria-hidden="true" />
        <span className="flex-1 text-left">Event in flight</span>
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>

      {open && (
        /* Capped and scrollable: a real payload with thirty properties would push the entire
           component palette off the bottom of the sidebar. */
        <div className="max-h-[45vh] space-y-3 overflow-y-auto px-3 pb-3">
          {live.map((entry) => (
            <RunPayload
              key={entry.id}
              entry={entry}
              nodeName={nameById.get(entry.step.nodeId) ?? entry.step.nodeId}
              named={live.length > 1 || scenarios?.length > 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RunPayload({ entry, nodeName, named }) {
  const { step, payload, color, name } = entry
  const transform = step.transform ?? null

  return (
    <section>
      {named && (
        <div className="flex items-center gap-1.5 pb-1">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
            aria-hidden="true"
          />
          <span className="truncate text-[11px] font-semibold text-twilio-navy">{name}</span>
        </div>
      )}

      {/* Where it is, and the verdict there. The same sentence the anchor tooltip shows on the
          canvas -- deliberately, because a reader looking at one and then the other must not have to
          reconcile two different accounts of the same step. */}
      <div className="rounded-md bg-twilio-gray-10 px-2 py-1.5">
        <p className="truncate text-[11px] font-semibold text-twilio-navy" title={nodeName}>
          {nodeName}
        </p>
        <p className="mt-0.5 text-[10px] leading-snug text-twilio-gray-60">{step.reason}</p>
      </div>

      {transform && (
        /* Amber and explicit. An unread transform is the one case where the JSON below is *not* the
           truth, and a panel that showed it silently would let the reader conclude a function does
           nothing. */
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-twilio-warning/40 bg-orange-50 px-2 py-1.5 text-[10px] leading-snug text-twilio-gray-80">
          {transform.unread ? (
            <TriangleAlert size={11} className="mt-px shrink-0 text-twilio-warning" aria-hidden="true" />
          ) : (
            <Wand2 size={11} className="mt-px shrink-0 text-twilio-warning" aria-hidden="true" />
          )}
          <span>
            {transform.unread
              ? 'This stage may rewrite the event, and this tool does not read its code — so what is below is what arrived, not what leaves.'
              : transform.fields?.length
                ? `Fields ${transform.mode === 'allow' ? 'kept' : 'removed'} here: ${transform.fields.join(', ')}.`
                : 'The event was rewritten at this stage.'}
          </span>
        </p>
      )}

      {!hasArrived(step.status) && (
        <p className="mt-1.5 text-[10px] leading-snug text-twilio-red-dark">
          {step.status === STATUS.dropped || step.status === STATUS.blocked
            ? 'The event stops here — nothing downstream of this receives it.'
            : 'Nothing past this point is claimed.'}
        </p>
      )}

      <PayloadBody payload={payload} />
    </section>
  )
}

/**
 * The payload, printed with the spec's own keys first.
 *
 * Not `JSON.stringify(payload, null, 2)` on the whole object: that prints keys in whatever order the
 * object was built, which for a hand-typed event is the order the user typed and for an API-shaped
 * one is arbitrary. A reader scanning for `userId` in a thirty-key payload needs it in the same place
 * every time.
 */
function PayloadBody({ payload }) {
  const { lead, rest } = useMemo(() => split(payload), [payload])

  if (!payload || typeof payload !== 'object') {
    return <p className="mt-1.5 text-[10px] italic text-twilio-gray-40">No payload recorded.</p>
  }

  return (
    <div className="mt-1.5 space-y-1">
      {lead.map(([key, value]) => (
        <div key={key} className="flex items-start gap-1.5 text-[10px]">
          <span className="w-20 shrink-0 text-twilio-gray-60">{key}</span>
          <span className="min-w-0 flex-1 break-all font-mono text-twilio-navy">{scalar(value)}</span>
        </div>
      ))}

      {rest.length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded bg-twilio-navy/95 px-2 py-1.5 font-mono text-[10px] leading-snug text-white">
          {JSON.stringify(Object.fromEntries(rest), null, 2)}
        </pre>
      )}
    </div>
  )
}

/* The spec's keys, in the spec's order, then everything else. `LEAD_KEYS` order rather than the
   payload's, so two events always read the same way. */
function split(payload) {
  if (!payload || typeof payload !== 'object') return { lead: [], rest: [] }
  const lead = LEAD_KEYS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])
  const claimed = new Set(LEAD_KEYS)
  const rest = Object.entries(payload).filter(([key]) => !claimed.has(key))
  return { lead, rest }
}

/* A scalar as one line. An object here is printed as JSON rather than as `[object Object]`, which is
   what a template's `context` under a lead key would otherwise render as. */
function scalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
