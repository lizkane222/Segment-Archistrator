/*
 * What order a fork's arms are taken in.
 *
 * Two properties carry most of the weight here. Absent means "all at once", so a scenario that has
 * never touched this must produce `null` and leave the walk exactly as it was -- the field is inert
 * until someone uses it. And a stored order outlives the diagram it was recorded against, so a
 * connector added or deleted since must not lose an arm or leave a hole.
 */

import { describe, expect, it } from 'vitest'

import {
  moveBranch,
  sequenceBranches,
  sequenceOf,
  sequenced,
  unsequenceBranches,
} from './branches.js'

const CHILDREN = ['a', 'b', 'c']

describe('sequenceOf', () => {
  it('is null when this path has said nothing about the fork', () => {
    /* Null and not the child list: "all at once" is a different answer from "in this order", and the
       scheduler branches on exactly this. */
    expect(sequenceOf({}, 'fork', CHILDREN)).toBeNull()
    expect(sequenceOf(undefined, 'fork', CHILDREN)).toBeNull()
    expect(sequenceOf({ other: ['x'] }, 'fork', CHILDREN)).toBeNull()
  })

  it('is null for an order that was emptied rather than removed', () => {
    expect(sequenceOf({ fork: [] }, 'fork', CHILDREN)).toBeNull()
  })

  it('gives the stored order back', () => {
    expect(sequenceOf({ fork: ['c', 'a', 'b'] }, 'fork', CHILDREN)).toEqual(['c', 'a', 'b'])
  })

  /* A connector drawn since the order was recorded. Appended rather than dropped -- an arm missing
     from the path because it was added late is a path that silently stops describing the diagram. */
  it('appends a child the order has never heard of', () => {
    expect(sequenceOf({ fork: ['c', 'a'] }, 'fork', CHILDREN)).toEqual(['c', 'a', 'b'])
  })

  it('keeps the walk order among the children it appends', () => {
    expect(sequenceOf({ fork: ['c'] }, 'fork', ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })

  /* A connector deleted or turned round since. Dropped rather than left in, or the order carries an
     arm the walk will never produce and every later index is off by one. */
  it('drops a stored id that is no longer a child', () => {
    expect(sequenceOf({ fork: ['gone', 'b', 'a'] }, 'fork', ['a', 'b'])).toEqual(['b', 'a'])
  })
})

describe('sequenced', () => {
  it('is true only for a fork with a real order on it', () => {
    expect(sequenced({ fork: ['a', 'b'] }, 'fork')).toBe(true)
    expect(sequenced({ fork: [] }, 'fork')).toBe(false)
    expect(sequenced({}, 'fork')).toBe(false)
    expect(sequenced(null, 'fork')).toBe(false)
  })
})

describe('moveBranch', () => {
  /* Moving an arm is also what starts a sequence: ordering arms that play at the same instant is not
     something anyone can mean, so the first move writes the whole order out. */
  it('starts a sequence from an unordered fork', () => {
    expect(moveBranch({}, 'fork', 'c', -1, CHILDREN)).toEqual({ fork: ['a', 'c', 'b'] })
  })

  it('moves later', () => {
    expect(moveBranch({ fork: ['a', 'b', 'c'] }, 'fork', 'a', 1, CHILDREN).fork).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('moves earlier', () => {
    expect(moveBranch({ fork: ['a', 'b', 'c'] }, 'fork', 'c', -1, CHILDREN).fork).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  /* Unchanged rather than clamped, so the end-of-list button is a no-op the editor can also render as
     disabled -- and a click that changed nothing does not mark the document dirty. */
  it('returns the map untouched at either end', () => {
    const at = { fork: ['a', 'b', 'c'] }
    expect(moveBranch(at, 'fork', 'a', -1, CHILDREN)).toBe(at)
    expect(moveBranch(at, 'fork', 'c', 1, CHILDREN)).toBe(at)
  })

  it('returns the map untouched for a child that is not there', () => {
    const at = { fork: ['a', 'b'] }
    expect(moveBranch(at, 'fork', 'nope', 1, ['a', 'b'])).toBe(at)
  })

  it('never mutates what it was given', () => {
    const at = { fork: ['a', 'b', 'c'] }
    const next = moveBranch(at, 'fork', 'a', 1, CHILDREN)
    expect(at.fork).toEqual(['a', 'b', 'c'])
    expect(next).not.toBe(at)
  })

  it('leaves other forks alone', () => {
    const next = moveBranch({ other: ['x', 'y'] }, 'fork', 'b', -1, CHILDREN)
    expect(next.other).toEqual(['x', 'y'])
  })
})

describe('sequenceBranches', () => {
  it('sequences without reordering', () => {
    expect(sequenceBranches({}, 'fork', CHILDREN)).toEqual({ fork: ['a', 'b', 'c'] })
  })

  it('does nothing for a component with no arms', () => {
    expect(sequenceBranches({}, 'fork', [])).toEqual({})
  })
})

describe('unsequenceBranches', () => {
  /*
   * The key is removed, not emptied.
   *
   * Absent is what a path that never used this looks like, so undoing the setting has to return the
   * scenario to that shape -- otherwise `graphFingerprint` sees a new field and reports the document
   * as changed against its saved copy for a setting the reader has just taken back.
   */
  it('removes the key rather than emptying it', () => {
    const next = unsequenceBranches({ fork: ['a', 'b'], other: ['x'] }, 'fork')
    expect('fork' in next).toBe(false)
    expect(next).toEqual({ other: ['x'] })
  })

  it('returns the same map when there was nothing to remove', () => {
    const at = { other: ['x'] }
    expect(unsequenceBranches(at, 'fork')).toBe(at)
  })
})
