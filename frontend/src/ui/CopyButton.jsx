/*
 * Lifted from segment-playground/src/components/common/CopyButton.jsx, restyled
 * onto the Twilio tokens and with two changes worth noting:
 *
 *   - `nodrag`, because these appear inside React Flow's surface, which otherwise
 *     interprets the mousedown as the start of a canvas drag.
 *   - the clipboard failure is surfaced rather than only console.error'd. A copy
 *     that silently does nothing is the kind of thing people retry five times.
 */

import { useState } from 'react'
import { Check, Copy, X } from 'lucide-react'

/**
 * @param text  the string to copy, or a function returning it.
 *
 * A function is for a value that is expensive to build or that has to be current at the moment of
 * the click -- a diagnostics report is both: assembling it on every render would rebuild a few
 * hundred lines whenever anything on the canvas moved, and the timestamp in it should say when it
 * was copied rather than when the button last rendered.
 */
export default function CopyButton({ text, label = 'Copy to clipboard', size = 13 }) {
  const [state, setState] = useState('idle') // idle | copied | failed

  const copy = async (event) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText((typeof text === 'function' ? text() : text) ?? '')
      setState('copied')
    } catch {
      // Denied permission, or a non-secure context.
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy

  return (
    <button
      type="button"
      onClick={copy}
      title={state === 'failed' ? 'Could not access the clipboard' : label}
      className={`nodrag inline-flex shrink-0 items-center transition-colors ${
        state === 'copied'
          ? 'text-twilio-success'
          : state === 'failed'
            ? 'text-twilio-error'
            : 'text-twilio-gray-40 hover:text-twilio-blue'
      }`}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  )
}
