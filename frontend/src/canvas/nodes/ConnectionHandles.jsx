/*
 * The four sides a connector can leave from or arrive at, drawn.
 *
 * One component for both node renderers, because a component and a zone have to agree about
 * this exactly: an edge between them stores a handle id, and if the two disagreed about what
 * `n` means the edge would be drawn to a different side depending on which end you looked
 * from. See canvas/handles.js for why each side is two stacked handles rather than one.
 *
 * ## Always dead centre
 *
 * The four fixed handles sit at the midpoint of their side, on every node, with no exceptions.
 * Zones used to take them at 70% along the edge to dodge the resize handles NodeResizer draws
 * at the same midpoints -- which meant a connector between a zone and a component met the two
 * at visibly different heights, and the line acquired a kink that looked like a routing bug.
 *
 * The collision is real but it costs nothing to lose: `NodeResizer` on a zone is given a
 * visible `lineStyle`, and that line is draggable along its whole length. So an edge-resize
 * still works anywhere on the border except the 9 pixels at the midpoint, and the corners are
 * untouched. The connection handle wins that overlap deliberately, via `zIndex` -- it is the
 * smaller target and the one with no alternative.
 *
 * ## And one that is not fixed at all
 *
 * A fifth handle follows the cursor along whichever border it is nearest, so a connector can be drawn
 * from -- or dropped onto -- any point on the outline rather than only a midpoint. It matters as soon
 * as three lines arrive at the same side of one component: at the midpoint they overlap for their
 * last 20px and a reader cannot tell which goes where.
 *
 * That handle exists only while the pointer is near a border, which is why the *edge* resolves its
 * geometry rather than React Flow: a moment after the drag the handle is gone, and React Flow's own
 * lookup would put that end of the line at the node's origin. See canvas/handles.js and
 * `anchorPoint` in edges/FlowEdge.jsx.
 */

import { Fragment, useState } from 'react'
import { Handle } from '@xyflow/react'

import { SIDES, encodeFreeHandle, nearestBorder } from '../handles.js'

/*
 * How close to a border the pointer has to be before the free dot appears.
 *
 * Wide enough to be reachable without precision, narrow enough that moving across the middle of a
 * card never summons it -- and narrower than half the shortest card, or the dot would be permanently
 * visible on a 36px-high chip and there would be nowhere to click that was not "start a connection".
 */
const BORDER_REACH = 14

/**
 * @param border  the node's border colour, so the dots read as belonging to it
 * @param dim     draw them faintly until the node is hovered. On a card the dots are four more
 *   marks on something the size of a business card, so they stay out of the way until the
 *   pointer is on it -- but never to zero opacity, because a handle nobody can see is a feature
 *   nobody finds. The parent needs Tailwind's `group` for this. A zone passes false: it is a
 *   large backdrop the pointer crosses constantly, so `group-hover` would flicker its handles on
 *   and off across the whole region.
 */
export default function ConnectionHandles({ border, dim = false, free = true }) {
  /*
   * A fifth handle that follows the cursor along whichever border it is nearest.
   *
   * This is how a connector comes to meet a component somewhere other than a midpoint, which matters
   * as soon as three lines arrive at the same side: at the midpoint they overlap for their last 20px
   * and a reader cannot tell which goes where.
   *
   * Local state, and it is a render per pointer move over the *border strip only* -- the handler
   * returns early well before `setAnchor` for a pointer anywhere else on the card, so crossing the
   * middle of a component costs nothing. That is the reason for `BORDER_REACH` rather than tracking
   * every move and deciding in the renderer.
   */
  const [anchor, setAnchor] = useState(null)

  const track = (event) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const found = nearestBorder(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      /* The box on *screen*, so the reach is in screen pixels and the strip stays the same width to
         the pointer at every zoom. Converting to flow units would make it unusably thin zoomed out. */
      { width: box.width, height: box.height },
    )
    if (found.distance > BORDER_REACH) {
      /* Cleared rather than left behind: a stale dot at the last border the pointer passed is a
         connection start point sitting somewhere the user is not looking. */
      if (anchor) setAnchor(null)
      return
    }
    if (anchor && anchor.side === found.side && Math.abs(anchor.t - found.t) < 0.01) return
    setAnchor({ side: found.side, t: found.t })
  }

  return (
    <>
      {free && (
        /* A transparent overlay across the whole card, purely to track the pointer. `inset: 0` on the
           node's own element rather than a handler on the card, because the card is where the label
           and the buttons live and a move handler there would fight them for the pointer. */
        <div
          className="absolute inset-0"
          style={{ pointerEvents: 'auto', background: 'transparent' }}
          onPointerMove={track}
          onPointerLeave={() => anchor && setAnchor(null)}
        />
      )}

      {anchor && (
        /* The handle itself, positioned by percentage along the side it snapped to. Its *id* carries
           the anchor, which is what makes the connection remember where it was drawn from with no new
           document field -- see canvas/handles.js. */
        <Handle
          type="source"
          id={encodeFreeHandle(anchor.side, anchor.t)}
          position={anchor.side}
          className="pointer-events-auto !h-3 !w-3 !border-2 !bg-white"
          style={{
            borderColor: border,
            /* Above the four fixed dots and above the resizer: it is under the cursor, so it has to
               be the thing the cursor grabs. */
            zIndex: 6,
            ...(anchor.side === 'left' || anchor.side === 'right'
              ? { top: `${anchor.t * 100}%` }
              : { left: `${anchor.t * 100}%` }),
          }}
          title="Drag to connect from this exact point on the border"
        />
      )}

      <FixedHandles border={border} dim={dim} />
    </>
  )
}

function FixedHandles({ border, dim }) {
  return SIDES.map((side) => {
    /* Both types per side, sharing an id. Source first, so a pointer aimed at the side lands
       on the exit -- starting a connection is what the dot is mostly for, and `Loose` mode
       means the drop end works regardless of which of the pair is on top. */
    const shared = {
      id: side.id,
      position: side.position,
      className: `pointer-events-auto !h-2 !w-2 !border-2 !bg-white transition-opacity ${
        dim ? 'opacity-40 group-hover:opacity-100' : ''
      }`,
      /* Above the resizer's own handles, which land on the same four midpoints while a zone is
         selected. Without this the user gets whichever was painted last, which is not something
         they can see or predict. */
      style: { borderColor: border, zIndex: 5 },
      title: `Drag to connect from the ${side.label}`,
    }
    return (
      <Fragment key={side.id}>
        <Handle type="source" {...shared} />
        <Handle type="target" {...shared} />
      </Fragment>
    )
  })
}
