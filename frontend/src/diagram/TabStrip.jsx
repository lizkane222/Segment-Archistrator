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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Columns2, Copy, Plus, Rows2, X } from 'lucide-react'

import { groupTabs } from './tabs.js'

/* A stable colour per workspace, so a group is recognisable at a glance without reading its name.
   Derived from the id rather than assigned, so it is the same after a reload and on every tab. */
const GROUP_COLOURS = ['#0d6efd', '#198754', '#b45309', '#7c3aed', '#be185d', '#0f766e', '#c2410c']
export function groupColour(workspaceId) {
  if (!workspaceId) return '#9ca3af'
  let hash = 0
  for (const char of workspaceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return GROUP_COLOURS[hash % GROUP_COLOURS.length]
}

export default function TabStrip({
  tabs,
  /* id -> {name, slug} for every connected workspace. A group whose id is not in here is shown as
     no workspace, which is also what the shell treats it as. */
  workspaces = {},
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
  onMoveTab,
  onDuplicateTo,
  onNewInGroup,
  onAddWorkspace,
}) {
  const [editing, setEditing] = useState(null)
  /* The right-click menu: `{x, y, tabId}` while open. */
  const [menu, setMenu] = useState(null)
  /* Which tab is mid-drag, and which group it is over. Held here, not in the DataTransfer: the drop
     handler needs the id and `dragover` cannot read DataTransfer data, only its types. */
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(undefined)
  const groups = groupTabs(tabs)
  /* The user's own group labels, for the menu to offer as destinations. */
  const customGroups = groups.filter((group) => group.groupName).map((group) => group.groupName)

  const commit = (tabId) => {
    const next = editing?.trim()
    setEditing(null)
    if (next) onRename?.(tabId, next)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {groups.map((group) => {
          const known = group.workspaceId && workspaces[group.workspaceId]
          const custom = Boolean(group.groupName)
          const label = known
            ? workspaces[group.workspaceId].slug || workspaces[group.workspaceId].name
            : custom
              ? group.groupName
              : 'No workspace'
          const colour = groupColour(known ? group.workspaceId : custom ? group.key : null)
          const hovered = dragging && over === group.key
          return (
            <div
              key={group.key ?? 'none'}
              role="group"
              aria-label={`${label} tabs`}
              onDragOver={(event) => {
                if (!dragging) return
                event.preventDefault()
                setOver(group.key)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const id = dragging
                setDragging(null)
                setOver(undefined)
                if (id) onMoveTab?.(id, group.workspaceId ?? null, group.groupName ?? null)
              }}
              className={`flex shrink-0 items-center gap-1 rounded-md border px-1 transition-colors ${
                hovered ? 'bg-twilio-blue-light' : 'bg-transparent'
              }`}
              style={{ borderColor: colour }}
            >
              <span
                className="max-w-32 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                style={{ backgroundColor: colour }}
                title={
                  known
                    ? `${workspaces[group.workspaceId].name} — tabs in this group use this workspace's token. Drag a tab here to move it.`
                    : custom
                      ? `A group of your own — it is only for organising tabs and is not connected to a workspace. Drag a tab here to add it.`
                      : 'Tabs here are not tied to a workspace. Drag a tab onto a workspace to move it there.'
                }
              >
                {label}
              </span>
          {group.tabs.map((tab) => {
          const active = tab.id === activeId
          const dirty = dirtyIds?.has(tab.id)
          return (
            <div
              key={tab.id}
              draggable={editing === null}
              onDragStart={(event) => {
                setDragging(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                /* Firefox will not start a drag with no data. The id itself is read from state. */
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={() => {
                setDragging(null)
                setOver(undefined)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, tabId: tab.id })
              }}
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

              {(known || custom) && (
                <button
                  type="button"
                  onClick={() => onNewInGroup?.(group.workspaceId, group.groupName)}
                  title={`New diagram in ${label}`}
                  className="shrink-0 rounded p-1 text-twilio-gray-40 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy"
                >
                  <Plus size={12} aria-hidden="true" />
                </button>
              )}
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

        {onAddWorkspace && (
          <button
            type="button"
            onClick={() => onAddWorkspace()}
            title="Connect another Segment workspace. It gets its own group of tabs and its own token."
            className="shrink-0 whitespace-nowrap rounded border border-dashed border-twilio-gray-40 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
          >
            + Workspace
          </button>
        )}
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
      {menu && (
        <TabMenu
          at={menu}
          workspaces={workspaces}
          customGroups={customGroups}
          onClose={() => setMenu(null)}
          onFork={onFork ? () => onFork(menu.tabId) : null}
          onDuplicateTo={onDuplicateTo ? (workspaceId, groupName) => onDuplicateTo(menu.tabId, workspaceId, groupName) : null}
          onMoveTab={onMoveTab ? (workspaceId, groupName) => onMoveTab(menu.tabId, workspaceId, groupName) : null}
          onCloseTab={onClose ? () => onClose(menu.tabId) : null}
        />
      )}
    </div>
  )
}


/*
 * The right-click menu on a tab. Styled to match the canvas's own (commands/ContextMenu.jsx): a white
 * card on the same border and shadow, rows that light blue on hover, and flyouts that open sideways
 * from a row with a chevron.
 *
 * "Duplicate to" and "Move to group" share one list of destinations -- a connected workspace, a group
 * of the user's own, no workspace, or a new group -- because they are the same question asked of a copy
 * or of the tab itself. Whether a move is *allowed* is the caller's call (it holds the live graph); it
 * answers with a toast, so this stays a list.
 */
const MARGIN = 8
const FLYOUT_WIDTH = 192

function TabMenu({ at, workspaces, customGroups, onClose, onFork, onDuplicateTo, onMoveTab, onCloseTab }) {
  const card = useRef(null)
  const [offset, setOffset] = useState(null)
  /* Which action is waiting on a new group's name -- 'duplicate' | 'move' -- or null. */
  const [naming, setNaming] = useState(null)
  const [name, setName] = useState('')

  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect()
    if (!box) return
    const x = at.x + box.width > window.innerWidth - MARGIN ? at.x - box.width : at.x
    const y = at.y + box.height > window.innerHeight - MARGIN ? at.y - box.height : at.y
    setOffset({ x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) })
  }, [at, naming])

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    /* Containment is tested against the card rather than by stopping propagation -- see the note in
       ContextMenu: a capture listener on `window` runs before React's delegated handlers. */
    const dismiss = (event) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('wheel', dismiss, { passive: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('wheel', dismiss)
    }
  }, [onClose])

  const run = (action, ...args) => {
    action?.(...args)
    onClose()
  }

  const destinations = (action) => [
    ...Object.entries(workspaces).map(([id, entry]) => ({
      key: `ws:${id}`,
      label: entry.slug || entry.name,
      run: () => run(action, id, null),
    })),
    ...customGroups.map((group) => ({
      key: `group:${group}`,
      label: group,
      run: () => run(action, null, group),
    })),
    { key: 'none', label: 'No workspace', run: () => run(action, null, null) },
  ]

  const submitName = (event) => {
    event.preventDefault()
    const group = name.trim()
    if (!group) return
    run(naming === 'duplicate' ? onDuplicateTo : onMoveTab, null, group)
  }

  return (
    <div
      ref={card}
      role="menu"
      className="fixed z-50 min-w-48 max-w-72 rounded-lg border border-twilio-gray-20 bg-white py-1 text-[12px] shadow-lg"
      style={{ left: offset?.x ?? at.x, top: offset?.y ?? at.y, visibility: offset ? 'visible' : 'hidden' }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {naming ? (
        <form onSubmit={submitName} className="space-y-2 px-3 py-2">
          <label className="block text-[11px] font-semibold text-twilio-gray-60">
            New group name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.stopPropagation() || (event.key === 'Escape' && onClose())}
              placeholder="e.g. Acme"
              className="mt-1 w-full rounded border border-twilio-gray-20 px-2 py-1 text-xs font-normal text-twilio-navy focus:border-twilio-blue focus:outline-none"
            />
          </label>
          <p className="text-[10px] leading-snug text-twilio-gray-40">
            Only for organising tabs. It is not connected to a workspace.
          </p>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!name.trim()}
              className="rounded bg-twilio-blue px-2.5 py-1 text-[11px] font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-40"
            >
              {naming === 'duplicate' ? 'Duplicate' : 'Move'}
            </button>
            <button
              type="button"
              onClick={() => setNaming(null)}
              className="rounded border border-twilio-gray-20 px-2.5 py-1 text-[11px] text-twilio-gray-60 hover:text-twilio-navy"
            >
              Back
            </button>
          </div>
        </form>
      ) : (
        <>
          {onDuplicateTo && (
            <MenuBranch
              label="Duplicate to"
              items={[...destinations(onDuplicateTo), { key: 'new', label: 'New group…', run: () => setNaming('duplicate') }]}
            />
          )}
          {onMoveTab && (
            <MenuBranch
              label="Move to group"
              items={[...destinations(onMoveTab), { key: 'new', label: 'New group…', run: () => setNaming('move') }]}
            />
          )}
          {onFork && <MenuRow label="Fork" onClick={() => run(onFork)} />}
          {onCloseTab && (
            <div className="mt-1 border-t border-twilio-gray-20 pt-1">
              <MenuRow label="Close" onClick={() => run(onCloseTab)} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MenuRow({ label, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-baseline gap-3 px-3 py-1 text-left text-twilio-navy hover:bg-twilio-blue-light"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function MenuBranch({ label, items }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const row = useRef(null)

  useLayoutEffect(() => {
    if (!open) return
    const box = row.current?.getBoundingClientRect()
    if (box) setFlip(box.right + FLYOUT_WIDTH > window.innerWidth - MARGIN)
  }, [open])

  return (
    <div
      ref={row}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        className={`flex w-full items-baseline gap-3 px-3 py-1 text-left text-twilio-navy hover:bg-twilio-blue-light ${
          open ? 'bg-twilio-blue-light' : ''
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div
          role="menu"
          style={{ minWidth: FLYOUT_WIDTH }}
          className={`absolute top-0 z-10 max-h-72 overflow-y-auto rounded-lg border border-twilio-gray-20 bg-white py-1 shadow-lg ${
            flip ? 'right-full -mr-px' : 'left-full -ml-px'
          }`}
        >
          {items.map((item) => (
            <MenuRow key={item.key} label={item.label} onClick={item.run} />
          ))}
        </div>
      )}
    </div>
  )
}
