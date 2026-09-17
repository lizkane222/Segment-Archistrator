/*
 * A divider: one canvas, several diagrams, told apart.
 *
 * Drawn as the lines and nothing else -- no fill, no border of its own -- because the thing it is
 * dividing is the canvas, and a filled box would put a colour behind every zone dropped into it. The
 * only furniture is a title per section, which is what makes "before" and "after" readable at the
 * zoom someone screen-shares at.
 *
 * ## What it has in common with a zone, and what it does not
 *
 * Like a zone: a React Flow group node with explicit dimensions, whose children declare `parentId`,
 * so moving it moves everything inside. That is where "sections carry their contents" comes from for
 * the whole-frame case, and it is why a frame is a *container* in canvas/rules.js.
 *
 * Unlike a zone: it does not grow to fit what is put in it (`growZones` skips frames -- a division
 * of the canvas is a decision, not a box that follows its contents), it has no tint and no meaning
 * to the topology, and the pointer passes straight through it except on the dividers and the titles.
 *
 * ## Why the backdrop is click-through
 *
 * The same reason ZoneNode's is: a frame is hundreds of pixels of empty space that the pointer
 * crosses to reach everything inside it, so a solid hit target would swallow every click on the
 * diagram it contains and turn a drag across empty canvas into a drag of the frame. So only the
 * dividers, the drag strip at the top and the titles take events.
 */

import { memo, useCallback, useRef, useState } from 'react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { Lock } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import RichEditor from './RichEditor.jsx'
import RichLabel from './RichLabel.jsx'
import { useChrome } from '../chrome.js'
import { dividesX, dividesY, normalizeFrame, sectionsOf, splitFromPointer } from '../frames.js'
import { MIN_ZONE_HEIGHT, MIN_ZONE_WIDTH } from '../layout.js'

/* How wide a divider's grab area is, in screen pixels. The line itself is two pixels; this is the
   strip around it, and it is deliberately generous because the alternative to finding it is
   dragging the whole frame by mistake. */
const GRIP = 9

/* The default look. Grey and dashed, so it reads as a division of the working surface rather than as
   a component with a border -- and overridable like anything else through `data.style`. */
const DEFAULT_LINE = '#8891aa'

function FrameNode({ id, data, selected, width, height }) {
  const { screenToFlowPosition, getZoom } = useReactFlow()
  const { updateData } = useChrome()

  const frame = normalizeFrame(data.frame)
  const locked = Boolean(data.locked)
  const line = data.style?.border ?? DEFAULT_LINE
  const text = data.style?.text ?? line

  /*
   * The frame's own box, from the props React Flow passes a node renderer -- *not* from `data`.
   *
   * A zone's geometry is top-level on the node (that is where `NodeResizer` writes it and where
   * React Flow reads it), and `data` never hears about it -- see `zoneSize`. Read from `data`, both
   * came back undefined, the box fell through to the minimum, and every divider drew its lines a
   * few per cent in from the top-left corner of a region ten times that size.
   */
  const size = {
    width: width || MIN_ZONE_WIDTH,
    height: height || MIN_ZONE_HEIGHT,
  }
  const sections = sectionsOf(frame, size)

  /* Which section title is being typed into, or null. */
  const [editing, setEditing] = useState(null)
  const host = useRef(null)

  const setSplit = useCallback(
    (patch) => updateData?.(id, { frame: { ...frame, ...patch } }),
    [updateData, id, frame],
  )

  /*
   * Dragging a divider.
   *
   * Sets the fraction from the pointer's offset within the frame rather than nudging it by a delta,
   * for the same reason the table's dividers do: a delta per frame accumulates rounding over a long
   * drag and the line ends up somewhere the pointer is not.
   *
   * The *contents* are moved by `shiftSections`, which Canvas calls when the frame's data changes --
   * not from here. This component knows where the line goes; what that means for the nodes inside is
   * the canvas's business, and doing it here would be a node renderer writing other nodes.
   */
  const dragDivider = useCallback(
    (event, axis) => {
      event.stopPropagation()
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture?.(event.pointerId)

      const rect = host.current?.getBoundingClientRect()
      if (!rect) return
      const origin = screenToFlowPosition({ x: rect.left, y: rect.top })

      const onMove = (moveEvent) => {
        const at = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
        if (axis === 'x') setSplit({ splitX: splitFromPointer(at.x - origin.x, size.width) })
        else setSplit({ splitY: splitFromPointer(at.y - origin.y, size.height) })
      }
      const stop = () => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', stop)
        element.removeEventListener('pointercancel', stop)
      }
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', stop)
      element.addEventListener('pointercancel', stop)
    },
    [screenToFlowPosition, setSplit, size.width, size.height],
  )

  const commitLabel = (index) => ({ rich, text: plain }) => {
    setEditing(null)
    const labels = [...(frame.labels ?? [])]
    labels[index] = plain ? { text: plain, ...(rich ? { rich } : {}) } : undefined
    updateData?.(id, { frame: { ...frame, labels } })
  }

  return (
    <>
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={MIN_ZONE_WIDTH}
        minHeight={MIN_ZONE_HEIGHT}
        color={line}
        handleStyle={{ width: 14, height: 14, borderRadius: 3 }}
        lineStyle={{ borderWidth: 1 }}
      />

      {/* A frame can be an edge endpoint like anything else -- "this whole comparison feeds that
          one" is a sentence someone may want to draw. */}
      <ConnectionHandles border={line} />

      <div ref={host} className="pointer-events-none relative h-full w-full">
        {/* The outline, dashed and faint. Drawn as a div rather than as a border on the node so the
            node itself stays click-through. */}
        <div
          className="absolute inset-0 rounded-lg border-2 border-dashed"
          style={{ borderColor: line, opacity: 0.55 }}
        />

        {/* The dividing lines. Solid where the outline is dashed, because these are the thing the
            frame is *for* and a dashed cross reads as scaffolding. */}
        {dividesX(frame.axis) && (
          <div
            className="absolute top-0 h-full"
            style={{ left: sections[1].x, width: 2, background: line, opacity: 0.85 }}
          />
        )}
        {dividesY(frame.axis) && (
          <div
            className="absolute left-0 w-full"
            style={{
              /* The first section whose `y` is not zero: for a cross that is the third, for a
                 horizontal frame the second. */
              top: sections[dividesX(frame.axis) ? 2 : 1].y,
              height: 2,
              background: line,
              opacity: 0.85,
            }}
          />
        )}

        {/* One title per section, in the corner where a reader starts. Each is its own rich label,
            so "Before" can be bold and "After (proposed)" can carry an italic caveat. */}
        {sections.map((section, index) => {
          const label = frame.labels?.[index]
          const isEditing = editing === index
          if (!label?.text && !isEditing && !selected) return null
          return (
            <div
              key={index}
              className="pointer-events-auto absolute max-w-[45%] px-2 py-1"
              style={{ left: section.x, top: section.y }}
            >
              {isEditing ? (
                <RichEditor
                  value={label?.rich}
                  text={label?.text ?? ''}
                  sessionKey={`frame:${id}:${index}`}
                  nodeId={id}
                  onCommit={commitLabel(index)}
                  onCancel={() => setEditing(null)}
                  className="min-w-24 rounded border border-twilio-blue bg-white px-1 text-[11px] font-bold uppercase tracking-widest"
                  style={{ color: text }}
                />
              ) : (
                <span
                  className={`cursor-text text-[11px] font-bold uppercase tracking-widest ${
                    label?.text ? '' : 'italic opacity-50'
                  }`}
                  style={{ color: text }}
                  title="Double-click to name this section"
                  onDoubleClick={(event) => {
                    if (!updateData) return
                    event.stopPropagation()
                    setEditing(index)
                  }}
                >
                  {label?.text ? (
                    <RichLabel value={label.rich} text={label.text} />
                  ) : (
                    /* Only while selected, so an unnamed section is empty space to a reader and an
                       invitation to whoever is drawing. */
                    'name this section'
                  )}
                </span>
              )}
            </div>
          )
        })}

        {/*
          The drag handle: a strip along the very top, outside every section's title.

          A frame has to be movable and its backdrop has to stay click-through, which is the same
          bind a zone is in -- and the same answer, a named strip that `dragHandle` points at. Along
          the top rather than a corner, because a frame is usually as wide as the screen and a corner
          is somewhere the user has to go looking for.
        */}
        <div
          className={`frame-handle pointer-events-auto absolute -top-5 left-0 flex h-5 w-full items-center gap-1 px-2 ${
            locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
          }`}
        >
          <span className="text-[10px] uppercase tracking-widest" style={{ color: text, opacity: 0.7 }}>
            {data.name || 'Divider'}
          </span>
          {locked && (
            <span title="Placement locked. Right-click to unlock.">
              <Lock size={10} aria-hidden="true" style={{ color: text, opacity: 0.7 }} />
            </span>
          )}
        </div>

        {/* The divider grips. Always available, not only while selected: unlike a table's, these do
            not sit over anything -- the frame's own backdrop is empty by definition, and the nodes
            inside it are painted above. */}
        {!locked && dividesX(frame.axis) && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Move the vertical divider"
            title="Drag to move the divider. What is in each section moves with it."
            onPointerDown={(event) => dragDivider(event, 'x')}
            className="nodrag nopan pointer-events-auto absolute top-0 h-full cursor-col-resize"
            style={{ left: sections[1].x - GRIP / 2 / getZoom(), width: GRIP / getZoom() }}
          />
        )}
        {!locked && dividesY(frame.axis) && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Move the horizontal divider"
            title="Drag to move the divider. What is in each section moves with it."
            onPointerDown={(event) => dragDivider(event, 'y')}
            className="nodrag nopan pointer-events-auto absolute left-0 w-full cursor-row-resize"
            style={{
              top: sections[dividesX(frame.axis) ? 2 : 1].y - GRIP / 2 / getZoom(),
              height: GRIP / getZoom(),
            }}
          />
        )}
      </div>
    </>
  )
}

export default memo(FrameNode)
