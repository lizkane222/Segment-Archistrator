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

import { memo } from 'react'
import { NodeResizer, useNodes } from '@xyflow/react'
import { Lock } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import { useChrome } from '../chrome.js'
import { MIN_ZONE_HEIGHT, MIN_ZONE_WIDTH } from '../layout.js'
import { zoneStyleFor } from '../kinds.js'

function ZoneNode({ id, data, selected }) {
  const style = zoneStyleFor(data)

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
  const { walkthroughActive } = useChrome()
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
        handleStyle={{ width: 9, height: 9, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
      />

      {/* A zone can feed another zone -- Connections into Unify, say -- so it needs
          connection handles like any component. Dead centre on every side, like every other
          node: they do sit under the resize handles NodeResizer draws at the same edge
          midpoints while the zone is selected, which is why the connection handle is given a
          `zIndex` there and the resizer's whole edge *line* stays draggable, so nothing is lost.
          See ConnectionHandles.

          Not dimmed, unlike a component's: a zone is a large backdrop the pointer crosses
          constantly, so `group-hover` would flicker its handles on and off across the whole
          region, and there is no shortage of room for four dots on something this size. */}
      <ConnectionHandles border={style.border} />

      <div
        className={`pointer-events-none h-full w-full rounded-xl border-2 border-dashed ${
          aside ? 'walkthrough-aside-zone' : ''
        }`}
        style={{ background: style.bg, borderColor: style.border }}
      >
        {/* The grab cursor goes with the drag, so a locked zone must not advertise one --
            otherwise the header says "drag me" and then refuses, which reads as a stuck
            canvas rather than as a lock. */}
        <div
          className={`zone-handle pointer-events-auto flex items-baseline gap-2 px-4 pt-3 ${
            data.locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
          }`}
        >
          <span
            className="text-[11px] font-bold uppercase tracking-widest"
            style={{ color: style.border }}
          >
            {data.label}
          </span>
          {data.locked && (
            <span title="Placement locked. Right-click to unlock.">
              <Lock size={10} aria-hidden="true" style={{ color: style.border, opacity: 0.7 }} />
            </span>
          )}
          <span className="truncate text-[10px] text-twilio-gray-60">{data.description}</span>
          {empty && (
            /* An empty zone is normal -- plenty of workspaces have no Unify -- so
               say so rather than leaving an unexplained empty box. */
            <span className="ml-auto shrink-0 pr-2 text-[10px] italic text-twilio-gray-60">
              {data.custom ? 'drag anything here' : 'nothing here yet'}
            </span>
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
