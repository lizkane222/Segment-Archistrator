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
 * An off-centre point on the border is a *different feature*: a custom connector the user
 * places by hovering an edge. That is stored per edge, not per node, and does not come through
 * here.
 */

import { Fragment } from 'react'
import { Handle } from '@xyflow/react'

import { SIDES } from '../handles.js'

/**
 * @param border  the node's border colour, so the dots read as belonging to it
 * @param dim     draw them faintly until the node is hovered. On a card the dots are four more
 *   marks on something the size of a business card, so they stay out of the way until the
 *   pointer is on it -- but never to zero opacity, because a handle nobody can see is a feature
 *   nobody finds. The parent needs Tailwind's `group` for this. A zone passes false: it is a
 *   large backdrop the pointer crosses constantly, so `group-hover` would flicker its handles on
 *   and off across the whole region.
 */
export default function ConnectionHandles({ border, dim = false }) {
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
