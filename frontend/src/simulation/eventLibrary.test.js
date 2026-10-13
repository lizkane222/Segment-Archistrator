/*
 * The Events tab's library.
 *
 * The repair is the part worth the most attention: every payload the walkthrough runs from the Events
 * tab has gone through it, so a repair that changes a value the reader typed correctly -- a comma
 * inside a string, a URL's `https:` -- would be a simulator quietly running a different event.
 */

import { describe, expect, it } from 'vitest'

import {
  EVENT_TYPES,
  SPEC_EVENTS,
  highlightRuns,
  identifiersFrom,
  identityMatcher,
  normalizeEvent,
  prepareEvent,
  repairJson,
  savedFor,
  specEventsFor,
  specPayload,
  toggleSpec,
  withSaved,
  withoutSaved,
} from './eventLibrary.js'

describe('repairJson', () => {
  it('leaves valid JSON alone and reports no fixes', () => {
    expect(repairJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 }, fixes: [] })
  })

  it('removes trailing commas', () => {
    const result = repairJson('{"a": 1, "b": [1, 2,],}')
    expect(result.value).toEqual({ a: 1, b: [1, 2] })
    expect(result.fixes).toContain('Removed a trailing comma.')
  })

  it('quotes bare keys and converts single quotes', () => {
    const result = repairJson("{event: 'Order Completed', properties: {revenue: 42}}")
    expect(result.value).toEqual({ event: 'Order Completed', properties: { revenue: 42 } })
  })

  it('adds missing commas between fields', () => {
    expect(repairJson('{"a": 1\n "b": 2}').value).toEqual({ a: 1, b: 2 })
  })

  it('closes unclosed brackets and strings', () => {
    expect(repairJson('{"a": {"b": [1, 2').value).toEqual({ a: { b: [1, 2] } })
    expect(repairJson('{"a": "unterminated').value).toEqual({ a: 'unterminated' })
  })

  it('drops comments', () => {
    expect(repairJson('{\n // who\n "a": 1 /* one */\n}').value).toEqual({ a: 1 })
  })

  it('maps Python and JS literals', () => {
    expect(repairJson('{"a": True, "b": None, "c": undefined}').value).toEqual({ a: true, b: null, c: null })
  })

  it('does not touch commas, colons or brackets inside strings', () => {
    const text = '{"url": "https://example.com/a,b}", "note": "x: y, z",}'
    expect(repairJson(text).value).toEqual({ url: 'https://example.com/a,b}', note: 'x: y, z' })
  })

  it('strips the function call around a pasted snippet', () => {
    const result = repairJson("analytics.identify({ userId: 'u1', traits: { email: 'a@b.co' } });")
    expect(result.value).toEqual({ userId: 'u1', traits: { email: 'a@b.co' } })
  })

  it('wraps bare fields in braces', () => {
    expect(repairJson('userId: "u1", event: "Signed Up"').value).toEqual({ userId: 'u1', event: 'Signed Up' })
  })

  it('quotes bare multi-word values', () => {
    expect(repairJson('{event: Order Completed}').value).toEqual({ event: 'Order Completed' })
  })

  it('gives a dangling key null', () => {
    expect(repairJson('{"a": 1, "b": }').value).toEqual({ a: 1, b: null })
  })

  it('refuses empty input', () => {
    expect(repairJson('   ').ok).toBe(false)
  })
})

describe('normalizeEvent', () => {
  it('sets the type to the tab the editor is under', () => {
    const result = normalizeEvent({ type: 'identify', userId: 'u' }, 'track')
    expect(result.payload.type).toBe('track')
    expect(result.fixes.some((fix) => fix.includes('Changed "type"'))).toBe(true)
  })

  it('fills the fields the Spec requires', () => {
    const track = normalizeEvent({}, 'track').payload
    expect(track.event).toBeTruthy()
    expect(track.anonymousId).toBeTruthy()
    expect(normalizeEvent({ userId: 'u' }, 'group').payload.groupId).toBeTruthy()
    expect(normalizeEvent({ userId: 'u' }, 'alias').payload.previousId).toBeTruthy()
  })

  it('replaces a non-object properties with an empty one', () => {
    expect(normalizeEvent({ userId: 'u', event: 'X', properties: 'oops' }, 'track').payload.properties).toEqual({})
  })

  it('quotes numeric ids', () => {
    expect(normalizeEvent({ userId: 42, event: 'X' }, 'track').payload.userId).toBe('42')
  })

  it('refuses a payload that is not an object', () => {
    expect(normalizeEvent([1, 2], 'track').ok).toBe(false)
  })

  it('changes nothing about an already-valid call', () => {
    const result = normalizeEvent({ type: 'track', event: 'X', userId: 'u' }, 'track')
    expect(result.fixes).toEqual([])
  })
})

describe('prepareEvent', () => {
  it('returns pretty-printed corrected text alongside the payload', () => {
    const result = prepareEvent("{event: 'X', userId: 'u',}", 'track')
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual(result.payload)
    expect(result.payload).toEqual({ type: 'track', event: 'X', userId: 'u' })
  })
})

describe('spec examples', () => {
  it('has examples for every event type', () => {
    for (const type of EVENT_TYPES) expect(specEventsFor(type).length).toBeGreaterThan(0)
  })

  it('has unique keys', () => {
    const keys = SPEC_EVENTS.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each(SPEC_EVENTS.map((entry) => [entry.key, entry]))('%s builds a valid call', (_, entry) => {
    const payload = specPayload(entry)
    expect(payload.type).toBe(entry.type)
    expect(payload.context).toBeTruthy()
    expect(normalizeEvent(payload, entry.type).fixes).toEqual([])
  })

  it('does not share structure between calls', () => {
    const [entry] = SPEC_EVENTS
    const a = specPayload(entry)
    a.properties.query = 'changed'
    expect(specPayload(entry).properties.query).not.toBe('changed')
  })
})

describe('saved events', () => {
  it('adds and removes per type', () => {
    const saved = withSaved({}, 'track', { id: 'a', name: 'A', payload: {} })
    expect(savedFor(saved, 'track')).toHaveLength(1)
    expect(savedFor(saved, 'identify')).toEqual([])
    expect(savedFor(withoutSaved(saved, 'track', 'a'), 'track')).toEqual([])
  })

  it('toggles a spec example on and off', () => {
    const [entry] = specEventsFor('identify')
    const on = toggleSpec({}, entry)
    expect(savedFor(on, 'identify')[0].spec).toBe(entry.key)
    expect(savedFor(toggleSpec(on, entry), 'identify')).toEqual([])
  })
})

describe('identity highlighting', () => {
  it('falls back to Segment defaults when no rule is drawn', () => {
    const { identifiers, defaults } = identifiersFrom({ nodes: [] })
    expect(defaults).toBe(true)
    expect(identifiers).toEqual(['user_id', 'email', 'anonymous_id'])
  })

  it('reads identifiers from Identity Resolution Rule components', () => {
    const graph = {
      nodes: [{ id: 'r', data: { kind: 'identity_setting', rules: [{ externalId: 'phone' }, { externalId: 'email' }] } }],
    }
    expect(identifiersFrom(graph)).toEqual({ identifiers: ['phone', 'email'], defaults: false })
  })

  it('matches spellings across snake and camel case', () => {
    const match = identityMatcher(['user_id', 'anonymous_id', 'ios.idfa'])
    expect(match('userId')).toBe('user_id')
    expect(match('anonymousId')).toBe('anonymous_id')
    expect(match('advertisingId')).toBe('ios.idfa')
    expect(match('event')).toBeNull()
  })

  it('cuts text into runs that reassemble exactly', () => {
    const text = '{\n  "userId": "u1",\n  "traits": { "email": "a@b.co", "plan": "pro" },\n  "url": "https://x.co"\n}'
    const runs = highlightRuns(text, identityMatcher(['user_id', 'email']))
    expect(runs.map((run) => run.text).join('')).toBe(text)
    expect(runs.filter((run) => run.identifier).map((run) => run.text)).toEqual([
      '"userId": "u1"',
      '"email": "a@b.co"',
    ])
  })
})
