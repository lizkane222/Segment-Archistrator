/*
 * Where the event is at a given millisecond, as opposed to on a given beat.
 *
 * The transport counts beats and always will: the scrubber, the step buttons and the drawer all
 * need a discrete position, and `frameAtPhase` is a pure fold over one. But a beat is a *state* of
 * the diagram, and the event is not a state -- it is a thing in motion, and it has to be somewhere
 * at every instant in between. That is what this module supplies.
 *
 * ## What was wrong without it
 *
 * The event used to be drawn only by the connector it was crossing, and only while that connector's
 * beat was the current one. A wave is two beats, so on every arrival beat the event was drawn by
 * nothing at all -- for a whole second there was no event anywhere on screen and a component simply
 * lit up on its own, then went out and a dot appeared on the next line. Half of every run had no
 * event in it. That is what read as stepping rather than travelling.
 *
 * ## Legs
 *
 * A trace becomes a flat list of legs, each with millisecond bounds:
 *
 *   {kind: 'travel', edgeId, from, to, start, end, until}   crossing a connector
 *   {kind: 'dwell',  nodeId,          start, end, until}    at a component
 *
 * Several legs share a start, which is the point: a fork is one moment with the event in two places,
 * so both arms travel together and both are live at once.
 *
 * `end` is when the *motion* finishes and `until` is when the beat does, and they are not the same
 * number for a fork. A beat lasts as long as its slowest connector (see `tickDurations`), so the
 * shorter arm finishes early and its token parks at the far end for the remainder. Holding it there
 * is the honest reading -- it has arrived, and the wave has not finished -- and the alternative,
 * stretching it to fill the beat, would make it crawl and break the constant speed that timing the
 * beat by distance exists to produce.
 *
 * ## Why it takes the durations rather than computing them
 *
 * The beat lengths come from `tickDurations`, the same table the transport schedules against. One
 * table with two readers cannot disagree; two tables computed from the same inputs can, and the way
 * that failure shows up is the event arriving at a component visibly before or after the component
 * lights up -- which is exactly the defect this is meant to fix. `choreography.test.js` pins the
 * alignment rather than trusting it.
 *
 * Pure, and free of geometry. Where a connector actually runs on screen is the canvas's business
 * (`EventLayer` reads the route the edge itself published); this says only which connector, and how
 * far along it, which is what makes it testable in a project with no DOM.
 */

import { STATUS } from './router.js'
import { NODE_BEAT_MS } from './scenarios.js'

/**
 * The event's whole itinerary, in milliseconds from the start of the run.
 *
 * @param trace              a `simulate()` result
 * @param options.durations  ms per beat, from `tickDurations` -- index-aligned with `trace.phases`
 * @param options.hopMs      edge id to how long crossing it takes, so an arm of a fork that is
 *   shorter than its sibling finishes when it actually arrives rather than when the beat ends
 * @param options.offset     when this run begins on the transport's clock. Zero for paths played
 *   together; in `sequence` mode the runs are laid end to end, so each one starts after the beats of
 *   the runs before it. Applied here rather than by the caller so the arithmetic that decides when a
 *   leg is live lives in one place.
 */
export function choreograph(trace, { durations = [], hopMs = null, offset = 0 } = {}) {
  const phases = trace?.phases ?? []
  const waves = trace?.waves ?? []
  const steps = trace?.steps ?? []

  const legs = []
  let clock = Number.isFinite(offset) ? offset : 0

  for (let beat = 0; beat < phases.length; beat += 1) {
    const { kind, wave } = phases[beat]
    /* A missing entry degrades to a uniform beat rather than to a zero-length one: a leg whose
       `start` equals its `until` is never live, so the token would blink out for that hop. Same
       fallback `tickDurations` uses for a connector it has no measurement for. */
    const span = span_(durations[beat], NODE_BEAT_MS)
    const start = clock
    const until = start + span
    clock = until

    for (const index of waves[wave] ?? []) {
      const step = steps[index]
      /* Only where the event genuinely went. A trace records more than the route: one hop past
         everything that stopped, so the diagram can say why, and the inert components no path
         touches at all. Those have a status and a connector and belong on the canvas -- but
         putting a token on them would draw an event travelling somewhere it never travelled. */
      if (!step || !reached(step, steps)) continue

      if (kind === 'edge') {
        if (!step.edgeId) continue
        /* Capped at the beat: a measurement that disagreed with the table it was summed into
           would put the token past the far end of the line and still moving. */
        const hop = Math.min(span, span_(hopMs?.get(step.edgeId), span))
        legs.push({
          kind: 'travel',
          edgeId: step.edgeId,
          from: step.fromId,
          to: step.nodeId,
          stepIndex: index,
          wave,
          start,
          end: start + hop,
          until,
        })
        continue
      }

      /* A rejoin is a second connector into a component that already has a verdict. Its
         connector is travelled and gets a leg above; its component does not get a second
         token, which would sit exactly on top of the first one.

         A *revisit* does get one, and should: the event really is back here, and a stop the reader
         asked to see needs something to watch. Two revisit dwells could in principle land on one wave
         and stack their tokens -- it needs two different parents at equal depth feeding the same
         component -- which is a smudge on a frame rather than a wrong account, and not worth a slot
         allocator to avoid. */
      if (step.rejoin) continue
      legs.push({
        kind: 'dwell',
        nodeId: step.nodeId,
        stepIndex: index,
        wave,
        start,
        end: until,
        until,
      })
    }
  }

  return legs
}

/**
 * The legs live at `ms`, each with how far through its motion it is.
 *
 * `progress` is 1 for a token parked at the far end of a hop it has already finished, and for a
 * dwell it runs 0..1 across the beat -- stationary, but the caller may want it to settle.
 */
export function legsAt(legs, ms) {
  const at = Number.isFinite(ms) ? ms : 0
  const live = []
  for (const leg of legs ?? []) {
    if (at < leg.start || at >= leg.until) continue
    const span = leg.end - leg.start
    live.push({ ...leg, progress: span > 0 ? Math.min(1, (at - leg.start) / span) : 1 })
  }
  return live
}

/**
 * How long the event is in play, which is not always how long the run lasts.
 *
 * A trace keeps going after the event has stopped: one beat past every dead end, so the diagram can
 * say why nothing arrived, and a final beat for the components no path touches. Those beats have no
 * token, correctly -- so on a diagram where the event stops early this is legitimately shorter than
 * the transport's own total, and the difference is time spent explaining rather than travelling.
 */
export function choreographyLength(legs) {
  return (legs ?? []).reduce((end, leg) => Math.max(end, leg.until), 0)
}

/**
 * The most places the event is at once, over the whole run.
 *
 * How many tokens the canvas has to draw. It matters because those tokens are mounted once and then
 * moved imperatively -- mounting and unmounting them as the count changed would put a React render
 * on every beat of every run, which is what the imperative loop exists to avoid.
 *
 * Only leg *starts* need checking: the live set can only grow at an instant when something begins.
 */
export function maxConcurrency(legs) {
  const list = legs ?? []
  let most = 0
  for (const leg of list) {
    let live = 0
    for (const other of list) if (other.start <= leg.start && leg.start < other.until) live += 1
    most = Math.max(most, live)
  }
  return most
}

/*
 * Did the event actually get here?
 *
 * The origin is where it starts, so yes by definition. Anything else was reached across a
 * connector, and only if whatever fed that connector passed the event on -- which is exactly what
 * `propagate` records. A step with no parent step and no origin status is a footnote: a component the
 * walk never touched, recorded so the diagram accounts for it.
 *
 * Against the parent *step* rather than `visited[fromId]`, because a path may stop at one component
 * twice and those two stops can differ in whether they passed the event on. Asking the component
 * would get whichever answer `visited` happens to hold -- the first -- so a token could be suppressed
 * on the leg that did travel, or drawn on the leg that did not.
 */
function reached(step, steps) {
  if (step.status === STATUS.origin) return true
  if (step.fromIndex == null) return false
  return steps[step.fromIndex]?.propagate === true
}

/* A positive finite duration, or the fallback. */
function span_(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
