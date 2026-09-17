/*
 * `detectPaste`/`mergeSnapshot`/`classifyTraits` against the five sample shapes a
 * real Profile API call returns -- the pure logic behind ProfilePreview.jsx, which
 * cannot be rendered here (no jsdom in this project; see canvas/anchors.test.js).
 */

import { describe, expect, it } from 'vitest'

import {
  PROFILE_KIND_TEMPLATES,
  classifyTraits,
  detectPaste,
  emptySnapshot,
  groupJourneys,
  importPaste,
  linkedCollections,
  mergeSnapshot,
  profileIdentity,
} from './profileSnapshot.js'

const TRAITS_RESPONSE = {
  traits: {
    city: 'Jaycefurt',
    email: 'norma.huels74+356@hotmail.com',
    first_name_exists: true,
    order_completed_last_100_days: true,
  },
  cursor: { url: '', has_more: false, next: '', limit: 20 },
}

const EXTERNAL_IDS_RESPONSE = {
  data: [
    {
      id: '59132b24-7016-4285-555-820d5383e966',
      type: 'user_id',
      source_id: 'hEVYdnsuzJzSHePCCudz1Z',
      collection: 'users',
      created_at: '2025-08-15T23:02:24.486Z',
      encoding: 'none',
      first_message_id: 'api-31LMXfqhe93W1lfjqDaSGbrpKHc',
    },
  ],
  cursor: { url: '', has_more: false, next: '', limit: 20 },
}

const METADATA_RESPONSE = {
  segment_id: 'use_ygkOOmY7RxT89ozSqaL31LMY8O8',
  metadata: {
    created_at: '2025-08-15T23:02:24.481Z',
    updated_at: '2026-08-31T21:52:28.173Z',
    first_source_id: 'hEVYdnsuzJzSHePCCudz1Z',
  },
}

const EVENTS_RESPONSE = {
  data: [
    { event: 'Audience Entered', message_id: 'personas_1', properties: { audience_key: 'first_name_exists' } },
  ],
  cursor: { url: '', has_more: false, next: '', limit: 20 },
}

const LINKS_RESPONSE = {
  data: [
    {
      to_collection: 'accounts',
      external_ids: [{ id: '12345', type: 'group_id', source_id: 'tbXSniLEQZvSyzWmre9EPi', collection: 'accounts' }],
    },
  ],
  cursor: { url: '', has_more: false, next: '', limit: 20 },
}

describe('detectPaste', () => {
  it('recognises a traits response', () => {
    expect(detectPaste(TRAITS_RESPONSE)).toBe('traits')
  })

  it('recognises an external_ids response', () => {
    expect(detectPaste(EXTERNAL_IDS_RESPONSE)).toBe('external_ids')
  })

  it('recognises a metadata response', () => {
    expect(detectPaste(METADATA_RESPONSE)).toBe('metadata')
  })

  it('recognises an events response', () => {
    expect(detectPaste(EVENTS_RESPONSE)).toBe('events')
  })

  it('recognises a links response', () => {
    expect(detectPaste(LINKS_RESPONSE)).toBe('links')
  })

  it('rejects a non-object', () => {
    expect(() => detectPaste('just a string')).toThrow(/not a Profile API response/)
  })

  it('rejects a shape none of the five endpoints produce', () => {
    expect(() => detectPaste({ foo: 'bar' })).toThrow(/Unrecognized shape/)
  })

  it('rejects a data array with nothing in it', () => {
    expect(() => detectPaste({ data: [] })).toThrow(/no entries/)
  })
})

describe('mergeSnapshot', () => {
  it('fills in one section of an empty snapshot', () => {
    const next = mergeSnapshot(emptySnapshot(), 'traits', TRAITS_RESPONSE)
    expect(next.traits).toEqual(TRAITS_RESPONSE.traits)
    expect(next.identifiers).toEqual([])
    expect(next.importedAt).toBeTypeOf('number')
  })

  it('replaces only the section the paste is for, leaving the others alone', () => {
    const withTraits = mergeSnapshot(emptySnapshot(), 'traits', TRAITS_RESPONSE)
    const withBoth = mergeSnapshot(withTraits, 'external_ids', EXTERNAL_IDS_RESPONSE)
    expect(withBoth.traits).toEqual(TRAITS_RESPONSE.traits)
    expect(withBoth.identifiers).toEqual(EXTERNAL_IDS_RESPONSE.data)
  })

  it('replaces rather than appends on a second paste of the same endpoint', () => {
    const once = mergeSnapshot(emptySnapshot(), 'events', EVENTS_RESPONSE)
    const twice = mergeSnapshot(once, 'events', EVENTS_RESPONSE)
    expect(twice.events).toHaveLength(1)
  })
})

describe('importPaste', () => {
  it('parses, detects, and merges in one call', () => {
    const { kind, snapshot } = importPaste(emptySnapshot(), JSON.stringify(TRAITS_RESPONSE))
    expect(kind).toBe('traits')
    expect(snapshot.traits.city).toBe('Jaycefurt')
  })

  it('rejects invalid JSON without touching the existing snapshot', () => {
    expect(() => importPaste(emptySnapshot(), '{not json')).toThrow(/not valid JSON/)
  })
})

describe('classifyTraits', () => {
  const nodes = [
    { data: { kind: 'audience', audienceKey: 'first_name_exists' } },
    { data: { kind: 'computed_trait', traitKey: 'order_completed_last_100_days' } },
  ]

  it('matches an audience node by audienceKey', () => {
    const result = classifyTraits(TRAITS_RESPONSE.traits, nodes)
    expect(result.audiences.map((entry) => entry.key)).toEqual(['first_name_exists'])
  })

  it('matches a computed trait node by traitKey', () => {
    const result = classifyTraits(TRAITS_RESPONSE.traits, nodes)
    expect(result.computedTraits.map((entry) => entry.key)).toEqual(['order_completed_last_100_days'])
  })

  it('recognises a journey step trait even with no matching node', () => {
    const result = classifyTraits({ j_o_signup__welcome_ab12c: true }, [])
    expect(result.journeys).toEqual([
      { key: 'j_o_signup__welcome_ab12c', value: true, journey: 'signup', step: 'welcome' },
    ])
  })

  it('falls back to custom for anything nothing on the canvas can vouch for', () => {
    const result = classifyTraits(TRAITS_RESPONSE.traits, [])
    expect(result.custom.map((entry) => entry.key).sort()).toEqual(
      ['city', 'email', 'first_name_exists', 'order_completed_last_100_days'].sort(),
    )
    expect(result.audiences).toEqual([])
    expect(result.computedTraits).toEqual([])
  })
})

describe('groupJourneys', () => {
  it('groups steps under their journey slug', () => {
    const journeys = classifyTraits(
      {
        j_o_signup__welcome_ab12c: true,
        j_o_signup__activated_de34f: true,
        j_o_winback__offer_gh56i: true,
      },
      [],
    ).journeys
    const grouped = groupJourneys(journeys)
    expect(grouped).toHaveLength(2)
    const signup = grouped.find((entry) => entry.journey === 'signup')
    expect(signup.steps.map((step) => step.step).sort()).toEqual(['activated', 'welcome'])
  })
})

describe('linkedCollections', () => {
  it('groups link rows by to_collection', () => {
    const grouped = linkedCollections(LINKS_RESPONSE.data)
    expect(grouped).toEqual([{ collection: 'accounts', entries: LINKS_RESPONSE.data }])
  })
})

describe('PROFILE_KIND_TEMPLATES', () => {
  it.each(Object.keys(PROFILE_KIND_TEMPLATES))('the %s template round-trips through detectPaste', (kind) => {
    const parsed = JSON.parse(PROFILE_KIND_TEMPLATES[kind])
    expect(detectPaste(parsed)).toBe(kind)
  })
})

describe('profileIdentity', () => {
  it('prefers the email trait', () => {
    expect(profileIdentity({ traits: { email: 'a@b.com' }, identifiers: [{ type: 'user_id', id: 'u1' }] })).toEqual({
      label: 'Email',
      value: 'a@b.com',
    })
  })

  it('falls back to a user_id identifier when there is no email', () => {
    expect(
      profileIdentity({ traits: {}, identifiers: [{ type: 'anonymous_id', id: 'anon1' }, { type: 'user_id', id: 'u1' }] }),
    ).toEqual({ label: 'User ID', value: 'u1' })
  })

  it('falls back to any identifier when there is no user_id', () => {
    expect(profileIdentity({ traits: {}, identifiers: [{ type: 'anonymous_id', id: 'anon1' }] })).toEqual({
      label: 'anonymous_id',
      value: 'anon1',
    })
  })

  it('falls back to the profile metadata id when there are no identifiers', () => {
    expect(profileIdentity({ traits: {}, identifiers: [], metadata: { segment_id: 'seg1' } })).toEqual({
      label: 'Profile ID',
      value: 'seg1',
    })
  })

  it('returns null for an empty snapshot', () => {
    expect(profileIdentity(emptySnapshot())).toBeNull()
  })
})
