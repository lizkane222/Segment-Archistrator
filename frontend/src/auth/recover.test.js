import { describe, expect, it } from 'vitest'

import { ApiError } from '../services/api.js'
import {
  isSessionLoss,
  lastResortMessage,
  recoveryMessage,
  recoveryStep,
} from './recover.js'

describe('isSessionLoss', () => {
  it('is true for the 401 an expired session produces', () => {
    expect(isSessionLoss(new ApiError('Authentication credentials were not provided.', {
      status: 401,
    }))).toBe(true)
  })

  it('is true for the codes the server names it by', () => {
    expect(isSessionLoss(new ApiError('nope', { code: 'not_authenticated' }))).toBe(true)
    expect(isSessionLoss(new ApiError('nope', { code: 'invalid_token' }))).toBe(true)
  })

  /* The distinction this exists to keep. A shared diagram refused for being somebody
     else's is not a session problem, and recovering from it by writing a copy would put a
     permission boundary behind a sentence about credentials. */
  it('is false for a diagram that is simply not yours to write', () => {
    expect(
      isSessionLoss(new ApiError('Save a copy to make changes.', { status: 403, code: 'not_your_diagram' })),
    ).toBe(false)
  })

  it('is false for a rejected save and for a dropped connection', () => {
    expect(isSessionLoss(new ApiError('edge names a missing node', { status: 400 }))).toBe(false)
    expect(isSessionLoss(new TypeError('Failed to fetch'))).toBe(false)
    expect(isSessionLoss(undefined)).toBe(false)
  })
})

describe('recoveryStep', () => {
  it('retries an existing diagram before copying it', () => {
    expect(recoveryStep({ hadId: true, attempt: 0 })).toBe('retry')
    expect(recoveryStep({ hadId: true, attempt: 1 })).toBe('copy')
    expect(recoveryStep({ hadId: true, attempt: 2 })).toBe('give-up')
  })

  /* A document that has never been saved has nothing to retry as: its first save is a
     create whichever way it is reached, so a second attempt at the same thing would only
     produce the same failure twice. */
  it('goes straight to a create for a document with no id', () => {
    expect(recoveryStep({ hadId: false, attempt: 0 })).toBe('copy')
    expect(recoveryStep({ hadId: false, attempt: 1 })).toBe('give-up')
  })
})

describe('recoveryMessage', () => {
  it('explains the delay when the same diagram was saved', () => {
    const message = recoveryMessage({ copied: false, signedIn: true, name: 'MTU Billing' })
    expect(message).toContain('expired')
    expect(message).toContain('MTU Billing')
    expect(message).not.toContain('copy')
  })

  /* The sentence that stops a copy reading as a lost diagram. `claim_for_account` is what
     makes it true: signing in moves the whole anonymous scope onto the account. */
  it('tells a signed-in user how to get a copy back onto their account', () => {
    const message = recoveryMessage({ copied: true, signedIn: true, name: 'MTU Billing' })
    expect(message).toContain('copy')
    expect(message).toContain('Sign in again')
  })

  it('does not offer sign-in to someone who was never signed in', () => {
    const message = recoveryMessage({ copied: true, signedIn: false, name: 'MTU Billing' })
    expect(message).toContain('copy')
    expect(message).not.toContain('Sign in')
  })

  it('survives a diagram with no name', () => {
    expect(recoveryMessage({ copied: false, signedIn: false, name: '' })).toContain('your diagram')
  })
})

describe('lastResortMessage', () => {
  it('keeps the reason and names the way out that needs no server', () => {
    const message = lastResortMessage('Request failed.')
    expect(message).toContain('Request failed.')
    expect(message).toContain('Export')
  })
})
