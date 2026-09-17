import { describe, expect, it } from 'vitest'

import { KEEP_ALIVE_MS, shouldPing } from './useSessionKeepAlive.js'

describe('shouldPing', () => {
  it('pings a visible tab holding unsaved work', () => {
    expect(shouldPing({ dirty: true, visible: true })).toBe(true)
  })

  /* A tab with nothing to lose is the case the twelve-hour window was chosen for, so it
     is left to expire on schedule rather than kept alive indefinitely. */
  it('does not ping when there is nothing unsaved', () => {
    expect(shouldPing({ dirty: false, visible: true })).toBe(false)
  })

  /* A hidden tab is not somebody working, and browsers throttle its timers anyway. */
  it('does not ping a hidden tab', () => {
    expect(shouldPing({ dirty: true, visible: false })).toBe(false)
  })

  it('treats absent flags as reasons not to ping', () => {
    expect(shouldPing({})).toBe(false)
  })
})

describe('KEEP_ALIVE_MS', () => {
  /* Comfortably inside the twelve-hour idle window, and not so short that an all-day
     session spends a request a minute keeping itself alive. */
  it('sits well inside the session window', () => {
    expect(KEEP_ALIVE_MS).toBeGreaterThan(60 * 1000)
    expect(KEEP_ALIVE_MS).toBeLessThan(12 * 60 * 60 * 1000)
  })
})
