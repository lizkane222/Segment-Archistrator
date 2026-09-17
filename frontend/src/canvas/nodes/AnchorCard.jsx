/*
 * The anchor note: one stop on the walkthrough.
 *
 * Two readings, and only ever one at a time. Handed a `step` it answers "what happened
 * to *this* event", because that is the question someone watching a walkthrough is
 * holding; without one it answers "what does this component do", which is the
 * architecture overview. Showing both at once was tried on paper and produced a panel
 * large enough to cover the components either side of it.
 *
 * Markup only, with no opinion about where it sits: the difference between the two
 * readings is one the *narration* draws (simulation/narration.js), not one the layout
 * should. Its only home is the notes lane (simulation/NotesLane.jsx) -- see the note at
 * the foot of this file for the two homes it used to have and why neither survived.
 */

import { Info, TriangleAlert } from 'lucide-react'

const STATUS_TONE = {
  origin: 'bg-twilio-blue text-white',
  passed: 'bg-twilio-blue text-white',
  transformed: 'bg-twilio-warning text-white',
  delivered: 'bg-twilio-success text-white',
  matched: 'bg-twilio-success text-white',
  dropped: 'bg-twilio-error text-white',
  blocked: 'bg-twilio-error text-white',
  unmatched: 'bg-twilio-error text-white',
}

/* Undecided, not-evaluated and not-applicable share this: all three mean the
   simulation is declining to answer, and colouring them like a verdict would read
   as one. */
const UNDECIDED_TONE = 'bg-twilio-gray-40 text-white'

/**
 * The note itself.
 *
 * Nothing is truncated to two lines any more. That existed for the gutter, whose column had to be
 * stacked without measuring the DOM and so gave every note a fixed height; the lane scrolls sideways
 * instead, so a card is as tall as what it has to say.
 */
export function AnchorCard({ name, anchor, step }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-40">
          {anchor?.title}
        </span>
        {step ? (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
              STATUS_TONE[step.status] ?? UNDECIDED_TONE
            }`}
          >
            {step.title}
          </span>
        ) : null}
      </div>

      {name && <p className="mt-0.5 truncate text-xs font-semibold text-twilio-navy">{name}</p>}

      {step ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-twilio-gray-60">{step.reason}</p>
      ) : (
        <>
          <p className="mt-1.5 text-[11px] leading-relaxed text-twilio-gray-60">{anchor.what}</p>
          <p className="mt-1.5 flex gap-1 text-[11px] leading-relaxed text-twilio-gray-40">
            <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{anchor.why}</span>
          </p>
        </>
      )}

      {anchor?.caveat && (
        <p className="mt-1.5 flex gap-1 border-t border-twilio-gray-10 pt-1.5 text-[11px] leading-relaxed text-twilio-gray-60">
          <TriangleAlert size={11} className="mt-0.5 shrink-0 text-twilio-warning" aria-hidden="true" />
          <span>{anchor.caveat}</span>
        </p>
      )}
    </>
  )
}

/* There used to be an `AnchorTooltip` here as well -- this card inside a `NodeToolbar`, floating over
   the component it described. It is gone, and its absence is the feature: a card is wider than a
   component and taller than the row gap, so every one of them covered the components either side of
   the thing it was explaining. The lane is the only home now. */
