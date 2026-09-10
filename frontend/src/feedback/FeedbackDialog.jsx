/*
 * The feedback form.
 *
 * Four fields the user fills in; four more this app derives and never shows as inputs, because they are
 * not the reporter's to decide -- see `apps/feedback/serializers.py`. What *is* shown is the derived
 * title, live, under the description: it is how the report will appear in a list view, and someone who
 * can see it will write a first sentence that reads well there.
 *
 * ## Why this posts to our own backend
 *
 * The Airtable token has `data.records:write`. A token like that in a bundle is a token anyone with the
 * network tab open can use to write to the base, so it stays server-side and the form posts to
 * `/api/feedback`. There is no browser-safe write token; this is not a matter of preference.
 *
 * ## What it will not do
 *
 * It will not refuse a report for want of a proposed fix, a name, or a screenshot. The description is
 * the whole of what is needed, and a form that insists on more is a form people abandon -- which costs
 * the feedback the whole feature exists to collect.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, MessageSquarePlus, Paperclip, X } from 'lucide-react'

import { ApiError, feedback as feedbackApi } from '../services/api.js'
import { problemTitle } from './title.js'

export default function FeedbackDialog({ config, onClose }) {
  const [description, setDescription] = useState('')
  const [proposedFix, setProposedFix] = useState('')
  const [reporter, setReporter] = useState('')
  const [files, setFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const picker = useRef(null)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* The same derivation the server will do, run here purely so the reporter can see it. The server's is
     the one that is stored -- this is a preview and is never sent, so the two cannot disagree about what
     was recorded. */
  const title = useMemo(() => problemTitle(description), [description])

  const maxFiles = config?.maxAttachments ?? 5
  const maxBytes = config?.maxAttachmentBytes ?? Infinity
  const tooLong = files.filter((file) => file.size > maxBytes)
  const ready = description.trim().length >= 10 && !tooLong.length && !submitting

  const pick = (event) => {
    const chosen = [...(event.target.files ?? [])]
    setFiles((current) => [...current, ...chosen].slice(0, maxFiles))
    /* Cleared, so choosing the same file again fires `change` a second time. */
    event.target.value = ''
  }

  async function submit(event) {
    event.preventDefault()
    if (!ready) return
    setSubmitting(true)
    setError(null)
    try {
      setDone(await feedbackApi.submit({ description, proposedFix, reporter, files }))
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

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-twilio-gray-20 bg-white shadow-lg"
      >
        <header className="flex items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-twilio-navy">
            <MessageSquarePlus size={15} aria-hidden="true" />
            Report a problem
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

        {done ? (
          <div className="p-5">
            <p className="flex items-start gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Recorded as <strong>{done.title}</strong>.
                {done.attached > 0 &&
                  ` ${done.attached} file${done.attached === 1 ? '' : 's'} attached.`}
              </span>
            </p>
            {/* Named, not counted, so a retry can be aimed at the one that failed rather than at
                everything. The record itself is safe either way -- it is created before any upload. */}
            {done.attachmentsFailed?.length > 0 && (
              <p className="mt-2 text-xs text-twilio-gray-60">
                {done.attachmentsFailed.join(', ')} could not be attached. The report itself was saved.
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="mt-4 w-full rounded-md bg-twilio-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-twilio-blue-dark"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-5">
            <label htmlFor="fb-description" className="text-sm font-medium text-twilio-navy">
              What went wrong?
            </label>
            <textarea
              id="fb-description"
              autoFocus
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="The zones stay dimmed after a walkthrough finishes, and clicking the canvas does not clear it."
              className="mt-1.5 w-full resize-y rounded-md border border-twilio-gray-20 p-2.5 text-xs outline-none focus:border-twilio-blue"
            />
            {/* The derived title, live. Someone who can see how their report will be filed writes a first
                sentence that reads well in a list view -- which is the point of deriving it from the
                description rather than asking for it as a separate field. */}
            {description.trim() && (
              <p className="mt-1 text-[11px] text-twilio-gray-60">
                Will be filed as <span className="font-semibold text-twilio-navy">{title}</span>
              </p>
            )}

            <label htmlFor="fb-fix" className="mt-4 block text-sm font-medium text-twilio-navy">
              What do you think would fix it?{' '}
              <span className="font-normal text-twilio-gray-40">optional</span>
            </label>
            <textarea
              id="fb-fix"
              value={proposedFix}
              onChange={(event) => setProposedFix(event.target.value)}
              rows={3}
              placeholder="Clearing the dimming when the transport stops, rather than when a new path is selected."
              className="mt-1.5 w-full resize-y rounded-md border border-twilio-gray-20 p-2.5 text-xs outline-none focus:border-twilio-blue"
            />

            <label htmlFor="fb-reporter" className="mt-4 block text-sm font-medium text-twilio-navy">
              Your name or email <span className="font-normal text-twilio-gray-40">optional</span>
            </label>
            <input
              id="fb-reporter"
              value={reporter}
              onChange={(event) => setReporter(event.target.value)}
              placeholder="So someone can come back to you about it"
              className="mt-1.5 w-full rounded-md border border-twilio-gray-20 p-2.5 text-xs outline-none focus:border-twilio-blue"
            />

            <div className="mt-4">
              <span className="text-sm font-medium text-twilio-navy">
                Attachments <span className="font-normal text-twilio-gray-40">optional</span>
              </span>
              <input ref={picker} type="file" multiple onChange={pick} className="hidden" />
              <button
                type="button"
                onClick={() => picker.current?.click()}
                disabled={files.length >= maxFiles}
                className="mt-1.5 flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue disabled:opacity-40"
              >
                <Paperclip size={13} aria-hidden="true" />
                Add a file
              </button>

              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}:${index}`}
                      className="flex items-center gap-2 text-[11px] text-twilio-gray-60"
                    >
                      <span className="min-w-0 flex-1 truncate" title={file.name}>
                        {file.name}
                      </span>
                      <span className="shrink-0 tabular-nums">{Math.ceil(file.size / 1024)} KB</span>
                      <button
                        type="button"
                        onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}
                        className="shrink-0 text-twilio-gray-40 hover:text-twilio-navy"
                        title={`Remove ${file.name}`}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {tooLong.length > 0 && (
                <p className="mt-1.5 text-[11px] text-twilio-red-dark">
                  {tooLong.map((file) => file.name).join(', ')} is over the{' '}
                  {Math.round(maxBytes / (1024 * 1024))}MB limit.
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-md bg-twilio-red-light p-3 text-sm text-twilio-red-dark"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!ready}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-twilio-blue px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
              {submitting ? 'Sending…' : 'Send'}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-twilio-gray-60">
              Goes to the team&rsquo;s Airtable. The status, the timestamp and which app it came from are
              filled in automatically — you do not need to.
            </p>
          </div>
        )}
      </form>
    </div>
  )
}
