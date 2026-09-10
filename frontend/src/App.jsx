import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import AppShell from './AppShell.jsx'
import ErrorBoundary from './ui/ErrorBoundary.jsx'
import { session as sessionApi } from './services/api.js'

/**
 * Boot into the app, connected or not.
 *
 * `GET /api/session` is always the first call. It answers "am I connected" and,
 * because that view is decorated with ensure_csrf_cookie, it also plants the
 * csrftoken cookie every subsequent POST needs -- including the anonymous one
 * below, so the order here is load-bearing.
 *
 * A visitor with no token gets a tokenless session rather than a login screen.
 * Drawing an architecture needs nothing from Segment; the token only buys the
 * ability to read a real workspace, so it is asked for at the point that matters
 * instead of at the door.
 */
export default function App() {
  const [status, setStatus] = useState('booting') // booting | ready | offline
  const [workspace, setWorkspace] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function boot() {
      const current = await sessionApi.current()
      if (current?.connected) return current
      // Already anonymous means a scope exists; minting a second one would
      // orphan whatever the first saved. The server is idempotent about this
      // too, so a double-mounted effect cannot do damage either.
      if (current?.anonymous) return current
      return sessionApi.startAnonymous()
    }

    boot()
      .then((result) => {
        if (cancelled) return
        setWorkspace(result?.workspace ?? null)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('offline')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleConnected = useCallback((next) => {
    setWorkspace(next)
  }, [])

  const handleSignOut = useCallback(async () => {
    try {
      await sessionApi.end()
    } finally {
      // DELETE removes the session row, so there is no scope left to save into.
      // Get another one rather than leaving the canvas unable to persist, and
      // drop the workspace regardless: a UI claiming a connection it cannot act
      // on is worse than a stale row.
      setWorkspace(null)
      await sessionApi.startAnonymous().catch(() => {})
    }
  }, [])

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
      <AppShell
        workspace={workspace}
        onConnected={handleConnected}
        onSignOut={handleSignOut}
      />
    </ErrorBoundary>
  )
}
