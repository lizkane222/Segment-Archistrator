/*
 * Style: per-node colour, outline, shape and size overrides.
 *
 * The brief asks for background, line and text colours plus distinct shapes that
 * are "easily updated". Two scopes, because both are asked for by the same
 * sentence and they are different jobs:
 *
 *   - this node only, written to `data.style`
 *   - every node of this kind on the canvas, which is what someone actually means
 *     when they say "make the warehouses grey"
 *
 * Defaults live in kinds.js and are never mutated. An override is always additive,
 * so Reset is a delete rather than a re-assignment of the original values -- which
 * means a later change to a kind's default reaches every node that never overrode
 * it.
 *
 * Size is the one thing here that is *not* part of `style`, and deliberately: it goes
 * to `data.size`, which is where the canvas's resize handles write too, so the panel
 * and the handles are two ways of setting one value rather than two values that can
 * disagree. It is also not something "apply to every kind" should touch -- see the
 * note on that section.
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Paintbrush, RotateCcw } from 'lucide-react'

import { SHAPES, outlineFor, styleFor } from '../canvas/kinds.js'
import { styleForColor } from '../canvas/palettes.js'
import {
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  componentSize,
} from '../canvas/layout.js'
import PalettePicker from '../ui/PalettePicker.jsx'
import { Section } from './primitives.jsx'

const SWATCHES = [
  { key: 'bg', label: 'Background' },
  { key: 'border', label: 'Border' },
  { key: 'text', label: 'Text' },
]

const SHAPE_LABELS = {
  rounded: 'Rounded',
  pill: 'Pill',
  sharp: 'Square',
  notched: 'Notched',
}

/* The outline half of the request. `double` needs 3px to render as two lines at all,
   so it is not offered -- a control that silently does nothing at the default width is
   worse than one fewer option. */
const BORDER_STYLES = ['solid', 'dashed', 'dotted']
const BORDER_WIDTHS = [1, 2, 3, 4]

/**
 * An integer field that commits on blur, not on keystroke.
 *
 * Same reason `EditableText` does: each commit replaces the node in React Flow's
 * store, and doing that per character while someone types "240" resizes the card
 * through 2 and 24 on the way -- both of which are below the floor, so the value
 * they end up with is not the one they typed.
 *
 * Empty is a value, not a validation failure: it clears the override on that one
 * axis and hands the card back to its default width or to its own contents.
 */
function IntegerField({ label, value, placeholder, min, onCommit }) {
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => setDraft(value ?? ''), [value])

  const commit = () => {
    const text = String(draft).trim()
    if (text === '') return onCommit(null)
    const parsed = Number.parseInt(text, 10)
    /* Unparseable reverts rather than clearing. Someone who typed "wide" meant to type
       a number, and dropping their existing size for it would be a surprise. */
    if (!Number.isFinite(parsed)) return setDraft(value ?? '')
    return onCommit(Math.max(min, parsed))
  }

  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="w-28 shrink-0 text-twilio-gray-60">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          /* Escape abandons the edit. Without it the only way out of a half-typed
             number is to type the old one back in from memory. */
          if (event.key === 'Escape') {
            setDraft(value ?? '')
            event.currentTarget.blur()
          }
        }}
        className="nodrag w-20 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-xs tabular-nums text-twilio-navy focus:border-twilio-blue focus:outline-none"
      />
      <span className="text-[10px] text-twilio-gray-60">px</span>
      {value != null && (
        <span className="ml-auto text-[9px] uppercase tracking-wide text-twilio-warning">
          custom
        </span>
      )}
    </div>
  )
}

export default function StyleTab({ node, topology, onUpdate, onUpdateKind }) {
  const kind = node.data.kind
  const override = node.data.style ?? {}
  const effective = styleFor(kind, override)
  /* Resolved rather than read off `effective`, so the highlighted button is the border
     the canvas is drawing -- an unstyled placeholder draws dashed while `effective` still
     says solid. */
  const outline = outlineFor(node.data)
  const isPlaceholder = node.data.bound === false
  /* Last fallback is a word rather than the kind, because the kind can be absent: a
     custom component carries none, and this label is interpolated into a sentence. */
  const kindLabel = topology?.kinds?.[kind]?.label ?? kind ?? 'component'
  const [palettesOpen, setPalettesOpen] = useState(false)

  const set = (patch) => onUpdate({ style: { ...override, ...patch } })

  const chosen = componentSize(node.data)
  /* Per axis, so setting a width does not force a height. A card with a width and no
     height still grows with its own contents, which is what an Identity Resolver's
     buckets need -- see SegmentNode. Both cleared drops `size` entirely rather than
     leaving `{width: null, height: null}` in the document to be read back later. */
  const setSize = (patch) => {
    const next = { width: chosen.width, height: chosen.height, ...patch }
    const cleared = next.width == null && next.height == null
    onUpdate({ size: cleared ? undefined : next })
  }

  return (
    <>
      <Section
        title="This component"
        actions={
          Object.keys(override).length > 0 && (
            <button
              type="button"
              /* Delete the override rather than writing the defaults back in, so
                 the node keeps tracking its kind's default if that ever changes. */
              onClick={() => onUpdate({ style: undefined })}
              className="nodrag flex items-center gap-1 text-[10px] text-twilio-gray-60 hover:text-twilio-blue"
            >
              <RotateCcw size={11} aria-hidden="true" />
              Reset
            </button>
          )
        }
      >
        {SWATCHES.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-2 py-1 text-xs">
            <span className="w-28 shrink-0 text-twilio-gray-60">{label}</span>
            <input
              type="color"
              value={effective[key]}
              onChange={(event) => set({ [key]: event.target.value })}
              className="nodrag h-6 w-10 shrink-0 cursor-pointer rounded border border-twilio-gray-20 bg-white"
              title={`${label} colour`}
            />
            <span className="font-mono text-[10px] uppercase text-twilio-gray-60">
              {effective[key]}
            </span>
            {override[key] && (
              <span
                className="ml-auto text-[9px] uppercase tracking-wide text-twilio-warning"
                title={`Overrides the default for ${kindLabel}`}
              >
                custom
              </span>
            )}
          </div>
        ))}

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Outline</span>
          <div className="flex flex-wrap gap-1">
            {BORDER_STYLES.map((borderStyle) => (
              <button
                key={borderStyle}
                type="button"
                onClick={() => set({ borderStyle })}
                title={`${borderStyle} outline`}
                className={`nodrag rounded border px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                  outline.borderStyle === borderStyle
                    ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                    : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                }`}
              >
                {borderStyle}
              </button>
            ))}
          </div>
          {isPlaceholder && !override.borderStyle && (
            /* Said, because otherwise the highlighted button and the card disagree and
               the panel looks broken. The dash is the unbound annotation, not a style
               anyone chose, and clicking any of the three above takes it over. */
            <span className="ml-auto text-[9px] uppercase tracking-wide text-twilio-warning">
              unbound
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Outline width</span>
          <div className="flex flex-wrap gap-1">
            {BORDER_WIDTHS.map((borderWidth) => (
              <button
                key={borderWidth}
                type="button"
                onClick={() => set({ borderWidth })}
                className={`nodrag rounded border px-1.5 py-0.5 text-[10px] tabular-nums transition-colors ${
                  outline.borderWidth === borderWidth
                    ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                    : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                }`}
              >
                {borderWidth}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Shape</span>
          <div className="flex flex-wrap gap-1">
            {Object.keys(SHAPES).map((shape) => (
              <button
                key={shape}
                type="button"
                onClick={() => set({ shape })}
                className={`nodrag border px-1.5 py-0.5 text-[10px] transition-colors ${
                  SHAPES[shape]
                } ${
                  effective.shape === shape
                    ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                    : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                }`}
              >
                {SHAPE_LABELS[shape] ?? shape}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Size"
        note="Or drag a corner of the component on the canvas. Leave a field empty to go back to the default."
        actions={
          (chosen.width != null || chosen.height != null) && (
            <button
              type="button"
              onClick={() => onUpdate({ size: undefined })}
              className="nodrag flex items-center gap-1 text-[10px] text-twilio-gray-60 hover:text-twilio-blue"
            >
              <RotateCcw size={11} aria-hidden="true" />
              Reset
            </button>
          )
        }
      >
        <IntegerField
          label="Width"
          value={chosen.width}
          placeholder={String(NODE_WIDTH)}
          min={MIN_NODE_WIDTH}
          onCommit={(width) => setSize({ width })}
        />
        <IntegerField
          label="Height"
          value={chosen.height}
          /* The placeholder is the *minimum*, not the height: with no chosen height a card
             is as tall as its contents, and a number here would claim otherwise for the
             kinds that have internals. */
          placeholder={`${NODE_HEIGHT}+`}
          min={MIN_NODE_HEIGHT}
          onCommit={(height) => setSize({ height })}
        />
      </Section>

      <Section
        title="Palettes"
        actions={
          <button
            type="button"
            onClick={() => setPalettesOpen((open) => !open)}
            className="nodrag flex items-center gap-1 text-[10px] text-twilio-gray-60 hover:text-twilio-blue"
          >
            {palettesOpen ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
            {palettesOpen ? 'Hide' : 'Show'}
          </button>
        }
        /* Folded away by default: 34 rows above the preview would push the thing the
           colours are being judged against off the bottom of the panel. */
        note={
          palettesOpen
            ? 'One click sets the fill, a matching border and a legible label colour together.'
            : undefined
        }
      >
        {palettesOpen && (
          <PalettePicker
            height="max-h-64"
            /* A swatch is a fill, and the border and text are derived from it rather
               than left to the user, because the three have to agree: a pick that set
               only the background is one click away from white-on-white. The colour
               pickers above are still there for anyone who wants to break that. */
            onPick={(color) => set(styleForColor(color))}
          />
        )}
      </Section>

      <Section title="Preview">
        <div className="flex justify-center rounded-md bg-twilio-gray-10 p-3">
          <div
            className={`flex items-center gap-2 border px-3 py-2 text-[13px] font-semibold shadow-sm ${
              SHAPES[effective.shape] ?? SHAPES.rounded
            }`}
            /* A fixed width, not the chosen one: this is a colour-and-outline swatch, and a
               scale model of a 90px-wide card would be too small to judge either in. */
            style={{
              width: 180,
              background: effective.bg,
              color: effective.text,
              borderColor: effective.border,
              borderStyle: outline.borderStyle,
              borderWidth: outline.borderWidth,
            }}
          >
            <span className="truncate">{node.data.name}</span>
          </div>
        </div>
      </Section>

      <Section
        title={`All ${kindLabel} components`}
        /* Size is left out on purpose, and the request itself is the reason: "make same
           size" and "apply same style" were asked for as two separate actions, so one of
           them is not allowed to quietly do the other. */
        note="Applies the colours, outline and shape above to every component of this kind currently on the canvas. Not the size — that stays per component."
      >
        <button
          type="button"
          onClick={() => onUpdateKind(kind, { ...override })}
          disabled={Object.keys(override).length === 0}
          className="nodrag flex w-full items-center justify-center gap-1.5 rounded-md border border-twilio-gray-20 px-2 py-1.5 text-xs text-twilio-navy transition-colors hover:border-twilio-blue hover:text-twilio-blue disabled:opacity-40"
        >
          <Paintbrush size={12} aria-hidden="true" />
          Apply to every {kindLabel.toLowerCase()}
        </button>
        {Object.keys(override).length === 0 && (
          <p className="mt-1 text-[11px] italic text-twilio-gray-60">
            Change something above first — there is nothing to apply yet.
          </p>
        )}
      </Section>
    </>
  )
}
