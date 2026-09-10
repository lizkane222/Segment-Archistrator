/*
 * The open diagrams, as a row of chips.
 *
 * It sits in the document strip -- the row that already carries the diagram's name, its unsaved dot
 * and Save -- because a tab *is* the diagram's name plus its unsaved dot, and having both would be
 * saying the same thing twice a few pixels apart. So the chips replace the name field and the
 * actions stay to the right of them.
 *
 * The unsaved marker is a dot rather than the word, for the same reason it was a dot before: it has
 * to be legible at a glance during a customer call, and it sits directly against the name it
 * describes.
 *
 * Renaming happens on the active chip, by double-clicking it -- the same gesture that renames a
 * component on the canvas. A separate name field beside the strip would be a second place the name
 * lives, and the two would show different things the moment a tab was switched mid-edit.
 */

import { useState } from 'react'
import { Columns2, Copy, Plus, Rows2, X } from 'lucide-react'

export default function TabStrip({
  tabs,
  activeId,
  dirtyIds,
  split,
  orientation,
  onSelect,
  onRename,
  onFork,
  onClose,
  onNew,
  onToggleSplit,
  onOrientation,
}) {
  const [editing, setEditing] = useState(null)

  const commit = (tabId) => {
    const next = editing?.trim()
    setEditing(null)
    if (next) onRename?.(tabId, next)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId
          const dirty = dirtyIds?.has(tab.id)
          return (
            <div
              key={tab.id}
              className={`group flex max-w-56 shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs transition-colors ${
                active
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-navy'
                  : 'border-transparent text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy'
              }`}
            >
              {active && editing !== null ? (
                <input
                  autoFocus
                  value={editing}
                  onChange={(event) => setEditing(event.target.value)}
                  onBlur={() => commit(tab.id)}
                  onFocus={(event) => event.target.select()}
                  onKeyDown={(event) => {
                    /* Contained, or Backspace in the field reaches the canvas's delete key and
                       removes whatever is selected on the diagram. */
                    event.stopPropagation()
                    if (event.key === 'Enter') commit(tab.id)
                    if (event.key === 'Escape') setEditing(null)
                  }}
                  className="w-36 rounded border border-twilio-blue px-1 text-xs text-twilio-navy outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect?.(tab.id)}
                  onDoubleClick={() => active && setEditing(tab.doc?.name ?? '')}
                  title={
                    active
                      ? 'Double-click to rename'
                      : `Switch to ${tab.doc?.name ?? 'this diagram'}`
                  }
                  className="min-w-0 truncate"
                >
                  {tab.doc?.name || 'Untitled'}
                </button>
              )}

              {/* The dot goes between the name and the close button, not after it: it belongs to
                  the name, and beyond the button it reads as decoration on the control. */}
              {dirty && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-twilio-warning"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              )}

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose?.(tab.id)
                }}
                /* Only on hover, or on the active tab. A close button on every chip all the time is
                   a row of crosses inviting a mis-click on work nobody asked to discard. */
                className={`shrink-0 rounded p-0.5 text-twilio-gray-40 transition-opacity hover:bg-twilio-gray-20 hover:text-twilio-navy ${
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
                }`}
                title={dirty ? 'Close — this diagram has unsaved changes' : 'Close'}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={() => onNew?.()}
          title="New diagram in a new tab"
          className="shrink-0 rounded p-1 text-twilio-gray-40 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-l border-twilio-gray-20 pl-1.5">
        <button
          type="button"
          onClick={() => onFork?.(activeId)}
          title="Fork this diagram into a new tab. The copy is unsaved, so saving it cannot overwrite this one."
          className="rounded p-1 text-twilio-gray-40 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
        >
          <Copy size={13} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => onToggleSplit?.()}
          aria-pressed={split}
          title={
            split
              ? 'Back to one diagram'
              : 'Show two diagrams side by side, to compare them'
          }
          className={`rounded p-1 transition-colors ${
            split
              ? 'bg-twilio-blue text-white'
              : 'text-twilio-gray-40 hover:bg-twilio-gray-10 hover:text-twilio-navy'
          }`}
        >
          <Columns2 size={13} aria-hidden="true" />
        </button>

        {/* Only while split. A divider-orientation control with no divider to orient is a button
            that does nothing visible, which reads as broken rather than as unavailable. */}
        {split && (
          <button
            type="button"
            onClick={() => onOrientation?.(orientation === 'vertical' ? 'horizontal' : 'vertical')}
            title={
              orientation === 'vertical'
                ? 'Stack them top and bottom instead'
                : 'Put them side by side instead'
            }
            className="rounded p-1 text-twilio-gray-40 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
          >
            {orientation === 'vertical' ? (
              <Rows2 size={13} aria-hidden="true" />
            ) : (
              <Columns2 size={13} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
