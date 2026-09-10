/*
 * The three-column shell: palette | canvas | inspector.
 *
 * Topology is fetched once here and passed down. Both the palette and the canvas
 * need the zone and connection rules, and they must be working from the same copy
 * -- the whole reason those rules live on the server is that two divergent copies
 * would let the canvas draw diagrams the backend considers invalid.
 *
 * ReactFlowProvider wraps at this level rather than inside Canvas because the
 * palette's drop handling needs `screenToFlowPosition`, which only exists inside
 * the provider.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { KeyRound, LogOut, RefreshCw, TriangleAlert, Workflow } from 'lucide-react'

import Canvas from './canvas/Canvas.jsx'
import ConnectDialog from './auth/ConnectDialog.jsx'
import ConsoleDrawer from './console/ConsoleDrawer.jsx'
import ContextMenu from './commands/ContextMenu.jsx'
import DiagramBar from './diagram/DiagramBar.jsx'
import ErrorBoundary from './ui/ErrorBoundary.jsx'
import Inspector from './inspector/Inspector.jsx'
import NuancesDialog from './commands/NuancesDialog.jsx'
import OpenDialog from './diagram/OpenDialog.jsx'
import Palette from './palette/Palette.jsx'
import EventPreview from './simulation/EventPreview.jsx'
import WalkthroughDrawer from './simulation/WalkthroughDrawer.jsx'
import { Toasts, useToasts } from './ui/Toasts.jsx'
import { clearSchemaCache } from './inspector/useSpaceSchema.js'
import { useConsoleLog } from './console/useConsoleLog.js'
import { createFlash } from './canvas/flash.js'
import { collapseGraph, groupsOf } from './canvas/grouping.js'
import { applyPaletteToNodes, clearPaletteFromNodes, paletteByKey } from './canvas/palettes.js'
import { runCommand } from './commands/registry.js'
import { useGraphHistory } from './commands/useGraphHistory.js'
import { useShortcuts } from './commands/useShortcuts.js'
import {
  copyNodes,
  duplicateNodes,
  pasteNodes,
  readClipboard,
  writeClipboard,
} from './commands/clipboard.js'
import SplitView from './ui/SplitView.jsx'
import TabStrip from './diagram/TabStrip.jsx'
import { useTabs } from './diagram/tabs.js'
import { toZoneLocal, zoneAtPosition } from './canvas/rules.js'
import { growZones, toFlowEdge, toFlowNode } from './canvas/layout.js'
import {
  GROUP_ID_PREFIX,
  alignNodes,
  anyLocked,
  arrangeNodes,
  distributeNodes,
  groupNodes,
  setLocked,
  ungroupNodes,
} from './canvas/selection.js'
import { useDiagrams } from './diagram/useDiagrams.js'
import { usePlayback } from './simulation/usePlayback.js'
import { useWorkspaceGraph } from './hooks/useWorkspaceGraph.js'
import {
  PLAY_MODES,
  applyPathsToEdges,
  applyPathsToNodes,
  combinedFrameAt,
  newScenario,
  playbackLength,
  runScenarios,
  runnable,
} from './simulation/scenarios.js'
import { defaultSourceId } from './simulation/router.js'
import { skeleton } from './simulation/payload.js'
import {
  countPlaceholders,
  graphFingerprint,
  isPlaceholder,
  serializeGraph,
} from './diagram/serialize.js'
import { exportPdf, exportPng, waitForRender } from './diagram/exportImage.js'
import { meta } from './services/api.js'

export default function AppShell({ workspace, onConnected, onSignOut }) {
  const [topology, setTopology] = useState(null)
  const [topologyError, setTopologyError] = useState(null)

  useEffect(() => {
    let cancelled = false
    meta
      .topology()
      .then((result) => !cancelled && setTopology(result))
      .catch((err) => !cancelled && setTopologyError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * Several diagrams open at once. See diagram/tabs.js for the model; what matters here is the
   * shape of the tree it produces.
   *
   * One `ReactFlowProvider` **per pane**, and each `Workbench` keyed by its tab id. Both halves are
   * load-bearing:
   *
   *   - Two canvases cannot share one provider. React Flow keeps a single node store per provider,
   *     so a shared one would give both panes the same nodes and the same viewport.
   *   - Keying by tab id is what makes switching cheap. React unmounts the outgoing pane, its store
   *     goes with it, and the incoming one mounts from the graph its tab was holding -- so at most
   *     two canvases exist at a time however many tabs are open. It is also what guarantees the
   *     unmount capture below runs: no key, and React would reuse the component and quietly show
   *     the new tab's name over the old tab's drawing.
   */
  const tabs = useTabs()

  /* Which pane the shared controls act on. The last one clicked, held here rather than derived,
     because "the active tab" and "the pane you are working in" are different questions once there
     are two panes -- and the strip has to keep highlighting the tab whose pane you are editing. */
  const [focused, setFocused] = useState(0)

  /*
   * Which tabs have unsaved work, as each pane reports it.
   *
   * Only a *mounted* pane can answer this properly: `useDiagrams` decides it by comparing a
   * fingerprint of the live graph against the one last persisted, and that comparison lives in the
   * pane. So panes report up, and a tab nobody has open falls back to the one thing that is knowable
   * without it -- a diagram with no database id has never been saved, so it is dirty by definition.
   *
   * The honest limitation: a tab that was edited, switched away from, and never saved keeps its dot
   * only because its last report is still in this map. That is right, and it survives switching
   * back and forth; what it would not survive is a page reload, which loses the tab anyway.
   */
  const [dirtyByTab, setDirtyByTab] = useState({})
  const reportDirty = useCallback((tabId, dirty) => {
    setDirtyByTab((current) => (current[tabId] === dirty ? current : { ...current, [tabId]: dirty }))
  }, [])

  const dirtyIds = useMemo(
    () =>
      new Set(
        tabs.tabs.filter((entry) => dirtyByTab[entry.id] ?? !entry.doc?.id).map((entry) => entry.id),
      ),
    [tabs.tabs, dirtyByTab],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SplitView orientation={tabs.orientation}>
        {tabs.visible.map((tab, index) => (
          <ReactFlowProvider key={tab.id}>
            <Workbench
              workspace={workspace}
              onConnected={onConnected}
              onSignOut={onSignOut}
              topology={topology}
              topologyError={topologyError}
              tab={tab}
              onCaptureTab={tabs.capture}
              /* Clicking anywhere in a pane makes it the one the tab strip is about. */
              onFocusPane={() => setFocused(index)}
              onDirtyChange={reportDirty}
              /* The strip is rendered by whichever pane is focused, into its own document row --
                 which is where the diagram's name used to be, and is where the request asked for
                 it. One strip, not one per pane: two copies of the same row of chips a few hundred
                 pixels apart would be two controls claiming to own the same state. */
              /* A render function, not an element, so the pane can hand its own `rename` in.
                 Renaming is only offered on the active chip, which is always the chip belonging to
                 the pane drawing the strip -- so the rename has to reach *that* pane's document, and
                 only the pane has it. Built here as an element instead, the strip would have to
                 write the name into the tab record and the pane would never hear about it. */
              tabStrip={
                index === focused
                  ? (pane) => (
                      <TabStrip
                        tabs={tabs.tabs}
                        activeId={tab.id}
                        dirtyIds={dirtyIds}
                        split={tabs.split}
                        orientation={tabs.orientation}
                        onSelect={tabs.setActiveId}
                        onRename={(_tabId, name) => pane.onRename(name)}
                        onFork={tabs.fork}
                        onClose={tabs.close}
                        onNew={() => tabs.open()}
                        onToggleSplit={tabs.toggleSplit}
                        onOrientation={tabs.setOrientation}
                      />
                    )
                  : null
              }
            />
          </ReactFlowProvider>
        ))}
      </SplitView>
    </div>
  )
}

function Workbench({
  workspace,
  onConnected,
  onSignOut,
  topology,
  topologyError,
  tab = null,
  onCaptureTab,
  onFocusPane,
  onDirtyChange,
  tabStrip = null,
}) {
  const { toasts, notify: raiseToast, dismiss } = useToasts()
  const log = useConsoleLog()

  /* One call site, two destinations. Wrapping here rather than editing the two dozen
     `notify` calls means a message added later cannot forget to be logged -- and the
     refusals are the whole point of keeping a log, since a toast is gone in six
     seconds and "why did it not let me do that" outlives it. */
  const notify = useCallback(
    ({ message, tone = 'info', source = 'app', detail = null }) => {
      raiseToast({ message, tone })
      log.record({ level: tone, message, source, detail })
    },
    [raiseToast, log.record],
  )

  /* Console only, deliberately no toast. An advisory fires on every frame of a drag that
     crosses a boundary and on every drop into an unconventional zone; as a toast that is
     a stack of popups arguing with something the user did on purpose. The console folds
     repeats into a count and is there to be consulted, which is the right weight for
     "this is not where these usually go". */
  /* One store for the session. Created here rather than in Canvas because both ends
     need it: Canvas provides it to the node renderers, and the two places a message
     about a component is produced -- a drag that lands somewhere unexpected, and the
     save response -- are both up here. See canvas/flash.js. */
  const flash = useMemo(() => createFlash(), [])

  const advise = useCallback(
    /* `nodeId` is optional and the call sites that have it pass it: a note naming
       "Destination" on a diagram with three of them is nearly no information, so the
       one it means pulses. */
    (message, nodeId = null) => {
      log.record({ level: 'warning', message, source: 'placement' })
      if (nodeId) flash.flash([nodeId])
    },
    [log.record, flash],
  )

  const graphState = useWorkspaceGraph({ topology })
  const docs = useDiagrams()
  const { deleteElements, fitView, getViewport, screenToFlowPosition, setViewport } =
    useReactFlow()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [drawing, setDrawing] = useState(false)
  /* Culling has to be off while the canvas is captured -- see exportImage.js. */
  const [exporting, setExporting] = useState(false)

  /* Saved walkthrough paths, part of the document. `selectedPaths` is not: which of
     them you are looking at right now is no more part of the architecture than which
     node is selected, and persisting it would mark the diagram dirty for pressing
     play. */
  const [scenarios, setScenarios] = useState([])
  const [selectedPaths, setSelectedPaths] = useState([])
  const [playMode, setPlayMode] = useState(PLAY_MODES.together)

  /* Which groups are folded, for the same reason `scenarios` is here and
     `selectedPaths` is not: it is the reader's account of the architecture rather
     than a transient selection, so it belongs to the document and survives a save. */
  const [collapsed, setCollapsed] = useState([])

  /* --- the command layer --------------------------------------------------- */

  /* Where the right-click landed and what it landed on, as Canvas reported it. */
  const [menu, setMenu] = useState(null)
  const [nuancesFor, setNuancesFor] = useState(null)

  /* Mirrored into state from sessionStorage rather than read on every keystroke, so a
     clip put there before a reload -- or by the diagram open in another workbench tab --
     is what enables Paste in the menu. */
  const [clipboard, setClipboard] = useState(() => readClipboard())

  /* The last pointer position, in client coordinates, held in a ref because it changes on
     every mouse move and none of those are renders anyone needs. It is what makes a
     keyboard cmd-v land where the user is looking rather than on top of the original. */
  const pointer = useRef(null)

  /* One string, or null when the affordance is available. Every workspace-only
     control reads this, so a disconnected visitor is told why the button is dead
     instead of finding out from a 403. */
  const workspaceReason = !workspace
    ? 'Connect a workspace with a Segment Public API token to read its components.'
    : /*
       * A workspace *is* connected, with an app session `auth_token` -- which identifies it but
       * cannot read its components. Said here, where every workspace-only control already looks
       * for its reason, so the button is dead with an explanation rather than dead because the
       * request behind it 403s. The two states need different sentences: one is "connect
       * something", the other is "connect the other thing", and a message covering both would
       * tell someone who has already connected a workspace to go and connect a workspace.
       */
      workspace.canReadWorkspace === false
      ? 'This workspace was connected with an app session. Reading its components needs a Segment Public API token.'
      : null

  /* The *id*, not the node. The inspector edits node data, so holding the object
     captured at selection time would show stale values right after an edit. */
  const [inspectedId, setInspectedId] = useState(null)
  const inspected = useMemo(
    () => graphState.nodes.find((node) => node.id === inspectedId) ?? null,
    [graphState.nodes, inspectedId],
  )

  const { setNodes } = graphState

  const updateNode = useCallback(
    (id, patch) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
        ),
      )
    },
    [setNodes],
  )

  /* "Make every warehouse grey." Merges into each node's existing override rather
     than replacing it, so a node with a bespoke shape keeps it when the kind's
     colours change. */
  const updateKindStyle = useCallback(
    (kind, style) => {
      setNodes((current) =>
        current.map((node) =>
          node.data?.kind === kind
            ? { ...node, data: { ...node.data, style: { ...node.data.style, ...style } } }
            : node,
        ),
      )
      notify({ tone: 'success', message: `Styled every ${kind.replace(/_/g, ' ')} on the canvas.` })
    },
    [setNodes, notify],
  )

  const applyPalette = useCallback(
    (key) => {
      setNodes((current) => applyPaletteToNodes(current, key))
      notify({ tone: 'success', message: `Applied the ${paletteByKey(key)?.name ?? key} palette.` })
    },
    [setNodes, notify],
  )

  const resetPalette = useCallback(() => {
    setNodes((current) => clearPaletteFromNodes(current))
    notify({ tone: 'info', message: 'Components are back to their default colours.' })
  }, [setNodes, notify])

  /* --- the document ------------------------------------------------------- */

  const { nodes, edges } = graphState

  /* The stored form of what is on screen. Recomputed per render rather than on
     demand so the unsaved marker is live; it is a few hundred object spreads, which
     is cheaper than the drag it happens during. */
  const currentGraph = useMemo(
    () => serializeGraph({ nodes, edges, scenarios, collapsed }),
    [nodes, edges, scenarios, collapsed],
  )

  /*
   * The canvas gets a *projection* of the document, not the document.
   *
   * Collapsing is a way of reading the diagram, so it must never reach back into
   * `graphState` -- expanding a group has to give the exact nodes and edges back,
   * and it can only do that if they were never gone. Which means everything that
   * asks "what is in this diagram?" keeps reading `nodes`/`edges` (serialization,
   * the walkthrough, the inspector, the placeholder count) and only the renderer
   * reads `view`.
   *
   * `groups` is derived from the document too, deliberately: computed from the view,
   * a folded group would vanish from the very list that unfolds it.
   */
  const view = useMemo(() => collapseGraph(nodes, edges, collapsed), [nodes, edges, collapsed])
  const groups = useMemo(() => groupsOf(nodes, topology), [nodes, topology])
  const dirty = Boolean(docs.current.id) && docs.isDirty(currentGraph)
  /* Reported up so the tab strip can put a dot on this tab. Only a mounted pane can answer it --
     the comparison is against a fingerprint `useDiagrams` holds -- so the strip cannot compute it
     for itself; see `dirtyByTab` in AppShell. */
  useEffect(() => {
    if (tab) onDirtyChange?.(tab.id, dirty)
  }, [tab, dirty, onDirtyChange])
  const placeholders = useMemo(() => countPlaceholders(nodes), [nodes])
  /* Components, not nodes: a canvas holding only zone backdrops -- a template's
     regions before anything is bound into them, or a zone someone has just drawn --
     is still empty in the sense the empty state and the theme control care about. */
  const componentCount = useMemo(
    () => nodes.filter((node) => node.type !== 'zone').length,
    [nodes],
  )
  /* So the palette can grey out a zone that is already drawn rather than let
     someone drop a second Connections. */
  const zonesOnCanvas = useMemo(
    () => new Set(nodes.filter((node) => node.type === 'zone').map((node) => node.data.id)),
    [nodes],
  )

  /* --- undo ---------------------------------------------------------------- */

  const print = useMemo(() => graphFingerprint(currentGraph), [currentGraph])

  /*
   * Deliberately not `applyGraph`. That is for *opening* a document -- it marks the
   * result saved, which would hide the unsaved dot on a state the user has just undone
   * back to, and it refits the viewport, which moves the canvas out from under them.
   * Undo puts the document back and touches nothing else.
   */
  const { replace: replaceGraph } = graphState
  const restore = useCallback(
    (graph) => {
      replaceGraph(graph)
      setScenarios(graph?.scenarios ?? [])
      setCollapsed(graph?.collapsed ?? [])
    },
    [replaceGraph],
  )

  const history = useGraphHistory({ graph: currentGraph, print, restore })

  /* --- the walkthrough ----------------------------------------------------- */

  /*
   * The graph the reducer runs over is the *serialized* one, memoised on its
   * fingerprint rather than on the node array.
   *
   * Playing a scenario writes `data.paths` onto nodes every tick, replacing their
   * object identities. Keying the runs on `nodes` would therefore re-evaluate every
   * FQL condition and audience query four times a second -- and worse, would loop:
   * new runs produce a new frame, which produces new nodes. The serialized document
   * has no playback fields in it at all (see RUNTIME_NODE_KEYS), so its fingerprint
   * is the thing that genuinely changes only when the architecture does.
   */
  const simFingerprint = useMemo(
    () => graphFingerprint({ nodes: currentGraph.nodes, edges: currentGraph.edges }),
    [currentGraph],
  )
  /* Keyed on the fingerprint, not on `currentGraph` -- that is the whole point, and
     the reason `currentGraph` is read here but deliberately not a dependency. */
  const simGraph = useMemo(
    () => ({ nodes: currentGraph.nodes, edges: currentGraph.edges }),
    [simFingerprint],
  )

  const activeScenarios = useMemo(
    () => runnable(simGraph, scenarios.filter((scenario) => selectedPaths.includes(scenario.id))),
    [simGraph, scenarios, selectedPaths],
  )
  const runs = useMemo(() => runScenarios(simGraph, activeScenarios), [simGraph, activeScenarios])
  const playbackTotal = useMemo(() => playbackLength(runs, playMode), [runs, playMode])
  const playback = usePlayback(playbackTotal)
  const frame = useMemo(
    () => combinedFrameAt(runs, playback.tick, { mode: playMode }),
    [runs, playback.tick, playMode],
  )

  const { setEdges } = graphState
  /* null means "clear it": `applyPaths*` returns the same array when there is
     nothing to clear, so deselecting every path costs one no-op pass rather than a
     rebuild of the canvas.

     Gated on the playhead having left the start (`tick >= 0`) as well as on there
     being runs. Selecting a path used to annotate the canvas immediately -- half the
     components dimmed to 50% before the user had pressed play -- which reads as the
     diagram having broken rather than as a walkthrough being ready. `reset` puts the
     tick back to -1, so this is also what makes the transport's stop button actually
     clear the canvas. */
  const liveFrame = runs.length > 0 && playback.tick >= 0 ? frame : null
  useEffect(() => {
    setNodes((current) => applyPathsToNodes(current, liveFrame, { playing: playback.playing }))
    setEdges((current) => applyPathsToEdges(current, liveFrame))
  }, [liveFrame, playback.playing, setNodes, setEdges])

  const addScenario = useCallback(
    (type = 'track') => {
      const created = newScenario({
        id: `path:${crypto.randomUUID().slice(0, 8)}`,
        name: `Path ${scenarios.length + 1}`,
        event: skeleton(type),
        existing: scenarios,
      })
      setScenarios((current) => [...current, created])
      /* Selected on creation. A new path that does nothing until you also click it
         reads as having failed to be created. */
      setSelectedPaths((current) => [...current, created.id])
      return created
    },
    [scenarios],
  )

  const startSimulation = useCallback(
    (type) => {
      if (!defaultSourceId(simGraph)) {
        notify({
          tone: 'info',
          message:
            'Add a source to the diagram first — an event enters the pipeline through a source’s write key, so there is nowhere for one to start.',
        })
        return
      }
      addScenario(type)
    },
    [simGraph, addScenario, notify],
  )

  const updateScenario = useCallback((id, patch) => {
    setScenarios((current) =>
      current.map((scenario) => (scenario.id === id ? { ...scenario, ...patch } : scenario)),
    )
  }, [])

  const removeScenario = useCallback((id) => {
    setScenarios((current) => current.filter((scenario) => scenario.id !== id))
    setSelectedPaths((current) => current.filter((entry) => entry !== id))
  }, [])

  const toggleSelectedPath = useCallback((id) => {
    setSelectedPaths((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )
  }, [])

  /* Through the view, because the drawer names nodes from the document and the one
     it wants may currently be inside a stack. fitView on an id React Flow has never
     heard of does nothing at all, which would read as the click being broken. */
  const focusNode = useCallback(
    (nodeId) => {
      if (!nodeId) return
      const onScreen =
        view.nodes.find((node) => node.id === nodeId) ??
        view.nodes.find((node) => node.data?.memberIds?.includes(nodeId))
      if (!onScreen) return
      fitView({ nodes: [{ id: onScreen.id }], padding: 3, duration: 400, maxZoom: 1.2 })
    },
    [fitView, view],
  )

  /* Everything that replaces the canvas goes through here, so "what is on the
     canvas" and "what the document believes it saved" can never drift apart. */
  const applyGraph = useCallback(
    (graph) => {
      /* A pulse pointing at a component from the previous document is worse than no
         pulse: the id may not exist here, and if it does it is a different component. */
      flash.clear()
      const layout = graphState.replace(graph)
      const opened = graph?.scenarios ?? []
      setScenarios(opened)
      /* Nothing selected, so opening a diagram never starts an animation on its
         own -- the paths are listed, and playing one is the reader's decision. */
      setSelectedPaths([])
      /* Restored, unlike the selection: a diagram saved with forty destinations folded
         was saved that way because that is the readable version of it, and opening it
         expanded would show the author's diagram as the wall they had folded away. */
      const folded = graph?.collapsed ?? []
      setCollapsed(folded)
      const stored = serializeGraph({ ...layout, scenarios: opened, collapsed: folded })
      docs.markSaved(stored)
      /* The undo stack starts again here. Opening a diagram is not an edit, and without
         this the first cmd-z would replace what is on screen with the previous
         customer's architecture and leave nothing to explain why. */
      history.reset(stored)
      setInspectedId(null)
      /* After the nodes have actually landed: restoring a viewport before the nodes
         exist works, but fitView has nothing to measure. */
      requestAnimationFrame(() => {
        if (layout.viewport) setViewport(layout.viewport)
        else fitView({ padding: 0.15 })
      })
      return layout
    },
    [graphState, docs, fitView, setViewport, history, flash],
  )

  /*
   * The tab handoff: mount from what this tab was carrying, hand it back on the way out.
   *
   * This component is keyed by tab id, so a switch is an unmount and a mount -- which is exactly
   * what makes these two effects sufficient, and why neither has a dependency on the tab: within
   * one mounted instance the tab never changes.
   *
   * The capture runs in a cleanup, and reads from a ref rather than from the render's closure. That
   * is the whole trick: an unmount cleanup written against `nodes` would capture the array from
   * whichever render registered the effect, so a tab switched away from would be stored as it was
   * when it was *opened*, silently discarding everything drawn since. The ref is reassigned on every
   * render, which is free; the serialize happens once.
   */
  const snapshot = useRef(null)
  snapshot.current = { nodes, edges, scenarios, collapsed, doc: docs.current }

  useEffect(() => {
    if (!tab) return
    /* The document first: `applyGraph` calls `markSaved`, and the dirty comparison is against the
       document this graph belongs to. */
    docs.adopt(tab.doc)
    if (tab.graph) applyGraph(tab.graph)
    /* Mount only. The component is keyed by tab id, so "the tab changed" is a remount and there is
       no second case to handle -- and re-running this on any other change would throw away the
       user's edits and reload the stored graph over them.
       eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  useEffect(
    () => () => {
      const held = snapshot.current
      if (!tab || !held) return
      onCaptureTab?.(tab.id, {
        graph: serializeGraph({
          nodes: held.nodes,
          edges: held.edges,
          scenarios: held.scenarios,
          collapsed: held.collapsed,
        }),
        doc: held.doc,
      })
    },
    /* Unmount only, for the same reason as above -- and `tab.id` is stable for the life of this
       instance, so the cleanup can safely name it.
       eslint-disable-next-line react-hooks/exhaustive-deps */
    [],
  )

  const openTemplate = async (key) => {
    try {
      const graph = await docs.openTemplate(key)
      const layout = applyGraph(graph)
      setDialogOpen(false)
      const unbound = countPlaceholders(layout.nodes)
      notify({
        tone: unbound ? 'info' : 'success',
        message: unbound
          ? `Opened as a new diagram. ${unbound} placeholder${unbound === 1 ? '' : 's'} to bind — click one and use the Bind tab.`
          : 'Opened as a new diagram.',
      })
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  const openDiagram = async (id) => {
    try {
      applyGraph(await docs.openDiagram(id))
      setDialogOpen(false)
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  const startBlank = () => {
    applyGraph(docs.startBlank())
    setDialogOpen(false)
    /* The empty state is a suggestion, not a mode: once someone has said they are
       drawing by hand, a panel over the middle of the zones is in the way. It does
       not come back if they later delete everything -- they have had the message. */
    setDrawing(true)
  }

  const removeDiagram = async (id) => {
    try {
      await docs.remove(id)
      notify({ tone: 'info', message: 'Diagram deleted. What is on the canvas is untouched.' })
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  /* The viewport is read at save time rather than tracked: it changes on every
     scroll wheel tick and none of those are edits. */
  const saveGraph = () =>
    serializeGraph({ nodes, edges, scenarios, collapsed, viewport: getViewport() })

  /* The server's read of the graph it just stored. Worth logging even though the canvas
     already advised on each move as it happened: this is computed from what was
     *persisted*, so it catches a document that arrived by paste, import or a template
     rather than by a drag, and it is the one place the two sides can be seen to agree. */
  const logAdvisories = (result) => {
    for (const message of result?.advisories ?? []) {
      log.record({ level: 'warning', message, source: 'save' })
    }
    /* `advisory_nodes` is ordered with `advisories` and the same length -- see
       DiagramSerializer. Nulls are dropped by the store, which is what the truncation
       line ("...and 4 more.") arrives as. */
    flash.flash(result?.advisory_nodes ?? [])
  }

  const save = async () => {
    try {
      const result = await docs.save(saveGraph())
      notify({ tone: 'success', message: `Saved “${result.name}”.` })
      logAdvisories(result)
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  const saveAs = async (name) => {
    try {
      const result = await docs.saveAs(name, saveGraph())
      notify({ tone: 'success', message: `Saved a copy as “${result.name}”.` })
      logAdvisories(result)
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  const exportDiagram = async (format) => {
    setExporting(true)
    /* A selection ring baked into an exported diagram reads as a rendering fault. */
    graphState.setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    )
    try {
      await waitForRender()
      const run = format === 'pdf' ? exportPdf : exportPng
      /* The view, because the bounds have to match the DOM being captured. Handed the
         document's nodes instead, an export with a group folded would reserve space for
         members that are not drawn and come out with a band of empty canvas. */
      const result = await run(view.nodes, { name: docs.current.name })
      notify({
        tone: result.downscaled ? 'info' : 'success',
        message: result.downscaled
          ? `Exported ${format.toUpperCase()}, scaled down to ${result.width}px wide — the diagram is too large to render at full size.`
          : `Exported ${format.toUpperCase()} at ${result.width}×${result.height}.`,
      })
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    } finally {
      setExporting(false)
    }
  }

  const focusPlaceholder = () => {
    const next = nodes.find((node) => node.type !== 'zone' && isPlaceholder(node))
    if (!next) return
    setInspectedId(next.id)
    fitView({ nodes: [{ id: next.id }], padding: 3, duration: 400, maxZoom: 1.2 })
  }

  const handleConnected = (next, { claimed = 0 } = {}) => {
    onConnected(next)
    setConnectOpen(false)
    /* The saved list was fetched against the anonymous scope. The diagrams it
       named have moved workspace, not changed id, but the list itself was read
       under the old cookie -- re-read it so what is offered matches what the
       server will now hand back. */
    docs.refresh()
    notify({
      tone: 'success',
      message: claimed
        ? `Connected to ${next.name}. ${claimed} diagram${claimed === 1 ? '' : 's'} you drew before connecting moved across.`
        : `Connected to ${next.name}.`,
    })
  }

  const loadWorkspace = async ({ refresh = false } = {}) => {
    if (workspaceReason) {
      notify({ tone: 'info', message: workspaceReason })
      setConnectOpen(true)
      return
    }
    try {
      const result = await graphState.load({ refresh })
      const count = result.nodes?.length ?? 0
      notify({ tone: 'success', message: `Loaded ${count} components from ${workspace.name}.` })
      /* Server-reported gaps, verbatim. These are the honest caveats -- missing
         Unify, a rate limit mid-fanout, journeys inferred from trait names. */
      for (const warning of result.warnings ?? []) {
        notify({ tone: 'info', message: warning })
      }
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  /* --- what the menu and the keyboard actually do --------------------------- */

  /* Read off the document, not the view: selection rides on `node.selected`, and
     `onNodesChange` writes it back through the document because a stack's id could not
     be written back at all. */
  const selection = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  )

  const copy = useCallback(
    (ids) => {
      const clip = copyNodes(nodes, edges, ids)
      if (!clip) return null
      setClipboard(clip)
      writeClipboard(clip)
      notify({ tone: 'success', message: `Copied ${components(clip.nodes.length)}.` })
      return clip
    },
    [nodes, edges, notify],
  )

  /* Through React Flow rather than `setNodes`, so Canvas's `onBeforeDelete` still runs.
     It holds the rule that a zone cannot go while its components are inside it, and a
     second route to deletion that skipped it would be a second answer to that rule. */
  const remove = useCallback(
    (ids) => {
      deleteElements({ nodes: (ids ?? []).map((id) => ({ id })) })
    },
    [deleteElements],
  )

  const cut = useCallback(
    (ids) => {
      const clip = copy(ids)
      /* What was copied, not what was asked for. A selection that included a zone has
         had it dropped by now, and cutting must not delete something the clipboard did
         not take -- there would be no paste that brought it back. */
      if (clip) remove(clip.nodes.map((node) => node.id))
    },
    [copy, remove],
  )

  /* The shared tail of paste and duplicate: document fragment in, canvas out. */
  const place = useCallback(
    (result, verb) => {
      if (result.error) {
        notify({ tone: 'error', message: result.error })
        return
      }
      /* Console, not toasts, and after the nodes are in hand rather than instead of them:
         an unconventional zone is worth a line and never worth losing the paste over. */
      for (const advisory of result.advisories ?? []) advise(advisory)

      const placed = result.nodes.map((node) => toFlowNode(node, node.zone, node.position))
      setNodes((current) => [
        /* The copies come out selected and the originals do not, so a drag straight
           afterwards moves what was just made rather than what it was made from. */
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        ...placed.map((node) => ({ ...node, selected: true })),
      ])
      setEdges((current) => [...current, ...result.edges.map(toFlowEdge)])
      /* Only when there is one, and because the first thing anyone does to a copy is
         rename it. Opening the inspector on one of forty would be a guess. */
      if (placed.length === 1) setInspectedId(placed[0].id)
      notify({ tone: 'success', message: `${verb} ${components(placed.length)}.` })
    },
    [setNodes, setEdges, notify, advise],
  )

  const paste = useCallback(
    (clip, at) => {
      /* The menu passes where it was opened; a keystroke passes nothing and gets the
         pointer. Either way the paste lands where the user is looking, which is the
         difference between pasting and finding a copy behind the original. */
      const point = at ?? pointer.current
      const flow = point ? screenToFlowPosition(point) : null
      const zone = flow ? zoneAtPosition(nodes, flow) : null
      place(
        pasteNodes(clip, {
          nodes,
          topology,
          zone: zone?.data ?? null,
          /* Zone-local when there is a zone, flow coordinates when there is not -- which
             is the same distinction `toFlowNode` makes about a node with no parent. */
          position: flow ? (zone ? toZoneLocal(zone, flow, nodes) : flow) : null,
        }),
        'Pasted',
      )
    },
    [nodes, topology, screenToFlowPosition, place],
  )

  const duplicate = useCallback(
    (ids) => {
      place(duplicateNodes(nodes, edges, ids, { topology }), 'Duplicated')
    },
    [nodes, edges, topology, place],
  )

  /* Components only. Zones are the regions the diagram is drawn in rather than part of
     it, and including them would put Delete one keystroke from taking a whole region. */
  const selectAll = useCallback(() => {
    setNodes((current) =>
      current.map((node) =>
        node.type === 'zone' || node.selected ? node : { ...node, selected: true },
      ),
    )
  }, [setNodes])

  /*
   * The arrange / align / distribute / group / lock family, all one shape: a pure transform
   * from canvas/selection.js applied through `setNodes`.
   *
   * `growZones` after each of them for the reason the resize handles call it too: an align
   * or a distribute can push a card past its zone's edge, and a zone that does not grow
   * leaves its own child drawn outside it. Arrange and lock cannot move anything, so they
   * would not need it -- they go through the same helper anyway rather than having a second,
   * subtly different path that a later edit could make matter.
   */
  const transformNodes = useCallback(
    (transform) => setNodes((current) => growZones(transform(current))),
    [setNodes],
  )

  const actions = useMemo(
    () => ({
      inspect: (node) => setInspectedId(node?.id ?? null),
      arrange: (ids, move) => transformNodes((current) => arrangeNodes(current, ids, move)),
      align: (ids, alignment) => transformNodes((current) => alignNodes(current, ids, alignment)),
      distribute: (ids, axis) => transformNodes((current) => distributeNodes(current, ids, axis)),
      lock: (ids, locked) => transformNodes((current) => setLocked(current, ids, locked)),
      /* The id is minted here rather than in `groupNodes`, which stays pure so the grouping
         rules are testable without a canvas. */
      group: (ids) =>
        transformNodes((current) =>
          groupNodes(current, ids, `${GROUP_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`),
        ),
      ungroup: (ids) => transformNodes((current) => ungroupNodes(current, ids)),
      /* The connector actions. Both write into `edge.data`, where `serializeEdge` reads them, and
         both go through the same `setEdges` the waypoint drag does -- one write path for the
         route, whether it was edited by dragging a handle or by picking a menu item. */
      lineStyle: (edgeId, line) =>
        setEdges((current) =>
          current.map((edge) =>
            edge.id === edgeId ? { ...edge, data: { ...edge.data, line } } : edge,
          ),
        ),
      /* `[]` clears rather than stores an empty array -- see the same reasoning in Canvas's
         `onWaypoints`: an edge with no bends must serialize like one that never had any. */
      route: (edgeId, waypoints) =>
        setEdges((current) =>
          current.map((edge) =>
            edge.id === edgeId
              ? {
                  ...edge,
                  data: { ...edge.data, waypoints: waypoints?.length ? waypoints : undefined },
                }
              : edge,
          ),
        ),
      /* Through React Flow, like `remove`, so `onBeforeDelete` still runs -- it is what spares an
         edge that is only in the set because a zone was selected. */
      removeEdges: (ids) => deleteElements({ edges: (ids ?? []).map((id) => ({ id })) }),
      /* An anchor click rather than `window.open`. Both carry `noopener` -- which matters,
         because the docs site is opened from a page holding a live session -- but a
         synthetic link click is an ordinary navigation and so is never popup-blocked,
         and `window.open` returns null under `noopener` by spec, meaning a blocked open
         and a successful one are indistinguishable and cannot be reported. */
      openUrl: (url) => {
        const link = document.createElement('a')
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        /* In the document for the duration of the click. A detached anchor's `click()` opens
           nothing in Firefox, which is the failure mode this whole approach was chosen to
           avoid being unable to detect: nothing happens and nothing can be reported. */
        document.body.append(link)
        try {
          link.click()
        } finally {
          link.remove()
        }
      },
      nuances: (node) =>
        setNuancesFor({
          kind: node.data.kind,
          /* Per kind *and* per slug, because the dialog asks for both -- a note about
             Braze and the notes about destinations in general. */
          slug: node.data.slug ?? '',
          label: node.data.name ?? node.data.kind,
        }),
      expandGroup: (stack) =>
        setCollapsed((current) => current.filter((key) => key !== stack?.data?.key)),
      copy,
      cut,
      paste,
      duplicate,
      remove,
      selectAll,
      save,
      undo: history.undo,
      redo: history.redo,
    }),
    [
      copy,
      cut,
      paste,
      duplicate,
      remove,
      selectAll,
      save,
      history.undo,
      history.redo,
      transformNodes,
      setEdges,
      deleteElements,
    ],
  )

  const commandContext = useMemo(
    () => ({
      nodes,
      selection,
      clipboard,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      canSave: !docs.busy,
      /* What Lock/Unlock and Ungroup read to decide which of them is the one on offer.
         Computed here rather than in the registry so the table stays free of node-shape
         knowledge -- `enabled` gets facts, not a graph to go looking through. */
      locked: anyLocked(nodes, selection),
      grouped: nodes.some((node) => node.selected && node.data?.group),
      actions,
    }),
    [nodes, selection, clipboard, history.canUndo, history.canRedo, docs.busy, actions],
  )

  /* The right-click menu's context is the same one, plus what was clicked. The keyboard
     has no subject, which is what makes its commands read the selection instead. */
  const menuContext = menu
    ? {
        ...commandContext,
        node: menu.node,
        stack: menu.stack,
        /* The whole edge object, because the connector rules read `deletable` and
           `data.waypoints` off it -- not just an id the registry would then have to go
           looking up. */
        edge: menu.edge ?? null,
        position: { x: menu.x, y: menu.y },
      }
    : null

  /* Off while a dialog is open: its fields and its own Escape belong to it, and cmd-a in
     the open dialog's filter is about that filter rather than about the canvas. */
  useShortcuts({
    context: commandContext,
    onRefuse: (message) => notify({ tone: 'info', message }),
    enabled: !dialogOpen && !connectOpen && !nuancesFor,
  })

  return (
    /* `onPointerDownCapture` rather than a click handler: it has to fire before the canvas handles
       the gesture, because "which pane am I working in" has to be settled before whatever that
       gesture does. Capture phase also means it fires for a drag that never becomes a click. */
    <div className="flex h-full min-h-0 flex-col" onPointerDownCapture={onFocusPane}>
      <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 bg-white px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold text-twilio-navy">
            Segment Builder
          </span>
          {workspace ? (
            <span className="text-xs text-twilio-gray-60">
              {workspace.name}
              {workspace.slug && (
                <span className="ml-2 font-mono text-[11px] opacity-70">{workspace.slug}</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-twilio-gray-40">Not connected</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {workspace ? (
            <>
              <button
                type="button"
                onClick={() => loadWorkspace({ refresh: graphState.status === 'ready' })}
                /* Disabled, with the reason on the tooltip, when the connected credential
                   cannot reach the Public API. Leaving it live would send the user at a
                   request that 403s and report it as a failure to load rather than as a
                   credential that cannot. */
                disabled={graphState.status === 'loading' || Boolean(workspaceReason)}
                title={workspaceReason ?? undefined}
                className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  aria-hidden="true"
                  className={graphState.status === 'loading' ? 'animate-spin' : undefined}
                />
                {graphState.status === 'ready' ? 'Refresh workspace' : 'Load workspace'}
              </button>
              <button
                type="button"
                onClick={() => {
                  /* The schema cache is module-level and holds one workspace's event
                     and trait names. Dropping it on disconnect keeps it from leaking
                     into whoever pastes the next token. */
                  clearSchemaCache()
                  onSignOut()
                }}
                className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
              >
                <LogOut size={14} aria-hidden="true" />
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark"
            >
              <KeyRound size={13} aria-hidden="true" />
              Connect a workspace
            </button>
          )}
        </div>
      </header>

      <DiagramBar
        tabStrip={tabStrip?.({ onRename: docs.rename })}
        doc={docs.current}
        dirty={dirty}
        busy={docs.busy}
        placeholders={placeholders}
        exporting={exporting}
        themeable={componentCount > 0}
        onOpen={() => setDialogOpen(true)}
        onSave={save}
        onSaveAs={saveAs}
        onRename={docs.rename}
        onExport={exportDiagram}
        onFocusPlaceholder={focusPlaceholder}
        onApplyPalette={applyPalette}
        onResetPalette={resetPalette}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* A column, so the payload panel takes the height it needs and the palette scrolls in what
            is left. `min-h-0` on the palette wrapper is what allows that -- a flex child defaults to
            never shrinking below its content, and the palette's content is long. */}
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-twilio-gray-20 bg-white">
          {/* Above the palette rather than below it: while an animation is playing this is what the
              reader is following, and the palette is what they are not using. Renders nothing at all
              when no walkthrough is mid-flight, so it costs an idle canvas no space. */}
          <EventPreview frame={liveFrame} graph={simGraph} scenarios={scenarios} />
          <div className="min-h-0 flex-1 overflow-hidden">
          <Palette
            topology={topology}
            graph={graphState.graph}
            zonesOnCanvas={zonesOnCanvas}
            workspaceReason={workspaceReason}
            onConnect={() => setConnectOpen(true)}
            onStartSimulation={startSimulation}
          />
          </div>
        </aside>

        <main
          className="relative min-w-0 flex-1 bg-twilio-gray-10"
          /* Tracked here rather than on the flow pane so it keeps working over a node,
             and written to a ref so a mouse move is not a render. */
          onMouseMove={(event) => {
            pointer.current = { x: event.clientX, y: event.clientY }
          }}
        >
          {topologyError ? (
            <Blocked
              title="Could not load the architecture rules"
              note={`${topologyError} The canvas cannot enforce valid placement without them, so it stays closed rather than letting you draw something invalid.`}
            />
          ) : !topology ? (
            <Blocked title="Loading architecture rules…" />
          ) : (
            <>
              {/* The diagram itself lives in this component's state, not the canvas's, so
                  a canvas that cannot render leaves the document intact and still
                  saveable from the bar above -- which is the difference between a bug and
                  a lost afternoon. Keyed on nothing: there is no next selection to
                  recover on, and a boundary that reset itself every render would loop. */}
              <ErrorBoundary
                title="The canvas cannot be drawn"
                hint="The diagram is still loaded and Save still works. Save it, then reload — the error below says what could not be rendered."
              >
              <Canvas
                topology={topology}
                nodes={view.nodes}
                edges={view.edges}
                documentNodes={nodes}
                groups={groups}
                collapsed={collapsed}
                onCollapsedChange={setCollapsed}
                setNodes={graphState.setNodes}
                setEdges={graphState.setEdges}
                onNodesChange={graphState.onNodesChange}
                onEdgesChange={graphState.onEdgesChange}
                onInspect={(node) => setInspectedId(node?.id ?? null)}
                onContextMenu={setMenu}
                onNotify={notify}
                onAdvise={advise}
                /* The same `updateNode` the inspector's own name field calls, so a rename
                   typed on the card and one typed in the sidebar are the same edit and land
                   on the same undo stack. */
                onRename={(id, name) => updateNode(id, { name })}
                /* Whether the Unbound flags mean anything yet -- see canvas/chrome.js. */
                connected={Boolean(workspace)}
                /* So an untouched component and an untouched zone can tell they are being left out
                   of a path, which nothing in their own data says -- see canvas/chrome.js. Exactly
                   the condition `liveFrame` uses, so the dimming appears and disappears with the
                   annotations rather than a frame either side of them. */
                walkthroughActive={runs.length > 0 && playback.tick >= 0}
                flash={flash}
                exporting={exporting}
              />
              </ErrorBoundary>
              {graphState.status !== 'loading' && componentCount === 0 && !drawing && (
                <EmptyOverlay
                  workspaceReason={workspaceReason}
                  onLoad={() => loadWorkspace()}
                  onOpen={() => setDialogOpen(true)}
                  onStartBlank={startBlank}
                />
              )}
            </>
          )}
          {connectOpen && (
            <ConnectDialog
              onConnected={handleConnected}
              onClose={() => setConnectOpen(false)}
            />
          )}
          {dialogOpen && (
            <OpenDialog
              templates={docs.templates}
              saved={docs.saved}
              loading={docs.loadingLists}
              error={docs.listError}
              busy={docs.busy}
              currentId={docs.current.id}
              onOpenTemplate={openTemplate}
              onOpenDiagram={openDiagram}
              onStartBlank={startBlank}
              onDelete={removeDiagram}
              onClose={() => setDialogOpen(false)}
            />
          )}
          {nuancesFor && (
            <NuancesDialog
              kind={nuancesFor.kind}
              slug={nuancesFor.slug}
              label={nuancesFor.label}
              /* Unconditional: App mounts the shell only once a session exists --
                 anonymous or connected -- and a session is all the endpoint asks for. */
              canSubmit
              onClose={() => setNuancesFor(null)}
              onNotify={notify}
            />
          )}
          <Toasts toasts={toasts} onDismiss={dismiss} />

          {/* Inside `main`, so it is positioned against the canvas and clears the
              minimap -- not against the window, where the inspector would cover it. */}
          <ConsoleDrawer
            entries={log.entries}
            unread={log.unread}
            onOpen={log.markRead}
            onClear={log.clear}
          />
        </main>

        <aside className="w-96 shrink-0 overflow-hidden border-l border-twilio-gray-20 bg-white">
          {/* Separately from the canvas, and keyed on the selection. The panel renders
              per-kind branches against whatever a node happens to carry, so it is the
              most likely thing here to meet a shape it was not written for -- and the
              canvas beside it, holding the unsaved diagram, has nothing to do with that.
              Reset by selection, so one unrenderable node does not close the panel for
              the rest of the session. */}
          <ErrorBoundary
            resetKey={inspected?.id ?? null}
            title="This component cannot be shown"
            hint="The canvas is unaffected — nothing has been lost. Select another component, or reopen this one."
          >
            <Inspector
              node={inspected}
              /* The whole canvas, so the Bind tab can tell which real components are
                 already spoken for by another node. */
              nodes={graphState.nodes}
              topology={topology}
              graph={graphState.graph}
              workspaceReason={workspaceReason}
              onConnect={() => setConnectOpen(true)}
              onUpdateNode={updateNode}
              onUpdateKind={updateKindStyle}
              onClose={() => setInspectedId(null)}
              onNotify={notify}
            />
          </ErrorBoundary>
        </aside>
      </div>

      {/* Full width under all three columns, and mounted only once a path exists.
          The paths are part of the document, so the drawer stays for as long as they
          do -- collapsing it is the way to get it out of the way without deleting
          work. */}
      {scenarios.length > 0 && (
        <WalkthroughDrawer
          graph={simGraph}
          topology={topology}
          scenarios={scenarios}
          runs={runs}
          frame={frame}
          transport={playback}
          mode={playMode}
          onModeChange={setPlayMode}
          selectedIds={selectedPaths}
          onToggleSelected={toggleSelectedPath}
          onAddScenario={addScenario}
          onUpdateScenario={updateScenario}
          onRemoveScenario={removeScenario}
          onFocusNode={focusNode}
          onClearSelection={() => setSelectedPaths([])}
        />
      )}

      {/* Outside the three columns, because two of them are `overflow-hidden` and a menu
          opened on a node near the right edge has to be able to reach past the
          inspector. */}
      {menu && (
        <ContextMenu
          at={menu}
          context={menuContext}
          onRun={(id) => {
            const result = runCommand(id, menuContext)
            if (!result.ran && result.reason) notify({ tone: 'info', message: result.reason })
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

const components = (count) => `${count} component${count === 1 ? '' : 's'}`

/* The canvas is mounted with its zone backdrops and no components, so this sits
   on top rather than replacing it -- dragging from the palette works before any
   fetch, which is how you draw an architecture with no token at all. */
function EmptyOverlay({ workspaceReason, onLoad, onOpen, onStartBlank }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto max-w-sm rounded-lg border border-twilio-gray-20 bg-white/95 p-5 text-center shadow-sm">
        <Workflow size={22} className="mx-auto text-twilio-gray-40" aria-hidden="true" />
        <h2 className="mt-2 text-sm font-semibold text-twilio-navy">Nothing on the canvas yet</h2>
        <p className="mt-1 text-xs leading-relaxed text-twilio-gray-60">
          Start from a reference template, drag components from the palette to draw one
          by hand, or build it from a customer&apos;s live workspace.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-twilio-blue-dark"
          >
            Open a template
          </button>
          <button
            type="button"
            onClick={onStartBlank}
            className="rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
          >
            Start from an empty canvas
          </button>
          <button
            type="button"
            onClick={onLoad}
            title={workspaceReason ?? undefined}
            className="rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy disabled:opacity-50"
            disabled={Boolean(workspaceReason)}
          >
            Load from workspace
          </button>
        </div>
        {workspaceReason && (
          <p className="mt-3 text-[11px] leading-relaxed text-twilio-gray-40">
            {workspaceReason}
          </p>
        )}
      </div>
    </div>
  )
}

function Blocked({ title, note }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <TriangleAlert size={22} className="mx-auto text-twilio-warning" aria-hidden="true" />
        <h2 className="mt-2 text-sm font-semibold text-twilio-navy">{title}</h2>
        {note && <p className="mt-1 text-xs leading-relaxed text-twilio-gray-60">{note}</p>}
      </div>
    </div>
  )
}

