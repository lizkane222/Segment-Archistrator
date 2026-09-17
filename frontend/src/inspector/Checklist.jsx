/*
 * The checklist: an ordered list of what a function does, each line ticked or crossed.
 *
 * Purely presentational. Every judgement it renders was made in ../functions/steps.js --
 * which line an item is anchored to, whether the run reached it, whether it could be
 * measured at all -- so this file has no opinion of its own to disagree with the gutter's.
 *
 * ## The four states, and why none of them collapse
 *
 * A tick and a cross are the point of the feature, and they are only two of the four things
 * that can be true. The other two exist because reporting them as a cross would be a claim
 * about the *function* when they are facts about the checklist or the runner:
 *
 *   done        the line ran
 *   missed      the line did not run -- the only honest red
 *   pending     nothing has been run yet, so there is nothing to say
 *   unanchored  the item has no line, so there is nothing to measure
 *   untracked   anchored, but the runner could not place a probe there
 *
 * The last one is the interesting one. `probePoint` refuses lines where inserting a probe
 * would change what the code means -- the unbraced body of an `if`, the inside of an object
 * literal, anything at module scope -- and an item on one of those is honestly unmeasurable.
 * Showing a red cross would tell the reader their function is broken.
 */

import { ArrowDown, ArrowUp, Check, ListChecks, Minus, Trash2, TriangleAlert, X } from 'lucide-react'

import { EmptyNote, Section } from './primitives.jsx'
import { summarizeSteps } from '../functions/steps.js'

const TONE = {
  done: {
    icon: Check,
    box: 'border-twilio-success/50 bg-green-50',
    mark: 'bg-twilio-success text-white',
    note: null,
  },
  missed: {
    icon: X,
    box: 'border-twilio-error/50 bg-twilio-red-light',
    mark: 'bg-twilio-error text-white',
    note: 'this line did not run',
  },
  pending: {
    icon: Minus,
    box: 'border-twilio-gray-20 bg-white',
    mark: 'bg-twilio-gray-20 text-twilio-gray-60',
    note: 'not run yet',
  },
  unanchored: {
    icon: TriangleAlert,
    box: 'border-twilio-warning/40 bg-orange-50',
    mark: 'bg-twilio-warning text-white',
    note: 'no line yet — press + beside a line in the code above',
  },
  untracked: {
    icon: TriangleAlert,
    box: 'border-twilio-warning/40 bg-orange-50',
    mark: 'bg-twilio-warning text-white',
    note: 'this line cannot be measured, so it is never ticked',
  },
}

export default function Checklist({ steps, onUpdate, onRemove, onMove, hasRun }) {
  const tally = summarizeSteps(steps)

  return (
    <Section
      title="Checklist"
      note="What this function is supposed to do, in order, each one tied to the line that does it. Run an event below and every step is ticked or crossed."
      actions={
        tally && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
              tally.done === tally.total
                ? 'bg-green-50 text-twilio-success'
                : 'bg-twilio-red-light text-twilio-red-dark'
            }`}
          >
            {tally.done}/{tally.total}
          </span>
        )
      }
    >
      {steps.length === 0 ? (
        <EmptyNote>
          <span className="flex items-start gap-1.5">
            <ListChecks size={12} className="mt-px shrink-0 text-twilio-gray-40" aria-hidden="true" />
            <span>
              Nothing yet. Hover a line of code above and press{' '}
              <span className="font-mono font-semibold">+</span> in the gutter to make it a step.
              Anchor the line that <em>does</em> the thing rather than the{' '}
              <span className="font-mono">if</span> above it — an{' '}
              <span className="font-mono">if</span> runs whether or not its branch is taken.
            </span>
          </span>
        </EmptyNote>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step, index) => (
            <Item
              key={step.id}
              step={step}
              position={index + 1}
              first={index === 0}
              last={index === steps.length - 1}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onMove={onMove}
            />
          ))}
        </ol>
      )}

      {tally && tally.missed.length > 0 && hasRun && (
        /* Named rather than left to be counted off the list. On a checklist of eight the
           useful sentence is which two did not happen, and that is the reason someone ran
           the event. */
        <p className="mt-2 text-[10px] leading-snug text-twilio-red-dark">
          The event did not reach{' '}
          {tally.missed.map((step) => `line ${step.line}`).join(', ')} — which may be exactly
          right, if this event was not meant to take that branch.
        </p>
      )}
    </Section>
  )
}

function Item({ step, position, first, last, onUpdate, onRemove, onMove }) {
  const tone = TONE[step.status] ?? TONE.pending
  const Icon = tone.icon

  return (
    <li className={`flex items-start gap-1.5 rounded-md border px-1.5 py-1 ${tone.box}`}>
      <span
        title={step.status}
        className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${tone.mark}`}
      >
        {step.status === 'done' || step.status === 'missed' ? (
          <Icon size={10} strokeWidth={3} aria-hidden="true" />
        ) : (
          position
        )}
      </span>

      <span className="min-w-0 flex-1">
        <input
          /* Addressed by id so the gutter badge can focus it -- clicking a step in the code
             should put the cursor in the sentence that describes it. */
          id={`step-${step.id}`}
          value={step.label ?? ''}
          onChange={(event) => onUpdate(step.id, { label: event.target.value })}
          placeholder="What happens here?"
          aria-label={`Step ${position} description`}
          className="nodrag w-full border-0 bg-transparent p-0 text-[11px] font-medium text-twilio-navy outline-none placeholder:font-normal placeholder:italic placeholder:text-twilio-gray-40"
        />
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-twilio-gray-60">
          {step.line ? (
            <span className="font-mono">line {step.line}</span>
          ) : (
            <span className="italic">unanchored</span>
          )}
          {tone.note && <span>· {tone.note}</span>}
        </span>
      </span>

      <span className="flex shrink-0 items-center">
        {/* Reordering is worth having because the list is a *narrative* -- "first it drops
            test traffic, then it redacts" -- and the order the anchors happen to sit in the
            file is not always the order worth reading them in. */}
        <button
          type="button"
          onClick={() => onMove(step.id, -1)}
          disabled={first}
          title="Move up"
          className="nodrag rounded p-0.5 text-twilio-gray-40 transition-colors hover:text-twilio-navy disabled:opacity-25"
        >
          <ArrowUp size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onMove(step.id, 1)}
          disabled={last}
          title="Move down"
          className="nodrag rounded p-0.5 text-twilio-gray-40 transition-colors hover:text-twilio-navy disabled:opacity-25"
        >
          <ArrowDown size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(step.id)}
          title="Delete this step, and its marker in the code"
          className="nodrag rounded p-0.5 text-twilio-gray-40 transition-colors hover:text-twilio-error"
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}
