import { describe, expect, it } from 'vitest'

import { applyProfile, newProfile, nextColour, profileFromSnapshot } from './profileLibrary.js'

const avery = newProfile({
  name: 'Avery',
  identifiers: [
    { type: 'user_id', id: 'u_avery' },
    { type: 'email', id: 'avery@example.com' },
  ],
  traits: { plan: 'pro' },
})

describe('applyProfile', () => {
  it('puts the ids on a track call and the traits in its context, dropping the skeleton user', () => {
    const out = applyProfile({ type: 'track', event: 'X', userId: 'user_1234', anonymousId: 'anon' }, avery)
    expect(out.userId).toBe('u_avery')
    expect(out.anonymousId).toBeUndefined()
    expect(out.context.traits).toEqual({ email: 'avery@example.com', plan: 'pro' })
  })
  it('puts the traits on an identify call', () => {
    const out = applyProfile({ type: 'identify', traits: { first: 'A' } }, avery)
    expect(out.traits).toEqual({ first: 'A', email: 'avery@example.com', plan: 'pro' })
  })
  it('leaves a payload alone when there is no profile', () => {
    const payload = { type: 'track' }
    expect(applyProfile(payload, null)).toBe(payload)
  })
})

describe('profiles', () => {
  it('hands out colours that are not yet worn', () => {
    const first = newProfile({ name: 'A' }, [])
    const second = newProfile({ name: 'B' }, [first])
    expect(second.color).not.toBe(first.color)
    expect(nextColour([first])).toBe(second.color)
  })
  it('copies identifiers and traits out of a pasted snapshot', () => {
    const copy = profileFromSnapshot({ identifiers: [{ type: 'user_id', id: 'u1', collection: 'users' }], traits: { a: 1 } }, 'From canvas')
    expect(copy.identifiers).toEqual([{ type: 'user_id', id: 'u1' }])
    expect(copy.traits).toEqual({ a: 1 })
  })
})
