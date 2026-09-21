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

import { SHAPES, outlineFor, styleFor, zoneStyleFor } from '../canvas/kinds.js'
import { SHAPES as GEOMETRY, shapeById, shapePath } from '../canvas/shapes/geometry.js'
import { CHANNELS, styleForChannels } from '../canvas/palettes.js'
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

/*
 * The controls that apply to a shape: which outline, and how round its corners.
 *
 * Both write fields the renderer actually reads -- `data.shape` and `data.radius` -- rather than the
 * `style.shape` class a component uses. The corner row is the same value the drag-dot on the canvas
 * writes, so the two are one setting with two ways in; and it is hidden for a shape with no corners,
 * because a control that silently does nothing on a circle teaches the user that the feature is
 * broken rather than inapplicable.
 *
 * The geometry list is every shape, in the palette's order, as its own outline: nobody scans a column
 * of words looking for a cylinder.
 */
/* `onUpdate` here is deliberately the *per-node* writer. A geometry and a corner radius are facts about
   one drawing -- pushing a cylinder onto four selected shapes because one of them was inspected is not
   what "style the selection" means. Colours and outlines, which are shared, go through the other one. */
function ShapeGeometry({ node, onUpdate }) {
  const current = node.data.shape ?? null
  const geometry = current ? shapeById(current) : null
  const radius = Number(node.data.radius) || 0

  return (
    <>
      <div className="flex items-start gap-2 py-1 text-xs">
        <span className="mt-1 w-28 shrink-0 text-twilio-gray-60">Shape</span>
        <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto pr-1">
          {GEOMETRY.map((shape) => (
            <button
              key={shape.id}
              type="button"
              title={shape.name}
              aria-label={shape.name}
              aria-pressed={current === shape.id}
              onClick={() => onUpdate({ shape: shape.id })}
              className={`nodrag flex h-7 w-7 items-center justify-center rounded border transition-colors ${
                current === shape.id
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                  : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
              }`}
            >
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-4 w-4">
                <path
                  d={shapePath(shape.id, 0)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={6}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </button>
          ))}
        </div>
      </div>

      {geometry?.rounds && (
        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Corners</span>
          <div className="flex flex-wrap gap-1">
            {CORNER_PRESETS.map(({ label, value }) => (
              <button
                key={label}
                type="button"
                onClick={() => onUpdate({ radius: value })}
                className={`nodrag rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                  /* Nearest preset rather than an exact match: the canvas drag writes any value in
                     between, and none of the three looking selected after a drag reads as the row
                     having lost track of the shape. */
                  nearestPreset(radius) === value
                    ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                    : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-1 self-center text-[10px] tabular-nums text-twilio-gray-60">
              {Math.round(radius * 100)}%
            </span>
          </div>
        </div>
      )}
    </>
  )
}

/* Square, rounded, pill -- the three the request asked for by name, mapped onto the one value a
   shape's corners actually have. 1 is fully round, which on a rectangle is a pill. */
const CORNER_PRESETS = [
  { label: 'Square', value: 0 },
  { label: 'Rounded', value: 0.2 },
  { label: 'Pill', value: 1 },
]

/* One channel on or off, never emptying the set: a picker with nothing selected would look like a
   control that had stopped working, and there is no useful "apply to none". */
function toggle(channels, key) {
  if (!channels.includes(key)) return CHANNELS.map((channel) => channel.key).filter(
    (channel) => channels.includes(channel) || channel === key,
  )
  const next = channels.filter((channel) => channel !== key)
  return next.length ? next : channels
}

/* An outline style as an SVG dash pattern, since a path has no `border-style`. Scaled by the stroke
   width so a 4px dashed outline reads as dashes rather than as a solid line with gaps in it. */
function dashFor({ borderStyle, borderWidth = 1 }) {
  if (borderStyle === 'dashed') return `${borderWidth * 4} ${borderWidth * 3}`
  if (borderStyle === 'dotted') return `${borderWidth} ${borderWidth * 2}`
  return undefined
}

const nearestPreset = (radius) =>
  CORNER_PRESETS.reduce((best, preset) =>
    Math.abs(preset.value - radius) < Math.abs(best.value - radius) ? preset : best,
  ).value

export default function StyleTab({
  node,
  topology,
  onUpdate,
  /* Per-node, always: size and a shape's own geometry are not things a selection shares. */
  onUpdateOne = onUpdate,
  onUpdateKind,
  selectedCount = 1,
}) {
  const kind = node.data.kind
  /*
   * A zone is a styled box too, and now reaches this panel.
   *
   * It resolves its look through `zoneStyleFor` rather than `styleFor`, because a zone's default is not
   * a kind's: it comes from the product palette, or from the single `color` it can be given, and its
   * background is *derived* from that colour rather than picked. So the effective values shown here have
   * to come from the same function the renderer uses, or the swatches would describe a zone that is not
   * on the canvas.
   *
   * Three of the controls below are meaningless on a zone and are hidden rather than greyed: there is no
   * kind to apply a style to every one of, no bind state to be a placeholder of, and its size belongs to
   * the resize handles (which is what the Zone tab says).
   */
  const isZone = node.type === 'zone'
  /* A shape draws an SVG path rather than a styled box, which changes what the controls below can
     honestly offer -- see the note beside the Shape row. `data.lucid` is a converted icon: it has no
     geometry of its own to swap, so it takes the colours and nothing else. */
  const isShape = kind === 'shape' && !node.data.lucid
  /*
   * Nodes with no shape to choose at all, where the four buttons would be the same dead control the
   * shape report was about: a converted Lucid icon *is* its artwork, and a table is a grid whose
   * outline is drawn by the cells. Both still take every colour on this panel.
   */
  const shapeless = kind === 'table' || Boolean(node.data.lucid)
  const override = node.data.style ?? {}
  const effective = isZone ? zoneStyleFor(node.data) : styleFor(kind, override)
  /* Resolved rather than read off `effective`, so the highlighted button is the border
     the canvas is drawing -- an unstyled placeholder draws dashed while `effective` still
     says solid. */
  const outline = isZone
    ? { borderStyle: effective.borderStyle, borderWidth: effective.borderWidth }
    : outlineFor(node.data)
  /* A zone is never a placeholder: nothing binds to one, so the dashed-means-unbound reading that the
     outline rows explain does not apply and would be a false note on the panel. */
  const isPlaceholder = !isZone && node.data.bound === false
  /* Last fallback is a word rather than the kind, because the kind can be absent: a
     custom component carries none, and this label is interpolated into a sentence. */
  const kindLabel = isZone ? 'zone' : (topology?.kinds?.[kind]?.label ?? kind ?? 'component')
  const [palettesOpen, setPalettesOpen] = useState(false)
  /* Which of background/border/text a palette swatch writes. All three to begin with, which is what
     this always did -- see the note beside the toggles. */
  const [channels, setChannels] = useState(() => CHANNELS.map((channel) => channel.key))

  const set = (patch) => onUpdate({ style: { ...override, ...patch } })

  const chosen = componentSize(node.data)
  /* Per axis, so setting a width does not force a height. A card with a width and no
     height still grows with its own contents, which is what an Identity Resolver's
     buckets need -- see SegmentNode. Both cleared drops `size` entirely rather than
     leaving `{width: null, height: null}` in the document to be read back later. */
  const setSize = (patch) => {
    const next = { width: chosen.width, height: chosen.height, ...patch }
    const cleared = next.width == null && next.height == null
    onUpdateOne({ size: cleared ? undefined : next })
  }

  return (
    <>
      <Section
        title={
          selectedCount > 1
            ? `These ${selectedCount} components`
            : isZone
              ? 'This zone'
              : 'This component'
        }
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

        {/*
          Two different controls, because "shape" means two different things.

          On a component, a shape is one of four CSS treatments of a box -- a border radius or a
          clip path on a div (see `SHAPES` in canvas/kinds.js). On a *shape*, the outline is drawn
          from an SVG path and those four classes are never read: the buttons appeared to work, the
          highlight moved, and nothing on the canvas changed. Which was the report.

          So a shape node gets the controls that do apply to it -- which path, and how round its
          corners -- and a component keeps the four it always had.
        */}
        {isShape ? (
          <ShapeGeometry node={node} onUpdate={onUpdateOne} />
        ) : shapeless ? null : (
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
        )}
      </Section>

      {/* A zone's geometry belongs to its resize handles -- the Zone tab says so, and two panels
          disagreeing about one rectangle is worse than one of them staying quiet. */}
      {!isZone && (
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
      )}

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
            ? channels.length === CHANNELS.length
              ? 'One click sets the fill, a matching border and a legible label colour together.'
              : `One click sets the ${CHANNELS.filter((channel) => channels.includes(channel.key))
                  .map((channel) => channel.label.toLowerCase())
                  .join(' and ')} only.`
            : undefined
        }
      >
        {palettesOpen && (
          <>
            {/*
              Which of the three a swatch writes.

              All three is the default and does what it always did -- the fill, plus a border and a
              label colour derived from it, because those three have to agree or a pick is one click
              away from white-on-white. Turning one off is the request's own case: a shape whose
              outline should take the palette colour and whose fill should stay as it is.

              Component state, not a document field: it is a mode for the next click, not a fact
              about this node, and storing it would put it in every saved diagram and in the
              unsaved-changes fingerprint.
            */}
            <div className="flex flex-wrap items-center gap-1 pb-1.5">
              <span className="mr-1 text-[10px] uppercase tracking-wide text-twilio-gray-60">
                Apply to
              </span>
              {CHANNELS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={channels.includes(key)}
                  onClick={() => setChannels(toggle(channels, key))}
                  className={`nodrag rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    channels.includes(key)
                      ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                      : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <PalettePicker
              height="max-h-64"
              onPick={(color) => {
                const patch = styleForChannels(color, channels)
                if (patch) set(patch)
              }}
            />
          </>
        )}
      </Section>

      <Section title="Preview">
        <div className="flex justify-center rounded-md bg-twilio-gray-10 p-3">
          {isShape ? (
            /* The actual outline, at the actual radius. A rounded rectangle standing in for a
               cylinder would make the swatch a picture of a different shape from the one being
               styled -- which is the same disconnect the Shape row above had. */
            <div className="relative" style={{ width: 180, height: 90 }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
                <path
                  d={shapePath(node.data.shape, Number(node.data.radius) || 0) ?? ''}
                  fill={override.bg ?? 'none'}
                  stroke={effective.border}
                  strokeWidth={outline.borderWidth}
                  strokeDasharray={dashFor(outline)}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span
                className="absolute inset-0 flex items-center justify-center px-2 text-center text-[12px] font-semibold"
                style={{ color: effective.text }}
              >
                {node.data.name}
              </span>
            </div>
          ) : (
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
          )}
        </div>
      </Section>

      {/* Nothing to apply it to: a zone has no kind, so "every zone of this kind" is every zone, which
          is not a thing anyone asked for and would repaint the whole canvas from a per-zone panel. */}
      {!isZone && (
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
      )}
    </>
  )
}
