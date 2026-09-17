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
import { createPortal } from 'react-dom'
import { ReactFlowProvider, useOnViewportChange, useReactFlow } from '@xyflow/react'
import { KeyRound, LogOut, MessageSquarePlus, RefreshCw, TriangleAlert, Workflow } from 'lucide-react'

import AccountMenu from './auth/AccountMenu.jsx'
import Canvas from './canvas/Canvas.jsx'
import ConnectDialog from './auth/ConnectDialog.jsx'
import InviteDialog from './auth/InviteDialog.jsx'
import ConsoleDrawer from './console/ConsoleDrawer.jsx'
import ContextMenu from './commands/ContextMenu.jsx'
import DiagramBar from './diagram/DiagramBar.jsx'
import ErrorBoundary from './ui/ErrorBoundary.jsx'
import Inspector from './inspector/Inspector.jsx'
import ProfilePreview from './inspector/ProfilePreview.jsx'
import NuancesDialog from './commands/NuancesDialog.jsx'
import OpenDialog from './diagram/OpenDialog.jsx'
import Palette from './palette/Palette.jsx'
import EventPreview from './simulation/EventPreview.jsx'
import FeedbackDialog from './feedback/FeedbackDialog.jsx'
import WalkthroughDrawer from './simulation/WalkthroughDrawer.jsx'
import { Toasts, useToasts } from './ui/Toasts.jsx'
import { clearSchemaCache } from './inspector/useSpaceSchema.js'
import { useConsoleLog } from './console/useConsoleLog.js'
import { createFlash } from './canvas/flash.js'
import { collapseGraph, groupsOf } from './canvas/grouping.js'
import {
  CHANNELS,
  applyPaletteToNodes,
  clearPaletteFromNodes,
  paletteByKey,
} from './canvas/palettes.js'
import { runCommand } from './commands/registry.js'
import {
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  resizeRow,
  tableText,
} from './canvas/tables.js'
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
import { centreOf, toZoneLocal, zoneAtPosition } from './canvas/rules.js'
import { autoAlignNodes } from './canvas/autoAlign.js'
import { growZones, toFlowEdge, toFlowNode, zoneSize } from './canvas/layout.js'
import { shiftSections } from './canvas/frames.js'
import { orientAlong, reverseEdge, reversible, routeToReach } from './canvas/direction.js'
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
  nextColor,
  playbackLength,
  runScenarios,
  runnable,
  tickDurations,
} from './simulation/scenarios.js'
import { createAnchorFocus } from './canvas/anchors.js'
import { choreograph } from './simulation/choreography.js'
import { notesInView, notesSoFar } from './simulation/notes.js'
import NotesLane from './simulation/NotesLane.jsx'
import { pathsReport } from './simulation/diagnostics.js'
import { defaultSourceId, hasArrived } from './simulation/router.js'
import { skeleton } from './simulation/payload.js'
import {
  countPlaceholders,
  graphFingerprint,
  isPlaceholder,
  serializeGraph,
} from './diagram/serialize.js'
import { downloadDiagramFile, parseDiagramFile } from './diagram/diagramFile.js'
import { useSession } from './auth/session.js'
import {
  isSessionLoss,
  lastResortMessage,
  recoveryMessage,
  recoveryStep,
  reviveSession,
} from './auth/recover.js'
import { useSessionKeepAlive } from './auth/useSessionKeepAlive.js'
import { exportPdf, exportPng, waitForRender } from './diagram/exportImage.js'
import { feedback as feedbackApi, meta } from './services/api.js'

/*
 * How fast the event travels along a connector, in flow pixels per second.
 *
 * Chosen so that a typical hop takes about a second: cards are 200px wide and usually sit 250-350px
 * apart, so at this speed most connectors are crossed in roughly the beat length the components
 * either side of them get. It is a *speed* rather than a duration on purpose -- a fixed duration per
 * connector is what made the event appear to accelerate across the long lines on a wide diagram.
 */
const HOP_SPEED_PX_PER_S = 300

/**
 * A table edit named by the right-click menu, carried out.
 *
 * Module scope and pure, so the mapping from verb to operation is testable and so the six menu rows
 * cannot drift from what they claim to do. Returns null for a verb it does not know -- a menu from a
 * newer build -- which the caller reads as "change nothing" rather than as an empty table.
 */
export function editTable(table, verb, cell) {
  const { row, column } = cell ?? {}
  switch (verb) {
    case 'insert-row-above':
      return insertRow(table, row)
    case 'insert-row-below':
      return insertRow(table, row + 1)
    case 'insert-column-left':
      return insertColumn(table, column)
    case 'insert-column-right':
      return insertColumn(table, column + 1)
    case 'delete-row':
      return removeRow(table, row)
    case 'delete-column':
      return removeColumn(table, column)
    /* Back to `auto`, which is the only way out of a row dragged shorter than its own text. */
    case 'fit-row':
      return resizeRow(table, row, null)
    default:
      return null
  }
}

export default function AppShell({
  workspace,
  onConnected,
  onSignOut,
  onLogOut,
  onRefreshSession,
  signInNotice,
}) {
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

  /* Keep the session alive while there is work that would be lost with it. Here rather
     than in a pane because the question it asks is about the whole app -- any tab holding
     unsaved work is reason enough -- and two panes running their own interval would ping
     twice as often for no extra safety. See auth/useSessionKeepAlive.js. */
  useSessionKeepAlive({ dirty: dirtyIds.size > 0, onLost: onRefreshSession })

  /*
   * Where the shared chrome lands.
   *
   * The header, the document bar, the palette and the inspector are all rendered *by a pane* -- they
   * read that pane's graph, its document, its selection -- but they must not be *inside* it. Two of
   * each is the problem this exists to fix: on a 1600px screen a palette and an inspector per pane is
   * 1280px of furniture and 320px of diagram, which made the side-by-side view technically working
   * and practically useless.
   *
   * They move by portal rather than by hoisting the state they need. Hoisting would mean the focused
   * pane publishing its graph upward on every drag frame, a parent re-render behind it, and both
   * panes re-rendering underneath that -- so the fix for a layout problem would have cost the frame
   * rate. A portal moves only the DOM: the React tree, the hooks and the context all stay exactly
   * where they were, and nothing above re-renders when a node moves.
   *
   * State rather than refs, because a ref is populated during commit and the portal has to exist on
   * the render *after* the container does. A callback ref into state is the standard way to have the
   * child re-render once its target is available.
   */
  const [topSlot, setTopSlot] = useState(null)
  const [leftSlot, setLeftSlot] = useState(null)
  const [rightSlot, setRightSlot] = useState(null)
  const slots = useMemo(
    () => ({ top: topSlot, left: leftSlot, right: rightSlot }),
    [topSlot, leftSlot, rightSlot],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `display: contents` on every slot, so the portalled element becomes a flex child of *this*
          row rather than of a wrapper with opinions of its own. It is what lets the header and the
          document bar keep being two siblings in a column, and the two asides keep their own widths,
          without any of those classes moving out of the component that owns them. */}
      <div ref={setTopSlot} style={{ display: 'contents' }} />

      <div className="relative flex min-h-0 flex-1">
        <div ref={setLeftSlot} style={{ display: 'contents' }} />

        <SplitView orientation={tabs.orientation}>
        {tabs.visible.map((tab, index) => (
          <ReactFlowProvider key={tab.id}>
            <Workbench
              workspace={workspace}
              onConnected={onConnected}
              onSignOut={onSignOut}
              onLogOut={onLogOut}
              onRefreshSession={onRefreshSession}
              /* Only the focused pane announces it, or a split view would raise the same
                 toast twice. */
              signInNotice={index === focused ? signInNotice : null}
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
              slots={slots}
              /* Only one pane draws the shared chrome, and it is the one you last clicked in. The
                 other renders its canvas and nothing else -- which is what makes a comparison view
                 two diagrams rather than two applications. */
              chromeOwner={index === focused}
            />
          </ReactFlowProvider>
        ))}
        </SplitView>

        <div ref={setRightSlot} style={{ display: 'contents' }} />
      </div>
    </div>
  )
}

/**
 * Where one piece of shared chrome should be drawn: `inline`, `portal`, or `none`.
 *
 * Extracted and exported because it is the logic that decides whether the user sees an inspector at
 * all, and getting it wrong is invisible in a test that cannot render -- `none` when it should be
 * `portal` is a workbench with no sidebars and no error anywhere.
 *
 * Three cases, in the order they are decided:
 *
 *   - Not the chrome owner: `none`. The other pane in a split renders its canvas and nothing else.
 *   - No slots supplied: `inline`. Anything mounting a `Workbench` on its own -- a test, a future
 *     embed -- gets the whole workbench in one box exactly as it did before slots existed.
 *   - Slots supplied but this one not yet mounted: `none`, for the one frame between AppShell's
 *     first render and its callback refs landing. Rendering inline for that frame instead would put
 *     the palette inside the pane and then move it, which is a visible jump.
 */
export function chromePlacement({ chromeOwner, slots, slot }) {
  if (!chromeOwner) return 'none'
  if (!slots) return 'inline'
  return slot ? 'portal' : 'none'
}

function Workbench({
  workspace,
  onConnected,
  onSignOut,
  onLogOut,
  onRefreshSession,
  signInNotice = null,
  topology,
  topologyError,
  tab = null,
  onCaptureTab,
  onFocusPane,
  onDirtyChange,
  tabStrip = null,
  slots = null,
  chromeOwner = true,
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
  const { deleteElements, fitView, getNodes, getViewport, screenToFlowPosition, setViewport } =
    useReactFlow()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  /*
   * Whether the inspector is widened for the Code tab.
   *
   * Here rather than in the tab because it is a fact about the *layout*: the aside's width is
   * this pane's to set, and a tab that could resize its own container would be reaching across
   * the boundary the workbench exists to hold. The Code tab asks, and narrows again when it
   * unmounts, so switching component or tab always gives the canvas its width back.
   */
  const [inspectorWide, setInspectorWide] = useState(false)
  /* From context rather than props: the account is read by the header here and, later, by
     anything that needs to explain why saving is or is not durable. Drilling it would mean
     threading it through Workbench alongside `workspace`, which is the pattern the four
     canvas contexts exist to avoid. */
  const sessionState = useSession()
  /* The file input backing "Import" everywhere it appears (DiagramBar, the Open
     dialog, the empty-canvas overlay) -- one hidden element, clicked by ref, rather
     than one per button. */
  const importInputRef = useRef(null)
  /*
   * The feedback form, and whether this deployment has one.
   *
   * Asked once, on mount. An unconfigured Airtable is a supported state -- someone running this locally
   * has no token -- and the honest response is not to draw the button at all rather than to offer a form
   * whose submit fails. `null` means "have not asked yet", which is distinct from `{available: false}`.
   */
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackConfig, setFeedbackConfig] = useState(null)

  useEffect(() => {
    let cancelled = false
    feedbackApi
      .config()
      .then((result) => !cancelled && setFeedbackConfig(result))
      /* Swallowed: a missing feedback endpoint is not something to interrupt anyone about, and the
         button simply does not appear. */
      .catch(() => !cancelled && setFeedbackConfig({ available: false }))
    return () => {
      cancelled = true
    }
  }, [])
  /* Announce the outcome of a sign-in once the toasts exist to carry it.
     App.jsx reads it off the URL and strips it there, so this only has to show it -- and
     only the focused pane is handed one, so a split view does not say it twice. */
  useEffect(() => {
    if (signInNotice) notify(signInNotice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInNotice])

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
  /*
   * Which path's editor is open. Not part of the document, like `selectedPaths`.
   *
   * At app level rather than inside the drawer because `addScenario` has to open it, and a path
   * can be created from the toolbar as well as from the drawer's own button -- a new path has no
   * start and cannot run until it is given one, so the editor has to appear either way.
   */
  const [editingPathId, setEditingPathId] = useState(null)

  /* Which groups are folded, for the same reason `scenarios` is here and
     `selectedPaths` is not: it is the reader's account of the architecture rather
     than a transient selection, so it belongs to the document and survives a save. */
  const [collapsed, setCollapsed] = useState([])

  /* --- the command layer --------------------------------------------------- */

  /* Where the right-click landed and what it landed on, as Canvas reported it. */
  const [menu, setMenu] = useState(null)
  /*
   * Which flow direction the menu is currently offering, while the pointer is on its row.
   *
   * Here rather than inside the menu because the thing that has to react to it is the canvas:
   * choosing a direction may turn a connector round, and a menu row cannot show that. So the
   * connectors concerned animate the way they *would* run before anything is committed. Cleared
   * by the menu on the way out, including when it is dismissed mid-hover.
   */
  const [flowPreview, setFlowPreview] = useState(null)
  const [nuancesFor, setNuancesFor] = useState(null)

  /* Mirrored into state from sessionStorage rather than read on every keystroke, so a
     clip put there before a reload -- or by the diagram open in another workbench tab --
     is what enables Paste in the menu. */
  const [clipboard, setClipboard] = useState(() => readClipboard())

  /* The last pointer position, in client coordinates, held in a ref because it changes on
     every mouse move and none of those are renders anyone needs. It is what makes a
     keyboard cmd-v land where the user is looking rather than on top of the original. */
  const pointer = useRef(null)

  /* The element the canvas fills. Measured, not stored: "what is on screen" needs the pane's size in
     pixels, and React Flow's transform only supplies the offset and the zoom. */
  const paneRef = useRef(null)

  /* One string, or null when the affordance is available. Every workspace-only
     control reads this, so a disconnected visitor is told why the button is dead
     instead of finding out from a 403. */
  /*
   * One sentence, or null when the affordance is available.
   *
   * Only the no-workspace case now. It used to also refuse a session connected with an app
   * `auth_token`, on the grounds that such a credential could identify a workspace but not read it --
   * which was true until `build_graph_via_graphql` existed and is not any more. A GraphQL session
   * reads the Connections spine, and what it *cannot* read comes back in the graph's own `warnings`
   * and is surfaced verbatim by `loadWorkspace`.
   *
   * That is the right channel for it: a gap in a result that arrived is a caveat about the result,
   * where this string is a reason a control does not work at all. Keeping the credential caveat here
   * would leave the button disabled and the partial read unreachable.
   */
  const workspaceReason = workspace
    ? null
    : 'Connect a workspace with a Segment Public API token to read its components.'

  /* The *id*, not the node. The inspector edits node data, so holding the object
     captured at selection time would show stale values right after an edit. Edges are
     checked too, now that a connector has its own styling to inspect -- nodes first,
     since an id collision between the two arrays cannot happen (React Flow's own
     namespacing keeps them apart) but nodes are what almost every selection is. */
  const [inspectedId, setInspectedId] = useState(null)
  const inspected = useMemo(
    () =>
      graphState.nodes.find((node) => node.id === inspectedId) ??
      graphState.edges.find((edge) => edge.id === inspectedId) ??
      null,
    [graphState.nodes, graphState.edges, inspectedId],
  )

  const { setNodes } = graphState

  const updateNode = useCallback(
    (id, patch) => {
      setNodes((current) => {
        const before = current.find((node) => node.id === id)
        const next = current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
        )

        /*
         * Moving a divider takes each section's contents with it.
         *
         * Here rather than in `FrameNode` because a node renderer must not write other nodes -- the
         * divider knows where its line has gone, and what that means for what is inside it belongs
         * to whoever owns the document. And here rather than in the drag handler specifically, so
         * that *any* write of `frame` moves the contents: the drag, an undo, and whatever sets a
         * split next all behave the same way.
         *
         * The box does not change, only the splits, so the same size is passed both sides -- see
         * `shiftSections` in canvas/frames.js, and the resize branch in Canvas.jsx for the other
         * gesture that moves a section's origin.
         */
        if (patch.frame && before?.data?.frame) {
          const box = zoneSize(before)
          return shiftSections(
            next,
            id,
            { frame: before.data.frame, ...box },
            { frame: patch.frame, ...box },
          )
        }
        return next
      })
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
    (key, options) => {
      setNodes((current) => applyPaletteToNodes(current, key, options))
      /* Names what it did rather than only which palette: with the channel toggles the same click can
         mean "recolour everything" or "recolour the borders", and a toast that said the same thing
         either way would leave the user checking the canvas to find out which. */
      const channels = options?.channels ?? CHANNELS.map((channel) => channel.key)
      const scope =
        channels.length === CHANNELS.length
          ? ''
          : ` to the ${CHANNELS.filter((channel) => channels.includes(channel.key))
              .map((channel) => channel.label.toLowerCase())
              .join(' and ')}`
      notify({
        tone: 'success',
        message: `Applied the ${paletteByKey(key)?.name ?? key} palette${scope}${
          options?.includeShapes ? ', shapes included' : ''
        }.`,
      })
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

  /*
   * How long the event should take to cross each connector, so it moves at one speed everywhere.
   *
   * This is the only layer that can answer it: the trace knows the route and the edge renderer knows
   * how to draw one, but neither knows how far apart two components are on screen. Both the transport
   * (which sizes the beat) and FlowEdge (which sizes the dot's travel) read this same map, so they
   * cannot disagree about when the event arrives.
   *
   * Distance is centre to centre. The drawn route is a little longer wherever it bends, so a heavily
   * bent connector is crossed slightly faster than a straight one of the same span -- measuring the
   * rendered path instead would mean resolving every hand-placed border anchor and measured card size
   * out here, and the error is a few percent of a one-second beat.
   *
   * Clamped at both ends. Two cards nearly touching should not produce a flicker too short to see,
   * and one at the far end of a large diagram should not hold the walkthrough for six seconds -- past
   * a few seconds the reader has stopped believing it is still running.
   */
  const hopDurations = useMemo(() => {
    const centres = new Map(
      simGraph.nodes
        .filter((node) => node.type !== 'zone')
        .map((node) => [node.id, centreOf(node, simGraph.nodes)]),
    )
    const map = new Map()
    for (const edge of simGraph.edges) {
      const from = centres.get(edge.source)
      const to = centres.get(edge.target)
      if (!from || !to) continue
      const span = Math.hypot(to.x - from.x, to.y - from.y)
      map.set(edge.id, Math.round(Math.min(2600, Math.max(450, (span / HOP_SPEED_PX_PER_S) * 1000))))
    }
    return map
    /* `simGraph`, not `currentGraph`, for the same reason the runs are keyed that way: playing a
       walkthrough rewrites `data.paths` on every node twice a second, so `currentGraph` gets a new
       identity on every beat even though not one position has moved. Keyed there, this Map -- and with
       it the beat table, every path's choreography and the transport's own timing table -- was being
       rebuilt mid-animation twice a second, which is exactly the kind of churn that makes a moving
       thing stutter. `simGraph` changes when the architecture does. */
  }, [simGraph])

  /*
   * The run for the path being edited, computed whether or not it is selected for playback.
   *
   * The editor needs a trace of its own: the timeline of components it offers to include or leave
   * out *is* the route, and the toggles below it are meant to name only what this path passes.
   * Deriving those from `runs` would empty them the moment the reader deselected the path they had
   * open, and would make the editor's contents depend on the transport.
   *
   * Costs one extra `simulate` while an editor is open, keyed on the same fingerprint as the rest,
   * so it does not re-run on playback ticks.
   */
  const editingRun = useMemo(() => {
    const scenario = scenarios.find((entry) => entry.id === editingPathId)
    if (!scenario) return null
    return runScenarios(simGraph, runnable(simGraph, [scenario]))[0] ?? null
  }, [simGraph, scenarios, editingPathId])
  const playbackTotal = useMemo(() => playbackLength(runs, playMode), [runs, playMode])
  /* Memoised because `usePlayback` rebuilds its timing table on a new array identity, and this feeds
     the running animation. */
  const beatDurations = useMemo(
    () => tickDurations(runs, playMode, { hopMs: hopDurations }),
    [runs, playMode, hopDurations],
  )
  const playback = usePlayback(playbackTotal, { durations: beatDurations })
  const frame = useMemo(
    () => combinedFrameAt(runs, playback.tick, { mode: playMode }),
    [runs, playback.tick, playMode],
  )

  /*
   * The event's itinerary, per path: where it is at any millisecond rather than on any beat.
   *
   * Built from the *same* `beatDurations` the transport schedules against, which is the whole point
   * -- the token has to reach a component on the beat that component lights up, and two tables
   * computed separately from the same inputs are two tables that can drift. See
   * simulation/choreography.js.
   *
   * Both play modes, which is why the cursor is here. Played together, every run shares the beat
   * table and starts at zero. Played in sequence they are laid end to end, so `tickDurations` returns
   * the runs' beats concatenated and each run's own slice begins after the ones before it -- the same
   * arithmetic `indicesAt` does in beats, done here in milliseconds.
   */
  const eventPlans = useMemo(() => {
    const sequential = playMode === PLAY_MODES.sequence
    let beat = 0
    let offset = 0
    return runs.map((run) => {
      const beats = run.trace?.phases?.length ?? 0
      const durations = sequential ? beatDurations.slice(beat, beat + beats) : beatDurations
      const plan = {
        scenarioId: run.scenario.id,
        color: run.scenario.color,
        legs: choreograph(run.trace, { durations, hopMs: hopDurations, offset }),
      }
      if (sequential) {
        beat += beats
        offset += durations.reduce((total, span) => total + span, 0)
      }
      return plan
    })
  }, [runs, playMode, beatDurations, hopDurations])

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
    setNodes((current) => applyPathsToNodes(current, liveFrame))
    setEdges((current) => applyPathsToEdges(current, liveFrame))
  }, [liveFrame, setNodes, setEdges])

  /*
   * What part of the diagram is on screen, in flow coordinates.
   *
   * For the notes lane, which shows the note of every component in view when nothing is playing. Held
   * in state rather than read during render because it is not derivable from anything React knows
   * about: it comes out of React Flow's own transform, which changes on a pan or a zoom and not on a
   * render.
   *
   * Throttled, and settled on the end of the gesture. A pan emits a frame at a time and the lane
   * renders cards, so following every frame would be sixty list rebuilds a second to change which
   * twenty cards are in it. A quarter of a second behind is imperceptible for this; being a frame
   * behind at the end of the gesture would not be, hence `onEnd` as well.
   */
  const [visibleRect, setVisibleRect] = useState(null)
  const readRect = useCallback(() => {
    const pane = paneRef.current
    const { x, y, zoom } = getViewport()
    if (!pane || !zoom) return
    const { width, height } = pane.getBoundingClientRect()
    setVisibleRect({ x: -x / zoom, y: -y / zoom, width: width / zoom, height: height / zoom })
  }, [getViewport])

  const rectTimer = useRef(0)
  useOnViewportChange({
    onChange: useCallback(() => {
      if (rectTimer.current) return
      rectTimer.current = window.setTimeout(() => {
        rectTimer.current = 0
        readRect()
      }, 240)
    }, [readRect]),
    onEnd: readRect,
  })

  /* Once on mount, and again whenever the canvas is replaced: opening a diagram fits the view, which
     is a transform change React Flow does not report as a user gesture. */
  useEffect(() => {
    const id = window.setTimeout(readRect, 0)
    return () => window.clearTimeout(id)
  }, [readRect, graphState.status, docs.current.id])

  /*
   * Which component's note is lit, shared between the canvas and the lane.
   *
   * Owned here rather than inside `Canvas` because both ends of the highlight need it and the lane
   * sits outside the canvas's own context. Outside React by design -- see canvas/anchors.js: a hovered
   * id in state would put a whole-canvas render on every mouse move across a 300-component diagram.
   */
  const anchorFocus = useMemo(() => createAnchorFocus(), [])
  const [notesCollapsed, setNotesCollapsed] = useState(false)

  /*
   * The notes for the lane above the diagram.
   *
   * Derived rather than accumulated, so scrubbing backwards shortens the lane instead of leaving cards
   * behind for components the event has not reached yet, and panning changes it with no state to
   * invalidate. See simulation/notes.js.
   */
  const laneNotes = useMemo(
    () =>
      liveFrame
        ? notesSoFar(liveFrame.runs, simGraph, { topology })
        : /* Nothing playing, so the lane is the diagram's documentation instead: the note of every
             component on screen. `view.nodes` and not the document's, because a collapsed group is one
             card standing for many and its members are not on screen to be annotated. */
          notesInView(view.nodes, visibleRect, { topology }),
    [liveFrame, simGraph, topology, view.nodes, visibleRect],
  )

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
      /* And its editor opened, wherever it was created from. A new path has no start yet and
         cannot run without one (see `runnable`), so landing on the canvas with nothing to fill in
         would leave a path button that lights up and plays nothing. */
      setEditingPathId(created.id)
      return created
    },
    [scenarios],
  )

  /*
   * A copy of an existing path, opened for editing.
   *
   * Comparing two scenarios that differ by one switch is what several paths are *for*, and the second
   * one was previously only reachable by building it again from scratch -- picking the same start,
   * retyping the same event, re-excluding the same components.
   *
   * Everything that describes the run is carried over: the event, the start, what is switched off,
   * what is left out, and the order its forks are taken in. What is not carried over is the identity --
   * a new id, the next unused colour, and a name saying what it is. The colour matters more than it
   * looks: two paths in the same colour cannot be told apart on the canvas, which is the one thing
   * playing them together is supposed to let you do.
   *
   * Then exactly what `addScenario` does -- selected and opened. A duplicate exists in order to be
   * changed, so leaving the reader to go and find it would be a second click nobody wants.
   */
  const duplicateScenario = useCallback(
    (id) => {
      const source = scenarios.find((entry) => entry.id === id)
      if (!source) return null

      const copy = {
        ...source,
        id: `path:${crypto.randomUUID().slice(0, 8)}`,
        name: `${source.name} copy`,
        color: nextColor(scenarios),
        /* Cloned, not shared. These are arrays and an object on a saved document, and handing the copy
           the same references would have editing one path silently edit the other. */
        disabled: [...(source.disabled ?? [])],
        excluded: [...(source.excluded ?? [])],
        revisit: [...(source.revisit ?? [])],
        fallback: { ...(source.fallback ?? {}) },
        branches: Object.fromEntries(
          Object.entries(source.branches ?? {}).map(([fork, arms]) => [fork, [...arms]]),
        ),
        event: source.event ? structuredClone(source.event) : null,
      }

      setScenarios((current) => [...current, copy])
      setSelectedPaths((current) => [...current, copy.id])
      setEditingPathId(copy.id)
      return copy
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

  /*
   * The pasteable report, built when the button is clicked rather than on every render.
   *
   * Reports on the paths being played, or on the one being edited when nothing is selected -- which
   * is the case that matters most, since a path that will not run is exactly what somebody needs to
   * send to somebody else, and a path that will not run is not in `runs`.
   *
   * An unrunnable path still gets a report: `pathReport` takes a null trace and leads with why
   * there is no route, which is the whole point of it existing.
   */
  const getDiagnostics = useCallback(() => {
    const played = runs.length > 0 ? runs : editingRun ? [editingRun] : []
    const entries =
      played.length > 0
        ? played.map((run) => ({ scenario: run.scenario, trace: run.trace }))
        : scenarios
            .filter((entry) => selectedPaths.includes(entry.id) || entry.id === editingPathId)
            .map((entry) => ({ scenario: entry, trace: null }))
    const text = pathsReport(entries, { graph: currentGraph, diagramName: docs.current.name })
    log.record({
      level: 'info',
      source: 'walkthrough',
      message: `Copied diagnostics for ${entries.length} path${entries.length === 1 ? '' : 's'}.`,
    })
    return text
  }, [runs, editingRun, scenarios, selectedPaths, editingPathId, currentGraph, docs, log])

  const updateScenario = useCallback((id, patch) => {
    setScenarios((current) =>
      current.map((scenario) => (scenario.id === id ? { ...scenario, ...patch } : scenario)),
    )
  }, [])

  const removeScenario = useCallback((id) => {
    setScenarios((current) => current.filter((scenario) => scenario.id !== id))
    setSelectedPaths((current) => current.filter((entry) => entry !== id))
    /* Or the editor stays open on a path that no longer exists and renders nothing. */
    setEditingPathId((current) => (current === id ? null : current))
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

  /*
   * Report the *document* up as it changes, rather than only on the way out.
   *
   * The graph is captured on unmount because serializing three hundred nodes on every drag frame
   * would cost the frame rate. A document is four short strings, so there is no reason to wait -- and
   * waiting was a bug with two faces. The tab strip renders `tab.doc.name`, so a rename committed in
   * a chip updated the pane and left the chip showing the old name, which read as the rename having
   * silently failed. And anything that reads a mounted tab's record -- `forkTab`, or a remount --
   * saw a document from whenever the tab was opened, so it could revert a name that had been changed
   * many minutes earlier.
   *
   * Cheap in practice: `docs.current` is a new object only when something about the document actually
   * changes, and while tabs are in use the per-keystroke name field is not rendered at all -- the
   * chip commits once, on Enter or blur.
   */
  /* `tab.id`, not `tab`: storing the document replaces the tab *object*, so depending on the
     object would re-run this on its own result -- which is a render loop, and was one. */
  useEffect(() => {
    if (!tab) return
    onCaptureTab?.(tab.id, { doc: docs.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, docs.current, onCaptureTab])

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

  const triggerImport = () => importInputRef.current?.click()

  /* The backup path for a diagram whose workspace scope became unreachable -- an
     anonymous session's cookie lost across a restart, with no other way back to it.
     Reads exactly the file `exportDiagramFile` writes, and rebuilds through the same
     `applyGraph` every other "load a diagram" path uses, so the result is byte-for-byte
     what `roundTrip.test.js` already proves that function does. */
  const importDiagramFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = parseDiagramFile(await file.text())
      docs.importGraph(parsed)
      const layout = applyGraph(parsed.graph)
      setDialogOpen(false)
      const unbound = countPlaceholders(layout.nodes)
      notify({
        tone: unbound ? 'info' : 'success',
        message: unbound
          ? `Imported “${parsed.name || 'Untitled architecture'}”. ${unbound} placeholder${unbound === 1 ? '' : 's'} to bind — not saved yet.`
          : `Imported “${parsed.name || 'Untitled architecture'}”. Not saved yet — click Save to keep it.`,
      })
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
  }

  const exportDiagramFile = () => {
    try {
      downloadDiagramFile(docs.current, saveGraph())
      notify({ tone: 'success', message: `Exported “${docs.current.name}” as a diagram file.` })
    } catch (err) {
      notify({ tone: 'error', message: err.message })
    }
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

  /*
   * A save that survives its session having expired.
   *
   * The plain path is the first four lines and is what runs every time. The rest is the
   * recovery, and it exists because the failure it handles is both common and total: a tab
   * left open overnight has no session by morning, and until this was here the only symptom
   * was a toast repeating DRF's "Authentication credentials were not provided" -- with no
   * way forward, since every retry reached the same deleted row.
   *
   * See auth/recover.js for why the recovery is "get a session, retry, then copy", and why
   * the copy is announced rather than made quietly.
   */
  const save = async () => {
    const graph = saveGraph()
    try {
      const result = await docs.save(graph)
      notify({ tone: 'success', message: `Saved “${result.name}”.` })
      logAdvisories(result)
    } catch (err) {
      if (!isSessionLoss(err)) return notify({ tone: 'error', message: err.message })
      await recoverSave(graph)
    }
  }

  const saveAs = async (name) => {
    const graph = saveGraph()
    try {
      const result = await docs.saveAs(name, graph)
      notify({ tone: 'success', message: `Saved a copy as “${result.name}”.` })
      logAdvisories(result)
    } catch (err) {
      if (!isSessionLoss(err)) return notify({ tone: 'error', message: err.message })
      /* Already a create, so there is nothing to retry differently -- `recoverSave` reads
         that off the document's own id and goes straight to the copy. */
      await recoverSave(graph, { name })
    }
  }

  const recoverSave = async (graph, { name } = {}) => {
    if (!(await reviveSession())) {
      return notify({
        tone: 'error',
        message: lastResortMessage('The server could not be reached to sign back in.'),
      })
    }
    /* Before either attempt: the session that exists now may be a different one, and the
       header must stop naming an account this browser no longer holds. */
    onRefreshSession?.()

    const hadId = Boolean(docs.current.id)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const step = recoveryStep({ hadId, attempt })
      if (step === 'give-up') break
      try {
        const result =
          step === 'retry'
            ? await docs.save(graph)
            : await docs.saveAs(name ?? docs.current.name, graph)
        notify({
          tone: step === 'retry' ? 'success' : 'info',
          message: recoveryMessage({
            copied: step === 'copy',
            /* Read now rather than before the revive: whether an account is still in play
               is exactly what the refresh above may have changed. */
            signedIn: Boolean(sessionState.account),
            name: result.name,
          }),
        })
        logAdvisories(result)
        return
      } catch (err) {
        /* Kept only to report if the *last* attempt fails. A failed retry is expected
           whenever the diagram belongs to an account and the new session is anonymous --
           `visible_to` does not include it -- and that is precisely the case the copy on
           the next pass is for. */
        if (recoveryStep({ hadId, attempt: attempt + 1 }) === 'give-up') {
          notify({ tone: 'error', message: lastResortMessage(err.message) })
        }
      }
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

  /*
   * Point connectors the other way. `null` means every connector on the diagram.
   *
   * One write for the whole set, so reversing a diagram drawn end-to-start is a single undo entry
   * rather than one per line -- which is the difference between a fix someone will try and one they
   * will not. Its own callback rather than only a member of `actions` because two commands reach for
   * it -- "Reverse direction" and "Add to path", which fixes a route by turning it round -- and a
   * second write path would be a second idea of when to snapshot history.
   *
   * The refusal is reported rather than silent. A connector read from the workspace cannot be
   * reversed (its direction is a fact, not a drawing decision), and a bulk reverse that quietly
   * skipped some would leave the reader believing the whole diagram had been turned round.
   */
  const reverseEdges = useCallback(
    (ids) =>
      setEdges((current) => {
        const { reverse, blocked } = reversible(current, ids)
        if (blocked.length > 0) {
          notify({
            tone: 'info',
            message: `${blocked.length} connector${blocked.length === 1 ? '' : 's'} came from your workspace, so ${blocked.length === 1 ? 'its' : 'their'} direction is a fact rather than a choice — left alone.`,
          })
        }
        if (reverse.length === 0) return current
        const flipping = new Set(reverse)
        return current.map((edge) => (flipping.has(edge.id) ? reverseEdge(edge) : edge))
      }),
    [setEdges, notify],
  )

  const actions = useMemo(
    () => ({
      inspect: (node) => setInspectedId(node?.id ?? null),
      arrange: (ids, move) => transformNodes((current) => arrangeNodes(current, ids, move)),
      align: (ids, alignment) => transformNodes((current) => alignNodes(current, ids, alignment)),
      distribute: (ids, axis) => transformNodes((current) => distributeNodes(current, ids, axis)),
      /* Runs over the whole diagram rather than `ids` -- the command has no selection to
         hand back, on purpose, since "tidy this up" is not a per-selection request. */
      autoAlign: () => transformNodes((current) => autoAlignNodes(current)),
      lock: (ids, locked) => transformNodes((current) => setLocked(current, ids, locked)),
      /* The id is minted here rather than in `groupNodes`, which stays pure so the grouping
         rules are testable without a canvas. */
      group: (ids) =>
        transformNodes((current) =>
          groupNodes(current, ids, `${GROUP_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`),
        ),
      ungroup: (ids) => transformNodes((current) => ungroupNodes(current, ids)),
      /*
       * One edit to a table's grid, named by the menu and carried out here.
       *
       * The verb is mapped to a function from canvas/tables.js rather than the menu calling one
       * directly, which keeps the command table free of the table model -- and means this is the
       * one place that knows a row inserted "below" is `insertRow(row + 1)`.
       *
       * `name` is rewritten with every edit because a table's name is derived from its contents
       * (`tableText`): it is what the console, search and the save advisories call this node, and
       * a name left behind after a row was deleted would name a row that is gone.
       */
      tableEdit: (nodeId, verb, cell) =>
        setNodes((current) =>
          current.map((node) => {
            if (node.id !== nodeId || !node.data?.table) return node
            const next = editTable(node.data.table, verb, cell)
            if (!next) return node
            return { ...node, data: { ...node.data, table: next, name: tableText(next) || 'Table' } }
          }),
        ),
      /* The connector actions. Both write into `edge.data`, where `serializeEdge` reads them, and
         both go through the same `setEdges` the waypoint drag does -- one write path for the
         route, whether it was edited by dragging a handle or by picking a menu item. */
      lineStyle: (edgeId, line) =>
        setEdges((current) =>
          current.map((edge) =>
            edge.id === edgeId ? { ...edge, data: { ...edge.data, line } } : edge,
          ),
        ),
      /* The Edge Style tab's write path -- colour, dash pattern, either arrow. One merge
         rather than one setter per field, since the tab patches whichever of the four the
         user just touched and the other three have to survive it untouched. */
      edgeStyle: (edgeId, patch) =>
        setEdges((current) =>
          current.map((edge) =>
            edge.id === edgeId ? { ...edge, data: { ...edge.data, ...patch } } : edge,
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
      /* Defined above, because "Add to path" reaches for it too. */
      reverseEdges,
      /*
       * Make data run a given way across the diagram. `ids` of `null` means every connector.
       *
       * Stated absolutely rather than relatively, which is what makes it safe in bulk: only the
       * connectors running against `direction` are touched, so the ones already correct are left
       * alone and running it twice changes nothing the second time.
       *
       * Positions come from `getNodes()` rather than the render's `nodes`, so this does not have
       * to be rebuilt on every node change to avoid capturing a stale array -- and centres are
       * computed with `centreOf`, the same measure FlowEdge's hover preview uses, so what the
       * preview animated is what this commits.
       */
      flowAlong: (ids, direction) => {
        const live = getNodes()
        const centres = new Map(
          live
            .filter((node) => node.type !== 'zone')
            .map((node) => [node.id, centreOf(node, live)]),
        )
        setEdges((current) => {
          const { reverse, blocked } = orientAlong(current, centres, direction, ids)
          if (blocked.length > 0) {
            notify({
              tone: 'info',
              message: `${blocked.length} connector${blocked.length === 1 ? '' : 's'} came from your workspace, so ${blocked.length === 1 ? 'its' : 'their'} direction is a fact rather than a choice — left alone.`,
            })
          }
          if (reverse.length === 0) {
            /* Said rather than passed over in silence. A menu item that appears to do nothing
               is indistinguishable from one that is broken, and "they already flow that way"
               is the useful half of the answer. */
            notify({
              tone: 'info',
              message: 'Every connector already flows that way — nothing to change.',
            })
            return current
          }
          const flipping = new Set(reverse)
          return current.map((edge) => (flipping.has(edge.id) ? reverseEdge(edge) : edge))
        })
      },
      /*
       * Get a component or a connector onto a path.
       *
       * "Add to path" cannot mean "append to a list". A path is *walked* -- from its start, along
       * the arrows -- so a component nothing points at has no way for the event to arrive, and a
       * list naming it would change nothing. There are exactly two reasons something is off a path,
       * and this tells them apart and says which one it found:
       *
       *   - The path was told to leave it out. Undone by clearing one field, and scoped to this
       *     path alone.
       *   - Nothing reaches it, because the connectors in between point the wrong way. Fixed by
       *     turning those round -- which changes the *diagram*, not the path, and the message says
       *     so. A backwards connector is wrong for every path, and quietly "fixing this path" while
       *     altering what the diagram claims would be the more surprising of the two.
       *
       * And one case that is neither: nothing connects them at all, which needs a connector drawn
       * and cannot be solved from here. Reported rather than passed over, because a menu item that
       * appears to do nothing is indistinguishable from one that is broken.
       */
      includeInPath: (pathId, { nodeId, edgeId }) => {
        const scenario = scenarios.find((entry) => entry.id === pathId)
        if (!scenario) return

        const edge = edgeId ? currentGraph.edges.find((entry) => entry.id === edgeId) : null
        /* A connector is asked about via the component it feeds: getting the event *to* its target
           is what puts the line on the path, and it is the same question one hop further on. */
        const targetId = nodeId ?? edge?.target ?? null
        if (!targetId) return

        const name = (id) =>
          currentGraph.nodes.find((entry) => entry.id === id)?.name ?? 'that component'

        if ((scenario.excluded ?? []).includes(targetId)) {
          updateScenario(pathId, {
            excluded: scenario.excluded.filter((id) => id !== targetId),
          })
          notify({
            tone: 'success',
            message: `“${name(targetId)}” is back on ${scenario.name}. The event acts on it again rather than stepping over it.`,
          })
          return
        }

        const trace = runScenarios(simGraph, [scenario])[0]?.trace
        const visited = trace?.visited ?? {}
        /*
         * Where the event actually *got to*, not everything the trace mentions.
         *
         * `visited` also holds one hop past each dead end -- recorded so the diagram can say why the
         * event never arrived -- so treating its keys as "on the path" would report an unreachable
         * component as already included and do nothing, which is the single most misleading answer
         * available here.
         */
        const reached = Object.keys(visited).filter((id) => hasArrived(visited[id].status))
        if (reached.includes(targetId)) {
          notify({
            tone: 'info',
            message: `“${name(targetId)}” is already on ${scenario.name} — the event reaches it as the diagram stands.`,
          })
          return
        }

        const { found, from, reverse, blocked } = routeToReach(
          currentGraph.edges,
          reached,
          targetId,
        )
        if (!found) {
          notify({
            tone: 'info',
            message: `Nothing on ${scenario.name} connects to “${name(targetId)}”, so there is no route for the event to take. Draw a connector to it first.`,
          })
          return
        }

        /*
         * The event reaches the far end of the path and stops there.
         *
         * A destination delivers and goes no further; a filter can drop; a switched-off component
         * halts. Turning connectors round past that point would change the diagram and leave the
         * path ending exactly where it did, so this reports the real obstacle instead -- and quotes
         * the reducer's own sentence, which is the one that knows why.
         */
        const stopsAt = visited[from]
        if (stopsAt && !stopsAt.propagate) {
          notify({
            tone: 'info',
            message: `${scenario.name} stops at “${name(from)}”, so nothing past it is reached — including “${name(targetId)}”. ${stopsAt.reason}`,
          })
          return
        }

        if (reverse.length === 0) {
          notify({
            tone: 'info',
            message: blocked.length
              ? `The route to “${name(targetId)}” runs through a connection read from your workspace, so its direction is a fact rather than a choice and cannot be turned round.`
              : `“${name(targetId)}” is already connected the right way round. Check whether something on the way to it is switched off for ${scenario.name}.`,
          })
          return
        }

        reverseEdges(reverse)
        notify({
          tone: 'success',
          message: `Turned ${reverse.length} connector${reverse.length === 1 ? '' : 's'} round so the event reaches “${name(targetId)}”. That corrects the diagram, not just ${scenario.name} — ${reverse.length === 1 ? 'it was' : 'they were'} pointing back upstream.`,
        })
      },
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
      notify,
      getNodes,
      reverseEdges,
      /* `includeInPath` reads the paths and the document to work out *why* something is off a
         path, and re-simulates the one path it was asked about. */
      scenarios,
      currentGraph,
      simGraph,
      updateScenario,
    ],
  )

  const commandContext = useMemo(
    () => ({
      nodes,
      /* For "Reverse every connector", which has to know whether there are any. A count
         would do, but the whole array costs nothing here and keeps the context a plain view
         of the canvas rather than a bag of pre-computed answers. */
      edges,
      /* The saved paths, so "Add to path" can name them. The rows are the user's own paths, which
         is the one thing about that submenu that cannot be written into the command table. */
      scenarios,
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
    [
      nodes,
      edges,
      scenarios,
      selection,
      clipboard,
      history.canUndo,
      history.canRedo,
      docs.busy,
      actions,
    ],
  )

  /* The right-click menu's context is the same one, plus what was clicked. The keyboard
     has no subject, which is what makes its commands read the selection instead. */
  const menuContext = menu
    ? {
        ...commandContext,
        node: menu.node,
        stack: menu.stack,
        /* Which table cell was right-clicked, if it was one. The Table submenu is hidden without
           it, because a table is one node and selecting it says nothing about which of its cells
           an "insert row" is meant to be about. */
        cell: menu.cell ?? null,
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
    enabled: !dialogOpen && !connectOpen && !nuancesFor && !feedbackOpen,
  })

  /*
   * The shared chrome, moved to app level by portal -- or rendered in place when there are no slots.
   *
   * Two callers with different needs, and one function so they cannot diverge: `AppShell` supplies
   * slots and exactly one pane owns them, while anything mounting a `Workbench` on its own (a test,
   * a future embed) supplies none and gets the whole workbench in one box as before.
   *
   * A non-owning pane renders `null` for all of it. Not `visibility: hidden` and not a second copy
   * portalled somewhere else -- a second Inspector would mount a second copy of every per-kind
   * branch against the same node and race the first one's edits.
   */
  const chrome = (slot, content) => {
    switch (chromePlacement({ chromeOwner, slots, slot })) {
      case 'inline':
        return content
      case 'portal':
        return createPortal(content, slot)
      default:
        return null
    }
  }

  return (
    /* `onPointerDownCapture` rather than a click handler: it has to fire before the canvas handles
       the gesture, because "which pane am I working in" has to be settled before whatever that
       gesture does. Capture phase also means it fires for a drag that never becomes a click. */
    <div className="flex h-full min-h-0 flex-col" onPointerDownCapture={onFocusPane}>
      {chrome(
        slots?.top,
        <>
        <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 bg-white px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold text-twilio-navy">
              Segment Archistrator
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

            {/* Reporting a problem.
                Icon-only: it has to be reachable from anywhere without competing with the two
                controls beside it, which are what someone actually came to the header for.
                Hidden entirely when the server has no Airtable credentials, matching how the
                endpoint reports itself -- an unconfigured form is a supported state, and a
                button whose submit could only fail is worse than no button. */}
            {feedbackConfig?.available && (
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                title="Report a problem or suggest an improvement"
                aria-label="Report a problem or suggest an improvement"
                className="flex items-center rounded-md border border-twilio-gray-20 p-1.5 text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
              >
                <MessageSquarePlus size={14} aria-hidden="true" />
              </button>
            )}

            {/* The divider lives inside AccountMenu, not here: this renders nothing at all
                on a deployment with no Google client and nobody signed in, and a lone
                separator floating at the end of the header would be the giveaway. */}
            <AccountMenu
              state={sessionState}
              onInvite={() => setInviteOpen(true)}
              onLogOut={() => {
                /* Everything, not one workspace: logging out means the next person at this
                   browser is a different person, and the schema cache holds event and trait
                   names read with the outgoing account's credentials. */
                clearSchemaCache()
                onLogOut?.()
              }}
            />
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
          onExportFile={exportDiagramFile}
          onImportFile={triggerImport}
          onFocusPlaceholder={focusPlaceholder}
          onApplyPalette={applyPalette}
          onResetPalette={resetPalette}
        />
        {/* Backing every "Import" button (DiagramBar, the Open dialog, the empty-canvas
            overlay): one hidden input, opened via `triggerImport`, so a file picked
            anywhere in the app goes through the same `importDiagramFile`. */}
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={importDiagramFile}
        />
        </>,
      )}

      <div className="relative flex min-h-0 flex-1">
        {chrome(
          slots?.left,
          <>
          {/* A column, so the payload panel takes the height it needs and the palette scrolls in what
              is left. `min-h-0` on the palette wrapper is what allows that -- a flex child defaults to
              never shrinking below its content, and the palette's content is long. */}
          <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-twilio-gray-20 bg-white">
            {inspected?.data?.kind === 'profile' ? (
              /* The Palette is not useful while looking at a profile, and a profile has more to
                 show than the right-hand Inspector's 96px column has room for -- so selecting one
                 takes over this slot instead of sharing it. Reset by selection, for the same reason
                 the right Inspector resets on `inspected?.id`: one unrenderable paste should not
                 close the panel for the rest of the session. */
              <ErrorBoundary
                resetKey={inspected.id}
                title="This profile cannot be shown"
                hint="The canvas is unaffected. Select another component, or reopen this one."
              >
                <ProfilePreview
                  node={inspected}
                  nodes={graphState.nodes}
                  onUpdateNode={updateNode}
                  onClose={() => setInspectedId(null)}
                  onNotify={notify}
                />
              </ErrorBoundary>
            ) : (
              <>
                {/* Above the palette rather than below it: while an animation is playing this is what
                    the reader is following, and the palette is what they are not using. Renders
                    nothing at all when no walkthrough is mid-flight, so it costs an idle canvas no
                    space. */}
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
              </>
            )}
          </aside>
          </>,
        )}

        <main
          className="relative flex min-w-0 flex-1 flex-col bg-twilio-gray-10"
          /* Tracked here rather than on the flow pane so it keeps working over a node,
             and written to a ref so a mouse move is not a render. */
          onMouseMove={(event) => {
            pointer.current = { x: event.clientX, y: event.clientY }
          }}
        >
          {/*
            * The walkthrough's notes, above the diagram rather than on top of it.
            *
            * Real layout, not an overlay: these used to be pinned to the components they described
            * and covered the ones either side, so the panel explaining a step hid the step. Taking
            * height is the point -- it is the only arrangement where reading the notes and reading
            * the diagram are not in competition. Renders nothing when no run has started, so an idle
            * canvas is exactly as tall as it was.
            */}
          <NotesLane
            notes={laneNotes}
            named={scenarios.length > 1}
            onFocusNode={focusNode}
            /* Which of the two readings it is showing. Exactly the condition `liveFrame` uses, so the
               heading and the contents cannot describe different things. */
            playing={Boolean(liveFrame)}
            collapsed={notesCollapsed}
            onCollapsedChange={setNotesCollapsed}
            focus={anchorFocus}
          />

          {/* `min-h-0` so the canvas gives up height to the lane rather than overflowing the
              column -- a flex child defaults to refusing to shrink below its content, and the
              canvas asks for all of it.

              Measured, because "what is on screen" needs the pane's size in pixels and React Flow's
              transform only supplies the offset and the zoom. */}
          <div ref={paneRef} className="relative min-h-0 flex-1">
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
                onAutoAlign={() => {
                  const result = runCommand('auto-align', commandContext)
                  if (!result.ran) notify({ tone: 'info', message: result.reason })
                }}
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
                /* The corner-rounding drag on a shape. Through `updateNode` like every other field
                   edit, so it lands on the same undo stack and the same dirty check. */
                onSetRadius={(id, radius) => updateNode(id, { radius })}
                /* Any other field a node writes for itself: a rich label commits `nameRich` and
                   the plain `name` derived from it together, and the text toolbar writes
                   `style.fontSize`, `style.textAlign` and the rest. The same function the
                   inspector's fields call, so all of it is one undo stack. */
                onUpdateData={updateNode}
                /* Whether the Unbound flags mean anything yet -- see canvas/chrome.js. */
                connected={Boolean(workspace)}
                /* So an untouched component and an untouched zone can tell they are being left out
                   of a path, which nothing in their own data says -- see canvas/chrome.js. Exactly
                   the condition `liveFrame` uses, so the dimming appears and disappears with the
                   annotations rather than a frame either side of them. */
                walkthroughActive={runs.length > 0 && playback.tick >= 0}
                /* Which way the hovered Flow menu row would make data run, so the connectors it
                   would affect can animate it before it is committed -- see canvas/chrome.js. */
                flowPreview={flowPreview}
                /* The travelling event: where it is at any millisecond, and the clock to look it up
                   against. Both derived from the same beat table the transport runs on, so the token
                   and the glow cannot disagree about where the event has got to. */
                eventPlans={eventPlans}
                eventClock={playback.clock}
                /* Shared with the notes lane, so hovering a component lights its card and hovering a
                   card lights the component -- one store, two ends. Owned by the app because the lane
                   is outside the canvas. */
                anchorFocus={anchorFocus}
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
                  onImportFile={triggerImport}
                />
              )}
            </>
          )}
          </div>

          {connectOpen && (
            <ConnectDialog
              email={sessionState.account?.email}
              onConnected={handleConnected}
              onClose={() => setConnectOpen(false)}
            />
          )}
          {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
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
              onImportFile={triggerImport}
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
          {feedbackOpen && (
            <FeedbackDialog config={feedbackConfig} onClose={() => setFeedbackOpen(false)} />
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

        {chrome(
          slots?.right,
          <>
          <aside
            className={`shrink-0 overflow-hidden border-l border-twilio-gray-20 bg-white transition-[width] duration-150 ${
              inspectorWide ? 'w-[42rem]' : 'w-96'
            }`}
          >
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
                /* For the Code tab: the events saved paths carry, to test a function
                   against, and which paths start at the component being edited. */
                scenarios={scenarios}
                wide={inspectorWide}
                onWide={setInspectorWide}
                onConnect={() => setConnectOpen(true)}
                onUpdateNode={updateNode}
                onUpdateKind={updateKindStyle}
                onUpdateEdge={actions.edgeStyle}
                onClose={() => setInspectedId(null)}
                onNotify={notify}
              />
            </ErrorBoundary>
          </aside>
          </>,
        )}
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
          onDuplicateScenario={duplicateScenario}
          onUpdateScenario={updateScenario}
          onRemoveScenario={removeScenario}
          onFocusNode={focusNode}
          onClearSelection={() => setSelectedPaths([])}
          editingId={editingPathId}
          onEdit={setEditingPathId}
          /* The edited path's own run, so its timeline and toggles describe its route rather than
             the whole canvas -- and keep doing so when it is not selected for playback. */
          editingRun={editingRun}
          getDiagnostics={getDiagnostics}
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
          onPreview={setFlowPreview}
        />
      )}
    </div>
  )
}

const components = (count) => `${count} component${count === 1 ? '' : 's'}`

/* The canvas is mounted with its zone backdrops and no components, so this sits
   on top rather than replacing it -- dragging from the palette works before any
   fetch, which is how you draw an architecture with no token at all. */
function EmptyOverlay({ workspaceReason, onLoad, onOpen, onStartBlank, onImportFile }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto max-w-sm rounded-lg border border-twilio-gray-20 bg-white/95 p-5 text-center shadow-sm">
        <Workflow size={22} className="mx-auto text-twilio-gray-40" aria-hidden="true" />
        <h2 className="mt-2 text-sm font-semibold text-twilio-navy">Nothing on the canvas yet</h2>
        <p className="mt-1 text-xs leading-relaxed text-twilio-gray-60">
          Start from a reference template, drag components from the palette to draw one
          by hand, build it from a customer&apos;s live workspace, or import a diagram
          file exported earlier.
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
          <button
            type="button"
            onClick={onImportFile}
            title="Rebuild a diagram, including its name, from a file exported earlier"
            className="rounded-md border border-twilio-gray-20 px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
          >
            Import a diagram file
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

