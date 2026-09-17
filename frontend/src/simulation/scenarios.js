/*
 * Scenarios: several named runs through one diagram, played together.
 *
 * A scenario is a saved *question* — this event, from this source, with these
 * things switched off — and it is stored in the document because the question is
 * part of the architecture's documentation. "What reaches Braze if the insert
 * function drops?" is the thing worth handing to the next engineer, not the
 * answer, which any run can recompute.
 *
 * Two scenarios can share every node and edge and still differ, which is the case
 * the whole design is bent around: source-only versus source-plus-insert-function
 * is one path drawn twice, so the frame has to carry a *list* per node and per edge
 * rather than a status. Collapsing that list to one value would silently hide the
 * comparison the user asked for.
 *
 * Everything here is pure and derived. `runScenarios` is the only thing that costs
 * anything (it evaluates FQL and audience queries); `combinedFrameAt` is a
 * projection of a tick over runs that already exist, so scrubbing is free and
 * backwards is the same price as forwards -- the property `frameAt` already has,
 * lifted to many runs at once.
 */

import { STATUS, componentNodes, frameAtPhase, hasArrived, simulate } from './router.js'

/*
 * Path colours.
 *
 * Deliberately none of the status colours: green already means delivered and red
 * already means dropped on this canvas, so a scenario tinted either would read as
 * a verdict about itself. These are chosen to stay apart from each other under the
 * commonest colour-vision deficiency too, since the whole feature is "tell the
 * paths apart by colour" -- which is also why nothing depends on colour alone:
 * every path has a name, and the drawer lists them.
 */
export const PATH_COLORS = [
  '#0263e0', // blue
  '#6f42c1', // violet
  '#e67e22', // amber
  '#00b0b3', // teal
  '#c4249b', // magenta
  '#354052', // slate
]

export const PLAY_MODES = { together: 'together', sequence: 'sequence' }

/** The colour least used by `existing`, so the first few scenarios never collide. */
export function nextColor(existing = []) {
  const used = new Set(existing.map((scenario) => scenario?.color))
  return PATH_COLORS.find((color) => !used.has(color)) ?? PATH_COLORS[existing.length % PATH_COLORS.length]
}

/**
 * A new scenario, ready to save.
 *
 * `id` is passed in rather than generated so this stays pure and testable --
 * crypto.randomUUID() here would make two identical calls differ and put a
 * side effect in the middle of a data constructor.
 */
export function newScenario({ id, name, event, sourceId = null, color, existing = [] }) {
  return {
    id,
    name: name?.trim() || 'New path',
    color: color ?? nextColor(existing),
    sourceId,
    event: event ?? null,
    /* All empty rather than absent, so the editor never has to guard and so a
       saved scenario reads as a complete description of its own run. */
    functionBehaviour: {},
    disabled: [],
    /*
     * Components left out of this path: the event steps over them rather than stopping.
     *
     * Separate from `disabled` because they answer different questions, and merging them would
     * lose the distinction the whole feature turns on. `disabled` is "what if this were switched
     * off" -- a claim about the architecture, which stops the event dead. `excluded` is "this path
     * is not about that component" -- a claim about the story, which must not truncate everything
     * downstream of it.
     */
    excluded: [],
    /*
     * Forks this path takes one arm at a time, and in what order:
     * `{[forkNodeId]: [childNodeId, ...]}`.
     *
     * An object rather than an array because it is a per-fork answer. Empty rather than absent for the
     * same reason as the two above: a saved scenario reads as a complete description of its own run,
     * and the editor never has to guard. A fork with no entry plays all its arms at once, which is
     * what a fan-out to twenty destinations means. See simulation/branches.js.
     */
    branches: {},
    /*
     * Components this path stops at twice, because the architecture doubles back through them.
     *
     * The default is once, and a second arrival is otherwise recorded as a `rejoin` -- the connector
     * lights up and the component does not claim to have acted again, which is right for the common
     * case of two routes converging on one destination. This is the uncommon case: a function that
     * consults a tracking plan and carries on with the answer really is entered twice, and under the
     * one-stop rule the return leg had no verdict, no card, and nothing downstream of it.
     *
     * Opt-in per component rather than inferred from the diagram having a cycle, because a cycle is
     * not evidence that the reader wants both passes narrated -- and inferring it would silently
     * relayout every already-saved path that has a diamond in it. See `revisit` in
     * simulation/router.js.
     */
    revisit: [],
    /*
     * What to assume where the diagram does not say: `{[nodeId]: 'allow' | 'block' | 'modify'}`.
     *
     * Empty means allow everywhere, which is what makes an unconfigured component pass rather than
     * report a drop nobody configured. Supersedes `functionBehaviour`, which said the same thing about
     * functions alone and which nothing ever wrote; `runScenarios` folds that spelling in so a saved
     * scenario carrying one keeps working. See `FALLBACK` in simulation/router.js.
     */
    fallback: {},
  }
}

/**
 * Scenarios that can actually be run: an event, and a start that still exists.
 *
 * The start has to be *named*. It used to fall back to "the first source on the diagram", which
 * made a new path appear to work while quietly answering a question nobody asked -- on a diagram
 * with four sources the walkthrough ran from whichever happened to be first in the array, and the
 * reader had no way to know that was a default rather than a choice. Worse, the fallback is what
 * hid a diagram whose connectors point the wrong way: the path ran, reached one component, and
 * stopped, which looks like the tool failing rather than like a start that feeds nothing.
 *
 * So an unset start now makes a path un-runnable, and the editor opens on creation to ask for one.
 */
export function runnable(graph, scenarios) {
  const ids = new Set(componentNodes(graph).map((node) => node.id))
  return (scenarios ?? []).filter(
    (scenario) => scenario?.event && scenario.sourceId && ids.has(scenario.sourceId),
  )
}

/**
 * Run each scenario through the existing reducer.
 *
 * One `simulate` per scenario, no shared state: two runs over the same graph must
 * not be able to influence each other, or "with the function off" would depend on
 * whether "with it on" was played first.
 */
export function runScenarios(graph, scenarios) {
  return (scenarios ?? []).map((scenario) => ({
    scenario,
    trace: simulate(graph, scenario.event, {
      sourceId: scenario.sourceId ?? undefined,
      /* Both, because `simulate` merges them and the legacy one has to keep working for a scenario
         saved before this field existed. `fallback` wins where the two name the same component. */
      fallback: scenario.fallback ?? {},
      functionBehaviour: scenario.functionBehaviour ?? {},
      disabled: scenario.disabled ?? [],
      excluded: scenario.excluded ?? [],
      /* Null rather than `{}` for a scenario saved before fork order existed. `scheduleWaves` reads
         absent as "every fork all at once", which is what those paths have always done. */
      branches: scenario.branches ?? null,
      /* Empty for a scenario saved before revisits existed, which is every one of them: no component
         named means every second arrival stays the connector-only rejoin it has always been. */
      revisit: scenario.revisit ?? [],
    }),
  }))
}

/**
 * How many ticks a set of runs takes.
 *
 * A tick is a *beat* -- either the connectors of one wave being travelled or its components being
 * arrived at. Two things follow, and neither was expressible when a tick was a step: everything
 * happening at one moment plays at one moment, so a fork lights both branches together; and travelling
 * is separate from arriving, so exactly one of them can be glowing at a time.
 *
 * `together`: the longest run, since they all advance at once and a short run just
 * finishes early. `sequence`: the sum, since each is watched on its own.
 */
export function playbackLength(runs, mode = PLAY_MODES.together) {
  const lengths = (runs ?? []).map((run) => run.trace?.phases?.length ?? 0)
  if (lengths.length === 0) return 0
  return mode === PLAY_MODES.sequence
    ? lengths.reduce((total, length) => total + length, 0)
    : Math.max(...lengths)
}

/* How long a beat spent arriving at components lasts. Connector beats are timed by distance
   instead -- see `tickDurations`. */
export const NODE_BEAT_MS = 1000

/**
 * How long each tick should last, in milliseconds.
 *
 * A component beat is a fixed second: it is a verdict being read, and a verdict does not take longer
 * because the card is further away. A connector beat is timed by *distance*, so the event crosses
 * every connector at the same speed -- which is the whole point. Timing those uniformly is what made
 * the event look as though it sped up across a long line and crawled across a short one.
 *
 * Where a beat travels several connectors at once (a fork), it lasts as long as the longest of them.
 * Cutting to the next beat when the shortest arrives would leave the other dots still in flight and
 * the components they are heading for already lit.
 *
 * @param hopMs  edge id to how long crossing it should take. Supplied by the app, which is the only
 *   layer that knows where anything is on screen; a missing entry falls back to a node beat so a
 *   connector whose ends are not measured yet still takes a sensible amount of time.
 */
export function tickDurations(runs, mode = PLAY_MODES.together, { hopMs } = {}) {
  const perRun = (runs ?? []).map((run) =>
    (run.trace?.phases ?? []).map((beat) => {
      if (beat.kind !== 'edge') return NODE_BEAT_MS
      const ids = (run.trace.waves[beat.wave] ?? [])
        .map((index) => run.trace.steps[index]?.edgeId)
        .filter(Boolean)
      const longest = ids.reduce((top, id) => Math.max(top, hopMs?.get(id) ?? NODE_BEAT_MS), 0)
      return longest || NODE_BEAT_MS
    }),
  )

  if (perRun.length === 0) return []
  if (mode === PLAY_MODES.sequence) return perRun.flat()

  /* Played together, so tick n lasts as long as the slowest run's tick n. A run that has already
     finished contributes nothing rather than padding the tick to a full beat. */
  const total = Math.max(...perRun.map((list) => list.length))
  return Array.from({ length: total }, (_, tick) =>
    Math.max(...perRun.map((list) => list[tick] ?? 0), 1),
  )
}

/*
 * Which step of each run is showing at tick `tick`.
 *
 * `sequence` keeps the runs that have already played fully lit rather than
 * clearing them: the reason to play several paths at all is to compare them, and a
 * path that vanishes when the next one starts cannot be compared with it. So the
 * two modes differ in *timing* only -- which is exactly the distinction between
 * "in tandem" and "one after another" -- and not in what ends up on screen.
 */
function indicesAt(runs, tick, mode) {
  if (mode !== PLAY_MODES.sequence) {
    return runs.map((run) => ({ index: tick, playing: tick < (run.trace?.phases?.length ?? 0) }))
  }

  let remaining = tick
  let started = true
  return runs.map((run) => {
    const length = run.trace?.phases?.length ?? 0
    if (!started) return { index: -1, playing: false }
    if (remaining < length) {
      const index = remaining
      started = false
      return { index, playing: true }
    }
    remaining -= length
    return { index: length - 1, playing: false }
  })
}

/**
 * The whole canvas at tick `tick`, for every run at once.
 *
 * @returns `{tick, total, done, mode, runs, nodes, edges, current}` where `nodes`
 *   and `edges` map an id to a **list** of `{scenarioId, name, color, status}` --
 *   one entry per scenario that has touched it. `current` is the playhead of each
 *   run that is still advancing.
 */
export function combinedFrameAt(runs, tick, { mode = PLAY_MODES.together } = {}) {
  const list = runs ?? []
  const total = playbackLength(list, mode)
  const clamped = Math.max(-1, Math.min(tick ?? total - 1, total - 1))
  const indices = indicesAt(list, clamped, mode)

  const nodes = {}
  const edges = {}
  const current = []
  const projected = []

  list.forEach((run, position) => {
    const { scenario, trace } = run
    const { index, playing } = indices[position]
    const frame = frameAtPhase(trace, index)
    projected.push({ scenario, trace, frame, playing, index: frame.index })

    /* index === -1 is a run that has not started yet in sequence mode. frameAtPhase
       returns an empty frame for it, so nothing below needs to know. */
    const inFlight = new Set(frame.current.map((step) => step.nodeId))
    for (const [nodeId, status] of Object.entries(frame.nodeStatus)) {
      ;(nodes[nodeId] ??= []).push({
        scenarioId: scenario.id,
        name: scenario.name,
        color: scenario.color,
        status,
        /*
         * The verdict reached here, so hovering the component says what happened to *this* event
         * rather than what the component does in general.
         *
         * Not from the frame's playhead: the playhead is empty while the event is between two
         * components, which is half of every hop, so reading it there would make the hover text
         * alternate between the two accounts as the run played.
         *
         * From `frame.nodeStep` rather than `trace.visited`, though, because the status on the line
         * above comes from the frame -- and where a path stops at one component twice, `visited` holds
         * the first stop while the frame has folded its way to the second. That put the first stop's
         * sentence beside the second stop's status word. Both now come from the same fold, so they
         * cannot disagree; `visited` stays as the fallback for a caller holding an older trace.
         */
        step: frame.nodeStep?.[nodeId] ?? trace?.visited?.[nodeId] ?? null,
        arrived: hasArrived(status),
        /* A set, because a wave can have the event at several components at once -- comparing
           against one "the current step" would light whichever arm of a fork happened to be
           recorded first and leave its sibling looking passed over. */
        current: inFlight.has(nodeId),
      })
    }

    for (const [edgeId, status] of Object.entries(frame.edgeStatus)) {
      ;(edges[edgeId] ??= []).push({
        scenarioId: scenario.id,
        name: scenario.name,
        color: scenario.color,
        status,
      })
    }

    /* One entry per component in flight, not one per run. Two arms of a fork are two places
       the event is, and the drawer and the canvas both have to be able to say so. */
    for (const step of frame.current) {
      current.push({ scenarioId: scenario.id, color: scenario.color, step })
    }
  })

  return {
    tick: clamped,
    total,
    done: clamped >= total - 1,
    mode,
    runs: projected,
    nodes,
    edges,
    current,
  }
}

/* --- applying a frame to the canvas ---------------------------------------- */

/*
 * These two return the *same array* when nothing changed, and reuse the identity of
 * every node or edge whose own playback state is unchanged.
 *
 * That is not a micro-optimisation, it is what makes playback watchable: React
 * Flow re-renders any node whose object identity changed, and `SegmentNode` is
 * memoised on exactly that. Rebuilding all of them each tick would re-render a
 * 300-node diagram four times a second and drop the animation.
 */

/** What the frame says about one id, or null. */
function pathsFor(frame, id) {
  const entries = frame?.[id]
  return entries && entries.length > 0 ? entries : null
}

function samePaths(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return (
      entry.scenarioId === other.scenarioId &&
      entry.status === other.status &&
      entry.current === other.current
    )
  })
}

/**
 * Write a combined frame onto React Flow nodes.
 *
 * Sets `data.paths` and nothing else: every scenario touching this node, with the status that draws
 * the rings, the dimming and the glow, and the verdict reached there for whoever asks to read it. In
 * `RUNTIME_NODE_KEYS`, so none of it reaches the stored document; see diagram/serialize.js.
 *
 * One field rather than two, deliberately. The verdict used to be written separately as
 * `data.anchorStep`, and because a frame is recomputed rather than mutated that was a *new object*
 * every tick -- so comparing it by identity rebuilt every annotated node on every beat and defeated
 * the whole point of the identity contract below. Carrying it inside the `paths` entry means
 * `samePaths` is the single arbiter of whether a node changed, and it compares the things that
 * actually decide what is drawn.
 *
 * ## What it no longer does, and why
 *
 * It used to also set `data.anchor = 'step'`, which *pinned* a note open over the component the
 * playhead was at. Two problems the on-canvas version could not solve. A note card is wider than a
 * component and taller than the row gap, so each one covered the components either side of the one it
 * described -- the panel explaining a step obscured the step. And a wave arrives at several
 * components at once, so this had to cap how many it would open (three) and open *none* past that,
 * meaning a source feeding twenty destinations explained nothing at the moment it had most to
 * explain.
 *
 * So the notes are collected in a lane above the diagram instead (simulation/NotesLane.jsx), where
 * they accumulate and nothing is hidden to show them.
 *
 * The step itself is still written, deliberately: hovering a component during or after a run shows
 * what happened to *this* event there rather than the generic description, and the show-all-notes
 * gutter reads the same field. What went away is only the forcing open, not the content.
 */
export function applyPathsToNodes(nodes, frame) {
  let changed = false
  const next = nodes.map((node) => {
    if (node.type === 'zone') return node
    const paths = pathsFor(frame?.nodes, node.id)
    if (samePaths(node.data?.paths ?? null, paths)) return node

    changed = true
    return { ...node, data: { ...node.data, paths: paths ?? undefined } }
  })

  return changed ? next : nodes
}

/** The same for edges, which carry only `data.paths`. */
export function applyPathsToEdges(edges, frame) {
  let changed = false
  const next = edges.map((edge) => {
    const paths = pathsFor(frame?.edges, edge.id)
    if (samePaths(edge.data?.paths ?? null, paths)) return edge
    changed = true
    return { ...edge, data: { ...edge.data, paths: paths ?? undefined } }
  })
  return changed ? next : edges
}

/* --- reading a run --------------------------------------------------------- */

/**
 * One line per run for the drawer: where it is, and whether anything was withheld.
 *
 * `withheld` counts terminals the event never reached, which is the number someone
 * plays a scenario to find out. It is counted over the whole trace rather than over
 * the frame, because "3 destinations will not receive this" is a fact about the run
 * and should not appear to grow as the animation plays.
 */
export function runStatus(run) {
  const terminal = Object.values(run?.trace?.visited ?? {}).filter((step) =>
    [STATUS.delivered, STATUS.dropped, STATUS.blocked, STATUS.unmatched].includes(step.status),
  )
  return {
    scenarioId: run?.scenario?.id,
    name: run?.scenario?.name,
    color: run?.scenario?.color,
    /* Beats, matching the transport. Counting steps here would put "4/9" beside a scrubber whose
       maximum is 5, and the two numbers describing the same run have to agree. */
    total: run?.trace?.phases?.length ?? 0,
    index: run?.index ?? -1,
    delivered: terminal.filter((step) => step.status === STATUS.delivered).length,
    withheld: terminal.filter((step) => !hasArrived(step.status)).length,
    notes: run?.trace?.notes ?? [],
  }
}
