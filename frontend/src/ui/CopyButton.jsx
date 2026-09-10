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

export default function CopyButton({ text, label = 'Copy to clipboard', size = 13 }) {
  const [state, setState] = useState('idle') // idle | copied | failed

  const copy = async (event) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(text ?? '')
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
