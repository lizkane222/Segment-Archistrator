/*
 * Keep an in-use tab's session from expiring underneath it.
 *
 * The server's idle window slides on every request (`WorkspaceSession.touch()`), so the
 * only way to be logged out mid-work is to make no requests for twelve hours -- which is
 * exactly what drawing does. Nothing about panning, dragging, typing or arranging talks
 * to the server, so a diagram can be worked on all day inside a session the server
 * considers idle, and the first request in half a day is the save that fails.
 *
 * One ping, well inside the window, closes that. It is not a heartbeat in the usual sense
 * and deliberately not unconditional:
 *
 *   - **Only while the tab is visible.** A backgrounded tab is not someone working, and a
 *     hidden tab pinging all night would keep a session alive for a browser nobody is
 *     sitting at. Browsers also throttle timers in background tabs, so an unconditional
 *     interval is unreliable there anyway -- `visibilitychange` is what makes the timing
 *     honest, and a ping on becoming visible again is what covers the tab that was hidden
 *     for hours.
 *   - **Only while there is unsaved work.** With nothing to lose there is nothing for the
 *     session to protect, and letting an idle tab's session expire on schedule is the
 *     behaviour the twelve hours were chosen for. So this extends a session that is
 *     holding a morning's drawing and no other.
 *
 * The ping is `GET /api/session`, which is not a special endpoint added for this: it
 * authenticates like everything else, so it touches the row on the way through. That is
 * the whole mechanism, which is why there is no server-side change to go with this file.
 *
 * If the ping finds the session already gone -- the tab was closed for a day, or someone
 * signed out in another tab -- this does *not* quietly mint a replacement. Doing so would
 * turn a signed-in visitor into an anonymous one behind their back, and change which
 * diagrams the Open dialog lists without anything having been clicked. It reports instead,
 * and the recovery that does write is the one in auth/recover.js, which runs when there is
 * actual work in hand to save.
 */

import { useEffect, useRef } from 'react'

import { session as sessionApi } from '../services/api.js'
import { needsBootstrap } from './session.js'

/*
 * 25 minutes.
 *
 * The window is twelve hours, so almost any interval would do and the useful question is
 * what it costs: at this rate an all-day session spends about twenty requests, each one a
 * single indexed row read and a write of `last_seen_at`. Anything much shorter is spending
 * requests to no purpose; anything approaching the window itself would leave the outcome
 * turning on where the last ping happened to fall before the tab was hidden.
 */
export const KEEP_ALIVE_MS = 25 * 60 * 1000

/**
 * Whether a ping is worth making right now.
 *
 * Split out because it is the whole policy of this module, and the alternative -- two
 * conditions inlined in an effect -- is a policy no test can read.
 */
export function shouldPing({ dirty, visible }) {
  return Boolean(dirty) && Boolean(visible)
}

/**
 * @param dirty      whether any open tab holds unsaved work
 * @param onLost     called when the ping finds no session. The caller re-reads the
 *   session so the chrome stops claiming an account this browser no longer holds.
 */
export function useSessionKeepAlive({ dirty, onLost }) {
  /* Through refs so the effect below depends on nothing that changes per keystroke. The
     interval must survive `dirty` flipping -- it flips on the first edit after every save
     -- and an effect that re-ran on it would restart the clock each time and, on a
     diagram being edited steadily, never reach the end of it. */
  const state = useRef({ dirty, onLost })
  state.current = { dirty, onLost }

  useEffect(() => {
    let stopped = false

    const ping = async () => {
      const { dirty: unsaved, onLost: lost } = state.current
      if (stopped || !shouldPing({ dirty: unsaved, visible: !document.hidden })) return
      try {
        const current = await sessionApi.current()
        if (!stopped && needsBootstrap(current)) lost?.()
      } catch {
        /* Swallowed. A failed ping is indistinguishable from being briefly offline, and
           the app has no business announcing that -- the next ping, or the next save,
           is where it matters. */
      }
    }

    const timer = setInterval(ping, KEEP_ALIVE_MS)
    /* Coming back to a tab that was hidden for hours is the case the interval cannot
       cover: the browser may have throttled it to nothing, and this is the moment the
       session is most likely to be near its limit. */
    const onVisible = () => {
      if (!document.hidden) ping()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
