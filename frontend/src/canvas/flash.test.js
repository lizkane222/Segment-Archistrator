/*
 * The store behind "which component is this message about?".
 *
 * Tested through injected timers rather than fake ones, because what is worth
 * asserting here is not that setTimeout works -- it is the bookkeeping around
 * re-flashing a component that is already flashing, which is where a leaked timer
 * would end a pulse early.
 */

import { describe, expect, it, vi } from 'vitest'

import { createFlash } from './flash.js'

/** A hand-driven clock, so a test can say exactly when a pulse ends. */
function clock() {
  let next = 1
  const pending = new Map()
  return {
    schedule: (fn) => {
      const id = next++
      pending.set(id, fn)
      return id
    },
    cancel: (id) => pending.delete(id),
    /** Fire every timer still outstanding. */
    run: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    },
    outstanding: () => pending.size,
  }
}

const store = (timers) => createFlash({ duration: 100, schedule: timers.schedule, cancel: timers.cancel })

describe('createFlash', () => {
  it('starts out flashing nothing', () => {
    const flash = store(clock())
    expect(flash.flashing('a')).toBe(false)
  })

  it('flashes the ids it is given and not the others', () => {
    const flash = store(clock())
    flash.flash(['a', 'b'])
    expect(flash.flashing('a')).toBe(true)
    expect(flash.flashing('b')).toBe(true)
    expect(flash.flashing('c')).toBe(false)
  })

  it('takes a bare id as well as a list', () => {
    const flash = store(clock())
    flash.flash('a')
    expect(flash.flashing('a')).toBe(true)
  })

  it('stops when the timer fires', () => {
    const timers = clock()
    const flash = store(timers)
    flash.flash(['a'])
    timers.run()
    expect(flash.flashing('a')).toBe(false)
  })

  it('drops nulls rather than flashing them', () => {
    /* The caller zips messages against ids, and the truncation line -- "...and 4
       more." -- has no id on purpose: it stands for several components, so pointing at
       one of them would be worse than pointing at none. */
    const timers = clock()
    const flash = store(timers)
    flash.flash([null, 'a', undefined])
    expect(flash.flashing('a')).toBe(true)
    expect(flash.flashing(null)).toBe(false)
    expect(timers.outstanding()).toBe(1)
  })

  it('never reports a null id as flashing, even with nothing scheduled', () => {
    const flash = store(clock())
    expect(flash.flashing(null)).toBe(false)
    expect(flash.flashing(undefined)).toBe(false)
  })

  it('restarts a component that is already flashing rather than leaving two timers', () => {
    /* The bug this guards: the first timer firing would end the second pulse early, so
       a component complained about twice would flash for less time than one complained
       about once. */
    const timers = clock()
    const flash = store(timers)
    flash.flash(['a'])
    flash.flash(['a'])
    expect(timers.outstanding()).toBe(1)
    expect(flash.flashing('a')).toBe(true)
  })

  it('notifies subscribers when a pulse starts and when it ends', () => {
    const timers = clock()
    const flash = store(timers)
    const listener = vi.fn()
    flash.subscribe(listener)

    flash.flash(['a'])
    expect(listener).toHaveBeenCalledTimes(1)
    timers.run()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('says nothing when asked to flash an empty list', () => {
    /* Every save with no advice at all goes through here, and a store change on each
       one would re-render every node on the canvas for no reason. */
    const flash = store(clock())
    const listener = vi.fn()
    flash.subscribe(listener)
    flash.flash([])
    flash.flash([null])
    expect(listener).not.toHaveBeenCalled()
  })

  it('clears everything at once, cancelling the timers', () => {
    const timers = clock()
    const flash = store(timers)
    flash.flash(['a', 'b'])
    flash.clear()
    expect(flash.flashing('a')).toBe(false)
    expect(timers.outstanding()).toBe(0)
  })

  it('says nothing when cleared with nothing flashing', () => {
    const flash = store(clock())
    const listener = vi.fn()
    flash.subscribe(listener)
    flash.clear()
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying an unsubscribed listener', () => {
    const flash = store(clock())
    const listener = vi.fn()
    flash.subscribe(listener)()
    flash.flash(['a'])
    expect(listener).not.toHaveBeenCalled()
  })
})
