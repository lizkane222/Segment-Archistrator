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
 *   - Function bodies are read *when the component carries code*, and are run
 *     against the event by ../functions/runtime.js -- so a function that strips a
 *     field really does strip it from the payload the next component receives. A
 *     function with no code on it is reported as "may transform", exactly as before,
 *     and the user can still tell the simulator to treat any of them as dropping.
 *     The runner is synchronous and has no network, so code that needs to wait for
 *     something reports `unavailable` and falls back to that same honest hint rather
 *     than to a guess -- which is the whole reason the outcome is a value and not a
 *     boolean.
 *   - Audience and computed-trait verdicts are three-valued and often UNKNOWN,
 *     because one event cannot settle a question about profile history.
 *
 * One consequence worth stating: `simulate` is memoised on (graph, event), which
 * holds only while running a function twice gives the same answer. The runner offers
 * nothing that varies by itself (no clock, no network, no randomUUID), so the only
 * way to break that is for the user's own code to reach for `Math.random()` -- which
 * is a thing they did, not a thing this reducer did.
 */

import { sequenceOf } from './branches.js'
import { evaluateCondition } from './fql.js'
import { evaluateQuery } from './audienceQuery.js'
import { dominantCause, explain, UNSUPPORTED } from './logic.js'
import { eventNameOf, identifiersOf } from './payload.js'
import {
  OUTCOME,
  ROUTER_DEADLINE_MS,
  runFunction,
  summarizeChanges,
} from '../functions/runtime.js'
import { anchoredLines, checklistState, summarizeSteps } from '../functions/steps.js'

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
  /* Left out of this path by the reader, and stepped over rather than stopped at. Distinct from
     `blocked`: switching a component off is a claim about the architecture ("nothing is delivered
     here"), while leaving it out is a claim about the *story being told* ("this path is not about
     this component"), and the event carries on to whatever it feeds. */
  bypassed: 'bypassed',
}

/* Statuses that mean the event got there. Used by the results panel rather than
   by traversal, which asks each handler whether to propagate instead.

   `bypassed` is in here because the event did pass through -- it is not withheld, and counting it
   as such would put a number in the results panel that reads as a fault when it was a choice. It
   is not `delivered` either, which is what keeps it out of the delivered count. */
const ARRIVED = new Set([
  STATUS.origin,
  STATUS.passed,
  STATUS.transformed,
  STATUS.delivered,
  STATUS.matched,
  STATUS.bypassed,
])

/* Exposed as a predicate rather than as the set, so a caller cannot add to it and
   change what every other reader of a trace considers an arrival. */
export const hasArrived = (status) => ARRIVED.has(status)

/*
 * What to assume where the diagram does not say.
 *
 * ## Why the default is `allow`
 *
 * Because the alternative was reading *absence of configuration* as an architectural finding, and
 * that turned out to be almost every component on almost every diagram. A destination filter with no
 * condition and no actions used to match every event, find no action to take, and drop it -- so a box
 * somebody had just dragged onto the canvas reported the event dead and greyed out everything past it.
 * Across the diagrams this tool actually holds, not one filter, audience, computed trait, journey or
 * mapping carried any rules at all: the "finding" was unanimous and meaningless. Worse, the fields it
 * turned on are read-only in the inspector -- they arrive from a real workspace or not at all -- so on
 * a hand-drawn diagram there was no way to stop a filter dropping.
 *
 * So an unconfigured component now passes the event, and the reader says otherwise when they mean it.
 *
 * ## Three, not two
 *
 * `block` is not the same claim as switching a component off, and the drawer has said so in a comment
 * for longer than this enum has existed: a dropping insert function still ran, while a switched-off one
 * was never invoked. `modify` is the third, and it is the honest answer for the commonest case of all --
 * a function whose body this tool cannot read, which probably did something to the payload but not
 * anything we can name.
 *
 * These are assumptions, so they only ever apply where the simulator has nothing better. A condition
 * that evaluates false, a matching DROP action, code that threw DropEvent, an audience query that
 * resolved -- all of those are *known*, and a fallback must never soften a real finding into a guess.
 * See `indeterminate` for the other half of that rule.
 */
export const FALLBACK = {
  allow: 'allow',
  block: 'block',
  modify: 'modify',
}

export const DEFAULT_FALLBACK = FALLBACK.allow

/* The legacy spelling. `functionBehaviour: {[nodeId]: 'pass' | 'drop'}` said the same thing about
   functions alone, and nothing in the app ever wrote it -- but a scenario in the database may carry
   one, and `serialize.test.js` and `tests/test_graph.py` both pin that it survives a round trip. Folded
   in one place (`runScenarios`) rather than checked at every use. */
const LEGACY_BEHAVIOUR = { pass: FALLBACK.allow, drop: FALLBACK.block }

/** A legacy `functionBehaviour` map as a `fallback` one. Exported so `runScenarios` is the only caller. */
export function foldLegacyBehaviour(behaviour) {
  const folded = {}
  for (const [nodeId, value] of Object.entries(behaviour ?? {})) {
    const mapped = LEGACY_BEHAVIOUR[value]
    if (mapped) folded[nodeId] = mapped
  }
  return folded
}

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

/*
 * How many times one component may be stopped at, at most, when a path has asked for it -- see
 * `revisit` in `simulate`.
 *
 * This is what keeps the walk finite, and it is a constant rather than a setting because it is not a
 * matter of taste: two is what a round trip needs (out and back), and the number that has to be
 * bounded by *something* is the number of times a component's outgoing connectors are followed. Raise
 * it and a diagram with a cycle in it takes longer to walk without telling a clearer story.
 */
const STOPS_PER_NODE = 2

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

/*
 * Every kind `visit` has a handler for.
 *
 * Kept beside the switch it mirrors, and read by `indeterminate` so an unknown kind is offered a
 * fallback: the simulator has no handler for it and so can claim nothing about it, which is precisely
 * the condition a fallback answers. Adding a `case` below without adding it here is the one way to get
 * these out of step, and the cost of that is a component offered a setting it does not need -- which is
 * the safe direction to fail in.
 */
const KNOWN_KINDS = new Set([
  'source',
  'custom',
  'source_function',
  'source_insert_function',
  'destination_insert_function',
  'destination_function',
  'source_schema_control',
  'destination_filter',
  'destination_mapping',
  'destination',
  'warehouse',
  'reverse_etl_model',
  'tracking_plan',
  'event_library',
  'property_library',
  'space',
  'identity_resolution',
  'computed_trait',
  'audience',
  'profile_sync',
  'profile_api',
  'journey',
  'profile_source',
  'profile',
  'identity_setting',
])

/*
 * Kinds whose outcome this tool can fail to settle, and which therefore take a fallback.
 *
 * A fixed list of kinds rather than a per-node inspection, for the same reason `revisitable` reads the
 * graph and not the trace: the answer has to be stable. "Does this filter record actions" flips the
 * moment a reader sets the fallback to `block` and truncates the path, and a control that removes its
 * own row is a control with no undo. A kind, by contrast, is a kind.
 *
 * It is deliberately close to the `toggleable` list the switched-off chips already use -- the two
 * questions are asked about much the same components -- but not identical: a `destination` or a
 * `warehouse` has nothing unreadable about it (they receive, and that is all), while an `audience` or a
 * `journey` is nothing but unreadable.
 */
const INDETERMINATE_KINDS = new Set([
  'source_function',
  'source_insert_function',
  'destination_insert_function',
  'destination_function',
  'destination_filter',
  'destination_mapping',
  'source_schema_control',
  'audience',
  'computed_trait',
  'journey',
])

/*
 * Of those, the ones where `modify` is a thing the component could actually do.
 *
 * An audience does not rewrite an event -- it decides whether a profile is in a set -- so offering
 * "assume it modifies the payload" there would invite a claim the diagram cannot support. Functions,
 * filters, mappings and schema controls all really can reshape what passes through them.
 */
const MODIFIABLE_KINDS = new Set([
  'source_function',
  'source_insert_function',
  'destination_insert_function',
  'destination_function',
  'destination_filter',
  'destination_mapping',
  'source_schema_control',
])

/** Is `modify` a meaningful assumption for this kind? See `MODIFIABLE_KINDS`. */
export function acceptsModify(kind) {
  return MODIFIABLE_KINDS.has(kind)
}

/**
 * The components on `graph` that take a fallback: those this tool may be unable to read.
 *
 * A Set of ids, off the graph, for the reasons in `INDETERMINATE_KINDS`. An unknown `kind` counts too:
 * the simulator has no handler for it, so it cannot claim anything about it, which is exactly the
 * condition a fallback answers.
 */
export function indeterminate(graph) {
  const ids = new Set()
  for (const node of componentNodes(graph)) {
    const kind = kindOf(node)
    if (INDETERMINATE_KINDS.has(kind) || !KNOWN_KINDS.has(kind)) ids.add(node.id)
  }
  return ids
}

/**
 * The components a path could sensibly be asked to stop at twice: those with more than one connector
 * drawn into them. See `revisit` in `simulate`.
 *
 * Off the *graph*, and that is the whole point of it being here rather than inferred where it is used.
 * The obvious source is the trace -- a `rejoin` step is literally the arrival the setting promotes, so
 * it looks like better evidence. It is not, and the way it fails is the way that matters: a rejoin only
 * exists if the walk reached the second connector, and a path whose filter drops the event never does.
 * So the control offering this vanished from exactly the diagram it was built for, leaving no way to
 * switch it on. Connectors are drawn whether or not a given run reached them, which is the question.
 *
 * A Set of ids rather than nodes, because every caller is asking "is this one of them" about a
 * component it already has.
 */
export function revisitable(graph) {
  const inbound = new Map()
  for (const edge of graph?.edges ?? []) {
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1)
  }
  const ids = new Set()
  for (const [nodeId, count] of inbound) if (count > 1) ids.add(nodeId)
  return ids
}

/* --- the trace ------------------------------------------------------------- */

/**
 * Which tick each step of the walk plays on, given the order this path takes its forks in.
 *
 * ## Why this is a pass and not a counter
 *
 * `wave` used to be written during the walk as `depth + 1`, which made two different ideas one
 * number: how far a component is from the start, and which moment it is watched at. They coincide
 * for a plain breadth-first reading and stop coinciding the instant a path wants to take one arm of a
 * fork before the other -- so they are prised apart here. `depth` still means BFS distance and
 * several things read it; `wave` means "which tick", and only this decides it.
 *
 * ## The shape it walks
 *
 * A tree. Every step carries exactly one `fromIndex` -- one parent *step*, not one parent component --
 * and a second connector arriving at a component the walk is finished with is recorded as a separate
 * `rejoin` step that owns no children. So the parent links form a spanning tree of the walk and this
 * cannot loop, however many cycles the diagram itself has, and however many times a path asks for one
 * component to be stopped at.
 *
 *   unsequenced fork  every arm at `parent + 1`, their subtrees advancing together. Exactly the
 *                     breadth-first shape as before, which is what keeps this inert for every path
 *                     that has not asked for anything.
 *   sequenced fork    arm *k*'s whole subtree finishes before arm *k+1* begins.
 *
 * Whole subtree, not one row: staggering only the arms themselves would interleave two branches a row
 * apart, and an event alternating between two stories reads as a fault rather than as a sequence.
 *
 * A `rejoin` is scheduled one wave after its own parent rather than pinned to the component it
 * rejoins. It exists so the *connector* lights up, and the connector is travelled at the moment the
 * branch carrying it gets there.
 *
 * @param steps     pass one's steps, each with `index`, `nodeId`, `fromIndex`, `rejoin`
 * @param branches  the scenario's fork order -- see simulation/branches.js
 * @returns Map of step index to wave
 */
export function scheduleWaves(steps, branches = null) {
  const list = steps ?? []
  const waves = new Map()
  if (list.length === 0) return waves

  /*
   * Children by parent *step*, in the order the walk found them.
   *
   * By step index and not by node id, which is the difference between a tree and a graph. These maps
   * used to be keyed by `fromId` and read back by `nodeId`, which was sound only while a component
   * could appear at most once in the walk. It no longer can: a path may ask for a component to be
   * stopped at twice (see `revisit` in `simulate`), and under node-id keys the two visits pool their
   * children -- so every child gets placed once per visit, and a genuine round trip
   * (`fn -> plan -> fn`) has `place` descending through the same pair for ever.
   *
   * A step index identifies one arrival rather than one component, and every step carries exactly
   * one parent, so keying on it makes the parent links a real spanning tree. Termination is then a
   * property of the shape rather than something the walk has to promise.
   *
   * Rejoins are collected separately even though they are keyed the same way. A rejoin takes a wave
   * but owns no subtree -- the component it arrives at already has one, reached by the route that got
   * there first -- so letting them into `children` would send the scheduler down through the same
   * component twice and count its depth twice over.
   */
  const children = new Map()
  const rejoins = new Map()
  const roots = []
  for (const step of list) {
    /* No parent step: the origin, and pass three's footnotes. `fromIndex` rather than `fromId`
       because that is the link being walked -- a step that named a parent id without an index would
       be a step this scheduler could not place, and silently rooting it would put it on tick zero. */
    if (step.fromIndex == null) {
      roots.push(step)
      continue
    }
    const into = step.rejoin ? rejoins : children
    if (!into.has(step.fromIndex)) into.set(step.fromIndex, [])
    into.get(step.fromIndex).push(step)
  }

  /*
   * Place one step and everything below it; return the last wave the subtree occupies.
   *
   * That return value is the whole reason this is recursive rather than a loop over an explicit
   * stack: a sequenced fork cannot know when its second arm may start until the first arm has said
   * how far it reached. The recursion is as deep as the longest route through the diagram, which is
   * tens of components on a real architecture and is bounded by the walk having already visited each
   * one exactly once.
   */
  const place = (step, at) => {
    waves.set(step.index, at)

    /* A second connector into somewhere already reached. Scheduled a wave *after* this component,
       because that is when it is travelled: the event leaves here and arrives there, exactly like any
       other hop -- the only difference is that the component at the far end already has its verdict. */
    for (const extra of rejoins.get(step.index) ?? []) {
      if (!waves.has(extra.index)) waves.set(extra.index, at + 1)
    }

    const kids = children.get(step.index) ?? []
    if (kids.length === 0) return at

    const order = sequenceOf(
      branches,
      step.nodeId,
      kids.map((kid) => kid.nodeId),
    )

    /* All at once: every arm on the next wave, their subtrees advancing together. This is the
       breadth-first shape the walk had before any of this existed, and it is what every path that has
       asked for nothing still gets. */
    if (!order) {
      let deepest = at
      for (const kid of kids) deepest = Math.max(deepest, place(kid, at + 1))
      return deepest
    }

    /* One at a time: each arm's whole subtree finishes before the next one begins. */
    const byNode = new Map(kids.map((kid) => [kid.nodeId, kid]))
    let cursor = at
    for (const id of order) {
      const kid = byNode.get(id)
      if (kid) cursor = place(kid, cursor + 1)
    }
    return cursor
  }

  for (const root of roots) if (!root.rejoin) place(root, 0)

  /* Any step the tree walk did not reach. Pass one produces only connected steps, so this is a
     belt-and-braces floor rather than an expected case -- but a step with no wave would be a step
     `wavesOf` silently filed under tick zero, which is worse than saying so here. */
  for (const step of list) if (!waves.has(step.index)) waves.set(step.index, 0)

  return waves
}

/**
 * Steps grouped into the ticks they play on: `waves[n]` is the step indices of wave n.
 *
 * Dense, so an empty wave in the middle is still a tick. That can happen -- pass two records
 * against the wave *after* whatever stopped, and if a path stopped early there may be no
 * wave-three hop even though a footnote sits at wave four -- and collapsing the gap would make
 * the transport skip a beat and land the footnotes a tick early.
 *
 * Indices rather than the steps themselves, so nothing holds a second reference to a step and
 * the array stays the one place a step object lives.
 */
export function wavesOf(steps) {
  const list = steps ?? []
  if (list.length === 0) return []
  const highest = list.reduce((top, step) => Math.max(top, step.wave ?? 0), 0)
  const waves = Array.from({ length: highest + 1 }, () => [])
  for (const step of list) waves[step.wave ?? 0].push(step.index)
  return waves
}

/**
 * The ticks a walkthrough plays, as `{kind: 'edge' | 'node', wave}`.
 *
 * A wave is two beats, not one: the event travels *along* the connectors into it, and then it
 * *arrives* at the components. Those are separate moments to watch -- one is motion between two
 * places, the other is a verdict at one -- and collapsing them into a single tick was what made the
 * animation read as a component lighting up at the same instant as the line feeding it, with nothing
 * in between.
 *
 * Either beat is skipped where the wave has nothing for it to show, because a beat with nothing in it
 * is a second of stillness the reader has to sit through.
 *
 *   no edge beat    where nothing is travelled. The origin arrives from nowhere, and the footnote
 *                   wave -- components the walk never reached, recorded so the diagram accounts for
 *                   them -- has no route to them by definition.
 *   no node beat    where nothing *arrives*. A wave holding only rejoins is the case: a rejoin is a
 *                   second connector into a component that already has its verdict, so the connector
 *                   is travelled and no component is reached. This used to be invisible, because a
 *                   rejoin always shared its wave with a real arrival -- until a path could take a
 *                   fork one arm at a time, which puts the rejoin on a wave of its own and left a
 *                   dead beat at the end of every such run.
 */
export function phasesOf(steps, waves) {
  const list = waves ?? []
  if (list.length === 0) return []

  const phases = []
  for (let wave = 0; wave < list.length; wave += 1) {
    const indices = list[wave] ?? []
    if (indices.length === 0) continue
    if (indices.some((index) => steps[index]?.edgeId)) phases.push({ kind: 'edge', wave })
    if (indices.some((index) => steps[index] && !steps[index].rejoin)) {
      phases.push({ kind: 'node', wave })
    }
  }
  return phases
}

/**
 * Walk `event` through `graph`.
 *
 * @param options.sourceId          which source the event enters at
 * @param options.fallback          `{[nodeId]: 'allow' | 'block' | 'modify'}` -- what to assume where
 *   the diagram does not say. Absent means `allow` for everything, which is what makes an unconfigured
 *   component pass rather than report a drop nobody configured. See `FALLBACK`, and `indeterminate` for
 *   which components it can apply to.
 * @param options.functionBehaviour the same idea, for functions alone, spelled `'pass' | 'drop'`.
 *   Superseded by `fallback` and read only so a scenario saved with one keeps working -- `runScenarios`
 *   folds it in, so nothing here consults it.
 * @param options.disabled          node ids to treat as switched off for this run
 *   only. The graph is not touched: "the same architecture with the insert function
 *   turned off" is a question about one run, and mutating a copy of the graph to ask
 *   it would break memoising the trace on (graph, event) and would put a scenario's
 *   assumption where the document's own `enabled` lives.
 * @param options.branches          `{[forkNodeId]: [childNodeId, ...]}` -- forks this path takes one
 *   arm at a time, in the order given. Absent means all at once, which is what a fan-out to twenty
 *   destinations means and stays the default. See simulation/branches.js.
 * @param options.excluded          node ids to step *over*: the event passes through without
 *   the component acting on it and carries on to whatever it feeds. Not the same as `disabled`,
 *   which stops the event dead -- this is for a path that is not about a component the route
 *   happens to run through, so leaving one out must not truncate everything past it.
 * @param options.revisit          node ids this path stops at *twice*.
 *
 *   Default is once, and once is right almost always: a component reached by two routes has one
 *   verdict, and the second connector is recorded as a `rejoin` so the line lights up without the
 *   component claiming to have acted again. But some architectures genuinely double back, and one of
 *   the real ones does it in the middle of a customer walkthrough:
 *
 *     destination filter -> insert function -> Actions tracking plan -> insert function -> Adobe
 *
 *   The function asks the plan for its rules and carries on with the answer. Under the one-stop rule
 *   the return leg is a bare connector: no verdict, no narration, and -- because a rejoin owns no
 *   subtree -- nothing downstream of it either. Naming the component here makes the second arrival a
 *   real stop, with its own tick, its own children, and `visit` run again against the payload as it
 *   stands, so a function that reshapes the event visibly reshapes it twice.
 *
 *   Capped at two stops per component, which is what bounds the walk: each component's outgoing
 *   connectors are followed at most twice, so a cycle with both ends named goes A B A B and stops.
 */
export function simulate(
  graph,
  event,
  {
    sourceId,
    fallback = {},
    functionBehaviour = {},
    disabled = [],
    excluded = [],
    branches = null,
    revisit = [],
  } = {},
) {
  const off = new Set(disabled)
  const skip = new Set(excluded)
  const returning = new Set(revisit)
  /* Merged here rather than in two places: a caller that still passes the legacy field gets it read,
     and `fallback` wins where both name the same component, because it is the newer statement. */
  const assumed = { ...foldLegacyBehaviour(functionBehaviour), ...fallback }
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
  /*
   * The stops each component has had: how many, and the most recent.
   *
   * Both separate from `visited`, which answers a different question -- "what is this component's
   * verdict" -- and has to go on answering it with one step per component, because the results panel
   * is a list of components rather than of arrivals.
   *
   * The count is what `revisit` is capped against. The latest is what a *further* connector into a
   * component reports: a rejoin says "the verdict above is the one that settles it", and on a component
   * stopped at twice the verdict above is the second one. Quoting the first would let a connector read
   * as dropped when the pass that actually settled it passed the event on.
   */
  const stops = new Map()
  const latest = new Map()

  /*
   * `wave` is which tick a step plays on; `index` is where it sits in the array.
   *
   * They are not the same number and the difference is the whole point. Several hops happen at
   * once -- a source feeding four destinations is one moment, not four -- so the transport
   * advances a wave at a time and a fork lights both of its branches together. The array stays
   * flat and ordered so `summarize` and the tests can read it as a list.
   *
   * A rejoin does not overwrite `visited`. It is a second connector arriving at a component
   * that already has a verdict, recorded so the *connector* lights up; letting it replace the
   * entry would give the component a second verdict and make `summarize` report it twice.
   *
   * Neither does a revisit, for the same reason and a different one. A component stopped at twice
   * has two verdicts and they can differ -- the payload has moved on between them -- but the results
   * panel is a list of components rather than of arrivals, so `visited` keeps the first and the
   * `steps` array is where both live. Readers that want the verdict as at a given tick take it from
   * the frame, which folds the steps in order.
   */
  const record = (entry) => {
    const step = { index: steps.length, ...entry }
    steps.push(step)
    if (!entry.rejoin) {
      if (!visited.has(entry.nodeId)) visited.set(entry.nodeId, step)
      stops.set(entry.nodeId, (stops.get(entry.nodeId) ?? 0) + 1)
      latest.set(entry.nodeId, step)
    }
    return step
  }

  const origin = record({
    nodeId: start.id,
    fromId: null,
    fromIndex: null,
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
  let frontier = [{ node: start, payload: event, depth: 0, index: origin.index }]

  while (frontier.length > 0) {
    const nextFrontier = []

    for (const current of frontier) {
      for (const edge of outgoing.get(current.node.id) ?? []) {
        const edgeId = edge.id ?? `${edge.source}->${edge.target}`
        const target = byId.get(edge.target)

        /*
         * A second connector into a component the walk already accounted for.
         *
         * This used to `continue`, which dropped the *edge* along with the node -- so on any
         * diagram where two things feed one destination, one of those two connectors appeared
         * nowhere in the trace and never lit up during playback. The event does travel along it,
         * so it is recorded; what is not repeated is the component's verdict, which does not
         * change for having been arrived at twice.
         *
         * Unless the path asked for it to be. A component named in `revisit` is one the reader is
         * telling us the event genuinely comes back through, so its second arrival falls through to
         * the real visit below instead of being flattened into a connector.
         *
         * Bounded either way: a component is allowed `STOPS_PER_NODE` arrivals and no more, so its
         * outgoing connectors are followed a bounded number of times and a cycle cannot spin here.
         */
        const known = visited.get(edge.target)
        const again = known && returning.has(edge.target) && (stops.get(edge.target) ?? 0) < STOPS_PER_NODE
        if (known && !again) {
          record({
            nodeId: target.id,
            fromId: current.node.id,
            fromIndex: current.index,
            edgeId,
            depth: current.depth + 1,
            /* The most recent stop, not the first: on a component this path stops at twice, the
               verdict "above" is the second one. */
            status: (latest.get(edge.target) ?? known).status,
            reason: `“${nameOf(target)}” is also fed from “${nameOf(current.node)}”. It is reached by more than one route on this diagram, and the verdict above is the one that settles it.`,
            payload: current.payload,
            propagate: false,
            rejoin: true,
          })
          continue
        }

        const outcome = visit({
          node: target,
          from: current.node,
          payload: current.payload,
          event,
          sourceNode: start,
          assumed,
          switchedOff: off.has(target.id),
          bypassed: skip.has(target.id),
        })

        const onward = continues(outcome, outgoing.get(target.id))
        const reason = onward === outcome.propagate ? outcome.reason : beyond(outcome, target)

        const step = record({
          nodeId: target.id,
          fromId: current.node.id,
          fromIndex: current.index,
          edgeId,
          depth: current.depth + 1,
          status: outcome.status,
          /* Said out loud on a second stop, because the sentence underneath is about to repeat a
             verdict the reader has already been given once. Without the prefix the card reads as the
             walkthrough having lost its place rather than as the event doubling back. */
          reason: again ? `${returned(target, current.node)} ${reason}` : reason,
          payload: outcome.payload ?? current.payload,
          verdict: outcome.verdict ?? null,
          transform: outcome.transform ?? null,
          /* The *effective* answer, not the handler's. Pass two reads this to decide where to record
             a "the event never got here" hop, and the app reads it to explain why a path stops -- so
             recording the handler's opinion while walking on past it would have the trace disagreeing
             with itself. */
          propagate: onward,
          /* Which assumption produced this verdict, when one did. Carried onto the step so a reader --
             and the diagnostics report -- can tell a guess from a finding without parsing the sentence. */
          ...(outcome.assumed ? { assumed: outcome.assumed } : {}),
          ...(again ? { revisit: true } : {}),
        })

        if (onward) {
          nextFrontier.push({
            node: target,
            payload: outcome.payload ?? current.payload,
            depth: current.depth + 1,
            index: step.index,
          })
        }
      }
    }

    frontier = nextFrontier
  }

  /*
   * Which tick each of those steps plays on.
   *
   * Its own pass, between the walk and the two that explain the walk, and that placement is
   * load-bearing in both directions. It has to come *after* pass one, because deciding when a
   * sequenced fork's second arm may start requires knowing how deep the first arm went -- which is
   * not known until the walk has finished. And it has to come *before* pass two, which schedules
   * itself relative to whatever stopped (`parent.wave + 1`) and would otherwise be reading a number
   * that had not been decided yet.
   *
   * The walk itself no longer assigns waves at all. It used to write `depth + 1`, which made "how far
   * from the start" and "which moment it is watched at" the same number -- true of a plain
   * breadth-first reading and false the moment a path wants one arm of a fork before the other.
   */
  for (const [index, wave] of scheduleWaves(steps, branches)) steps[index].wave = wave

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
      fromIndex: parent.index,
      edgeId: edge.id ?? `${edge.source}->${edge.target}`,
      depth: parent.depth + 1,
      /* The wave after whatever stopped, so "the event would have gone here next" plays at the
         moment it would have happened rather than at the end of the run. */
      wave: (parent.wave ?? parent.depth) + 1,
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
  /* One wave past everything the walk produced, so the footnotes arrive after the run rather
     than at tick zero -- which is where grouping them by `depth` would have put them, since
     they have no depth to speak of. */
  const footnoteWave = steps.reduce((highest, step) => Math.max(highest, step.wave ?? 0), 0) + 1
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    if (!INERT_KINDS.has(kindOf(node))) continue

    const outcome = visit({
      node,
      from: null,
      payload: event,
      event,
      sourceNode: start,
      assumed,
      switchedOff: off.has(node.id),
      bypassed: skip.has(node.id),
    })

    record({
      nodeId: node.id,
      fromId: null,
      fromIndex: null,
      edgeId: null,
      depth: 0,
      wave: footnoteWave,
      status: outcome.status,
      reason: outcome.reason,
      payload: event,
      propagate: false,
      ...(outcome.assumed ? { assumed: outcome.assumed } : {}),
    })
  }

  const waves = wavesOf(steps)
  return {
    sourceId: start.id,
    event,
    steps,
    waves,
    phases: phasesOf(steps, waves),
    visited: Object.fromEntries([...visited].map(([id, step]) => [id, step])),
    notes,
  }
}

/*
 * Does the event carry on past this component?
 *
 * The handler's own answer, unless it said "stop" for the one reason that is not about the event: a
 * destination *delivers* and then, as far as Segment is concerned, the story is over. That is true of
 * Segment and not true of the architecture -- a customer's diagram may well carry on into another
 * vendor's estate, and one of the real ones does exactly that:
 *
 *   … -> Adobe Analytics -> Adds AA formatting -> AEP HTTP endpoint -> AEP dataset -> CJA reports
 *
 * Five components past the destination, every one of them drawn deliberately, and the walkthrough
 * used to report all five as never reached. The diagram said the data goes there and the tool said it
 * does not, which makes the tool wrong about the thing it is for.
 *
 * So an outgoing connector is read as the claim it is. Drawing a line out of a component says the
 * data continues, and this follows it.
 *
 * Gated on `delivered` specifically, and not on `hasArrived`, which was tried and is too loose. A
 * space returns `passed` with `propagate: false` to mean "the event got here but has no identifier, so
 * it cannot be attached to a profile" -- an entirely real reason not to continue, and one that has a
 * downstream audience depending on it. `arrived and stopped` covers both "the model ends here" and
 * "the event stopped here", and only the first should be walked past. `delivered` is the one status
 * that means the former: the event left Segment intact.
 *
 * Gated on there *being* an outgoing connector too, so a genuine leaf stays a leaf and the results
 * panel goes on counting delivered terminals.
 *
 * The component's status is untouched: Adobe Analytics still reads as `delivered`, because it is. What
 * changes is only whether the walk stops there.
 */
function continues(outcome, out) {
  if (outcome.propagate) return true
  return outcome.status === STATUS.delivered && (out?.length ?? 0) > 0
}

/* The verdict, plus the fact that the walk is following the diagram past it. Said out loud rather
   than left implicit: "Delivered to Adobe Analytics" followed by the event turning up three
   components later needs a sentence explaining which claim the tool is making, or it reads as the
   simulator not understanding what a destination is. */
function beyond(outcome, node) {
  return `${outcome.reason} This diagram carries on past “${nameOf(node)}”, so the walkthrough follows what you have drawn it feeding — beyond this point it is your architecture being described, not Segment's own behaviour.`
}

/*
 * The opening clause of a second stop.
 *
 * Prefixed to the verdict rather than replacing it, because the verdict is still the thing that
 * happened -- and it was re-evaluated against the payload as it stands now, so on a function that
 * reshapes the event it is a genuinely different sentence from the first pass. What the reader needs
 * added is only *which* pass they are looking at.
 */
function returned(node, from) {
  return `The event comes back through “${nameOf(node)}” from “${nameOf(from)}”, so this component acts on it a second time on this path.`
}

/*
 * The outcome of an assumption, for a component whose real behaviour the diagram does not record.
 *
 * One function so the three answers cannot drift apart across the eight or so places that reach for
 * them, and so the wording is uniformly about *who said so*. Every sentence here names the reader,
 * because that is the difference between this and a finding: "nothing is recorded, so the walkthrough
 * assumes" is a very different claim from "the filter drops it", and a reader who cannot tell them
 * apart has no reason to trust either.
 *
 * `why` lets the caller say what specifically was unreadable -- no actions recorded, a condition that
 * would not parse, a definition needing history -- appended rather than replacing the sentence, so the
 * assumption is always stated even when the cause is interesting.
 */
function assume(node, payload, how, why = null) {
  const name = nameOf(node)
  const because = why ? ` ${why}` : ''

  if (how === FALLBACK.block) {
    return {
      status: STATUS.dropped,
      reason: `You set “${name}” to block on this path, so the event stops here and nothing downstream receives it.${because}`,
      assumed: how,
      propagate: false,
    }
  }

  if (how === FALLBACK.modify) {
    return {
      status: STATUS.transformed,
      reason: `You set “${name}” to modify the event on this path, so it carries on with the payload treated as reshaped — this diagram does not record how, so the fields shown downstream are the ones that arrived.${because}`,
      /* The same `unread` marker an unread function body sets, so the payload panel already knows how to
         say "this may have changed" without a second vocabulary for the same uncertainty. */
      transform: { unread: true },
      assumed: how,
      payload,
      propagate: true,
    }
  }

  return {
    status: STATUS.passed,
    reason: `Nothing on this diagram records what “${name}” does to the event, so the walkthrough lets it through.${because} Set it to block or modify on this path to say otherwise.`,
    assumed: FALLBACK.allow,
    payload,
    propagate: true,
  }
}

/*
 * An honest verdict, with the reader's fallback deciding only whether the walk carries on past it.
 *
 * The other half of `assume`, and the distinction between them is the one this whole feature turns on.
 * `assume` is for a component that records *nothing* -- there is no verdict to preserve, so the
 * assumption becomes the verdict and the route reads green. This is for a component that records
 * something the simulator genuinely cannot settle: an audience needing profile history one event cannot
 * supply, a condition outside the readable FQL subset, a journey whose entry rules Segment publishes no
 * API for.
 *
 * Those keep their amber status, because it is true and because turning it green would claim the tool
 * had settled something it had not. What changes is that they no longer *truncate*: the event carries
 * on and everything downstream gets its own verdict, which is the difference between a walkthrough with
 * one honest caveat in it and a walkthrough that stops.
 */
function carryOn(outcome, node, payload, how) {
  if (how === FALLBACK.block) return assume(node, payload, how, outcome.reason)

  return {
    ...outcome,
    reason: `${outcome.reason} The walkthrough carries on past it${how === FALLBACK.modify ? ' with the payload treated as reshaped' : ''}, so what follows is what the diagram says happens next rather than something this component confirmed.`,
    ...(how === FALLBACK.modify ? { transform: { unread: true } } : {}),
    assumed: how ?? DEFAULT_FALLBACK,
    payload,
    propagate: true,
  }
}

/* --- per-kind behaviour ---------------------------------------------------- */

function visit({
  node,
  from,
  payload,
  event,
  sourceNode,
  assumed,
  switchedOff,
  bypassed,
}) {
  const data = dataOf(node)
  const kind = data.kind

  /*
   * Left out of this path, and therefore stepped over.
   *
   * First, ahead of every other rule including the two "off" checks below. Leaving a component out
   * is a statement about the story the path tells, and if it is not in the story then its
   * behaviour is not either -- so nothing here evaluates a filter, reads a function, or asks
   * whether the workspace has it enabled. The payload passes through untouched.
   *
   * `propagate: true` is the whole difference from `blocked`. Stopping here would truncate
   * everything downstream, which is the opposite of what leaving out a component in the middle of
   * a route is for.
   */
  if (bypassed) {
    return {
      status: STATUS.bypassed,
      reason: `“${nameOf(node)}” is left out of this path, so the event passes straight through it to whatever it feeds. Nothing this component does is evaluated here.`,
      propagate: true,
    }
  }

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
      /*
       * A source fed by another source: the same source in a second place, not a second collection.
       *
       * This used to be `blocked`, on the reasoning that an event is collected once and a second
       * collection of the same event is not a thing Segment does. That reasoning is right about the
       * product and wrong about the drawing, and the flagship template is the proof: a source in
       * Connections *also* exists as a Profile Source in Unify, and because those are conceptually
       * different places the template draws the same source twice and joins them. It was never
       * claiming data flows from one source into another.
       *
       * Blocking it cost the whole Unify and Engage half of that template -- Profile, Audience,
       * Computed Trait and Journey all reported as never reached, from one edge that was only ever a
       * drawing convention. A diagramming tool that enforces the product's plumbing over the reader's
       * concepts is rigid in the one place it cannot afford to be.
       *
       * So it passes, and says which of the two things it is. Nothing is claimed about a second
       * collection, because that is not what the edge means.
       */
      if (kindOf(from) === 'source') {
        return {
          status: STATUS.passed,
          reason: `“${nameOf(node)}” is the same source shown again — a source in Connections is also a Profile Source in Unify, and the two are drawn separately because they are different ideas. No second collection happens here; the walkthrough carries on into the role this copy stands for.`,
          propagate: true,
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
      return visitFunction({ node, payload, assumed })

    case 'source_schema_control':
      return visitSchemaControl({ node, payload })

    case 'destination_filter':
      return visitFilter({ node, payload, switchedOff, assumed })

    case 'destination_mapping':
      return visitMapping({ node, payload, assumed })

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
      /* Propagates, though it is not a stage. Keeping the honest verdict and *also* stopping the walk
         meant a component drawn feeding something else reported that something else as never reached --
         which is a claim about the diagram, not about Segment. The status stays amber because it is
         true; what carries on is the walk. */
      return {
        status: STATUS.notApplicable,
        reason:
          'Reverse ETL is not event-driven — this model runs its query on a schedule, so it plays no part in one event’s path.',
        propagate: true,
      }

    case 'tracking_plan':
      return visitTrackingPlan({ node, payload, from })

    case 'event_library':
    case 'property_library':
      return {
        status: STATUS.notApplicable,
        reason: `“${nameOf(node)}” holds ${kind === 'event_library' ? 'events and their properties' : 'groups of properties'} for tracking plans to share. Events do not flow through it; it is where the plan got its definitions.`,
        propagate: true,
      }

    case 'space':
      return visitSpace({ node, payload })

    case 'identity_resolution':
      return visitIdentityResolution({ node, payload })

    case 'computed_trait':
    case 'audience':
      return visitQueryNode({ node, payload, assumed })

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
        propagate: true,
      }

    case 'journey':
      /* Never readable, so this is the one kind whose fallback is the *only* thing that can decide it.
         The status stays amber whatever the reader assumes, because "we cannot see the entry conditions"
         does not stop being true when they tell us what to assume about them. */
      return carryOn(
        {
          status: STATUS.undecided,
          reason:
            'Segment publishes no Journeys API, so this journey’s entry conditions are not readable and cannot be simulated.',
        },
        node,
        payload,
        assumed?.[node.id],
      )

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
        propagate: true,
      }

    case 'identity_setting':
      return {
        status: STATUS.notApplicable,
        reason:
          'A recorded identity resolution rule, not a stage the event passes through. Segment publishes no API for these, so it is maintained by hand.',
        propagate: true,
      }

    default:
      /* No handler, so nothing is known -- which is what a fallback is for. This used to stop the walk,
         the way `custom` did before it was given a case of its own, and the comment there records what
         that cost: it silently truncated every path that ran through one. */
      return assume(
        node,
        payload,
        assumed?.[node.id],
        `“${kind ?? 'This component'}” is not a kind the simulator has rules for.`,
      )
  }
}

/*
 * A function, with or without its code.
 *
 * Without code the verdict is the one this simulator always gave: something may have
 * changed here, we do not claim to know what, and the user can assert a drop to test
 * the branch. That was the only honest answer while a function body was a thing the
 * tool refused to hold.
 *
 * With code on the component -- pasted into the Code tab -- it is *run*, and the event
 * that leaves is the event the code returned. That is the point of the feature: a
 * function that deletes a trait now visibly deletes it from the payload the next
 * component receives, and a `throw new DropEvent(...)` stops the path where it really
 * would stop.
 *
 * The interesting cases are the ones where running it settles less than it looks like
 * it should:
 *
 *   - `unavailable` -- the code reached for `fetch`, `crypto.createHash`, lodash. The
 *     runner is synchronous and has no network, so it cannot know what comes back. This
 *     falls all the way back to the unread verdict rather than to an optimistic one,
 *     because a payload shown confidently and wrong is worse than a payload withheld.
 *   - `notRunnable` -- it did not compile. Also the unread verdict, and deliberately
 *     still propagating: a half-typed brace in the sidebar must not blank out
 *     everything downstream of the component on the canvas.
 *   - `error` -- it threw something unplanned. Nothing past this point is claimed,
 *     which matches what Segment does with it: retry, then drop.
 *   - `no_handler` -- there is no handler for this event type. On an insert function
 *     that blocks the type outright, which is a real Segment behaviour and one of the
 *     easiest to be caught by, so it is reported as the drop it is.
 *
 * The reader's fallback wins over all of it. "Assume this blocks" is a question they asked, and code
 * that says otherwise is not an answer to it.
 */
function visitFunction({ node, payload, assumed }) {
  const data = dataOf(node)
  const name = nameOf(node)
  const terminal = data.kind === 'destination_function'

  const said = assumed?.[node.id]
  if (said === FALLBACK.block) return assume(node, payload, said)

  /*
   * The unread verdict, kept in one place because four branches below fall back to it and they must
   * not drift apart. `why` is appended when there is something specific to say about why the code
   * could not settle it.
   *
   * A terminal function is not routed through `assume`: a destination function *is* the destination,
   * so "the event carried on" is not a thing that could happen here whatever the reader assumes, and
   * `delivered` is the honest verdict. For the other three kinds this is `modify` in all but name --
   * a payload that may have been reshaped, carried through unchanged because we cannot say how -- so
   * the reader only has to reach for the control to say `block` or `allow` instead.
   */
  const unread = (why) => {
    if (!terminal && said === FALLBACK.allow) return assume(node, payload, said)
    return {
      status: terminal ? STATUS.delivered : STATUS.transformed,
      reason: terminal
        ? `Delivered by “${name}”. A destination function *is* the destination${why ? `, and ${why}` : ' — its code is not read, so what it sends is not simulated'}.`
        : `“${name}” may reshape or drop the event${why ? `, and ${why}` : '. Its code is not read'}, so the payload is carried through unchanged.`,
      transform: { unread: true },
      payload,
      propagate: !terminal,
    }
  }

  if (!data.code?.trim()) return unread(null)

  /* The checklist's anchors, so a walkthrough reports the same ticks and crosses the Code
     tab's own Test button does. Same source of truth, same run, so the two cannot disagree
     about what happened on this event. */
  const anchors = Object.values(anchoredLines(data.code))

  const result = runFunction({
    code: data.code,
    kind: data.kind,
    event: payload,
    settings: data.functionSettings ?? {},
    deadlineMs: ROUTER_DEADLINE_MS,
    probes: anchors,
    /* A handful, not the hundred the tester keeps: the trace reports a count and the
       Code tab is where the output is actually read. A trace is held per scenario per
       tick, so what goes in it stays small. */
    maxLogs: 5,
  })

  const logs = result.logs.length
  /* Small on purpose. This rides in the trace, which is memoised per (graph, event) and
     read by the canvas on every tick, so it carries a sentence and a count rather than
     the whole diff. */
  /*
   * Small on purpose. This rides in the trace, which is memoised per (graph, event) and read
   * by the canvas on every tick, so it carries a sentence and a few counts rather than the
   * whole diff, the console output, or the checklist itself.
   */
  const tally = summarizeSteps(
    checklistState(data.checklist ?? [], data.code, result.hits, result.tracked),
  )
  const transform = {
    ran: true,
    summary: summarizeChanges(result.changed),
    logs,
    outcome: result.outcome,
    ...(tally ? { steps: { done: tally.done, total: tally.total } } : {}),
  }
  const alsoLogged = logs > 0 ? ` It logged ${logs} line${logs === 1 ? '' : 's'}.` : ''
  /* The checklist, in one clause, so the walkthrough drawer says what the Code tab shows.
     Only when something was measurable -- see `summarizeSteps`. */
  const alsoSteps = tally
    ? ` ${tally.done} of ${tally.total} checklist step${tally.total === 1 ? '' : 's'} ${tally.done === 1 ? 'was' : 'were'} reached.`
    : ''

  switch (result.outcome) {
    case OUTCOME.returned: {
      const changes = summarizeChanges(result.changed)
      if (!changes) {
        return {
          /* `passed`, not `transformed`. The code ran and handed the event back
             untouched, and calling that a transformation would put an amber "the event
             was rewritten here" note on a component that did nothing to it. */
          status: terminal ? STATUS.delivered : STATUS.passed,
          reason: terminal
            ? `Delivered by “${name}”. Its code ran and returned the event unchanged.${alsoSteps}${alsoLogged}`
            : `“${name}” ran and returned the event unchanged.${alsoSteps}${alsoLogged}`,
          transform,
          payload: result.payload,
          propagate: !terminal,
        }
      }
      return {
        status: terminal ? STATUS.delivered : STATUS.transformed,
        reason: terminal
          ? `Delivered by “${name}”. Its code ran and ${changes}.${alsoSteps}${alsoLogged}`
          : `“${name}” ran and ${changes}. Everything downstream sees the event as it stands after this.${alsoSteps}${alsoLogged}`,
        transform,
        payload: result.payload,
        propagate: !terminal,
      }
    }

    case OUTCOME.emitted: {
      const count = result.emitted.length
      return {
        status: STATUS.transformed,
        reason:
          count === 1
            ? `“${name}” ran and emitted one ${result.payload?.type ?? 'event'} call, which is what continues from here.${alsoLogged}`
            : /* One event carries on, and the walkthrough says so rather than quietly
                 following the first. A source function fanning one webhook into four
                 events is a real thing, and a reducer built around a single payload
                 cannot show all four without pretending to be something it is not. */
              `“${name}” ran and emitted ${count} calls (${result.emitted.map((entry) => entry.type).join(', ')}). This path follows the first of them; the others take the same route.${alsoLogged}`,
        transform,
        payload: result.payload,
        propagate: true,
      }
    }

    case OUTCOME.dropped:
      return {
        status: STATUS.dropped,
        reason: `“${name}” threw DropEvent, so the event is discarded here${terminal ? '' : ' and nothing downstream receives it'}: ${result.error.message}${alsoSteps}${alsoLogged}`,
        transform,
        propagate: false,
      }

    case OUTCOME.invalid:
      return {
        status: STATUS.dropped,
        reason: `“${name}” rejected the event permanently (${result.error.name}: ${result.error.message}). There is no retry for this, so it goes no further.${alsoLogged}`,
        transform,
        propagate: false,
      }

    case OUTCOME.unsupported:
      return {
        status: STATUS.dropped,
        reason: `“${name}” does not handle ${payload?.type ?? 'this'} events (${result.error.message}), so nothing is sent for it.${alsoLogged}`,
        transform,
        propagate: false,
      }

    case OUTCOME.noHandler:
      return {
        status: STATUS.dropped,
        reason: `${result.error.message} An omitted handler blocks that event type outright rather than passing it through, which is the easiest thing about a function to be caught by.`,
        transform,
        propagate: false,
      }

    case OUTCOME.empty:
      return {
        status: STATUS.dropped,
        reason: `${result.error.message}${alsoLogged}`,
        transform,
        propagate: false,
      }

    case OUTCOME.retry:
      return {
        status: STATUS.undecided,
        reason: `“${name}” threw RetryError (${result.error.message}). Segment will retry it with backoff, so whether this event eventually lands is not something one run can tell you.${alsoLogged}`,
        transform,
        propagate: false,
      }

    case OUTCOME.unavailable:
      return unread(
        `its code needs something the local runner does not have (${result.error.message})`,
      )

    case OUTCOME.notRunnable:
      return unread(`its code could not be run here (${result.error.message})`)

    default:
      return {
        status: STATUS.notEvaluated,
        reason: `“${name}” threw while handling the event (${result.error?.name}: ${result.error?.message}), so nothing past this point is claimed. Segment would retry it and then drop it.${alsoLogged}`,
        transform,
        propagate: false,
      }
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
/*
 * A tracking plan, as a stage the event travels through.
 *
 * It used to be `notApplicable` and stop the path dead, on the grounds that a plan is a *list* and
 * enforcement lives in the connected source's schema controls. That is factually right and was the
 * wrong call for a diagram: someone who has drawn `app -> tracking plan -> source` has drawn the
 * question "does this event get in?", and answering it with a greyed-out box and a paragraph about
 * where enforcement really lives leaves the most interesting component on the diagram contributing
 * nothing to the walkthrough.
 *
 * So the plan now reports a verdict and the path continues through it. What it does *not* do is
 * invent authority it does not have:
 *
 *   - Event in the plan: passes, and says only the name was checked. Whether the properties satisfy
 *     the plan's rules needs the rules, and the API gives names.
 *   - Event not in the plan, and the plan records an `unplanned` policy: that policy is honoured,
 *     because a plan carrying one is someone recording the enforcement they have configured.
 *   - Event not in the plan, no policy recorded: passes, *with* the note about schema controls. This
 *     is the case the old behaviour was protecting, and it is preserved -- the plan does not claim to
 *     have blocked anything, it just no longer swallows the rest of the path.
 *   - No events listed at all: passes, saying so. A plan with no events on the diagram is a
 *     placeholder, and a placeholder must not read as "this event is unplanned".
 *
 * The `unplanned` field is deliberately the same name `source_schema_control` uses. They are the same
 * question -- what happens to an event nobody planned -- and one name means the inspector's existing
 * editor serves both and a reader does not have to learn two vocabularies.
 */
function visitTrackingPlan({ node, payload, from }) {
  const data = dataOf(node)

  /*
   * Nothing upstream reached this plan, so it is being *accounted for* rather than walked -- pass
   * three, which calls `visit` with no `from` for exactly the kinds in INERT_KINDS. A plan sitting
   * off to one side of the diagram must not report `passed`: that would claim the event went through
   * a component it never touched, which is a wrong diagram rather than a generous one.
   *
   * This is the old behaviour, kept precisely for the case it was right about.
   */
  if (!from) {
    return {
      status: STATUS.notApplicable,
      reason:
        'Nothing on this path reaches this plan, so it takes no part in the event’s journey. A tracking plan is the list of events the workspace agreed to; what stops an unplanned event is the connected source’s schema controls. Draw it between a source and what feeds it to include it in the walkthrough.',
      propagate: false,
    }
  }
  const name = eventNameOf(payload)
  /* Three spellings, because a plan reaches this diagram three ways: read from the API, seeded by a
     template, or typed by hand into the inspector. Treating only one as authoritative would make the
     walkthrough depend on how the plan got here. */
  const planned = namesOf(data.plannedEvents ?? data.events ?? data.rules)
  const label = data.trackingPlan ? `“${data.trackingPlan}”` : `“${nameOf(node)}”`

  if (!name || planned.length === 0) {
    return {
      status: STATUS.passed,
      reason: `${label} records no event list on this diagram, so there is nothing to check this event against. It passes; what a plan actually enforces is the connected source’s schema controls.`,
      propagate: true,
    }
  }

  if (planned.some((entry) => sameName(entry, name))) {
    return {
      status: STATUS.passed,
      reason: `“${name}” is in ${label}, so it is a planned event. Only the name is checked here — whether its properties match the plan’s rules needs the rules themselves, which the API does not return.`,
      propagate: true,
    }
  }

  switch (data.unplanned) {
    case 'block':
      return {
        status: STATUS.dropped,
        reason: `“${name}” is not in ${label}, and unplanned events are set to be blocked, so it never reaches the source — and is not counted as an MTU or an API call either.`,
        propagate: false,
      }
    case 'omit':
      return {
        status: STATUS.transformed,
        reason: `“${name}” is not in ${label}. Unplanned properties are omitted rather than the event being blocked, so it continues — with fields this simulator cannot list, because that needs the plan’s rules and not just its event names.`,
        transform: { unread: true },
        payload,
        propagate: true,
      }
    case 'allow':
      return {
        status: STATUS.passed,
        reason: `“${name}” is not in ${label}, but unplanned events are allowed, so it passes. It will show as a violation without being stopped.`,
        propagate: true,
      }
    default:
      /* Passes, unlike the schema control's equivalent branch, which refuses to guess. The
         difference is where the authority sits: a *source* that does not record its unplanned
         policy genuinely might block, so claiming anything past it would be a guess. A plan has no
         enforcement of its own, so "it carries on and the source decides" is not a guess -- it is
         what happens. */
      return {
        status: STATUS.passed,
        reason: `“${name}” is not in ${label}, so it is an unplanned event — a violation. The plan itself blocks nothing; whether it actually gets in is the connected source’s schema controls, which this diagram does not record for this path.`,
        propagate: true,
      }
  }
}

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
function visitMapping({ node, payload, assumed }) {
  const data = dataOf(node)
  const result = evaluateCondition(data.trigger, payload)
  const said = assumed?.[node.id]

  if (!result.parsed) {
    return carryOn(
      {
        status: STATUS.notEvaluated,
        reason: `“${nameOf(node)}” has a trigger this simulator cannot read (${result.error}), so whether the action fires is unknown.`,
      },
      node,
      payload,
      said,
    )
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

function visitFilter({ node, payload, switchedOff, assumed }) {
  const data = dataOf(node)
  const said = assumed?.[node.id]

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
    return carryOn(
      {
        status: STATUS.notEvaluated,
        reason: `“${nameOf(node)}” has a condition this simulator cannot read (${result.error}), so its verdict is unknown.`,
      },
      node,
      payload,
      said,
    )
  }

  /*
   * Checked before the actions, and that order is load-bearing.
   *
   * A condition the event does not match is a *known* answer: the filter provably leaves this event
   * alone, whatever it would do to one that matched and whatever the reader has assumed. Consulting the
   * fallback here would let "assume this blocks" drop an event the recorded rules say it never touches,
   * which is the one thing a fallback must not do -- it exists to fill silence, not to overrule a fact.
   */
  if (!result.matched) {
    return {
      status: STATUS.passed,
      reason: `The event does not match “${nameOf(node)}” (${data.condition}), so the filter leaves it alone.`,
      propagate: true,
    }
  }

  return applyFilterActions({
    node,
    payload,
    said,
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
function applyFilterActions({ node, payload, matched, said }) {
  const actions = dataOf(node).actions ?? []

  /*
   * No actions recorded, so what the filter *does* is simply not on the diagram.
   *
   * This used to read `dropped`, on the reasoning that a filter with no action to take drops what it
   * matches. True of the real product and wrong for this tool: a filter's actions are read-only in the
   * inspector, arriving from a live workspace or not at all, so every hand-drawn filter had an empty
   * list and every hand-drawn filter therefore killed the walkthrough at the exact point the reader was
   * trying to explain. It read as a finding and it was a blank field.
   */
  if (actions.length === 0) {
    return assume(node, payload, said, `${matched}, and no actions are recorded for it.`)
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

  return carryOn(
    {
      status: STATUS.notEvaluated,
      reason: `${matched}, but its action (${types.join(', ') || 'unnamed'}) is not one this simulator interprets, so the outcome is unknown.`,
    },
    node,
    payload,
    said,
  )
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

function visitQueryNode({ node, payload, assumed }) {
  const data = dataOf(node)
  const label = data.kind === 'audience' ? 'audience' : 'computed trait'
  const said = assumed?.[node.id]

  /*
   * No definition at all, which is a different thing from a definition that cannot be settled.
   *
   * Checked here rather than left to `evaluateQuery`, which folds both into one `unsupported` verdict.
   * They deserve different answers: a placeholder audience somebody dropped on the canvas records
   * nothing, so there is no verdict to preserve and the walkthrough should simply let the event past
   * (green). A *recorded* definition needing profile history is a real caveat and keeps its amber
   * status below.
   */
  if (data.query == null || String(data.query).trim() === '') {
    return assume(node, payload, said, `No ${label} definition is recorded on this diagram.`)
  }

  const verdict = evaluateQuery(data.query, payload)

  if (verdict.value === 'true') {
    return {
      status: STATUS.matched,
      reason: `This event satisfies the ${label} “${nameOf(node)}” on its own.`,
      verdict,
      propagate: true,
    }
  }

  /* A definite no, from a definition that was read. Known, so the fallback stays out of it -- see the
     matching note in `visitFilter`. */
  if (verdict.value === 'false') {
    return {
      status: STATUS.unmatched,
      reason: `This event cannot put the profile in “${nameOf(node)}”, and no history could change that: ${explain(verdict).join(' ') || data.query}`,
      verdict,
      propagate: false,
    }
  }

  const unsupported = dominantCause(verdict) === UNSUPPORTED
  return carryOn(
    {
      status: unsupported ? STATUS.notEvaluated : STATUS.undecided,
      reason: explain(verdict).join(' ') || `The definition of “${nameOf(node)}” was not evaluated.`,
      verdict,
    },
    node,
    payload,
    said,
  )
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

/** Did the event stop at this step? Decides whether its incoming connector reads as dropped. */
function stopped(step) {
  return (
    step.status === STATUS.dropped ||
    step.status === STATUS.blocked ||
    step.status === STATUS.unmatched
  )
}

/**
 * The visual state of the diagram after `phase` ticks have played.
 *
 * The same fold as `frameAt`, over phases instead of single steps. Two properties come out of it,
 * and both are things the step-indexed version could not express:
 *
 *   - Everything happening at one moment is lit at one moment, so a fork reads as a fork. A source
 *     feeding four destinations sends the event down all four together, and stepping through them
 *     one at a time said something about the diagram that was not true.
 *   - Exactly one thing is `active` at a time -- either the connectors being travelled or the
 *     components being arrived at, never both. That is what lets the canvas glow only where the
 *     event *is*: an edge beat lights the lines and leaves the components behind it dim, and the
 *     node beat that follows lights the components and drops the lines to `travelled`.
 *
 * `frameAt` is kept beside this rather than replaced. It is the honest way to ask "what had happened
 * by step N", which is what a test asserting on trace order wants, and the two cannot disagree
 * because this is expressed in terms of the same statuses.
 *
 * `current` is a *list*, and it is empty during an edge beat: while the event is between components
 * there is no component it is at, which is precisely why the tooltips stay shut until it lands.
 */
export function frameAtPhase(trace, phase) {
  const phases = trace?.phases ?? []
  const waves = trace?.waves ?? []
  const steps = trace?.steps ?? []
  const total = phases.length
  const index = Math.max(-1, Math.min(phase ?? total - 1, total - 1))

  const nodeStatus = {}
  const nodeStep = {}
  const edgeStatus = {}
  const current = []
  let arrived = []
  let payload = trace?.event ?? null

  for (let cursor = 0; cursor <= index; cursor += 1) {
    const beat = phases[cursor]
    const active = cursor === index
    const landed = []

    for (const stepIndex of waves[beat.wave] ?? []) {
      const entry = steps[stepIndex]
      if (!entry) continue

      if (beat.kind === 'edge') {
        /* The connectors only. The components at their far ends have not been reached yet on this
           beat, and revealing their verdicts here would light the destination before the event
           got to it. */
        if (!entry.edgeId) continue
        edgeStatus[entry.edgeId] = stopped(entry) ? 'dropped' : active ? 'active' : 'travelled'
        continue
      }

      nodeStatus[entry.nodeId] = entry.status
      nodeStep[entry.nodeId] = entry
      if (entry.payload) payload = entry.payload
      landed.push(entry)
      if (active) current.push(entry)
    }

    if (beat.kind === 'node' && landed.length > 0) arrived = landed
  }

  return {
    index,
    total,
    /* Which kind of beat this is, so the canvas can tell "the event is moving" from "the event has
       landed" without re-deriving it from what happens to be active. */
    kind: phases[index]?.kind ?? null,
    nodeStatus,
    /*
     * The step each component's status came from, keyed the same way.
     *
     * Published because `nodeStatus` alone is not enough to say *why* once a component can be stopped
     * at twice: a reader looking it up in `trace.visited` gets the first stop's sentence beside the
     * second stop's status word, and the two can disagree. Folded in the same order as the status, so
     * they cannot.
     */
    nodeStep,
    edgeStatus,
    payload,
    current,
    /*
     * Where the event last *landed*, which during a travelling beat is not where it is.
     *
     * `current` is deliberately empty mid-hop -- there is no component the event is at, and that is
     * what keeps the tooltips shut and the glow on the line. But a panel describing the payload has
     * to keep saying something across the gap, or it would blink out and back on every hop. So this
     * holds the most recent arrival and never empties once the run has started.
     */
    arrived,
    /* The first of the active steps, for the handful of readers that genuinely want one thing
       to point at. Named so it cannot be mistaken for "the" position of the run. */
    leading: current[0] ?? null,
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
