/*
 * Anchor narration: what happens to an event at each component.
 *
 * Two readings of the same diagram, deliberately kept apart:
 *
 *   - `describeKind` answers "what does this component do to an event", from the
 *     node alone. It is the architecture overview, readable with nothing running,
 *     which is what walking a customer through their own diagram needs.
 *   - `describeStep` answers "what happened to *this* event here", and is a thin
 *     projection of the trace the reducer already produced. router.js writes a
 *     `reason` for every node it visits -- including the ones it never reached and
 *     why -- so a second explanation engine here could only drift from it.
 *
 * The copy is a table keyed by kind and parameterised by the node's own data,
 * rather than prose stored on each node: a filter's anchor has to name that
 * filter's actual condition, and a sentence about it saved on the node would go
 * stale the next time the workspace was refreshed.
 *
 * Wording tracks router.js on purpose. Where the router refuses to claim something
 * -- a function body is not read, sampling is random, one event cannot settle a
 * question about profile history -- the anchor says so in `caveat` rather than
 * promising more than the simulation delivers.
 */

import { labelForKind } from '../canvas/kinds.js'
import { STATUS, dataOf, hasArrived } from './router.js'

/* Keyed off STATUS rather than off the literal strings, so a status renamed in the
   reducer is a missing key here rather than a label that silently stops matching. */
export const STATUS_LABELS = {
  [STATUS.origin]: 'Enters here',
  [STATUS.passed]: 'Passes through',
  [STATUS.transformed]: 'May be changed',
  [STATUS.delivered]: 'Delivered',
  [STATUS.dropped]: 'Dropped',
  [STATUS.blocked]: 'Never reached',
  [STATUS.matched]: 'Matched',
  [STATUS.unmatched]: 'Not matched',
  [STATUS.undecided]: 'Cannot be decided',
  [STATUS.notEvaluated]: 'Not evaluated',
  [STATUS.notApplicable]: 'Not applicable',
}

/*
 * One entry per component kind. `what` and `why` may be a function of the node's
 * data; `caveat` is optional and is where the honest limits go.
 *
 * tests/test_topology.py parses the keys of this table with a line-anchored regex
 * to assert that every kind in topology.py has narration -- a check that has to
 * cross the language boundary, because the kind list lives in Python and the copy
 * lives here. Keep one kind per line at this indentation.
 */
const NARRATION = {
  source: {
    what: (data) =>
      `Events start here. Anything sent to this ${
        data.sourceType ? `${data.sourceType} ` : ''
      }source's write key enters the pipeline as a track, identify, page, group, or alias call. Segment validates it against the source schema, then fans one copy out to every destination, warehouse, and space this source is connected to.`,
    why: 'A write key is what ties an event to a pipeline, so a source is the only component an event can originate from — and the only place a walkthrough can start. The fan-out is what Segment is for: instrument once here, and adding a destination needs no new tracking code.',
  },
  source_function: {
    what: 'A payload that is not yet a Segment event — a partner webhook, a bare HTTP POST — is handed to your code, and whatever it emits becomes the event.',
    why: 'It lets a system with no Segment library produce events without standing up a service in the middle to translate for it.',
    caveat: 'The function body is not read here, so what it emits is not simulated.',
  },
  source_insert_function: {
    what: 'Every event from the source is handed to your code on its way in, before Segment validates it. It can enrich the payload, or return nothing and drop the event.',
    why: 'Enrichment that has to apply to everything downstream belongs here — once, rather than repeated in every destination that needs it.',
    caveat: 'The function body is not read here. Mark it as dropping in a scenario to see the path without it.',
  },
  source_schema_control: {
    what: (data) =>
      `Every event from the source is checked against ${
        data.trackingPlan ? `the “${data.trackingPlan}” tracking plan` : 'the connected tracking plan'
      } and the source’s own event and trait filters. ${schemaOutcome(data)}`,
    why: 'It is the only place an event can be stopped before it costs anything: an event blocked here is excluded from MTU and API counts as well as from every destination. It is also the answer to “we deleted the tracking code but the event is still arriving” — the schema, not the plan, is what enforces.',
    caveat: 'Which events a source blocks is read from its settings, but a tracking plan’s own rules are not evaluated here — so an unplanned event is not detected, only a rule the source itself records.',
  },
  tracking_plan: {
    what: 'Nothing passes through a tracking plan. It is the list of events and properties the workspace has agreed to, and the thing a source’s schema controls enforce on its behalf.',
    why: 'It is what makes “unplanned” mean anything. Without one, every event is as valid as every other and a typo is a new event name rather than a violation.',
    caveat: 'A plan on its own changes nothing: it has to be connected to a source, and that source’s schema controls set to block or omit, before an event is ever stopped.',
  },
  event_library: {
    what: 'Nothing passes through it. It holds track events and their properties so several tracking plans can share one definition of them.',
    why: 'It is how the same checkout event stays the same event across three plans — and, once a plan syncs from a library, the library becomes the only place it can be edited.',
    caveat: 'A library that a plan has synced from makes those events read-only in the plan, which is the usual explanation for an event nobody can work out how to change.',
  },
  property_library: {
    what: 'Nothing passes through it. It holds groups of track event properties — an order_id, a currency, a products array — for events across plans to reuse.',
    why: 'Properties are where drift actually happens: the event name is agreed on once and the properties are retyped every time. Defining them once is what stops order_id and orderID both existing.',
    caveat: 'Partial syncs are not supported, so importing from a library brings all of it.',
  },
  destination_mapping: {
    what: (data) =>
      `The mapping decides whether this action fires for the event${
        data.trigger ? `, on ${quoted(data.trigger)}` : ''
      }, and then builds the destination’s own payload field by field${
        mappedFields(data) ? ` — ${mappedFields(data)} mapped` : ''
      }.`,
    why: 'On an actions destination this is what “connected” actually means. A destination can be enabled, receiving events, and still send nothing, because no mapping is enabled or none of their triggers match — and that is invisible from the connection alone.',
    caveat: 'The trigger is not evaluated here and the fields are not resolved, so this says which mapping the event would meet, not what the destination receives.',
  },
  profile_sync: {
    what: 'The profile the event just touched — its identifiers, traits, and audience membership — is written to the warehouse on the sync’s own schedule, not on arrival.',
    why: 'It is the one place Unify and Engage leave Segment as tables: profiles and computed traits from Unify, audience membership from Engage, landed together so they can be joined against everything else the customer holds.',
    caveat: 'Scheduled, not event-driven, and no endpoint confirms which spaces have it — so this component was asserted by hand and its timing is not simulated.',
  },
  destination_filter: {
    what: (data) =>
      `Events matching ${
        quoted(data.condition) || 'this filter’s condition'
      } have the filter’s actions applied to them — dropped, sampled, or stripped of fields. Anything that does not match passes untouched.`,
    why: 'A filter acts on what it matches rather than on what it excludes, which is the reverse of how most people read one: a filter that matches everything and is set to drop makes the destination behind it receive nothing.',
  },
  destination_insert_function: {
    what: 'Runs on the event once per destination, after that destination’s filters and immediately before it is sent, so it can reshape or drop the payload for this one destination.',
    why: 'Per-destination shaping without changing what every other destination receives.',
    caveat: 'The function body is not read here, so the shape it sends is not simulated.',
  },
  destination_function: {
    what: 'Your code receives the event and is responsible for sending it on. There is no catalog destination behind it — the function is the destination.',
    why: 'It is how a tool Segment has no catalog destination for still gets events.',
    caveat: 'The function body is not read here, so what it sends — and whether the send succeeded — is not simulated.',
  },
  destination: {
    what: 'The event is mapped into the shape this tool expects and delivered. Nothing continues past it.',
    why: 'A destination is wired to specific sources, so the same destination can receive events from one source and not another — the commonest reason an event that plainly reached Segment never turned up.',
  },
  warehouse: {
    what: 'The event is written to a table named after it, unfiltered, on the warehouse’s next sync rather than on arrival.',
    why: 'A warehouse receives everything, which makes it the place to check what Segment actually collected when a destination disagrees.',
    caveat: 'Syncs run on a schedule, so this is the one delivery on the diagram where “arrived” does not mean “now”.',
  },
  reverse_etl_model: {
    what: 'Nothing. A Reverse ETL model runs its own query against the warehouse on a schedule and emits rows; it is not something an event passes through.',
    why: 'It is the return path — data that only ever existed in the warehouse being sent back out to tools, which is the reverse of every other arrow here.',
    caveat: 'Not event-driven, so a walkthrough stops here by design rather than because something is misconfigured.',
  },
  space: {
    what: 'The event is attached to a profile in this space, keyed on whichever identifiers it carries — userId, anonymousId, email, or groupId.',
    why: 'Unify is where events stop being a stream and start being people: everything past this point reads the profile, not the event.',
    caveat: 'An event carrying no identifier still reaches the space but cannot be attached to a profile, so nothing downstream sees it.',
  },
  identity_resolution: {
    what: 'The event’s identifiers are matched against existing profiles, and either merged onto one or used to create a new profile.',
    why: 'It is what makes an anonymous session and the signed-in user it became the same person, and this is the step that decides it.',
    caveat: 'Which identifier wins, and how many of each a profile may hold, is configured per space and is not readable from the API — so the merge itself is not simulated.',
  },
  profile_source: {
    what: 'The event reaches the space only if this source is one of the space’s profile sources. If it is not, everything downstream of Unify never sees it.',
    why: 'A source being connected to a space is a separate switch from the source existing, and it is the one people forget — which is why this node exists as something to assert rather than something read.',
    caveat: 'Segment publishes no endpoint listing a space’s profile sources, so this was asserted by hand and is not verified against the workspace.',
  },
  profile: {
    what: 'Nothing arrives at a profile as such. It is what the events before it added up to: identifiers, traits, and the event history attached to one person.',
    why: 'Everything in Engage asks a question about this shape rather than about an event, so having it on the diagram is what makes an audience condition readable.',
    caveat: 'A stand-in for the shape of a profile, not a real one — a real profile in a diagram exported to a slide deck would be customer PII.',
  },
  identity_setting: {
    what: 'Nothing. It records one of the space’s identity resolution rules — an identifier’s limit, or its precedence against the others.',
    why: 'These rules decide every merge, and they are the first thing to check when two people share a profile or one person has two. They are configured per space in Segment and cannot be read back.',
    caveat: 'Maintained by hand: Segment publishes no API for identity resolution settings, so nothing here is verified.',
  },
  computed_trait: {
    what: (data) =>
      `The trait is recomputed for the profile this event touched${
        data.query ? `, from ${truncate(data.query)}` : ''
      }.`,
    why: 'A trait is a property of the profile computed from its whole history, so it answers a question about a person rather than about an event.',
    caveat: 'One event usually cannot settle that: a trait counting orders over 30 days depends on events this walkthrough has never seen.',
  },
  profile_api: {
    what: 'Nothing is delivered here. The Profile API is how a profile is read back out — by your own app, or by a support tool asking about one person.',
    why: 'It is on the diagram because it is a real dependency: something outside Segment reads from it, and that consumer breaks if the space or its identifiers change.',
    caveat: 'A read surface, so an event walkthrough has nothing to show at this anchor.',
  },
  audience: {
    what: (data) =>
      `Membership is re-evaluated for the profile this event touched${
        data.query ? `, against ${truncate(data.query)}` : ''
      }. Entering or leaving is itself an event, delivered to whatever the audience is connected to.`,
    why: 'An audience is a saved question about profiles; connecting one to a destination is how that question becomes a campaign.',
    caveat: 'Membership depends on profile history, so a single event can often rule it out but not confirm it.',
  },
  journey: {
    what: 'A profile that satisfies the entry condition begins the journey and moves through its steps on the journey’s own schedule, not the event’s.',
    why: 'A journey is the multi-step version of an audience: wait, branch, and send over days rather than evaluate once.',
    caveat: 'Segment publishes no Journeys API, so this journey was drawn by hand and its entry conditions cannot be read or simulated.',
  },
  custom: {
    what: (data) =>
      data.description?.trim() ||
      'Whatever happens here is outside Segment, so only the notes on this component describe it. Add a description in the inspector and it will read here.',
    why: 'It stands for something the customer runs themselves — their own app, a warehouse they own, a partner’s workspace — which has no Segment rules and no API to read.',
    caveat: 'Nothing about it is verified against a workspace.',
  },
}

/*
 * Every kind the table has copy for.
 *
 * Exported for narration.test.js, which runs its exhaustiveness checks over this rather
 * than over a list retyped beside them -- a hand-copied list is how six kinds were once
 * added to the table and silently went unexercised. The Python side of the guard still
 * earns its place: it is the only test that can see topology.py and this file at once.
 */
export const NARRATED_KINDS = Object.freeze(Object.keys(NARRATION))

/**
 * What happens to an event at this component, before any of them has run.
 *
 * @param node  a React Flow node or a bare `{kind, ...}` payload -- both, because
 *   the inspector holds the first and a serialized graph holds the second.
 * @returns `{kind, title, what, why, caveat, known}`. Never null and never
 *   throwing: this renders in a tooltip, and a blank tooltip on an unfamiliar kind
 *   reads as a broken feature rather than an honest gap.
 */
export function describeKind(node, { topology } = {}) {
  const data = dataOf(node)
  const kind = data.kind ?? null
  const entry = kind ? NARRATION[kind] : null
  const title = data.kindLabel ?? (kind ? labelForKind(topology, kind) : null) ?? 'Component'

  if (!entry) {
    return {
      kind,
      title,
      known: false,
      what: 'What an event does here is not something this tool has narration for.',
      why: 'It is not one of Segment’s component kinds, so the walkthrough describes it as unknown rather than guessing at it.',
      caveat: null,
    }
  }

  return {
    kind,
    title,
    known: true,
    what: resolve(entry.what, data),
    why: resolve(entry.why, data),
    /* A component switched off in the workspace overrides its own caveat, because
       "this is not running" is the more surprising fact and the one that explains
       the walkthrough. The two texts differ because router.js treats a disabled
       filter as absent -- everything passes it -- and a disabled anything else as
       receiving nothing. */
    caveat:
      data.enabled === false
        ? kind === 'destination_filter'
          ? 'Switched off in the workspace, so it does not apply and every event passes it.'
          : 'Switched off in the workspace, so nothing is delivered here.'
        : (resolve(entry.caveat, data) ?? null),
  }
}

/**
 * What happened to the simulated event at this node.
 *
 * The `reason` is the trace's own, verbatim. Rewording it here would mean two
 * accounts of the same event that could disagree -- and the reducer's is the one
 * that knows why a node was never reached.
 *
 * @param step  `trace.visited[nodeId]`, or a `trace.steps` entry
 */
export function describeStep(step, node) {
  if (!step) return null
  const data = dataOf(node)
  return {
    nodeId: step.nodeId,
    name: data.name ?? step.nodeId,
    status: step.status,
    /* The status word, not a sentence: the reason below is the sentence. */
    title: STATUS_LABELS[step.status] ?? step.status,
    reason: step.reason,
    arrived: hasArrived(step.status),
    index: step.index,
    depth: step.depth,
  }
}

function resolve(value, data) {
  return typeof value === 'function' ? value(data) : value
}

/*
 * What a source does with an event its schema does not recognise.
 *
 * Only the node's own flattened `unplanned` is read. The settings payload spells this
 * out per call type and again per property -- track events, identify traits, group
 * traits, each with their own switch -- and an anchor that tried to say all of that
 * would be the inspector. The fallback names the three possibilities rather than
 * guessing at one, because "allow" is both the default and the one people assume is
 * off.
 */
function schemaOutcome(data) {
  switch (data.unplanned) {
    case 'block':
      return 'Anything unplanned is blocked here, and goes no further — not to a destination, and not into your MTU count.'
    case 'omit':
      return 'Unplanned properties are stripped from the payload and the event carries on without them.'
    case 'allow':
      return 'Unplanned events and properties are let through, so this records the schema rather than enforcing it.'
    default:
      return 'What happens to an unplanned event — allowed, stripped of the offending properties, or blocked outright — is set per call type on the source.'
  }
}

/* A mapping's fields arrive as an object keyed by destination field, and are hand-drawn
   as an array often enough to be worth tolerating both. */
function mappedFields(data) {
  const fields = data.fields
  const count = Array.isArray(fields) ? fields.length : Object.keys(fields ?? {}).length
  return count > 0 ? `${count} field${count === 1 ? '' : 's'}` : null
}

function quoted(value) {
  const text = String(value ?? '').trim()
  return text ? `“${truncate(text)}”` : ''
}

/* Conditions and audience queries have no length limit and a real one can run to
   several lines. Past this the anchor stops being readable at a glance, which is
   the only thing it is for -- the inspector shows the whole thing. */
const MAX_QUOTED = 140

function truncate(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1)}…` : text
}
