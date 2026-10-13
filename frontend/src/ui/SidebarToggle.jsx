/*
 * The chevron that collapses or expands a workbench sidebar (the palette, or the inspector).
 *
 * Sits on the border between the sidebar and the canvas rather than inside either one, because
 * that is the one seam both a component with the sidebar open and one with it collapsed can
 * agree on -- there's no `<aside>` left to put a button inside once the width is zero.
 *
 * Hidden until the pointer is at that border while the sidebar is open, the same reasoning
 * `handleReveal` in canvas/chrome.js uses for the connection dots: a control drawn on every one
 * of two hundred nodes is a wall of chrome, but a border with forty other borders on the same
 * screen has only the two these panels own. Once collapsed there is nothing else marking where
 * the sidebar went, so the arrow stays visible unconditionally -- the only way back has to be
 * findable without hovering blind along the window's edge.
 *
 * ## The strip is click-through; only the button is not
 *
 * The wrapper spans the sidebar's whole height and straddles the seam, so it lies over a 16px
 * column of canvas for the full window. Left hit-testable it would swallow every click, drag and
 * connection gesture that happened to land in that column -- an invisible dead stripe down the
 * edge of the drawing, which is the kind of thing that reads as the canvas being broken rather
 * than as a control being in the way. So the strip is `pointer-events-none` and the button turns
 * them back on for its own 24px. Hover still works: `group-hover` is a CSS state and does not
 * need the wrapper to take events, only to be hovered.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function SidebarToggle({ side, open, onToggle }) {
  const isLeft = side === 'left'
  const label = `${open ? 'Collapse' : 'Expand'} ${isLeft ? 'palette' : 'inspector'}`
  /* Pointing at the canvas to expand, and at the sidebar's own content to collapse -- the arrow
     always shows which way the border is about to move. */
  const Icon = open ? (isLeft ? ChevronLeft : ChevronRight) : isLeft ? ChevronRight : ChevronLeft

  return (
    <div
      className={`group pointer-events-none absolute inset-y-0 z-10 flex w-4 items-center ${
        isLeft ? 'right-0 translate-x-1/2 justify-start' : 'left-0 -translate-x-1/2 justify-end'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        aria-label={label}
        title={label}
        className={`nodrag pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full border border-twilio-gray-20 bg-white text-twilio-gray-60 shadow-sm transition-opacity hover:border-twilio-blue hover:text-twilio-navy focus-visible:opacity-100 ${
          open ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        <Icon size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
