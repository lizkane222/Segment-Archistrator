import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'

import AppShell from './AppShell.jsx'
import ErrorBoundary from './ui/ErrorBoundary.jsx'
import { auth as authApi, session as sessionApi } from './services/api.js'
import {
  SIGN_IN_PARAMS,
  SessionContext,
  needsBootstrap,
  sessionStateFrom,
  signInNotice,
} from './auth/session.js'

/**
 * Boot into the app: signed in or not, connected or not.
 *
 * `GET /api/session` is always the first call. It answers who and what this browser is
 * holding and, because that view is decorated with ensure_csrf_cookie, it also plants the
 * csrftoken cookie every subsequent POST needs -- including the anonymous one below, so
 * the order here is load-bearing.
 *
 * A visitor with no account and no token gets a tokenless session rather than a login
 * screen. Drawing an architecture needs nothing from Segment and nothing from Google; an
 * account buys durability and a token buys reading a real workspace, so both are asked
 * for at the point that matters instead of at the door.
 *
 * Whether to mint that session is `needsBootstrap`, not an inline check, because the
 * question stopped being simple. "Connected" and "anonymous" used to be exhaustive, so
 * neither-of-them meant no session; a signed-in account with no workspace is exactly that
 * pair of false flags, and minting there would hand the browser a second session and
 * strand the scope the account had just claimed.
 */
export default function App() {
  const [status, setStatus] = useState('booting') // booting | ready | offline
  const [session, setSession] = useState(null)
  /* Read once, from the URL the OAuth callback redirected to, and shown as a toast by the
     shell. Held here rather than in the shell because the parameters must be stripped
     before anything else reads the URL. */
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    let cancelled = false

    /* Do this before the request, not after: React may mount this effect twice in
       development, and the second pass must not re-announce a sign-in. */
    setNotice(signInNotice(window.location.search))
    stripSignInParams()

    async function boot() {
      const current = await sessionApi.current()
      /* The server is idempotent about minting, so a double-mounted effect cannot do
         damage even if this decision were wrong. */
      return needsBootstrap(current) ? sessionApi.startAnonymous() : current
    }

    boot()
      .then((result) => {
        if (cancelled) return
        setSession(result)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('offline')
      })

    return () => {
      cancelled = true
    }
  }, [])

  /* Re-read rather than patching a field in. Signing in or out rotates the session and can
     move diagrams between owners, so the server's answer is the only trustworthy picture
     of what just happened. */
  const refreshSession = useCallback(async () => {
    const current = await sessionApi.current().catch(() => null)
    if (current) setSession(current)
    return current
  }, [])

  const handleConnected = useCallback(
    (workspace) => {
      /* Optimistic, then authoritative: the header should show the workspace name the
         instant the dialog closes, but connecting also rewrites which workspace the
         session's diagrams are about. */
      setSession((current) => ({ ...(current ?? {}), workspace, connected: true, anonymous: false }))
      refreshSession()
    },
    [refreshSession],
  )

  /** Disconnect: forget the Segment credential, keep the session and the account. */
  const handleSignOut = useCallback(async () => {
    try {
      await sessionApi.end()
    } finally {
      /* DELETE removes the session row, so there is no scope left to save into. Get
         another one rather than leaving the canvas unable to persist. */
      await sessionApi.startAnonymous().catch(() => {})
      await refreshSession()
    }
  }, [refreshSession])

  /** Log out: forget the account. A different act from Disconnect, on purpose. */
  const handleLogOut = useCallback(async () => {
    try {
      await authApi.logOut()
    } finally {
      await refreshSession()
    }
  }, [refreshSession])

  const state = useMemo(() => sessionStateFrom(session), [session])

  if (status === 'booting') {
    return (
      <div className="flex h-full items-center justify-center text-twilio-gray-60">
        <Loader2 size={20} className="animate-spin" aria-hidden="true" />
        <span className="ml-2 text-sm">Starting…</span>
      </div>
    )
  }

  if (status === 'offline') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-twilio-navy">
            Cannot reach the server
          </h1>
          <p className="mt-2 text-sm text-twilio-gray-60">
            The app needs its own backend to save diagrams. Check that it is
            running, then reload.
          </p>
        </div>
      </div>
    )
  }

  return (
    /* The outer net. Anything the inner boundaries do not hold lands here as a message
       with the error in it -- which is strictly better than the blank white page this
       replaced, but not good: React unmounts the subtree it caught, so retrying starts a
       fresh canvas. The hint says so rather than implying the drawing survived. */
    <ErrorBoundary
      title="The app stopped rendering"
      hint="Unsaved canvas changes are gone. Retrying starts a fresh canvas; the error is below, and the console has the component stack."
    >
      <SessionContext.Provider value={state}>
        <AppShell
          workspace={state.workspace}
          onConnected={handleConnected}
          onSignOut={handleSignOut}
          onLogOut={handleLogOut}
          /* Re-read the session from the server. Two callers, both of which have just
             discovered that what this component believes about the session is out of date:
             the keep-alive ping when it finds the session gone, and the save recovery after
             it has minted a replacement. Without it the header goes on naming an account
             whose session no longer exists. */
          onRefreshSession={refreshSession}
          signInNotice={notice}
        />
      </SessionContext.Provider>
    </ErrorBoundary>
  )
}

/**
 * Take the OAuth callback's parameters out of the address bar.
 *
 * `replaceState` rather than a navigation: reloading a URL that still said `signed_in`
 * would re-announce the sign-in, and the parameters are noise in a link someone copies.
 * Only the keys this app put there are removed, so anything else in the URL survives.
 */
function stripSignInParams() {
  const url = new URL(window.location.href)
  const present = SIGN_IN_PARAMS.filter((key) => url.searchParams.has(key))
  if (!present.length) return
  for (const key of present) url.searchParams.delete(key)
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash)
}
