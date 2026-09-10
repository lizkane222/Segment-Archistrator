/*
 * Bind a template placeholder to a real component in the customer's workspace.
 *
 * This is the step that turns a reference architecture into a customer's
 * architecture, so the panel is built around one idea: the ranking is a suggestion
 * and it says why, but it never gets the last word. Every component of the right
 * kind is listed, the suggested ones are labelled and sorted first, and the reasons
 * are shown next to them. A hint written by someone who has never seen this
 * workspace must not be able to hide the component the user came here to pick.
 *
 * Binding across kinds is the one thing refused outright -- it would put the node in
 * the wrong pipeline zone and invalidate every edge already attached to it.
 */

import { useMemo, useState } from 'react'
import { Check, Link2, Link2Off, Search, Sparkles } from 'lucide-react'

import { EmptyNote, Row, Section } from './primitives.jsx'
import {
  applyBinding,
  boundSegmentIds,
  candidatesFor,
  replacementPatch,
  undoBinding,
} from '../binding/bindMatch.js'

export default function BindTab({
  node,
  topology,
  graph,
  nodes,
  workspaceReason,
  onConnect,
  onUpdate,
  onNotify,
}) {
  const [term, setTerm] = useState('')

  const data = node.data
  const kindLabel = topology?.kinds?.[data.kind]?.label ?? data.kind ?? 'component'

  const used = useMemo(() => boundSegmentIds(nodes, node.id), [nodes, node.id])
  const candidates = useMemo(
    () => candidatesFor(data, graph?.nodes, used),
    [data, graph, used],
  )

  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (!needle) return candidates
    return candidates.filter((candidate) =>
      `${candidate.node.name ?? ''} ${candidate.node.slug ?? ''}`.toLowerCase().includes(needle),
    )
  }, [candidates, term])

  /* Both directions go through `replacementPatch` because binding and unbinding
     *replace* a node's identity rather than adding to it, while `onUpdate` merges.
     Without it, unbinding leaves the real segmentId attached to a dashed
     placeholder. */
  const bind = (candidate) => {
    onUpdate(replacementPatch(data, applyBinding(data, candidate.node)))
    onNotify?.({
      tone: 'success',
      message: `Bound "${data.templateName ?? data.name}" to ${candidate.node.name}.`,
    })
  }

  const unbind = () => {
    const restored = undoBinding(data)
    onUpdate(replacementPatch(data, restored))
    onNotify?.({
      tone: 'info',
      message: `Unbound. The placeholder is back to "${restored.name}".`,
    })
  }

  return (
    <>
      {data.bound ? (
        <Section
          title="Bound to"
          note={
            data.templateName && data.templateName !== data.name
              ? `Drawn as "${data.templateName}" in the template.`
              : null
          }
        >
          <Row label="Component" value={data.name} />
          <Row label="Kind" value={kindLabel} />
          {data.slug && <Row label="Slug" value={data.slug} mono />}
          <button
            type="button"
            onClick={unbind}
            className="nodrag mt-2 flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-[11px] text-twilio-gray-60 transition-colors hover:border-twilio-error hover:text-twilio-error"
          >
            <Link2Off size={12} aria-hidden="true" />
            Unbind and restore the placeholder
          </button>
        </Section>
      ) : (
        <Section
          title="Placeholder"
          note={`This node is drawn from a template and is not yet attached to anything in the workspace. Pick the ${kindLabel.toLowerCase()} it stands for.`}
        >
          <Row label="Drawn as" value={data.name} />
          {data.description && <Row label="Role" value={data.description} />}
          <HintRow binds={data.binds} />
        </Section>
      )}

      <Section
        title={data.bound ? 'Rebind to' : `Workspace ${kindLabel.toLowerCase()}s`}
        note={
          candidates.length > 0
            ? 'Suggestions come from the template’s hint. Anything of the same kind can be picked regardless of ranking.'
            : null
        }
      >
        {workspaceReason ? (
          /* Checked before `!graph`: with no token there is nothing to load, so
             pointing at the header's Load button would be a dead end. */
          <EmptyNote>
            {workspaceReason} Until then the placeholder can be renamed and described
            by hand from the Overview tab.
            {onConnect && (
              <button
                type="button"
                onClick={onConnect}
                className="nodrag mt-2 block rounded-md bg-twilio-blue px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-twilio-blue-dark"
              >
                Connect a workspace
              </button>
            )}
          </EmptyNote>
        ) : !graph ? (
          <EmptyNote>
            The workspace has not been loaded yet. Use “Load workspace” in the header — binding
            needs the real component list to choose from.
          </EmptyNote>
        ) : !candidates.length ? (
          <EmptyNote>
            No {kindLabel.toLowerCase()} was found in this workspace.
            {data.kind === 'journey'
              ? ' Journeys have no Public API, so journey nodes stay hand-authored.'
              : ' Refresh the workspace if it was created recently.'}
          </EmptyNote>
        ) : (
          <>
            {candidates.length > 6 && (
              <label className="mb-2 flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2 py-1.5 focus-within:border-twilio-blue">
                <Search size={12} className="shrink-0 text-twilio-gray-40" aria-hidden="true" />
                <input
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder={`Search ${candidates.length} components`}
                  className="nodrag min-w-0 flex-1 bg-transparent text-xs text-twilio-navy placeholder:text-twilio-gray-40 focus:outline-none"
                />
              </label>
            )}

            <ul className="space-y-1">
              {filtered.map((candidate) => (
                <li key={candidate.node.id ?? candidate.node.segmentId}>
                  <Candidate
                    candidate={candidate}
                    isCurrent={candidate.node.segmentId === data.segmentId}
                    onSelect={() => bind(candidate)}
                  />
                </li>
              ))}
            </ul>

            {!filtered.length && <EmptyNote>Nothing matches “{term}”.</EmptyNote>}
          </>
        )}
      </Section>
    </>
  )
}

/* What the template guessed, stated plainly. Someone deciding whether to trust the
   ranking needs to see what it was based on. */
function HintRow({ binds }) {
  if (!binds) return null
  const parts = [
    binds.sourceType && `type ${asList(binds.sourceType)}`,
    binds.warehouseType && `warehouse ${asList(binds.warehouseType)}`,
    binds.slug && `slug ${asList(binds.slug)}`,
    binds.categories && `category ${asList(binds.categories)}`,
  ].filter(Boolean)

  if (!parts.length) return null
  return <Row label="Template hint" value={parts.join(', ')} />
}

function asList(value) {
  return Array.isArray(value) ? value.join(' / ') : String(value)
}

function Candidate({ candidate, isCurrent, onSelect }) {
  const { node, reasons, suggested, alreadyUsed } = candidate

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={`nodrag w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
        isCurrent
          ? 'cursor-default border-twilio-success bg-white'
          : suggested
            ? 'border-twilio-blue bg-twilio-blue-light/40 hover:bg-twilio-blue-light'
            : 'border-twilio-gray-20 bg-white hover:border-twilio-gray-40'
      } ${alreadyUsed ? 'opacity-70' : ''}`}
    >
      <span className="flex items-center gap-1.5">
        {isCurrent ? (
          <Check size={12} className="shrink-0 text-twilio-success" aria-hidden="true" />
        ) : (
          suggested && <Sparkles size={12} className="shrink-0 text-twilio-blue" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-twilio-navy">
          {node.name}
        </span>
        {isCurrent && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-twilio-success">
            bound
          </span>
        )}
        {alreadyUsed && !isCurrent && (
          <span
            title="Already bound to another node on this canvas"
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-twilio-warning"
          >
            <Link2 size={10} aria-hidden="true" />
            in use
          </span>
        )}
      </span>

      {(reasons.length > 0 || node.slug) && (
        <span className="mt-0.5 block truncate text-[10px] text-twilio-gray-60">
          {reasons.length ? reasons.join(' · ') : node.slug}
        </span>
      )}
    </button>
  )
}
