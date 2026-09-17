/*
 * The walkthrough's notes, in the order the event collected them.
 *
 * ## Why they left the diagram
 *
 * A note used to be pinned open on the component the playhead was at, drawn over the canvas by
 * `NodeToolbar`. The card is wider than a component and taller than the row gap, so each one covered
 * the components either side of the one it described -- and because a fork arrives at several
 * components at once, the canvas had to cap how many it would open (three) and show *none* past that.
 * A source feeding twenty destinations therefore explained nothing at the moment it had most to say.
 *
 * Worse, there was nowhere to read the run as a whole. Each note appeared for one beat and was gone,
 * so the account of what happened to the event existed only as a sequence of things that had already
 * vanished. So the notes come off the drawing and stack in a lane instead, where they accumulate.
 *
 * ## Why this is a projection and not a log
 *
 * Nothing is appended anywhere. This derives the whole list from the trace and the current beat, the
 * same way every other frame in this system is derived from a tick -- which is what makes scrubbing
 * *backwards* shorten the lane instead of leaving stale cards behind, and what makes the lane
 * survive a re-render with no state to lose.
 */

import { describeKind, describeStep } from './narration.js'
import { componentNodes, dataOf } from './router.js'

/**
 * The note of every component inside `rect`, left to right.
 *
 * What the lane shows when nothing is playing, which is most of the time -- so this is the answer to
 * "what does this diagram do", where `notesSoFar` is the answer to "what happened to this event".
 * Same shape out, so the lane renders one list either way and does not branch on which it got.
 *
 * Scoped to the viewport because the lane is a strip and an architecture is not. Three hundred cards
 * is a scrollbar nobody will drag; the twenty components you are looking at is a readable row. It also
 * makes the lane self-updating in the way a reader expects -- pan to another part of the diagram and
 * the notes follow.
 *
 * Ordered by position rather than by id or document order, so the lane reads in the same direction as
 * the diagram: a component further left is a card further left. Ties broken top to bottom, then by id
 * so two components at the same point do not swap places between renders.
 *
 * @param nodes     React Flow nodes; zones and group stacks are skipped
 * @param rect      `{x, y, width, height}` in flow coordinates, or null for "everything"
 * @param topology  the architecture rules, for `describeKind`
 */
export function notesInView(nodes, rect, { topology = null, positions = null } = {}) {
  const boxes = []

  for (const node of nodes ?? []) {
    /* Components only. A zone is described by what is inside it, and a collapsed group stands for
       components whose notes are deliberately not being shown -- folding a group away is a request for
       less on screen, so producing forty notes for it would undo what the reader just asked for. */
    if (node.type !== 'segmentNode') continue

    const at = positions?.get(node.id) ?? node.internals?.positionAbsolute ?? node.position
    if (!at) continue
    const width = node.measured?.width ?? node.width ?? 0
    const height = node.measured?.height ?? node.height ?? 0

    if (rect && !overlaps(at, width, height, rect)) continue
    boxes.push({ node, x: at.x, y: at.y })
  }

  boxes.sort((a, b) => a.x - b.x || a.y - b.y || (a.node.id < b.node.id ? -1 : 1))

  return boxes.map(({ node }) => {
    const data = dataOf(node)
    return {
      /* Prefixed, so a viewport note and a walkthrough note for the same component cannot collide as
         React keys if both ever appear in one list. */
      key: `view:${node.id}`,
      scenarioId: null,
      pathName: null,
      color: null,
      nodeId: node.id,
      name: data.name ?? node.id,
      anchor: describeKind(node, { topology }),
      /*
       * The verdict from the last run, if there is one still on the canvas.
       *
       * Not null on principle: after a walkthrough has played, "what happened to my event here" is
       * more use than the generic description, and it is written on the node already
       * (`applyPathsToNodes`). With nothing played this is absent and the card shows what the
       * component is for.
       */
      step: describeStep(data.paths?.[0]?.step, node),
      current: false,
      wave: 0,
      order: 0,
    }
  })
}

/* Any overlap counts, not containment: a card half on screen is a card the reader can see and ask
   about, and requiring the whole box would drop exactly the ones at the edges they are panning
   towards. */
function overlaps(at, width, height, rect) {
  return (
    at.x + width >= rect.x &&
    at.x <= rect.x + rect.width &&
    at.y + height >= rect.y &&
    at.y <= rect.y + rect.height
  )
}

/**
 * Every note the runs have reached, in the order the event reached them.
 *
 * @param runs       `combinedFrameAt(...).runs` -- each with its own `trace` and projected `frame`
 * @param graph      the document, for resolving names and per-kind narration
 * @param topology   the architecture rules, for `describeKind`
 * @returns `[{key, scenarioId, pathName, color, nodeId, name, anchor, step, current, wave}]`
 *
 * Ordered by wave first and by run second, so with two paths playing the lane reads
 * chronologically -- what happened at the same moment sits together -- rather than as one path's
 * whole story followed by another's.
 */
export function notesSoFar(runs, graph, { topology = null } = {}) {
  const byId = new Map(componentNodes(graph).map((node) => [node.id, node]))
  const collected = []

  ;(runs ?? []).forEach((run, order) => {
    const trace = run?.trace
    const upto = run?.frame?.index ?? -1
    if (!trace || upto < 0) return

    const phases = trace.phases ?? []
    /* Where this run's playhead is *now*, so the lane can mark the newest cards. A list, because a
       fork has the event at more than one component and picking one would leave its sibling looking
       like history the instant it arrived. */
    /* Step indices rather than node ids: a component stopped at twice has two cards, and marking them
       by component would light both the moment either one is reached. */
    const now = new Set((run.frame?.current ?? []).map((step) => step.index))
    /* One card per *arrival* per run, and arrivals are per component except where the path asked
       otherwise. A component reached by two routes still has one verdict -- the rejoin exists so the
       second *connector* lights up, and a second card would repeat the same sentence under the same
       heading, so rejoins are skipped below as they always were. A component the path asked to stop at
       twice is the case this now admits: it was re-evaluated against the payload as it stands, so the
       second card is a different sentence and withholding it would leave a beat on the transport with
       nothing in the lane to explain it.

       Keyed on the step rather than the component, because that is what "one per arrival" means. */
    const seen = new Set()

    for (let beat = 0; beat <= upto && beat < phases.length; beat += 1) {
      /* Arrivals only. A travelling beat is the event between two components, and there is no
         component for it to be a note about. */
      if (phases[beat].kind !== 'node') continue

      for (const index of trace.waves?.[phases[beat].wave] ?? []) {
        const step = trace.steps?.[index]
        if (!step || step.rejoin || seen.has(step.index)) continue
        seen.add(step.index)

        const node = byId.get(step.nodeId)
        collected.push({
          /* By step index, so a component stopped at twice gets two cards rather than one card and a
             duplicate React key in the lane. */
          key: `${run.scenario?.id}:${step.index}`,
          scenarioId: run.scenario?.id ?? null,
          pathName: run.scenario?.name ?? null,
          color: run.scenario?.color ?? null,
          nodeId: step.nodeId,
          name: dataOf(node).name ?? step.nodeId,
          /* Both readings, exactly as the pinned tooltip carried them: the per-kind heading says
             what the component is, the step says what happened to this event there. Handing over
             only the step would drop the heading and leave a card that opens with a status badge. */
          anchor: node ? describeKind(node, { topology }) : null,
          step: describeStep(step, node),
          current: now.has(step.index),
          wave: phases[beat].wave,
          order,
        })
      }
    }
  })

  /* Stable within a wave: `order` then insertion, so nothing reshuffles between frames. */
  return collected
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => a.entry.wave - b.entry.wave || a.entry.order - b.entry.order || a.at - b.at)
    .map(({ entry }) => entry)
}
