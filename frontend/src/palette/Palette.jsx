/*
 * The left sidebar: what you can put on the canvas.
 *
 * Four tabs, because the things you drag come from four different places and
 * have genuinely different filters:
 *
 *   Components — the topology kinds. Always available, no network.
 *   Catalog    — the global Segment catalog from Postgres. Costs the customer no
 *                rate budget, so search-as-you-type is safe here.
 *   Workspace  — the customer's real components, read once on connect from
 *                /api/workspace/graph and filtered locally. Listed, never put on the canvas
 *                by themselves: drag one onto a card to bind it, onto empty canvas to add it,
 *                or "Visualize all" to open the whole workspace in a new tab.
 *   Events     — the five event types, their payloads and saved examples, for the simulator
 *                rather than the canvas. See EventsTab.jsx.
 *
 * Everything draggable sets the same dataTransfer payload, so Canvas has one drop
 * handler regardless of which tab the item came from.
 */

import { useEffect, useMemo, useReducer, useState } from 'react'

import EventsTab from './EventsTab.jsx'
import ShapesTab from './ShapesTab.jsx'
import { ConvertContext, GLOW_CLASS, GLOW_PENDING_CLASS, useConvert } from './convertContext.js'
import {
  Box,
  Boxes,
  Check,
  LayoutGrid,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Filter as FilterIcon,
  Frame,
  Search,
  SquareDashed,
  X,
} from 'lucide-react'

import { catalog as catalogApi } from '../services/api.js'
import { DRAG_MIME } from '../canvas/Canvas.jsx'
import { groupTree } from '../canvas/grouping.js'
import { boundSegmentIds } from '../binding/bindMatch.js'
import { KIND_STYLES, iconFor, zoneStyleFor } from '../canvas/kinds.js'
import {
  BOUND_ANY,
  BOUND_NO,
  BOUND_YES,
  TABS,
  activeFilterCount,
  applyWorkspaceFilters,
  relatedNodeIds,
  catalogQuery,
  filtersReducer,
  initialFilters,
} from './filters.js'

const CATALOG_KINDS = [
  { id: 'destination', label: 'Destinations', fetch: catalogApi.destinations },
  { id: 'source', label: 'Sources', fetch: catalogApi.sources },
  { id: 'warehouse', label: 'Warehouses', fetch: catalogApi.warehouses },
]

/* One instance of each of these belongs in a diagram, so offering them for
   repeat drops would only let people build something meaningless. */
const SINGLETON_KINDS = new Set(['identity_resolution', 'profile_api'])

export default function Palette({
  topology,
  graph,
  /* The diagram on the canvas, as opposed to `graph`, which is the workspace. The Events tab reads the
     identity resolution rules drawn on it. */
  diagram,
  zonesOnCanvas,
  workspaceReason,
  workspaceStatus = 'idle',
  workspaceError = null,
  onRetryWorkspace,
  /* Builds a diagram from the workspace components ticked in the Workspace tab: `(nodes) => void`. */
  onBuildSelected,
  /* Bumped by the shell to bring the Workspace tab forward (e.g. from "Visualize the workspace"). */
  workspaceSignal = 0,
  onConnect,
  /* Just connected: the Workspace tab glows until it is clicked, to say where binding starts. */
  guideWorkspaceTab = false,
  onGuideDone,
  onStartSimulation,
  /* Graph ids of the workspace components selected on the canvas, for "connected to selection". */
  selectedIds = [],
  /* While a component is being converted: `{ name, pending, onPick, onConfirm, onCancel }`. */
  convert = null,
}) {
  const [filters, dispatch] = useReducer(filtersReducer, initialFilters)
  const activeCount = activeFilterCount(filters)
  const converting = Boolean(convert)
  /* Workspace components ticked for "Build diagram": by graph id, kept here because the footer button
     and the list both need it. */
  const [picked, setPicked] = useState(() => new Set())
  const togglePicked = (ids, on) =>
    setPicked((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  useEffect(() => {
    if (workspaceSignal) dispatch({ type: 'setTab', tab: TABS.workspace })
  }, [workspaceSignal])

  /* Conversion picks from Segment components and Shapes, which both live under Components. */
  useEffect(() => {
    if (converting) dispatch({ type: 'setTab', tab: TABS.components })
  }, [converting])

  const convertValue = useMemo(
    () => (convert ? { onPick: convert.onPick, pending: convert.pending } : null),
    [convert],
  )

  return (
    <ConvertContext.Provider value={convertValue}>
    <div className="flex h-full flex-col">
      {convert && <ConvertBar convert={convert} />}
      <div className="shrink-0 border-b border-twilio-gray-20 px-3 pt-3">
        {/* Four uppercase labels do not fit the 320px sidebar, so the strip
            scrolls rather than clipping the last tab mid-word. */}
        <nav className="scroll-x-thin flex gap-0.5" role="tablist">
          {[
            [TABS.components, 'Components'],
            [TABS.catalog, 'Catalog'],
            [TABS.workspace, 'Workspace'],
            [TABS.events, 'Events'],
          ].map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={filters.tab === tab}
              onClick={() => {
                dispatch({ type: 'setTab', tab })
                if (tab === TABS.workspace) onGuideDone?.()
              }}
              title={
                tab === TABS.workspace && guideWorkspaceTab
                  ? 'Open this, click a component on the canvas, then pick the workspace resources to bind it to.'
                  : undefined
              }
              className={`shrink-0 whitespace-nowrap rounded-t-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                tab === TABS.workspace && guideWorkspaceTab ? 'guide-glow ' : ''
              }${
                filters.tab === tab
                  ? 'bg-twilio-gray-10 text-twilio-navy'
                  : 'text-twilio-gray-60 hover:text-twilio-navy'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {filters.tab !== TABS.events && (
        <div className="shrink-0 space-y-2 border-b border-twilio-gray-20 p-3">
          <SearchBox
            value={filters.search}
            onChange={(search) => dispatch({ type: 'setSearch', search })}
          />
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'clear' })}
              className="flex items-center gap-1 text-[11px] text-twilio-blue hover:underline"
            >
              <X size={11} aria-hidden="true" />
              Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filters.tab === TABS.components && (
          <ComponentsSection
            topology={topology}
            zonesOnCanvas={zonesOnCanvas}
            search={filters.search}
          />
        )}
        {filters.tab === TABS.catalog && (
          <CatalogTab filters={filters} dispatch={dispatch} />
        )}
        {filters.tab === TABS.workspace && (
          <WorkspaceTab
            topology={topology}
            graph={graph}
            diagram={diagram}
            status={workspaceStatus}
            error={workspaceError}
            onRetry={onRetryWorkspace}
            workspaceReason={workspaceReason}
            selectedIds={selectedIds}
            onConnect={onConnect}
            picked={picked}
            onPick={togglePicked}
            filters={filters}
            dispatch={dispatch}
          />
        )}
        {filters.tab === TABS.events && (
          <EventsTab diagram={diagram} onStartSimulation={onStartSimulation} />
        )}
      </div>

      {filters.tab === TABS.workspace && !workspaceReason && graph && (
        <div className="shrink-0 border-t border-twilio-gray-20 p-3">
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => {
              onBuildSelected?.((graph.nodes ?? []).filter((node) => picked.has(node.id)))
              setPicked(new Set())
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-twilio-blue px-3 py-2 text-xs font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-50"
          >
            <LayoutGrid size={13} aria-hidden="true" />
            Build diagram from {picked.size} selected
          </button>
          <p className="mt-1.5 text-center text-[10px] text-twilio-gray-60">
            Each component is placed in its own zone, in a new tab.
          </p>
        </div>
      )}
    </div>
    </ConvertContext.Provider>
  )
}

/* The confirmation step: nothing is final until Confirm, so the reader can click through options. */
function ConvertBar({ convert }) {
  return (
    <div className="shrink-0 space-y-2 border-b border-twilio-blue bg-twilio-blue-light px-3 py-2.5 text-[11px] text-twilio-navy">
      <p className="font-semibold">Converting “{convert.name}”</p>
      <p className="text-twilio-gray-60">
        {convert.pending
          ? `Previewing ${convert.pending}. Pick another to compare, or confirm.`
          : 'Click a glowing component or shape to preview it on the canvas.'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={convert.onConfirm}
          disabled={!convert.pending}
          className="rounded bg-twilio-blue px-2.5 py-1 font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-40"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={convert.onCancel}
          className="rounded border border-twilio-gray-20 bg-white px-2.5 py-1 text-twilio-gray-60 hover:text-twilio-navy"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/* --- tabs ----------------------------------------------------------------- */

/*
 * Components, split in two.
 *
 * "Segment" is everything with rules -- a kind from topology.py, with a zone it belongs in and a
 * verdict the walkthrough can give it. "Shapes" is everything without: geometry, annotations, and the
 * converted Twilio icon libraries.
 *
 * Nested rather than a fifth top-level tab, because the top row is about *where a thing comes from* --
 * the rules, the catalog, this workspace, an event -- and both of these come from the same place. It
 * is also what the request asked for.
 *
 * The sub-tab is local state. It is a view preference within one session, not part of the document and
 * not something the filter reducer needs to know: no other tab's behaviour depends on it, so putting it
 * in `filters` would be adding a field every reducer case has to carry.
 */
function ComponentsSection({ topology, zonesOnCanvas, search }) {
  const [section, setSection] = useState('segment')

  return (
    <div>
      <div className="mb-3 flex gap-1 border-b border-twilio-gray-20 pb-2">
        {[
          ['segment', 'Segment'],
          ['shapes', 'Shapes'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            aria-pressed={section === id}
            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              section === id
                ? 'bg-twilio-blue text-white'
                : 'text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {section === 'segment' ? (
        <ComponentsTab topology={topology} zonesOnCanvas={zonesOnCanvas} search={search} />
      ) : (
        <ShapesTab search={search} />
      )}
    </div>
  )
}

function ComponentsTab({ topology, zonesOnCanvas, search }) {
  if (!topology) return <Hint>Loading component rules…</Hint>

  const needle = search.trim().toLowerCase()

  return (
    <div className="space-y-4">
      <ZonesSection topology={topology} zonesOnCanvas={zonesOnCanvas} needle={needle} />

      {topology.zones.map((zone) => {
        const kinds = (topology.kindsByZone[zone.id] ?? [])
          .filter((kind) => kind in KIND_STYLES && !SINGLETON_KINDS.has(kind))
          .filter((kind) => !needle || topology.kinds[kind].label.toLowerCase().includes(needle))

        if (kinds.length === 0) return null

        return (
          <section key={zone.id}>
            <ZoneHeading zone={zone} />
            <div className="mt-1.5 space-y-1">
              {kinds.map((kind) => (
                <DraggableItem
                  key={kind}
                  kind={kind}
                  label={topology.kinds[kind].label}
                  /* Journeys are the one kind that can never be discovered, so
                     the palette is where users are told to draw them by hand. */
                  hint={
                    topology.kinds[kind].api === false
                      ? 'Not discoverable from the API — draw it by hand.'
                      : null
                  }
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/*
 * Zones come first because they have to: a component can only be dropped inside
 * one, so on a canvas whose zones have been deleted every other item in this tab
 * is unusable. The custom pair sits with them -- a region outside Segment and the
 * rule-free component that inhabits it are one idea, not two.
 */
function ZonesSection({ topology, zonesOnCanvas, needle }) {
  const present = zonesOnCanvas instanceof Set ? zonesOnCanvas : new Set(zonesOnCanvas ?? [])

  const items = [
    ...topology.zones.map((zone) => ({
      key: zone.id,
      kind: 'zone',
      icon: Frame,
      label: zone.label,
      /*
       * Never disabled, and that single word is the whole of "let a zone be added twice".
       *
       * The machinery for a second copy has been in place for some time and is tested end to end:
       * `dropZone` in canvas/Canvas.jsx mints `connections~2` via `nextZoneInstance`
       * (canvas/frames.js), the rules and colour tables resolve it by product, and the backend's
       * `topology.zone_product` does the same. None of it could ever run, because this tile was
       * rendered with `draggable={false}` the moment its zone was on the canvas -- so no `dragstart`
       * fired and the drop handler was never reached.
       *
       * The hint still says what will happen, because a reader who has already placed Destinations
       * and drags it again deserves to know they are getting a second one rather than moving the
       * first: one canvas holding Destinations inside Connections *and* inside Engage is the case
       * this is for.
       */
      hint: present.has(zone.id)
        ? `Already on the canvas — dragging it again adds a second ${zone.label}.`
        : zone.description,
      payload: {
        zone: {
          id: zone.id,
          label: zone.label,
          description: zone.description ?? '',
          order: zone.order ?? 0,
          /* Carried so a re-added zone goes back where it belongs in the tree. Left
             out, Unify would land as a root beside Segment instead of inside it, and
             the drop would be refused for being in the wrong place. */
          parent: zone.parent ?? null,
          docsUrl: zone.docsUrl ?? null,
        },
      },
    })),
    {
      key: 'custom-zone',
      kind: 'zone',
      icon: SquareDashed,
      label: 'Custom zone',
      hint: 'Somewhere outside Segment — an app, a site, a warehouse. Rename it once it lands.',
      payload: { zone: { label: 'New region', description: 'Outside Segment', custom: true } },
    },
    {
      key: 'custom-component',
      kind: 'custom',
      icon: Box,
      label: 'Custom component',
      hint: 'No rules attached. Name it and fill in your own details.',
      payload: { name: 'Custom component', bound: true, data: { bindable: false, details: [] } },
    },
  ].filter((item) => !needle || item.label.toLowerCase().includes(needle))

  if (!items.length) return null

  return (
    <section>
      <div className="text-[10px] font-bold uppercase tracking-widest text-twilio-gray-60">
        Zones &amp; custom
      </div>
      <div className="mt-1.5 space-y-1">
        {items.map(({ key, ...item }) => (
          <DraggableItem key={key} {...item} />
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-twilio-gray-60">
        A product zone drops inside Segment, its sub-zones inside it. A custom zone
        goes on empty canvas. Click any of them to resize from an edge or corner.
      </p>
    </section>
  )
}

function CatalogTab({ filters, dispatch }) {
  const [state, setState] = useState({ status: 'loading', items: [], categories: [] })
  const active = CATALOG_KINDS.find((entry) => entry.id === filters.catalogKind)

  const params = useMemo(() => catalogQuery(filters), [filters.search, filters.categories])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    /* Debounced so typing a destination name is one request, not eight. The
       catalog is local Postgres, but a request per keystroke still floods the
       dev server and makes results arrive out of order. */
    const timer = setTimeout(() => {
      setState((current) => ({ ...current, status: 'loading' }))
      active
        .fetch(params)
        .then((result) => {
          if (cancelled) return
          setState({ status: 'ready', items: result.items, categories: result.categories })
        })
        .catch((error) => {
          if (cancelled || error.name === 'AbortError') return
          setState({ status: 'error', items: [], categories: [], error: error.message })
        })
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, params])

  return (
    <div className="space-y-3">
      <div className="scroll-x-thin flex gap-1">
        {CATALOG_KINDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => dispatch({ type: 'setCatalogKind', kind: entry.id })}
            className={`shrink-0 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] transition-colors ${
              filters.catalogKind === entry.id
                ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {state.categories.length > 0 && (
        <FacetChips
          label="Category"
          options={state.categories}
          selected={filters.categories}
          onToggle={(category) => dispatch({ type: 'toggleCategory', category })}
        />
      )}

      {state.status === 'error' && <Hint tone="error">{state.error}</Hint>}
      {state.status === 'loading' && <Hint>Searching the catalog…</Hint>}

      {state.status === 'ready' && state.items.length === 0 && (
        <Hint>
          Nothing matched. If the catalog looks empty entirely, it has not been
          synced yet — run <code className="font-mono">manage.py sync_catalog</code>.
        </Hint>
      )}

      <div className="space-y-1">
        {state.items.map((item) => (
          <DraggableItem
            key={`${item.kind}:${item.metadataId ?? item.slug}`}
            kind={catalogKindToNodeKind(filters.catalogKind)}
            label={item.name}
            hint={item.categories?.join(' · ')}
            logo={item.logoUrl}
            payload={{
              name: item.name,
              bound: false,
              data: {
                slug: item.slug,
                docsUrl: item.docsUrl,
                categories: item.categories,
                catalogMetadataId: item.metadataId,
              },
            }}
          />
        ))}
      </div>
    </div>
  )
}

function WorkspaceTab({
  topology,
  graph,
  diagram,
  status,
  error,
  onRetry,
  workspaceReason,
  selectedIds = [],
  onConnect,
  picked,
  onPick,
  filters,
  dispatch,
}) {
  /* The only tab that needs a token. Said here, with the way out attached,
     rather than left to fail as a 403 on the fetch behind it. */
  if (workspaceReason) {
    return (
      <div className="space-y-2">
        <Hint>{workspaceReason}</Hint>
        <button
          type="button"
          onClick={onConnect}
          className="rounded-md bg-twilio-blue px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-twilio-blue-dark"
        >
          Connect a workspace
        </button>
      </div>
    )
  }

  if (!graph) {
    if (status === 'error') {
      return (
        <div className="space-y-2">
          <Hint>Could not read the workspace{error ? `: ${error}` : '.'}</Hint>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-[11px] text-twilio-gray-60 hover:border-twilio-gray-40 hover:text-twilio-navy"
          >
            Try again
          </button>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 text-[11px] text-twilio-gray-60">
        <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
        Reading the workspace’s components… a large workspace can take a minute.
      </div>
    )
  }

  const selectedNodes = (graph.nodes ?? []).filter((node) => selectedIds.includes(node.id))
  const following = filters.followSelection && selectedNodes.length > 0
  const related = following ? relatedNodeIds(graph.edges, selectedIds) : null
  const nodes = applyWorkspaceFilters(graph.nodes ?? [], filters, topology, related)
  const onCanvas = boundSegmentIds(diagram?.nodes)
  const spaces = (graph.nodes ?? []).filter((node) => node.kind === 'space')

  return (
    <div className="space-y-3">
      {selectedNodes.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-twilio-blue/30 bg-twilio-blue/5 px-2 py-1.5 text-[11px] text-twilio-navy">
          <p className="min-w-0 flex-1">
            {following ? 'Showing what is connected to ' : 'Connected components hidden for '}
            <strong className="font-semibold">
              {selectedNodes.length === 1 ? selectedNodes[0].name : `${selectedNodes.length} selected components`}
            </strong>
            {following && related.size === 0 && (
              <span className="text-twilio-gray-60">
                {' '}— the Public API reports no connections for {selectedNodes.length === 1 ? 'it' : 'them'}.
                {selectedNodes.some((node) => node.kind === 'audience') &&
                  ' It does not list an audience’s destinations; an audience relates to its space.'}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => dispatch({ type: 'setFollowSelection', follow: !filters.followSelection })}
            className="shrink-0 rounded border border-twilio-gray-20 bg-white px-1.5 py-0.5 text-[10px] text-twilio-gray-60 hover:text-twilio-navy"
          >
            {following ? 'Show all' : 'Show connected'}
          </button>
        </div>
      )}

      <FacetChips
        label="Pipeline"
        options={(topology?.zones ?? []).map((zone) => zone.id)}
        labels={Object.fromEntries((topology?.zones ?? []).map((z) => [z.id, z.label]))}
        selected={filters.zones}
        onToggle={(zone) => dispatch({ type: 'toggleZone', zone })}
      />

      <FacetChips
        label="Binding"
        options={[BOUND_ANY, BOUND_YES, BOUND_NO]}
        labels={{ [BOUND_ANY]: 'Any', [BOUND_YES]: 'Bound', [BOUND_NO]: 'Unbound' }}
        selected={[filters.bound]}
        onToggle={(bound) => dispatch({ type: 'setBound', bound })}
      />

      {spaces.length > 1 && (
        <FacetChips
          label="Space"
          options={spaces.map((space) => space.segmentId)}
          labels={Object.fromEntries(spaces.map((s) => [s.segmentId, s.name]))}
          selected={filters.spaceId ? [filters.spaceId] : []}
          onToggle={(spaceId) =>
            dispatch({ type: 'setSpace', spaceId: filters.spaceId === spaceId ? null : spaceId })
          }
        />
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-twilio-gray-60">
        <span>
          {nodes.length} of {graph.nodes?.length ?? 0} components
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => onPick(nodes.map((node) => node.id), true)}
            className="hover:text-twilio-navy hover:underline"
          >
            Select shown
          </button>
          <button
            type="button"
            onClick={() => onPick([...picked], false)}
            disabled={picked.size === 0}
            className="hover:text-twilio-navy hover:underline disabled:opacity-40"
          >
            Clear
          </button>
        </span>
      </div>

      <Hint>
        Tick the components you want, then build a diagram from them. Or drag one onto a card of the
        same kind to bind it, or onto empty canvas to add it.
      </Hint>

      <WorkspaceSections
        nodes={nodes}
        topology={topology}
        onCanvas={onCanvas}
        picked={picked}
        onPick={onPick}
      />
    </div>
  )
}

/*
 * The workspace list, ordered by type with a header per type -- the same grouping the
 * canvas folds by, from the same `groupKey`, so "Destinations · Email Marketing" means
 * one thing in both places.
 *
 * Its own component because WorkspaceTab returns early for a missing token, and a hook
 * behind an early return is a hook that is sometimes called.
 */
function WorkspaceSections({ nodes, topology, onCanvas, picked, onPick }) {
  const tree = useMemo(() => groupTree(nodes, topology), [nodes, topology])
  const [closed, setClosed] = useState(null)

  /* Everything arrives folded, so the tab opens as a short list of type headers with their counts
     rather than hundreds of rows. Which are open is the reader's from the first click. */
  const folded = closed ?? new Set(tree.flatMap((entry) => [entry.key, ...entry.subs.map((sub) => sub.key)]))

  const toggle = (key) => {
    const next = new Set(folded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setClosed(next)
  }

  const items = (list) => (
    <div className="space-y-1">
      {list.map((node) => (
        <div key={node.id} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={picked.has(node.id)}
            onChange={(event) => onPick([node.id], event.target.checked)}
            aria-label={`Include ${node.name} in the new diagram`}
            className="h-3.5 w-3.5 shrink-0 accent-twilio-blue"
          />
          <div className="min-w-0 flex-1">
            <DraggableItem
              kind={node.kind}
              label={node.name}
              hint={node.sourceType ?? topology?.kinds?.[node.kind]?.label}
              placed={onCanvas?.has(node.segmentId)}
              /* Dragging a real workspace component onto the canvas carries its
                 ids and links with it, so it lands already bound. */
              payload={{ name: node.name, bound: true, data: node }}
            />
          </div>
        </div>
      ))}
    </div>
  )

  const header = (key, label, count, shut, level) => (
    <button
      type="button"
      onClick={() => toggle(key)}
      aria-expanded={!shut}
      className={
        level === 0
          ? 'flex w-full items-center gap-1 border-b border-twilio-gray-20 px-0.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-twilio-navy'
          : 'flex w-full items-center gap-1 rounded px-0.5 py-1 pl-3 text-left text-[10px] font-semibold text-twilio-gray-60 hover:text-twilio-navy'
      }
    >
      {shut ? <ChevronRight size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 font-normal tabular-nums normal-case tracking-normal">{count}</span>
    </button>
  )

  return (
    <div className="space-y-3">
      {tree.map((entry) => {
        const shut = folded.has(entry.key)
        return (
          <section key={entry.key} aria-label={entry.label}>
            {header(entry.key, entry.label, entry.count, shut, 0)}
            {!shut && (
              <div className="mt-1 space-y-1">
                {entry.items.length > 0 && items(entry.items)}
                {entry.subs.map((sub) => {
                  const subShut = folded.has(sub.key)
                  return (
                    <div key={sub.key}>
                      {header(sub.key, sub.label, sub.items.length, subShut, 1)}
                      {!subShut && <div className="pl-3">{items(sub.items)}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* --- pieces --------------------------------------------------------------- */

function DraggableItem({ kind, label, hint, logo, icon, payload, disabled = false, placed = false }) {
  const Icon = icon ?? iconFor(kind)
  const convert = useConvert()
  /* A zone is a region, not a component, so it cannot be what a component becomes. */
  const pickable = Boolean(convert) && !disabled && kind !== 'zone'
  const pending = convert?.pending === label

  return (
    <div
      draggable={!disabled && !convert}
      onClick={pickable ? () => convert.onPick({ kind, ...payload }, label) : undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind, ...payload }))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className={
        convert
          ? `flex items-center gap-2 rounded-md border bg-white px-2.5 py-1.5 transition-colors ${
              pickable
                ? `cursor-pointer ${pending ? GLOW_PENDING_CLASS : GLOW_CLASS}`
                : 'border-twilio-gray-20 opacity-40'
            }`
          : disabled
          ? 'flex items-center gap-2 rounded-md border border-dashed border-twilio-gray-20 bg-twilio-gray-10 px-2.5 py-1.5 opacity-60'
          : 'flex cursor-grab items-center gap-2 rounded-md border border-twilio-gray-20 bg-white px-2.5 py-1.5 transition-colors hover:border-twilio-blue hover:bg-twilio-blue-light active:cursor-grabbing'
      }
      title={hint || label}
    >
      {logo ? (
        <img src={logo} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" />
      ) : (
        <Icon size={14} className="shrink-0 text-twilio-gray-60" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-twilio-navy">{label}</span>
        {hint && (
          <span className="block truncate text-[10px] text-twilio-gray-60">{hint}</span>
        )}
      </span>
      {placed && (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-twilio-success" title="Bound to a component on this canvas">
          <Check size={11} aria-hidden="true" />
          On canvas
        </span>
      )}
    </div>
  )
}

function FacetChips({ label, options, labels, selected, onToggle }) {
  if (!options.length) return null
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
        <FilterIcon size={10} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={selected.includes(option)}
            onClick={() => onToggle(option)}
            className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
              selected.includes(option)
                ? 'border-twilio-blue bg-twilio-blue text-white'
                : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
            }`}
          >
            {labels?.[option] ?? option}
          </button>
        ))}
      </div>
    </div>
  )
}

function SearchBox({ value, onChange }) {
  return (
    <label className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2 py-1.5 focus-within:border-twilio-blue">
      <Search size={13} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search"
        className="min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none placeholder:text-twilio-gray-40"
      />
    </label>
  )
}

/* Indented when nested, so Profiles reads as part of Unify rather than as a fourth
   product. `zoneStyleFor` rather than a `--color-zone-<id>-border` built from the id:
   a sub-zone has no variable of its own and would get a transparent dot. */
function ZoneHeading({ zone }) {
  return (
    <div className={`flex items-center gap-1.5 ${zone.parent ? 'pl-3' : ''}`}>
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: zoneStyleFor(zone).border }}
      />
      <span className="text-[10px] font-bold uppercase tracking-widest text-twilio-gray-60">
        {zone.label}
      </span>
    </div>
  )
}

function Hint({ children, tone }) {
  return (
    <p
      className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${
        tone === 'error' ? 'text-twilio-error' : 'text-twilio-gray-60'
      }`}
    >
      {tone !== 'error' && (
        <Boxes size={12} className="mt-0.5 shrink-0 opacity-60" aria-hidden="true" />
      )}
      <span>{children}</span>
    </p>
  )
}

/* The catalog's `kind` and the topology's `kind` share three names but are
   different vocabularies -- one describes a catalog entry, the other a node on
   the canvas. They happen to map 1:1 today; this is where that assumption is
   written down rather than spread across the component. */
function catalogKindToNodeKind(catalogKind) {
  return { destination: 'destination', source: 'source', warehouse: 'warehouse' }[catalogKind]
}
