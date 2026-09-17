/*
 * What to do when a save comes back 401.
 *
 * A session lasts `WORKSPACE_SESSION_IDLE_HOURS` (12) from its last *request*, and the
 * server slides that window on every one -- so a tab that is being used never expires.
 * A tab left open overnight does: the row is deleted the next time anything touches it
 * (see `WorkspaceSessionAuthentication.authenticate`), and the request that discovered
 * the expiry is the one that fails. Which means the first thing to break is almost
 * always a save, and the work being saved is a morning's drawing.
 *
 * Until this existed the failure was final: `save` caught the error, raised a toast with
 * DRF's own words in it ("Authentication credentials were not provided.") and stopped.
 * The diagram was still on the canvas, but nothing said how to get it into the database
 * and no amount of pressing Save again would help -- every attempt reached the same
 * deleted row.
 *
 * So the answer is three steps, and the reason they are three is that only the first is
 * guaranteed to work:
 *
 *   1. Get a session. `GET /api/session` says whether the cookie still names one; if it
 *      does not, `POST /api/session/anonymous` mints a scope to save into. Neither needs
 *      an account, which is what makes this recoverable without a round trip through
 *      Google.
 *   2. Try the same save again. This succeeds whenever the *session* was the only thing
 *      that had gone -- a signed-in visitor whose session expired while their account
 *      still owns the diagram gets their own row updated and never learns anything
 *      happened beyond one extra sentence.
 *   3. Failing that, save a copy. A freshly-minted anonymous scope does not own an
 *      account's diagram, so the retried PATCH 404s (`visible_to` excludes it) or 403s
 *      (`editable_by` does) -- and a copy under the new scope is the only write left
 *      that can succeed. It is not a silent one: the toast says a copy was made, and
 *      signing in again claims it, because `claim_for_account` moves everything in the
 *      anonymous scope to the account.
 *
 * The decisions live here as plain functions rather than inside AppShell's `save`,
 * because this project has no jsdom and a decision left inside a component is one no
 * test can reach. `reviveSession` is the one function here that talks to the network,
 * and it is two calls in the order boot already makes them.
 */

import { session as sessionApi } from '../services/api.js'
import { needsBootstrap } from './session.js'

/**
 * Is this failure "your session is gone", rather than "that save was rejected"?
 *
 * `ApiError.isUnauthenticated` is the test, and it is deliberately *not* widened to
 * cover 403: a 403 from `get_editable` means the diagram belongs to somebody else and
 * was shared with you, which is a fact about the document rather than about the session.
 * Recovering from that by writing a copy would be right; doing it under this name would
 * hide a permission boundary behind a word about credentials. That case keeps its own
 * message, which already tells the user to save a copy themselves.
 *
 * Tolerant of anything that is not an ApiError -- a TypeError from a dropped connection
 * is not a session problem and must not send anyone through this path.
 */
export function isSessionLoss(error) {
  return Boolean(error?.isUnauthenticated)
}

/**
 * The next thing to attempt, given how many attempts have already failed.
 *
 * `hadId` is whether the document already exists in the database. A document that has
 * never been saved has nothing to retry *as* -- its first save is a create either way --
 * so it skips straight past the retry and a "copy" is simply that create. Written as one
 * function over an attempt counter rather than as nested try/catch in the caller so the
 * order is legible in one place and pinned by a test.
 */
export function recoveryStep({ hadId, attempt }) {
  if (attempt === 0) return hadId ? 'retry' : 'copy'
  if (attempt === 1) return hadId ? 'copy' : 'give-up'
  return 'give-up'
}

/**
 * What to say once the work is safe.
 *
 * Every branch says two things: that the session had expired (so the delay and the
 * failed first press are explained) and where the diagram now is. The signed-in copy
 * case says the one extra thing that matters -- signing in again is what brings the copy
 * back to the account, and without that sentence the user is left believing their
 * diagram has been orphaned.
 */
export function recoveryMessage({ copied, signedIn, name }) {
  const title = name ? `“${name}”` : 'your diagram'
  if (!copied) return `Your session had expired — signed back in and saved ${title}.`
  if (signedIn) {
    return (
      `Your session had expired, so ${title} was saved as a new copy in this browser. ` +
      'Sign in again to move it back to your account.'
    )
  }
  return `Your session had expired, so ${title} was saved again as a new copy.`
}

/** What to say when even the copy failed. Names the way out that does not need a server. */
export function lastResortMessage(reason) {
  return `${reason} Nothing on the canvas is lost — use Export ▸ Diagram file to keep it.`
}

/**
 * Make sure this browser holds a session, and say whether it does.
 *
 * The same two calls boot makes, in the same order and for the same reason: `GET` is
 * what plants the CSRF cookie a subsequent POST needs, and `needsBootstrap` rather than
 * an inline check because "is there a session?" is not the simple question it looks like
 * -- a signed-in account with no workspace connected has both `connected` and `anonymous`
 * false, and reading that as sessionless would mint a second session and strand the
 * scope the first one owned.
 *
 * Returns the session payload, or null when the server could not be reached at all --
 * which is a different problem with a different message, and not one a retry fixes.
 */
export async function reviveSession() {
  try {
    const current = await sessionApi.current()
    if (!needsBootstrap(current)) return current
    return await sessionApi.startAnonymous()
  } catch {
    return null
  }
}
