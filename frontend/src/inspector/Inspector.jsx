/*
 * The Edit-Stage panel. Opened by right-clicking a component, per the brief.
 *
 * It renders the *live* node out of React Flow's store rather than the node object
 * it was handed on selection. That distinction matters: editing the name from the
 * Overview tab replaces the node in the store, and a stale captured copy would show
 * the old value until the next click.
 *
 * The selected tab survives moving between nodes when the new node has that tab
 * (see `reconcileTab`) -- comparing the Fields of three audiences in a row should
 * not bounce back to Overview between each click.
 */

import { useMemo, useState } from 'react'
import { Frame, MousePointerClick, SquareDashed, X } from 'lucide-react'

import BindTab from './BindTab.jsx'
import FieldsTab from './FieldsTab.jsx'
import LinksTab from './LinksTab.jsx'
import OverviewTab from './OverviewTab.jsx'
import RulesTab from './RulesTab.jsx'
import StyleTab from './StyleTab.jsx'
import ZoneTab from './ZoneTab.jsx'
import { iconFor, labelForKind, styleFor, zoneStyleFor } from '../canvas/kinds.js'
import { zoneLabel } from '../canvas/rules.js'
import {
  BIND,
  FIELDS,
  LINKS,
  OVERVIEW,
  RULES,
  STYLE,
  TAB_LABELS,
  ZONE,
  reconcileTab,
  resolveSpace,
  spacesFromGraph,
  tabsFor,
} from './tabs.js'

export default function Inspector({
  node,
  nodes,
  topology,
  graph,
  workspaceReason,
  onConnect,
  onUpdateNode,
  onUpdateKind,
  onClose,
  onNotify,
}) {
  const [requested, setRequested] = useState(OVERVIEW)

  /*
   * Reconciled while rendering, not in an effect.
   *
   * The tab has to stay valid as the selection moves -- clicking from an audience
   * (which has Rules) to a warehouse (which does not) must not leave the panel on a tab
   * that renders nothing. Doing that in an effect meant there was always one render
   * where the *old* tab was paired with the *new* node, and the panel body is chosen by
   * that pair. Clicking a zone while on Style rendered StyleTab against a node with no
   * kind, whose kind label is then undefined, and `.toLowerCase()` on it took the whole
   * app down to a blank page with an unsaved diagram in it. Derived here, that pairing
   * cannot occur at all.
   *
   * `requested` is what was last clicked rather than what was last shown, so returning
   * to a node that has the tab returns to the tab.
   */
  const tab = reconcileTab(requested, node)

  const spaces = useMemo(() => spacesFromGraph(graph), [graph])
  const space = useMemo(() => resolveSpace(node, spaces), [node, spaces])

  /* Read off the live zone node rather than copied into the component's own data:
     renaming a zone would leave every copy stale, and a component's zone is
     already recorded as the parent it is clamped to. */
  const zoneName = useMemo(() => {
    if (!node || node.type === 'zone') return null
    const parent = nodes?.find((candidate) => candidate.id === node.parentId)
    return parent?.data?.label ?? zoneLabel(topology, node.data?.zone) ?? '—'
  }, [node, nodes, topology])

  if (!node) return <Placeholder />

  const isZone = node.type === 'zone'
  const tabs = tabsFor(node)
  const data = node.data
  const title = isZone ? data.label || 'Untitled zone' : data.name
  const subtitle = isZone
    ? data.custom
      ? 'Custom zone'
      : 'Pipeline zone'
    : labelForKind(topology, data.kind)

  const style = isZone
    ? { ...zoneStyleFor(data), text: zoneStyleFor(data).border }
    : styleFor(data.kind, data.style)
  const Icon = isZone ? (data.custom ? SquareDashed : Frame) : iconFor(data.kind)

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-twilio-gray-20 px-4 py-3">
        <div className="flex items-start gap-2">
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded"
            style={{ background: style.bg, color: style.text, boxShadow: `inset 0 0 0 1px ${style.border}` }}
          >
            <Icon size={13} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-twilio-navy" title={title}>
              {title}
            </h2>
            <p className="text-[11px] uppercase tracking-wide text-twilio-gray-60">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close inspector"
            className="nodrag shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-navy"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <nav className="mt-3 flex gap-1 overflow-x-auto">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setRequested(id)}
              className={`nodrag shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                tab === id
                  ? 'bg-twilio-blue text-white'
                  : 'text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy'
              }`}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === ZONE && (
          <ZoneTab node={node} onUpdate={(patch) => onUpdateNode(node.id, patch)} />
        )}
        {tab === BIND && (
          <BindTab
            node={node}
            nodes={nodes}
            topology={topology}
            graph={graph}
            workspaceReason={workspaceReason}
            onConnect={onConnect}
            onUpdate={(patch) => onUpdateNode(node.id, patch)}
            onNotify={onNotify}
          />
        )}
        {tab === OVERVIEW && (
          <OverviewTab
            node={node}
            topology={topology}
            zoneName={zoneName}
            onUpdate={(patch) => onUpdateNode(node.id, patch)}
            onNotify={onNotify}
          />
        )}
        {tab === FIELDS && (
          /* Keyed by space so switching selection to a node in a different space
             remounts rather than showing the previous space's events under the new
             heading while the fetch is in flight. */
          <FieldsTab key={space.spaceId ?? 'none'} node={node} spaces={spaces} space={space} />
        )}
        {tab === RULES && <RulesTab node={node} onNotify={onNotify} />}
        {tab === STYLE && (
          <StyleTab
            node={node}
            topology={topology}
            onUpdate={(patch) => onUpdateNode(node.id, patch)}
            onUpdateKind={onUpdateKind}
          />
        )}
        {tab === LINKS && <LinksTab node={node} />}
      </div>
    </div>
  )
}

function Placeholder() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-[15rem] text-center">
        <MousePointerClick size={20} className="mx-auto text-twilio-gray-40" aria-hidden="true" />
        <h2 className="mt-2 text-sm font-semibold text-twilio-navy">Edit-Stage</h2>
        <p className="mt-1 text-xs leading-relaxed text-twilio-gray-60">
          Right-click a component to open its rules, available fields and links.
        </p>
      </div>
    </div>
  )
}
