import { describe, expect, it } from 'vitest'

import { editTargets, shared } from './multiEdit.js'

describe('which ids an edit reaches', () => {
  it('reaches the whole selection when the inspected item is part of it', () => {
    expect(editTargets(['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c'])
  })

  it('reaches only the inspected item when it is not part of the selection', () => {
    expect(editTargets(['a', 'b'], 'z')).toEqual(['z'])
  })

  it('reaches only the inspected item when it is the only thing selected', () => {
    expect(editTargets(['a'], 'a')).toEqual(['a'])
  })

  it('reaches the selection when nothing is inspected', () => {
    expect(editTargets(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  it('reaches nothing when nothing is selected or inspected', () => {
    expect(editTargets([], null)).toEqual([])
    expect(editTargets(undefined, undefined)).toEqual([])
  })
})

describe('what to show when items disagree', () => {
  const edges = [{ pattern: 'solid' }, { pattern: 'solid' }, { pattern: 'solid' }]

  it('shows the common value when everything agrees', () => {
    expect(shared(edges, (e) => e.pattern)).toEqual({ mixed: false, value: 'solid' })
  })

  it('says mixed when one differs', () => {
    expect(shared([...edges, { pattern: 'dashed' }], (e) => e.pattern)).toEqual({
      mixed: true,
      value: undefined,
    })
  })

  it('treats a missing value the same as every other missing value', () => {
    expect(shared([{}, {}], (e) => e.pattern ?? 'solid')).toEqual({ mixed: false, value: 'solid' })
    expect(shared([{}, { pattern: 'solid' }], (e) => e.pattern ?? 'solid').mixed).toBe(false)
  })

  it('compares objects by content', () => {
    const a = { waypoints: [{ x: 1, y: 2 }] }
    const b = { waypoints: [{ x: 1, y: 2 }] }
    expect(shared([a, b], (e) => e.waypoints).mixed).toBe(false)
  })

  it('has no opinion about an empty group', () => {
    expect(shared([], (e) => e.pattern).mixed).toBe(false)
  })
})
