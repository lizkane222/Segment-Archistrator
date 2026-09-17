/*
 * The transport's timing table, and which beat a millisecond falls on.
 *
 * The hook itself needs React and a clock, and this project has no DOM to give it either -- so the
 * arithmetic is extracted and tested here instead. That is not a consolation prize: an off-by-one in
 * `tickAt` is the one bug in this file that cannot be seen by reading it, and it went unnoticed
 * until connectors were timed by distance. Beats were being displayed for their *neighbour's*
 * duration, which meant the glow ran a beat out of step with the event.
 */

import { describe, expect, it } from 'vitest'

import { tickAt, timeline } from './usePlayback.js'

describe('timeline', () => {
  it('accumulates each tick onto the one before it', () => {
    expect(timeline(3, [100, 200, 300])).toEqual([0, 100, 300, 600])
  })

  /* The extra entry on the end is the length of the whole run, which is what "has it finished"
     compares against -- so it has to be there even with nothing to play. */
  it('always ends with the length of the whole run', () => {
    const offsets = timeline(2, [400, 600])
    expect(offsets[offsets.length - 1]).toBe(1000)
    expect(timeline(0, [])).toEqual([0])
  })

  it('falls back to a uniform step for a missing or nonsense duration', () => {
    const [, first, second, third] = timeline(3, [undefined, -50, NaN])
    expect(first).toBe(second - first)
    expect(second - first).toBe(third - second)
  })
})

describe('tickAt', () => {
  const offsets = timeline(3, [1000, 500, 1000]) // [0, 1000, 1500, 2500]

  it('shows the first beat from the very first millisecond', () => {
    /* Not tick -1. This is the fix: the run used to spend the first beat's worth of time showing
       nothing at all, so the event's arrival at the start component was never drawn. */
    expect(tickAt(offsets, 0, 3)).toBe(0)
  })

  it('gives every beat the span that begins at its own offset', () => {
    expect(tickAt(offsets, 999, 3)).toBe(0)
    expect(tickAt(offsets, 1000, 3)).toBe(1)
    expect(tickAt(offsets, 1499, 3)).toBe(1)
    expect(tickAt(offsets, 1500, 3)).toBe(2)
  })

  /* The last beat gets its full duration rather than being reached at the instant playback stops,
     which is what made a run appear to end one component early. */
  it('holds the last beat for its whole duration', () => {
    expect(tickAt(offsets, 2499, 3)).toBe(2)
    expect(tickAt(offsets, 2500, 3)).toBe(2)
    expect(tickAt(offsets, 99999, 3)).toBe(2)
  })

  it('is -1 before the run has started', () => {
    expect(tickAt(offsets, -1, 3)).toBe(-1)
    expect(tickAt(offsets, NaN, 3)).toBe(-1)
  })

  it('is -1 when there is nothing to play', () => {
    expect(tickAt([0], 0, 0)).toBe(-1)
  })
})
