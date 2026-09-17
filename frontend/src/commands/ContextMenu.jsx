/*
 * The right-click menu.
 *
 * It knows nothing about what the commands do -- it reads `commandsFor` and renders it.
 * The only judgement it makes is presentational: an unavailable command stays in the
 * list, greyed, with its reason printed under it.
 *
 * That is the request's *"dropdown functionality for what is possible on a component"*
 * taken literally. A menu that hides what cannot be done answers a narrower question and
 * leaves the user to guess whether the item was never there or is merely unavailable
 * today -- and "the destination has no mapping yet" is exactly the kind of thing they
 * opened the menu to find out.
 *
 * Positioned `fixed` from the raw pointer coordinates, not inside the flow viewport: a
 * menu that panned and zoomed with the canvas would drift away from the node it was
 * opened on the moment anything moved.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { commandsFor, formatShortcut } from './registry.js'

/* Keep off the window edge, so a menu opened near the bottom right does not have its
   last item under the scrollbar. */
const MARGIN = 8

/* The flyout's width, as a number rather than a Tailwind class, because the flip decision has
   to compare it against the room on screen -- and reading it back off the DOM would mean
   rendering the submenu in the wrong place first and moving it, which is the visible jump the
   parent menu's own measurement pass exists to avoid. */
const SUBMENU_WIDTH = 176

const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '')

/**
 * @param onPreview  called with a command's `preview` value while the pointer or the focus is
 *   on its row, and with `null` when it leaves. Used by the flow directions to animate the
 *   connector the way it would run before anything is committed -- a menu row cannot show the
 *   consequence of turning a line round, and the canvas can.
 */
export default function ContextMenu({ at, context, onRun, onClose, onPreview }) {
  const card = useRef(null)
  const [offset, setOffset] = useState(null)

  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect()
    if (!box) return
    /* Flipped rather than clamped: sliding the menu up so its bottom clears the window
       would leave the pointer in the middle of it, over whichever item happened to land
       there -- one stray click from running it. */
    const x = at.x + box.width > window.innerWidth - MARGIN ? at.x - box.width : at.x
    const y = at.y + box.height > window.innerHeight - MARGIN ? at.y - box.height : at.y
    setOffset({ x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) })
  }, [at])

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    /* `capture`, so the menu closes before the click reaches the canvas underneath and
       changes the selection the command was about to act on. Scroll and a second
       right-click close it too -- both leave it pointing at nothing.
     *
     * Containment is tested *here*, against the card, and not by stopping propagation
     * from the card's own handler. A capture listener on `window` is the first thing to
     * run in the entire dispatch, and React's handlers are delegated to the root
     * container -- so `stopPropagation` there cannot un-run this, and the menu unmounted
     * on pointer-down with the `click` never reaching the button. Every command silently
     * did nothing; only the ones with no visible effect looked like they had worked. */
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

  /* Clear the preview when the menu goes, however it goes -- Escape, a click outside, a
     command running, or the pointer leaving mid-hover. Without this a menu dismissed while a
     flow row was hovered leaves the canvas animating a direction nobody chose. */
  useEffect(() => () => onPreview?.(null), [onPreview])

  const items = commandsFor(at.menu, context)
  if (!items.length) return null

  return (
    <div
      ref={card}
      role="menu"
      /* No `overflow-hidden`, and that is the whole reason the submenus were invisible: a
         flyout is absolutely positioned at `left-full`, which is *outside* this box, so clipping
         to the box clipped all of it. It was there to round the corners of the first and last
         rows against the card's radius; the rows are square and the padding row above and below
         them means nothing reaches the corner anyway. */
      className="fixed z-50 min-w-52 max-w-72 rounded-lg border border-twilio-gray-20 bg-white py-1 text-[12px] shadow-lg"
      style={{
        left: offset?.x ?? at.x,
        top: offset?.y ?? at.y,
        /* Hidden for the one frame between mount and measurement. Rendering it at the
           unadjusted point first makes a menu near the edge visibly jump. */
        visibility: offset ? 'visible' : 'hidden',
      }}
      /* Belt and braces only -- the dismiss listener above decides by containment, not by
         propagation. This just keeps a menu click from reaching anything else listening
         further up the document. */
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {at.subject && (
        <p className="truncate border-b border-twilio-gray-20 px-3 pb-1.5 pt-1 text-[11px] font-semibold text-twilio-gray-60">
          {at.subject}
        </p>
      )}

      {items.map((item, index) => {
        const divided = index > 0 && items[index - 1].group !== item.group
        return (
          <div key={item.id} className={divided ? 'mt-1 border-t border-twilio-gray-20 pt-1' : ''}>
            <MenuItem item={item} onRun={onRun} onClose={onClose} onPreview={onPreview} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * One row: a command, or a branch that opens a submenu.
 *
 * A branch is not clickable. There is nothing for it to do -- "Align" is not an action --
 * and a parent that ran its own first child on click would make a mis-aimed pointer silently
 * rearrange the diagram.
 */
function MenuItem({ item, onRun, onClose, onPreview }) {
  const branch = Boolean(item.children?.length)
  /* Opened on hover *and* kept open by focus, so the submenu is reachable by keyboard.
     Held here rather than in the parent so hovering one branch closes the others for free --
     each row owns exactly its own flyout. */
  const [open, setOpen] = useState(false)
  const row = useRef(null)
  /* Which side the flyout opens on, decided when it opens rather than on every render: the
     parent menu is already flipped away from the window edge, so a menu opened near the right
     of the screen has its own body where the flyout wanted to go. Measured from the row, not
     guessed from the click point, because the parent's own flip has already happened by then. */
  const [flip, setFlip] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const box = row.current?.getBoundingClientRect()
    if (!box) return
    setFlip(box.right + SUBMENU_WIDTH > window.innerWidth - MARGIN)
  }, [open])

  return (
    <div
      ref={row}
      className="relative"
      onMouseEnter={() => {
        if (branch && item.enabled) setOpen(true)
        /* A leaf's own preview, so a top-level flow row would work the same way as a nested
           one. A branch has none of its own -- "Flow" is not a direction -- and previewing on
           the parent would show one arbitrary child's answer. */
        if (!branch && item.enabled && item.preview) onPreview?.(item.preview)
      }}
      onMouseLeave={() => {
        setOpen(false)
        if (!branch && item.preview) onPreview?.(null)
      }}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup={branch ? 'menu' : undefined}
        aria-expanded={branch ? open : undefined}
        /* A branch is disabled only when its own gate refuses it -- an enabled branch is
           still not clickable, which is what the no-op handler expresses. */
        disabled={!item.enabled}
        onClick={() => {
          if (branch) return
          onRun(item.id)
          onClose()
        }}
        onFocus={() => branch && item.enabled && setOpen(true)}
        className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${
          item.enabled
            ? 'text-twilio-navy hover:bg-twilio-blue-light'
            : 'cursor-default text-twilio-gray-40'
        } ${branch && open ? 'bg-twilio-blue-light' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.shortcut && (
          <span className="shrink-0 tabular-nums text-twilio-gray-40">
            {formatShortcut(item.shortcut, { mac: IS_MAC })}
          </span>
        )}
        {branch && <ChevronRight size={12} aria-hidden="true" className="shrink-0 opacity-60" />}
      </button>

      {!item.enabled && item.reason && (
        <p className="px-3 pb-1 text-[10px] leading-snug text-twilio-gray-40">{item.reason}</p>
      )}

      {branch && open && (
        /* Overlapping the parent by 1px, so the pointer can cross between them without
           passing over the canvas and closing the flyout on the way. */
        <div
          role="menu"
          style={{ minWidth: SUBMENU_WIDTH }}
          className={`absolute top-0 z-10 rounded-lg border border-twilio-gray-20 bg-white py-1 shadow-lg ${
            flip ? 'right-full -mr-px' : 'left-full -ml-px'
          }`}
        >
          {item.children.map((child) => (
            <div key={child.id}>
              <button
                type="button"
                role="menuitem"
                disabled={!child.enabled}
                onClick={() => {
                  onRun(child.id)
                  onClose()
                }}
                /* Hover *and* focus, so the preview is not mouse-only: the flow rows are
                   reachable by keyboard and the animation is the only thing that explains what
                   the row will do. Cleared on the way out either way. */
                onMouseEnter={() => child.enabled && child.preview && onPreview?.(child.preview)}
                onMouseLeave={() => child.preview && onPreview?.(null)}
                onFocus={() => child.enabled && child.preview && onPreview?.(child.preview)}
                onBlur={() => child.preview && onPreview?.(null)}
                className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${
                  child.enabled
                    ? 'text-twilio-navy hover:bg-twilio-blue-light'
                    : 'cursor-default text-twilio-gray-40'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{child.label}</span>
                {child.shortcut && (
                  <span className="shrink-0 tabular-nums text-twilio-gray-40">
                    {formatShortcut(child.shortcut, { mac: IS_MAC })}
                  </span>
                )}
              </button>
              {/* The reason it cannot run, or -- when it can -- what choosing it means. Never
                  both: a row saying two things in the same grey text under it is a row nobody
                  reads either sentence of. */}
              {!child.enabled && child.reason ? (
                <p className="px-3 pb-1 text-[10px] leading-snug text-twilio-gray-40">
                  {child.reason}
                </p>
              ) : (
                child.hint && (
                  <p className="px-3 pb-1 text-[10px] leading-snug text-twilio-gray-40">
                    {child.hint}
                  </p>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
