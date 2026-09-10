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

import { STATUS, componentNodes, defaultSourceId, frameAt, hasArrived, simulate } from './router.js'

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
    /* Both empty rather than absent, so the editor never has to guard and so a
       saved scenario reads as a complete description of its own run. */
    functionBehaviour: {},
    disabled: [],
  }
}

/** Scenarios that can actually be run: an event and a source that still exists. */
export function runnable(graph, scenarios) {
  const ids = new Set(componentNodes(graph).map((node) => node.id))
  return (scenarios ?? []).filter(
    (scenario) => scenario?.event && (scenario.sourceId ? ids.has(scenario.sourceId) : defaultSourceId(graph)),
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
      functionBehaviour: scenario.functionBehaviour ?? {},
      disabled: scenario.disabled ?? [],
    }),
  }))
}

/**
 * How many ticks a set of runs takes.
 *
 * `together`: the longest run, since they all advance at once and a short run just
 * finishes early. `sequence`: the sum, since each is watched on its own.
 */
export function playbackLength(runs, mode = PLAY_MODES.together) {
  const lengths = (runs ?? []).map((run) => run.trace?.steps?.length ?? 0)
  if (lengths.length === 0) return 0
  return mode === PLAY_MODES.sequence
    ? lengths.reduce((total, length) => total + length, 0)
    : Math.max(...lengths)
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
    return runs.map((run) => ({ index: tick, playing: tick < (run.trace?.steps?.length ?? 0) }))
  }

  let remaining = tick
  let started = true
  return runs.map((run) => {
    const length = run.trace?.steps?.length ?? 0
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
    const frame = frameAt(trace, index)
    projected.push({ scenario, trace, frame, playing, index: frame.index })

    /* index === -1 is a run that has not started yet in sequence mode. frameAt
       returns an empty frame for it, so nothing below needs to know. */
    for (const [nodeId, status] of Object.entries(frame.nodeStatus)) {
      ;(nodes[nodeId] ??= []).push({
        scenarioId: scenario.id,
        name: scenario.name,
        color: scenario.color,
        status,
        arrived: hasArrived(status),
        current: frame.current?.nodeId === nodeId,
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

    if (frame.current) {
      current.push({ scenarioId: scenario.id, color: scenario.color, step: frame.current })
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
 * Sets `data.paths` (every scenario touching this node) and, for the node a
 * playhead is on, `data.anchor`/`data.anchorStep` -- which is what makes the
 * walkthrough tooltip open by itself. All three are in `RUNTIME_NODE_KEYS`, so none
 * of this reaches the stored document; see diagram/serialize.js.
 *
 * `playing` gates the anchor, and only the anchor. An open tooltip is the claim "the
 * event is here, now", and that is true exactly while the transport is running -- so
 * when it stops, the rings and the dimming stay (they are the result, and the reason
 * to have watched) and the tooltip closes. Without the gate the playhead parks on
 * whichever component it finished on and holds a panel open over the diagram
 * indefinitely, which is what a stopped walkthrough used to look like: three
 * components greyed out with a note stuck to one of them and no way to tell why.
 *
 * @param frame    `combinedFrameAt` output, or null to clear playback state
 * @param playing  whether the transport is running; false leaves the frame's result
 *                 on the canvas but opens no tooltip
 */
export function applyPathsToNodes(nodes, frame, { playing = true } = {}) {
  /* One tooltip per node, so when two playheads land on the same node the first
     run's step is the one shown -- the drawer lists every run's position, which is
     where the ambiguity is resolved honestly rather than by stacking panels. */
  const steps = new Map()
  for (const entry of frame?.current ?? []) {
    if (!steps.has(entry.step.nodeId)) steps.set(entry.step.nodeId, entry.step)
  }

  let changed = false
  const next = nodes.map((node) => {
    if (node.type === 'zone') return node
    const paths = pathsFor(frame?.nodes, node.id)
    const step = playing ? (steps.get(node.id) ?? null) : null
    const anchor = step ? 'step' : undefined

    if (
      samePaths(node.data?.paths ?? null, paths) &&
      (node.data?.anchorStep ?? null) === step &&
      node.data?.anchor === anchor
    ) {
      return node
    }

    changed = true
    const data = { ...node.data, paths: paths ?? undefined, anchor, anchorStep: step ?? undefined }
    return { ...node, data }
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
  const steps = run?.trace?.steps ?? []
  const terminal = Object.values(run?.trace?.visited ?? {}).filter((step) =>
    [STATUS.delivered, STATUS.dropped, STATUS.blocked, STATUS.unmatched].includes(step.status),
  )
  return {
    scenarioId: run?.scenario?.id,
    name: run?.scenario?.name,
    color: run?.scenario?.color,
    total: steps.length,
    index: run?.index ?? -1,
    delivered: terminal.filter((step) => step.status === STATUS.delivered).length,
    withheld: terminal.filter((step) => !hasArrived(step.status)).length,
    notes: run?.trace?.notes ?? [],
  }
}
