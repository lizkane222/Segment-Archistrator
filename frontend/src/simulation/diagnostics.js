/*
 * A path, written out as text you can paste to somebody.
 *
 * The walkthrough is an animation, and an animation is the one thing you cannot put in a bug
 * report. So when a path does not do what the reader expected, there was nothing to send: they
 * could describe what they saw, and everything that would explain it -- which connectors exist,
 * which way round they are, where the walk stopped and why -- was only visible by hovering things
 * one at a time.
 *
 * ## What it is built to make obvious
 *
 * The bug this was written for is a diagram whose connectors point the wrong way. Under
 * `ConnectionMode.Loose` a connector drawn from the downstream card back to the upstream one is
 * stored reversed (see canvas/direction.js), and the symptom is a path that reaches one component
 * and stops -- which reads as the tool being broken rather than as the diagram saying something
 * different from what it looks like.
 *
 * So the report leads with the two facts that settle it: what leaves the start, and which
 * connectors point *at* it. A start with nothing leaving it cannot go anywhere, and that sentence
 * is the whole diagnosis in a case that otherwise takes an afternoon.
 *
 * ## Why text and not JSON
 *
 * It is meant to be read by a person in a chat window, and pasted JSON is read by nobody. Every
 * line names components the way the diagram does, because "the connector from Adobe Analytics to
 * Source Function is backwards" is actionable and `e7` is not.
 *
 * Pure, and takes the trace it is given rather than running one, so the report describes exactly
 * the run the reader was looking at.
 */

import {
  DEFAULT_FALLBACK,
  STATUS,
  componentNodes,
  dataOf,
  foldLegacyBehaviour,
  hasArrived,
} from './router.js'
import { STATUS_LABELS } from './narration.js'

/** Components keyed by id, with the two things every line here needs. */
function index(graph) {
  const map = new Map()
  for (const node of componentNodes(graph)) {
    const data = dataOf(node)
    map.set(node.id, { name: data.name ?? node.id, kind: data.kind ?? 'unknown' })
  }
  return map
}

const label = (entry, id) => (entry ? `[${entry.kind}] ${entry.name}` : `[missing] ${id}`)

/**
 * One path as a plain-text report.
 *
 * @param scenario  the saved path: its name, start, event and assumptions
 * @param trace     the run to describe, or null when the path could not run at all
 * @param graph     the document the run was over, for names and the connector list
 */
export function pathReport({ scenario, trace, graph, diagramName } = {}) {
  const nodes = index(graph)
  const edges = (graph?.edges ?? []).filter(
    (edge) => nodes.has(edge.source) && nodes.has(edge.target),
  )
  const lines = []
  const say = (text = '') => lines.push(text)

  say('===  · PATH DIAGNOSTICS ===')
  say(`generated: ${new Date().toISOString()}`)
  if (diagramName) say(`diagram:   ${diagramName}`)
  say(`path:      ${scenario?.name ?? '(unnamed)'}`)
  say(
    `event:     ${scenario?.event?.type ?? '(none)'}${
      scenario?.event?.event ? ` "${scenario.event.event}"` : ''
    }`,
  )
  say(`components: ${nodes.size}   connectors: ${edges.length}`)
  say()

  /* --- the start, and whether it can go anywhere ---------------------------- */

  const startId = scenario?.sourceId ?? trace?.sourceId ?? null
  const leaving = edges.filter((edge) => edge.source === startId)
  const arriving = edges.filter((edge) => edge.target === startId)

  say('--- START ---')
  if (!startId) {
    say('No start chosen, so there is nothing to walk. Pick one in the path editor.')
    say()
  } else {
    say(`${label(nodes.get(startId), startId)}`)
    say(`connectors leaving it:  ${leaving.length}`)
    say(`connectors arriving at it: ${arriving.length}`)
    if (leaving.length === 0) {
      /* The headline. Everything else in the report is detail next to this. */
      say()
      say('*** NOTHING LEAVES THIS COMPONENT, so the path cannot go anywhere. ***')
      if (arriving.length > 0) {
        say('    These connectors point AT it instead of away from it, which is what a')
        say('    connector drawn from the far end towards this one looks like:')
        for (const edge of arriving) {
          say(`      ${label(nodes.get(edge.source), edge.source)}  ->  THIS`)
        }
        say('    Fix: right-click the connector and use Flow, or right-click the canvas')
        say('    and use "Reverse every connector" if the whole diagram is drawn backwards.')
      }
    }
    say()
  }

  /* --- the route it actually took ------------------------------------------- */

  say('--- ROUTE ---')
  if (!trace || !trace.waves?.length) {
    say('(no route — the path did not run)')
    say()
  } else {
    say('One block per moment. Components in the same block receive the event together.')
    say()
    trace.waves.forEach((indices, wave) => {
      const steps = indices.map((position) => trace.steps[position]).filter(Boolean)
      if (steps.length === 0) return
      say(`  ${String(wave + 1).padStart(2)}.`)
      for (const step of steps) {
        const via = step.edgeId ? ` via ${step.edgeId}` : ''
        const again = step.rejoin
          ? ' (also reached along another connector)'
          : step.revisit
            ? ' (the event returning, second stop)'
            : ''
        say(
          `      ${label(nodes.get(step.nodeId), step.nodeId)} — ${
            STATUS_LABELS[step.status] ?? step.status
          }${again}${via}`,
        )
        say(`          ${step.reason}`)
      }
    })
    say()
  }

  /* --- every connector, and which way it points ----------------------------- */

  const travelled = new Set(
    (trace?.steps ?? []).map((step) => step.edgeId).filter(Boolean),
  )

  say('--- CONNECTORS ---')
  say('"used" means the event travelled it on this run.')
  say()
  for (const edge of edges) {
    const id = edge.id ?? `${edge.source}->${edge.target}`
    say(
      `  ${travelled.has(id) ? 'used  ' : 'unused'}  ${label(nodes.get(edge.source), edge.source)}  ->  ${label(
        nodes.get(edge.target),
        edge.target,
      )}   (${id})`,
    )
  }
  if (edges.length === 0) say('  (none)')
  say()

  /* --- what the run never accounted for ------------------------------------- */

  const seen = new Set(Object.keys(trace?.visited ?? {}))
  const unreached = [...nodes.keys()].filter((id) => !seen.has(id))
  if (unreached.length > 0) {
    say('--- COMPONENTS THE PATH NEVER REACHED ---')
    for (const id of unreached) say(`  ${label(nodes.get(id), id)}`)
    say()
  }

  const unused = edges.filter((edge) => !travelled.has(edge.id ?? `${edge.source}->${edge.target}`))
  if (unused.length > 0 && trace?.waves?.length) {
    say('--- CONNECTORS THE EVENT NEVER TRAVELLED ---')
    say('A connector here is either downstream of somewhere the event stopped, or pointing')
    say('the wrong way. Check its arrowhead on the canvas.')
    for (const edge of unused) {
      say(
        `  ${label(nodes.get(edge.source), edge.source)}  ->  ${label(nodes.get(edge.target), edge.target)}`,
      )
    }
    say()
  }

  /* --- the assumptions this run was made under ------------------------------ */

  const off = scenario?.disabled ?? []
  const out = scenario?.excluded ?? []
  const back = scenario?.revisit ?? []
  /* Both spellings, because the legacy one is what a scenario saved before `fallback` existed carries --
     and a section headed "the assumptions this run was made under" that silently omitted one would be
     untrue. It omitted `functionBehaviour` entirely until now. */
  const assumed = { ...foldLegacyBehaviour(scenario?.functionBehaviour), ...(scenario?.fallback ?? {}) }
  const said = Object.entries(assumed).filter(([, how]) => how && how !== DEFAULT_FALLBACK)
  if (off.length > 0 || out.length > 0 || back.length > 0 || said.length > 0) {
    say('--- ASSUMPTIONS FOR THIS PATH ---')
    for (const id of off) say(`  switched off:  ${label(nodes.get(id), id)}`)
    for (const id of out) say(`  left out:      ${label(nodes.get(id), id)} (event steps over it)`)
    for (const id of back) say(`  visited twice: ${label(nodes.get(id), id)} (the path doubles back)`)
    for (const [id, how] of said) say(`  assume ${how}:  ${label(nodes.get(id), id)}`)
    say()
  }

  /* --- the reducer's own caveats -------------------------------------------- */

  if (trace?.notes?.length) {
    say('--- NOTES FROM THE SIMULATOR ---')
    for (const note of trace.notes) say(`  ${note}`)
    say()
  }

  /* --- the short version --------------------------------------------------- */

  const arrived = Object.values(trace?.visited ?? {}).filter((step) => hasArrived(step.status))
  const stopped = Object.values(trace?.visited ?? {}).filter(
    (step) => step.status === STATUS.dropped || step.status === STATUS.blocked,
  )
  say('--- SUMMARY ---')
  say(`reached ${arrived.length} of ${nodes.size} components; ${stopped.length} stopped short.`)
  say(`used ${travelled.size} of ${edges.length} connectors.`)

  return lines.join('\n')
}

/**
 * The same for several paths at once, which is what the drawer's button produces.
 *
 * Concatenated rather than merged: two paths are two runs and two answers, and interleaving them
 * would produce a document about neither.
 */
export function pathsReport(entries, { graph, diagramName } = {}) {
  const list = entries ?? []
  if (list.length === 0) {
    return 'No paths to report on. Create a path and choose where it starts.'
  }
  return list
    .map((entry) => pathReport({ ...entry, graph, diagramName }))
    .join(`\n\n${'='.repeat(70)}\n\n`)
}
