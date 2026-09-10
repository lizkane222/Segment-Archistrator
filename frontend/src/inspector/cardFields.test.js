/*
 * Which fields a card prints.
 *
 * Two properties carry this file, and both are about a diagram not changing under the user:
 *
 *  - **An untouched document stores nothing.** `showFields` only ever holds explicit decisions, and a
 *    field switched off and back on again must leave the document byte-identical. Get this wrong and
 *    every diagram anyone has opened differs from its saved copy by an empty object, and the
 *    unsaved-changes dot lights up for nothing.
 *  - **"Off" and "absent" are different questions.** The eye can be on for a field the component does
 *    not have. The inspector needs to tell those apart; the card must draw neither.
 */

import { describe, expect, it } from 'vitest'

import {
  CARD_FIELDS,
  cardField,
  fieldShown,
  toggleField,
  visibleCardFields,
} from './cardFields.js'

const source = (extra = {}) => ({
  kind: 'source',
  kindLabel: 'Source',
  name: 'Web',
  description: 'The marketing site',
  sourceType: 'javascript',
  zone: 'connections',
  ...extra,
})

describe('the table', () => {
  it('gives every field an id, a label, a default and a reader', () => {
    for (const field of CARD_FIELDS) {
      expect(typeof field.id, field.id).toBe('string')
      expect(field.label, field.id).toBeTruthy()
      expect(typeof field.defaultOn, field.id).toBe('boolean')
      expect(typeof field.read, field.id).toBe('function')
    }
  })

  it('has no duplicate ids', () => {
    const ids = CARD_FIELDS.map((field) => field.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not offer the name, which is the card title and always drawn', () => {
    /* A card with no label is not a component, it is a rectangle. */
    expect(cardField('name')).toBeNull()
  })

  it('does not offer the write key', () => {
    /* `WriteKeyRow` reveals a real credential on a timer and writes an audit row. A checkbox that
       could print one onto a diagram destined for a PDF is not a feature. */
    for (const field of CARD_FIELDS) {
      expect(field.id.toLowerCase(), field.id).not.toContain('writekey')
    }
  })

  it('defaults everything on except the zone', () => {
    /* Asked for directly. Zone is the exception because the card is drawn *inside* its zone, so the
       name repeats what the position already says. */
    const off = CARD_FIELDS.filter((field) => !field.defaultOn).map((field) => field.id)
    expect(off).toEqual(['zone'])
  })
})

describe('fieldShown', () => {
  it('follows the table when nothing is stored', () => {
    expect(fieldShown(source(), 'description')).toBe(true)
    expect(fieldShown(source(), 'zone')).toBe(false)
  })

  it('follows an explicit override either way', () => {
    expect(fieldShown(source({ showFields: { zone: true } }), 'zone')).toBe(true)
    expect(fieldShown(source({ showFields: { description: false } }), 'description')).toBe(false)
  })

  it('ignores a stored value that is not a boolean', () => {
    /* Hand-edited documents happen. A truthy string must not be read as "on" by accident, because
       the round trip through `toggleField` would then never be able to clear it. */
    expect(fieldShown(source({ showFields: { zone: 'yes' } }), 'zone')).toBe(false)
    expect(fieldShown(source({ showFields: { description: 0 } }), 'description')).toBe(true)
  })

  it('says no for a field it has never heard of', () => {
    expect(fieldShown(source(), 'nonsense')).toBe(false)
  })

  it('survives being handed nothing', () => {
    expect(fieldShown(null, 'description')).toBe(true)
    expect(fieldShown(undefined, 'zone')).toBe(false)
  })
})

describe('toggleField', () => {
  it('stores only a decision that differs from the default', () => {
    expect(toggleField(source(), 'description', false)).toEqual({ description: false })
    expect(toggleField(source(), 'zone', true)).toEqual({ zone: true })
  })

  it('drops the key entirely when the last override goes back to its default', () => {
    /* The property that keeps a saved diagram from reading as dirty after a look-and-undo. */
    const shown = toggleField(source(), 'zone', true)
    const data = source({ showFields: shown })
    expect(toggleField(data, 'zone', false)).toBeUndefined()
  })

  it('keeps the other overrides when one is cleared', () => {
    const data = source({ showFields: { zone: true, description: false } })
    expect(toggleField(data, 'zone', false)).toEqual({ description: false })
  })

  it('round-trips to nothing', () => {
    /* Off, on, off again -- and the document is exactly as it started, not carrying an empty object. */
    let data = source()
    data = { ...data, showFields: toggleField(data, 'description', false) }
    expect(data.showFields).toEqual({ description: false })
    data = { ...data, showFields: toggleField(data, 'description', true) }
    expect(data.showFields).toBeUndefined()
  })

  it('never mutates what it was given', () => {
    const stored = { zone: true }
    const data = source({ showFields: stored })
    toggleField(data, 'description', false)
    expect(stored).toEqual({ zone: true })
  })

  it('leaves the overrides alone for a field it does not know', () => {
    const data = source({ showFields: { zone: true } })
    expect(toggleField(data, 'nonsense', true)).toEqual({ zone: true })
  })
})

describe('what a card prints', () => {
  it('prints the description, which is what the request was about', () => {
    const rows = visibleCardFields(source())
    expect(rows.find((row) => row.id === 'description')?.value).toBe('The marketing site')
  })

  it('leaves the zone off until it is asked for', () => {
    expect(visibleCardFields(source()).some((row) => row.id === 'zone')).toBe(false)
    const shown = visibleCardFields(source({ showFields: { zone: true } }))
    expect(shown.find((row) => row.id === 'zone')?.value).toBe('connections')
  })

  it('prints nothing for a field the component does not have', () => {
    /* The eye is on for Cadence by default, and a source has no cadence. A row reading
       "Cadence: not set" on a drawing is worse than no row -- "not set" is worth saying in the
       inspector, next to the field that would set it. */
    const rows = visibleCardFields(source())
    expect(rows.some((row) => row.id === 'computeCadence')).toBe(false)
    expect(rows.some((row) => row.id === 'deployedAt')).toBe(false)
  })

  it('treats an empty string as absent', () => {
    /* Real in a hand-edited document, and the reason `read` trims. */
    expect(visibleCardFields(source({ description: '   ' })).some((r) => r.id === 'description')).toBe(
      false,
    )
  })

  it('keeps the table order, so two cards read the same way', () => {
    const rows = visibleCardFields(source({ showFields: { zone: true } }))
    const order = rows.map((row) => row.id)
    const expected = CARD_FIELDS.filter((field) => order.includes(field.id)).map((f) => f.id)
    expect(order).toEqual(expected)
  })

  it('only mentions the Segment name when it differs', () => {
    /* "Name in Segment: Web" under a card titled "Web" is a row that says nothing. */
    expect(
      visibleCardFields(source({ segmentName: 'Web' })).some((r) => r.id === 'segmentName'),
    ).toBe(false)
    expect(
      visibleCardFields(source({ segmentName: 'Website (JS)' })).find((r) => r.id === 'segmentName')
        ?.value,
    ).toBe('Website (JS)')
  })

  it('only mentions Enabled when the component is disabled', () => {
    /* Every enabled component is enabled, so saying it on all forty cards is noise -- whereas one
       disabled destination is exactly what a reader is hunting for. */
    expect(visibleCardFields(source()).some((r) => r.id === 'enabled')).toBe(false)
    expect(
      visibleCardFields(source({ enabled: false })).find((r) => r.id === 'enabled')?.value,
    ).toMatch(/disabled/i)
  })

  it('joins categories into one row', () => {
    expect(
      visibleCardFields(source({ categories: ['Email', 'CRM'] })).find((r) => r.id === 'categories')
        ?.value,
    ).toBe('Email, CRM')
  })

  it('answers nothing for nothing', () => {
    expect(visibleCardFields(null)).toEqual([])
    expect(visibleCardFields({})).toEqual([])
  })
})
