/*
 * A shape: geometry or a converted Lucid icon, with an optional label.
 *
 * A separate renderer from `SegmentNode`, and the line between them is worth stating because it is
 * not "one is simpler". A Segment component is *a labelled box with fields* -- its name, its type, its
 * unbound flag and its anchor note are the content, and the box is furniture. A shape is the opposite:
 * the outline is the content and any text is an annotation on it. Sharing a renderer would mean every
 * branch in `SegmentNode` growing a "unless it is a shape" clause.
 *
 * What they *do* share is everything about being a node on this canvas: the four-sided connection
 * handles, the free border anchor, the lock, the resizer, the walkthrough dimming. Those come from the
 * same modules, so a shape connects and behaves exactly like a component.
 *
 * ## The corner handle
 *
 * "A drag-corner-dot control to round any shape's corners", asked for directly. It is a dot inside the
 * top-left corner, dragged toward the centre to round and back to square it off, and it writes
 * `data.radius` as a fraction 0..1 -- see geometry.js for why a fraction rather than pixels.
 *
 * Only shown for a shape that has corners (`rounds`), because a handle that silently does nothing on a
 * circle is worse than no handle: the user drags it, watches nothing happen, and concludes the feature
 * is broken rather than inapplicable.
 */

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { Lock } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import RichEditor from './RichEditor.jsx'
import RichLabel from './RichLabel.jsx'
import { LucidArt } from '../shapes/LucidArt.jsx'
import { shapeById, shapePath } from '../shapes/geometry.js'
import { useChrome } from '../chrome.js'
import { useHeld } from '../flash.js'
import { labelLayout } from '../labelStyle.js'
import { hasFormatting } from '../richText.js'
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH, componentSize } from '../layout.js'

/* How far in from the corner the rounding dot sits, in pixels. Far enough not to sit on the resizer's
   own corner handle, close enough to read as belonging to that corner. */
const HANDLE_INSET = 12

/* The drag distance that takes a corner from square to fully round. In screen pixels rather than a
   fraction of the shape, so the gesture feels the same on a small shape and a large one -- the *value*
   is a fraction, the *travel* is not. */
const HANDLE_TRAVEL = 60

/* An outline style as an SVG dash pattern, since a path has no `border-style`. Scaled by the stroke
   width, or a 4px dashed outline reads as a solid line with nicks in it rather than as dashes. The
   same mapping the inspector's preview uses -- see `dashFor` in inspector/StyleTab.jsx. */
function dashFor({ borderStyle, borderWidth }) {
  if (borderStyle === 'dashed') return `${borderWidth * 4} ${borderWidth * 3}`
  if (borderStyle === 'dotted') return `${borderWidth} ${borderWidth * 2}`
  return undefined
}

/*
 * How much of each side of a shape's box its outline eats, as a fraction of that side: where the text
 * may actually go. A callout's body is the top 72% of its box and the tail is not a place for words; a
 * circle's corners are empty; a diamond is mostly empty at the edges. Shapes not listed use the whole box.
 */
const TEXT_INSET = {
  callout: { t: 0.04, r: 0.04, b: 0.3, l: 0.04 },
  circle: { t: 0.15, r: 0.15, b: 0.15, l: 0.15 },
  ellipse: { t: 0.14, r: 0.14, b: 0.14, l: 0.14 },
  diamond: { t: 0.25, r: 0.25, b: 0.25, l: 0.25 },
  triangle: { t: 0.38, r: 0.22, b: 0.04, l: 0.22 },
  pentagon: { t: 0.14, r: 0.1, b: 0.06, l: 0.1 },
  hexagon: { t: 0.08, r: 0.08, b: 0.08, l: 0.08 },
  octagon: { t: 0.1, r: 0.1, b: 0.1, l: 0.1 },
  star: { t: 0.3, r: 0.28, b: 0.2, l: 0.28 },
  cylinder: { t: 0.22, r: 0.04, b: 0.06, l: 0.04 },
  database: { t: 0.22, r: 0.04, b: 0.06, l: 0.04 },
  cloud: { t: 0.2, r: 0.14, b: 0.16, l: 0.14 },
  document: { t: 0.04, r: 0.04, b: 0.12, l: 0.04 },
  documents: { t: 0.1, r: 0.1, b: 0.12, l: 0.04 },
}
const NO_INSET = { t: 0, r: 0, b: 0, l: 0 }
/* The tightest a line may be squeezed before the shape grows instead. */
const FIT_LINE_HEIGHTS = [null, 1.15, 1.05, 1]
const FIT_PADDING = 8

function ShapeNode({ id, data, selected }) {
  const { screenToFlowPosition } = useReactFlow()
  const { walkthroughActive, rename, setRadius, updateData } = useChrome()
  /* A boolean now rather than the draft text it used to hold: the draft lives in the DOM while a
     rich edit is in progress -- see RichEditor.jsx -- and holding a copy here as well would be two
     answers to "what does this label say". */
  const [editing, setEditing] = useState(false)

  const picked = useHeld(id)
  const locked = Boolean(data.locked)
  const chosen = componentSize(data)
  const geometry = data.shape ? shapeById(data.shape) : null
  const radius = Number(data.radius) || 0

  /* The style tab's overrides, with a shape's own defaults. A shape starts unfilled: it is usually an
     outline drawn *around* or *beside* components, and a solid default would hide whatever it was put
     behind. */
  const stroke = data.style?.border ?? '#354052'
  const fill = data.style?.bg ?? 'none'
  const text = data.style?.text ?? '#354052'

  /*
   * The outline, resolved the same way a component's is.
   *
   * A shape's default is 2px rather than the 1px hairline a card gets: a card's border sits around
   * text and a shape's outline *is* the shape, so a hairline triangle reads as a scratch. The legacy
   * `style.strokeWidth` is honoured ahead of everything, because shapes drawn before the Outline
   * rows worked stored their width there.
   */
  const outline = {
    borderStyle: data.style?.borderStyle ?? 'solid',
    borderWidth: Number(data.style?.strokeWidth ?? data.style?.borderWidth ?? 2) || 2,
  }

  const paths = data.paths ?? null
  const here = paths?.find((entry) => entry.current) ?? null
  const arrived = paths?.some((entry) => entry.arrived) ?? false
  const aside = walkthroughActive && !here && !arrived

  /*
   * Dragging the corner dot.
   *
   * Distance from the shape's top-left corner along the diagonal, as a fraction of `HANDLE_TRAVEL`.
   * Measured in flow coordinates so the gesture is unaffected by zoom -- at 40% zoom a screen-pixel
   * measurement would need two and a half times the mouse travel for the same result.
   */
  const dragCorner = useCallback(
    (event) => {
      event.stopPropagation()
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture?.(event.pointerId)
      const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY })

      const onMove = (moveEvent) => {
        const at = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
        /* Along the diagonal, so dragging right or down both round -- a corner dot that only
           responded to one axis would feel broken half the time. */
        const travelled = (at.x - origin.x + (at.y - origin.y)) / 2
        const next = Math.min(1, Math.max(0, radius + travelled / HANDLE_TRAVEL))
        setRadius?.(id, Math.round(next * 100) / 100)
      }
      const onUp = () => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', onUp)
        element.removeEventListener('pointercancel', onUp)
      }
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', onUp)
      element.addEventListener('pointercancel', onUp)
    },
    [screenToFlowPosition, radius, data, id],
  )

  /*
   * A finished edit, written as both halves of the same fact.
   *
   * `name` is the plain projection and stays authoritative -- export, search, the minimap and the
   * server all read it -- and `nameRich` carries the formatting for whoever can draw it. Written
   * together, in one patch, because a node whose two fields disagreed would render one thing and
   * be found by searching for another.
   *
   * Blank is allowed here, unlike on a component: a shape is its outline, and an unlabelled arrow
   * or swimlane is a perfectly ordinary thing to want. An unformatted label stores no `nameRich`
   * at all, so a shape whose text has only ever been typed serializes exactly as it did before
   * rich labels existed.
   */
  const commit = ({ rich, text: plain }) => {
    setEditing(false)
    const formatted = hasFormatting(rich) ? rich : undefined
    if (plain === (data.name ?? '') && formatted === undefined && !data.nameRich) return
    if (updateData) updateData(id, { name: plain, nameRich: formatted })
    else rename?.(id, plain)
  }

  const label = labelLayout(data.style)

  /*
   * Keep the text inside the shape.
   *
   * Measured after layout: first the text as it would normally sit, then with the line height squeezed
   * a step at a time, and if even the tightest does not fit the shape grows -- taller for more lines,
   * wider for a word that is wider than the box. Never while editing (the box would jump under the
   * caret) and never on a locked shape, which keeps its size and takes the squeezed lines.
   */
  const inset = (data.shape && TEXT_INSET[data.shape]) || NO_INSET
  const boxRef = useRef(null)
  const textRef = useRef(null)
  const [squeeze, setSqueeze] = useState(null)
  const hasText = Boolean(data.name || data.nameRich)
  useLayoutEffect(() => {
    const box = boxRef.current
    const text = textRef.current
    if (!box || !text || !hasText || editing) return
    const inner = text.firstElementChild
    const fits = () => {
      const availableHeight = box.clientHeight - 2 * FIT_PADDING
      return text.offsetHeight <= availableHeight + 0.5 && text.scrollWidth <= box.clientWidth - 2 * FIT_PADDING + 0.5
    }
    const original = inner ? inner.style.lineHeight : ''
    let chosenLine = null
    let found = false
    for (const lineHeight of FIT_LINE_HEIGHTS) {
      if (inner) inner.style.lineHeight = lineHeight == null ? original : String(lineHeight)
      if (fits()) {
        chosenLine = lineHeight
        found = true
        break
      }
    }
    if (inner) inner.style.lineHeight = original
    setSqueeze(chosenLine)
    if (found || locked || !updateData) return

    /* Does not fit even squeezed: grow to the size the text needs at its normal spacing. The node's own
       size is what is being changed, so it is measured from the node and not from the inset box. */
    const nodeWidth = box.parentElement?.offsetWidth ?? box.clientWidth
    const nodeHeight = box.parentElement?.offsetHeight ?? box.clientHeight
    /* Both ways at once, by the square root of how much too tall the text is: wider boxes take fewer
       lines, so growing only one side makes a tall sliver. The effect runs again at the new size and
       stops the first time everything fits. */
    const tall = text.offsetHeight / Math.max(1, box.clientHeight - 2 * FIT_PADDING)
    const wide = text.scrollWidth / Math.max(1, box.clientWidth - 2 * FIT_PADDING)
    const factor = Math.min(2, Math.max(1.1, Math.sqrt(tall), wide))
    updateData(id, {
      size: { width: Math.ceil(nodeWidth * factor), height: Math.ceil(nodeHeight * factor) },
    })
  }, [data.name, data.nameRich, data.style?.fontSize, data.shape, chosen.width, chosen.height, editing, locked, hasText])

  return (
    <>
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={MIN_NODE_WIDTH}
        minHeight={MIN_NODE_HEIGHT}
        color={stroke}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1, opacity: 0.35 }}
      />

      <div
        className={`nokey group relative ${picked ? 'pick-glow' : ''} ${aside ? 'walkthrough-aside' : ''} ${
          here ? 'walkthrough-here' : arrived ? 'walkthrough-trail' : ''
        }`}
        style={{
          width: chosen.width ?? 120,
          height: chosen.height ?? 120,
          '--path-colour': here?.color ?? undefined,
        }}
        onContextMenu={(event) => event.preventDefault()}
        data-kind="shape"
        data-node-id={id}
      >
        <ConnectionHandles border={stroke} />

        {/* The artwork fills the node exactly. `preserveAspectRatio="none"` on both sources, so the
            node's size is the only thing that decides how big the shape is and a resize never fights
            an intrinsic ratio. */}
        {data.lucid ? (
          <LucidArt id={data.lucid} className="pointer-events-none h-full w-full" style={{ color: stroke }} />
        ) : geometry ? (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none h-full w-full overflow-visible"
          >
            <path
              d={shapePath(data.shape, radius)}
              fill={fill}
              stroke={stroke}
              /*
               * The same two fields the inspector's Outline rows write, and the same ones a
               * component's border reads. They used to be `style.strokeWidth`, which nothing else
               * in the app has ever written -- so the Outline and Outline width rows moved their
               * highlight and changed nothing on the shape, exactly as the Shape row did.
               *
               * A path has no `border-style`, so dashed and dotted become a dash array; `dashFor`
               * scales it by the width, or a 4px dashed outline reads as a solid line with nicks in
               * it. Legacy `strokeWidth` is still honoured, so a shape saved with one keeps it.
               */
              strokeWidth={outline.borderWidth}
              strokeDasharray={dashFor(outline)}
              strokeLinejoin="round"
              strokeLinecap="round"
              /* So a shape stretched to 400px wide keeps a 2px outline rather than a smeared one. */
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          /* Neither a known geometry nor a known icon: a document from a newer build. A dashed box
             saying so beats drawing a square and letting the reader think that is what was meant. */
          <div className="flex h-full w-full items-center justify-center rounded border-2 border-dashed border-twilio-gray-40 p-2 text-center text-[10px] text-twilio-gray-40">
            Unknown shape
          </div>
        )}

        {/* The label, over the shape. Absolutely positioned so it does not participate in the
            shape's box -- text inside a triangle would otherwise stretch it -- and laid out by the
            two alignment settings the text toolbar writes, which is why the flex classes come from
            `labelLayout` rather than being fixed at centre. */}
        <div
          ref={boxRef}
          className={`absolute flex ${label.itemsClass} ${label.justifyClass} ${
            editing ? '' : 'pointer-events-none'
          }`}
          style={{
            left: `${inset.l * 100}%`,
            right: `${inset.r * 100}%`,
            top: `${inset.t * 100}%`,
            bottom: `${inset.b * 100}%`,
            padding: FIT_PADDING,
            overflow: 'hidden',
          }}
        >
          {editing ? (
            <RichEditor
              value={data.nameRich}
              text={data.name ?? ''}
              sessionKey={`node:${id}`}
              nodeId={id}
              /* A shape's label is the one place on this canvas that is genuinely prose: a
                 callout, a caveat, a numbered list of three things. So Enter is a new line and
                 clicking away is what finishes. */
              multiline
              align={label.align}
              onCommit={commit}
              onCancel={() => setEditing(false)}
              className="w-full rounded border border-twilio-blue bg-white/90 px-1 text-[12px] font-semibold"
              style={{ color: text, ...label.textStyle }}
            />
          ) : (
            (data.name || data.nameRich) &&
            !data.labelHidden && (
              <span
                ref={textRef}
                className="pointer-events-auto max-w-full"
                onDoubleClick={(event) => {
                  if (!updateData && !rename) return
                  event.stopPropagation()
                  setEditing(true)
                }}
              >
                <RichLabel
                  value={data.nameRich}
                  text={data.name}
                  align={label.align}
                  className="text-[12px] font-semibold leading-tight"
                  style={{
                    color: text,
                    ...label.textStyle,
                    ...(squeeze ? { lineHeight: squeeze } : {}),
                  }}
                />
              </span>
            )
          )}
        </div>

        {locked && (
          <span className="absolute right-1 top-1" title="Placement locked. Right-click to unlock.">
            <Lock size={11} className="opacity-50" aria-hidden="true" />
          </span>
        )}

        {/* The corner-rounding dot. Only while selected, and only on a shape that has corners. */}
        {selected && !locked && geometry?.rounds && (
          <div
            role="slider"
            aria-label="Corner rounding"
            aria-valuenow={Math.round(radius * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            onPointerDown={dragCorner}
            onKeyDown={(event) => {
              /* Keyboard as well as pointer: this is the only control on the canvas that is purely a
                 drag, and a slider with no key bindings is unreachable without a mouse. */
              const step = event.shiftKey ? 0.2 : 0.05
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                setRadius?.(id, Math.min(1, radius + step))
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                setRadius?.(id, Math.max(0, radius - step))
              } else {
                return
              }
              event.preventDefault()
            }}
            title={`Drag to round the corners (${Math.round(radius * 100)}%)`}
            className="nodrag nopan absolute h-2.5 w-2.5 cursor-nwse-resize rounded-full border-2 border-white bg-twilio-warning shadow"
            style={{
              /* Moves inward as the radius grows, so the dot sits roughly where the curve now starts
                 -- it reads as the handle for *this* corner rather than a control parked nearby. */
              left: HANDLE_INSET + radius * 18,
              top: HANDLE_INSET + radius * 18,
              zIndex: 7,
            }}
          />
        )}
      </div>
    </>
  )
}

export default memo(ShapeNode)
