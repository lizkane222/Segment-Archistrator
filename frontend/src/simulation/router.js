/*
 * The simulation reducer: one event, one graph, a step-indexed trace.
 *
 * Pure, and structured as "compute the whole trace once, then project a frame for
 * step N" rather than "re-walk the graph for step N". Two reasons, both from the
 * animation requirement: scrubbing backwards has to be free, and the trace has to
 * be memoisable on (graph, event) so dragging the scrubber does not re-evaluate
 * every audience query 60 times a second.
 *
 * Traversal is breadth-first from the source the event was sent from, so the
 * animation advances as a wavefront rather than diving down one branch to a
 * destination while a sibling destination sits untouched.
 *
 * ---
 *
 * Two passes, because "why did it NOT arrive" is the question this tool exists to
 * answer. Pass one walks the paths the event actually takes. Pass two looks at
 * every node one hop past where a path stopped and records why it was never
 * reached -- a filter dropped the event, an audience did not match, a destination
 * is wired to a different source. Without pass two a dropped event just makes
 * half the diagram stay grey, which looks like the simulator gave up.
 *
 * What is a claim and what is a hint (this distinction is the whole point):
 *   - Destination filters ARE evaluated. FQL runs against one event with no
 *     profile context, so a verdict here matches the real engine (see fql.js).
 *   - Function bodies are NOT read, by the same decision as the Rules tab. A
 *     function is reported as "may transform" and the user can tell the simulator
 *     to treat it as dropping, which is what the end-to-end-test template's
 *     "simulate with and without it" note is asking for.
 *   - Audience and computed-trait verdicts are three-valued and often UNKNOWN,
 *     because one event cannot settle a question about profile history.
 */

import { evaluateCondition } from './fql.js'
import { evaluateQuery } from './audienceQuery.js'
import { dominantCause, explain, UNSUPPORTED } from './logic.js'
import { eventNameOf, identifiersOf } from './payload.js'

export const STATUS = {
  origin: 'origin',
  passed: 'passed',
  transformed: 'transformed',
  delivered: 'delivered',
  dropped: 'dropped',
  blocked: 'blocked',
  matched: 'matched',
  unmatched: 'unmatched',
  undecided: 'undecided',
  notEvaluated: 'not_evaluated',
  notApplicable: 'not_applicable',
}

/* Statuses that mean the event got there. Used by the results panel rather than
   by traversal, which asks each handler whether to propagate instead. */
const ARRIVED = new Set([STATUS.origin, STATUS.passed, STATUS.transformed, STATUS.delivered, STATUS.matched])

/* Exposed as a predicate rather than as the set, so a caller cannot add to it and
   change what every other reader of a trace considers an arrival. */
export const hasArrived = (status) => ARRIVED.has(status)

/*
 * Kinds that are never a stage on an event's path: a definition, a record, or a read
 * surface. They get a verdict from pass three even when nothing on the diagram connects
 * them to the source being simulated, because a grey component is indistinguishable
 * from a simulator that gave up -- and a tracking plan is exactly the component someone
 * stops the walkthrough to ask about.
 *
 * Deliberately not "every unvisited node". A destination wired to a different source is
 * also unvisited, and it stays grey on purpose: it genuinely would receive the event on
 * another run, and pass two already says so wherever there is an edge to say it along.
 */
const INERT_KINDS = new Set([
  'tracking_plan',
  'event_library',
  'property_library',
  'identity_setting',
  'profile',
  'profile_api',
  'reverse_etl_model',
])

export function dataOf(node) {
  return node?.data ?? node ?? {}
}

function kindOf(node) {
  return dataOf(node).kind ?? null
}

function nameOf(node) {
  return dataOf(node).name ?? node?.id ?? 'unnamed'
}

/** Component nodes only: zone backdrops are regions, not stops on a path. */
export function componentNodes(graph) {
  return (graph?.nodes ?? []).filter((node) => node.type !== 'zone')
}

/**
 * The sources an event could be sent from.
 *
 * A `track` call is made against a source's write key, so this is where an *event*
 * originates. It is no longer the same question as where a walkthrough may start --
 * see `eligibleStarts`.
 */
export function eligibleSources(graph) {
  return componentNodes(graph).filter((node) => kindOf(node) === 'source')
}

/**
 * Every component a walkthrough may start from, sources first.
 *
 * This used to be `eligibleSources`, on the grounds that an event enters through a
 * source and starting anywhere else would simulate something that cannot happen. That
 * reasoning was too narrow, and the counter-example is in the shipped end-to-end
 * template: `warehouse -> reverse_etl_model -> destination` is a real Segment data path
 * with no write key and no source anywhere in it, and it was unwalkable. A reader also
 * has a legitimate reason to start partway along a path they are explaining, which is
 * what a walkthrough is *for*.
 *
 * So the restriction is gone and the ordering carries the advice instead: a source is
 * still what you usually want, so it is what the picker offers first.
 */
export function eligibleStarts(graph) {
  const components = componentNodes(graph)
  const sources = components.filter((node) => kindOf(node) === 'source')
  const rest = components.filter((node) => kindOf(node) !== 'source')
  return [...sources, ...rest]
}

/** Still a source when there is one: the commonest case should need no decision. */
export function defaultSourceId(graph) {
  return eligibleStarts(graph)[0]?.id ?? null
}

/* --- the trace ------------------------------------------------------------- */

/**
 * Walk `event` through `graph`.
 *
 * @param options.sourceId          which source the event enters at
 * @param options.functionBehaviour {[nodeId]: 'pass' | 'drop'} -- what to assume a
 *                                  function whose code we cannot read does
 * @param options.disabled          node ids to treat as switched off for this run
 *   only. The graph is not touched: "the same architecture with the insert function
 *   turned off" is a question about one run, and mutating a copy of the graph to ask
 *   it would break memoising the trace on (graph, event) and would put a scenario's
 *   assumption where the document's own `enabled` lives.
 */
export function simulate(graph, event, { sourceId, functionBehaviour = {}, disabled = [] } = {}) {
  const off = new Set(disabled)
  const nodes = componentNodes(graph)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = (graph?.edges ?? []).filter(
    (edge) => byId.has(edge.source) && byId.has(edge.target),
  )

  const outgoing = new Map()
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source).push(edge)
  }

  const notes = []
  const startId = sourceId ?? defaultSourceId(graph)
  const start = startId ? byId.get(startId) : null

  /* Any component, not only a source -- see `eligibleStarts`. What still has to exist
     is a start: a scenario can outlive the component it named. */
  if (!start) {
    return {
      sourceId: null,
      event,
      steps: [],
      visited: {},
      notes: [
        nodes.length === 0
          ? 'There is nothing on the canvas to simulate.'
          : 'Pick a component to start the walkthrough from — the path is traced forward from whatever you choose.',
      ],
    }
  }

  /* A run cannot start at a source that is off. Checked rather than allowed to
     produce a full trace, because "switch things off and see what still arrives"
     is the whole point of the toggles -- and a walkthrough that plays normally
     from a source the user has just switched off answers the wrong question. */
  if (off.has(start.id) || dataOf(start).enabled === false) {
    return {
      sourceId: start.id,
      event,
      steps: [],
      visited: {},
      notes: [
        `“${nameOf(start)}” is switched off, so no event enters the pipeline through it.`,
      ],
    }
  }

  /* Only when the run started at a source, because that is what the sentence is about:
     "the other sources would each take their own path" is a remark on the fan-in this
     diagram has, and it is not a useful thing to say about a run that deliberately
     started halfway along one path. */
  const sources = eligibleSources(graph)
  if (kindOf(start) === 'source' && sources.length > 1) {
    notes.push(
      `Simulated from “${nameOf(start)}”. The other ${sources.length - 1} source${sources.length === 2 ? '' : 's'} on this diagram would each take their own path.`,
    )
  }
  if (kindOf(start) !== 'source') {
    notes.push(
      `Started at “${nameOf(start)}”, which is not a source — so this traces what happens downstream of it rather than a full event path.`,
    )
  }

  const steps = []
  const visited = new Map()

  const record = (entry) => {
    const step = { index: steps.length, ...entry }
    steps.push(step)
    visited.set(entry.nodeId, step)
    return step
  }

  record({
    nodeId: start.id,
    fromId: null,
    edgeId: null,
    depth: 0,
    status: STATUS.origin,
    /* The fan-out sentence used to belong to a `segment_core` node in the middle of
       every diagram. That node is gone, and this is the only other step guaranteed
       to exist -- so without it here the walkthrough would never say what Segment
       itself does with the event. */
    /* Two wordings, because the sentence about schema validation and fan-out is a claim
       about a *source* and is simply false of anything else. A walkthrough may now
       start at the customer's own app outside the Segment zone, and telling the reader
       that Segment validated it there would be inventing a stage that does not exist. */
    reason:
      kindOf(start) === 'source'
        ? `The event enters the pipeline at “${nameOf(start)}”. Segment validates it against the source schema, then fans one copy out to everything this source is connected to.`
        : `The walkthrough starts at “${nameOf(start)}”, which is not a source — so nothing here is Segment's doing yet. The path follows what this component is drawn as feeding.`,
    payload: event,
    propagate: true,
  })

  /* Pass one: the paths the event takes. */
  let frontier = [{ node: start, payload: event, depth: 0 }]

  while (frontier.length > 0) {
    const nextFrontier = []

    for (const current of frontier) {
      for (const edge of outgoing.get(current.node.id) ?? []) {
        if (visited.has(edge.target)) continue

        const target = byId.get(edge.target)
        const outcome = visit({
          node: target,
          from: current.node,
          payload: current.payload,
          event,
          sourceNode: start,
          functionBehaviour,
          switchedOff: off.has(target.id),
        })

        record({
          nodeId: target.id,
          fromId: current.node.id,
          edgeId: edge.id ?? `${edge.source}->${edge.target}`,
          depth: current.depth + 1,
          status: outcome.status,
          reason: outcome.reason,
          payload: outcome.payload ?? current.payload,
          verdict: outcome.verdict ?? null,
          transform: outcome.transform ?? null,
          propagate: outcome.propagate,
        })

        if (outcome.propagate) {
          nextFrontier.push({
            node: target,
            payload: outcome.payload ?? current.payload,
            depth: current.depth + 1,
          })
        }
      }
    }

    frontier = nextFrontier
  }

  /* Pass two: one hop past every path that stopped, so the diagram says why. */
  for (const edge of edges) {
    const parent = visited.get(edge.source)
    if (!parent || parent.propagate) continue
    if (visited.has(edge.target)) continue

    const target = byId.get(edge.target)
    const undecidedParent =
      parent.status === STATUS.undecided ||
      parent.status === STATUS.notEvaluated ||
      parent.status === STATUS.notApplicable

    record({
      nodeId: target.id,
      fromId: edge.source,
      edgeId: edge.id ?? `${edge.source}->${edge.target}`,
      depth: parent.depth + 1,
      status: undecidedParent ? STATUS.undecided : STATUS.blocked,
      reason: undecidedParent
        ? `Whether the event reaches “${nameOf(target)}” depends on “${nameOf(byId.get(edge.source))}”, which this simulation could not settle.`
        : `The event never reaches “${nameOf(target)}”: ${parent.reason}`,
      payload: parent.payload,
      propagate: false,
    })
  }

  /* Pass three: the components that take no part in any event's path at all, so the
     diagram accounts for them instead of leaving them grey. Last, and with no edge, so
     they read as footnotes to the walk rather than as part of it. */
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    if (!INERT_KINDS.has(kindOf(node))) continue

    const outcome = visit({
      node,
      from: null,
      payload: event,
      event,
      sourceNode: start,
      functionBehaviour,
      switchedOff: off.has(node.id),
    })

    record({
      nodeId: node.id,
      fromId: null,
      edgeId: null,
      depth: 0,
      status: outcome.status,
      reason: outcome.reason,
      payload: event,
      propagate: false,
    })
  }

  return {
    sourceId: start.id,
    event,
    steps,
    visited: Object.fromEntries([...visited].map(([id, step]) => [id, step])),
    notes,
  }
}

/* --- per-kind behaviour ---------------------------------------------------- */

function visit({ node, from, payload, event, sourceNode, functionBehaviour, switchedOff }) {
  const data = dataOf(node)
  const kind = data.kind

  /* Two ways to be off, worded differently on purpose: one is a fact about the
     customer's workspace, the other is an assumption the user made for this run,
     and confusing the two turns a scenario's toggle into a finding. The workspace
     wins when both apply -- it is the one they cannot change from here. */
  if ((data.enabled === false || switchedOff) && kind !== 'destination_filter') {
    return {
      status: STATUS.blocked,
      reason:
        data.enabled === false
          ? `“${nameOf(node)}” is disabled in the workspace, so nothing is delivered to it.`
          : `You switched “${nameOf(node)}” off for this run, so nothing is delivered to it.`,
      propagate: false,
    }
  }

  switch (kind) {
    case 'source': {
      /* Source -> source really is a dead end: an event is collected once, and a
         second collection of the same event is not a thing Segment does. */
      if (kindOf(from) === 'source') {
        return {
          status: STATUS.blocked,
          reason: 'An event cannot pass from one source into another.',
          propagate: false,
        }
      }
      /* Anything else upstream is the customer's own system handing Segment the event
         -- their app, a server, a queue -- which is the commonest thing to draw
         outside the Segment zone and the reason a walkthrough starts out there at all.
         This is where the event *enters* the pipeline, so it passes and carries on.
         It used to be blocked unconditionally, on the grounds that the only way to
         reach a source was from another source; that stopped being true when the
         connector allowlist went. */
      return {
        status: STATUS.passed,
        reason: `Collected by “${nameOf(node)}”. Upstream of this is the customer's own system, which Segment sees only as the call that arrives here.`,
        propagate: true,
      }
    }

    /* Not a topology kind, on purpose -- it stands for something the customer runs
       themselves, so Segment's rules have nothing to say about it. The simulator
       treats it the way it treats a function whose code it will not read: something
       happened here, we do not claim to know what, and the event carries on. Falling
       through to `default` instead left it `notEvaluated` and not propagating, which
       silently truncated every path that began outside Segment. */
    case 'custom':
      return {
        status: STATUS.passed,
        reason: `“${nameOf(node)}” is the customer's own component, so what it does to the event is not something this diagram knows. The path continues on the assumption it passes through.`,
        propagate: true,
      }

    case 'source_function':
    case 'source_insert_function':
    case 'destination_insert_function':
    case 'destination_function':
      return visitFunction({ node, payload, functionBehaviour })

    case 'source_schema_control':
      return visitSchemaControl({ node, payload })

    case 'destination_filter':
      return visitFilter({ node, payload, switchedOff })

    case 'destination_mapping':
      return visitMapping({ node, payload })

    case 'destination':
      return visitDestination({ node, from, payload, sourceNode })

    case 'warehouse':
      return {
        status: STATUS.delivered,
        reason: `Loaded into “${nameOf(node)}” on its next sync. Warehouses receive every event, unfiltered.`,
        /* Propagates so a Reverse ETL model downstream gets its own explanation
           rather than sitting grey. */
        propagate: true,
      }

    case 'reverse_etl_model':
      return {
        status: STATUS.notApplicable,
        reason:
          'Reverse ETL is not event-driven — this model runs its query on a schedule, so it plays no part in one event’s path.',
        propagate: false,
      }

    /* The three Protocols kinds. Nothing passes through a definition -- and saying
       which component *does* enforce it is the useful half of the answer, because a
       plan that enforces nothing is the commonest surprise in Protocols. */
    case 'tracking_plan':
      return {
        status: STATUS.notApplicable,
        reason:
          'A tracking plan is the list of events the workspace agreed to, not a stage the event passes through. What stops an unplanned event is the connected source’s schema controls — a plan with none set to block changes nothing.',
        propagate: false,
      }

    case 'event_library':
    case 'property_library':
      return {
        status: STATUS.notApplicable,
        reason: `“${nameOf(node)}” holds ${kind === 'event_library' ? 'events and their properties' : 'groups of properties'} for tracking plans to share. Events do not flow through it; it is where the plan got its definitions.`,
        propagate: false,
      }

    case 'space':
      return visitSpace({ node, payload })

    case 'identity_resolution':
      return visitIdentityResolution({ node, payload })

    case 'computed_trait':
    case 'audience':
      return visitQueryNode({ node, payload })

    case 'profile_sync':
      return {
        status: STATUS.passed,
        /* `passed` rather than `delivered`: what reaches the warehouse is the profile
           this event changed, on the sync's own schedule, so calling the event
           delivered here would date a row that does not exist yet. */
        reason: `The profile this event touched — its identifiers, traits, and audience membership — is carried to the warehouse by “${nameOf(node)}” on the sync’s own schedule rather than now.`,
        propagate: true,
      }

    case 'profile_api':
      return {
        status: STATUS.notApplicable,
        reason:
          'The Profile API is a read surface — events are not delivered to it, they become readable through it.',
        propagate: false,
      }

    case 'journey':
      return {
        status: STATUS.undecided,
        reason:
          'Segment publishes no Journeys API, so this journey’s entry conditions are not readable and cannot be simulated.',
        propagate: false,
      }

    /* The three Unify/Engage kinds nobody can read back from the API. All three are
       asserted by hand, so the honest verdict is "this diagram says so", and none of
       them may be reported as verified. */
    case 'profile_source':
      return {
        status: STATUS.undecided,
        reason: `This diagram asserts that ${from ? `“${nameOf(from)}”` : 'the source upstream'} feeds the space’s profiles. No endpoint lists a space’s profile sources, so it cannot be confirmed — and if it is wrong, nothing past Unify sees the event.`,
        propagate: true,
      }

    case 'profile':
      return {
        status: STATUS.notApplicable,
        reason:
          'A profile is what the events before it added up to, and this node stands for the shape of one rather than a real person — so a single event has nothing to arrive at here.',
        propagate: false,
      }

    case 'identity_setting':
      return {
        status: STATUS.notApplicable,
        reason:
          'A recorded identity resolution rule, not a stage the event passes through. Segment publishes no API for these, so it is maintained by hand.',
        propagate: false,
      }

    default:
      return {
        status: STATUS.notEvaluated,
        reason: `“${kind ?? 'This component'}” is not a component the simulator knows how to route through.`,
        propagate: false,
      }
  }
}

/*
 * A function's code is deliberately not read -- reproducing it in a diagram invites
 * it going stale, which is the same reason the Rules tab refuses to show it. So the
 * honest simulation is "something may have changed here", with the user able to
 * assert a drop to test the branch.
 */
function visitFunction({ node, payload, functionBehaviour }) {
  if (functionBehaviour[node.id] === 'drop') {
    return {
      status: STATUS.dropped,
      reason: `You told the simulator to treat “${nameOf(node)}” as dropping the event.`,
      propagate: false,
    }
  }

  const terminal = dataOf(node).kind === 'destination_function'
  return {
    status: terminal ? STATUS.delivered : STATUS.transformed,
    reason: terminal
      ? `Delivered by “${nameOf(node)}”. A destination function *is* the destination — its code is not read, so what it sends is not simulated.`
      : `“${nameOf(node)}” may reshape or drop the event. Its code is not read, so the payload is carried through unchanged.`,
    transform: { unread: true },
    payload,
    propagate: !terminal,
  }
}

/*
 * Schema controls: the one gate that runs inside Segment's own validation.
 *
 * What can honestly be decided here is narrow, and the narrowness is the point. A
 * source's settings say which events it blocks outright, and a diagram can record which
 * events its tracking plan covers -- both are lists of names, and a name is something
 * this simulator can check. What it cannot do is evaluate a plan's rules: whether a
 * property is the right type, or required, or nested where the plan says. So an event
 * that is *in* the plan is not reported as valid, only as planned.
 */
function visitSchemaControl({ node, payload }) {
  const data = dataOf(node)
  const name = eventNameOf(payload)
  const blocked = namesOf(data.blockedEvents)
  const planned = namesOf(data.plannedEvents)

  if (name && blocked.some((entry) => sameName(entry, name))) {
    return {
      status: STATUS.dropped,
      reason: `“${name}” is blocked at the source by “${nameOf(node)}”, so it reaches nothing downstream — and is not counted as an MTU or an API call either.`,
      propagate: false,
    }
  }

  if (name && planned.length > 0 && !planned.some((entry) => sameName(entry, name))) {
    switch (data.unplanned) {
      case 'block':
        return {
          status: STATUS.dropped,
          reason: `“${name}” is not in the tracking plan recorded here, and this source blocks unplanned events, so it goes no further.`,
          propagate: false,
        }
      case 'omit':
        return {
          status: STATUS.transformed,
          reason: `“${name}” is not in the tracking plan recorded here. This source omits unplanned properties rather than blocking the event, so it continues — with fields this simulator cannot list, because that needs the plan's rules and not just its event names.`,
          transform: { unread: true },
          payload,
          propagate: true,
        }
      case 'allow':
        return {
          status: STATUS.passed,
          reason: `“${name}” is not in the tracking plan recorded here, but this source allows unplanned events, so it passes. The event will show as a violation without being stopped.`,
          propagate: true,
        }
      default:
        /* Undecidable rather than optimistic, matching an unreadable filter condition:
           the diagram says the event is unplanned and does not say what this source does
           about it, and the two answers differ by everything downstream. */
        return {
          status: STATUS.notEvaluated,
          reason: `“${name}” is not in the tracking plan recorded here, and what this source does with an unplanned event — allow, omit, or block — is not recorded, so nothing past this point is claimed.`,
          propagate: false,
        }
    }
  }

  return {
    status: STATUS.passed,
    reason:
      planned.length > 0 && name
        ? `“${name}” is in the tracking plan recorded here, so it passes validation. Whether its properties match the plan's rules is not checked — only the event name is.`
        : `Passes “${nameOf(node)}”. No blocked events or planned events are recorded on this component, so there is nothing here for the event to fail.`,
    propagate: true,
  }
}

/*
 * An actions destination's mapping. Its trigger is FQL, the same language destination
 * filters are written in, so it is evaluated by the same engine rather than described --
 * which makes "the destination is connected and still receives nothing" a thing the
 * walkthrough can actually show.
 *
 * The field mapping is a different matter: resolving it would mean reproducing the
 * destination's own payload shape, which is the same "do not reproduce what will go
 * stale" line the function bodies fall on.
 */
function visitMapping({ node, payload }) {
  const data = dataOf(node)
  const result = evaluateCondition(data.trigger, payload)

  if (!result.parsed) {
    return {
      status: STATUS.notEvaluated,
      reason: `“${nameOf(node)}” has a trigger this simulator cannot read (${result.error}), so whether the action fires is unknown.`,
      propagate: false,
    }
  }

  if (!result.matched) {
    return {
      status: STATUS.unmatched,
      reason: `The event does not match this mapping's trigger (${data.trigger}), so the action does not fire. A destination can be enabled, connected, and still send nothing for exactly this reason.`,
      propagate: false,
    }
  }

  return {
    status: STATUS.transformed,
    reason: result.empty
      ? `“${nameOf(node)}” records no trigger, so it fires on every event. The fields it sends are built from the event, and are not resolved here.`
      : `The event matches this mapping's trigger (${data.trigger}), so the action fires. The fields it sends are built from the event, and are not resolved here.`,
    transform: { unread: true },
    payload,
    propagate: true,
  }
}

/* Event names come off the API as a list of strings and are hand-typed as either that or
   a list of `{name}`, so both are read rather than one being declared correct.

   Exported because the inspector lists the same names it routes on. A second tolerant
   reader there would mean the panel could show an event the router does not see. */
export function namesOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.event))
    .filter((entry) => typeof entry === 'string' && entry.trim())
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

function visitFilter({ node, payload, switchedOff }) {
  const data = dataOf(node)

  /* A filter that is off is absent, so everything passes it -- the opposite of
     every other component, where off means nothing arrives. */
  if (data.enabled === false || switchedOff) {
    return {
      status: STATUS.passed,
      reason:
        data.enabled === false
          ? `“${nameOf(node)}” is disabled, so it does not apply.`
          : `You switched “${nameOf(node)}” off for this run, so it does not apply and the event passes it.`,
      propagate: true,
    }
  }

  const result = evaluateCondition(data.condition, payload)

  if (!result.parsed) {
    return {
      status: STATUS.notEvaluated,
      reason: `“${nameOf(node)}” has a condition this simulator cannot read (${result.error}), so its verdict is unknown and the event is not claimed to pass.`,
      propagate: false,
    }
  }

  if (!result.matched) {
    return {
      status: STATUS.passed,
      reason: `The event does not match “${nameOf(node)}” (${data.condition}), so the filter leaves it alone.`,
      propagate: true,
    }
  }

  /* An empty condition still has to run the actions. Returning "matches
     everything" and then passing the event on would contradict itself, and would
     hide a filter that drops every event -- the worst possible thing to hide. */
  return applyFilterActions({
    node,
    payload,
    matched: result.empty
      ? `“${nameOf(node)}” reports no condition, so it matches every event`
      : `The event matches “${nameOf(node)}” (${data.condition})`,
  })
}

/*
 * What a matched filter does is its actions, not its condition. The action `type`
 * spelling has been seen in more than one form across API versions, so this
 * matches on substrings in the same tolerant spirit as schemas.py.
 */
function applyFilterActions({ node, payload, matched }) {
  const actions = dataOf(node).actions ?? []

  if (actions.length === 0) {
    return {
      status: STATUS.dropped,
      reason: `${matched}, and the filter reports no actions. A destination filter with no action to take drops what it matches.`,
      propagate: false,
    }
  }

  const types = actions.map((action) => String(action?.type ?? '').toUpperCase())

  if (types.some((type) => type.includes('DROP'))) {
    return {
      status: STATUS.dropped,
      reason: `${matched}, and the filter drops it.`,
      propagate: false,
    }
  }

  if (types.some((type) => type.includes('SAMPLE'))) {
    const sample = actions.find((action) => String(action?.type ?? '').toUpperCase().includes('SAMPLE'))
    const percent = sample?.percent ?? sample?.samplePercentage
    return {
      status: STATUS.undecided,
      reason: `${matched} and is sampled${percent != null ? ` at ${formatPercent(percent)}` : ''}. Sampling is random, so whether this particular event survives is not something a simulation can tell you.`,
      propagate: false,
    }
  }

  const fieldAction = actions.find((action) => {
    const type = String(action?.type ?? '').toUpperCase()
    return (
      type.includes('WHITELIST') ||
      type.includes('BLACKLIST') ||
      type.includes('ALLOW') ||
      type.includes('BLOCK')
    )
  })

  if (fieldAction) {
    const fields = fieldPaths(fieldAction)
    const allowList = String(fieldAction.type ?? '')
      .toUpperCase()
      .match(/WHITELIST|ALLOW/)
    return {
      status: STATUS.transformed,
      reason: `${matched}. The filter ${allowList ? 'keeps only' : 'removes'} ${fields.length > 0 ? fields.join(', ') : 'the configured fields'}, then passes it on.`,
      transform: { fields, mode: allowList ? 'allow' : 'block' },
      payload,
      propagate: true,
    }
  }

  return {
    status: STATUS.notEvaluated,
    reason: `${matched}, but its action (${types.join(', ') || 'unnamed'}) is not one this simulator interprets, so the outcome is unknown.`,
    propagate: false,
  }
}

function fieldPaths(action) {
  const fields = action?.fields
  if (!fields || typeof fields !== 'object') return []
  const paths = []
  for (const [scope, spec] of Object.entries(fields)) {
    const names = Array.isArray(spec) ? spec : (spec?.fields ?? [])
    for (const name of names) paths.push(`${scope}.${name}`)
  }
  return paths
}

function formatPercent(percent) {
  const value = Number(percent)
  if (Number.isNaN(value)) return String(percent)
  return `${value <= 1 ? value * 100 : value}%`
}

/*
 * A destination discovered from the API carries the source it is wired to, which is
 * what settles "why did my event not arrive" -- and the check stays even though
 * build_graph now draws one edge per real source->destination connection. A
 * hand-drawn or hand-edited diagram can still claim an edge the workspace does not
 * have, and this is the only place that disagreement is visible.
 */
function visitDestination({ node, payload, sourceNode }) {
  const data = dataOf(node)
  const wiredTo = data.sourceId
  const simulatedFrom = dataOf(sourceNode).segmentId

  if (wiredTo && simulatedFrom && wiredTo !== simulatedFrom) {
    return {
      status: STATUS.blocked,
      reason: `“${nameOf(node)}” is connected to a different source, not “${nameOf(sourceNode)}”. Events from this source are not delivered to it.`,
      propagate: false,
    }
  }

  return {
    status: STATUS.delivered,
    reason: `Delivered to “${nameOf(node)}”.`,
    payload,
    propagate: false,
  }
}

function visitSpace({ node, payload }) {
  const identifiers = identifiersOf(payload)
  return {
    status: STATUS.passed,
    reason: identifiers.length > 0
      ? `The event updates a profile in “${nameOf(node)}”, keyed on ${identifiers.map((identifier) => identifier.key).join(', ')}.`
      : `The event reaches “${nameOf(node)}” but carries no identifier, so it cannot be attached to a profile.`,
    propagate: identifiers.length > 0,
  }
}

function visitIdentityResolution({ node, payload }) {
  const identifiers = identifiersOf(payload)
  if (identifiers.length === 0) {
    return {
      status: STATUS.blocked,
      reason: 'The event carries no userId, anonymousId, email, or groupId, so there is nothing to resolve it onto a profile.',
      propagate: false,
    }
  }
  return {
    status: STATUS.passed,
    reason: `Resolved onto a profile using ${identifiers.map((identifier) => `${identifier.key}=${identifier.value}`).join(', ')}. Which identifier wins is set per space and is not readable from the API.`,
    propagate: true,
  }
}

function visitQueryNode({ node, payload }) {
  const data = dataOf(node)
  const verdict = evaluateQuery(data.query, payload)
  const label = data.kind === 'audience' ? 'audience' : 'computed trait'

  if (verdict.value === 'true') {
    return {
      status: STATUS.matched,
      reason: `This event satisfies the ${label} “${nameOf(node)}” on its own.`,
      verdict,
      propagate: true,
    }
  }

  if (verdict.value === 'false') {
    return {
      status: STATUS.unmatched,
      reason: `This event cannot put the profile in “${nameOf(node)}”, and no history could change that: ${explain(verdict).join(' ') || data.query}`,
      verdict,
      propagate: false,
    }
  }

  const unsupported = dominantCause(verdict) === UNSUPPORTED
  return {
    status: unsupported ? STATUS.notEvaluated : STATUS.undecided,
    reason: explain(verdict).join(' ') || `The definition of “${nameOf(node)}” was not evaluated.`,
    verdict,
    propagate: false,
  }
}

/* --- projecting a step ----------------------------------------------------- */

/**
 * The visual state of the diagram after `step` steps have played.
 *
 * A fold rather than a lookup so the caller can hold one trace and render any
 * point in it, forwards or backwards, without the reducer keeping state.
 */
export function frameAt(trace, step) {
  const total = trace?.steps?.length ?? 0
  const index = Math.max(-1, Math.min(step ?? total - 1, total - 1))

  const nodeStatus = {}
  const edgeStatus = {}
  let payload = trace?.event ?? null
  let current = null

  for (let cursor = 0; cursor <= index; cursor += 1) {
    const entry = trace.steps[cursor]
    nodeStatus[entry.nodeId] = entry.status
    if (entry.edgeId) {
      edgeStatus[entry.edgeId] =
        entry.status === STATUS.dropped || entry.status === STATUS.blocked || entry.status === STATUS.unmatched
          ? 'dropped'
          : cursor === index
            ? 'active'
            : 'travelled'
    }
    if (entry.payload) payload = entry.payload
    current = entry
  }

  return {
    index,
    total,
    nodeStatus,
    edgeStatus,
    payload,
    current,
    done: index >= total - 1,
  }
}

/** The plan's `(graph, event, step) -> SimulationState` signature. */
export function simulateAt(graph, event, step, options) {
  const trace = simulate(graph, event, options)
  return { trace, frame: frameAt(trace, step) }
}

/* --- the results panel ----------------------------------------------------- */

/**
 * Per-destination rows, plus the Unify/Engage verdicts.
 *
 * Ordered worst-news-first: a delivered destination is the boring case, and the
 * reason someone opened the simulator is usually the one that was dropped.
 */
export function summarize(trace, graph) {
  const byId = new Map(componentNodes(graph).map((node) => [node.id, node]))
  const rank = {
    [STATUS.dropped]: 0,
    [STATUS.blocked]: 1,
    [STATUS.unmatched]: 2,
    [STATUS.notEvaluated]: 3,
    [STATUS.undecided]: 4,
    [STATUS.notApplicable]: 5,
    [STATUS.transformed]: 6,
    [STATUS.passed]: 7,
    [STATUS.matched]: 8,
    [STATUS.delivered]: 9,
    [STATUS.origin]: 10,
  }

  const rows = Object.values(trace?.visited ?? {})
    .map((step) => {
      const node = byId.get(step.nodeId)
      return {
        nodeId: step.nodeId,
        name: nameOf(node),
        kind: kindOf(node),
        status: step.status,
        reason: step.reason,
        arrived: ARRIVED.has(step.status),
        stepIndex: step.index,
      }
    })
    .sort((a, b) => (rank[a.status] ?? 99) - (rank[b.status] ?? 99) || a.name.localeCompare(b.name))

  const terminals = rows.filter((row) => ['destination', 'destination_function', 'warehouse'].includes(row.kind))

  return {
    rows,
    terminals,
    delivered: terminals.filter((row) => row.status === STATUS.delivered).length,
    withheld: terminals.filter((row) => !ARRIVED.has(row.status)).length,
    eventName: eventNameOf(trace?.event) ?? trace?.event?.type ?? 'event',
    notes: trace?.notes ?? [],
  }
}
