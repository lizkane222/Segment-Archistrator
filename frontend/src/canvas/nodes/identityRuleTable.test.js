/*
 * The identity resolution rule's rows.
 *
 * The rendering is not tested here (there is no DOM in this suite); what is worth
 * pinning is the normalisation, because these rows are transcribed by hand from a
 * workspace and every field can legitimately be missing.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_IDENTITY_RULES,
  formatLimit,
  identityRules,
} from './IdentityRuleTable.jsx'

describe('identityRules', () => {
  it('falls back to Segment’s own default priority when no rules are recorded', () => {
    /* Not an empty table: an empty one is indistinguishable from a component that has
       no table at all, so a diagram nobody has edited still says something true. */
    expect(identityRules({ kind: 'identity_setting' })).toEqual(DEFAULT_IDENTITY_RULES)
    expect(DEFAULT_IDENTITY_RULES.map((rule) => rule.externalId)).toEqual([
      'user_id',
      'email',
      'anonymous_id',
    ])
  })

  it('honours an explicitly empty list rather than restoring the defaults', () => {
    /* The distinction that matters: an author who deleted every row must not have the
       edit undone on the next reload. */
    expect(identityRules({ rules: [] })).toEqual([])
  })

  it('keeps the order it was given, because order is what priority means', () => {
    const rules = [{ externalId: 'email' }, { externalId: 'user_id' }]
    expect(identityRules({ rules }).map((rule) => rule.externalId)).toEqual(['email', 'user_id'])
  })

  it('does not store a priority number alongside the order', () => {
    /* Two answers to one question. The row's position is the priority. */
    for (const rule of identityRules({ rules: [{ externalId: 'a' }] })) {
      expect(rule.priority).toBeUndefined()
    }
  })

  it('fills a half-written row rather than dropping it', () => {
    expect(identityRules({ rules: [{ externalId: 'crm_id' }] })).toEqual([
      { externalId: 'crm_id', limit: null, frequency: 'Ever' },
    ])
  })

  it('tolerates a row that is not an object at all', () => {
    expect(identityRules({ rules: [null] })).toEqual([
      { externalId: '', limit: null, frequency: 'Ever' },
    ])
  })

  it('ignores a rules value that is not a list', () => {
    expect(identityRules({ rules: 'user_id' })).toEqual(DEFAULT_IDENTITY_RULES)
  })
})

describe('formatLimit', () => {
  it('reads as the UI writes it', () => {
    expect(formatLimit({ limit: 5, frequency: 'Ever' })).toBe('5 Ever')
    expect(formatLimit({ limit: 1, frequency: 'Day' })).toBe('1 Day')
  })

  it('defaults the window to Ever, which is Segment’s default', () => {
    expect(formatLimit({ limit: 3 })).toBe('3 Ever')
  })

  it('says “no limit” with a dash rather than printing a bare zero-ish value', () => {
    /* An unset limit is a real answer -- it means unlimited -- and must not render as
       "null Ever" or as an empty cell that looks like a rendering fault. */
    expect(formatLimit({ limit: null })).toBe('—')
    expect(formatLimit({ limit: undefined })).toBe('—')
    expect(formatLimit({ limit: '' })).toBe('—')
  })

  it('keeps a zero limit, which is not the same as no limit', () => {
    expect(formatLimit({ limit: 0, frequency: 'Ever' })).toBe('0 Ever')
  })
})
