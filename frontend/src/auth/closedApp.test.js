import { describe, expect, it } from 'vitest'

import { needsBootstrap, needsSignIn, sessionStateFrom } from './session.js'

const closed = { hasSession: false, auth: { required: true, google: true, domains: ['twilio.com'] } }

describe('a closed app', () => {
  it('shows the sign-in screen to someone with no session', () => {
    expect(needsSignIn(sessionStateFrom(closed))).toBe(true)
  })

  it('never asks the server for an anonymous scope it would refuse', () => {
    expect(needsBootstrap(closed)).toBe(false)
  })

  it('lets a signed-in account through', () => {
    const state = sessionStateFrom({
      hasSession: true,
      account: { email: 'sol@twilio.com' },
      auth: { required: true },
      connections: [{ id: 'ws1', slug: 'acme' }],
    })
    expect(needsSignIn(state)).toBe(false)
    expect(state.connections).toEqual([{ id: 'ws1', slug: 'acme' }])
  })

  it('tells the sign-in screen which domains may sign in', () => {
    expect(sessionStateFrom(closed).domains).toEqual(['twilio.com'])
  })
})

describe('an open app (local development)', () => {
  it('still mints an anonymous scope, and never shows the sign-in screen', () => {
    const open = { hasSession: false, auth: { required: false } }
    expect(needsBootstrap(open)).toBe(true)
    expect(needsSignIn(sessionStateFrom(open))).toBe(false)
  })

  it('treats the one connection a tokenless-account session holds as the only group', () => {
    const state = sessionStateFrom({
      hasSession: true,
      account: null,
      workspace: { id: 'ws1', slug: 'acme' },
      connected: true,
      auth: {},
    })
    expect(state.connections).toEqual([{ id: 'ws1', slug: 'acme' }])
  })
})
