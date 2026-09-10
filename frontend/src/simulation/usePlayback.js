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
 * The tick is a plain integer step index, not a position in seconds. Playback speed
 * is therefore a property of this hook alone -- the trace and the frame know nothing
 * about time, which is what lets the same frame be rendered by an export or a test
 * with no clock at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/* Milliseconds per step at 1x. Slow enough to read the anchor that opens at each
   arrival, which is the point of the walkthrough -- an animation tuned to look
   good is one nobody can follow. */
const STEP_MS = 900

export const SPEEDS = [0.5, 1, 2, 4]

export function usePlayback(total, { onEnd } = {}) {
  const [tick, setTick] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  /* The wall-clock instant tick -1 would have started at, back-computed from the
     current tick. Held in a ref because changing it must not re-render. */
  const originRef = useRef(0)
  const frameRef = useRef(0)
  const endedRef = useRef(false)

  const rebase = useCallback(
    (nextTick) => {
      originRef.current = performance.now() - (nextTick + 1) * (STEP_MS / speed)
    },
    [speed],
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
    setTick(-1)
  }, [])

  useEffect(() => {
    if (!playing) return undefined

    const step = () => {
      const elapsed = performance.now() - originRef.current
      const next = Math.min(Math.floor(elapsed / (STEP_MS / speed)) - 1, total - 1)
      setTick((current) => (next > current ? next : current))

      if (next >= total - 1) {
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
