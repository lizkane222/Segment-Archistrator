import { describe, expect, it } from 'vitest'

import {
  NO_SESSION,
  accountInitials,
  accountLabel,
  canInvite,
  canSignIn,
  needsBootstrap,
  persistenceNote,
  sessionStateFrom,
  signInNotice,
} from './session.js'

const SIGNED_IN = { hasSession: true, account: { email: 'liz@example.com', name: 'Liz Kane' } }

describe('sessionStateFrom', () => {
  it('reads a connected workspace', () => {
    const state = sessionStateFrom({
      hasSession: true,
      account: null,
      workspace: { id: 'ws_1', name: 'Acme' },
      connected: true,
      anonymous: false,
      auth: { google: true },
    })
    expect(state).toMatchObject({
      status: 'ready',
      connected: true,
      anonymous: false,
      googleAvailable: true,
    })
    expect(state.workspace.name).toBe('Acme')
  })

  it('reads a signed-in account with no workspace connected', () => {
    /* The combination that used to be unrepresentable: both flags false, yet a real
       session. Boot must not read this as "no session". */
    const state = sessionStateFrom({ ...SIGNED_IN, connected: false, anonymous: false })
    expect(state.status).toBe('ready')
    expect(state.account.email).toBe('liz@example.com')
    expect(state.connected).toBe(false)
    expect(state.anonymous).toBe(false)
  })

  it('reports no session when the server says there is none', () => {
    expect(sessionStateFrom({ hasSession: false }).status).toBe('none')
    expect(sessionStateFrom(null).status).toBe('none')
  })

  it('keeps whether sign-in is available even with no session', () => {
    expect(sessionStateFrom({ hasSession: false, auth: { google: true } }).googleAvailable).toBe(true)
  })

  it('never guesses that sign-in is available', () => {
    /* A wrong `true` flashes a button the server cannot honour. */
    expect(NO_SESSION.googleAvailable).toBe(false)
    expect(sessionStateFrom({ hasSession: true }).googleAvailable).toBe(false)
  })
})

describe('needsBootstrap', () => {
  it('mints only when there is genuinely no session', () => {
    expect(needsBootstrap(null)).toBe(true)
    expect(needsBootstrap({ hasSession: false })).toBe(true)
  })

  it('does not mint a second session for a signed-in account with no workspace', () => {
    /* The regression this function exists for: minting here would orphan the scope the
       account was about to claim. */
    expect(needsBootstrap({ ...SIGNED_IN, connected: false, anonymous: false })).toBe(false)
  })

  it('does not mint for an anonymous or connected session', () => {
    expect(needsBootstrap({ hasSession: true, anonymous: true })).toBe(false)
    expect(needsBootstrap({ hasSession: true, connected: true })).toBe(false)
  })
})

describe('canInvite / canSignIn', () => {
  it('only an account may invite', () => {
    expect(canInvite(sessionStateFrom(SIGNED_IN))).toBe(true)
    expect(canInvite(sessionStateFrom({ hasSession: true, anonymous: true }))).toBe(false)
    expect(canInvite(undefined)).toBe(false)
  })

  it('offers sign-in only when Google is configured and nobody is signed in', () => {
    expect(canSignIn(sessionStateFrom({ hasSession: true, auth: { google: true } }))).toBe(true)
    expect(canSignIn(sessionStateFrom({ hasSession: true, auth: { google: false } }))).toBe(false)
    expect(canSignIn(sessionStateFrom({ ...SIGNED_IN, auth: { google: true } }))).toBe(false)
  })
})

describe('accountLabel / accountInitials', () => {
  it('prefers the display name', () => {
    expect(accountLabel({ name: 'Liz Kane', email: 'liz@example.com' })).toBe('Liz Kane')
    expect(accountInitials({ name: 'Liz Kane' })).toBe('LK')
  })

  it('falls back to the local part when there is no name', () => {
    expect(accountLabel({ email: 'liz.kane@example.com' })).toBe('liz.kane')
    expect(accountInitials({ email: 'liz.kane@example.com' })).toBe('LK')
  })

  it('never renders an empty label for an account that has neither', () => {
    expect(accountLabel({})).toBe('your account')
    expect(accountLabel(null)).toBe('')
  })

  it('abbreviates nothing rather than the fallback phrase', () => {
    /* Guards a real slip: initials taken from accountLabel would render "your account"
       as "YA", which looks like somebody's name. */
    expect(accountInitials({})).toBe('?')
    expect(accountInitials(null)).toBe('?')
  })
})

describe('persistenceNote', () => {
  it('says diagrams are safe once signed in', () => {
    expect(persistenceNote(sessionStateFrom(SIGNED_IN))).toMatch(/saved to your account/)
  })

  it('warns that an anonymous scope is tied to the browser', () => {
    const state = sessionStateFrom({ hasSession: true, anonymous: true, auth: { google: true } })
    expect(persistenceNote(state)).toMatch(/tied to this browser/)
    expect(persistenceNote(state)).toMatch(/Sign in/)
  })

  it('does not tell someone to sign in when they cannot', () => {
    const state = sessionStateFrom({ hasSession: true, anonymous: true, auth: { google: false } })
    expect(persistenceNote(state)).toMatch(/not configured/)
    expect(persistenceNote(state)).not.toMatch(/Sign in to keep/)
  })
})

describe('signInNotice', () => {
  it('surfaces a refusal verbatim', () => {
    const notice = signInNotice('?auth_error=This%20app%20is%20limited')
    expect(notice).toEqual({ tone: 'error', message: 'This app is limited' })
  })

  it('reports a plain sign-in', () => {
    expect(signInNotice('?signed_in=liz@example.com')).toEqual({
      tone: 'success',
      message: 'Signed in as liz@example.com.',
    })
  })

  it('mentions claimed diagrams, and counts them in words that agree', () => {
    expect(signInNotice('?signed_in=liz@example.com&claimed=1').message).toMatch(
      /1 diagram you drew before signing in is now saved/,
    )
    expect(signInNotice('?signed_in=liz@example.com&claimed=4').message).toMatch(
      /4 diagrams you drew before signing in are now saved/,
    )
  })

  it('treats a zero or absent count as nothing claimed', () => {
    /* The backend omits the parameter entirely when nothing moved. */
    expect(signInNotice('?signed_in=liz@example.com&claimed=0').message).toBe(
      'Signed in as liz@example.com.',
    )
  })

  it('is silent on an ordinary page load', () => {
    expect(signInNotice('')).toBeNull()
    expect(signInNotice('?something=else')).toBeNull()
    expect(signInNotice(undefined)).toBeNull()
  })

  it('prefers the error when both somehow arrive', () => {
    expect(signInNotice('?signed_in=a@b.com&auth_error=nope').tone).toBe('error')
  })
})
