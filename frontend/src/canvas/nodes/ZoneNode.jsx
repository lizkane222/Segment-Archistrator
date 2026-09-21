/*
 * A zone backdrop: Segment, one of the three products inside it, one of their
 * sub-zones, or a region the customer drew for something that lives outside
 * Segment altogether.
 *
 * This is a React Flow group node: children declare `parentId` pointing here, so moving
 * the zone moves everything in it. What they no longer declare is `extent: 'parent'` --
 * containment used to be a clamp React Flow enforced, and it is advice now, because a
 * component can belong to two products at once and the canvas outside every zone is a
 * working area. Canvas re-homes a node on drag stop instead.
 *
 * Two interaction details that are easy to get wrong:
 *
 *  - The backdrop keeps `pointer-events-none` and only the header strip takes
 *    events. Dragging from the backdrop would turn every click on empty space
 *    inside a zone into a move of the whole region -- and it is what leaves a drag
 *    across a zone's empty space panning the canvas, which is how you move around
 *    a diagram larger than the window. The cursor over the backdrop is set in
 *    styles/tokens.css, not here: React Flow puts `grab` on the node element that
 *    wraps this one, and a rule in a component whose element is click-through cannot
 *    override it.
 *  - The resize floor is flat, not computed from the children. It used to be their
 *    extents, so a handle stopped dead at the last component in the way and a zone
 *    laid out once could never be tightened up. The contents come with it instead,
 *    which Canvas does from the `dimensions` change this resizer emits -- not from
 *    here, because the nodes this component can see are the collapsed *view* and the
 *    ones that have to move are the document's.
 */

import { memo, useState } from 'react'
import { NodeResizer, useNodes } from '@xyflow/react'
import { Lock } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import RichEditor from './RichEditor.jsx'
import RichLabel from './RichLabel.jsx'
import { useChrome } from '../chrome.js'
import { hasFormatting } from '../richText.js'
import { MIN_ZONE_HEIGHT, MIN_ZONE_WIDTH } from '../layout.js'
import { zoneStyleFor } from '../kinds.js'

/*
 * The corner treatments a zone can take, as classes rather than radii.
 *
 * The same four names a component's `style.shape` uses, so one control serves both -- but a zone is
 * hundreds of pixels across, and a component's `rounded-full` pill would turn a region into a lozenge.
 * `pill` therefore means "generously rounded" here. `notched` has no meaning on a plain rectangle and
 * falls back to square, which is the honest reading of it.
 */
const ZONE_SHAPES = {
  rounded: 'rounded-xl',
  pill: 'rounded-[2rem]',
  square: 'rounded-none',
  notched: 'rounded-none',
}

function ZoneNode({ id, data, selected }) {
  const style = zoneStyleFor(data)
  const { updateData, walkthroughActive } = useChrome()
  const [editing, setEditing] = useState(false)

  /* Both halves of the label, like a component's name: `label` stays the field the inspector, the
     save advisories and the deletion warning all read, and `labelRich` carries the formatting. */
  const commit = ({ rich, text }) => {
    setEditing(false)
    const next = text.trim()
    /* A zone with no title is an unexplained box, and there would be nothing left to
       double-click to get the field back -- so blank is a cancel, as it is on a component. */
    if (!next) return
    const formatted = hasFormatting(rich) ? rich : undefined
    if (next === data.label && !formatted && !data.labelRich) return
    updateData?.(id, { label: next, labelRich: formatted })
  }

  /* `useNodes` re-renders this on every node change, which defeats the `memo`
     below. Accepted: zones are a handful of divs, and the alternative is reading
     React Flow's internal node lookup, which is not a public API and has changed
     shape between minor versions. */
  const nodes = useNodes()

  /* Any child counts, not just `kindCount`. The Segment zone holds no components of
     its own -- only the three product zones -- so counting components alone would
     have it permanently claiming to be empty. */
  const empty = !nodes.some((node) => node.parentId === id)

  /*
   * A zone the current walkthrough never enters recedes.
   *
   * Answered from the children rather than from anything stored on the zone: a zone has no path
   * state of its own, and it is *on* the path exactly when something inside it is. Descendants
   * count, not just direct children -- Segment holds only the three product zones, so counting
   * direct children alone would leave the whole backdrop dimmed while an event ran through
   * Connections inside it.
   *
   * `useNodes` above already re-renders this on every node change, so this costs a pass over the
   * list on a render that was happening anyway.
   */
  const aside =
    walkthroughActive && !nodes.some((node) => onPath(node) && within(node, id, nodes))

  return (
    <>
      <NodeResizer
        /* All eight handles: a zone grows in whichever direction the architecture
           it holds grew. None of them on a locked zone -- resizing a zone moves every
           component in it (`scaleZoneChildren`), which is the most placement a single
           gesture on this canvas can change, and so the first thing a lock has to stop. */
        isVisible={selected && !data.locked}
        minWidth={MIN_ZONE_WIDTH}
        minHeight={MIN_ZONE_HEIGHT}
        color={style.border}
        /* Wider than the connection dot it shares a midpoint with -- see ConnectionHandles --
           so most of the border is grabbable as a resize target rather than the sliver that
           used to survive outside the dot's own hit area. The dot still wins its own center,
           deliberately: it is the smaller target and the one with no alternative. */
        handleStyle={{ width: 16, height: 16, borderRadius: 3 }}
        lineStyle={{ borderWidth: 1 }}
      />

      {/* A zone can feed another zone -- Connections into Unify, say -- so it needs
          connection handles like any component. Dead centre on every side, like every other
          node: they do sit under the resize handles NodeResizer draws at the same edge
          midpoints while the zone is selected, which is why the connection handle is given a
          `zIndex` there and the resizer's whole edge *line* stays draggable, so nothing is lost.
          See ConnectionHandles.

          Revealed by border proximity like every other node's, which is what a zone needed all
          along: they used to be permanently visible here precisely because hover was the wrong
          test on a backdrop the pointer crosses on its way to everything else. "Near the border"
          means the same thing on a 900px region as on a card. */}
      <ConnectionHandles border={style.border} />

      {/*
        * The backdrop, drawn from the resolved style rather than from a fixed class list.
        *
        * `rounded-xl border-2 border-dashed` used to be hardcoded here, which meant a zone could be
        * given a colour and nothing else: the renderer had no way to honour an outline style, a width or
        * a corner, so the panel could not offer them. The defaults are unchanged -- they have moved into
        * `zoneStyleFor` -- so every existing diagram draws exactly as it did.
        */}
      <div
        className={`pointer-events-none h-full w-full ${ZONE_SHAPES[style.shape] ?? ZONE_SHAPES.rounded} ${
          aside ? 'walkthrough-aside-zone' : ''
        }`}
        style={{
          background: style.bg,
          borderColor: style.border,
          borderStyle: style.borderStyle,
          borderWidth: `${style.borderWidth}px`,
        }}
      >
        {/* The grab cursor goes with the drag, so a locked zone must not advertise one --
            otherwise the header says "drag me" and then refuses, which reads as a stuck
            canvas rather than as a lock. */}
        <div
          className={`zone-handle pointer-events-auto px-4 pt-3 ${
            data.locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
          }`}
        >
          <div className="flex items-baseline gap-2">
            {editing ? (
              <RichEditor
                value={data.labelRich}
                text={data.label ?? ''}
                sessionKey={`zone:${id}`}
                nodeId={id}
                /* Single-line, like a component's name and for the same reason: this is a
                   region's title, printed in one uppercase row that the zone's own width is
                   not negotiated around. */
                onCommit={commit}
                onCancel={() => setEditing(false)}
                className="min-w-24 rounded border border-twilio-blue bg-white px-1 text-[11px] font-bold uppercase tracking-widest"
                style={{ color: style.border }}
              />
            ) : (
              <span
                className="text-[11px] font-bold uppercase tracking-widest"
                style={{ color: style.border }}
                /* Double-click to rename, matching a component's card. The Zone tab is still the
                   way to do it without hunting for the header, and both write the same fields. */
                onDoubleClick={(event) => {
                  if (!updateData) return
                  event.stopPropagation()
                  setEditing(true)
                }}
              >
                <RichLabel value={data.labelRich} text={data.label} />
              </span>
            )}
            {data.locked && (
              <span title="Placement locked. Right-click to unlock.">
                <Lock size={10} aria-hidden="true" style={{ color: style.border, opacity: 0.7 }} />
              </span>
            )}
            {empty && (
              /* An empty zone is normal -- plenty of workspaces have no Unify -- so
                 say so rather than leaving an unexplained empty box. */
              <span className="ml-auto shrink-0 pr-2 text-[10px] italic text-twilio-gray-60">
                {data.custom ? 'drag anything here' : 'nothing here yet'}
              </span>
            )}
          </div>
          {/* On its own line rather than sharing the label row, so wrapping to two or three
              lines does not crowd the lock icon or the "nothing here yet" hint. */}
          {data.description && (
            <div className="mt-0.5 max-w-md whitespace-normal break-words text-[10px] text-twilio-gray-60">
              {data.description}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* Did any scenario's event actually arrive at this node? `paths` carries entries for components the
   event never reached too -- that is how "why did it not get here" is recorded -- so arrival is the
   test, not presence. */
function onPath(node) {
  return Boolean(node.data?.paths?.some((entry) => entry.arrived))
}

/* Is `node` inside the zone `zoneId`, at any depth? Walks `parentId` upward with a visited set,
   because the parent links come from live canvas state and a bad one should draw a diagram oddly
   rather than overflow the stack on a drag frame -- the same guard `growZones` and `orderForFlow`
   both keep. */
function within(node, zoneId, nodes) {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))
  const seen = new Set()
  let current = node
  while (current?.parentId && !seen.has(current.parentId)) {
    if (current.parentId === zoneId) return true
    seen.add(current.parentId)
    current = byId.get(current.parentId)
  }
  return false
}

export default memo(ZoneNode)
