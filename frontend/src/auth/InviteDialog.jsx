/*
 * Let somebody else in.
 *
 * An invitation here is pre-authorization for one email address and nothing more. **No
 * mail is sent** -- this app has no email backend -- so the copy says that plainly and
 * tells the inviter to pass the URL along themselves. A dialog that said "invitation
 * sent" would leave the other person waiting for a message that is never coming, which
 * is the one failure mode worth designing against here.
 *
 * Structured like ConnectDialog: backdrop click and Escape to close, one error channel,
 * and the list of what already exists in the same place as the form that adds to it --
 * because "did I already invite them?" is the question you have the moment you open this.
 */

import { useEffect, useState } from 'react'
import { Loader2, Mail, TriangleAlert, X } from 'lucide-react'

import { ApiError, invitations as invitationsApi } from '../services/api.js'

export default function InviteDialog({ onClose }) {
  const [email, setEmail] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    invitationsApi
      .list()
      .then((result) => !cancelled && setItems(result?.items ?? []))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(event) {
    event.preventDefault()
    const address = email.trim()
    if (!address) return

    setSubmitting(true)
    setError(null)
    setNote(null)
    try {
      const result = await invitationsApi.create(address)
      setEmail('')
      setNote(
        result?.alreadyInvited
          ? `${result.invitation.email} was already invited. Nothing new was sent — there is no email to send.`
          : `${result.invitation.email} can now sign in. Send them the link to this app.`,
      )
      const refreshed = await invitationsApi.list()
      setItems(refreshed?.items ?? [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="text-sm font-semibold text-twilio-navy">Invite someone</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-twilio-gray-40 transition-colors hover:text-twilio-navy"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="text-[11px] leading-relaxed text-twilio-gray-60">
            This lets one email address sign in with Google. It does{' '}
            <span className="font-semibold text-twilio-navy">not</span> send them anything —
            there is no email service here — so you will need to pass this app&apos;s link
            along yourself.
          </p>

          <label className="mt-3 block">
            <span className="text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60">
              Email address
            </span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="colleague@example.com"
              autoFocus
              className="mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1.5 font-mono text-xs text-twilio-navy focus:border-twilio-blue focus:outline-none"
            />
          </label>

          {error && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 rounded border border-twilio-error bg-twilio-red-light px-2.5 py-2 text-[11px] text-twilio-navy"
            >
              <TriangleAlert size={12} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
              {error}
            </p>
          )}
          {note && (
            <p className="mt-3 rounded border border-twilio-gray-20 bg-twilio-gray-10 px-2.5 py-2 text-[11px] leading-relaxed text-twilio-navy">
              {note}
            </p>
          )}

          <div className="mt-4 border-t border-twilio-gray-20 pt-3">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60">
              Already invited
            </h3>
            {loading && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-twilio-gray-60">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                Loading…
              </p>
            )}
            {!loading && !items.length && (
              <p className="mt-2 text-[11px] italic text-twilio-gray-60">
                You have not invited anyone yet.
              </p>
            )}
            {items.map((invitation) => (
              <p
                key={invitation.id}
                className="mt-1.5 flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="truncate font-mono text-twilio-navy">{invitation.email}</span>
                <span
                  className={
                    invitation.pending
                      ? 'shrink-0 rounded bg-twilio-gray-10 px-1.5 py-0.5 text-[10px] text-twilio-gray-60'
                      : 'shrink-0 rounded bg-twilio-blue-light/50 px-1.5 py-0.5 text-[10px] text-twilio-blue'
                  }
                >
                  {invitation.pending ? 'not signed in yet' : 'signed in'}
                </span>
              </p>
            ))}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-twilio-gray-20 bg-twilio-gray-10 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-twilio-gray-20 bg-white px-3 py-1.5 text-xs text-twilio-gray-60 hover:text-twilio-navy"
          >
            Done
          </button>
          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Mail size={13} aria-hidden="true" />
            )}
            Allow this address
          </button>
        </footer>
      </form>
    </div>
  )
}
