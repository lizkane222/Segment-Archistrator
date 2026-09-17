/*
 * A rich label, drawn.
 *
 * React elements built from the model in canvas/richText.js -- never `dangerouslySetInnerHTML`.
 * That is the whole reason the model exists: a diagram can be shared with a workspace, so one
 * person's label is rendered in another person's browser, and a stored HTML fragment would be a
 * stored-XSS surface guarded only by a sanitiser that has to stay right forever. Runs cannot
 * express a `<script>`, so there is nothing to guard.
 *
 * Falls back to the plain string, which is what every node that has never been formatted still
 * carries: a card whose name has only ever been typed in the inspector has `name` and no
 * `nameRich`, and it must render exactly as it did before any of this existed.
 */

import { memo } from 'react'

import { isEmptyRich } from '../richText.js'

/**
 * @param value  the rich value, or null
 * @param text   the plain fallback -- `data.name`, `data.label`, a cell's text
 * @param align  'left' | 'center' | 'right'. A node-wide property (`data.style.textAlign`)
 *   rather than a per-block one, because alignment is a decision about the label and offering
 *   it per line is a feature nobody has asked for and another axis for the normaliser to
 *   compare.
 */
function RichLabel({ value, text = '', align, className = '', style }) {
  const rich = value && !isEmptyRich(value) ? value : null

  if (!rich) {
    /* `whitespace-pre-wrap` even here, so a plain label with a newline in it -- pasted, or
       typed before it was formatted -- wraps the way the rich one would rather than collapsing
       onto a single line. */
    return (
      <span className={`whitespace-pre-wrap break-words ${className}`} style={{ textAlign: align, ...style }}>
        {text}
      </span>
    )
  }

  const blocks = rich.blocks ?? []

  return (
    <span
      className={`block whitespace-pre-wrap break-words ${className}`}
      style={{ textAlign: align, ...style }}
    >
      {blocks.map((block, index) => (
        /*
         * Keyed by index, which is right here and usually is not: these are lines of one label
         * with no identity of their own, they are re-rendered whole on every edit, and nothing
         * inside them holds state that could be attached to the wrong line.
         */
        <Block key={index} block={block} ordinal={ordinalOf(blocks, index)} />
      ))}
    </span>
  )
}

function Block({ block, ordinal }) {
  const runs = block.runs ?? []
  const content = runs.map((run, index) => <Run key={index} run={run} />)

  if (!block.list) return <span className="block">{content}</span>

  /* A real marker rather than a `<ul>`: the label is inside a shape or a table cell whose height
     is being negotiated by CSS grid and flexbox, and a list element brings its own margins and
     padding that would push the text off its own centre line. The marker is drawn and the text
     hangs beside it. */
  return (
    <span className="flex gap-1.5">
      <span aria-hidden="true" className="shrink-0 tabular-nums opacity-70">
        {block.list === 'number' ? `${ordinal}.` : '•'}
      </span>
      <span className="min-w-0 flex-1">{content}</span>
    </span>
  )
}

/*
 * Which number a numbered item shows.
 *
 * Counted from the start of the *run of numbered lines it belongs to*, not from the top of the
 * label, so a label with two separate numbered lists does not number the second one 4, 5, 6.
 * Anything that is not a numbered line breaks the run, which is what an intervening paragraph
 * or bullet means to a reader.
 */
function ordinalOf(blocks, index) {
  let count = 0
  for (let at = 0; at <= index; at += 1) {
    if (blocks[at]?.list === 'number') count += 1
    else count = 0
  }
  return count
}

function Run({ run }) {
  const text = run.text ?? ''
  /* Nested elements rather than one span with a style object, so the markup says what it means
     and a screen reader reads the emphasis. Order is fixed rather than following the order the
     marks were applied in -- `<b><i>` and `<i><b>` render identically, and a fixed order means
     two identically-formatted labels produce identical trees. */
  let content = text
  if (run.s) content = <s>{content}</s>
  if (run.u) content = <u>{content}</u>
  if (run.i) content = <em>{content}</em>
  if (run.b) content = <strong>{content}</strong>
  return <>{content}</>
}

export default memo(RichLabel)
