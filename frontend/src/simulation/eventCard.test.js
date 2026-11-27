import { describe, expect, it } from 'vitest'

import {
  flattenPayload,
  payloadAtAnchor,
  previewCardData,
  shownRows,
  toggleField,
  valueAt,
} from './eventCard.js'

const payload = {
  type: 'track',
  event: 'Order Completed',
  properties: { total: 42, items: [{ sku: 'a' }, { sku: 'b' }], empty: {} },
}

describe('flattenPayload', () => {
  it('lists every key:value leaf by path, in order', () => {
    expect(flattenPayload(payload).map((row) => row.path)).toEqual([
      'type',
      'event',
      'properties.total',
      'properties.items[0].sku',
      'properties.items[1].sku',
      'properties.empty',
    ])
  })
  it('reads a value back by its path', () => {
    expect(valueAt(payload, 'properties.items[1].sku')).toBe('b')
    expect(valueAt(payload, 'properties.nope.deeper')).toBeUndefined()
  })
})

describe('card order', () => {
  it('lists type, event, user id, anonymous id, then properties, traits and context', () => {
    const shuffled = {
      context: { ip: '1.2.3.4' },
      traits: { plan: 'pro' },
      properties: { total: 1 },
      anonymousId: 'anon',
      other: 'x',
      user_id: 'u',
      event: 'E',
      type: 'track',
    }
    expect(flattenPayload(shuffled).map((row) => row.path)).toEqual([
      'type',
      'event',
      'user_id',
      'anonymousId',
      'properties.total',
      'traits.plan',
      'context.ip',
      'other',
    ])
  })
})

describe('shownRows', () => {
  it('shows nothing by default and only the chosen paths otherwise', () => {
    expect(shownRows(payload, [])).toEqual([])
    expect(shownRows(payload, ['properties.total', 'event']).map((row) => row.path)).toEqual(['event', 'properties.total'])
  })
  it('toggles a path on and off without touching the others', () => {
    const on = toggleField(['a'], 'b')
    expect(on).toEqual(['a', 'b'])
    expect(toggleField(on, 'a')).toEqual(['b'])
  })
})

describe('payloadAtAnchor', () => {
  const trace = {
    event: { v: 1 },
    steps: [
      { nodeId: 'src', edgeId: null },
      { nodeId: 'fn', edgeId: 'e1', payload: { v: 2 } },
      { nodeId: 'dest', edgeId: 'e2' },
    ],
  }
  it('carries the payload forward to where it is asked for', () => {
    expect(payloadAtAnchor(trace, { type: 'node', id: 'src' })).toEqual({ v: 1 })
    expect(payloadAtAnchor(trace, { type: 'node', id: 'dest' })).toEqual({ v: 2 })
    expect(payloadAtAnchor(trace, { type: 'edge', id: 'e1' })).toEqual({ v: 2 })
  })
  it('is null where the run never goes', () => {
    expect(payloadAtAnchor(trace, { type: 'node', id: 'elsewhere' })).toBeNull()
  })
  it('previews start with no fields shown', () => {
    expect(previewCardData({ scenarioId: 's', anchor: { type: 'node', id: 'x' } }).shownFields).toEqual([])
  })
})

describe('editing a payload by path', () => {
  it('replaces a nested value without touching the original', async () => {
    const { setValueAt } = await import('./eventCard.js')
    const original = { traits: { plan: 'free' }, items: [{ sku: 'a' }] }
    const next = setValueAt(original, 'traits.plan', 'pro')
    expect(next.traits.plan).toBe('pro')
    expect(original.traits.plan).toBe('free')
    expect(setValueAt(original, 'items[0].sku', 'b').items[0].sku).toBe('b')
  })
  it('adds a field, making the objects on the way', async () => {
    const { setValueAt } = await import('./eventCard.js')
    expect(setValueAt({}, 'context.traits.email', 'a@b.c')).toEqual({ context: { traits: { email: 'a@b.c' } } })
  })
  it('keeps the type of what was there where the new text allows', async () => {
    const { coerceLike } = await import('./eventCard.js')
    expect(coerceLike(42.5, '50')).toBe(50)
    expect(coerceLike(42.5, 'lots')).toBe('lots')
    expect(coerceLike('123', '456')).toBe('456')
    expect(coerceLike(true, 'false')).toBe(false)
    expect(coerceLike(null, '7')).toBe(7)
  })
})
