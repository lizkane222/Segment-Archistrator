/*
 * The account corner of the header.
 *
 * Separate from the workspace controls beside it because they answer different
 * questions, and conflating them is the mistake this whole change is unpicking: the
 * workspace controls are about *which customer's components* are on screen, this is
 * about *who you are* and therefore whether your work survives closing the tab.
 *
 * "Log out" and "Disconnect" are both here in spirit but only one is here in fact.
 * Disconnect drops a Segment credential and lives with the workspace controls; logging
 * out drops the account and lives here. They used to be one button, which was fine when
 * there was nothing to be signed in to.
 */

import { useEffect, useRef, useState } from 'react'
import { LogOut, Mail, ShieldCheck, UserRound } from 'lucide-react'

import { accountInitials, accountLabel, canInvite, canSignIn, persistenceNote } from './session.js'

export default function AccountMenu({ state, onLogOut, onInvite }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef(null)

  /* Close on an outside click or Escape. Both, because a menu that traps the pointer is
     worse than no menu, and this one sits next to controls people reach for constantly. */
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!wrapper.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  /* Nothing to offer: no account, and no configured way to get one. Rendering a dead
     button would be worse than rendering nothing -- it implies the server can honour a
     click it cannot. */
  if (!state.account && !canSignIn(state)) return null

  if (canSignIn(state)) {
    return (
      <>
      <Divider />
      {/* An anchor, not a button with a handler. The target answers with a cross-origin
          redirect to Google, which a fetch cannot follow usefully -- the browser itself
          has to leave. */}
      <a
        href="/api/auth/google/start"
        className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
        title="Keep your diagrams after this browser session ends"
      >
        <ShieldCheck size={13} aria-hidden="true" />
        Sign in
      </a>
      </>
    )
  }

  const label = accountLabel(state.account)

  return (
    <>
    <Divider />
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={state.account.email}
        className="flex items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-xs text-twilio-navy transition-colors hover:border-twilio-gray-20"
      >
        {/* Initials rather than the Google profile picture. Rendering an
            lh3.googleusercontent.com URL would make every page load report to Google who
            is using this tool and when, which is not a thing a diagramming app needs to
            tell anyone. */}
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-twilio-blue text-[10px] font-semibold text-white">
          {accountInitials(state.account)}
        </span>
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>

      {open && (
        /* `right-0`: this is the rightmost control in the header, and anchoring left puts
           the panel off the edge of the window. Same reason the Theme menu does it. */
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-64 rounded-md border border-twilio-gray-20 bg-white shadow-lg"
        >
          <div className="border-b border-twilio-gray-20 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-twilio-navy">
              <UserRound size={12} aria-hidden="true" />
              {label}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-twilio-gray-60">{state.account.email}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-twilio-gray-60">
              {persistenceNote(state)}
            </p>
          </div>

          {canInvite(state) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onInvite()
              }}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
            >
              <Mail size={12} aria-hidden="true" />
              Invite someone…
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogOut()
            }}
            className="flex w-full items-center gap-1.5 border-t border-twilio-gray-20 px-3 py-2 text-left text-xs text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
          >
            <LogOut size={12} aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </div>
    </>
  )
}

/*
 * Separates the account controls from the workspace controls beside them.
 *
 * Rendered here rather than by the header, so it appears exactly when there is something
 * to separate. A deployment with no Google client and nobody signed in draws neither.
 */
function Divider() {
  return <span className="mx-1 h-5 w-px bg-twilio-gray-20" aria-hidden="true" />
}
