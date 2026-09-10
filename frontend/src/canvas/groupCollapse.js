/*
 * The collapse state, for the node renderers.
 *
 * A context for the same reason AnchorContext is one: which groups are folded away is
 * one fact about the canvas, and threading it through node `data` would rebuild every
 * node on a toggle -- and put a reading preference somewhere `serializeNode`'s spread
 * would carry it into the document as a per-node field.
 *
 * `expand` is here rather than passed down because a stack node has to be able to
 * open itself: clicking one is the obvious way out of a group, and the alternative --
 * a callback injected into the derived node data by `collapseGraph` -- would make the
 * pure module take a function argument purely so a renderer could reach it.
 */

import { createContext, useContext } from 'react'

export const GroupCollapseContext = createContext({
  topology: null,
  collapsed: [],
  expand: () => {},
})

export function useGroupCollapse() {
  return useContext(GroupCollapseContext)
}
