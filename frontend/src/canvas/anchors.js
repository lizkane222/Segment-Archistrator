/*
 * The topology, and which component's note is under the cursor.
 *
 * A context rather than a field on each node's `data`, because both are one fact about
 * the canvas and writing either into every node would mean rebuilding the whole node
 * array to change it -- which React Flow reads as a change to every node, and which
 * would land in `graphFingerprint` and mark the document dirty for a display state.
 *
 * Focus is the awkward one, and the reason there is a hand-rolled store below rather
 * than a second field on the context value. The notes live in a lane above the canvas
 * (simulation/NotesLane.jsx), so a note and the component it describes are far apart
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
 * Two, because a click has to outlive the pointer. Hovering a note lights up its component;
 * clicking one does the same thing and *keeps* doing it once the pointer has gone, which is
 * what lets a reader find a component in the lane and then go and work on it while it stays
 * marked. So `pinned` is a second slot with the same meaning and a different lifetime, and
 * `focused()` is the union: both light up, because a pin that dimmed the moment you looked
 * at the next note would have lost the only thing pinning bought.
 *
 * `hovered` is still separate from `pinned` rather than being written into it, because the
 * *lane* scrolls to whichever is being pointed at and must not fight a pin to do it -- that
 * is what `leader()` answers: the pointer while there is one, the pin otherwise.
 *
 * `clear` takes the id it is clearing rather than clearing unconditionally, because the two
 * ends of this are two elements and the pointer can move from one to the other: a mouseleave
 * on the component arrives *after* the mouseenter on its card, and an unconditional clear
 * would blank the hover that had already moved on.
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

export const AnchorContext = createContext({ topology: null, focus: NO_FOCUS })

export function useAnchors() {
  return useContext(AnchorContext)
}

/** Whether this component is lit -- a boolean, so the rest do not re-render. */
export function useAnchorFocused(id) {
  const { focus } = useAnchors()
  return useSyncExternalStore(focus.subscribe, () => focus.focused(id))
}

/**
 * The same two questions, for a reader that was handed the store instead of the context.
 *
 * The notes lane lives above the canvas rather than inside it, so it has no `AnchorContext` to read --
 * the store is passed to it as a prop by whoever owns both ends. `null` is tolerated so a lane rendered
 * without one still draws, rather than the caller needing a guard at every call site.
 */
export function useFocused(focus, id) {
  return useSyncExternalStore(
    focus?.subscribe ?? NO_SUBSCRIBE,
    () => focus?.focused(id) ?? false,
  )
}

export function usePinned(focus, id) {
  return useSyncExternalStore(
    focus?.subscribe ?? NO_SUBSCRIBE,
    () => (focus?.pinned() ?? null) === id,
  )
}

/* A stable no-op, so a null store does not hand `useSyncExternalStore` a new subscribe function on
   every render -- which it responds to by resubscribing on every render. */
const NO_SUBSCRIBE = () => () => {}
