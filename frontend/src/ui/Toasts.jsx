/*
 * Toasts, for the refusals the canvas has to explain.
 *
 * The brief's rule enforcement is only useful if a rejected drop or connection
 * says *why* and names the correct zone. Silently snapping a node back reads as a
 * bug, not a rule.
 *
 * Deliberately tiny -- no portal, no animation library, no queue limit beyond a
 * hard cap. A dependency for this would be more code than the thing itself.
 */

import { useCallback, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

const MAX_VISIBLE = 4
const DISMISS_AFTER = 6000

const ICONS = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
}

const TONES = {
  error: 'border-twilio-error bg-twilio-red-light text-twilio-navy',
  success: 'border-twilio-success bg-white text-twilio-navy',
  info: 'border-twilio-gray-40 bg-white text-twilio-navy',
}

export function useToasts() {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const notify = useCallback(
    ({ message, tone = 'info' }) => {
      if (!message) return
      const id = crypto.randomUUID()
      setToasts((current) => {
        /* Repeating the same refusal is common -- someone tries the same illegal
           edge twice. Replacing rather than stacking keeps it readable. */
        const deduped = current.filter((toast) => toast.message !== message)
        return [...deduped, { id, message, tone }].slice(-MAX_VISIBLE)
      })
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_AFTER),
      )
    },
    [dismiss],
  )

  return { toasts, notify, dismiss }
}

export function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null

  return (
    <div
      className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone] ?? Info
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border-l-4 px-3 py-2 shadow-lg ${
              TONES[toast.tone] ?? TONES.info
            }`}
          >
            <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-[12px] leading-snug">{toast.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 opacity-50 hover:opacity-100"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
