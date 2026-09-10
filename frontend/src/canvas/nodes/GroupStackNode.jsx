/*
 * A collapsed group, drawn as one node, plus the expandable-internals control that
 * SegmentNode shares with it.
 *
 * The stack has to read as a *stack* and not as a component, or someone walking a
 * customer through the diagram will point at it and say "and here's your destination".
 * Hence the offset backing card, the count on the face, and named members rather than
 * a bare "40 destinations" -- the names are what make it obvious there is more here.
 *
 * It carries no inspector: clicking opens the group instead. Canvas.jsx enforces that
 * end of it, because `Workbench.inspected` looks ids up in the document and a stack's
 * id is not in there -- the inspector would open empty.
 */

import { memo, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Layers, Unlink } from 'lucide-react'

import { GROUP_PEEK, internalSections } from '../grouping.js'
import { SHAPES, iconFor, styleFor } from '../kinds.js'
import { useGroupCollapse } from '../groupCollapse.js'

function GroupStackNode({ data }) {
  const style = styleFor(data.kind)
  const Icon = iconFor(data.kind)
  const shapeClass = SHAPES[style.shape] ?? SHAPES.rounded

  const { topology, expand } = useGroupCollapse()
  const label = topology?.kinds?.[data.kind]?.label ?? data.kind
  const heading = data.type ? data.type : label

  const peek = data.members.slice(0, GROUP_PEEK)
  const rest = data.count - peek.length

  const paths = data.paths ?? null
  const lit = paths?.filter((entry) => entry.arrived) ?? null
  const glowing = lit?.length ? lit : null

  return (
    <div className="relative h-full w-full">
      {/* Two offset cards behind the face. The only thing on the canvas that looks
          like this, which is the point -- a reader should never mistake a stack for
          the component it stands for. */}
      <div
        className={`absolute inset-0 translate-x-1.5 translate-y-1.5 border ${shapeClass}`}
        style={{ background: style.bg, borderColor: style.border, opacity: 0.35 }}
        aria-hidden="true"
      />
      <div
        className={`absolute inset-0 translate-x-0.5 translate-y-0.5 border ${shapeClass}`}
        style={{ background: style.bg, borderColor: style.border, opacity: 0.6 }}
        aria-hidden="true"
      />

      <button
        type="button"
        className={`relative flex h-full w-full flex-col gap-1 border px-2.5 py-1.5 text-left shadow-sm transition-shadow hover:shadow-md ${shapeClass}`}
        style={{
          background: style.bg,
          color: style.text,
          borderColor: glowing?.[0]?.color ?? style.border,
          boxShadow: glowing
            ? glowing.map((entry, index) => `0 0 0 ${(index + 1) * 3}px ${entry.color}55`).join(', ')
            : undefined,
          opacity: paths && !glowing ? 0.5 : undefined,
        }}
        title={`${data.count} × ${label}${data.type ? ` · ${data.type}` : ''} — click to expand`}
        onClick={() => expand(data.key)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="flex items-center gap-1.5">
          <Layers size={13} aria-hidden="true" className="shrink-0 opacity-70" />
          <Icon size={13} aria-hidden="true" className="shrink-0 opacity-60" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-none">
            {heading}
          </span>
          <span className="shrink-0 rounded-full bg-black/10 px-1.5 text-[10px] font-bold leading-4 tabular-nums">
            {data.count}
          </span>
        </span>

        <span className="flex flex-col leading-[17px]">
          {peek.map((member) => (
            <span
              key={member.id}
              className="truncate text-[10px] opacity-70"
              style={{ fontStyle: member.bound ? undefined : 'italic' }}
            >
              {member.name}
            </span>
          ))}
          {rest > 0 && (
            <span className="truncate text-[10px] font-medium opacity-50">+{rest} more</span>
          )}
        </span>
      </button>

      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-2 !bg-white"
        style={{ borderColor: style.border }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-2 !bg-white"
        style={{ borderColor: style.border }}
      />

      {/* Edges between two members of this group. Undrawable while it is folded --
          both ends are this one node -- so they are said out loud rather than left
          to look like connections that were never there. */}
      {data.internalEdges > 0 && (
        <span
          className="absolute -bottom-1.5 left-2 flex items-center gap-0.5 rounded bg-twilio-gray-90 px-1 text-[9px] font-semibold text-white"
          title={`${data.internalEdges} connection${data.internalEdges === 1 ? '' : 's'} between members of this group, hidden while it is collapsed`}
        >
          <Unlink size={8} aria-hidden="true" />
          {data.internalEdges}
        </span>
      )}

      {paths && (
        <span className="absolute -top-1.5 right-1.5 flex gap-0.5">
          {paths.map((entry) => (
            <span
              key={entry.scenarioId}
              title={`${entry.name} — ${entry.arrived ? 'reached this group' : 'did not reach this group'}`}
              className="h-1.5 w-1.5 rounded-full ring-1 ring-white"
              style={{ background: entry.color, opacity: entry.arrived ? 1 : 0.4 }}
            />
          ))}
        </span>
      )}
    </div>
  )
}

/**
 * A component's expandable internals: the Identity Resolver's New / Append / Merge,
 * a profile's identifiers / traits / events.
 *
 * The counts are always on the face and the contents open in an absolutely-positioned
 * popover, which is not a styling preference. The column layout's row pitch is
 * NODE_HEIGHT + ROW_GAP, so a node that grew by three rows on expand would overlap the
 * node beneath it -- and that overlap would then be what a PNG export shows. A popover
 * changes no geometry at all, so nothing downstream has to know this can happen.
 */
export function InternalSections({ data, topology }) {
  const sections = internalSections(data, topology)
  const [open, setOpen] = useState(null)
  if (!sections.length) return null

  const shown = sections.find((section) => section.id === open) ?? null

  return (
    <div className="relative mt-1 flex flex-wrap gap-1">
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className={`nodrag rounded px-1 text-[9px] font-semibold uppercase tracking-wide transition-opacity ${
            open === section.id ? 'bg-black/20 opacity-100' : 'bg-black/10 opacity-70 hover:opacity-100'
          }`}
          title={`${section.rows.length} ${section.label.toLowerCase()}`}
          onClick={(event) => {
            event.stopPropagation()
            setOpen(open === section.id ? null : section.id)
          }}
        >
          {section.label} {section.rows.length}
        </button>
      ))}

      {shown && (
        <div className="nodrag absolute left-0 top-full z-50 mt-1 w-full rounded border border-twilio-gray-20 bg-white p-1.5 text-twilio-gray-90 shadow-lg">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            {shown.label}
          </div>
          {shown.rows.length ? (
            <ul className="space-y-0.5">
              {shown.rows.map((row) => (
                <li key={row.id} className="truncate font-mono text-[10px]" title={row.label}>
                  {row.label}
                </li>
              ))}
            </ul>
          ) : (
            /* Named rather than left blank. "Nothing here yet" and "this component has
               no such section" look the same on an empty popover, and only one of them
               is worth a Twilion's attention. */
            <p className="text-[10px] italic text-twilio-gray-60">Nothing recorded yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(GroupStackNode)
