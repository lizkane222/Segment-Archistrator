/*
 * The transport: play, pause, step, scrub, speed.
 *
 * requestAnimationFrame rather than setInterval, and the tick is derived from
 * elapsed time rather than incremented per frame. Two reasons, both visible:
 * a background tab throttles rAF, and an interval that keeps firing there returns
 * to a walkthrough that has silently run to the end; and scrubbing has to be able
 * to move the tick without the timer fighting it, which it does here by rebasing
 * the clock on whatever tick the scrub landed on.
 *
 * The tick is a plain integer, not a position in seconds. Playback speed is therefore a
 * property of this hook alone -- the trace and the frame know nothing about time, which is what
 * lets the same frame be rendered by an export or a test with no clock at all.
 *
 * What the integer *indexes* is not this hook's business either, and it has changed twice: it was a
 * step, then a wave, and is now a beat -- travelling along a wave's connectors and arriving at its
 * components being two beats rather than one (see `phasesOf` in simulation/router.js).
 *
 * ## Why ticks can have different lengths
 *
 * They used to all last `STEP_MS`, which meant the event crossed a 600px connector and a 60px one in
 * the same time -- so it appeared to race across long lines and creep across short ones. Constant
 * *speed* requires a tick as long as the distance being covered, so a caller may supply a duration
 * per tick and this schedules against their running total. A beat spent arriving at a component is
 * still a fixed length, because reading a verdict does not take longer when the card is further away.
 *
 * The uniform case is kept as the default: with no durations every tick is `STEP_MS`, which is what a
 * caller with no geometry to hand (a test, an export) should get.
 *
 * ## The clock, and why it is a ref
 *
 * A beat is a state of the diagram; the event is not a state -- it is in motion, and something has to
 * know where it is *between* two beats. So alongside the tick this publishes `clock`, the elapsed
 * position in the same milliseconds the durations are measured in, for `EventLayer` to interpolate
 * against (see simulation/choreography.js).
 *
 * It is a ref and not state on purpose. Elapsed time changes every frame, and holding it in state
 * would re-render whatever owns this hook sixty times a second -- which for `AppShell` means the
 * whole application, to move one dot. The consumer runs its own animation frame and reads the ref.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* Milliseconds per step at 1x, when the caller has no per-tick timing to offer. Slow enough to read
   the anchor that opens at each arrival, which is the point of the walkthrough -- an animation tuned
   to look good is one nobody can follow. */
const STEP_MS = 900

export const SPEEDS = [0.5, 1, 2, 4]

/**
 * Cumulative start time of each tick, in unscaled ms, plus the total.
 *
 * `offsets[n]` is when tick n begins. One extra entry on the end holds the length of the whole run,
 * which is what "has it finished" compares against.
 */
export function timeline(total, durations) {
  const offsets = new Array(total + 1)
  offsets[0] = 0
  for (let tick = 0; tick < total; tick += 1) {
    const span = durations?.[tick]
    offsets[tick + 1] = offsets[tick] + (Number.isFinite(span) && span > 0 ? span : STEP_MS)
  }
  return offsets
}

/**
 * Which tick is showing at `elapsed` ms, or -1 before the run starts.
 *
 * A tick occupies the span that *begins* at its own offset: tick n is current from `offsets[n]`
 * until `offsets[n + 1]`. Exported so that is pinned by a test rather than by inspection -- getting
 * it wrong by one shifts every beat onto its neighbour's duration, which with connectors timed by
 * distance means the glow and the moving event disagree about where the event is.
 *
 * A scan rather than a division, because the ticks are not the same length -- and it is at most a
 * few dozen entries walked once per frame.
 */
export function tickAt(offsets, elapsed, total) {
  if (!(elapsed >= 0)) return -1
  let tick = -1
  while (tick + 1 < total && offsets[tick + 1] <= elapsed) tick += 1
  return tick
}

/**
 * @param durations  optional ms per tick. Omit for a uniform `STEP_MS` per tick.
 */
export function usePlayback(total, { onEnd, durations } = {}) {
  const [tick, setTick] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  /* The wall-clock instant tick -1 would have started at, back-computed from the
     current tick. Held in a ref because changing it must not re-render. */
  const originRef = useRef(0)
  const frameRef = useRef(0)
  const endedRef = useRef(false)

  const offsets = useMemo(() => timeline(total, durations), [total, durations])
  /* Also in a ref, read by the animation frame below. If that effect depended on the array it would
     tear down and restart the rAF loop on every render that produced a new one -- and the caller
     computes these from node positions, so that is every render during a drag. */
  const offsetsRef = useRef(offsets)
  offsetsRef.current = offsets

  /* Where the playhead is in milliseconds, for whatever has to draw something that moves between
     beats. Kept in step with `tick` by every path that changes either -- see the header. */
  const clockRef = useRef(0)

  /* The wall-clock instant the run would have started at, back-computed from where the playhead is
     now. With unequal ticks that is the *cumulative* time up to this tick rather than a multiple of
     one step length -- which is the whole reason the offsets table exists.

     `offsets[nextTick]`, not `[nextTick + 1]`: a tick occupies the span that *begins* at its own
     offset. Rebasing to the end of it used to shift the whole run a beat out of phase -- the first
     beat's worth of time was spent on tick -1 with nothing drawn, every beat was then displayed for
     its neighbour's duration, and the last one was reached at the exact moment playback stopped, so
     it never showed at all. Distance-timed connectors made that visible: the beat lengths were right
     and were being applied to the wrong beats. */
  const rebase = useCallback(
    (nextTick) => {
      const into = offsets[Math.max(0, Math.min(nextTick, total))] ?? 0
      originRef.current = performance.now() - into / speed
      clockRef.current = into
    },
    [speed, offsets, total],
  )

  const seek = useCallback(
    (nextTick) => {
      const clamped = Math.max(-1, Math.min(nextTick, total - 1))
      endedRef.current = false
      rebase(clamped)
      setTick(clamped)
      return clamped
    },
    [total, rebase],
  )

  const play = useCallback(() => {
    if (total === 0) return
    /* Replay from the start when the transport is sitting at the end, rather than
       playing nothing -- pressing play on a finished walkthrough obviously means
       "again". Computed out here rather than inside a setTick updater, because
       rebasing the clock is a side effect and React may call an updater twice. */
    const from = tick >= total - 1 ? -1 : tick
    rebase(from)
    setTick(from)
    endedRef.current = false
    setPlaying(true)
  }, [total, tick, rebase])

  const pause = useCallback(() => setPlaying(false), [])

  const reset = useCallback(() => {
    setPlaying(false)
    endedRef.current = false
    clockRef.current = 0
    setTick(-1)
  }, [])

  useEffect(() => {
    if (!playing) return undefined

    const step = () => {
      const elapsed = (performance.now() - originRef.current) * speed
      const table = offsetsRef.current
      /* Published before anything else, so a consumer reading it this frame sees the same instant
         the tick below is derived from. */
      clockRef.current = elapsed

      const next = tickAt(table, elapsed, total)
      setTick((current) => (next > current ? next : current))

      /* Against the end of the *run*, not against the last tick's index. Stopping as soon as the
         final tick became current gave that tick no time on screen at all. */
      if (elapsed >= table[total]) {
        setPlaying(false)
        if (!endedRef.current) {
          endedRef.current = true
          onEnd?.()
        }
        return
      }
      frameRef.current = requestAnimationFrame(step)
    }

    frameRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameRef.current)
  }, [playing, speed, total, onEnd])

  /* A speed change mid-play must not jump the tick: rebase so the current step
     keeps its position and only what comes after it runs faster. Keyed on `speed`
     alone deliberately -- rebasing whenever `tick` changed would reset the clock
     every step and the transport would never advance. */
  const speedRef = useRef(speed)
  useEffect(() => {
    if (speedRef.current === speed) return
    speedRef.current = speed
    if (playing) rebase(tick)
  }, [speed, playing, tick, rebase])

  return {
    tick,
    /* Elapsed milliseconds, for drawing what moves between two beats. A ref rather than a value --
       see the header -- so reading it is a deliberate act inside someone else's animation frame and
       cannot accidentally become a dependency that re-renders on every tick of the clock. */
    clock: clockRef,
    /* Handed back rather than left to the caller to remember: the scrubber's range
       and the transport's disabled states are all bounds on the same number, and a
       caller holding its own copy is a caller whose slider can disagree with what
       `seek` will clamp to. */
    total,
    playing,
    speed,
    setSpeed,
    play,
    pause,
    reset,
    seek,
    step: useCallback(
      (delta) => {
        setPlaying(false)
        seek(tick + delta)
      },
      [seek, tick],
    ),
    done: total > 0 && tick >= total - 1,
  }
}
