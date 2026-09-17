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
 *     topology finds unusual (it used to refuse one), and to take a zone's contents with
 *     it when the zone is resized.
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
import { orientConnection } from './direction.js'
import { FlashContext } from './flash.js'
import { codeSeed } from '../functions/defaults.js'
import { EDGE_MENU, NODE_MENU, PANE_MENU } from '../commands/registry.js'
import { isGroupStackId, translateGroupDrag } from './grouping.js'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  componentSize,
  droppedZoneSize,
  edgeZFor,
  growZones,
  orderForFlow,
  scaleZoneChildren,
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
import { instanceLabel, nextZoneInstance, shiftSections } from './frames.js'
import { columnCount, rowCount, scaleTable, tableSize } from './tables.js'
import {
  SIDES,
  alongBorder,
  anchorStringFor,
  encodeFreeHandle,
  fixedHandleForSide,
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
   * Defaults to *off* rather than to `connected`, so the badges are opt-in even once there
   * is a workspace: an architecture being drawn from scratch against a real workspace is
   * mostly placeholders for a while, and forty badges is the same wall of orange whether or
   * not a token is present. What `connected` gates is whether the control appears at all --
   * with no workspace the distinction the badge draws does not exist yet.
   */
  const [showFlags, setShowFlags] = useState(false)

  /* The one place React Flow is handed the list, so the one place its ordering rule has
     to be satisfied -- see orderForFlow. Everything else here reads the props, because
     order is React Flow's constraint and not a fact about the document. */
  const flowNodes = useMemo(() => {
    const ordered = orderForFlow(nodes)
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
  }, [nodes])

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
            ? { ...edge, data: { ...edge.data, waypoints: waypoints?.length ? waypoints : undefined } }
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

  const chrome = useMemo(
    () => ({
      showFlags,
      connected,
      rename: onRename ?? null,
      setRadius: onSetRadius ?? null,
      updateData: onUpdateData ?? null,
      onWaypoints,
      adjustingEdgeId,
      walkthroughActive,
      flowPreview,
      routes,
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
      adjustingEdgeId,
      walkthroughActive,
      flowPreview,
      routes,
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
      return (
        !isGroupStackId(connection.source) &&
        !isGroupStackId(connection.target) &&
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
       * A zone being resized takes its contents with it.
       *
       * Skipped when the same frame also moves the zone -- that is a top or left handle,
       * and the resizer already shifts the children the opposite way to hold them still.
       * Scaling on top of that would apply two transforms to one drag.
       *
       * Done inside one `setNodes` rather than after `onNodesChange`, because the
       * scaling factor is the ratio of the new size to the old one and the old one is
       * only readable before the change lands. Two queued updates would read it after.
       */
      const moved = new Set(
        changes.filter((change) => change.type === 'position').map((change) => change.id),
      )
      const resizes = changes.filter(
        (change) =>
          change.type === 'dimensions' &&
          change.dimensions &&
          !moved.has(change.id) &&
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
          for (const change of resizes) {
            const before = current.find((node) => node.id === change.id)
            const from = zoneSize(before)
            /*
             * A divider's contents move; a zone's contents scale.
             *
             * The difference is what each one *is*. A zone is a box drawn around a group of
             * components, so stretching it should spread them out -- that is `scaleZoneChildren`.
             * A divider is a division of the canvas into sections, and its sections hold whole
             * diagrams: scaling those would rearrange every component inside them. What moves
             * instead is each section, by however far its own origin moved, taking its contents
             * with it. See `shiftSections` in canvas/frames.js.
             */
            if (before?.data?.frame) {
              next = shiftSections(
                next,
                change.id,
                { frame: before.data.frame, ...from },
                { frame: before.data.frame, ...change.dimensions },
              )
            } else {
              next = scaleZoneChildren(next, change.id, from, change.dimensions)
            }
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
            /* A card dragged wider than the room its zone has left overhangs the backdrop,
               which reads as a rendering bug. Same call the drag does, for the same reason. */
            next = growZones(next)
          }
          return next
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
    },
    [documentNodes, setNodes, topology, onAdvise, edges, setEdges],
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
      if (anchor || landing) {
        connection = {
          ...connection,
          ...(anchor
            ? { sourceHandle: fixedHandleForSide(anchor.side) ?? connection.sourceHandle }
            : {}),
          ...(landing
            ? { targetHandle: fixedHandleForSide(landing.side) ?? connection.targetHandle }
            : {}),
        }
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
             behind them yet, so they start unbound and render dashed. */
          bound: payload.bound ?? false,
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
    [screenToFlowPosition, nodes, topology, setNodes, onInspect, onNotify, onAdvise],
  )

  /*
   * Every connector's paint layer, stated rather than derived -- see `edgeZFor` in canvas/layout.js.
   *
   * Here rather than in `toFlowEdge` because an edge made by a live drag never goes through
   * `toFlowEdge`; `addEdge` builds it in `onConnect`. This is the one place every edge passes
   * through on its way to React Flow, whatever created it.
   */
  const layeredEdges = useMemo(
    () => edges.map((edge) => (edge.zIndex === edgeZFor(edge) ? edge : { ...edge, zIndex: edgeZFor(edge) })),
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
            onConnectEnd={() => {
              connectFrom.current = null
              /* A no-op if `onConnect` already consumed it; a stale one otherwise, from a drag
                 that ended without connecting -- which must not attach itself to a later,
                 unrelated connection drawn from the same node. */
              dragAnchorRegistry.clear()
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            /* So clicking a connection shows a draggable dot at each end. Generous
               radius: the ends of an edge are two small dots on a diagram the reader is
               usually zoomed out of, and 10px of slop is the difference between
               "draggable" and "fiddly". */
            edgesReconnectable
            /*
             * Generous, because the thing being grabbed is a dot on a line the reader is usually
             * zoomed out of. 20 rather than the library's 10 for a second reason too: the anchor is
             * centred on the endpoint, which is exactly where the node's own connection handle is,
             * so the inner part of it is under the card. The radius is what leaves a ring of it
             * outside.
             */
            reconnectRadius={20}
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
             * Swallow one specific complaint, and only for the case it is wrong about.
             *
             * `008` is "couldn't create edge for handle id X". React Flow raises it whenever an edge
             * names a handle that is not currently mounted -- which is *every* free border anchor a
             * moment after the drag that made it, because that handle follows the cursor and then
             * stops existing (see canvas/handles.js). The edge is fine: `FlowEdge` resolves the point
             * from the node's own box. Left alone this logs on every render of every such edge, which
             * on a diagram with a few of them is a console nobody can read -- and this app pipes its
             * console into a drawer the user is meant to consult.
             *
             * Every other code, and an `008` about a handle that is *not* a free anchor, goes through
             * to the default so a genuinely broken edge still says so.
             */
            onError={(code, message) => {
              if (code === '008' && /free:/.test(message)) return
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
 * The topology's tree is now advice rather than the rule it was. A zone lands wherever
 * the cursor was, and the only thing still refused outright is a duplicate -- two zones
 * with one id would collide on save, which is a different kind of problem from an
 * unconventional arrangement.
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
 * to go. Collapsed group stacks are excluded for the opposite reason -- their id is not in the
 * document, so a route stored against one would be dropped on the next expand.
 *
 * Positions are absolute. A component inside a zone stores its position relative to that zone, and
 * an obstacle test against parent-relative coordinates would place every card in Unify a few
 * hundred pixels from where it is drawn.
 */
function componentBoxes(nodes) {
  const positions = absolutePositions(nodes ?? [])
  const boxes = []
  for (const node of nodes ?? []) {
    if (node.type === 'zone' || isGroupStackId(node.id)) continue
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
