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

import { memo, useCallback, useState } from 'react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { Lock } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import RichEditor from './RichEditor.jsx'
import RichLabel from './RichLabel.jsx'
import { LucidArt } from '../shapes/LucidArt.jsx'
import { shapeById, shapePath } from '../shapes/geometry.js'
import { useChrome } from '../chrome.js'
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

function ShapeNode({ id, data, selected }) {
  const { screenToFlowPosition } = useReactFlow()
  const { walkthroughActive, rename, setRadius, updateData } = useChrome()
  /* A boolean now rather than the draft text it used to hold: the draft lives in the DOM while a
     rich edit is in progress -- see RichEditor.jsx -- and holding a copy here as well would be two
     answers to "what does this label say". */
  const [editing, setEditing] = useState(false)

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
        className={`group relative ${aside ? 'walkthrough-aside' : ''} ${
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
          className={`absolute inset-0 flex p-2 ${label.itemsClass} ${label.justifyClass} ${
            editing ? '' : 'pointer-events-none'
          }`}
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
            (data.name || data.nameRich) && (
              <span
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
                  style={{ color: text, ...label.textStyle }}
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
