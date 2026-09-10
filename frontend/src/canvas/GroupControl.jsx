/*
 * The control that decides what is folded away.
 *
 * It used to be labelled "Group components", which was the wrong word for it and read as a
 * bug: a checkbox called "group" is expected to tie some cards together so they move as one,
 * and ticking this instead replaced forty cards with a single stack -- which looks exactly
 * like the diagram collapsing on itself. It has always been *collapse*; its own buttons say
 * so. Grouping in the other sense is a different feature, on the right-click menu, and it
 * deliberately leaves every component where it is (canvas/selection.js's `groupNodes`).
 *
 * Something has to offer this, because a collapsed group is the only thing on the
 * canvas that cannot be reached by clicking what it stands for -- once forty
 * destinations are one node there is nowhere else to un-tick them from. It reads as
 * the request was written: a dropdown per component type, headed by the type, with
 * the count of what is in it.
 *
 * Deliberately not a per-node affordance. "Collapse destinations" is a statement about
 * the diagram, not about whichever destination happened to be right-clicked, and the
 * only way to find a group whose members are all currently offscreen is a list.
 *
 * The groups come in as a prop rather than being computed here, from the *document's*
 * nodes: computing them from the collapsed view would make a folded group disappear
 * from the list that unfolds it.
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, Layers } from 'lucide-react'

export default function GroupControl({ groups, collapsed, onChange }) {
  const [open, setOpen] = useState(false)
  if (!groups.length) return null

  const folded = new Set(collapsed)
  const activeGroups = groups.filter((group) => folded.has(group.key))
  const hiddenCount = activeGroups.reduce((total, group) => total + group.count, 0)

  const toggle = (key) => {
    const next = new Set(folded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next])
  }

  return (
    <div className="w-64 rounded-md border border-twilio-gray-20 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title="Fold every component of one type into a single stack, to make a large workspace readable. Does not change the diagram — expand to get them back."
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-twilio-gray-60 hover:text-twilio-navy"
      >
        <Layers size={13} aria-hidden="true" />
        <span className="flex-1 text-left">
          {/* The count of what is hidden, on the collapsed control itself. A reader who
              opened someone else's saved diagram has no other way to tell that forty
              components are not simply absent. */}
          {hiddenCount ? `${hiddenCount} components folded away` : 'Collapse by type'}
        </span>
        {open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-twilio-gray-20 px-1 py-1">
          {groups.map((group) => (
            <label
              key={group.key}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-twilio-gray-10"
            >
              <input
                type="checkbox"
                checked={folded.has(group.key)}
                onChange={() => toggle(group.key)}
                className="accent-twilio-blue"
              />
              <span className="min-w-0 flex-1 truncate text-twilio-gray-90" title={group.label}>
                {group.label}
              </span>
              <span className="shrink-0 tabular-nums text-twilio-gray-60">{group.count}</span>
            </label>
          ))}

          <div className="mt-1 flex gap-1 border-t border-twilio-gray-20 pt-1">
            <button
              type="button"
              /* Unioned, not replaced. A key can be in `collapsed` with no group behind
                 it right now -- someone deleted a destination and left one -- and
                 dropping it here would silently un-collapse that group the moment its
                 second member came back. */
              onClick={() => onChange([...new Set([...collapsed, ...groups.map((g) => g.key)])])}
              className="flex-1 rounded px-1.5 py-1 text-[11px] text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy"
            >
              Collapse all
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={!folded.size}
              className="flex-1 rounded px-1.5 py-1 text-[11px] text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy disabled:opacity-40"
            >
              Expand all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
