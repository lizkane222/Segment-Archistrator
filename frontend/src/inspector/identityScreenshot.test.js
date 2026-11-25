import { describe, expect, it } from 'vitest'

import fixture from './identityScreenshot.fixture.json'
import browserFixture from './identityScreenshot.browser.fixture.json'
import { cleanIdentifier, parseLimit, parseRuleTable } from './identityScreenshot.js'

describe('cleanIdentifier', () => {
  it('rejoins a name that OCR split where the underscore was', () => {
    expect(cleanIdentifier(['uncredentialed_member.', 'id'])).toBe('uncredentialed_member_id')
    expect(cleanIdentifier(['user', 'id'])).toBe('user_id')
  })
  it('keeps a dot inside a name and drops stray punctuation round it', () => {
    expect(cleanIdentifier(['android.id,'])).toBe('android.id')
    expect(cleanIdentifier(['-', 'rcs_identity_id', '°'])).toBe('rcs_identity_id')
  })
})

describe('parseLimit', () => {
  it('reads a count and its window', () => {
    expect(parseLimit(['5', 'weekly'])).toEqual({ limit: 5, frequency: 'Week' })
    expect(parseLimit(['10', 'weekly'])).toEqual({ limit: 10, frequency: 'Week' })
    expect(parseLimit(['3', 'Daily'])).toEqual({ limit: 3, frequency: 'Day' })
  })
  it('takes a bare number as ever, and nothing as unreadable', () => {
    expect(parseLimit(['1'])).toEqual({ limit: 1, frequency: 'Ever' })
    expect(parseLimit(['weekly'])).toBeNull()
  })
})

describe('parseRuleTable', () => {
  it('reads the settings page screenshot: priority, identifier, value limit', () => {
    const { rows } = parseRuleTable(fixture)
    expect(rows).toEqual([
      { externalId: 'user_id', limit: 1, frequency: 'Ever' },
      { externalId: 'uncredentialed_member_id', limit: 1, frequency: 'Ever' },
      { externalId: 'rcs_identity_id', limit: 1, frequency: 'Ever' },
      { externalId: 'client_visitor_id', limit: 5, frequency: 'Week' },
      { externalId: 'amaua_member_id', limit: 5, frequency: 'Week' },
      { externalId: 'edw_visitor_id', limit: 10, frequency: 'Week' },
      { externalId: 'upnest_visitor_id', limit: 10, frequency: 'Week' },
      { externalId: 'anonymous_id', limit: 10, frequency: 'Week' },
    ])
  })
  it('still finds every row when OCR drops a priority number (the "1" read as a bar)', () => {
    const { rows } = parseRuleTable(browserFixture)
    expect(rows.map((row) => row.externalId)).toEqual([
      'user_id',
      'uncredentialed_member_id',
      'rcs_identity_id',
      'client_visitor_id',
      'amaua_member_id',
      'edw_visitor_id',
      'upnest_visitor_id',
      'anonymous_id',
    ])
  })
  it('says so when the header is not in the picture', () => {
    expect(parseRuleTable([{ text: 'hello', x0: 0, y0: 0, x1: 5, y1: 5 }]).rows).toEqual([])
  })
})
