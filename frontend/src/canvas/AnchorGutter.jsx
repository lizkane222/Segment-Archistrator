/*
 * The anchor notes, stacked outside the drawing, with a leader line to whichever end the
 * cursor is on.
 *
 * Rendered through `ViewportPortal`, so the notes live in flow coordinates and pan and
 * zoom with the diagram they annotate -- they are part of the drawing, in the sense that
 * a LucidChart callout is, and a fixed screen-space column would slide off the components
 * it points at the moment anyone panned.
 *
 * One SVG for the leader line rather than one per note: only ever one line is drawn, and a
 * line has to be able to cross the whole diagram to reach its component.
 *
 * Geometry is in canvas/anchorGutter.js. What is here is the DOM, the focus wiring, and
 * one thing worth stating plainly: this is *not* captured by an export. It used to be true
 * for free (NodeToolbar portals outside `.react-flow__viewport`, which is what
 * exportImage.js captures) and it is now true on purpose -- `diagramBounds` measures nodes,
 * so notes outside those bounds would be cropped off the edge of the PNG rather than
 * appearing in it. Putting them in an export means teaching `diagramBounds` about them,
 * which is a bigger change than this one and has to be asked for.
 */

import { memo, useMemo } from 'react'
import { ViewportPortal } from '@xyflow/react'

import { AnchorCard } from './nodes/AnchorTooltip.jsx'
import { layoutAnchorNotes } from './anchorGutter.js'
import { useAnchorFocused, useAnchorLeader, useAnchorPinned, useAnchors } from './anchors.js'
import { describeKind, describeStep } from '../simulation/narration.js'

/* How far the leader line runs straight out of the note before it turns towards the
   component. Without the stub the line leaves the card at whatever angle the component
   happens to be at, and reads as a stray diagonal rather than as a pointer. */
const STUB = 16

export default function AnchorGutter({ nodes }) {
  const notes = useMemo(() => layoutAnchorNotes(nodes), [nodes])
  const byId = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node])), [nodes])
  const leaderId = useAnchorLeader()

  if (!notes.length) return null

  const leader = leaderId ? notes.find((note) => note.id === leaderId) : null

  return (
    <ViewportPortal>
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width={1}
        height={1}
        style={{ overflow: 'visible' }}
        aria-hidden="true"
      >
        {leader && <Leader line={leader.line} side={leader.side} />}
      </svg>

      {notes.map((note) => (
        <GutterNote key={note.id} note={note} node={byId.get(note.id)} />
      ))}
    </ViewportPortal>
  )
}

/**
 * The line, twice: a wide translucent pass for the glow and a solid one over it.
 *
 * Drawn rather than reused from the edge renderer because this is not an edge -- it says
 * "this note is about that component", where every edge on the canvas says "data flows
 * from here to there", and one line that meant either thing depending on what it touched
 * would be the most misleading mark on the diagram.
 */
function Leader({ line, side }) {
  const turn = side === 'left' ? line.x1 + STUB : line.x1 - STUB
  const points = `${line.x1},${line.y1} ${turn},${line.y1} ${line.x2},${line.y2}`

  return (
    <>
      <polyline points={points} fill="none" stroke="#0263e0" strokeOpacity={0.25} strokeWidth={6} />
      <polyline
        points={points}
        fill="none"
        stroke="#0263e0"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <circle cx={line.x2} cy={line.y2} r={3.5} fill="#0263e0" />
    </>
  )
}

function GutterNoteBody({ note, node }) {
  const { topology, focus } = useAnchors()
  const open = useAnchorFocused(note.id)
  const pinned = useAnchorPinned(note.id)
  const data = node?.data ?? {}
  const anchor = useMemo(() => describeKind(data, { topology }), [data, topology])

  /* Handed to the card as well as the description, because the card is what decides which
     of the two readings wins -- and with a walkthrough loaded the answer is the verdict,
     not the overview. Leaving it out would mean pinning every note during a playback
     showed what each component *does* while the drawer explained what the event *did*. */
  const step = useMemo(() => describeStep(data.anchorStep, data), [data])

  return (
    <div
      /* nopan/nodrag: this sits inside the viewport, so without them a press on a note is
         a press on the pane and reading one drags the whole canvas out from under it. */
      className={`nopan nodrag absolute cursor-pointer rounded-md border bg-white p-2.5 text-left transition-shadow focus:outline-none ${
        open
          ? 'z-10 border-twilio-blue shadow-xl ring-2 ring-twilio-blue/40'
          : 'border-twilio-gray-20 shadow-sm hover:border-twilio-blue/60'
      } ${pinned ? 'ring-twilio-blue' : ''}`}
      style={{
        left: note.x,
        top: note.y,
        width: note.width,
        /* Fixed while idle, because the stacking in anchorGutter.js assumed a height it
           could not measure. Released once the note is focused -- hovered, or clicked to
           hold it open -- so the clamped text can finish its sentence, which is why the
           focused note is also the one raised above its neighbours. */
        height: open ? undefined : note.height,
        minHeight: note.height,
        overflow: 'hidden',
      }}
      /* A div with a role rather than a <button>: the card is a heading over paragraphs,
         and a button wrapping block content is invalid markup that some screen readers
         flatten to its text. The keyboard handler is what a button would have given for
         free and is not optional -- reading a note is the one thing here that a
         pointer-only affordance would make unavailable. */
      role="button"
      tabIndex={0}
      aria-pressed={pinned}
      onMouseEnter={() => focus.set(note.id)}
      onMouseLeave={() => focus.clear(note.id)}
      onClick={() => focus.pin(note.id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        /* Space scrolls the page otherwise, and this note is inside a pannable canvas. */
        event.preventDefault()
        focus.pin(note.id)
      }}
    >
      <AnchorCard name={data.name} anchor={anchor} step={step} clamped={!open} />
    </div>
  )
}

/* memo'd on the note geometry and the node, so a hover -- which re-renders the gutter to
   move the leader line -- does not re-render three hundred cards to arrive at the same
   markup. Each card subscribes to the focus store itself for the two booleans it needs. */
const GutterNote = memo(GutterNoteBody)
