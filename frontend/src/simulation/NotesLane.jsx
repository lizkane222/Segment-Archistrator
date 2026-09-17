/*
 * Every anchor note, in one lane above the diagram.
 *
 * ## Why one place
 *
 * The notes used to have three homes and none of them worked on its own. A tooltip pinned open over
 * the component it described covered the components either side of it -- the panel explaining a step
 * obscured the step. A gutter column outside the drawing did not cover anything, but it lived in
 * *flow* space, so at any zoom that fitted the diagram it sat off both edges of the screen. And this
 * lane only appeared while a walkthrough was playing, so the rest of the time there was nowhere to
 * read what a component does at all.
 *
 * So there is one home, it is in screen space, and it never overlaps the drawing. A row rather than a
 * column: the diagram is wide and the vertical space belongs to it, and a row matches the thing it
 * represents when a walkthrough is playing -- a sequence, read left to right in the order the event
 * travelled.
 *
 * ## Two readings, one lane
 *
 * With a walkthrough on screen the lane is that run's story: what the event met, accumulating as it
 * goes. Otherwise it is the diagram's own documentation: the note of every component currently in
 * view. Which one is showing is decided by the caller -- both come out of simulation/notes.js in the
 * same shape, so nothing here branches on it beyond the heading.
 *
 * ## What it does not do
 *
 * It keeps no list of its own. Both readings are projections -- of the trace and the tick, or of the
 * nodes and the viewport -- so scrubbing backwards shortens the lane, panning changes it, and there is
 * nothing to reset or invalidate. The only imperative things here are scrolling a card into view and
 * lighting up the component a card is about, both of which are properties of the screen rather than of
 * the data.
 */

import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Footprints, StickyNote } from 'lucide-react'

import { AnchorCard } from '../canvas/nodes/AnchorCard.jsx'
import { useFocused, usePinned } from '../canvas/anchors.js'

export default function NotesLane({
  notes,
  onFocusNode,
  named = false,
  playing = false,
  collapsed = false,
  onCollapsedChange,
  /*
   * The shared hover store (canvas/anchors.js), so a card and the component it describes light each
   * other up. It has to be shared rather than local: they are far apart now, and it lives outside
   * React because a hovered id in state would re-render the whole canvas on every mouse move.
   */
  focus = null,
}) {
  const strip = useRef(null)

  /*
   * Keep the interesting card in view.
   *
   * While a run is playing that is the *current* one, and specifically the leftmost of them -- at a
   * fork several cards are current at once and scrolling to the last would leave its sibling behind.
   * Instant rather than smooth: beats are about a second apart, and a smooth scroll still running when
   * the next one starts fights itself.
   */
  useEffect(() => {
    if (collapsed) return
    const lane = strip.current
    const card = lane?.querySelector('[data-current="true"]')
    if (!lane || !card) return
    const left = card.offsetLeft - lane.offsetLeft
    const overshoot = left + card.offsetWidth - (lane.scrollLeft + lane.clientWidth)
    if (overshoot > 0) lane.scrollLeft += overshoot
    else if (left < lane.scrollLeft) lane.scrollLeft = left
  }, [notes, collapsed])

  /*
   * And bring the hovered component's card into view when the pointer is on the *diagram*.
   *
   * Without this, hovering a card on the canvas highlights a note that may be scrolled ten cards off
   * the end of the lane -- which is indistinguishable from the highlight not working. Subscribed
   * imperatively rather than through `useSyncExternalStore`, because nothing here needs to re-render:
   * the scroll position is not React state.
   */
  useEffect(() => {
    if (!focus || collapsed) return undefined
    return focus.subscribe(() => {
      const id = focus.leader()
      const lane = strip.current
      if (!id || !lane) return
      const card = lane.querySelector(`[data-node-id="${cssEscape(id)}"]`)
      if (!card) return
      const left = card.offsetLeft - lane.offsetLeft
      const overshoot = left + card.offsetWidth - (lane.scrollLeft + lane.clientWidth)
      if (overshoot > 0) lane.scrollLeft += overshoot
      else if (left < lane.scrollLeft) lane.scrollLeft = left
    })
  }, [focus, collapsed])

  /* Nothing to say. An empty lane still renders its header when a walkthrough is running, so the
     reader can tell the difference between "no notes yet" and the lane having gone away -- but on an
     empty canvas it takes no height at all. */
  if (!notes?.length && !playing) return null

  return (
    <div className="shrink-0 border-b border-twilio-gray-20 bg-white">
      <div className="flex items-center gap-1.5 px-3 pt-1.5">
        <button
          type="button"
          onClick={() => onCollapsedChange?.(!collapsed)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60 hover:text-twilio-navy"
        >
          {collapsed ? (
            <ChevronUp size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          {playing ? (
            <Footprints size={12} aria-hidden="true" />
          ) : (
            <StickyNote size={12} aria-hidden="true" />
          )}
          {/* Named for which reading it is showing. "Notes" alone would leave the reader wondering why
              the contents changed the moment they pressed play. */}
          <span>{playing ? 'What the event met' : 'Notes on what is in view'}</span>
          <span className="font-mono text-[10px] font-normal tabular-nums text-twilio-gray-40">
            {notes?.length ?? 0}
          </span>
        </button>
      </div>

      {collapsed ? (
        <div className="h-1.5" />
      ) : (
        /* `aria-live` off: with a run playing this changes once a second, and announcing every arrival
           would talk over a reader trying to follow one. */
        <ol
          ref={strip}
          className="flex gap-2 overflow-x-auto px-3 pb-2.5 pt-1.5"
          style={{ scrollbarWidth: 'thin' }}
        >
          {notes.map((note) => (
            <NoteCard
              key={note.key}
              note={note}
              named={named}
              focus={focus}
              onFocusNode={onFocusNode}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function NoteCard({ note, named, focus, onFocusNode }) {
  /* Lit because the pointer is on this card or on the component it describes -- one store, both ends,
     so the two cannot disagree about which thing is highlighted. */
  const lit = useFocused(focus, note.nodeId)
  const pinned = usePinned(focus, note.nodeId)

  return (
    <li
      data-current={note.current ? 'true' : 'false'}
      data-node-id={note.nodeId}
      /* Hovering a card lights up its component on the canvas; clicking one keeps it lit after the
         pointer has gone, which is what lets a reader find a component here and then go and work on it
         while it stays marked. A click on bare canvas releases it. */
      onMouseEnter={() => focus?.set(note.nodeId)}
      onMouseLeave={() => focus?.clear(note.nodeId)}
      onClick={() => focus?.pin(note.nodeId)}
      title={pinned ? 'Click again to stop marking this on the diagram' : undefined}
      /* Fixed width, so the lane does not reflow as cards arrive -- a card that resized its
         neighbours would shift whatever the reader was already reading. */
      className={`w-64 shrink-0 cursor-pointer rounded-md border bg-white p-2.5 text-left transition-shadow duration-300 ${
        note.current
          ? 'border-transparent shadow-md'
          : lit || pinned
            ? 'border-twilio-blue shadow-md'
            : 'border-twilio-gray-20 opacity-90 shadow-none hover:border-twilio-blue/60'
      } ${pinned ? 'ring-2 ring-twilio-blue/40' : ''}`}
      style={
        note.current && note.color
          ? /* Ringed in the path's own colour, which is the only thing tying a card to the glowing
               token on the canvas when two paths are playing. */
            { boxShadow: `0 0 0 2px ${note.color}, 0 2px 8px rgba(0,0,0,0.08)` }
          : undefined
      }
    >
      {named && note.pathName && (
        <div className="flex items-center gap-1.5 pb-1">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: note.color }}
            aria-hidden="true"
          />
          <span className="truncate text-[10px] font-semibold text-twilio-gray-60">
            {note.pathName}
          </span>
        </div>
      )}

      {/* One card component for every home a note has ever had. Two copies of this markup would
          drift, and the difference between a note here and a note anywhere else is one of placement
          rather than of content. */}
      <AnchorCard name={note.name} anchor={note.anchor} step={note.step} />

      {onFocusNode && (
        /* The lane is off the diagram, so it needs a way back to it -- otherwise a note about a
           component 3000px away leaves the reader to go and find it by hand. `stopPropagation` so it
           does not also toggle the pin: two things on one click is one thing too many. */
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onFocusNode(note.nodeId)
          }}
          className="mt-1.5 text-[10px] font-semibold text-twilio-blue hover:underline"
        >
          Show on diagram
        </button>
      )}
    </li>
  )
}

/* Node ids are generated (`manual:destination:ab12cd`, `xy-edge__…`) and contain colons, which are
   valid in an attribute value and not in a bare selector. `CSS.escape` where it exists, and a
   conservative quote-and-backslash escape where it does not, so a lookup can never become a syntax
   error that takes the lane down with it. */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return String(value).replace(/["\\]/g, '\\$&')
}
