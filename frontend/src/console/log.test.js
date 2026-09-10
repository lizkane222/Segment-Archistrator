import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  MAX_ENTRIES,
  alertCount,
  appendEntry,
  bySeverity,
  filterEntries,
  formatLogText,
  isBrowserNoise,
  levelCounts,
} from './log.js'

const entry = (message, level = 'info', at = 1_700_000_000_000, extra = {}) => ({
  id: message,
  level,
  message,
  at,
  source: 'app',
  ...extra,
})

const build = (...entries) => entries.reduce((list, item) => appendEntry(list, item), [])

describe('appendEntry', () => {
  it('appends in order', () => {
    const log = build(entry('first'), entry('second'))
    expect(log.map((item) => item.message)).toEqual(['first', 'second'])
  })

  it('folds an immediate repeat into a count rather than a second row', () => {
    const log = build(entry('same'), entry('same'), entry('same'))
    expect(log).toHaveLength(1)
    expect(log[0].count).toBe(3)
  })

  it('keeps the later timestamp when it folds', () => {
    /* Otherwise a refusal repeated for ten minutes reports the moment it first
       happened, and the log says the canvas has been quiet since. */
    const log = build(entry('same', 'error', 1000), entry('same', 'error', 9000))
    expect(log[0].at).toBe(9000)
  })

  it('does not fold across a different message', () => {
    const log = build(entry('a'), entry('b'), entry('a'))
    expect(log.map((item) => item.message)).toEqual(['a', 'b', 'a'])
    expect(log.every((item) => item.count === 1)).toBe(true)
  })

  it('does not fold two levels that happen to share a message', () => {
    /* "Save failed" as a warning and as an error are different events, and folding
       them would hide the escalation. */
    const log = build(entry('Save failed', 'warning'), entry('Save failed', 'error'))
    expect(log).toHaveLength(2)
  })

  it('drops the oldest entry rather than the newest at the cap', () => {
    const log = Array.from({ length: 5 }, (_, index) => entry(`m${index}`)).reduce(
      (list, item) => appendEntry(list, item, { max: 3 }),
      [],
    )
    expect(log.map((item) => item.message)).toEqual(['m2', 'm3', 'm4'])
  })

  it('caps at MAX_ENTRIES by default', () => {
    const log = Array.from({ length: MAX_ENTRIES + 20 }, (_, index) => entry(`m${index}`)).reduce(
      (list, item) => appendEntry(list, item),
      [],
    )
    expect(log).toHaveLength(MAX_ENTRIES)
    expect(log[log.length - 1].message).toBe(`m${MAX_ENTRIES + 19}`)
  })

  it('treats a null log as empty', () => {
    expect(appendEntry(null, entry('first'))).toHaveLength(1)
  })
})

describe('isBrowserNoise', () => {
  it('recognises the ResizeObserver notification in both of its wordings', () => {
    expect(isBrowserNoise('ResizeObserver loop completed with undelivered notifications.')).toBe(
      true,
    )
    expect(isBrowserNoise('ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('recognises it however the browser prefixes it', () => {
    /* Some browsers hand the window handler the message with an `Uncaught Error: ` in
       front of it and some do not, which is why the match is not an equality. */
    expect(isBrowserNoise('resizeobserver loop limit exceeded')).toBe(true)
  })

  it('does not swallow a real error that merely mentions a ResizeObserver', () => {
    /* The hazard of filtering by message: this list has to stay a list of *specific*
       browser notifications, not a keyword. A failure inside our own observer callback
       is a bug and has to reach the drawer. */
    expect(isBrowserNoise('Cannot read properties of null (reading "ResizeObserver")')).toBe(false)
    expect(isBrowserNoise('ResizeObserver is not defined')).toBe(false)
  })

  it('is false for an ordinary error and for nothing at all', () => {
    expect(isBrowserNoise('Save failed')).toBe(false)
    expect(isBrowserNoise('')).toBe(false)
    expect(isBrowserNoise(null)).toBe(false)
    expect(isBrowserNoise(undefined)).toBe(false)
  })
})

describe('the wiring into the window listener', () => {
  /*
   * `useConsoleLog` is a hook and there is no jsdom in this project, so the only way to
   * pin that the predicate is actually consulted is to read the source. Without this the
   * filter could be exported, fully tested, and called from nowhere -- and the symptom
   * would be the thing it was written to fix, still happening.
   */
  const hook = readFileSync(new URL('./useConsoleLog.js', import.meta.url), 'utf8')

  it('consults it in the window error handler', () => {
    const start = hook.indexOf('const onError =')
    const end = hook.indexOf('const onRejection =')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(hook.slice(start, end)).toContain('isBrowserNoise')
  })

  it('leaves the console.error wrapper alone', () => {
    /* Deliberate asymmetry, and asserted so it cannot be "tidied" into one place: a
       ResizeObserver message we log ourselves is a message, not the browser's noise. */
    const start = hook.indexOf('const forward =')
    const end = hook.indexOf('const onError =')
    expect(hook.slice(start, end)).not.toContain('isBrowserNoise')
  })
})

describe('levelCounts', () => {
  it('counts folded repeats as the number of occurrences', () => {
    /* One row, three events. A count of 1 here would let three failures read as one
       in the badge. */
    const log = build(entry('boom', 'error'), entry('boom', 'error'))
    expect(levelCounts(log).error).toBe(2)
  })

  it('ignores a level it does not know', () => {
    expect(levelCounts([entry('x', 'debug')])).toEqual({
      error: 0,
      warning: 0,
      success: 0,
      info: 0,
    })
  })
})

describe('alertCount', () => {
  it('counts only what went wrong', () => {
    const log = build(
      entry('ok', 'success'),
      entry('fyi', 'info'),
      entry('careful', 'warning'),
      entry('boom', 'error'),
    )
    expect(alertCount(log)).toBe(2)
  })

  it('is zero for a log of nothing but good news', () => {
    expect(alertCount(build(entry('saved', 'success'), entry('copied', 'success')))).toBe(0)
  })
})

describe('filterEntries', () => {
  const log = build(entry('a', 'error'), entry('b', 'info'), entry('c', 'error'))

  it('returns everything for all', () => {
    expect(filterEntries(log, 'all')).toHaveLength(3)
    expect(filterEntries(log, null)).toHaveLength(3)
  })

  it('returns one level', () => {
    expect(filterEntries(log, 'error').map((item) => item.message)).toEqual(['a', 'c'])
  })
})

describe('bySeverity', () => {
  it('puts errors first and leaves the order within a level alone', () => {
    const log = build(
      entry('i1', 'info'),
      entry('w1', 'warning'),
      entry('e1', 'error'),
      entry('i2', 'info'),
    )
    expect(bySeverity(log).map((item) => item.message)).toEqual(['e1', 'w1', 'i1', 'i2'])
  })

  it('does not mutate the log it was given', () => {
    const log = build(entry('i', 'info'), entry('e', 'error'))
    bySeverity(log)
    expect(log.map((item) => item.message)).toEqual(['i', 'e'])
  })
})

describe('formatLogText', () => {
  it('writes one line per entry with an ISO stamp', () => {
    const text = formatLogText([entry('Copied 3 components', 'success', 1_700_000_000_000)])
    expect(text).toBe('2023-11-14T22:13:20.000Z SUCCESS [app] Copied 3 components')
  })

  it('marks a folded repeat', () => {
    const log = build(entry('same', 'error'), entry('same', 'error'))
    expect(formatLogText(log)).toContain('(x2)')
  })

  it('indents a detail block so a stack trace stays readable', () => {
    const text = formatLogText([entry('Boom', 'error', 1_700_000_000_000, { detail: 'a\nb' })])
    expect(text).toContain('\n    a\n    b')
  })

  it('is empty for an empty log rather than a stray newline', () => {
    expect(formatLogText([])).toBe('')
  })
})
