/*
 * The sign-in gate, drawn over the app rather than instead of it.
 *
 * It used to be a screen of its own, which unmounted the whole workbench -- and a session that
 * lapsed under an open page took every open diagram's in-memory state with it. Now the shell
 * stays mounted underneath, inert, so nothing can be edited while nobody is signed in and nothing
 * that was open goes away. Signing in is a full-page navigation (the target redirects to Google),
 * and the shell writes its tabs to this browser's storage on the way out, so they come back --
 * groups included -- when the visitor does.
 */

import { ShieldCheck } from 'lucide-react'

/* `BASE_URL` is `/` in dev and `/static/` in the build Django serves; a bare `/file` would 404 there. */
const WORDMARK_URL = `${import.meta.env.BASE_URL}archistrator-wordmark.png`
const WORDMARK_MASK = {
  WebkitMask: `url(${WORDMARK_URL}) center / contain no-repeat`,
  mask: `url(${WORDMARK_URL}) center / contain no-repeat`,
}

export default function SignInModal({ notice, domains = [], googleAvailable }) {
  const company = domains.length ? domains.map((domain) => `@${domain}`).join(', ') : 'your company'
  const failure = notice?.tone === 'error' ? notice.message : null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-twilio-navy/40 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sign-in-title"
    >
      <div className="w-full max-w-sm rounded-lg border border-twilio-gray-20 bg-white p-6 text-center shadow-lg">
        <div className="relative mx-auto mb-4 w-full">
          <img src={WORDMARK_URL} alt="Archistrator" className="block w-full" />
          <div className="wordmark-shine" style={WORDMARK_MASK} aria-hidden="true" />
        </div>
        <h1 id="sign-in-title" className="text-lg font-semibold text-twilio-navy">
          Sign in to continue
        </h1>
        <p className="mt-2 text-sm text-twilio-gray-60">
          Sign in with your {company} Google account so your diagrams are saved to you.
        </p>
        <p className="mt-2 text-xs text-twilio-gray-60">
          Whatever you have open — including unsaved diagrams and their tab groups — is kept on this
          device and reopens when you are back.
        </p>

        {failure && (
          <p
            role="alert"
            className="mt-4 rounded-md border border-twilio-error/40 bg-twilio-red-light px-3 py-2 text-left text-xs text-twilio-red-dark"
          >
            {failure}
          </p>
        )}

        {googleAvailable ? (
          <a
            href="/api/auth/google/start"
            className="mt-5 inline-flex items-center justify-center gap-2 rounded-md bg-twilio-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-twilio-blue-dark"
          >
            <ShieldCheck size={15} aria-hidden="true" />
            Sign in with Google
          </a>
        ) : (
          <p className="mt-5 text-xs text-twilio-gray-60">
            Sign-in is not configured on this server yet. Ask whoever runs this app to set up Google
            sign-in.
          </p>
        )}
      </div>
    </div>
  )
}
