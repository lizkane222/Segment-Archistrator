/*
 * The code block in the sidebar: a foldable read view, and a textarea to change it in.
 *
 * ## Why two modes rather than one
 *
 * Folding and free-text editing genuinely fight each other. A `<textarea>` holds one
 * string, so a collapsed region is either still in that string (and the fold is a lie,
 * because the lines are right there) or it is not (and every edit near the seam has to
 * guess where the hidden text goes back). Editors that do both properly are built
 * around a document model, which is a dependency this tool has no other reason to
 * carry.
 *
 * So the two jobs are separated, along the line that the jobs themselves already fall
 * on. Folding is for *reading* -- the case is a 400-line function pasted out of a
 * workspace, where the reader wants the outline and then one handler. Editing is for
 * the twenty lines they came to change. The read view folds; pressing Edit swaps in a
 * plain textarea with the same line numbers and no chevrons, and says why when asked.
 *
 * Edit mode also asks the inspector to widen (see `onWide`), because a 384px column is
 * enough to *read* a function and not enough to work in one.
 *
 * ## What the gutter promises
 *
 * Line numbers are the *real* ones, and keep counting through a fold. That matters
 * because the numbers are load-bearing: ./prepare.js refuses an unguardable loop by
 * line, a compile error names one, and the checklist in ./steps.js anchors to one.
 *
 * The third column of the gutter is the checklist. A line carrying a step shows its
 * number; a line that *could* carry one offers a `+` on hover. Which lines those are is
 * not this component's opinion -- `anchorable` answers it, and it answers with the same
 * function the runner uses to place its probes, so the button cannot offer an anchor
 * that would then always read as a cross.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FoldVertical,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  UnfoldVertical,
  X,
} from 'lucide-react'

import { allFoldableLines, visibleRows } from './folds.js'
import { TOKEN, highlightLines } from './highlight.js'
import { anchorable } from './steps.js'

/* Fixed and shared by both modes, because the gutter is a separate scrolling element
   from the textarea beside it and they have to agree to the pixel. */
const LINE_HEIGHT = 18

/*
 * Tailwind classes rather than a stylesheet block: a handful of colours used in one
 * component is not a design token, and keeping them here puts the highlighter's vocabulary
 * next to the thing that renders it. Chosen off the palette in styles/tokens.css, and
 * deliberately avoiding red and green as *foreground* text -- on this canvas those two
 * already mean dropped and delivered.
 *
 * `segment` is the only bold one. It is Segment's own API surface -- the error classes, the
 * handler names, `Segment.track` -- and it is what someone scanning an unfamiliar function
 * is actually looking for. Bolding the parameters too would make most of the file bold and
 * the emphasis would stop meaning anything.
 */
const TOKEN_CLASS = {
  [TOKEN.comment]: 'text-twilio-gray-40 italic',
  [TOKEN.string]: 'text-[#0e7c3a]',
  [TOKEN.keyword]: 'text-[#043cb5]',
  [TOKEN.segment]: 'font-bold text-[#6f42c1]',
  [TOKEN.runtime]: 'text-[#6f42c1]',
  [TOKEN.number]: 'text-[#7a4a12]',
  [TOKEN.plain]: 'text-twilio-navy',
}

/* How a step's badge reads once an event has been through. The same three readings the
   canvas gives a component, for the same reason: nobody should have to reconcile two
   vocabularies between this panel and the diagram beside it. */
const STEP_TONE = {
  done: 'border-twilio-success bg-green-50 text-twilio-success',
  missed: 'border-twilio-error bg-twilio-red-light text-twilio-red-dark',
  untracked: 'border-twilio-warning bg-orange-50 text-twilio-warning',
  pending: 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark',
}

/**
 * @param value      the code
 * @param onChange   called per keystroke with the new draft. Cheap on purpose -- the
 *                   caller holds the draft and decides when it reaches the document.
 * @param onCommit   called when editing ends, which is when the change is worth paying
 *                   for: every commit replaces the node in React Flow's store, and
 *                   doing that per character is visible as lag on a large diagram.
 * @param max        the character cap. See MAX_CODE_LENGTH in ./defaults.js.
 * @param onRefuse   told when a paste was too long to accept, so the panel can say so
 *                   rather than the text silently not appearing.
 * @param steps      the resolved checklist -- `[{id, label, line, status}]` from
 *                   `checklistState`. Only the anchored ones matter here.
 * @param onAddStep  called with a 1-based line to anchor a new step to it.
 * @param onStepClick called with a step id when its badge is clicked.
 * @param wide       whether the inspector is currently widened
 * @param onWide     ask the inspector to widen or narrow. Editing asks for wide by itself.
 */
export default function CodeEditor({
  value = '',
  onChange,
  onCommit,
  max,
  onRefuse,
  steps = [],
  onAddStep,
  onStepClick,
  wide = false,
  onWide,
  placeholder = 'No code on this component.',
  label = 'function body',
}) {
  const [editing, setEditing] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())

  const area = useRef(null)
  const gutter = useRef(null)

  const lines = useMemo(() => value.split('\n'), [value])
  /* Computed even while editing, so that leaving edit mode does not clear the folds:
     gating this on `editing` made the set momentarily empty, and the reconciliation
     below then dropped every fold the reader had set. */
  const foldable = useMemo(() => allFoldableLines(value), [value])

  /* Anchored steps by 1-based line, with the position they hold in the list -- the badge
     shows that number, so it matches what the checklist is showing. */
  const stepByLine = useMemo(() => {
    const byLine = new Map()
    ;(steps ?? []).forEach((step, index) => {
      if (step?.line) byLine.set(step.line, { ...step, position: index + 1 })
    })
    return byLine
  }, [steps])

  /*
   * Folds that no longer point at anything are dropped.
   *
   * A collapsed region is remembered by its *first line*, and inserting a line above it
   * moves every region below by one -- so a fold that was hiding a handler would end up
   * hiding whatever now starts on that line. Rather than track regions through edits,
   * a fold whose line stopped being foldable is forgotten, which is the honest version
   * of "this no longer means what you clicked".
   */
  const signature = foldable.join(',')
  useEffect(() => {
    const still = new Set(signature ? signature.split(',').map(Number) : [])
    setCollapsed((current) => {
      if (current.size === 0) return current
      const kept = new Set([...current].filter((line) => still.has(line)))
      return kept.size === current.size ? current : kept
    })
  }, [signature])

  const toggle = (line) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })

  const start = () => {
    setEditing(true)
    /*
     * Widening is what makes editing bearable in a sidebar, so entering edit mode asks for it
     * rather than leaving it to a second click.
     *
     * It is deliberately *not* given back on Done. What people do straight after editing is
     * press Test, and the result panel and the checklist want the room as much as the code
     * did -- snapping back to 384px at the moment the run appears would undo the widening
     * exactly when it started being useful. The toggle beside this is how you narrow, and the
     * panel narrows by itself when the tab unmounts (see CodeTab).
     */
    onWide?.(true)
  }

  const finish = () => {
    setEditing(false)
    onCommit?.()
  }

  const type = (next) => {
    if (max && next.length > max) {
      /* Only on the way over the line, not on every keystroke after it. Someone parked at
         the cap and still typing would otherwise get a toast per character, which turns
         one piece of information into a barrage of it. */
      if (value.length < max) onRefuse?.(next.length)
      /* Clamped rather than rejected outright: someone pasting a function 200 characters
         over the cap should get all but the tail, with the panel saying so, instead of a
         textarea that appears to ignore the paste. */
      onChange?.(next.slice(0, max))
      return
    }
    onChange?.(next)
  }

  /* Taller when the panel is wide, because the reason to widen is to see more at once and
     a 288px window into a 400-line function is the thing being complained about. */
  const height = wide ? 'h-[34rem]' : 'h-72'

  return (
    <div className="rounded-md border border-twilio-gray-20 bg-white">
      <div className="flex items-center gap-1.5 border-b border-twilio-gray-20 px-2 py-1.5">
        <Code2 size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
        <span className="text-[10px] tabular-nums text-twilio-gray-60">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
        {max && (
          <span
            className={`text-[10px] tabular-nums ${
              value.length > max * 0.9 ? 'text-twilio-warning' : 'text-twilio-gray-40'
            }`}
          >
            · {value.length.toLocaleString()}/{max.toLocaleString()}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          {onWide && (
            <button
              type="button"
              onClick={() => onWide(!wide)}
              title={wide ? 'Narrow the panel' : 'Widen the panel to work on the code'}
              aria-pressed={wide}
              className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
            >
              {wide ? (
                <Minimize2 size={11} aria-hidden="true" />
              ) : (
                <Maximize2 size={11} aria-hidden="true" />
              )}
              {wide ? 'Narrow' : 'Widen'}
            </button>
          )}
          {!editing && foldable.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((current) =>
                  current.size >= foldable.length ? new Set() : new Set(foldable),
                )
              }
              title={
                collapsed.size >= foldable.length
                  ? 'Expand every block'
                  : 'Collapse every block down to an outline'
              }
              className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
            >
              {collapsed.size >= foldable.length ? (
                <UnfoldVertical size={11} aria-hidden="true" />
              ) : (
                <FoldVertical size={11} aria-hidden="true" />
              )}
              {collapsed.size >= foldable.length ? 'Expand all' : 'Fold all'}
            </button>
          )}
          <button
            type="button"
            /*
             * Keeps the textarea focused through the click, which is what stops Done from
             * re-opening the editor. Without it the sequence is: mousedown moves focus,
             * the textarea's `onBlur` runs `finish()`, the button re-renders as "Edit",
             * and the click that follows lands on *that* and puts the editor straight
             * back into edit mode.
             */
            onMouseDown={editing ? (event) => event.preventDefault() : undefined}
            onClick={() => (editing ? finish() : start())}
            className={`nodrag flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              editing
                ? 'bg-twilio-blue text-white hover:bg-twilio-blue-dark'
                : 'border border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-blue hover:text-twilio-blue'
            }`}
          >
            {!editing && <Pencil size={11} aria-hidden="true" />}
            {editing ? 'Done' : 'Edit'}
          </button>
        </span>
      </div>

      {editing ? (
        /*
         * A fixed height, and that is load-bearing rather than cosmetic.
         *
         * The gutter is a separate element scrolled programmatically from the textarea's
         * `onScroll`, and an element only has somewhere to scroll *to* when it is shorter
         * than its own content. Sized to fit (by `max-h`, or by the flex row growing to
         * the tallest child) the gutter is exactly as tall as its numbers, `scrollTop`
         * silently stays 0, and the line numbers drift out of step with the code the
         * moment the textarea scrolls. Both children stretch to this height instead, so
         * the textarea scrolls and the gutter follows.
         */
        <div className={`flex overflow-hidden ${height}`}>
          <div
            ref={gutter}
            aria-hidden="true"
            /* Nothing folds while editing. Said on the gutter rather than left to be
               inferred from the chevrons having vanished. */
            title="Folding and checklist anchors are in the read view — press Done."
            className="shrink-0 select-none overflow-hidden border-r border-twilio-gray-20 bg-twilio-gray-10 text-right"
          >
            {/* The padding is on this inner element, not on the scroller: padding-top on a
                scrolling box does not move with its content, so the numbers would sit a
                few pixels low as soon as it scrolled. It matches the textarea's own. */}
            <div className="py-1.5">
              {lines.map((_, index) => {
                const step = stepByLine.get(index + 1)
                return (
                  <div
                    key={index}
                    style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                    className="flex items-center justify-end gap-1 px-1.5 font-mono text-[10px] tabular-nums text-twilio-gray-40"
                  >
                    {step && (
                      <span className="rounded-full bg-twilio-blue px-1 text-[8px] font-bold text-white">
                        {step.position}
                      </span>
                    )}
                    {index + 1}
                  </div>
                )
              })}
            </div>
          </div>
          <textarea
            ref={area}
            autoFocus
            value={value}
            spellCheck={false}
            /* No soft wrapping: a wrapped line occupies two rows in the textarea and one
               in the gutter, and there is no way to keep the two aligned after that. A
               long line scrolls sideways instead. */
            wrap="off"
            onChange={(event) => type(event.target.value)}
            onScroll={() => {
              if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop
            }}
            onBlur={finish}
            aria-label={label}
            style={{ lineHeight: `${LINE_HEIGHT}px` }}
            className="nodrag h-full w-full resize-none overflow-auto py-1.5 pl-2 font-mono text-[11px] text-twilio-navy outline-none"
          />
        </div>
      ) : (
        <ReadView
          value={value}
          collapsed={collapsed}
          stepByLine={stepByLine}
          height={height}
          onToggle={toggle}
          onEdit={start}
          onAddStep={onAddStep}
          onStepClick={onStepClick}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}

function ReadView({
  value,
  collapsed,
  stepByLine,
  height,
  onToggle,
  onEdit,
  onAddStep,
  onStepClick,
  placeholder,
}) {
  const rows = useMemo(() => visibleRows(value, collapsed), [value, collapsed])
  const painted = useMemo(() => highlightLines(value), [value])
  /*
   * Which visible lines could take an anchor.
   *
   * Computed for the rendered rows only, not for the whole file: `anchorable` builds a mask
   * per call, and asking it four hundred times for a folded view whose rows are a dozen
   * would be the most expensive thing in this panel.
   */
  const canAnchor = useMemo(() => {
    if (!onAddStep) return new Set()
    const allowed = new Set()
    for (const row of rows) {
      if (!stepByLine.has(row.index + 1) && anchorable(value, row.index + 1)) {
        allowed.add(row.index + 1)
      }
    }
    return allowed
  }, [rows, value, stepByLine, onAddStep])

  if (!value.trim()) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="nodrag block w-full px-2 py-4 text-left text-[11px] italic text-twilio-gray-40 hover:text-twilio-blue"
      >
        {placeholder}
      </button>
    )
  }

  return (
    <div className={`overflow-auto ${height}`}>
      <div className="min-w-max">
        {rows.map((row) => {
          const line = row.index + 1
          const step = stepByLine.get(line)
          return (
            <div key={row.index} className="group flex items-start">
              {/* Number, fold chevron and step control in one fixed-width gutter, so the
                  code starts at the same x on every row whether or not that row folds or
                  carries a step. A control that pushed the text right would make the
                  gutter read as indentation. */}
              <span className="sticky left-0 z-10 flex shrink-0 select-none items-center bg-white pr-1">
                {row.fold ? (
                  <button
                    type="button"
                    onClick={() => onToggle(row.index)}
                    aria-expanded={row.fold === 'open'}
                    title={row.fold === 'closed' ? 'Expand this block' : 'Collapse this block'}
                    style={{ height: LINE_HEIGHT }}
                    className="nodrag flex w-4 items-center justify-center text-twilio-gray-40 transition-colors hover:text-twilio-blue"
                  >
                    {row.fold === 'closed' ? (
                      <ChevronRight size={11} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={11} aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span className="w-4" aria-hidden="true" />
                )}
                <span
                  style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                  className="w-7 pr-1 text-right font-mono text-[10px] tabular-nums text-twilio-gray-40"
                >
                  {line}
                </span>
                <StepControl
                  step={step}
                  line={line}
                  canAnchor={canAnchor.has(line)}
                  onAddStep={onAddStep}
                  onStepClick={onStepClick}
                />
              </span>

              <code
                style={{ minHeight: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                onDoubleClick={onEdit}
                title="Double-click to edit"
                /* An anchored line is bolded and tinted along its left edge, so the
                   checklist is legible *in the code* and not only in the list beside it --
                   which is the whole point of anchoring rather than just numbering. */
                className={`block whitespace-pre pr-3 font-mono text-[11px] ${
                  step ? 'border-l-2 border-twilio-blue bg-twilio-blue-light/40 pl-1 font-semibold' : ''
                }`}
              >
                {(painted[row.index] ?? []).map((segment, index) => (
                  <span key={index} className={TOKEN_CLASS[segment.token]}>
                    {segment.text}
                  </span>
                ))}
                {row.hidden > 0 && (
                  /* The count, not an ellipsis: "12 lines" is what tells the reader
                     whether the thing they folded was a comment or a whole handler. */
                  <button
                    type="button"
                    onClick={() => onToggle(row.index)}
                    className="nodrag ml-1 rounded bg-twilio-gray-10 px-1 align-middle text-[9px] text-twilio-gray-60 hover:bg-twilio-blue-light hover:text-twilio-blue-dark"
                  >
                    ⋯ {row.hidden} line{row.hidden === 1 ? '' : 's'}
                  </button>
                )}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The third gutter column: this line's step, or an offer to make one.
 *
 * The `+` appears on hover only. Every line having a visible button would turn the gutter
 * into a column of clutter down the side of the code, and the lines that *cannot* take one
 * would then need an explanation for why theirs is missing. On hover, its absence is simply
 * not noticed.
 */
function StepControl({ step, line, canAnchor, onAddStep, onStepClick }) {
  if (step) {
    const Icon = step.status === 'done' ? Check : step.status === 'missed' ? X : null
    return (
      <button
        type="button"
        onClick={() => onStepClick?.(step.id)}
        title={`Step ${step.position}: ${step.label || 'unnamed'}${
          step.status === 'done'
            ? ' — this line ran'
            : step.status === 'missed'
              ? ' — this line did not run'
              : step.status === 'untracked'
                ? ' — this line cannot be measured'
                : ''
        }`}
        style={{ height: LINE_HEIGHT }}
        className={`nodrag flex w-5 items-center justify-center gap-px rounded border text-[8px] font-bold tabular-nums ${
          STEP_TONE[step.status] ?? STEP_TONE.pending
        }`}
      >
        {Icon ? <Icon size={9} strokeWidth={3} aria-hidden="true" /> : step.position}
      </button>
    )
  }

  if (!canAnchor) return <span className="w-5" aria-hidden="true" />

  return (
    <button
      type="button"
      onClick={() => onAddStep?.(line)}
      title={`Add a checklist step for line ${line}`}
      style={{ height: LINE_HEIGHT }}
      className="nodrag flex w-5 items-center justify-center text-twilio-gray-20 opacity-0 transition-opacity hover:text-twilio-blue group-hover:opacity-100"
    >
      <Plus size={11} aria-hidden="true" />
    </button>
  )
}
