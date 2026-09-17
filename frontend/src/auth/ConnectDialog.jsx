/*
 * Connect a workspace. Two ways in, offered as equals.
 *
 * Not a gate -- the canvas works without any of this, so it opens from the header when someone
 * wants to read a real workspace.
 *
 * ## The two options, and why neither is recommended here
 *
 * A **Public API token** is scoped, revocable, and belongs to exactly one workspace. An **app
 * session `auth_token`** is the cookie the Segment app itself uses: it is already in the
 * browser of anyone who is logged in, so it needs nothing created and no request to the
 * customer, and it is the one that gets a workspace read today rather than next week.
 *
 * The tradeoff between those is real and it is not this dialog's to make. An auth_token is
 * somebody's whole login session -- it carries all of their access, in every workspace they can
 * reach, and cannot be revoked without ending their session -- and the decision was that both
 * are listed and the user picks. So the two tabs are the same size, in the same style, with no
 * "recommended" on either. What this dialog *does* owe the user is the facts, which is what the
 * note under each tab is for: choosing needs to be possible, and it is not possible without
 * knowing what the second credential is.
 *
 * ## The three-step shape of the GraphQL flow
 *
 * A Public API token names its workspace, so pasting it is the whole flow. An auth_token is a
 * person, and a person is often in dozens of workspaces -- so the server answers `needsChoice`
 * with the list, and this component asks. Connecting to whichever sorted first would put a
 * solutions engineer on the wrong customer's workspace, which is the one outcome here that
 * would be actively harmful.
 *
 * The credential is held in state across that round trip, because the second request has to
 * carry it again -- it is never stored server-side until a workspace is chosen. It is dropped
 * the moment the flow ends, either way.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Cookie,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react'

import { ApiError, session as sessionApi } from '../services/api.js'

const REGIONS = [
  { value: 'us', label: 'US', hint: 'api.segmentapis.com' },
  { value: 'eu', label: 'EU', hint: 'eu1.api.segmentapis.com' },
]

/*
 * The two credentials, as data, so the tabs cannot drift from the fields they switch between.
 *
 * `caveat` is not optional decoration. The Public API entry has one too -- it says what the
 * token costs to obtain -- so that the auth_token's caveat reads as *information* rather than
 * as the dialog steering the user away from an option it was asked to offer as an equal.
 */
const CREDENTIALS = [
  {
    id: 'public_api',
    tab: 'Public API token',
    icon: KeyRound,
    label: 'Public API token',
    placeholder: 'sgp_...',
    rows: 3,
    blurb:
      'Scoped to one workspace, revocable on its own, and safe to hold for a while. Someone with workspace-owner access has to create it first.',
    caveat: null,
    where: 'Segment workspace settings → Access Management → Tokens. Read-only scopes are enough.',
  },
  {
    id: 'graphql',
    tab: 'App session',
    icon: Cookie,
    label: 'auth_token cookie',
    placeholder: 'eyJhbGciOi...',
    /* Taller: a JWT is well over a thousand characters, and a three-row box makes it look as
       though something went wrong with the paste. */
    rows: 5,
    blurb:
      'Already in your browser if you are logged in to Segment, so there is nothing to create and nobody to ask. Reads the same workspaces you can see in the app.',
    caveat:
      'This is your whole login session, not a scoped token: it carries all of your access, in every workspace you can reach, and cannot be revoked without ending your session. It expires on its own after about a week. Use your own login rather than asking a customer for theirs.',
    where: null,
  },
]

/* Where the user put the screenshot. Served from `frontend/public`, which Vite copies verbatim
   into the build output -- so unlike an <img> tag inside index.html, a plain string path here is
   never rewritten for the production build, and falls through Django's SPA catch-all instead of
   reaching the file. `BASE_URL` is `/` in dev and `/static/` in the build Django actually serves. */
const COOKIE_SCREENSHOT = `${import.meta.env.BASE_URL}help/graph_ql_auth_token.png`

export default function ConnectDialog({ email, onConnected, onClose }) {
  /* The App session (auth_token) option is somebody's whole login session, not a scoped
     credential -- offered at all only to a signed-in Twilio account. Hiding it here is UX, not
     the boundary: the server refuses `credential=graphql` from anyone else regardless. */
  const credentials = useMemo(
    () => CREDENTIALS.filter((entry) => entry.id !== 'graphql' || email?.endsWith('@twilio.com')),
    [email],
  )

  const [credential, setCredential] = useState('public_api')
  const [token, setToken] = useState('')
  const [region, setRegion] = useState('us')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  /* Hidden by default every time the paste changes. A screen share should never expose what was
     just pasted here without a deliberate click to reveal it. */
  const [revealed, setRevealed] = useState(false)
  /* The `needsChoice` list, when the credential can see more than one workspace. Null the rest
     of the time, and it is what switches this dialog into its second step. */
  const [choices, setChoices] = useState(null)
  /* Set when the choice offered was the `segment-operator` gateway rather than a real workspace
     -- see `_OPERATOR_SLUG` server-side. Switches the second step into a slug prompt instead of
     the list, until that slug resolves and folds back into `choices`. */
  const [needsSlug, setNeedsSlug] = useState(false)
  const [slug, setSlug] = useState('')

  const active = credentials.find((entry) => entry.id === credential) ?? credentials[0]

  // If the tab that was selected disappears out from under the dialog -- e.g. someone signs out
  // of a Twilio account while it is still open -- fall back to the option that is always offered.
  useEffect(() => {
    if (!credentials.some((entry) => entry.id === credential)) setCredential('public_api')
  }, [credentials, credential])

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * One attempt, for either credential and either step.
   *
   * `workspaceId` is passed on the second step only. Written as one function rather than two
   * because the request, the error handling and the teardown are identical -- the only
   * difference is one field, and two copies would be two places to forget to clear the token.
   */
  async function attempt(workspaceId, workspaceSlug) {
    setSubmitting(true)
    setError(null)
    try {
      const result = await sessionApi.start(token.trim(), region, {
        credential,
        workspaceId,
        workspaceSlug,
      })

      /* The workspace clicked was the `segment-operator` gateway, not a real one -- ask for the
         exact slug instead of connecting. */
      if (result?.needsSlug) {
        setChoices(result.workspaces ?? [])
        setNeedsSlug(true)
        return
      }

      /* Not connected yet: the credential works but the workspace is still a question. Keep the
         token in state -- the next request has to carry it again, because nothing is stored
         server-side until a workspace is chosen. */
      if (result?.needsChoice) {
        setChoices(result.workspaces ?? [])
        setNeedsSlug(false)
        setSlug('')
        return
      }

      /* Clear it on the way out. It is already gone from the wire; there is no reason for it to
         sit in a React fiber too. */
      setToken('')
      setChoices(null)
      setNeedsSlug(false)
      onConnected(result.workspace, { claimed: result.claimed ?? 0 })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Check that it is running.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  function handleSubmit(event) {
    event.preventDefault()
    if (!token.trim() || submitting) return
    attempt()
  }

  function handleSlugSubmit(event) {
    event.preventDefault()
    if (!slug.trim() || submitting) return
    attempt(undefined, slug.trim())
  }

  /* Switching tabs drops whatever was pasted. The two credentials look nothing alike, so a
     token left in the box after a switch would be submitted against the wrong validator and
     rejected with a message about the wrong thing. */
  function pick(id) {
    setCredential(id)
    setToken('')
    setRevealed(false)
    setError(null)
    setChoices(null)
    setNeedsSlug(false)
    setSlug('')
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={handleSubmit}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-twilio-gray-20 bg-white shadow-lg"
      >
        <header className="flex items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="text-sm font-semibold text-twilio-navy">
            {choices ? 'Which workspace?' : 'Connect a workspace'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-twilio-gray-40 transition-colors hover:text-twilio-navy"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {needsSlug ? (
          <SlugPrompt
            slug={slug}
            onSlugChange={setSlug}
            onSubmit={handleSlugSubmit}
            submitting={submitting}
            error={error}
            onBack={() => {
              setNeedsSlug(false)
              setSlug('')
              setError(null)
            }}
          />
        ) : choices ? (
          <WorkspaceChoice
            workspaces={choices}
            submitting={submitting}
            error={error}
            onPick={(id) => attempt(id)}
            onBack={() => {
              setChoices(null)
              setError(null)
            }}
          />
        ) : (
          <div className="p-5">
            <p className="text-xs leading-relaxed text-twilio-gray-60">
              Only needed to read a customer&apos;s live sources, destinations and audiences.
              Everything you have drawn so far stays, and moves across with you.
            </p>

            {/* Two tabs, same size, same weight, no default recommendation. */}
            <div
              role="tablist"
              aria-label="How to connect"
              className="mt-4 flex gap-2"
            >
              {credentials.map((entry) => {
                const Icon = entry.icon
                const chosen = entry.id === credential
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={chosen}
                    onClick={() => pick(entry.id)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                      chosen
                        ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                        : 'border-twilio-gray-20 text-twilio-gray-60 hover:text-twilio-navy'
                    }`}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {entry.tab}
                  </button>
                )
              })}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-twilio-gray-60">{active.blurb}</p>

            {active.caveat && (
              /* Amber rather than red. It is a fact about the credential the user has chosen,
                 not an error and not a refusal -- the option is offered, and this is what
                 choosing it means. */
              <p className="mt-3 flex items-start gap-2 rounded-md border border-twilio-warning/40 bg-twilio-warning/10 p-3 text-xs leading-relaxed text-twilio-navy">
                <TriangleAlert
                  size={14}
                  className="mt-0.5 shrink-0 text-twilio-warning"
                  aria-hidden="true"
                />
                {active.caveat}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between">
              <label
                htmlFor="token"
                className="flex items-center gap-2 text-sm font-medium text-twilio-navy"
              >
                <active.icon size={16} aria-hidden="true" />
                {active.label}
              </label>
              {/* Hidden by default -- a screen share should never expose what was just pasted
                  without a deliberate click to reveal it. */}
              <button
                type="button"
                onClick={() => setRevealed((prev) => !prev)}
                disabled={!token}
                className="flex items-center gap-1 text-xs text-twilio-gray-60 transition-colors hover:text-twilio-navy disabled:cursor-not-allowed disabled:opacity-40"
              >
                {revealed ? (
                  <EyeOff size={13} aria-hidden="true" />
                ) : (
                  <Eye size={13} aria-hidden="true" />
                )}
                {revealed ? 'Hide' : 'Reveal'}
              </button>
            </div>
            <div className="relative mt-2">
              <textarea
                id="token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                rows={active.rows}
                autoComplete="off"
                spellCheck={false}
                placeholder={active.placeholder}
                className={`w-full resize-none break-all rounded-md border border-twilio-gray-20 p-3 font-mono text-xs outline-none focus:border-twilio-blue focus:ring-2 focus:ring-twilio-blue/20 ${
                  revealed || !token ? 'text-twilio-navy' : 'text-transparent'
                }`}
              />
              {/* Painted over the real text rather than instead of it -- the textarea keeps the
                  actual value (and the caret), so paste, selection and submission all still work
                  on the real thing. This is purely what gets drawn on screen during a share. */}
              {!revealed && token && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-all p-3 font-mono text-xs text-twilio-navy"
                >
                  {'•'.repeat(Math.min(token.length, 400))}
                </div>
              )}
            </div>

            {credential === 'graphql' && <CookieHelp />}

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-twilio-navy">Region</legend>
              {credential === 'graphql' && (
                /* Said out loud, because the field stays enabled and a user who picks the wrong
                   one should not think they have broken something. The gateway's answer carries
                   the workspace's real region and the server stores that instead. */
                <p className="mt-1 text-xs text-twilio-gray-60">
                  A starting point only — your session can see workspaces in both regions, and
                  whichever you connect brings its own.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                {REGIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex-1 cursor-pointer rounded-md border p-3 text-sm ${
                      region === option.value
                        ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                        : 'border-twilio-gray-20 text-twilio-gray-60'
                    }`}
                  >
                    <input
                      type="radio"
                      name="region"
                      value={option.value}
                      checked={region === option.value}
                      onChange={() => setRegion(option.value)}
                      className="sr-only"
                    />
                    <span className="font-medium">{option.label}</span>
                    <span className="mt-1 block font-mono text-[11px] opacity-70">
                      {option.hint}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && <ErrorNote message={error} />}

            <button
              type="submit"
              disabled={submitting || !token.trim()}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-twilio-blue px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {submitting ? 'Validating with Segment…' : 'Connect workspace'}
            </button>

            <p className="mt-4 flex items-start gap-2 text-xs text-twilio-gray-60">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Validated against Segment, then encrypted and stored server-side. It is never sent
              back to this browser, and write keys stay masked until you explicitly reveal one.
            </p>
            {active.where && (
              <p className="mt-3 text-xs text-twilio-gray-60">Need one? {active.where}</p>
            )}
            {credential === 'graphql' && (
              /* The boundary, said before they connect rather than discovered afterwards from a
                 button that will not work. */
              <p className="mt-3 text-xs text-twilio-gray-60">
                An app session identifies the workspace, but loading its sources, destinations
                and audiences still needs a Public API token — those reads have no GraphQL
                equivalent in this app yet.
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  )
}

/**
 * How to get the cookie out of the browser, with the screenshot.
 *
 * Collapsed by default. Anyone who has done it once does not need six lines of instructions
 * every time, and anyone who has not needs the picture more than the prose -- so the summary is
 * the affordance and the image is the answer.
 */
function CookieHelp() {
  return (
    <details className="mt-2 rounded-md border border-twilio-gray-20 bg-twilio-gray-10/50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-twilio-navy">
        Where do I find auth_token?
      </summary>
      <div className="border-t border-twilio-gray-20 px-3 py-3">
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-twilio-gray-60">
          <li>
            Open <span className="font-mono">app.segment.com</span> and log in to the workspace
            you want to read.
          </li>
          <li>Open the browser inspector and go to the Application tab.</li>
          <li>
            Under Cookies, pick the <span className="font-mono">.app.segment.com</span> domain.
          </li>
          <li>
            Find <span className="font-mono">auth_token</span> and copy its whole value — it is
            long, so check you have all of it.
          </li>
        </ol>
        <img
          src={COOKIE_SCREENSHOT}
          /* Long, and describes what the reader is looking for rather than the picture. Someone
             using a screen reader cannot use the screenshot at all, so the alt text has to
             carry the same instruction the image does. */
          alt="The browser inspector's Application tab, with Cookies expanded, the .app.segment.com domain selected, and the auth_token row highlighted in the list of cookies."
          className="mt-3 w-full rounded border border-twilio-gray-20"
          /* Lazy, because the details element is closed on first render and most users will
             never open it. */
          loading="lazy"
        />
      </div>
    </details>
  )
}

/**
 * Step two: which of the workspaces this login can see.
 *
 * A list of buttons rather than a dropdown and a submit. Picking one *is* the action, and a
 * select plus a confirm would be two gestures for one decision -- on a list of two hundred, the
 * scroll is the hard part and a second click adds nothing.
 */
function WorkspaceChoice({ workspaces, submitting, error, onPick, onBack }) {
  return (
    <div className="p-5">
      <p className="text-xs leading-relaxed text-twilio-gray-60">
        That session can see {workspaces.length} workspaces. Pick the one to read — nothing is
        stored until you do.
      </p>

      {error && <ErrorNote message={error} />}

      <ul className="mt-4 max-h-72 space-y-1 overflow-y-auto">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onPick(workspace.id)}
              className="w-full rounded-md border border-twilio-gray-20 px-3 py-2 text-left transition-colors hover:border-twilio-blue hover:bg-twilio-blue-light disabled:opacity-50"
            >
              <span className="block truncate text-sm font-medium text-twilio-navy">
                {workspace.name || workspace.slug}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px] text-twilio-gray-60">
                {workspace.slug}
                {/* Shown per row, because a session spanning both regions is exactly the case
                    the region radio could not answer for. */}
                {workspace.region && ` · ${workspace.region.toUpperCase()}`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onBack}
        className="mt-4 flex items-center gap-1.5 text-xs text-twilio-gray-60 transition-colors hover:text-twilio-navy"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Use a different credential
      </button>
    </div>
  )
}

/**
 * The `segment-operator` gateway's second step: type the exact slug of the workspace
 * you actually want, rather than picking from a list that cannot include it.
 *
 * A signed-in account's resolved slug is bookmarked server-side, so this is a one-time
 * cost per workspace -- it reappears in the ordinary list on the next connect.
 */
function SlugPrompt({ slug, onSlugChange, onSubmit, submitting, error, onBack }) {
  return (
    <div className="p-5">
      <p className="text-xs leading-relaxed text-twilio-gray-60">
        That entry is a gateway, not a workspace. Type the exact slug of the workspace you want
        to read — once it resolves, it is added to your list for next time.
      </p>

      <form onSubmit={onSubmit}>
        <label
          htmlFor="operator-slug"
          className="mt-4 block text-sm font-medium text-twilio-navy"
        >
          Workspace slug
        </label>
        <input
          id="operator-slug"
          type="text"
          value={slug}
          onChange={(event) => onSlugChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="acme-corp"
          className="mt-2 w-full rounded-md border border-twilio-gray-20 p-3 font-mono text-xs text-twilio-navy outline-none focus:border-twilio-blue focus:ring-2 focus:ring-twilio-blue/20"
        />

        {error && <ErrorNote message={error} />}

        <button
          type="submit"
          disabled={submitting || !slug.trim()}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-twilio-blue px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {submitting ? 'Looking it up…' : 'Find workspace'}
        </button>
      </form>

      <button
        type="button"
        onClick={onBack}
        className="mt-4 flex items-center gap-1.5 text-xs text-twilio-gray-60 transition-colors hover:text-twilio-navy"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Back to the list
      </button>
    </div>
  )
}

function ErrorNote({ message }) {
  return (
    <p
      role="alert"
      className="mt-4 flex items-start gap-2 rounded-md bg-twilio-red-light p-3 text-sm text-twilio-red-dark"
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  )
}
