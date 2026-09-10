/*
 * Anchor visibility, the topology, and which anchor is under the cursor.
 *
 * A context rather than a field on each node's `data`, because "show every anchor"
 * is one fact about the canvas and writing it into every node would mean rebuilding
 * the whole node array on a toggle -- which React Flow reads as a change to every
 * node, and which would land in `graphFingerprint` and mark the document dirty for
 * a display preference. What *is* per-node -- `anchor: 'step'` while the playhead
 * is here -- stays in `data`.
 *
 * Focus is the awkward one, and the reason there is a hand-rolled store below rather
 * than a third field on the context value. The gutter (canvas/anchorGutter.js) put the
 * notes outside the drawing, so a note and the component it describes are now far apart
 * and each has to light the other up -- which means hover can no longer be local state
 * inside one node renderer. It also cannot be React state on the canvas: React Flow
 * re-renders every node on any store change, so a `setState` per mouse-enter would put
 * a whole-canvas render on every mouse move across a 300-node architecture, which is
 * exactly what SegmentNode's memo() and its local hover state were protecting against.
 *
 * So the focused id lives outside React and is read through `useSyncExternalStore`. The
 * store's identity never changes, so putting it on the context costs no re-render; and
 * because each subscriber's snapshot is a boolean about *itself*, React bails out of
 * re-rendering the other 298 nodes whose answer did not change.
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * The focused-anchor store: two ids, and whoever wants to know about them.
 *
 * Two, because a click has to outlive the pointer. Hovering a note expands it and lights
 * up its component; clicking one does the same thing and *keeps* doing it once the
 * pointer has gone, which is what makes a note readable while the user works on the
 * component it describes -- the reason to click one at all. So `pinned` is a second slot
 * with the same meaning and a different lifetime, and `focused()` is the union: both
 * light up, because a pinned note that dimmed the moment you looked at its neighbour
 * would have lost the only thing pinning bought.
 *
 * `hovered` is still separate from `pinned` rather than being written into it, because
 * the leader line can only usefully be drawn once -- two dashed lines across a diagram
 * read as edges, which is precisely what `Leader`'s comment says this must not do. The
 * line follows `leader()`: the pointer while there is one, the pin otherwise.
 *
 * `clear` takes the id it is clearing rather than clearing unconditionally, because the
 * two ends of a leader line are two elements and the pointer can move from one to the
 * other: a mouseleave on the component arrives *after* the mouseenter on its note, and
 * an unconditional clear would blank the hover that had already moved on.
 */
export function createAnchorFocus() {
  let hovered = null
  let pinned = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const set = (id) => {
    if (hovered === id) return
    hovered = id
    emit()
  }

  return {
    hovered: () => hovered,
    pinned: () => pinned,
    /* Whichever end the cursor is on, falling back to the pin. */
    leader: () => hovered ?? pinned,
    focused: (id) => id != null && (hovered === id || pinned === id),
    set,
    clear: (id) => {
      if (hovered === id) set(null)
    },
    /* A toggle, so the gesture that opens a note also closes it. Clicking a second note
       moves the pin rather than adding one: two notes held open drift apart from what the
       user is actually pointing at, and the gutter has no room to say which is which. */
    pin: (id) => {
      const next = pinned === id ? null : id
      if (pinned === next) return
      pinned = next
      emit()
    },
    clearPin: () => {
      if (pinned === null) return
      pinned = null
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/* A real store, not null, so a node renderer used outside a provider still has something
   to call. The alternative is an optional-chain at every call site and a hover that
   silently does nothing when one of them is forgotten. */
const NO_FOCUS = createAnchorFocus()

export const AnchorContext = createContext({ topology: null, showAll: false, focus: NO_FOCUS })

export function useAnchors() {
  return useContext(AnchorContext)
}

/** The id the leader line points at, for the one component that draws it. */
export function useAnchorLeader() {
  const { focus } = useAnchors()
  return useSyncExternalStore(focus.subscribe, focus.leader)
}

/** Whether this component is lit -- a boolean, so the rest do not re-render. */
export function useAnchorFocused(id) {
  const { focus } = useAnchors()
  return useSyncExternalStore(focus.subscribe, () => focus.focused(id))
}

/** Whether this note is the pinned one, for the control that says so. */
export function useAnchorPinned(id) {
  const { focus } = useAnchors()
  return useSyncExternalStore(focus.subscribe, () => focus.pinned() === id)
}
