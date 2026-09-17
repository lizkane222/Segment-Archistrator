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
 *   - `routes`: where each connector actually runs, published *by* the edges and read by
 *     `simulation/EventLayer.jsx` so the travelling event follows the line the reader can see. See
 *     `edgeRoutes()` below for why this is a mutable registry rather than a value.
 *   - `flowPreview`: `{direction, edgeIds}` while a Flow row in the right-click menu is hovered,
 *     or null. The menu is asking "which way should data run", and the answer may turn a line
 *     round -- which a menu row cannot show and the canvas can. So the connectors concerned
 *     animate the way they *would* run, before anything is committed. `edgeIds: null` means
 *     every connector, which is what the bulk version previews.
 *   - `handleReveal`: which node the pointer is currently at the border of, so its four connection
 *     dots can appear and every other node's can stay hidden. A store rather than a value, for the
 *     same reason `edgeRoutes` is one -- see `handleReveal()` below.
 *   - `dragAnchor`: the free border point a connection drag most recently passed near on the node
 *     it started from, written by `ConnectionHandles` and consumed once by Canvas's `onConnect` --
 *     see `dragAnchor()` below for why a connection can only be *drawn* from a node's own fixed
 *     handles now, and how it still ends up attached to an exact point on the border.
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
 *
 * `flowPreview` is the closest thing to an exception and still on the right side of it: it
 * changes on hover, but on hover of a *menu row*, which fires once per row entered rather than
 * once per pointer position. A handful of renders while a submenu is open is not the case
 * anchors.js was built to avoid.
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * A registry of where the connectors run, written by the edges and read by the event layer.
 *
 * The moving event has to follow the line on screen, and that line is `FlowEdge`'s to compute: it
 * holds the chosen line style, the hand-dragged waypoints, and the free border anchors React Flow
 * cannot resolve on its own. Deriving it a second time in the overlay would be a second
 * implementation of the router, and the two disagreeing means an event that travels somewhere the
 * line does not go -- which is the failure the Flow hover preview is already careful to avoid by
 * measuring from the same centres the command does.
 *
 * So each edge publishes its own route and the overlay reads them. Mutable and outside React state
 * on purpose: this is geometry that changes on every drag frame and on every pan, and routing it
 * through state would re-render the canvas to move a dot. Nothing renders *from* this -- the overlay
 * samples it inside its own animation frame -- so there is no stale-render hazard to trade away.
 *
 * A route is `{points: [{x, y}, ...]}` in flow coordinates, running centre to centre. Centres, not
 * the border anchors the line is drawn between: the event has to arrive at a component, sit there,
 * and leave from the same place, and a token that stopped at the near border and resumed at the far
 * one would jump the width of the card on every hop.
 */
export function edgeRoutes() {
  const routes = new Map()
  return {
    publish(id, points) {
      if (points?.length >= 2) routes.set(id, points)
      else routes.delete(id)
    },
    /* Forgotten when the edge unmounts, so a deleted connector cannot leave a route behind for the
       overlay to draw an event along. */
    forget(id) {
      routes.delete(id)
    },
    get(id) {
      return routes.get(id) ?? null
    },
  }
}

/**
 * Where a connection drag last passed near this node's own border, while it is still this node's
 * drag to have an opinion about.
 *
 * A connection can now only be *started* from one of a node's four fixed side handles -- see
 * ConnectionHandles.jsx -- so React Flow's own `fromHandle` is always one of those, never a free
 * anchor. But the drag can still slide along the border before leaving the node, and the point it
 * was nearest when it did is what the user means by "start here instead". React Flow has no notion
 * of a handle changing mid-gesture, so the actual override happens after the fact: Canvas's
 * `onConnect` takes whatever is here (if anything) and writes it into the finished edge's
 * `sourceHandle` in place of the fixed one the drag technically began on.
 *
 * Mutable, not a value in React state, for the same reason `edgeRoutes` above is: it changes on
 * every pointer-move frame of a drag.
 *
 * Keyed by node id, and it used to be a single slot on the grounds that "there is never more than
 * one node with anything worth writing here". That was true only because of a bug. A connection has
 * *two* ends and both deserve to land where the user put them, but only the node a drag began on ever
 * published an anchor -- so `data.targetAnchor` was read, stored, reversed and tested throughout the
 * app and written by nothing, and every connector's arriving end snapped to one of four side
 * midpoints no matter where it was dropped. One slot could not have held both ends even once the
 * other started publishing, so this is a map.
 *
 * Bounded by the gesture: entries are only added while a drag is in progress, and `clear()` runs at
 * both ends of one. A pointer that grazes several nodes on its way leaves entries for each, and they
 * are harmless -- only the two ids that actually get connected are ever read.
 */
export function dragAnchor() {
  let current = new Map()
  return {
    set(nodeId, side, t) {
      current.set(nodeId, { nodeId, side, t })
    },
    /** Read once, and cleared with the read -- an override applies to the connection that produced
        it and never to a later one from the same node. */
    take(nodeId) {
      const anchor = current.get(nodeId)
      if (!anchor) return null
      current.delete(nodeId)
      return anchor
    },
    /** For a drag that ends without connecting, so a stale anchor cannot attach itself to a
        completely unrelated later connection from the same node. */
    clear() {
      current = new Map()
    },
  }
}

/**
 * Which node's connection handles the pointer has earned the right to see.
 *
 * The four dots used to be permanent furniture: drawn on every card at 40% opacity, and on
 * every zone at full. On a card the size of a business card that is four marks competing with
 * the name and the type; across a diagram of two hundred it is eight hundred of them. So they
 * are hidden now until the pointer is at a border, which is the only moment they are the thing
 * being reached for.
 *
 * A store outside React rather than state, for exactly the reason canvas/anchors.js has one:
 * this changes on pointer movement, and React Flow re-renders every node on any store change,
 * so a `setState` per mouse-move would put a whole-canvas render behind every pointer frame.
 * Each subscriber reads a *boolean about itself*, so React bails out on the other nodes.
 *
 * One id at a time, and no need for more: the pointer is in one place. A drag near a node is
 * the other way handles appear, and that one is not here -- each node answers it for itself
 * from React Flow's connection state, which it is already subscribed to.
 */
export function handleReveal() {
  let near = null
  const listeners = new Set()

  return {
    near: () => near,
    revealed: (id) => id != null && near === id,
    set(id) {
      if (near === id) return
      near = id
      for (const listener of listeners) listener()
    },
    /* Takes the id it is clearing, like `AnchorFocus.clear` and for the same reason: the
       pointer can leave one node by entering another, and the two events arrive in that
       order -- so an unconditional clear would blank the reveal that had already moved on. */
    clear(id) {
      if (near === id) this.set(null)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Which label is being edited right now, and where.
 *
 * The rich-text toolbar sits above the canvas (a `Panel`, beside the selection toolbar) and the
 * text being formatted is inside a node, so the two ends need a shared fact: *which* editor has
 * the caret. It cannot be node data -- the editor is transient and writing it into the document
 * would mark the diagram dirty for clicking into a label -- and it cannot be state on the node,
 * because the toolbar is not inside the node.
 *
 * The session carries the editable element itself, which is what lets the toolbar act at all: the
 * editor is an uncontrolled `contentEditable`, so bold is `document.execCommand` against the
 * element that has the selection, and there is no other way to reach it from outside. See
 * nodes/RichEditor.jsx for why the editor is uncontrolled.
 *
 * A store rather than context state, again -- but for a different reason from the others here. It
 * changes once per click into a label, which context would handle fine; what it must not do is
 * re-render the canvas *between* the editor mounting and the toolbar appearing, because a
 * re-render of the node while the browser holds a live caret inside it is how a caret gets lost.
 */
export function textEditing() {
  let session = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  return {
    current: () => session,
    begin(next) {
      session = next
      emit()
    },
    /* By key, like `AnchorFocus.clear` and `handleReveal.clear`: clicking from one label straight
       into another mounts the second editor before the first one blurs, so an unconditional end
       would close the session that had just opened. */
    end(key) {
      if (session?.key !== key) return
      session = null
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/* Flags off and no callbacks, which is what a node or edge rendered outside the canvas gets --
   the export path and any test that mounts one on its own. Everything degrades to "draw it, no
   badge, not editable", which is the reading with the fewest moving parts. */
const NO_CHROME = {
  showFlags: false,
  connected: false,
  rename: null,
  setRadius: null,
  /* How a node writes any other field back. `rename` and `setRadius` predate it and stay --
     they are what the tests and the two existing call sites use -- but a rich label commits two
     fields at once (`nameRich` and the plain `name` derived from it), which is the shape every
     later edit has too. */
  updateData: null,
  onWaypoints: null,
  walkthroughActive: false,
  flowPreview: null,
  routes: null,
  dragAnchor: null,
  /* A real store rather than null, for the same reason anchors.js keeps one: a node
     renderer mounted on its own -- the export path, a test -- still has something to
     subscribe to, and the alternative is an optional chain at every call site plus a
     `useSyncExternalStore` that has to cope with no subscribe function. */
  handleReveal: handleReveal(),
  textEditing: textEditing(),
}

export const ChromeContext = createContext(NO_CHROME)

export function useChrome() {
  return useContext(ChromeContext) ?? NO_CHROME
}

/** Whether this node's handles are showing because the pointer is at its border. */
export function useHandlesRevealed(nodeId) {
  const { handleReveal: reveal } = useChrome()
  return useSyncExternalStore(reveal.subscribe, () => reveal.revealed(nodeId))
}
