/*
 * Canvas-wide chrome: what the nodes are allowed to draw, and how they hand an edit back.
 *
 * Three things live here, and they have one thing in common -- every node needs them and no
 * node's *document* should carry them:
 *
 *   - `showFlags`: whether the "Unbound" badge is drawn. A view setting, like the anchor
 *     gutter beside it, and not a fact about any component.
 *   - `connected`: whether a workspace token has been supplied. This is what makes the flag
 *     mean anything. Unbound is a comparison -- "this card is a placeholder, not the real
 *     component in your workspace" -- and with no workspace to compare against, *every*
 *     card is unbound and the badge is on all of them at once, which is the distraction
 *     rather than the information. So the flags are hidden by default until there is
 *     something to be bound to, and `showFlags` can then be turned off anyway.
 *   - `rename(id, name)`: how a node writes a name back. Double-clicking a card edits it in
 *     place, and the edit has to reach the same `setNodes` the inspector's field does or the
 *     two would show different names for the same component.
 *   - `setRadius(id, radius)`: how a shape writes its corner rounding back. Same argument as
 *     `rename` -- the drag happens inside the node renderer, the edit belongs to whoever owns the
 *     document.
 *   - `walkthroughActive`: whether a walkthrough is currently showing a frame. Nodes and zones need
 *     it to know they are being *left out* of a path, which is not something they can tell from
 *     their own data -- an untouched component carries no path state at all, and is
 *     indistinguishable from one on a canvas where nothing is playing.
 *   - `onWaypoints(edgeId, waypoints)`: how an edge writes a hand-dragged route back. Same
 *     argument as `rename` -- the drag happens inside the edge renderer, but the edit belongs to
 *     whoever owns the document. An edge reaching for the store directly would be a second write
 *     path with its own idea of when to snapshot history.
 *
 * Context rather than node data, for the same reason canvas/anchors.js is: putting any of
 * these into every node's `data` would mean a change to one of them rewriting every node
 * object on the canvas, and `serialize.js` would then need three more names in
 * RUNTIME_NODE_KEYS to keep them out of Postgres. A context value changes without touching
 * a single node.
 *
 * Unlike anchors.js this is *not* an external store. That module exists because a hovered id
 * changes on every mouse move; none of these change more than once per user action, so an
 * ordinary context is the simpler thing and a re-render of the canvas is the correct
 * response to `showFlags` flipping.
 */

import { createContext, useContext } from 'react'

/* Flags off and no callbacks, which is what a node or edge rendered outside the canvas gets --
   the export path and any test that mounts one on its own. Everything degrades to "draw it, no
   badge, not editable", which is the reading with the fewest moving parts. */
const NO_CHROME = {
  showFlags: false,
  connected: false,
  rename: null,
  setRadius: null,
  onWaypoints: null,
  walkthroughActive: false,
}

export const ChromeContext = createContext(NO_CHROME)

export function useChrome() {
  return useContext(ChromeContext) ?? NO_CHROME
}
