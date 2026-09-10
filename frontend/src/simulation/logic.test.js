/*
 * The three-valued kernel.
 *
 * These tests are mostly the Kleene tables, which look tedious written out but are
 * the thing every verdict in the simulator rests on. The two that matter most are
 * `FALSE AND UNKNOWN = FALSE` and `TRUE OR UNKNOWN = TRUE`: without them a single
 * unreadable clause in an audience definition would make the whole verdict
 * unknown, and most real definitions contain at least one.
 */

import { describe, expect, it } from 'vitest'

import {
  FALSE,
  HISTORY,
  TRUE,
  UNKNOWN,
  UNSUPPORTED,
  and,
  dependsOnHistory,
  dominantCause,
  explain,
  no,
  not,
  notSupported,
  or,
  yes,
} from './logic.js'

describe('and', () => {
  it('is TRUE only when every operand is TRUE', () => {
    expect(and([yes(), yes()]).value).toBe(TRUE)
  })

  it('is FALSE when any operand is FALSE, even alongside an unknown', () => {
    expect(and([no(), dependsOnHistory('x')]).value).toBe(FALSE)
    expect(and([dependsOnHistory('x'), no()]).value).toBe(FALSE)
  })

  it('is UNKNOWN when nothing is FALSE but something is unknown', () => {
    expect(and([yes(), dependsOnHistory('x')]).value).toBe(UNKNOWN)
  })

  it('drops the reasons of unknowns that did not influence a FALSE result', () => {
    const verdict = and([no(), dependsOnHistory('should not be quoted')])
    expect(verdict.reasons).toEqual([])
  })
})

describe('or', () => {
  it('is TRUE when any operand is TRUE, even alongside an unknown', () => {
    expect(or([no(), yes()]).value).toBe(TRUE)
    expect(or([dependsOnHistory('x'), yes()]).value).toBe(TRUE)
  })

  it('is FALSE only when every operand is FALSE', () => {
    expect(or([no(), no()]).value).toBe(FALSE)
  })

  it('is UNKNOWN when the best any operand offers is unknown', () => {
    expect(or([no(), dependsOnHistory('x')]).value).toBe(UNKNOWN)
  })
})

describe('not', () => {
  it('swaps the definite values', () => {
    expect(not(yes()).value).toBe(FALSE)
    expect(not(no()).value).toBe(TRUE)
  })

  /* If NOT collapsed UNKNOWN to a definite value it would manufacture exactly the
     wrong verdicts the three-valued model exists to prevent. */
  it('leaves UNKNOWN unknown and keeps its reasons', () => {
    const negated = not(dependsOnHistory('needs history'))
    expect(negated.value).toBe(UNKNOWN)
    expect(explain(negated)).toEqual(['needs history'])
  })
})

describe('reason collection', () => {
  it('merges reasons across unknown operands without duplicating them', () => {
    const verdict = and([dependsOnHistory('same'), dependsOnHistory('same'), dependsOnHistory('other')])
    expect(explain(verdict)).toEqual(['same', 'other'])
  })
})

describe('dominantCause', () => {
  it('is null for a definite verdict', () => {
    expect(dominantCause(yes())).toBeNull()
  })

  it('reports history when that is all there is', () => {
    expect(dominantCause(dependsOnHistory('x'))).toBe(HISTORY)
  })

  /* Reporting "depends on profile history" for a query we could not parse would
     claim an understanding the interpreter does not have. */
  it('prefers unsupported over history when both are present', () => {
    const verdict = and([dependsOnHistory('x'), notSupported('y')])
    expect(dominantCause(verdict)).toBe(UNSUPPORTED)
  })
})
