/*
 * Rules: the logic attached to this component.
 *
 * What that means differs per kind, so this tab is a switch rather than a shared
 * layout: a destination's rules are its filters, an audience's are its query, a
 * function's are code this API cannot read. `rulesSubject()` in tabs.js decides
 * whether the tab appears at all, so every branch here has something to say.
 *
 * Destination filters are fetched on demand. They are the one piece of this that
 * is not already in the graph payload -- `build_graph` does not fan out over every
 * destination to collect them, because that surface is limited to 5 requests a
 * minute and would dominate the whole load.
 *
 * Anything with a condition gets it twice: the FQL as the API returns it, and the
 * field/operator/value rows the customer built it in. That is not redundancy -- the two
 * audiences for this panel recognise different halves, and only one of them is in the API.
 *
 * Several kinds here have no discovery endpoint at all, so their content is whatever
 * someone typed. Those branches say which parts are asserted rather than read; a panel
 * that looked identical either way would make the diagram less trustworthy than the
 * LucidChart it replaces, not more.
 */

import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Filter, Loader2, TriangleAlert } from 'lucide-react'

import ConditionBreakdown from './ConditionBreakdown.jsx'
import CopyButton from '../ui/CopyButton.jsx'
import MappingFields from './MappingFields.jsx'
import { EmptyNote, Row, Section } from './primitives.jsx'
import { namesOf } from '../simulation/router.js'
import { workspace as workspaceApi } from '../services/api.js'
import { rulesSubject } from './tabs.js'

/* The three answers a source can give, in the words the consequence is in rather than
   the API's enum -- "omit" alone does not say that the event still arrives. */
const UNPLANNED_LABELS = {
  block: 'Blocked outright — not delivered, and not counted',
  omit: 'Offending properties stripped, event still delivered',
  allow: 'Delivered, and recorded as a violation',
}

export default function RulesTab({ node, onNotify }) {
  const data = node.data
  const subject = rulesSubject(node)

  switch (data.kind) {
    case 'destination':
      return <DestinationFilters node={node} onNotify={onNotify} />

    case 'destination_filter':
      return (
        <Section title={subject} note="Evaluated before the event reaches the destination.">
          <QueryBlock label="Condition (FQL)" query={data.condition} />
          <ConditionBreakdown
            condition={data.condition}
            emptyNote="No condition, so this filter matches every event and applies its actions to all of them."
          />
          <Row label="Enabled" value={data.enabled === false ? 'Disabled' : 'Enabled'} />
          <FilterActions actions={data.actions} />
        </Section>
      )

    case 'destination_mapping':
      return (
        <>
          <Section
            title={subject}
            note="On an actions destination this is what a connection consists of: a trigger deciding whether the action fires, then the payload it builds."
          >
            <Row label="Action" value={data.actionSlug ?? data.action} />
            <Row label="Enabled" value={data.enabled === false ? 'Disabled' : 'Enabled'} />
            <QueryBlock label="Trigger (FQL)" query={data.trigger} />
            <ConditionBreakdown
              label="Trigger (rows)"
              condition={data.trigger}
              emptyNote="No trigger, so this action fires on every event that reaches the destination."
            />
          </Section>
          <Section title="Fields sent">
            <MappingFields fields={data.fields} />
            <EmptyNote>
              Where each field comes from, not what it resolves to: resolving it means
              reproducing this integration&rsquo;s own payload shape, which is the part most
              likely to go stale against the real destination.
            </EmptyNote>
          </Section>
        </>
      )

    case 'source_schema_control':
      return (
        <Section
          title={subject}
          note="The only gate that can stop an event before it costs anything — an event blocked here is excluded from MTU and API counts as well as from every destination."
        >
          <Row label="Tracking plan" value={data.trackingPlan} />
          <Row label="Unplanned events" value={UNPLANNED_LABELS[data.unplanned] ?? null} />
          {!data.unplanned && (
            <EmptyNote>
              Which of the three this source does is not recorded here, and they differ by
              everything downstream — so the simulator refuses to claim anything past an
              unplanned event rather than assuming the permissive answer.
            </EmptyNote>
          )}
          <NameList
            label="Planned events"
            names={namesOf(data.plannedEvents)}
            empty="none recorded, so nothing is treated as unplanned"
          />
          <NameList
            label="Blocked events"
            names={namesOf(data.blockedEvents)}
            empty="none recorded"
          />
          <EmptyNote>
            Only the event names are checked. A plan&rsquo;s property-level rules are not
            evaluated, so an event that is planned but carries the wrong properties reads
            here as passing.
          </EmptyNote>
        </Section>
      )

    case 'tracking_plan':
      return (
        <Section
          title={subject}
          note="A plan is the list the workspace agreed to, not a gate. What enforces it is the connected source’s schema controls."
        >
          <Row label="Plan type" value={data.planType} />
          <NameList label="Events" names={namesOf(data.events)} empty="none recorded" />
          <NameList label="Properties" names={namesOf(data.properties)} empty="none recorded" />
          <EmptyNote>
            A plan with no source set to block or omit changes nothing — which is the
            commonest surprise in Protocols, and the reason the enforcing component is on
            the diagram separately.
          </EmptyNote>
        </Section>
      )

    case 'event_library':
    case 'property_library':
      return (
        <Section title={subject}>
          <NameList
            label={data.kind === 'event_library' ? 'Events' : 'Property groups'}
            names={namesOf(data.kind === 'event_library' ? data.events : data.properties)}
            empty="none recorded"
          />
          <EmptyNote>
            Once a plan has synced from a library, these become read-only in the plan —
            usually the explanation for an event nobody can work out how to edit. Partial
            syncs are not supported, so an import brings all of it.
          </EmptyNote>
        </Section>
      )

    case 'profile_sync':
      return (
        <Section
          title={subject}
          note="Scheduled rather than event-driven: what lands in the warehouse is the profile as it stands at the next sync, not the event that changed it."
        >
          <Row label="Warehouse" value={data.warehouseName ?? data.warehouse} />
          <Row label="Schedule" value={data.scheduleStrategy ?? data.schedule} />
          <EmptyNote>
            The columns it produces are the space&rsquo;s own traits and identifiers, so the
            Fields tab is the list of what a query against them can select.
          </EmptyNote>
          <EmptyNote>
            Segment publishes no endpoint listing which spaces have Profiles Sync enabled,
            so this component was asserted by hand and its schedule is not verified against
            the workspace.
          </EmptyNote>
        </Section>
      )

    case 'computed_trait':
    case 'audience':
      return (
        <>
          <Section title={subject}>
            <QueryBlock label="Definition" query={data.query} />
            <Row label="Definition type" value={data.definitionType} />
            {data.kind === 'audience' && (
              <>
                <Row
                  label="Anonymous users"
                  value={data.includeAnonymousUsers ? 'Included' : 'Excluded'}
                />
                <Row
                  label="Historical data"
                  value={data.includeHistoricalData ? 'Backfilled' : 'Forward only'}
                />
              </>
            )}
            {data.isJourneyStep && (
              <EmptyNote>
                The key matches Segment&rsquo;s <span className="font-mono">j_o_*</span> pattern,
                so this trait is journey-step membership rather than a trait someone
                authored directly.
              </EmptyNote>
            )}
          </Section>
          <Section title="Simulation">
            <EmptyNote>
              The event simulator interprets a documented subset of this query
              language locally. Anything outside that subset is reported as
              &ldquo;not evaluated&rdquo; rather than guessed at.
            </EmptyNote>
          </Section>
        </>
      )

    case 'reverse_etl_model':
      return (
        <Section title={subject}>
          <QueryBlock label="SQL" query={data.query} />
          <Row label="Schedule" value={data.scheduleStrategy} />
        </Section>
      )

    case 'source_function':
    case 'source_insert_function':
    case 'destination_function':
    case 'destination_insert_function':
      return (
        <Section title={subject} note="Functions run customer-authored JavaScript.">
          <Row label="Resource type" value={data.resourceType} />
          {data.previewWebhookUrl && (
            <Row label="Preview webhook" value={data.previewWebhookUrl} mono copy />
          )}
          <EmptyNote>
            The function body is not read by this tool — reproducing code in a
            diagram invites it going stale against the deployed version. Open it in
            the workspace from the Links tab instead.
          </EmptyNote>
        </Section>
      )

    case 'identity_resolution':
      return (
        <Section title={subject}>
          <EmptyNote>
            Identity resolution rules — match limits and identifier precedence — are
            configured per space in Segment and are not exposed on a path this tool
            reads. The Links tab opens the space&rsquo;s settings directly.
          </EmptyNote>
        </Section>
      )

    /* Not the default branch, though it has no fields of its own to show: "nothing
       configured on this component" is the one wrong thing to say about a node whose whole
       purpose is to record a rule that has no API to read it from. */
    case 'identity_setting':
      return (
        <Section title={subject}>
          <EmptyNote>
            Segment exposes no API for identity resolution settings, so this component is
            whatever was typed on it: the rule belongs in its description and details on the
            Overview tab, and nothing here is verified against the space.
          </EmptyNote>
          <EmptyNote>
            These rules decide every merge, so they are the first thing to check when two
            people share a profile or one person has two.
          </EmptyNote>
        </Section>
      )

    case 'journey':
      return <JourneySteps data={data} />

    default:
      return (
        <Section title={subject ?? 'Rules'}>
          <EmptyNote>Nothing configured on this component.</EmptyNote>
        </Section>
      )
  }
}

/**
 * A query, condition, or SQL body.
 *
 * Collapsed to a fixed height with its own scroll: audience definitions run to
 * several hundred characters and would otherwise push everything else off the
 * panel.
 */
function QueryBlock({ label, query }) {
  if (!query) {
    return (
      <Row label={label}>
        <span className="italic text-twilio-gray-40">not reported by the API</span>
      </Row>
    )
  }

  return (
    <div className="py-1">
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[11px] text-twilio-gray-60">{label}</span>
        <CopyButton text={query} label={`Copy ${label.toLowerCase()}`} size={12} />
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-twilio-gray-20 bg-twilio-gray-10 p-2 font-mono text-[10px] leading-relaxed text-twilio-slate">
        {query}
      </pre>
    </div>
  )
}

function FilterActions({ actions }) {
  if (!actions?.length) return null
  return (
    <div className="py-1">
      <span className="text-[11px] text-twilio-gray-60">Actions</span>
      <ul className="mt-1 flex flex-col gap-1">
        {actions.map((action, index) => (
          <li
            key={index}
            className="rounded border border-twilio-gray-20 px-1.5 py-1 font-mono text-[10px] text-twilio-slate"
          >
            {/* Shape varies by action type (drop / sample / allow / block fields),
                so it is rendered as-is rather than parsed into a claim. */}
            {JSON.stringify(action)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* How many event names fit before the panel is a scroll bar. A real tracking plan holds
   hundreds, and the first dozen plus a count answers "is this the right plan?" -- which is
   what the list is read for. The rest is one click away. */
const NAMES_SHOWN = 12

/**
 * A list of event or property names.
 *
 * The count is in the label rather than below the list: on a plan with three hundred
 * events the number is the useful part and it should not need scrolling to.
 */
function NameList({ label, names, empty }) {
  const [expanded, setExpanded] = useState(false)

  if (names.length === 0) {
    return (
      <Row label={label}>
        <span className="italic text-twilio-gray-40">{empty}</span>
      </Row>
    )
  }

  const shown = expanded ? names : names.slice(0, NAMES_SHOWN)
  const hidden = names.length - shown.length

  return (
    <div className="py-1">
      <span className="text-[11px] text-twilio-gray-60">
        {label} ({names.length})
      </span>
      <ul className="mt-1 flex flex-wrap gap-1">
        {shown.map((name) => (
          <li
            key={name}
            className="rounded border border-twilio-gray-20 px-1 py-0.5 font-mono text-[10px] text-twilio-slate"
          >
            {name}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="nodrag mt-1 text-[10px] text-twilio-blue hover:underline"
        >
          Show {hidden} more
        </button>
      )}
    </div>
  )
}

function DestinationFilters({ node, onNotify }) {
  const destinationId = node.data.segmentId
  const [state, setState] = useState({ status: 'idle', items: [], error: null })

  /* Held in a ref rather than named as a dependency below. `notify` happens to be
     stable today, but an inline arrow from a future caller would turn the fetch
     effect into a loop against a 5-request-per-minute endpoint. */
  const notifyRef = useRef(onNotify)
  notifyRef.current = onNotify

  useEffect(() => {
    let cancelled = false
    if (!destinationId) {
      setState({ status: 'ready', items: [], error: null })
      return () => {}
    }

    setState({ status: 'loading', items: [], error: null })
    workspaceApi
      .destinationFilters(destinationId)
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', items: result.items ?? [], error: null })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', items: [], error: err })
        notifyRef.current?.({ tone: 'error', message: err.message })
      })

    return () => {
      cancelled = true
    }
  }, [destinationId])

  if (state.status === 'loading') {
    return (
      <Section title="Destination filters">
        <p className="flex items-center gap-2 text-xs text-twilio-gray-60">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Reading filters…
        </p>
      </Section>
    )
  }

  if (state.status === 'error') {
    return (
      <Section title="Destination filters">
        <p className="flex items-start gap-2 text-xs text-twilio-error">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          {state.error?.message}
        </p>
        <EmptyNote>
          This endpoint allows 5 requests a minute, the tightest limit in the API.
          A 429 here clears on its own.
        </EmptyNote>
      </Section>
    )
  }

  return (
    <Section
      title={`Destination filters (${state.items.length})`}
      note="Applied after Segment's own processing and before this destination only, so they can drop or reshape an event without affecting anything else it was sent to."
    >
      {state.items.length === 0 ? (
        <EmptyNote>
          No filters — every event routed to this destination is delivered as-is.
        </EmptyNote>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.items.map((filter) => (
            <li key={filter.id} className="rounded-md border border-twilio-gray-20 p-2">
              <div className="flex items-center gap-1.5">
                <Filter size={12} className="shrink-0 text-twilio-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-twilio-navy">
                  {filter.name}
                </span>
                <span
                  className={`shrink-0 rounded px-1 text-[9px] uppercase tracking-wide ${
                    filter.enabled === false
                      ? 'bg-twilio-gray-10 text-twilio-gray-60'
                      : 'bg-green-50 text-twilio-success'
                  }`}
                >
                  {filter.enabled === false ? 'off' : 'on'}
                </span>
              </div>
              {filter.description && (
                <p className="mt-1 text-[11px] text-twilio-gray-60">{filter.description}</p>
              )}
              <QueryBlock label="Condition (FQL)" query={filter.condition} />
              <ConditionBreakdown
                condition={filter.condition}
                emptyNote="No condition, so this filter matches every event and applies its actions to all of them."
              />
              <FilterActions actions={filter.actions} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function JourneySteps({ data }) {
  const steps = data.steps ?? []
  return (
    <Section title="Journey steps">
      <EmptyNote>
        Segment publishes no Journeys API, so a journey is never discovered — it is
        drawn by hand, or inferred from the{' '}
        <span className="font-mono">j_o_&lt;journey&gt;__&lt;step&gt;</span> computed traits
        it leaves behind.
      </EmptyNote>
      {steps.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1">
          {steps.map((step) => (
            <li
              key={step.traitKey ?? step.slug}
              className="rounded border border-twilio-gray-20 px-1.5 py-1"
            >
              <div className="text-xs text-twilio-navy">{step.name}</div>
              {step.traitKey && (
                <div className="flex items-center gap-1">
                  <span className="min-w-0 truncate font-mono text-[10px] text-twilio-gray-60">
                    {step.traitKey}
                  </span>
                  <CopyButton text={step.traitKey} size={11} />
                </div>
              )}
              {step.orderKnown === false && (
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-twilio-warning">
                  <ExternalLink size={9} aria-hidden="true" />
                  order not recoverable from the trait name
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
