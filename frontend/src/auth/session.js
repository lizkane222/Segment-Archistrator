/*
 * Who is holding this tab: the account, the workspace, and what the chrome should say
 * about both.
 *
 * A context rather than more props. `workspace`, `onConnected` and `onSignOut` were
 * already drilled App -> AppShell -> Workbench -> {Palette, Inspector, EmptyOverlay,
 * ConnectDialog}, and an account plus sign-in and sign-out would be four more down the
 * same path into a file that is already two thousand lines. The canvas already solves
 * this shape four times over -- see chrome.js, anchors.js, flash.js, groupCollapse.js --
 * and this follows them: a context, a default that is safe to render against, and a hook.
 *
 * Everything that makes a *decision* is a plain exported function below the context, so
 * it can be tested. This project has no jsdom, so a decision left inside a component is
 * a decision no test can reach; `chromePlacement` in AppShell.jsx is the same move.
 */

import { createContext, useContext } from 'react'

/* Safe to render against before the session has been read: nobody is signed in, nothing
   is connected, and sign-in is assumed unavailable until the server says otherwise. The
   last part matters -- guessing `true` would flash a sign-in button on a deployment that
   has no Google client and cannot honour it. */
export const NO_SESSION = {
  status: 'booting',
  account: null,
  workspace: null,
  connected: false,
  anonymous: false,
  googleAvailable: false,
}

export const SessionContext = createContext(NO_SESSION)

export function useSession() {
  return useContext(SessionContext) ?? NO_SESSION
}

/**
 * The state of the world, from what `GET /api/session` answered.
 *
 * `hasSession` is the load-bearing field and it is not derivable from the other two.
 * "Connected" and "anonymous" used to be exhaustive, so the boot code read
 * neither-of-them as "no session at all"; a signed-in account with no workspace
 * connected is exactly that combination, and treating it as sessionless would mint a
 * second session and orphan the scope the account was about to claim.
 */
export function sessionStateFrom(payload) {
  if (!payload || !payload.hasSession) {
    return { ...NO_SESSION, status: 'none', googleAvailable: Boolean(payload?.auth?.google) }
  }
  return {
    status: 'ready',
    account: payload.account ?? null,
    workspace: payload.workspace ?? null,
    connected: Boolean(payload.connected),
    anonymous: Boolean(payload.anonymous),
    googleAvailable: Boolean(payload.auth?.google),
  }
}

/**
 * Whether boot should ask the server for a session.
 *
 * Split out because getting it wrong is silent and expensive: minting a session that
 * already exists strands whatever the first one saved behind a cookie that has just been
 * replaced.
 */
export function needsBootstrap(payload) {
  return !payload || !payload.hasSession
}

/** Signed in with an account, which is what inviting requires. */
export function canInvite(state) {
  return Boolean(state?.account)
}

/**
 * Whether to offer sign-in at all.
 *
 * False once signed in, and false when the server has no Google client configured --
 * unconfigured is a supported state here, the same way an unset Airtable key simply
 * hides the feedback form rather than offering one whose submit fails.
 */
export function canSignIn(state) {
  return Boolean(state?.googleAvailable) && !state?.account
}

/**
 * How to name the person in the header, in one place.
 *
 * Falls back through name, then the local part of the address, then a generic word --
 * because a Google account may carry no display name at all, and "Signed in as" with
 * nothing after it reads like a bug.
 */
export function accountLabel(account) {
  if (!account) return ''
  if (account.name) return account.name
  const local = (account.email || '').split('@')[0]
  return local || 'your account'
}

/**
 * Initials for the avatar circle.
 *
 * Built from the name or the address only -- deliberately not from `accountLabel`, whose
 * last resort is the phrase "your account" and would render as the initials "YA".
 * A question mark is the honest answer when there is nothing to abbreviate.
 */
export function accountInitials(account) {
  const source = account?.name || (account?.email || '').split('@')[0]
  const words = (source || '').split(/[\s._-]+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return words[0].slice(0, 2).toUpperCase()
}

/**
 * What the account area should say about durability.
 *
 * This is the sentence that explains the whole feature, so it is worth being exact
 * about: an account is what makes a diagram outlive the cookie, and an anonymous scope
 * is explicitly not.
 */
export function persistenceNote(state) {
  if (state?.account) return 'Your diagrams are saved to your account.'
  if (!state?.googleAvailable) {
    return 'Sign-in is not configured on this server, so diagrams are tied to this browser.'
  }
  return 'Diagrams you save are tied to this browser. Sign in to keep them.'
}

/*
 * The sign-in outcome the OAuth callback redirects back with.
 *
 * The callback is a server-side 302 to `/`, so its result arrives as a query parameter
 * and is read once on boot. A pure function because the alternative -- parsing this
 * inside an effect -- is untestable here, and the mapping from parameter to toast is
 * exactly the part worth pinning.
 */
export function signInNotice(search) {
  const params = new URLSearchParams(search || '')

  const error = params.get('auth_error')
  if (error) return { tone: 'error', message: error }

  const email = params.get('signed_in')
  if (email) {
    const claimed = Number(params.get('claimed') || 0)
    return {
      tone: 'success',
      message: claimed
        ? `Signed in as ${email}. ${claimed} diagram${claimed === 1 ? '' : 's'} you drew before signing in ${claimed === 1 ? 'is' : 'are'} now saved to your account.`
        : `Signed in as ${email}.`,
    }
  }
  return null
}

/** The parameters `signInNotice` consumes, so boot can strip them from the URL. */
export const SIGN_IN_PARAMS = ['auth_error', 'signed_in', 'claimed']
