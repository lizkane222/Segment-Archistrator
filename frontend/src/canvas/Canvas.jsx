/*
 * The React Flow canvas.
 *
 * Rule enforcement happens at two seams, both React Flow hooks rather than
 * custom drag handling:
 *
 *   - `isValidConnection` refuses illegal edges mid-drag, so the handle shows as
 *     invalid before the mouse is released.
 *   - `onNodeDragStop` re-homes whatever was dragged, by the node's centre, and grows
 *     the zones that now have to contain it. React Flow does not reparent on drag and
 *     nothing clamps a node to its zone any more, so without this a component dragged
 *     into another product would render over it while remaining the old zone's child.
 *   - `onNodesChange` is intercepted for two things: to *remark on* a placement the
 *     topology finds unusual (it used to refuse one), and to stop a zone's resize at the
 *     box its own contents occupy -- see `clampZoneResize`.
 *   - `onBeforeDelete` filters a deletion that would take a populated zone's
 *     children with it.
 *
 * All of them consult the server's topology payload; none has rules of its own.
 *
 * Which note is highlighted and the collapse state are provided through context rather
 * than written into each node's data -- see canvas/anchors.js for why that distinction
 * matters. The notes themselves are not drawn here at all; they live in a lane above the
 * canvas (simulation/NotesLane.jsx), and hovering a card here is what lights one there.
 *
 * The `nodes` and `edges` handed in are a *view*: Workbench collapses the document
 * before passing it down (canvas/grouping.js). So a node here may be a `groupStack`
 * standing for many, whose id the document has never heard of -- which is why a change
 * addressed to one is translated onto its members before it reaches the store, and why
 * clicking one opens the group rather than the inspector.
 */

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionMode,
  Panel,
  ReactFlow,
  SelectionMode,
  addEdge,
  applyNodeChanges,
  reconnectEdge,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Sparkles, Tag } from 'lucide-react'

import FlowEdge from './edges/FlowEdge.jsx'
import GroupControl from './GroupControl.jsx'
import GroupStackNode from './nodes/GroupStackNode.jsx'
import SegmentNode from './nodes/SegmentNode.jsx'
import ShapeNode from './nodes/ShapeNode.jsx'
import TableNode from './nodes/TableNode.jsx'
import ZoneOrFrame from './nodes/ZoneOrFrame.jsx'
import EventLayer from '../simulation/EventLayer.jsx'
import { AnchorContext, createAnchorFocus } from './anchors.js'
import { GroupCollapseContext } from './groupCollapse.js'
import { ChromeContext, dragAnchor, edgeRoutes, handleReveal, textEditing } from './chrome.js'
import { orientConnection, sideOf } from './direction.js'
import { FlashContext } from './flash.js'
import { codeSeed } from '../functions/defaults.js'
import { applyBinding, boundSegmentIds, replacementPatch } from '../binding/bindMatch.js'
import { DROPPED_STYLE } from './dropDefaults.js'
import { EDGE_MENU, NODE_MENU, PANE_MENU } from '../commands/registry.js'
import { isGroupStackId, translateGroupDrag } from './grouping.js'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  clampZoneResize,
  componentSize,
  droppedZoneSize,
  edgeZFor,
  growZones,
  orderForFlow,
  toFlowNode,
  toZoneNode,
  zoneNodeId,
  zoneSize,
} from './layout.js'
import {
  absolutePositions,
  attachTargetFor,
  explainMisplacement,
  explainRejection,
  isValidPlacement,
  kindOf,
  makeConnectionValidator,
  reparentTarget,
  toZoneLocal,
  zoneAtPosition,
  zoneLabel,
  zoneOfParent,
} from './rules.js'
import { avoidingWaypoints } from './edges/routing.js'
import {
  PIN_TYPE,
  cleanPoint,
  detachEnd,
  endBox,
  isLoose,
  isPinId,
  loosePoint,
  looseEnds,
  pinNodesFor,
  pinnedEdges,
  pointKey,
  withoutPoint,
} from './edges/looseEnds.js'
import { instanceLabel, nextZoneInstance, shiftSections } from './frames.js'
import { columnCount, rowCount, scaleTable, tableSize } from './tables.js'
import {
  SIDES,
  alongBorder,
  anchorStringFor,
  distanceToBox,
  encodeFreeHandle,
  facingSide,
  fanOutAnchors,
  fixedHandleForSide,
  internalBox,
  nearestBorder,
  parseFreeHandle,
} from './handles.js'
import { styleFor } from './kinds.js'
import SelectionToolbar from './SelectionToolbar.jsx'
import TextToolbar from './TextToolbar.jsx'
import {
  GROUP_ID_PREFIX,
  alignNodes,
  groupNodes,
  groupSelectionChanges,
  matchSize,
  matchStyle,
  selectedComponents,
  ungroupNodes,
  withGroupMates,
} from './selection.js'

/* Declared once, at module scope. React Flow warns (and rebuilds its internal
   node registry) if these object identities change between renders. */
const NODE_TYPES = {
  segmentNode: SegmentNode,
  shape: ShapeNode,
  table: TableNode,
  /* A divider is stored as a zone and drawn differently -- see nodes/ZoneOrFrame.jsx. */
  zone: ZoneOrFrame,
  groupStack: GroupStackNode,
  /* A loose connector end's stand-in. Always hidden, so never drawn -- registered only because React
     Flow resolves the type before it checks `hidden`, and warns about one it does not know. */
  [PIN_TYPE]: () => null,
}
const EDGE_TYPES = { flow: FlowEdge }

export const DRAG_MIME = 'application/segment-arch-kind'

/*
 * How close to a node's border the pointer has to be for its connection dots to appear, in
 * screen pixels.
 *
 * 32 rather than a rounder number because it is half of NODE_HEIGHT plus a little: a card at
 * the default height has no middle worth speaking of, so anywhere on one counts. A card someone
 * has dragged taller, and every zone, has a middle that does not -- which is the case that made
 * permanently-visible handles the lesser evil before this existed, since the pointer crosses a
 * zone on its way to everything inside it.
 */
const BORDER_REVEAL = 32

/*
 * How far outside a component an endpoint drag may be released and still land on it.
 *
 * 45, the same number as `connectionRadius` on the flow below, because it answers the same
 * question for the same gesture: aim at the card, get the nearest side. Divided by the zoom
 * where it is used, like `BORDER_REACH` and `DRAG_REACH` in ConnectionHandles, so the slop
 * stays the same distance *to the pointer* at every zoom rather than shrinking to nothing
 * zoomed out.
 */
const ENDPOINT_REACH = 45

/*
 * The style every *component* gets when it is dragged onto the canvas.
 *
 * A constant rather than three literals at the drop site, so the palette, the catalog and anything
 * added later cannot drift apart.
 *
 * Not applied to the two kinds that are drawings rather than components. A `shape` is an outline drawn
 * around or beside components and `ShapeNode` defaults it to 2px for a stated reason -- "a hairline
 * triangle reads as a scratch" -- while `rounded` is meaningless against an explicit geometry and a
 * radius the shapes palette already supplies. A `table` is furniture too. Both would be actively worse
 * for being made to match a card.
 */
export { DROPPED_STYLE }

/* Drawings, not components: they keep their own defaults -- see `DROPPED_STYLE`. */
const DRAWING_KINDS = new Set(['shape', 'table'])

export default function Canvas({
  topology,
  nodes,
  edges,
  documentNodes = nodes,
  groups = [],
  collapsed = [],
  onCollapsedChange,
  onAutoAlign,
  onNodesChange,
  onEdgesChange,
  setNodes,
  setEdges,
  onInspect,
  onContextMenu,
  onNotify,
  onAdvise,
  onRename,
  onSetRadius,
  /* How a node writes any field of its own data back -- a rich label commits two at once. The
     same `updateNode` the inspector's fields call, so an edit on the card and one in the sidebar
     land on the same undo stack. */
  onUpdateData,
  flash,
  connected = false,
  walkthroughActive = false,
  /* `{direction, edgeIds}` while a Flow row in the right-click menu is hovered. Passed
     straight into the chrome context for the edges to read -- see canvas/chrome.js. */
  flowPreview = null,
  /* The travelling event: one timed itinerary per path (`simulation/choreography.js`), and the
     transport's clock. Drawn by `EventLayer` inside the flow so it pans and zooms with the diagram,
     and mounted here rather than in `AppShell` for that reason alone. */
  eventPlans = null,
  eventClock = null,
  /* Which component's note is lit, shared with the notes lane above the canvas. Owned by the app
     because the lane sits outside this component and both ends of the highlight need the same store --
     see canvas/anchors.js for why it lives outside React. */
  anchorFocus = null,
  exporting = false,
}) {
  const { screenToFlowPosition, getNode, getInternalNode, getZoom } = useReactFlow()

  /*
   * Whether the "Unbound" badge is drawn.
   *
   * Off by default. With no workspace connected, `connected` hides the toggle outright (see
   * below), so this only starts to matter the moment a workspace is bound -- and at that moment
   * it should still be the user's call whether to see the badges, not a wall of orange sprung on
   * them the instant they connect.
   *
   * What `connected` gates is whether the control appears at all: with no workspace the distinction
   * the badge draws does not exist yet.
   */
  const [showFlags, setShowFlags] = useState(false)

  /* The one place React Flow is handed the list, so the one place its ordering rule has
     to be satisfied -- see orderForFlow. Everything else here reads the props, because
     order is React Flow's constraint and not a fact about the document. */
  /*
   * A hidden pin per loose connector end -- see edges/looseEnds.js for why React Flow needs a node
   * there at all.
   *
   * Keyed on a signature of just the loose ends rather than on `edges`, because `edges` changes on
   * every selection click and every style tweak, and a new node array each time would have React
   * Flow re-adopt every node on the canvas for a change that moved none of them.
   */
  const pinSignature = edges
    .filter(isLoose)
    .map((edge) => `${edge.id}:${JSON.stringify(edge.data?.sourcePoint ?? null)}:${JSON.stringify(edge.data?.targetPoint ?? null)}:${edge.source ?? ''}:${edge.target ?? ''}`)
    .join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the signature, see above
  const pins = useMemo(() => pinNodesFor(edges), [pinSignature])

  const flowNodes = useMemo(() => {
    /* Appended after everything else so they never disturb the parent-before-child order
       `orderForFlow` guarantees. */
    const ordered = pins.length ? [...orderForFlow(nodes), ...pins] : orderForFlow(nodes)
    /*
     * `data.locked` -> React Flow's own drag and selection flags, applied here rather than
     * in `toFlowNode`, because this is the one seam every node reaches the canvas through.
     * Written into the node at build time instead, a locked card would come back draggable
     * after any paste, duplicate or palette drop that did not remember to re-apply it.
     *
     * Still selectable. A locked node has to be selectable or there would be no way to
     * unlock it -- the menu acts on the selection -- and selecting it is also how the
     * inspector is reached, which a lock on *placement* has no business preventing.
     */
    if (!ordered.some((node) => node.data?.locked)) return ordered
    return ordered.map((node) =>
      node.data?.locked ? { ...node, draggable: false, dragHandle: undefined } : node,
    )
  }, [nodes, pins])

  /*
   * No anchor notes are drawn here at all any more, and there is no control for them.
   *
   * There were two homes and both had the same problem in different clothes: a tooltip over the
   * component covered the components either side of it, and a gutter column outside the drawing lived
   * in *flow* space, so at any zoom that fitted the diagram it sat off both edges of the screen -- the
   * toggle appeared to do nothing until you zoomed out to find it. Notes are now a screen-space lane
   * above the canvas (simulation/NotesLane.jsx), always present, showing whatever is in view.
   *
   * What survives here is the *highlight*: hovering a component lights its card in the lane, through
   * the shared focus store below.
   */

  /* Outside React on purpose. See canvas/anchors.js: a hovered id in state would put a
     whole-canvas render on every mouse move. Created once, so it costs the context value
     nothing to carry. */
  /* Supplied by the app, because the notes lane is the other end of this highlight and it sits outside
     this component. Falls back to a store of its own so a canvas mounted on its own -- the export path,
     a test -- still has something to call. */
  const fallbackFocus = useMemo(() => createAnchorFocus(), [])
  const focus = anchorFocus ?? fallbackFocus
  const anchors = useMemo(() => ({ topology, focus }), [topology, focus])

  const expand = useCallback(
    (key) => onCollapsedChange?.(collapsed.filter((entry) => entry !== key)),
    [collapsed, onCollapsedChange],
  )
  const groupCollapse = useMemo(
    () => ({ topology, collapsed, expand }),
    [topology, collapsed, expand],
  )
  /*
   * A hand-dragged route, written onto the edge.
   *
   * Stored under `data.waypoints` rather than as a top-level key, so it goes through
   * `serializeEdge` with the rest of the edge's own facts and comes back through `toFlowEdge`.
   * Cleared to `undefined` when the list empties, so an edge whose bends have all been removed
   * serializes identically to one that never had any -- otherwise straightening a connector would
   * leave an empty array behind and mark every such diagram dirty on open.
   */
  const onWaypoints = useCallback(
    (edgeId, waypoints) => {
      setEdges((current) =>
        current.map((edge) =>
          edge.id === edgeId
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  waypoints: waypoints?.length ? waypoints : undefined,
                  /*
                   * Touched by a hand, so no longer the router's to recompute.
                   *
                   * Cleared on every commit, including one that *removes* the last bend: a straightened
                   * connector is a decision too, and re-deriving a route the user had just flattened
                   * would be the app arguing with them.
                   */
                  routed: undefined,
                },
              }
            : edge,
        ),
      )
    },
    [setEdges],
  )

  /*
   * Which connector is in route-adjust mode, entered by double-clicking the line.
   *
   * One at a time, and held here rather than in each edge, which is what makes that guarantee
   * cheap: two edges showing handles at once means two sets of dots competing for the same few
   * pixels wherever the lines cross, and no way to tell which line a dot belongs to.
   *
   * Selection already reveals the handles, so this is not the only way in -- it is the *deliberate*
   * way in, and it survives clicking elsewhere, which selection does not.
   */
  const [adjustingEdgeId, setAdjustingEdgeId] = useState(null)

  /* Where every connector runs, written by the edges as they draw themselves and read by
     `EventLayer`. A stable registry rather than a value, so republishing a route on a drag frame
     does not re-render the canvas -- see `edgeRoutes` in canvas/chrome.js. */
  const routes = useMemo(() => edgeRoutes(), [])

  /* Where a connection drag last passed near the border of the node it started on -- see
     `dragAnchor` in canvas/chrome.js and the `onConnect` override below. Stable for the same
     reason `routes` is: it changes every pointer-move frame of a drag, and routing that through
     state would re-render the canvas to move a dot. */
  const dragAnchorRegistry = useMemo(() => dragAnchor(), [])

  /* Which node's connection dots are showing. Stable for the same reason the two registries
     above are: it changes on pointer movement, and putting that through state would re-render
     every node on the canvas to fade four dots in on one of them. See canvas/chrome.js. */
  const reveal = useMemo(() => handleReveal(), [])

  /* Which label is being edited, shared with the rich-text toolbar above the canvas. Stable for
     the same reason: mounting an editor must not re-render the canvas, because a re-render while
     the browser holds a live caret inside a node is how a caret gets lost. */
  const editingText = useMemo(() => textEditing(), [])
  /* Read here as well as in the toolbar, because *which* bar the panel draws is this component's
     decision -- see the panel below. One render of the canvas per click into a label, which is
     the same cost a selection change already has. */
  const editingLabel = useSyncExternalStore(editingText.subscribe, editingText.current)

  /*
   * Where each connector sits along the side it meets, when several meet the same one.
   *
   * Computed here because it is the only question in this file that no single edge can answer: a
   * connector cannot know how many siblings share its arrival side. One pass over the edge list,
   * turned into per-end fractions by `fanOutAnchors` (canvas/handles.js), and read back by each
   * `FlowEdge` for its own two ends.
   *
   * Hand-placed anchors are left out and therefore keep exactly where the user put them -- this
   * only fills the default, which was "every line lands on the midpoint" and drew four connectors
   * as one. `order` is the *opposite* end's position across the side, so the lines fan out in the
   * order they are going rather than in whatever order the array happens to hold.
   */
  const fanAnchors = useMemo(() => {
    const attachments = []
    for (const edge of edges) {
      for (const end of ['source', 'target']) {
        const nodeId = end === 'source' ? edge.source : edge.target
        /* A loose end has no component and so no side to share. */
        if (!nodeId) continue
        const stored = end === 'source' ? edge.data?.sourceAnchor : edge.data?.targetAnchor
        if (parseFreeHandle(stored)) continue
        const farEnd = end === 'source' ? 'target' : 'source'
        /* The far end of a loose connector is a point, which orders it just as well as a card. */
        const farPoint = loosePoint(edge, farEnd)
        const other = farPoint
          ? { internals: { positionAbsolute: farPoint }, measured: { width: 0, height: 0 } }
          : getInternalNode(edge[farEnd])
        const at = other?.internals?.positionAbsolute
        if (!at) continue
        /* `.side`, because `sideOf` returns `{side, flow, edgeId}`. Passing the whole record made
           every key `"<nodeId>|[object Object]"`, so all of a card's ends landed in one bucket
           whatever side they used -- an end on the left was spread as though it shared the right
           with three others, and a single connector arriving alone was pushed off the midpoint by
           siblings on other sides entirely. */
        const side = sideOf(edge, nodeId)?.side
        const across =
          side === 'left' || side === 'right'
            ? at.y + (other.measured?.height ?? 0) / 2
            : at.x + (other.measured?.width ?? 0) / 2
        attachments.push({ key: `${edge.id}:${end}`, nodeId, side, order: across })
      }
    }
    return fanOutAnchors(attachments)
    /* `nodes` is a dependency because the ordering is geometric: moving a card changes which slot
       its connectors deserve. */
  }, [edges, nodes, getInternalNode])

  /*
   * One end of a connector, dragged to a point and dropped.
   *
   * ## Why this exists alongside `onReconnect`
   *
   * `onReconnect` is React Flow's path, and it is reached through anchors the library draws
   * itself: two `<circle fill="transparent">`s (`EdgeAnchor`) placed at the edge's reported
   * endpoint and shifted `reconnectRadius` *outward* from the node. Two problems, and together
   * they are the whole of "I cannot move the ends of a connector".
   *
   * They are invisible, so nothing says an end can be grabbed at all. And on this canvas they
   * are frequently not where the line is: an end carrying a `data.sourceAnchor` or a
   * `fanOutAnchors` share is *drawn* at a point `FlowEdge` computes, while React Flow's anchor
   * stays at the handle's midpoint. So the reader aims at the visible end of the line and
   * grabs nothing, because the target is somewhere else and cannot be seen either way.
   *
   * So `edgesReconnectable` is off and `FlowEdge` draws its own grips at `start`/`end` -- the
   * points it actually strokes between -- and releases into this. `onReconnect` stays wired up
   * regardless: it costs nothing, and a future path that goes through the library should not
   * find it missing.
   *
   * ## What it writes
   *
   * The same three facts, in the same shape, as `onConnect`: the endpoint id, the *fixed*
   * handle for the side, and the precise point as an anchor in `data`. Never a `free:` id in
   * `sourceHandle` -- see canvas/handles.js, where that mistake made the edge undrawable
   * forever rather than merely misplaced.
   *
   * @param end   'source' or 'target' -- which end the gesture grabbed
   * @param drop  `{nodeId, side, t}` from `endpointDropTarget`, or null for a release on
   *   nothing, which is a cancel
   */
  const onEndpointMove = useCallback(
    (edgeId, end, drop, point) => {
      const edge = edges.find((entry) => entry.id === edgeId)
      if (!edge) return
      const other = end === 'source' ? 'target' : 'source'
      const free = looseEnds(edge)

      /* A merged line stands for several connectors, none of which is the one being dragged. */
      if (edge.data?.aggregated) {
        onNotify?.({
          tone: 'info',
          message: 'This line stands for several connectors. Expand the group to move one of them.',
        })
        return
      }

      /*
       * Released over empty canvas: the end is let go of *there*, and the connector is left pointing at
       * a component that does not exist yet -- see edges/looseEnds.js.
       *
       * Refused for the two cases where that would be destroying something rather than drawing it. A
       * connector whose other end is already loose would be attached to nothing at all, which is not a
       * connector. And one read from the workspace is a fact: disconnecting it on the diagram would
       * claim something about the customer's setup that is not true.
       */
      if (!drop) {
        const at = cleanPoint(point)
        if (!at) return
        if (free[end]) {
          setEdges((current) =>
            current.map((entry) =>
              entry.id === edgeId
                ? {
                    ...entry,
                    data: { ...entry.data, [pointKey(end)]: { x: Math.round(at.x), y: Math.round(at.y) } },
                  }
                : entry,
            ),
          )
          return
        }
        if (free[other]) {
          onNotify?.({
            tone: 'info',
            message: 'The other end is not connected either. Drop this end on a component, or delete the connector.',
          })
          return
        }
        if ((edge.data?.discovered ?? edge.discovered) === true) {
          onNotify?.({
            tone: 'info',
            message: 'This connection was read from the workspace, so it cannot be left unconnected. Disconnect it in Segment.',
          })
          return
        }
        setEdges((current) =>
          current.map((entry) => (entry.id === edgeId ? detachEnd(entry, end, at) : entry)),
        )
        return
      }

      if (isGroupStackId(drop.nodeId) || isPinId(drop.nodeId)) {
        onNotify?.({
          tone: 'info',
          message: 'Expand the group first — a connection has to name the component it reaches.',
        })
        return
      }

      const connection = {
        source: end === 'source' ? drop.nodeId : edge.source,
        target: end === 'target' ? drop.nodeId : edge.target,
        sourceHandle: end === 'source' ? fixedHandleForSide(drop.side) : edge.sourceHandle,
        targetHandle: end === 'target' ? fixedHandleForSide(drop.side) : edge.targetHandle,
      }

      /*
       * Released over the component at the *other* end, which would fold the connector into a loop
       * on one card.
       *
       * Refused, even though the validator deliberately permits a self-connection -- drawing one on
       * purpose is a drawable thing and there is a handle on each of four sides for it. Reaching one
       * *this* way is different: it is a slipped drag, it destroys the connection the reader was
       * adjusting, and the only way back is to draw it again. So the end returns to where it was,
       * with a word about why. Checked before the validator, which would wave it through.
       */
      if (drop.nodeId === edge[other]) {
        onNotify?.({
          tone: 'info',
          message: 'Both ends would be on the same component. Drop this end somewhere else, or delete the connector.',
        })
        return
      }

      /* Nothing moved: the end went back onto the same side of the same component. Returned
         before the validator, which would refuse it as a duplicate of the edge it *is*. */
      const sameEnd =
        connection[end] === edge[end] &&
        connection[`${end}Handle`] === edge[`${end}Handle`]

      /* The edge being moved is excluded, exactly as in `onReconnect`: counting it against
         itself would report the pair as already connected.

         Only asked when both ends will be attached. The rules are about what may connect to what, and
         a connector still loose at its other end does not connect two things yet -- the check runs
         when that end is dropped. */
      const others = edges.filter((entry) => entry.id !== edgeId)
      if (
        !sameEnd &&
        !free[other] &&
        !makeConnectionValidator({ topology, getNode, edges: others })(connection)
      ) {
        onNotify?.({
          tone: 'error',
          message: explainRejection({
            from: getNode(connection.source),
            to: getNode(connection.target),
            edges: others,
          }),
        })
        return
      }

      setEdges((current) =>
        current.map((entry) =>
          entry.id === edgeId
            ? {
                ...entry,
                ...connection,
                data: {
                  /* An end that was loose is not any more, so its point goes. */
                  ...withoutPoint(entry.data, end),
                  /* Where along that side, which is the point of dragging rather than picking
                     from a menu. Only the end that moved -- the other keeps whatever it had. */
                  [`${end}Anchor`]: encodeFreeHandle(drop.side, drop.t),
                },
              }
            : entry,
        ),
      )
    },
    [edges, topology, getNode, setEdges, onNotify],
  )

  /*
   * Where an endpoint drag would land, given the pointer in flow coordinates.
   *
   * Built here rather than inside the edge because it needs every node's box, which no single
   * edge can see. A callback rather than a value: it runs on pointer release, not on render.
   *
   * ## Hit-tested against `nodes`, not `documentNodes`
   *
   * The *view*, deliberately, and it is the one place in this file where that is the right list.
   * `documentNodes` holds the members of a collapsed group, which are not on screen -- so a release
   * over a stack would silently attach the connector to whichever hidden member happened to be
   * nearest, and the reader would see a line vanish into a stack pointing at something they cannot
   * see. Hit-testing what is drawn means a stack is found *as a stack*, which `onEndpointMove` can
   * then refuse by name.
   *
   * Components win over zones outright, and a zone is only considered when no component is in
   * reach. A zone's box covers everything inside it, so ranking the two together would attach
   * most drops to the backdrop the reader was aiming *through*.
   */
  const endpointDropTarget = useCallback(
    (point) => {
      const reach = ENDPOINT_REACH / getZoom()
      let best = null
      let bestDistance = Infinity
      for (const box of componentBoxes(nodes, { stacks: true })) {
        const distance = distanceToBox(box, point)
        if (distance > reach || distance >= bestDistance) continue
        best = box
        bestDistance = distance
      }

      /* Only the inside of a zone counts, via the same containment test a palette drop uses --
         a zone is a region, so "near its border" is not a thing anyone aims at.

         A *divider* is excluded. It is stored as a zone and `zoneAtPosition` prefers the deepest
         hit, so a release over empty canvas inside one resolved to the frame -- and a connector
         attached to a layout divider is a line pointing at a piece of furniture, which nothing
         downstream refuses and no reader could explain. */
      const under = zoneAtPosition(nodes, point)
      const box = best ?? (under?.data?.frame ? null : boxOfZone(under, nodes))
      if (!box) return null

      const found = nearestBorder(
        { x: point.x - box.x, y: point.y - box.y },
        { width: box.width, height: box.height },
      )
      return { nodeId: box.id, side: found.side, t: found.t }
    },
    [nodes, getZoom],
  )

  const chrome = useMemo(
    () => ({
      showFlags,
      connected,
      rename: onRename ?? null,
      setRadius: onSetRadius ?? null,
      updateData: onUpdateData ?? null,
      onWaypoints,
      onEndpointMove,
      endpointDropTarget,
      adjustingEdgeId,
      walkthroughActive,
      flowPreview,
      routes,
      fanAnchors,
      dragAnchor: dragAnchorRegistry,
      handleReveal: reveal,
      textEditing: editingText,
    }),
    [
      showFlags,
      connected,
      onRename,
      onSetRadius,
      onUpdateData,
      onWaypoints,
      onEndpointMove,
      endpointDropTarget,
      adjustingEdgeId,
      walkthroughActive,
      flowPreview,
      routes,
      fanAnchors,
      dragAnchorRegistry,
      reveal,
      editingText,
    ],
  )

  /*
   * Publish whether the pointer is at the border of the node it is over.
   *
   * Through React Flow's own `onNodeMouseMove` rather than a handler inside each renderer, for
   * two reasons. It is the only version that answers the question once: the event names the node
   * the pointer is on, so this is O(1) per frame rather than a pass over every node's box. And it
   * keeps the three node renderers free of pointer plumbing -- an always-mounted overlay tracking
   * hover on every card is exactly what used to sit over a zone's header and swallow its drags.
   *
   * The reach is divided by the zoom so it stays the same distance *to the pointer* at every
   * zoom level, which is the same correction `BORDER_REACH` makes in ConnectionHandles.
   */
  const onNodeMouseMove = useCallback(
    (event, node) => {
      const internal = getInternalNode?.(node.id)
      const at = internal?.internals?.positionAbsolute
      const width = internal?.measured?.width
      const height = internal?.measured?.height
      if (!at || !width || !height) return

      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const near = alongBorder({ x: at.x, y: at.y, width, height }, point, BORDER_REVEAL / getZoom())
      if (near) reveal.set(node.id)
      else reveal.clear(node.id)
    },
    [getInternalNode, screenToFlowPosition, getZoom, reveal],
  )

  /*
   * A first route for a new connector that does not cross the components in between.
   *
   * The endpoints come from React Flow's measured handle geometry rather than being recomputed from
   * the node boxes, because the handle is where the line actually starts -- guessing "the middle of
   * the right-hand edge" would be wrong for any card that has been resized, and wrong for all four
   * sides on a card whose handles the user has re-picked.
   *
   * The two components being connected are excluded from the obstacles, because a line to a card
   * necessarily touches it. So are zones: a zone is a region the diagram is drawn *in*, and a
   * connector routing around Connections rather than through it would have nowhere to go.
   */
  /*
   * The handle ids for the two ends of a connection, each facing the other component.
   *
   * Null for an end whose geometry is not measured yet, so the caller falls back to whatever React Flow
   * reported rather than to a guess. See `facingSide` in canvas/handles.js for the rule and for what it
   * deliberately does not touch.
   */
  const facingFor = useCallback(
    (connection) => {
      const boxOf = (id) => internalBox(getInternalNode?.(id))
      /* A loose end is a point, which the attached end can face just as well as a card. It gets no
         handle of its own -- there is no component there to have one. */
      const from = endBox(connection, 'source', boxOf)
      const to = endBox(connection, 'target', boxOf)
      if (!from || !to) return { source: null, target: null }
      const free = looseEnds(connection)
      return {
        source: free.source ? null : fixedHandleForSide(facingSide(from, to)),
        target: free.target ? null : fixedHandleForSide(facingSide(to, from)),
      }
    },
    [getInternalNode],
  )

  const avoidanceFor = useCallback(
    (connection) => {
      const from = getInternalNode?.(connection.source)
      const to = getInternalNode?.(connection.target)
      const geometry = fromToGeometry(from, to, connection)
      if (!geometry) return []

      const skip = new Set([connection.source, connection.target])
      const boxes = componentBoxes(documentNodes).filter((box) => !skip.has(box.id))
      return avoidingWaypoints({ ...geometry, boxes })
    },
    [getInternalNode, documentNodes],
  )

  /*
   * Which component the multi-selection copies its size and style from.
   *
   * The last one clicked, held here rather than derived, because there is nothing in the
   * document that records the order a selection was built in -- and every rule that *can*
   * be derived (first in the array, largest, topmost) is one the user cannot predict
   * before pressing the button. The toolbar names it for the same reason.
   */
  const [modelId, setModelId] = useState(null)

  const selection = useMemo(() => {
    const chosen = selectedComponents(documentNodes, documentNodes.filter((node) => node.selected).map((node) => node.id))
    const ids = chosen.map((node) => node.id)
    /* Falls back to the first selected rather than to nothing when the model has been
       deselected: a toolbar whose two copy-from buttons do nothing until the user happens
       to re-click one of their own selection reads as broken, and the toolbar says which
       card it landed on either way. */
    const model = chosen.find((node) => node.id === modelId) ?? chosen[0] ?? null
    return {
      ids,
      model,
      grouped: chosen.some((node) => node.data?.group),
    }
  }, [documentNodes, modelId])

  /*
   * Every toolbar action, applied to the *live* document rather than to this render's copy.
   *
   * The updater form is load-bearing and its absence was a real bug. `documentNodes` is a
   * prop, so it is whatever the last render was handed -- and the click that built the
   * selection queues its own `select` changes through the same `setNodes`. Passing a value
   * here therefore replaced the store with an array from before those landed, and the
   * selection the user had just made vanished the instant they pressed a button on the
   * toolbar that existed *because* of it. `selection.ids` is safe to close over: it is what
   * was selected when the button was rendered, which is exactly what the button is about.
   */
  const runSelection = useCallback(
    (transform) => setNodes((current) => growZones(transform(current, selection.ids))),
    [selection.ids, setNodes],
  )

  /* `growZones` after each of these for the same reason the resize handles call it: an
     align or a match-size can push a card past its zone's edge, and a zone that does not
     grow leaves its own child clipped outside it. */
  const onAlign = useCallback(
    (alignment) => runSelection((nodes_, ids) => alignNodes(nodes_, ids, alignment)),
    [runSelection],
  )
  const onMatchSize = useCallback(
    () => runSelection((nodes_, ids) => matchSize(nodes_, ids, selection.model?.id)),
    [runSelection, selection.model],
  )
  const onMatchStyle = useCallback(
    () => runSelection((nodes_, ids) => matchStyle(nodes_, ids, selection.model?.id)),
    [runSelection, selection.model],
  )
  const onGroup = useCallback(
    () =>
      runSelection((nodes_, ids) =>
        groupNodes(nodes_, ids, `${GROUP_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`),
      ),
    [runSelection],
  )
  const onUngroup = useCallback(() => runSelection(ungroupNodes), [runSelection])

  /*
   * Which end the connection drag started at.
   *
   * The one fact that decides which way a new connector points, and it is not in the connection React
   * Flow hands back. Every side of a card carries a source handle and a target handle stacked under one
   * id, and a drag begun on the target handle is reported with the ends the other way round -- so
   * without this the direction of every hand-drawn connector was set by which of two invisible handles
   * was painted last. See `orientConnection` in canvas/direction.js.
   *
   * A ref, because it changes on a gesture rather than being rendered from, and it has to be readable
   * synchronously inside `isValidConnection` while the pointer is still moving.
   */
  const connectFrom = useRef(null)

  const isValidConnection = useMemo(() => {
    const valid = makeConnectionValidator({ topology, getNode, edges })
    /* Wrapped rather than taught about stacks: `rules.js` answers questions about the
       document, and a stack is not in it. Refusing here is also what makes the handle
       read as invalid mid-drag instead of only on release.

       Oriented first, so the rules are asked about the connector the user is actually drawing. Asked
       about the reported pair instead, a legal source-to-destination drag would be judged as
       destination-to-source and refused mid-drag -- the handle going red for a connection that is
       perfectly valid. */
    return (candidate) => {
      const connection = orientConnection(candidate, connectFrom.current)
      /* A pin is a loose end's stand-in, not a component -- see edges/looseEnds.js. It registers a
         handle so React Flow can draw to it, which also makes it findable by a connection drag. */
      return (
        !isGroupStackId(connection.source) &&
        !isGroupStackId(connection.target) &&
        !isPinId(connection.source) &&
        !isPinId(connection.target) &&
        valid(connection)
      )
    }
  }, [topology, getNode, edges])

  /*
   * Wrap the store's change handler so a parent reassignment can be *remarked on*
   * before it lands. It used to be vetoed -- the change was dropped and a toast said
   * why. That is no longer right: a component may now be placed in any zone, or in
   * none, because some of them genuinely belong to two products at once and the bare
   * canvas is a working area. What the topology knows about where a thing usually goes
   * is still worth saying, so it is said once, to the console, instead of blocking the
   * move. Position and dimension changes stream through untouched -- they arrive every
   * frame of a drag and must not be filtered.
   */
  const handleNodesChange = useCallback(
    (rawChanges) => {
      /* First, because everything downstream -- the advisory, the store itself -- only
         knows document ids. A stack's id is not one, so a drag of it has to become a
         drag of each member before anyone else sees it. */
      const changes = translateGroupDrag(rawChanges, nodes, documentNodes)

      for (const change of changes) {
        if (change.type !== 'replace' || !change.item) continue
        /* The zone itself, not its id: whether a placement is conventional depends on
           the zone being one of Segment's or one the customer drew. */
        const nextZone = getNode(change.item.parentId)?.data
        const kind = kindOf(change.item)
        if (!nextZone || !kind) continue
        if (isValidPlacement(topology, kind, nextZone)) continue
        onAdvise?.(explainMisplacement({ topology, kind, attemptedZone: nextZone }), change.item.id)
      }

      /*
       * A zone being resized stops at its own contents.
       *
       * Not skipped when the same frame also moves the zone, which is what a top or left
       * handle does: `clampZoneResize` needs that position, because whatever the floor
       * refuses to take off the size has to be given back to the origin or the zone grows
       * from the edge nobody dragged. So the two changes are paired up here rather than
       * one of them disqualifying the other.
       *
       * Done inside one `setNodes` rather than after `onNodesChange`, because the floor is
       * measured against the children's *current* positions and the clamped position has to
       * replace the resizer's before either lands. Two queued updates would race.
       *
       * `setAttributes` is the discriminator, for exactly the reason stated on `sized` below:
       * React Flow emits a `dimensions` change for every *measurement* too -- once per node on
       * mount and again whenever the DOM reports a new box -- and only a resize handle sets this
       * flag. A measurement reports the zone's box in *screen* pixels, so treating one as a resize
       * ran the clamp against a number at the current zoom: the shipped template opened at
       * 2035 wide and was immediately written down to 1914, the measured width at 0.19 zoom.
       *
       * This filter lacked the flag while the branch called `scaleZoneChildren`, and the bug was
       * invisible there only because a measurement's ratio is ~1 and scaling by 1 changes nothing.
       * The clamp has no such accidental immunity, which is what surfaced it.
       */
      const movedTo = new Map(
        changes.filter((change) => change.type === 'position').map((change) => [change.id, change]),
      )
      const resizes = changes.filter(
        (change) =>
          change.type === 'dimensions' &&
          change.setAttributes &&
          change.dimensions &&
          documentNodes.some((node) => node.id === change.id && node.type === 'zone'),
      )

      /*
       * A component resize, written into the document.
       *
       * `setAttributes` is the whole discriminator, and it has to be: React Flow emits a
       * `dimensions` change for every *measurement* too -- once per node on mount, again
       * whenever the DOM reports a new box -- and only a resize handle sets this flag.
       * Mirroring the measurements instead would bake one browser's text metrics into the
       * saved document (the thing serialize.js strips `measured` to avoid) and mark a
       * diagram dirty the moment it finished loading.
       */
      const sized = changes.filter(
        (change) =>
          change.type === 'dimensions' &&
          change.setAttributes &&
          change.dimensions &&
          documentNodes.some((node) => node.id === change.id && node.type !== 'zone'),
      )

      if (resizes.length || sized.length) {
        setNodes((current) => {
          let next = applyNodeChanges(changes, current)
          /* The dividers resized in this batch, which `growZones` must not touch -- see the note
             where it is called. Ids rather than a flag, so a batch that resized a divider *and*
             something else still grows the something else. */
          const framesResized = new Map()
          for (const change of resizes) {
            const before = current.find((node) => node.id === change.id)
            /*
             * A divider's contents move; a zone's contents stay exactly where they are.
             *
             * The difference is what each one *is*. A divider is a division of the canvas into
             * sections, and its sections hold whole diagrams: what moves when it is dragged is
             * each section, by however far its own origin moved, taking its contents with it.
             * See `shiftSections` in canvas/frames.js.
             *
             * A zone is a box drawn *around* components that are already arranged. Stretching
             * or tightening the box says nothing about the arrangement inside it, so nothing
             * inside moves -- the box simply stops when it reaches them. See `clampZoneResize`,
             * and its header for what this used to do instead.
             */
            if (before?.data?.frame) {
              framesResized.set(change.id, change.dimensions)
              const from = zoneSize(before)
              next = shiftSections(
                next,
                change.id,
                { frame: before.data.frame, ...from },
                { frame: before.data.frame, ...change.dimensions },
              )
              continue
            }

            /* Measured against `current`, the positions the children had before this batch --
               which is also what they have after it, since a zone resize never moves them. */
            /* `before.position` is the third argument and is load-bearing: it is how the clamp tells
               a near-edge drag from a far-edge one per axis. Omitted, the size object bound to
               `from` and `to` came through undefined, so every resize collapsed to the contents'
               bounding box. */
            const clamped = clampZoneResize(current, change.id, before?.position, {
              ...change.dimensions,
              position: movedTo.get(change.id)?.position,
            })
            next = next.map((node) =>
              node.id === change.id
                ? {
                    ...node,
                    width: clamped.width,
                    height: clamped.height,
                    /* Both, because React Flow renders the top-level pair and `zoneSize` reads
                       it first -- a zone carrying a stale `style` size would serialize at one
                       size and draw at another. */
                    ...(node.style ? { style: { ...node.style, width: clamped.width, height: clamped.height } } : {}),
                    ...(clamped.position ? { position: clamped.position } : {}),
                  }
                : node,
            )
          }
          if (sized.length) {
            const byId = new Map(sized.map((change) => [change.id, change.dimensions]))
            next = next.map((node) => {
              const box = byId.get(node.id)
              if (!box) return node
              /* Rounded for the same reason positions are: a sub-pixel width produces a
                 diff on every save and makes "did this change?" unanswerable by eye. */
              const size = { width: Math.round(box.width), height: Math.round(box.height) }
              /*
               * A table's box *is* its columns and rows, so dragging its outer edge has to scale
               * the grid -- otherwise the node is one size and the table drawn inside it another,
               * and the handles appear to do nothing but move the border. Read from `current`
               * rather than from `next`, because the old box is what the scale is a ratio of and
               * `next` already has the new one.
               */
              if (node.data?.table) {
                const before = current.find((entry) => entry.id === node.id)
                return {
                  ...node,
                  data: {
                    ...node.data,
                    size,
                    table: scaleTable(before?.data?.table, tableSize(before?.data?.table), size),
                  },
                }
              }
              return { ...node, data: { ...node.data, size } }
            })
          }
          /*
           * Grow whatever now has to contain more than it did: a card dragged wider than the room
           * its zone has left, or a sub-zone dragged wider than its parent -- either of which
           * leaves a child drawn outside a backdrop it is still a child of.
           *
           * A no-op for a zone just clamped, deliberately: `clampZoneResize` floors it at exactly
           * the `minZoneSize` this measures, so there is nothing left to grow. That is what makes
           * the handle stop where it stopped rather than springing back a frame later.
           *
           * Skipped entirely for a *divider*, which is the one resize whose contents move. A
           * divider tightened from 400 to 300 has just pulled its sections inward, and `growZones`
           * -- which cannot tell a section's margin from an overflow -- measured the moved cards and
           * pushed it back out to 310. So a frame resize returns what `shiftSections` produced,
           * untouched. Nothing is lost: a frame's children are only ever moved *inward* by this
           * path, so there is no overflow for a grow pass to fix.
           */
          if (!framesResized.size) return growZones(next)
          /*
           * Grow everything else, then put the dividers back.
           *
           * `growZones` floors every zone at `minZoneSize`, which adds `CHILD_MARGIN` beyond the
           * last child -- right for a zone drawn *around* an arrangement, and wrong for a divider,
           * whose sections legitimately run right up to their own boundary. `shiftSections` has
           * just pulled those sections inward, so the grow pass measured the moved cards and pushed
           * the frame back out: a divider dragged 400 -> 300 sprang to 310.
           *
           * Restoring by id rather than skipping the pass outright, so a component resized in the
           * same batch still gets the zone growth it needs.
           */
          const grown = growZones(next)
          return grown.map((node) => {
            const box = framesResized.get(node.id)
            return box ? { ...node, width: box.width, height: box.height } : node
          })
        })
        return
      }

      /*
       * A group is selected and released as one.
       *
       * That is the whole of what a group is here: React Flow already drags a
       * multi-selection together, so the drag path needs to know nothing about groups --
       * see `groupSelectionChanges` in canvas/selection.js, which is also where the
       * ordering rule for the appended changes is explained.
       *
       * Done on the change stream rather than in `onNodeClick` because a rubber-band
       * selection and a select-all arrive as changes and never as a click, and a group
       * half-caught by a lasso would come apart on the next drag.
       */
      const mates = groupSelectionChanges(documentNodes, changes)
      const forwarded = mates.length ? [...changes, ...mates] : changes

      if (forwarded.length) onNodesChange(forwarded)
    },
    [onNodesChange, setNodes, topology, getNode, onAdvise, nodes, documentNodes],
  )

  /*
   * Re-home whatever was just dragged, and grow the zones that now have to contain it.
   *
   * This is the work `extent: 'parent'` used to do for free by making it impossible:
   * React Flow does not reparent on drag, so without this a component dragged from
   * Connections into Unify would render over Unify while remaining Connections' child
   * -- and would jump back the moment Connections moved. Zones go through the same
   * path, which is what lets Unify be pulled out to sit beside Connections.
   *
   * The node handed to the callback is the authority on where the drag ended; the props
   * can still be a frame behind it. So the moved positions are written in first and
   * everything else is derived from the result.
   *
   * ## Two things here are about *clicks*, not drags
   *
   * React Flow ends a drag it started, and it starts one on the smallest pointer movement.
   * So an ordinary click on a card -- which almost never lands on exactly one pixel -- used
   * to arrive here as a completed drag, and this callback then rewrote the entire document.
   * That is what made clicking flaky in two ways at once, and both are fixed below:
   *
   *   - Nothing moved, so there is nothing to write. `nodeDragThreshold` on the flow means
   *     most of those never reach here at all now; the guard covers the rest, and also the
   *     drag that ends exactly where it began.
   *   - The write goes through the updater form. `documentNodes` is a prop, and the same
   *     click queues `select` changes through the same store -- so writing a *value* built
   *     from the prop replaced the store with an array from before the selection landed,
   *     and the click appeared to select nothing. `runSelection` above had the same bug.
   */
  const onNodeDragStop = useCallback(
    (_event, node, dragged) => {
      const moved = dragged?.length ? dragged : node ? [node] : []
      if (!moved.length) return

      /* Rounded, because that is the precision positions are stored at (`serializeNode`):
         a half-pixel that will be rounded away on save is not a move, and treating it as
         one marks the document dirty for a click. */
      const same = (a, b) =>
        Math.round(a?.x ?? 0) === Math.round(b?.x ?? 0) &&
        Math.round(a?.y ?? 0) === Math.round(b?.y ?? 0)
      const shifted = moved.some((item) => {
        const before = documentNodes.find((entry) => entry.id === item.id)
        /* Unknown id: a group stack, which stands for members that *are* in the document
           and whose own position changes arrive separately. Treated as a move so the
           members are still re-homed. */
        return !before || !same(before.position, item.position)
      })
      /*
       * Connector sides are re-faced before the "did anything actually move" guard below, because they
       * are a question about where things are *now* rather than about whether the document changed. It
       * is idempotent -- an end already on the right side is left alone -- so running it on every drag
       * stop costs nothing.
       *
       * It has to be before the guard for a blunter reason too: that guard compares each dragged node
       * against `documentNodes`, which React Flow has already updated through `onNodesChange` during the
       * drag, so it is comparing the new position with itself and returns early on a drag that plainly
       * moved something. Worth a look on its own account -- everything after it is behind that early
       * return -- but not something to change quietly from here.
       */
      /*
       * Moving a component can leave its connectors attached to the wrong side.
       *
       * Draw A to a B on its right, then drag B to the far left: the line still leaves A's *east* side,
       * so it exits east, turns, and crosses back over A. That is how 13 connector ends in the saved
       * diagrams came to face away from where they were going, one of them by 2095px -- nobody chose it,
       * a component moved afterwards.
       *
       * Only ends with no hand-placed anchor, and only connectors touching something that just moved. A
       * reader who dragged an end to a particular point on a border said something, and it is not this
       * function's business to argue.
       */
      const moving = new Set(moved.map((item) => item.id))
      setEdges((current) =>
        current.map((edge) => {
          if (!moving.has(edge.source) && !moving.has(edge.target)) return edge
          const facing = facingFor(edge)
          const sourceFixed = parseFreeHandle(edge.data?.sourceAnchor) ? null : facing.source
          const targetFixed = parseFreeHandle(edge.data?.targetAnchor) ? null : facing.target
          if (
            (sourceFixed == null || sourceFixed === edge.sourceHandle) &&
            (targetFixed == null || targetFixed === edge.targetHandle)
          ) {
            return edge
          }
          return {
            ...edge,
            ...(sourceFixed ? { sourceHandle: sourceFixed } : {}),
            ...(targetFixed ? { targetHandle: targetFixed } : {}),
          }
        }),
      )

      if (!shifted) return

      /* Computed twice, deliberately, and cheaply -- once here over the props to work out
         what to *say*, and once inside the updater below to work out what to *store*. The
         alternative is side effects inside a state updater, which React may invoke twice.
         Nothing a pending selection change could alter is read here: an advisory depends
         on where the node landed and where the zones are, and neither is selection. */
      const preview = rehomeDragged(documentNodes, moved, topology)
      for (const advisory of preview.advisories) onAdvise?.(advisory.message, advisory.nodeId)

      setNodes((current) => growZones(rehomeDragged(current, moved, topology).nodes))

      /* A mapping dropped onto its destination is a fact about the drop, not
         something the user should have to draw separately -- see attachTargetFor. */
      for (const item of moved) {
        const live = preview.nodes.find((entry) => entry.id === item.id)
        if (!live || kindOf(live) !== 'destination_mapping') continue

        const attached = attachTargetFor(live, preview.nodes, {
          size: { width: NODE_WIDTH, height: NODE_HEIGHT },
        })
        if (!attached) continue
        if (edges.some((e) => e.source === live.id && e.target === attached.id)) continue

        setEdges((current) =>
          addEdge(
            { source: live.id, target: attached.id, type: 'flow', data: { discovered: false } },
            current,
          ),
        )
      }

      /*
       * Re-route the connectors whose route the router owns.
       *
       * Obstacle avoidance used to run once, when a connector was drawn, and never again -- so every
       * component moved after that left its connectors on a route computed for a layout that no longer
       * existed, and they accumulated crossings through the very cards they were meant to dodge. The
       * bends *look* deliberate, which is why this went unnoticed: nothing distinguished a route the
       * router had computed from one a hand had placed.
       *
       * `data.routed === 'auto'` is that distinction, and it is checked strictly. A hand-adjusted route
       * is a statement about a piece of empty space and is never touched; so is a route stored before
       * the marker existed, which is every route already in the database. The safe direction.
       */
      const touched = new Set(moved.map((item) => item.id))

      setEdges((current) =>
        current.map((edge) => {
          if (edge.data?.routed !== 'auto') return edge
          if (!touched.has(edge.source) && !touched.has(edge.target)) return edge
          const next = avoidanceFor(edge)
          /* An empty result means the direct route is clear now, so the bends are dropped along with
             the marker -- the connector goes back to being one the router derives from its endpoints. */
          return {
            ...edge,
            data: {
              ...edge.data,
              waypoints: next.length ? next : undefined,
              routed: next.length ? 'auto' : undefined,
            },
          }
        }),
      )
    },
    [documentNodes, setNodes, topology, onAdvise, edges, setEdges, avoidanceFor, facingFor],
  )

  /* Deleting a zone deletes its children -- React Flow pulls them into the set
     itself. That is a lot of work to lose to one keystroke, so populated zones and
     their contents are filtered out of the deletion rather than the whole thing
     being refused: a multi-select that happened to include a zone should still
     delete everything else the user picked. */
  const onBeforeDelete = useCallback(
    async ({ nodes: doomedNodes, edges: doomedEdges }) => {
      /* The document's children, not the view's. A zone whose components are all folded
         into a stack looks empty on screen, and counting what is drawn would let one
         keystroke delete the zone while leaving its members in the document parented to
         something that no longer exists. */
      const childrenOf = (zoneId) => documentNodes.filter((node) => node.parentId === zoneId)
      const occupied = doomedNodes.filter(
        (node) => node.type === 'zone' && childrenOf(node.id).length > 0,
      )
      if (!occupied.length) return true

      const spared = new Set()
      for (const zone of occupied) {
        spared.add(zone.id)
        for (const child of childrenOf(zone.id)) spared.add(child.id)
      }

      onNotify?.({
        tone: 'error',
        message: `Move or delete what is inside ${occupied
          .map((zone) => `${zone.data?.label ?? zone.data?.id} (${childrenOf(zone.id).length})`)
          .join(', ')} before deleting the zone.`,
      })

      return {
        nodes: doomedNodes.filter((node) => !spared.has(node.id)),
        /* An edge that is only in the set because React Flow followed a spared node
           is spared too, or the diagram would quietly lose connections it still
           draws. One the user selected outright still goes. */
        edges: doomedEdges.filter(
          (edge) => edge.selected || (!spared.has(edge.source) && !spared.has(edge.target)),
        ),
      }
    },
    [documentNodes, onNotify],
  )

  const onConnect = useCallback(
    (candidate) => {
      /*
       * Pointing the way it was drawn, before anything else looks at it.
       *
       * First, deliberately: the validator, the refusal message, the route-avoidance and the stored
       * edge all have to be about the same connector, and every one of them reads `source` and
       * `target`. See `orientConnection` in canvas/direction.js for why the pair arrives backwards.
       */
      let connection = orientConnection(candidate, connectFrom.current)

      /* A connection can only be *grabbed* from one of a node's fixed side handles now -- see
         ConnectionHandles.jsx -- but the drag may have slid along that node's border before
         leaving it, and wherever it was nearest when it did is what the user means by "start
         here instead". React Flow cannot report that: `sourceHandle` above is always the fixed
         handle the gesture technically began on. So the exact point, if there is one, is taken
         from the registry `ConnectionHandles` wrote it into.
         `sourceHandle` itself still gets the *fixed* id for that side, never the free-anchor
         string -- see `fixedHandleForSide` in canvas/handles.js for why an edge that named the
         free anchor's own ephemeral handle would never draw. The precise point rides in `data`
         instead, read back out by `anchorPoint` in edges/FlowEdge.jsx. */
      /* Both ends, because a connection has two and the reader placed both. The arriving end used to
         be left to `connectionRadius`, which snaps to the nearest of four side midpoints -- so a
         connector dropped a third of the way down a border jumped to the middle of it, and the
         `targetAnchor` field the rest of the app already understood was written by nothing. */
      const anchor = dragAnchorRegistry.take(connection.source)
      const landing = dragAnchorRegistry.take(connection.target)
      const sourceAnchor = anchor ? encodeFreeHandle(anchor.side, anchor.t) : null
      const targetAnchor = landing ? encodeFreeHandle(landing.side, landing.t) : null
      /*
       * An end the reader did not place gets the side that faces the other component.
       *
       * Without this the source end keeps whichever handle the drag happened to start from and the
       * target end keeps whatever `connectionRadius` snapped to -- neither of which knows where the
       * other component is. A connector to something on the left that leaves the *east* side has to
       * exit east, turn, and cross back over the component it just left, which is what reads as the
       * event running backwards. (It never is: the walk only ever follows connectors out of a
       * component. It is the first leg of the line that doubles back.)
       *
       * A hand-placed anchor always wins, because it is a decision.
       */
      const facing = facingFor(connection)
      connection = {
        ...connection,
        sourceHandle: anchor
          ? (fixedHandleForSide(anchor.side) ?? connection.sourceHandle)
          : (facing.source ?? connection.sourceHandle),
        targetHandle: landing
          ? (fixedHandleForSide(landing.side) ?? connection.targetHandle)
          : (facing.target ?? connection.targetHandle),
      }

      /* A stack has handles because the aggregated edges have to land somewhere, but an
         edge *drawn* to one would be stored against an id the document has never
         contained -- and would then be dropped on the next expand. So the group is
         opened instead of the edge being silently refused. */
      if (isGroupStackId(connection.source) || isGroupStackId(connection.target)) {
        onNotify?.({
          tone: 'info',
          message: 'Expand the group first — a connection has to name the component it reaches.',
        })
        return
      }
      if (!isValidConnection(connection)) {
        onNotify?.({
          tone: 'error',
          message: explainRejection({
            topology,
            from: getNode(connection.source),
            to: getNode(connection.target),
            edges,
          }),
        })
        return
      }
      /*
       * Try to keep the new line off the components between its ends.
       *
       * Done once, here, at the moment the connector is created -- not continuously. A route that
       * re-solved itself every time anything moved would take a line the user had deliberately
       * placed and move it, and there would be no way to say "no, leave it there". So this is a
       * better starting point rather than a rule, and the handles are how it gets adjusted after.
       *
       * Best-effort: `avoidingWaypoints` returns `[]` when the default is already clear or when
       * nothing it tried worked, and a line through a card is a legible problem with an obvious fix.
       */
      const waypoints = avoidanceFor(connection)

      setEdges((current) =>
        addEdge(
          {
            ...connection,
            type: 'flow',
            /* Hand-drawn, so deletable -- unlike an edge discovered from the
               customer's real workspace, which is a fact, not a choice. */
            data: {
              discovered: false,
              ...(waypoints.length ? { waypoints, routed: 'auto' } : {}),
              ...(sourceAnchor ? { sourceAnchor } : {}),
              ...(targetAnchor ? { targetAnchor } : {}),
            },
          },
          current,
        ),
      )
    },
    [isValidConnection, setEdges, topology, getNode, edges, onNotify, avoidanceFor, dragAnchorRegistry],
  )

  /*
   * A connection drag released somewhere React Flow did not read as a handle.
   *
   * It used to be thrown away, with no line drawn and nothing said -- which is what made "aim at the
   * card" fail whenever the release was a little way inside it, out of reach of all four side dots.
   * There are two things the reader can have meant, and both are drawn now:
   *
   *   - Over a component: connect to it, at the side nearest the pointer. The same answer an endpoint
   *     drag gets, through the same hit test, so the two gestures cannot disagree about where a drop
   *     landed.
   *   - Over empty canvas: a connector to *nothing yet*, ending where the pointer is -- see
   *     edges/looseEnds.js. Dropped onto a component later, it connects.
   *
   * A release on the component the drag started from is neither, and is left alone: it is a drag that
   * never left the card, not a request for a loop.
   */
  const finishLooseConnection = useCallback(
    (event, state, from) => {
      /* React Flow already connected it (or refused it mid-drag, with the handle shown red). A pin
         does not count: it is a loose end's stand-in, and landing near one is landing on canvas. */
      if (state?.toHandle && !isPinId(state.toNode?.id)) return
      const startId = state?.fromNode?.id ?? from?.nodeId
      if (!startId || isGroupStackId(startId) || isPinId(startId)) return

      const pointer = 'changedTouches' in (event ?? {}) ? event.changedTouches[0] : event
      if (!pointer || !Number.isFinite(pointer.clientX)) return
      const point = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY })

      const drop = endpointDropTarget(point)
      if (drop) {
        if (drop.nodeId === startId) return
        /* Through `onConnect`, so the rules, the refusal message, the facing sides and the route
           avoidance are the ones every other new connector gets. The landing point is handed over the
           same way `ConnectionHandles` hands over a slide along the border. */
        dragAnchorRegistry.set(drop.nodeId, drop.side, drop.t)
        onConnect({
          source: startId,
          target: drop.nodeId,
          sourceHandle: state?.fromHandle?.id ?? null,
          targetHandle: fixedHandleForSide(drop.side),
        })
        return
      }

      const edge = {
        id: `manual-edge:${crypto.randomUUID().slice(0, 8)}`,
        source: startId,
        target: null,
        type: 'flow',
        data: {
          discovered: false,
          targetPoint: { x: Math.round(point.x), y: Math.round(point.y) },
        },
      }
      /* The end it leaves from faces the point it is going to, unless the drag slid along the border
         to a particular place first -- the same precedence `onConnect` gives a hand-placed anchor. */
      const anchor = dragAnchorRegistry.take(startId)
      const facing = facingFor(edge)
      setEdges((current) => [
        ...current,
        {
          ...edge,
          sourceHandle: anchor
            ? fixedHandleForSide(anchor.side)
            : (facing.source ?? state?.fromHandle?.id ?? null),
          data: {
            ...edge.data,
            ...(anchor ? { sourceAnchor: encodeFreeHandle(anchor.side, anchor.t) } : {}),
          },
        },
      ])
    },
    [screenToFlowPosition, endpointDropTarget, dragAnchorRegistry, onConnect, facingFor, setEdges],
  )

  /*
   * Moving one end of an existing connection somewhere else.
   *
   * Without this the only way to change where a connection goes is to delete it and
   * draw a new one, which loses whatever the edge carried -- and on a diagram where an
   * edge may have been discovered from the real workspace, deleting is not a neutral
   * way to edit.
   *
   * `reconnectEdge` keeps the edge object and rewrites its ends, so `data.discovered`
   * and anything else on it survive the move. The same validator the draw path uses
   * decides whether the new pair is allowed, or the two would disagree about the very
   * same connection depending on how it was made.
   */
  const onReconnect = useCallback(
    (oldEdge, connection) => {
      if (isGroupStackId(connection.source) || isGroupStackId(connection.target)) {
        onNotify?.({
          tone: 'info',
          message: 'Expand the group first — a connection has to name the component it reaches.',
        })
        return
      }
      /* The edge being moved is excluded from the duplicate check: dropping an end back
         where it came from is a no-op, and counting the edge against itself would report
         it as already connected. */
      const others = edges.filter((edge) => edge.id !== oldEdge.id)
      if (!makeConnectionValidator({ topology, getNode, edges: others })(connection)) {
        onNotify?.({
          tone: 'error',
          message: explainRejection({
            from: getNode(connection.source),
            to: getNode(connection.target),
            edges: others,
          }),
        })
        return
      }
      /*
       * The moved end forgets where it used to be attached.
       *
       * `reconnectEdge` preserves `data` wholesale, which is right for colour and line style and
       * wrong for an anchor: a `sourceAnchor` of `free:right:0.8` outlives a drag that moved the end
       * to the *top* side, and `anchorPoint` in edges/FlowEdge.jsx honours the anchor over the
       * handle -- so the end sprang back to the old border the instant it was released, which is
       * precisely the "it will not stay where I put it" complaint.
       *
       * Whichever end the gesture just placed is re-anchored from the registry if the drag left a
       * point there, and cleared otherwise so the fixed handle decides.
       */
      const movedSource = connection.source !== oldEdge.source || connection.sourceHandle !== oldEdge.sourceHandle
      const movedTarget = connection.target !== oldEdge.target || connection.targetHandle !== oldEdge.targetHandle
      const placed = {
        ...(movedSource
          ? { sourceAnchor: anchorStringFor(dragAnchorRegistry.take(connection.source)) }
          : {}),
        ...(movedTarget
          ? { targetAnchor: anchorStringFor(dragAnchorRegistry.take(connection.target)) }
          : {}),
      }

      setEdges((current) =>
        reconnectEdge(oldEdge, connection, current).map((edge) =>
          edge.source === connection.source && edge.target === connection.target && edge.id === oldEdge.id
            ? { ...edge, data: { ...edge.data, ...placed } }
            : edge,
        ),
      )
    },
    [edges, topology, getNode, setEdges, onNotify, dragAnchorRegistry],
  )

  /*
   * A plain click means "just this one".
   *
   * React Flow does not do this, and the gap is the second half of the report about selection. Its
   * click handler adds a node to the selection when it is *not* already in one and toggles it out
   * when a modifier is held -- but a plain click on a node that is already selected alongside others
   * matches neither branch, so nothing happens at all. From the user's side: pick four cards, click
   * one to work on it, and the other three are still selected with no ring anywhere to say so. The
   * next align, restyle or delete then lands on all four.
   *
   * Sent as `select` changes through the same seam every other selection change uses, so the
   * document, the toolbar and the history all see it the way they see a click on the pane.
   *
   * Two things it deliberately does not do. It leaves a modified click alone -- shift and cmd are how
   * a selection is *built*, and narrowing there would make multi-select impossible. And it keeps this
   * node's group mates, because a group is selected as one: dropping them would take a group apart
   * with a click, which is the opposite of what grouping is for.
   */
  const narrowSelection = useCallback(
    (event, node) => {
      if (event?.shiftKey || event?.metaKey || event?.ctrlKey) return
      const keep = new Set(withGroupMates(documentNodes, [node.id]))
      const drop = documentNodes
        .filter((entry) => entry.selected && !keep.has(entry.id))
        .map((entry) => ({ id: entry.id, type: 'select', selected: false }))
      if (drop.length) onNodesChange(drop)
    },
    [documentNodes, onNodesChange],
  )

  /* --- the command menu ---------------------------------------------------- */

  /*
   * The canvas reports *where* the click was and *what* it was on; it does not decide
   * what may be done there. Building the menu here, where the nodes are, would mean the
   * keyboard and the menu each answering "is this possible?" for themselves -- which is
   * the one thing commands/registry.js exists to prevent.
   */
  /* Right-clicking the line. Reported as `edge` rather than as `node`, so the registry can offer a
     different menu entirely -- see EDGE_MENU. The whole edge object goes up, not just its id,
     because the enablement rules read `deletable` and `data.waypoints` off it. */
  const openEdgeMenu = useCallback(
    (event, edge) => {
      if (!onContextMenu) return
      event.preventDefault()
      onContextMenu({
        menu: EDGE_MENU,
        x: event.clientX,
        y: event.clientY,
        node: null,
        stack: null,
        edge,
        subject: null,
      })
    },
    [onContextMenu],
  )

  const openMenu = useCallback(
    (event, node) => {
      if (!onContextMenu) return
      event.preventDefault()
      /* A stack is reported as a stack, never as a node. Its id exists only in this
         view, so anything resolving it against the document -- the inspector, the
         clipboard -- would find nothing, which is why right-click used to skip stacks
         outright. Reported this way, the menu can offer to open the group instead. */
      const stack = node && isGroupStackId(node.id) ? node : null
      onContextMenu({
        menu: node ? NODE_MENU : PANE_MENU,
        x: event.clientX,
        y: event.clientY,
        node: stack ? null : (node ?? null),
        stack,
        /* Which cell of a table was clicked, when it was a table. Facts rather than the model --
           the row, the column and how many of each there are -- because the command table's
           `enabled` is given answers, not a graph to go looking through. */
        cell: cellFromEvent(event, node),
        subject: node ? (node.data?.name ?? node.data?.label ?? null) : null,
      })
    },
    [onContextMenu],
  )

  /* --- palette drops ------------------------------------------------------- */

  const onDragOver = useCallback((event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      const raw = event.dataTransfer.getData(DRAG_MIME)
      if (!raw) return

      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      const kind = payload.kind

      /*
       * A workspace component dropped onto a card already on the canvas binds that card rather than
       * adding a second one beside it. Only onto the same kind -- binding across kinds would move the
       * card to another pipeline zone and break the connectors already on it, which is the one thing
       * the Bind tab refuses too.
       */
      if (payload.bound && payload.data?.segmentId) {
        const hit = event.target?.closest?.('.react-flow__node')?.getAttribute('data-id')
        const target = hit ? nodes.find((node) => node.id === hit && node.type !== 'zone') : null
        if (target && !isGroupStackId(target.id)) {
          const name = target.data?.templateName ?? target.data?.name ?? 'This component'
          if (target.data?.kind !== kind) {
            onNotify?.({
              tone: 'error',
              message: `“${name}” is a ${target.data?.kind ?? 'different kind'}, and ${payload.data.name} is a ${kind}. Drop it on a ${kind}, or on empty canvas to add it.`,
            })
            return
          }
          if (boundSegmentIds(nodes, target.id).has(payload.data.segmentId)) {
            onNotify?.({
              tone: 'error',
              message: `${payload.data.name} is already bound to another component on this canvas.`,
            })
            return
          }
          const next = replacementPatch(target.data, applyBinding(target.data, payload.data))
          onUpdateData?.(target.id, next)
          onNotify?.({ tone: 'success', message: `Bound “${name}” to ${payload.data.name}.` })
          onInspect?.(target)
          return
        }
      }

      const dropped = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const zone = zoneAtPosition(nodes, dropped)

      /* Zones are handled first and separately. Where one may go is a question
         about the zone tree, not about `KINDS_BY_ZONE` -- so `isValidPlacement`,
         which answers for components, has nothing to say about it. */
      if (kind === 'zone') {
        const node = dropZone(payload, dropped, { nodes, zone, topology, onNotify, onAdvise })
        if (!node) return
        setNodes((current) => growZones([...current, node]))
        onInspect?.(node)
        return
      }

      /*
       * Centre the node on the cursor. Dropping by top-left corner feels like a half-node offset
       * error.
       *
       * By the node's *own* box, not by the default card. A shape carries its size in the payload
       * (a swimlane arrives 384px wide) and a table's is the sum of its columns, so centring
       * everything on a 200x60 card put the wide ones visibly off the cursor.
       */
      const box = droppedBox(payload)
      const position = { x: dropped.x - box.width / 2, y: dropped.y - box.height / 2 }

      /* Generated before the advisory below rather than inline in `toFlowNode`, because
         the note points at the component it is about and cannot name a node that does
         not exist yet. */
      const newId = `manual:${kind}:${crypto.randomUUID().slice(0, 8)}`

      /* No zone is a legitimate answer now. The canvas outside the zones is a working
         area -- somewhere to park a component while working out where it goes, or to
         hold one that belongs to two products at once -- so a drop there is a drop, not
         a refusal. It used to say "Drop components inside a zone." */
      if (zone && !isValidPlacement(topology, kind, zone.data)) {
        onAdvise?.(explainMisplacement({ topology, kind, attemptedZone: zone.data }), newId)
      }

      const zoneId = zone ? zone.data.id : null
      const node = toFlowNode(
        {
          /* Prefixed so a manually added node can never collide with a Segment
             id, and so it is obvious later which nodes came from the API. */
          id: newId,
          kind,
          zone: zoneId,
          name: payload.name ?? topology?.kinds?.[kind]?.label ?? kind,
          description: payload.description ?? '',
          /* Catalog drops carry a slug and docs link but no workspace instance
             behind them yet, so they start unbound. */
          bound: payload.bound ?? false,
          /*
           * The look every component starts with, stated rather than inherited.
           *
           * Without it a dropped component resolved through `styleFor` -> `KIND_STYLES` -> `DEFAULT`,
           * which meant two surprises. `outlineFor` forces dashed 2px on anything unbound, and a
           * catalog drop is unbound by definition -- so a freshly dragged component came out dashed
           * and heavier than the same component after binding. And `KIND_STYLES` overrides the shape
           * per kind, so a warehouse arrived square and a source function notched.
           *
           * An explicit override beats both, which is the point: a reader who drags four things onto a
           * canvas gets four things that look like each other. It costs the dashed border as a signal
           * for "not bound yet" -- that now rests entirely on the Unbound badge, which is why its
           * default is on rather than off.
           *
           * Before `payload.data` deliberately, so a palette tile that knows better still wins.
           */
          ...(DRAWING_KINDS.has(kind) ? {} : { style: DROPPED_STYLE }),
          /* A function drawn by hand starts with the out-of-the-box body for its type, so
             it does something the moment it is on the canvas. A function dragged out of
             the *workspace* tab deliberately does not: its real body is not something the
             Public API returns, and seeding a template would make the walkthrough report
             a guess as fact. See `codeSeed`. */
          ...codeSeed(kind, { bound: payload.bound ?? false }),
          ...payload.data,
        },
        zoneId,
        zone ? toZoneLocal(zone, position, nodes) : position,
      )

      setNodes((current) => [...current, node])
      onInspect?.(node)
    },
    [screenToFlowPosition, nodes, topology, setNodes, onInspect, onNotify, onAdvise, onUpdateData],
  )

  /*
   * Every connector's paint layer, stated rather than derived -- see `edgeZFor` in canvas/layout.js.
   *
   * Here rather than in `toFlowEdge` because an edge made by a live drag never goes through
   * `toFlowEdge`; `addEdge` builds it in `onConnect`. This is the one place every edge passes
   * through on its way to React Flow, whatever created it.
   */
  const layeredEdges = useMemo(
    () =>
      /* Loose ends pointed at their pins here, at the last moment, so nothing upstream -- the store,
         the inspector, the serializer -- ever sees an id that is not a component. */
      pinnedEdges(edges).map((edge) =>
        edge.zIndex === edgeZFor(edge) ? edge : { ...edge, zIndex: edgeZFor(edge) },
      ),
    [edges],
  )

  return (
    <AnchorContext.Provider value={anchors}>
      <FlashContext.Provider value={flash}>
      <ChromeContext.Provider value={chrome}>
      <GroupCollapseContext.Provider value={groupCollapse}>
        <div className="h-full w-full">
          <ReactFlow
            nodes={flowNodes}
            edges={layeredEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            /* Where the drag began, which is what decides which way the new connector points -- see
               `connectFrom` above. Cleared on release so a later reconnect drag, which goes through its
               own handlers, cannot be judged against a stale origin. */
            onConnectStart={(_event, params) => {
              connectFrom.current = params
              /* Whatever a previous gesture from this same node left behind, cleared before this
                 one can write anything of its own -- so a drag that ends without ever reaching
                 `onConnectEnd` (the pointer released somewhere React Flow does not read as a
                 drag end) cannot leave an anchor for *this* gesture to inherit. */
              dragAnchorRegistry.clear()
            }}
            onConnectEnd={(event, state) => {
              const from = connectFrom.current
              connectFrom.current = null
              finishLooseConnection(event, state, from)
              /* A no-op if `onConnect` already consumed it; a stale one otherwise, from a drag
                 that ended without connecting -- which must not attach itself to a later,
                 unrelated connection drawn from the same node. */
              dragAnchorRegistry.clear()
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            /*
             * Off, and this is the fix for "I cannot move the ends of a connector".
             *
             * React Flow's reconnect anchors are two `<circle fill="transparent">`s drawn at the
             * edge's reported endpoint and shifted `reconnectRadius` *outward* from the node. Both
             * halves of that are wrong here. They are invisible, so nothing advertises that an end
             * can be grabbed at all -- and on this canvas the reported endpoint is frequently not
             * where the line is: an end carrying a `data.sourceAnchor` or a share of a fanned-out
             * side is drawn at a point `FlowEdge` computes, while the anchor stays at the handle's
             * midpoint. So the reader aims at the visible end of the line and grabs nothing.
             *
             * `FlowEdge` draws its own grips instead, at the points it actually strokes between,
             * and releases into `onEndpointMove`. `onReconnect` stays wired above: it costs
             * nothing and this could be switched back on.
             */
            edgesReconnectable={false}
            /*
             * How close to a handle a connection has to be *released* to land on it. The
             * library's default is 20, which is a ring barely wider than the dot itself --
             * so dropping a connector on a card meant hitting one of four 8px targets, and
             * missing meant the drag was thrown away with no line drawn and nothing said.
             *
             * 45 makes the catch area reach well outside the component, which is the point:
             * aim at the card, get the nearest side. It cannot over-reach onto a neighbour,
             * because `ConnectionMode.Loose` still resolves to the *nearest* handle within
             * the radius, and cards on this canvas sit further apart than this.
             */
            connectionRadius={45}
            /*
             * How far the pointer must travel before a press becomes a drag.
             *
             * Zero -- the library's effective default -- means every click is also a
             * one-pixel drag, and this canvas does real work on `onNodeDragStop`: it
             * re-homes the dragged node, re-parents it into whichever zone it landed in and
             * grows the zones to fit. All of that ran on every click, which is what made
             * clicking a card sometimes clear the selection and mark the diagram dirty
             * without moving anything. Three pixels is below the threshold of a deliberate
             * drag and above the jitter of a click.
             */
            nodeDragThreshold={3}
            /*
             * Every layer is stated, not derived -- see the z scheme in canvas/layout.js.
             *
             * The default (`basic`) computes an edge's z as `edge.zIndex + max(z of each endpoint
             * that has a parent)`, which meant the same edge landed on a different layer depending
             * on whether its endpoints happened to live inside a zone: 10 inside one, 0 outside --
             * and 0 is where the zone backdrops are, so those edges were painted over and vanished.
             * No per-edge z could fix that, because the term being added is not ours.
             *
             * Inert for nodes, which is what makes this affordable: `calculateChildXYZ` applies its
             * `parentZ + 1` nesting bump whatever the mode, so a sub-zone still resolves above its
             * parent. Only *selection* elevation is gated on the mode -- and `elevateNodesOnSelect`
             * was already off, while the edge lift it also disables is now applied by `edgeZFor`.
             */
            zIndexMode="manual"
            /*
             * Every side of a node is both an exit and an entrance -- see canvas/handles.js.
             *
             * Each side is two stacked handles, one source and one target, and under the
             * default Strict mode a drop lands on whichever of the pair was painted last:
             * connecting to a side would work or be refused depending on nothing the user can
             * see. Loose lets either half accept it, which is what makes the *side* the thing
             * being connected to. The rules that decide whether a connection is allowed are
             * unaffected -- they are in rules.js and run through `isValidConnection`.
             */
            connectionMode={ConnectionMode.Loose}
            /*
             * `008` is "couldn't create edge for handle id X", and it is never survivable.
             *
             * This used to swallow it whenever the message mentioned a `free:` anchor, on the stated
             * grounds that "the edge is fine: `FlowEdge` resolves the point from the node's own box".
             * That was wrong about the library's control flow, and expensively so. When `008` fires,
             * `getEdgePosition` has already returned null and React Flow's own `EdgeWrapper` has
             * already returned null -- `FlowEdge` is never mounted and resolves nothing. The edge is
             * not drawn at all, on this render or any other. So the filter was not quietening a
             * cosmetic warning; it was hiding the diagnostic for a permanently invisible connector,
             * which is the single hardest thing to debug in this app.
             *
             * Nothing should reach a handle field with a free id now -- `fixedHandleForSide` puts the
             * fixed id there and the precise point rides in `data.sourceAnchor`/`data.targetAnchor`
             * (see canvas/handles.js) -- so an `008` mentioning one is a real regression and has to be
             * loud. It is called out by name to say so, rather than passed through anonymously.
             */
            onError={(code, message) => {
              if (code === '008' && /free:/.test(message)) {
                console.error(
                  `[React Flow] ${message} — a connector is naming a free border anchor as its handle, ` +
                    'so it will not be drawn at all. The anchor belongs in the edge’s data, not in ' +
                    'sourceHandle/targetHandle; see canvas/handles.js.',
                )
                return
              }
              console.warn(`[React Flow] ${message}`)
            }}
            onNodeDragStop={onNodeDragStop}
            onBeforeDelete={onBeforeDelete}
            isValidConnection={isValidConnection}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            /* Off, against the library's default. On, selecting anything sets its z to 1000
               -- and a zone's wrapper div is a full-size hit target, so a selected zone
               covered every component on the canvas and swallowed their clicks until
               something else was selected. Nothing here needs the lift: a component already
               sits above every zone by `COMPONENT_Z`, and which of two zones is in front is
               the arrangement rule in `orderForFlow`, which a 1000 would override. */
            elevateNodesOnSelect={false}
            /*
             * Shift-drag catches anything the box *touches*, not only what it fully
             * encloses.
             *
             * React Flow's default is `SelectionMode.Full`, which is why a shift-drag
             * across the canvas looked intermittent: it was working exactly as specified and
             * silently skipping every node whose far edge was a few pixels outside the box.
             * On a diagram of 200px cards inside zones that are wider than the screen, Full
             * means a lasso can never catch a zone at all and catches a card only if the
             * drag starts and ends clear of it -- so the same gesture selected three of the
             * five things it was drawn around, with nothing to indicate why.
             */
            selectionMode={SelectionMode.Partial}
            /*
             * Shift adds to the selection on click, as well as drawing the box.
             *
             * React Flow binds these to two different keys by default: `selectionKeyCode` is
             * Shift (the lasso) and `multiSelectionKeyCode` is Meta or Control (additive click).
             * So shift-clicking a second component replaced the selection instead of extending
             * it -- the modifier was held, and it was the modifier for the *other* gesture.
             *
             * Both now, rather than moving Shift across: an array means "any of these", so
             * cmd-click keeps working for anyone who learned it from the library's default, and
             * Shift means "and this one too" for both gestures. The two cannot collide -- the
             * lasso starts on the pane and additive click lands on a node.
             */
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeContextMenu={openMenu}
            onEdgeContextMenu={openEdgeMenu}
            /* The connection dots, revealed by proximity -- see `onNodeMouseMove` above. The
               leave handler is not redundant: the pointer can exit a node across its border,
               where the move handler's last word was "near", and without this the dots would
               stay up on a card the pointer has finished with. */
            onNodeMouseMove={onNodeMouseMove}
            onNodeMouseLeave={(_event, node) => reveal.clear(node.id)}
            /* Double-click the line to adjust its route; double-click again to put the handles away.
               A toggle rather than a one-way door, because the handles sit on top of the line and
               there has to be a way to see it plainly again without hunting for empty canvas. */
            onEdgeDoubleClick={(_event, edge) =>
              setAdjustingEdgeId((current) => (current === edge.id ? null : edge.id))
            }
            /* React Flow routes a right-click that lands inside a multi-selection here
               rather than to onNodeContextMenu. Without it, right-clicking forty selected
               components would open the pane menu and none of them would be the subject. */
            onSelectionContextMenu={(event, selected) => openMenu(event, selected?.[0] ?? null)}
            onPaneContextMenu={(event) => openMenu(event, null)}
            onNodeClick={(event, node) => {
              if (isGroupStackId(node.id)) return
              onInspect?.(node)
              if (node.type !== 'zone') setModelId(node.id)
              narrowSelection(event, node)
            }}
            /* Mirrors onNodeClick: a connector is as inspectable as a component now that
               it has its own styling to set, and this is the only other thing on the
               canvas `onInspect` needs to reach. */
            onEdgeClick={(_, edge) => onInspect?.(edge)}
            onPaneClick={() => {
              onInspect?.(null)
              /* A click on bare canvas is how you finish editing a route. Without this the handles
                 stay up over a line nobody is working on any more, and the only way out is to find
                 that line again and double-click it. */
              setAdjustingEdgeId(null)
              /* A click on bare canvas is the way out of a pinned note, and the same
                 gesture that dismisses the inspector. Without it the only way to release
                 a pin is to find the note again, which for a note the user has since
                 panned away from is worse than the problem pinning solved. */
              focus.clearPin()
            }}
            /* Culling offscreen nodes is what keeps a 300-node customer architecture
               interactive -- but it is also why it has to be switched off for an
               export: a node that is not in the DOM cannot be captured, so a PNG taken
               while culling was on would silently omit everything scrolled out of
               frame. */
            onlyRenderVisibleElements={!exporting}
            /*
             * Trackpad navigation, matching Lucidchart: a two-finger scroll pans in
             * whichever direction it moves, and a pinch zooms. Both read the same wheel
             * event, and the browser is what tells them apart -- a trackpad pinch is
             * reported with `ctrlKey: true` (the same signal a Ctrl-scroll on a mouse
             * sends, which is why that combination still zooms too). `panOnScrollMode="free"`
             * is what allows the pan to move diagonally with the gesture instead of
             * snapping to one axis. Click-drag panning (`panOnDrag`, on by default) is left
             * alone, so mouse users keep their existing way to navigate.
             */
            panOnScroll
            panOnScrollMode="free"
            zoomOnScroll={false}
            zoomOnPinch
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d7dbe4" />

            {/* The travelling event. Inside the flow so it is in flow coordinates, and not while
                exporting -- a still of a diagram should not have a dot frozen halfway along a line,
                which reads as part of the drawing rather than as a moment in a playthrough. */}
            {!exporting && (
              <EventLayer
                plans={eventPlans}
                clock={eventClock}
                active={walkthroughActive && Boolean(eventPlans?.length)}
              />
            )}

            <Panel position="top-left" className="flex flex-col items-start gap-1.5">
              <GroupControl
                groups={groups}
                collapsed={collapsed}
                onChange={(next) => onCollapsedChange?.(next)}
              />
              {/* Only once there is a workspace to be bound to. With none, every component
                  on the canvas is unbound and the control would toggle a badge that is
                  either on all of them or on none -- which is not a distinction worth a
                  button, and is why the badges are hidden outright until then. */}
              {connected && (
                <button
                  type="button"
                  onClick={() => setShowFlags((current) => !current)}
                  aria-pressed={showFlags}
                  title="Mark the components that are still placeholders rather than something read from your workspace."
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs shadow-sm transition-colors ${
                    showFlags
                      ? 'border-twilio-blue bg-twilio-blue text-white'
                      : 'border-twilio-gray-20 bg-white text-twilio-gray-60 hover:text-twilio-navy'
                  }`}
                >
                  <Tag size={13} aria-hidden="true" />
                  {showFlags ? 'Hide flags' : 'Show flags'}
                </button>
              )}
              {/* Not gated on `connected` -- unlike the flags toggle, tidying the layout has
                  nothing to do with whether a workspace is bound. */}
              <button
                type="button"
                onClick={() => onAutoAlign?.()}
                title="Nudge components and zones that are already almost aligned the rest of the way."
                className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 bg-white px-2.5 py-1.5 text-xs text-twilio-gray-60 shadow-sm transition-colors hover:text-twilio-navy"
              >
                <Sparkles size={13} aria-hidden="true" />
                Auto-Align
              </button>
            </Panel>
            {/* Centred, and above rather than beside the diagram: the actions are about the
                selection, so anchoring the bar to the selection's own bounding box would
                put it under the cursor mid-drag and move it every time the selection
                changed. */}
            <Panel position="top-center">
              {/*
                One bar at a time, and text wins. The two are about different things -- a caret in
                a label, or several components picked out -- and they cannot both be what the user
                is doing: clicking into a label is what deselects everything else. Text takes
                precedence because it is the narrower and more recent statement of intent, and
                because losing the formatting bar the moment a second component happens to still
                be selected would read as it never having appeared.
              */}
              {editingLabel ? (
                <TextToolbar />
              ) : (
                <SelectionToolbar
                  count={selection.ids.length}
                  modelName={selection.model?.data?.name}
                  grouped={selection.grouped}
                  onAlign={onAlign}
                  onMatchSize={onMatchSize}
                  onMatchStyle={onMatchStyle}
                  onGroup={onGroup}
                  onUngroup={onUngroup}
                />
              )}
            </Panel>
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={2}
              /* Colour the minimap by kind so the three products stay
                 distinguishable when zoomed out past readable labels. */
              nodeColor={(node) =>
                node.type === 'zone' ? '#ffffff00' : styleFor(node.data?.kind).border
              }
              className="!bottom-3 !right-3"
            />
          </ReactFlow>
        </div>
      </GroupCollapseContext.Provider>
      </ChromeContext.Provider>
      </FlashContext.Provider>
    </AnchorContext.Provider>
  )
}

/**
 * Which cell of a table a right-click landed on, or null.
 *
 * Read off the DOM (`data-cell`, written by TableNode) rather than computed from the pointer
 * against the column widths: the browser has already done that hit test, and doing it again here
 * would be the same answer derived a second way, free to disagree the first time either changes.
 */
function cellFromEvent(event, node) {
  const table = node?.data?.table
  if (!table) return null
  const found = event.target?.closest?.('[data-cell]')?.dataset?.cell
  if (!found) return null
  const [row, column] = found.split(':').map(Number)
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null
  return { row, column, rows: rowCount(table), columns: columnCount(table) }
}

/**
 * How big the thing being dropped is, for centring it on the cursor.
 *
 * Three cases, in the order they can be known: a table's box is the sum of its own columns, a shape
 * brings an explicit size, and everything else is a card.
 */
function droppedBox(payload) {
  if (payload?.data?.table) return tableSize(payload.data.table)
  return {
    width: payload?.data?.size?.width ?? NODE_WIDTH,
    height: payload?.data?.size?.height ?? NODE_HEIGHT,
  }
}

/**
 * Every dragged node moved to where it was dropped, and re-parented into whatever zone it
 * landed in. Returns the new array and the placements worth remarking on.
 *
 * Pure, and separate from `onNodeDragStop`, for one reason: the callback needs this answer
 * twice -- once against the props to decide what to say, once inside a state updater to
 * decide what to store -- and a function is the only way to have the two agree. Inlined, the
 * second pass would have been "the first pass's array, hopefully still current", which is
 * exactly the staleness that made a click clear the selection.
 *
 * `moved` is React Flow's own report of where each drag ended, which is the authority: the
 * props can still be a frame behind the last pointer event.
 */
function rehomeDragged(nodes, moved, topology) {
  const byId = new Map(moved.map((item) => [item.id, item]))
  let next = (nodes ?? []).map((entry) => {
    const item = byId.get(entry.id)
    return item ? { ...entry, position: item.position } : entry
  })

  const advisories = []
  for (const item of moved) {
    const live = next.find((entry) => entry.id === item.id)
    /* A stack's id is not in the document -- it stands for several nodes that are.
       Dragging one moves its members (translateGroupDrag), but which zone a group of
       forty belongs to is not a question one drop can answer, so it keeps its parent. */
    if (!live) continue

    const target = reparentTarget(live, next, {
      size: { width: NODE_WIDTH, height: NODE_HEIGHT },
    })
    if (!target) continue

    const kind = kindOf(live)
    if (kind && target.zone && !isValidPlacement(topology, kind, target.zone.data)) {
      advisories.push({
        nodeId: live.id,
        message: explainMisplacement({ topology, kind, attemptedZone: target.zone.data }),
      })
    }

    next = next.map((entry) =>
      entry.id === live.id ? withParent(entry, target.zone, target.position) : entry,
    )
  }

  return { nodes: next, advisories }
}

/**
 * A node re-homed into `zone`, or out of every zone when it is null.
 *
 * Writes both halves of the same fact. React Flow reads `parentId`; the document
 * stores `zone` for a component and `parent` for a zone -- and `serializeZone` falls
 * back to the declared parent when the node has no live one, so a zone pulled out of
 * Segment with only its `parentId` cleared would quietly nest itself again on the next
 * open.
 */
function withParent(node, zone, position) {
  const zoneId = zone ? (zone.data?.id ?? zoneOfParent(zone.id)) : null
  const { parentId, ...rest } = node
  const data = node.data ?? {}
  return {
    ...rest,
    ...(zoneId ? { parentId: zoneNodeId(zoneId) } : {}),
    position,
    data: node.type === 'zone' ? { ...data, parent: zoneId } : { ...data, zone: zoneId },
  }
}

/**
 * A zone dropped from the palette. Returns the node, or null having already said
 * why not.
 *
 * Zones nest; components do not. That asymmetry is the whole design: a zone can be a
 * child of a zone at any depth, but a component still stores exactly one `zone`,
 * always the innermost, because a single answer to "which zone is this in?" is all the
 * stored field can hold.
 *
 * The topology's tree is now advice rather than the rule it was: a zone lands wherever the cursor
 * was. Nothing is refused outright any more -- a duplicate used to be, because two zones sharing an
 * id collide on save, and that is solved below by giving the copy an id of its own rather than by
 * turning the drop away.
 *
 * @param zone  the zone already under the cursor, if any
 */
function dropZone(payload, dropped, { nodes, zone, topology, onNotify, onAdvise }) {
  const descriptor = payload.zone ?? {}
  /* A product zone arrives with its id (it is being re-added after a delete); a
     custom one is minted here, colon-separated to match the `manual:` component
     ids and to stay clear of any slug Segment could hand out. */
  const asked = descriptor.id ?? `custom:zone:${crypto.randomUUID().slice(0, 8)}`

  /*
   * The same zone, a second time.
   *
   * This used to be refused: two zones with one id collide on save, because the document keys
   * `zones` by id and a component stores a single `zone` string. That refusal is what made it
   * impossible to lay two diagrams out side by side on one canvas -- the request this answers -- so
   * the copy gets an id of its own and remembers which product it is a copy of. Everything that
   * asks what a zone *is* goes through `zoneProduct` (canvas/rules.js), so the copy keeps
   * Connections' colour, Connections' placement rules and Connections' name.
   */
  const id = nodes.some((node) => node.id === zoneNodeId(asked))
    ? nextZoneInstance(
        asked,
        nodes.filter((node) => node.type === 'zone').map((node) => node.data?.id),
      )
    : asked
  const copy = id !== asked

  if (copy) {
    onNotify?.({
      tone: 'info',
      message: `Added a second ${descriptor.label ?? asked}. Components in it are tagged “${instanceLabel(
        descriptor.label ?? asked,
        id,
      )}”.`,
    })
  }

  /* Where the topology says this zone usually sits. Advice, not a rule: zones can be
     moved freely once they are down, so refusing a drop that a single drag could then
     produce anyway would only be theatre. What the drop actually honours is where the
     cursor was. */
  const conventional =
    (topology?.zones ?? []).find((entry) => entry.id === id)?.parent ?? descriptor.parent ?? null
  const parent = zone ? (zone.data?.id ?? null) : null

  if (conventional && parent !== conventional) {
    onAdvise?.(
      parent
        ? `${descriptor.label ?? id} normally sits inside ${zoneLabel(topology, conventional)}, not ${
            zone.data?.label ?? 'this zone'
          }.`
        : `${descriptor.label ?? id} normally sits inside ${zoneLabel(topology, conventional)}.`,
    )
  }

  const { width, height } = droppedZoneSize(id, descriptor)
  const topLeft = {
    x: Math.round(dropped.x - width / 2),
    y: Math.round(dropped.y - height / 2),
  }

  return toZoneNode(
    {
      order: nodes.filter((node) => node.type === 'zone').length,
      ...descriptor,
      id,
      parent,
      /* Numbered on its face, so two Connections backdrops on one canvas can be told apart at the
         zoom someone screen-shares at. */
      ...(copy ? { label: instanceLabel(descriptor.label ?? asked, id) } : {}),
    },
    {
      position: zone ? toZoneLocal(zone, topLeft, nodes) : topLeft,
      width,
      height,
      parentZoneId: parent,
    },
  )
}

/**
 * Every component's box in flow coordinates, for the obstacle test a new connector runs.
 *
 * Zones are excluded, and that is not an optimisation: a zone is the region the diagram is drawn
 * *in*, so a line asked to route around Connections rather than through it would have nowhere left
 * to go. Collapsed group stacks are excluded by default for the opposite reason -- their id is not
 * in the document, so a route stored against one would be dropped on the next expand.
 *
 * `stacks: true` includes them, for the one caller that needs to *find* a stack rather than avoid
 * one: an endpoint drop released over a collapsed group has to be recognised and refused by name,
 * and a hit test that skipped stacks would instead attach the connector to a hidden member. See
 * `endpointDropTarget`.
 *
 * Positions are absolute. A component inside a zone stores its position relative to that zone, and
 * an obstacle test against parent-relative coordinates would place every card in Unify a few
 * hundred pixels from where it is drawn.
 */
function componentBoxes(nodes, { stacks = false } = {}) {
  const positions = absolutePositions(nodes ?? [])
  const boxes = []
  for (const node of nodes ?? []) {
    if (node.type === 'zone') continue
    if (isGroupStackId(node.id) && !stacks) continue
    const at = positions.get(node.id)
    if (!at) continue
    const chosen = componentSize(node)
    boxes.push({
      id: node.id,
      x: at.x,
      y: at.y,
      width: chosen.width ?? node.measured?.width ?? NODE_WIDTH,
      height: chosen.height ?? node.measured?.height ?? NODE_HEIGHT,
    })
  }
  return boxes
}

/**
 * A zone node's box in flow coordinates, or null when there is no zone.
 *
 * `componentBoxes` deliberately excludes zones -- a connector routing *around* Connections
 * would have nowhere to go -- but a zone is a legal endpoint (one zone can be drawn feeding
 * another), so an endpoint drop still has to be able to find one. Its size comes from
 * `zoneSize` rather than from `measured`, because React Flow does not measure group nodes.
 */
function boxOfZone(zone, nodes) {
  if (!zone) return null
  const at = absolutePositions(nodes ?? []).get(zone.id)
  const { width, height } = zoneSize(zone)
  if (!at || !width || !height) return null
  return { id: zone.id, x: at.x, y: at.y, width, height }
}

/**
 * Where a proposed connection would start and end, read off React Flow's measured handles.
 *
 * Returns null when either node has not been measured yet -- which happens for the frame after a
 * palette drop. Routing against an unmeasured node would put the endpoint at the node's origin and
 * produce a detour around nothing, so no route is better than a guess.
 */
function fromToGeometry(from, to, connection) {
  const source = handlePoint(from, connection.sourceHandle, 'source')
  const target = handlePoint(to, connection.targetHandle, 'target')
  if (!source || !target) return null
  return {
    source: { x: source.x, y: source.y },
    target: { x: target.x, y: target.y },
    sourcePosition: source.position,
    targetPosition: target.position,
  }
}

/* One handle's absolute centre and which side it is on. Falls back across both handle lists
   because `ConnectionMode.Loose` means either type may be the one that matched -- see
   canvas/handles.js. */
function handlePoint(node, handleId, type) {
  const bounds = node?.internals?.handleBounds
  if (!bounds || !node.internals.positionAbsolute) return null
  const candidates = [...(bounds[type] ?? []), ...(bounds[type === 'source' ? 'target' : 'source'] ?? [])]
  const handle = handleId ? candidates.find((entry) => entry.id === handleId) : candidates[0]
  if (!handle) return null
  return {
    x: node.internals.positionAbsolute.x + handle.x + handle.width / 2,
    y: node.internals.positionAbsolute.y + handle.y + handle.height / 2,
    position: handle.position ?? SIDES[0].position,
  }
}
