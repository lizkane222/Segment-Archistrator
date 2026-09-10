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
 * Anchor visibility and the collapse state are provided through context rather than
 * written into each node's data -- see canvas/anchors.js for why that distinction
 * matters.
 *
 * The `nodes` and `edges` handed in are a *view*: Workbench collapses the document
 * before passing it down (canvas/grouping.js). So a node here may be a `groupStack`
 * standing for many, whose id the document has never heard of -- which is why a change
 * addressed to one is translated onto its members before it reaches the store, and why
 * clicking one opens the group rather than the inspector.
 */

import { useCallback, useMemo, useState } from 'react'
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
import { MessageSquareText, Tag } from 'lucide-react'

import FlowEdge from './edges/FlowEdge.jsx'
import GroupControl from './GroupControl.jsx'
import GroupStackNode from './nodes/GroupStackNode.jsx'
import SegmentNode from './nodes/SegmentNode.jsx'
import ShapeNode from './nodes/ShapeNode.jsx'
import ZoneNode from './nodes/ZoneNode.jsx'
import AnchorGutter from './AnchorGutter.jsx'
import { AnchorContext, createAnchorFocus } from './anchors.js'
import { annotatedBounds } from './anchorGutter.js'
import { GroupCollapseContext } from './groupCollapse.js'
import { ChromeContext } from './chrome.js'
import { FlashContext } from './flash.js'
import { EDGE_MENU, NODE_MENU, PANE_MENU } from '../commands/registry.js'
import { isGroupStackId, translateGroupDrag } from './grouping.js'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  componentSize,
  droppedZoneSize,
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
import { SIDES } from './handles.js'
import { styleFor } from './kinds.js'
import SelectionToolbar from './SelectionToolbar.jsx'
import {
  GROUP_ID_PREFIX,
  alignNodes,
  groupNodes,
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
  zone: ZoneNode,
  groupStack: GroupStackNode,
}
const EDGE_TYPES = { flow: FlowEdge }

export const DRAG_MIME = 'application/segment-arch-kind'

export default function Canvas({
  topology,
  nodes,
  edges,
  documentNodes = nodes,
  groups = [],
  collapsed = [],
  onCollapsedChange,
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
  flash,
  connected = false,
  walkthroughActive = false,
  exporting = false,
}) {
  const { screenToFlowPosition, getNode, getInternalNode, fitBounds } = useReactFlow()

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

  /* Off by default: every anchor open at once is a wall of text, and the hover
     reading answers "what is this one?" on its own. Pinning them all is for reading
     the architecture as a document, which is why it is a mode rather than a
     modifier key. Switched on, the notes move to the gutter outside the drawing --
     see canvas/AnchorGutter.jsx, including why an export still does not contain them. */
  const [showAnchors, setShowAnchors] = useState(false)

  /* Outside React on purpose. See canvas/anchors.js: a hovered id in state would put a
     whole-canvas render on every mouse move. Created once, so it costs the context value
     nothing to carry. */
  const focus = useMemo(() => createAnchorFocus(), [])
  const anchors = useMemo(
    () => ({ topology, showAll: showAnchors, focus }),
    [topology, showAnchors, focus],
  )

  /* Zoom out to include the gutter when it appears. Without this the control reads as
     broken: the notes are a note's width outside the drawing, so at the zoom that fitted
     the drawing they are off both edges of the screen and switching them on does nothing
     visible. Not reversed on the way back -- the user's zoom after that is theirs. */
  const toggleAnchors = useCallback(() => {
    const next = !showAnchors
    setShowAnchors(next)
    if (!next) {
      /* Or the pinned note's component keeps glowing with nothing on screen to explain
         why, and the pin comes back the next time the notes do. */
      focus.clearPin()
      return
    }
    const bounds = annotatedBounds(nodes)
    if (bounds) fitBounds(bounds, { duration: 300 })
  }, [showAnchors, nodes, fitBounds, focus])

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

  const chrome = useMemo(
    () => ({
      showFlags,
      connected,
      rename: onRename ?? null,
      setRadius: onSetRadius ?? null,
      onWaypoints,
      adjustingEdgeId,
      walkthroughActive,
    }),
    [
      showFlags,
      connected,
      onRename,
      onSetRadius,
      onWaypoints,
      adjustingEdgeId,
      walkthroughActive,
    ],
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

  const runSelection = useCallback(
    (transform) => setNodes(growZones(transform(documentNodes, selection.ids))),
    [documentNodes, selection.ids, setNodes],
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

  const isValidConnection = useMemo(() => {
    const valid = makeConnectionValidator({ topology, getNode, edges })
    /* Wrapped rather than taught about stacks: `rules.js` answers questions about the
       document, and a stack is not in it. Refusing here is also what makes the handle
       read as invalid mid-drag instead of only on release. */
    return (connection) =>
      !isGroupStackId(connection.source) &&
      !isGroupStackId(connection.target) &&
      valid(connection)
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
            const from = zoneSize(current.find((node) => node.id === change.id))
            next = scaleZoneChildren(next, change.id, from, change.dimensions)
          }
          if (sized.length) {
            const byId = new Map(sized.map((change) => [change.id, change.dimensions]))
            next = next.map((node) => {
              const box = byId.get(node.id)
              if (!box) return node
              /* Rounded for the same reason positions are: a sub-pixel width produces a
                 diff on every save and makes "did this change?" unanswerable by eye. */
              return {
                ...node,
                data: {
                  ...node.data,
                  size: { width: Math.round(box.width), height: Math.round(box.height) },
                },
              }
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
       * Selecting one member of a group selects the group.
       *
       * That is the whole of what a group is here: React Flow already drags a
       * multi-selection together, so the drag path needs to know nothing about groups --
       * see canvas/selection.js.
       *
       * Done on the change stream rather than in `onNodeClick` because a rubber-band
       * selection and a select-all arrive as changes and never as a click, and a group
       * half-caught by a lasso would come apart on the next drag. Appended rather than
       * merged, because a plain click arrives as deselect-everything followed by
       * select-one: an extra select has to land *after* those deselects to survive them.
       */
      const selecting = changes
        .filter((change) => change.type === 'select' && change.selected)
        .map((change) => change.id)
      const mates = withGroupMates(documentNodes, selecting)
      const forwarded =
        mates === selecting
          ? changes
          : [
              ...changes,
              ...mates
                .filter((id) => !selecting.includes(id))
                .map((id) => ({ id, type: 'select', selected: true })),
            ]

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
   */
  const onNodeDragStop = useCallback(
    (_event, node, dragged) => {
      const moved = dragged?.length ? dragged : node ? [node] : []
      const byId = new Map(moved.map((item) => [item.id, item]))

      let next = documentNodes.map((entry) => {
        const item = byId.get(entry.id)
        return item ? { ...entry, position: item.position } : entry
      })

      const advisories = []
      for (const item of moved) {
        const live = next.find((entry) => entry.id === item.id)
        /* A stack's id is not in the document -- it stands for several nodes that are.
           Dragging one moves its members (translateGroupDrag), but which zone a group
           of forty belongs to is not a question one drop can answer, so it keeps the
           parent it had. */
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

      setNodes(growZones(next))
      for (const advisory of advisories) onAdvise?.(advisory.message, advisory.nodeId)

      /* A mapping dropped onto its destination is a fact about the drop, not
         something the user should have to draw separately -- see attachTargetFor. */
      for (const item of moved) {
        const live = next.find((entry) => entry.id === item.id)
        if (!live || kindOf(live) !== 'destination_mapping') continue

        const attached = attachTargetFor(live, next, {
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
    (connection) => {
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
            data: { discovered: false, ...(waypoints.length ? { waypoints } : {}) },
          },
          current,
        ),
      )
    },
    [isValidConnection, setEdges, topology, getNode, edges, onNotify, avoidanceFor],
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
      setEdges((current) => reconnectEdge(oldEdge, connection, current))
    },
    [edges, topology, getNode, setEdges, onNotify],
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

      /* Centre the node on the cursor. Dropping by top-left corner feels like a
         half-node offset error. */
      const position = { x: dropped.x - NODE_WIDTH / 2, y: dropped.y - NODE_HEIGHT / 2 }

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

  return (
    <AnchorContext.Provider value={anchors}>
      <FlashContext.Provider value={flash}>
      <ChromeContext.Provider value={chrome}>
      <GroupCollapseContext.Provider value={groupCollapse}>
        <div className="h-full w-full">
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
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
             * The other half of making endpoint dragging work at all.
             *
             * Edges paint *below* nodes, so the reconnect anchor at each end sits under the very
             * component it is attached to -- and under that component's connection handle, which
             * takes the pointer and starts drawing a *new* connection instead. This lifts the
             * selected edge by 1000 (`getElevatedEdgeZIndex`), which clears the components at
             * `COMPONENT_Z` and puts its anchors on top where they can be grabbed.
             *
             * Only the selected edge is lifted, which is also the only one whose ends anyone is
             * trying to move -- so the cost is that a selected connector draws over the cards it
             * passes, during the moment you are editing it.
             */
            elevateEdgesOnSelect
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
            onNodeClick={(_, node) => {
              if (isGroupStackId(node.id)) return
              onInspect?.(node)
              if (node.type !== 'zone') setModelId(node.id)
            }}
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
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d7dbe4" />

            {/* Not while exporting: the notes portal *into* the viewport, which is the
                element the export captures, and `diagramBounds` measures nodes -- so a
                capture with them up would crop them in half rather than include them. */}
            {showAnchors && !exporting && <AnchorGutter nodes={nodes} />}

            <Panel position="top-left" className="flex flex-col items-start gap-1.5">
              <button
                type="button"
                onClick={toggleAnchors}
                aria-pressed={showAnchors}
                title="What happens to an event at each component, in a column either side of the diagram. Hover either end to see which note goes with which component."
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs shadow-sm transition-colors ${
                  showAnchors
                    ? 'border-twilio-blue bg-twilio-blue text-white'
                    : 'border-twilio-gray-20 bg-white text-twilio-gray-60 hover:text-twilio-navy'
                }`}
              >
                <MessageSquareText size={13} aria-hidden="true" />
                {showAnchors ? 'Hide anchor notes' : 'Show anchor notes'}
              </button>
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
            </Panel>
            {/* Centred, and above rather than beside the diagram: the actions are about the
                selection, so anchoring the bar to the selection's own bounding box would
                put it under the cursor mid-drag and move it every time the selection
                changed. */}
            <Panel position="top-center">
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
  const id = descriptor.id ?? `custom:zone:${crypto.randomUUID().slice(0, 8)}`

  if (nodes.some((node) => node.id === zoneNodeId(id))) {
    onNotify?.({
      tone: 'error',
      message: `${descriptor.label ?? id} is already on the canvas.`,
    })
    return null
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

  const { width, height } = droppedZoneSize(id)
  const topLeft = {
    x: Math.round(dropped.x - width / 2),
    y: Math.round(dropped.y - height / 2),
  }

  return toZoneNode(
    { order: nodes.filter((node) => node.type === 'zone').length, ...descriptor, id, parent },
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
