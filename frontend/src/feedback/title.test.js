/*
 * The browser's copy of the title derivation.
 *
 * It exists only to *preview* how a report will be filed while the reporter is still typing. The
 * server's copy is the one that is stored, so a drift between them cannot corrupt a record -- but it
 * could show a preview that differs from what lands, which is a small lie in the one place the feature
 * is trying to build trust.
 *
 * So the last test in this file reads `apps/feedback/titles.py` and checks the two word lists against
 * each other. Same technique the registry tests use to check the command table against AppShell, and for
 * the same reason: two copies of a list in two languages will drift the first time one is edited alone.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MAX_TITLE, SKIPPED, TITLE_WORDS, problemTitle } from './title.js'

describe('problemTitle', () => {
  it('keeps five meaningful words', () => {
    expect(problemTitle('Connectors overlap badly when three arrive together')).toBe(
      'Connectors overlap badly when three',
    )
  })

  it('spends the five slots on words that carry meaning', () => {
    /* The reading this implements: walk the description skipping the small words until five are kept,
       rather than taking five and then dropping some. "the event in the debugger is not shown" has four
       skipped words among its first five, so the other reading yields two words from a nine-word
       sentence. */
    expect(problemTitle('the event in the debugger is not shown')).toBe('event debugger is not shown')
  })

  it('keeps a word that merely starts with a skipped one', () => {
    /* `information` is not `in`; `attachment` is not `at`. A prefix match would eat both. */
    expect(problemTitle('information attachment ordering interface onboarding')).toBe(
      'information attachment ordering interface onboarding',
    )
  })

  it('keeps contractions, hyphenated words and identifiers whole', () => {
    expect(problemTitle("side-by-side doesn't resize the divider")).toBe(
      "side-by-side doesn't resize divider",
    )
    expect(problemTitle('data.paths and sql_table disagree about column order')).toBe(
      'data.paths and sql_table disagree column',
    )
  })

  it('drops punctuation between words', () => {
    expect(problemTitle("canvas: the zones don't dim")).toBe("canvas zones don't dim")
  })

  it('ignores case when deciding whether a word is skipped', () => {
    expect(problemTitle('The Zones In The Canvas Flicker')).toBe('Zones Canvas Flicker')
  })

  it('takes five and not six', () => {
    expect(problemTitle('one two three four five six seven').split(' ')).toHaveLength(TITLE_WORDS)
  })

  it('still gives a title when every word is a skipped one', () => {
    /* "in the on" is a thing a person types. A blank title on a record nobody can find is worse. */
    expect(problemTitle('in the on')).toBe('in the on')
  })

  it('labels an empty or wordless description', () => {
    for (const value of ['', '   ', null, undefined, '!!! ???', '😀']) {
      expect(problemTitle(value), String(value)).toBe('Untitled feedback')
    }
  })

  it('cuts a very long title on a word boundary', () => {
    const title = problemTitle(Array.from({ length: 5 }, () => 'supercalifragilistic'.repeat(2)).join(' '))
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE + 1)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/ …$/)
  })
})

describe('the two copies agree', () => {
  /* Read from the Python rather than duplicated here, so this test fails when one list is edited
     without the other -- which is the only way the preview and the record can come to disagree. */
  const python = readFileSync(new URL('../../../apps/feedback/titles.py', import.meta.url), 'utf8')

  const wordsIn = (name) => {
    const block = python.match(new RegExp(`${name} = \\{([^}]*)\\}`))
    if (!block) throw new Error(`could not find ${name} in titles.py`)
    return new Set([...block[1].matchAll(/"([a-z']+)"/g)].map((match) => match[1]))
  }

  it('skips exactly the same words', () => {
    const fromPython = new Set([...wordsIn('_ARTICLES'), ...wordsIn('_PREPOSITIONS')])
    /* Both directions, so neither file can quietly gain a word the other does not have. */
    expect([...fromPython].filter((word) => !SKIPPED.has(word))).toEqual([])
    expect([...SKIPPED].filter((word) => !fromPython.has(word))).toEqual([])
  })

  it('keeps the same number of words and the same length cap', () => {
    expect(python).toMatch(new RegExp(`TITLE_WORDS = ${TITLE_WORDS}\\b`))
    expect(python).toMatch(new RegExp(`MAX_TITLE = ${MAX_TITLE}\\b`))
  })
})
