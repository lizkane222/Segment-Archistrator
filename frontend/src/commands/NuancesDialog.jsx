/*
 * Nuances for one kind of component: known product gaps, known bugs, the ordering that
 * only bites you once.
 *
 * Submissions are shown verbatim. Stage 6 adds the pass that makes a pile of them
 * succinct, and until then a note written by hand is better than a summary written by
 * nothing.
 *
 * The warning above the textarea is not decoration. The table has no workspace column
 * on purpose -- these are read by every workspace -- so nothing on the server can stop
 * a customer's name being typed into the body. Saying so at the moment of typing is the
 * only control there is, which is why it sits against the field rather than in a
 * tooltip or a help page.
 */

import { useEffect, useState } from 'react'
import { Loader2, Send, TriangleAlert, X } from 'lucide-react'

import { nuances as api } from '../services/api.js'

export default function NuancesDialog({ kind, slug, label, canSubmit, onClose, onNotify }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    api
      .list(kind, slug || undefined)
      .then((result) => !cancelled && setItems(result.items ?? []))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [kind, slug])

  const submit = async (event) => {
    event.preventDefault()
    const text = body.trim()
    if (!text) return

    setSending(true)
    try {
      const created = await api.submit({ kind, slug: slug ?? '', body: text })
      /* Prepended rather than re-fetched: the list is newest-first, so this is the
         same answer the server would give and it does not blank the panel to say so. */
      setItems((current) => [created, ...(current ?? [])])
      setBody('')
      onNotify?.({ tone: 'success', message: 'Nuance submitted. Everyone will see it.' })
    } catch (err) {
      onNotify?.({ tone: 'error', message: err.message })
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-twilio-gray-20 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-twilio-navy">Nuances</h2>
            <p className="truncate text-[11px] text-twilio-gray-60">
              {label}
              {slug ? ` · ${slug}` : ''} — what Twilions have learned about this that the
              docs do not say.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-navy"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items === null && !error && (
            <p className="flex items-center gap-2 px-4 py-6 text-xs text-twilio-gray-60">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              Loading…
            </p>
          )}

          {error && (
            <p className="flex items-start gap-2 bg-twilio-red-light px-4 py-2 text-xs text-twilio-navy">
              <TriangleAlert size={13} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
              {error}
            </p>
          )}

          {items?.length === 0 && (
            <p className="px-4 py-6 text-xs text-twilio-gray-60">
              Nothing recorded for this component type yet. If you know something, it is
              worth the thirty seconds.
            </p>
          )}

          <ul className="divide-y divide-twilio-gray-20">
            {(items ?? []).map((item) => (
              <li key={item.id} className="px-4 py-3">
                <p className="whitespace-pre-wrap text-[12px] leading-snug text-twilio-navy">
                  {item.body}
                </p>
                <p className="mt-1 text-[10px] text-twilio-gray-40">
                  {item.slug ? `${item.slug} · ` : ''}
                  {new Date(item.createdAt).toLocaleDateString()}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <form onSubmit={submit} className="shrink-0 border-t border-twilio-gray-20 p-3">
          <label className="block text-[11px] font-semibold text-twilio-navy" htmlFor="nuance-body">
            Add one
          </label>
          <p className="mb-1.5 mt-0.5 flex items-start gap-1.5 text-[10px] leading-snug text-twilio-gray-60">
            <TriangleAlert size={11} className="mt-px shrink-0 text-twilio-warning" aria-hidden="true" />
            <span>
              Every workspace sees this, so write it as a fact about Segment.{' '}
              <strong className="font-semibold">Name no customer</strong> — not the
              company, the space, the source, or the event.
            </span>
          </p>
          <textarea
            id="nuance-body"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            disabled={!canSubmit}
            placeholder={
              canSubmit
                ? 'e.g. a destination filter on a blocked event still counts toward MTUs.'
                : 'Start a session to submit.'
            }
            className="w-full resize-y rounded border border-twilio-gray-20 px-2 py-1.5 text-[12px] text-twilio-navy placeholder:text-twilio-gray-40 focus:border-twilio-blue focus:outline-none disabled:bg-twilio-gray-10"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={!canSubmit || sending || !body.trim()}
              className="flex items-center gap-1.5 rounded bg-twilio-blue px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-twilio-blue-dark disabled:cursor-not-allowed disabled:bg-twilio-gray-40"
            >
              {sending ? (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              ) : (
                <Send size={12} aria-hidden="true" />
              )}
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
