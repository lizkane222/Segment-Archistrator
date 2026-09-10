/*
 * The anchor note: one stop on the walkthrough.
 *
 * Two readings, and only ever one at a time. With the playhead here it answers
 * "what happened to *this* event", because that is the question someone watching a
 * walkthrough is holding; with nothing running it answers "what does this component
 * do", which is the architecture overview. Showing both at once was tried on paper
 * and produced a panel large enough to cover the components either side of it.
 *
 * The card is exported on its own because it now has two homes. Attached to a node it
 * goes through `NodeToolbar`, which React Flow positions in flow space -- so the tooltip
 * tracks pan and zoom with no coordinate maths here. Stacked in the gutter with all the
 * others (canvas/AnchorGutter.jsx) it is placed by geometry instead. The text is the same
 * text either way, which is the point of splitting it: two copies of this markup would
 * drift, and the difference between the two readings is one the *narration* draws, not
 * one the layout should.
 */

import { NodeToolbar, Position } from '@xyflow/react'
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
 * The note itself, with no opinion about where it is.
 *
 * `clamped` is for the gutter, where a note has a fixed height so the column can be
 * stacked without measuring the DOM: it shows the first two lines of each paragraph and
 * folds the caveat down to the warning triangle in the header, so nothing is silently
 * missing -- the triangle is what says there is more to read. The gutter drops the clamp
 * on hover, which is the same gesture that draws the leader line.
 */
export function AnchorCard({ name, anchor, step, clamped = false }) {
  const clamp = clamped ? 'line-clamp-2' : ''

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
        ) : (
          clamped &&
          anchor?.caveat && (
            <TriangleAlert
              size={11}
              className="shrink-0 text-twilio-warning"
              aria-hidden="true"
            />
          )
        )}
      </div>

      {name && <p className="mt-0.5 truncate text-xs font-semibold text-twilio-navy">{name}</p>}

      {step ? (
        <p className={`mt-1.5 text-[11px] leading-relaxed text-twilio-gray-60 ${clamp}`}>
          {step.reason}
        </p>
      ) : (
        <>
          <p className={`mt-1.5 text-[11px] leading-relaxed text-twilio-gray-60 ${clamp}`}>
            {anchor.what}
          </p>
          <p className="mt-1.5 flex gap-1 text-[11px] leading-relaxed text-twilio-gray-40">
            <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className={clamp}>{anchor.why}</span>
          </p>
        </>
      )}

      {anchor?.caveat && !clamped && (
        <p className="mt-1.5 flex gap-1 border-t border-twilio-gray-10 pt-1.5 text-[11px] leading-relaxed text-twilio-gray-60">
          <TriangleAlert size={11} className="mt-0.5 shrink-0 text-twilio-warning" aria-hidden="true" />
          <span>{anchor.caveat}</span>
        </p>
      )}
    </>
  )
}

export default function AnchorTooltip({ visible, name, anchor, step }) {
  if (!visible || (!anchor && !step)) return null

  return (
    <NodeToolbar isVisible position={Position.Top} offset={12}>
      <div className="w-64 rounded-md border border-twilio-gray-20 bg-white p-2.5 text-left shadow-lg">
        <AnchorCard name={name} anchor={anchor} step={step} />
      </div>
    </NodeToolbar>
  )
}
