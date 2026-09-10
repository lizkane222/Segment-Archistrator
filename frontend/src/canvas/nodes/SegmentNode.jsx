/*
 * The one node renderer. Every component kind draws through here.
 *
 * One component rather than sixteen because the differences between a source and
 * an audience are entirely data -- colour, shape, icon, which badges apply -- and
 * sixteen near-identical files would drift. `kinds.js` holds the differences.
 *
 * memo() is load-bearing: React Flow re-renders every node on any store change,
 * including each frame of a drag, so an unmemoized renderer makes large diagrams
 * stutter. Hover state for the anchor is local for the same reason -- lifting it
 * would put a store write on every mouse move across the canvas.
 */

import { memo, useMemo, useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import { ChevronDown, ChevronRight, Link2, Lock, TriangleAlert } from 'lucide-react'

import AnchorTooltip from './AnchorTooltip.jsx'
import ConnectionHandles from './ConnectionHandles.jsx'
import IdentityRuleTable from './IdentityRuleTable.jsx'
import { InternalSections } from './GroupStackNode.jsx'
import { useChrome } from '../chrome.js'
import {
  MAX_AUTO_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  componentSize,
} from '../layout.js'
import { SHAPES, iconFor, outlineFor, styleFor } from '../kinds.js'
import { visibleCardFields } from '../../inspector/cardFields.js'
import { useAnchorFocused, useAnchors } from '../anchors.js'
import { useFlashing } from '../flash.js'
import { describeKind, describeStep } from '../../simulation/narration.js'

/*
 * Which printed fields ride on the card's existing meta line rather than getting a row of their own.
 *
 * `type` and `sourceType` are the pair that line has always shown, so keeping them there means a
 * card with the default eyes set looks exactly as it did before any of this existed. Everything else
 * is a new row underneath.
 */
const LEAD_FIELDS = new Set(['type', 'sourceType', 'warehouseType'])

/*
 * Which rows print their label.
 *
 * A description speaks for itself and a label in front of it is clutter; "Daily" or "us-west-2" does
 * not, and unlabelled it is a mystery string on a drawing. The test is whether a reader who has
 * never opened the inspector could say what the value means.
 */
const LABELLED_FIELDS = new Set([
  'zone',
  'segmentName',
  'status',
  'computeCadence',
  'deployedAt',
  'slug',
  'traitKey',
  'audienceKey',
  'categories',
])

function SegmentNode({ id, data, selected, dragging }) {
  const style = styleFor(data.kind, data.style)
  const outline = outlineFor(data)
  const Icon = iconFor(data.kind)
  const shapeClass = SHAPES[style.shape] ?? SHAPES.rounded

  const hasChildren = (data.children?.length ?? 0) > 0
  /* Both halves of the condition, and the second is the load-bearing one: see chrome.js.
     `bound === false` alone is true of every card on a canvas with no workspace behind it. */
  const { showFlags, rename } = useChrome()
  const isPlaceholder = data.bound === false && showFlags
  const locked = Boolean(data.locked)

  const { topology, showAll, focus } = useAnchors()
  const [hovered, setHovered] = useState(false)
  const anchor = useMemo(() => describeKind(data, { topology }), [data, topology])
  const step = useMemo(() => describeStep(data.anchorStep, data), [data])

  /* True when this component's note in the gutter is the one under the cursor, or the one
     the user clicked to hold open -- the other half of the request that moved the notes out
     there. A boolean rather than the focused id, so the other components on the canvas do
     not re-render to find out it was not them. See canvas/anchors.js. */
  const noted = useAnchorFocused(id)
  /* Pulses when a message names this component -- see canvas/flash.js. */
  const flashing = useFlashing(id)

  /*
   * The playhead wins over everything -- an anchor pinned open by the walkthrough must not
   * vanish because the cursor moved on. After that: while the gutter is showing, it owns
   * the architecture note, and drawing a second copy of the same card over the component
   * would put back exactly the overlap the gutter exists to remove.
   *
   * Suppressed mid-drag: a tooltip that follows the node it is describing across the
   * canvas hides whatever the node is being dragged towards.
   */
  const anchorVisible = data.anchor === 'step' || (!showAll && hovered && !dragging)

  /*
   * Renaming in place.
   *
   * `editing` holds the draft rather than writing through on every keystroke: a store write
   * per character would re-run `growZones` and the whole change pipeline mid-word, and would
   * put one undo entry on the history stack per letter typed.
   *
   * Committed on blur as well as on Enter. A user who types a name and then clicks the
   * canvas has finished, and discarding the edit because they did not press Enter is the
   * kind of loss that makes an inline field not worth using. Escape is the way to abandon
   * one, which is the only gesture that means it.
   */
  const [editing, setEditing] = useState(null)

  const commit = () => {
    const next = editing?.trim()
    setEditing(null)
    /* Unchanged, or emptied: neither is a rename. A blank name would leave a card with no
       label and nothing to double-click to get the field back. */
    if (!next || next === data.name) return
    rename?.(id, next)
  }

  /* Published only while the gutter is up, because that is the only thing listening.
     Cleared by id rather than unconditionally -- the pointer can move from a component
     straight onto its own note, and the mouseleave here arrives after that mouseenter. */
  const enter = () => {
    setHovered(true)
    if (showAll) focus.set(id)
  }
  const leave = () => {
    setHovered(false)
    focus.clear(id)
  }

  /*
   * Scenarios that have touched this node, in their own colours.
   *
   * Split by `arrived`, because a trace records the nodes it never reached and why
   * -- so a node can be in this list precisely because the event did *not* get
   * there. Lighting those up would say the opposite of what the trace says. They
   * dim instead, and only a path that actually arrived draws a ring.
   */
  const paths = data.paths ?? null
  const lit = paths?.filter((entry) => entry.arrived) ?? null
  const glowing = lit?.length ? lit : null

  /* Absent until someone drags a handle, and that is the point: with no chosen height a
     card is `minHeight` and grows with `InternalSections`, so an Identity Resolver is as
     tall as its buckets need. A chosen height is a size the user picked, so it wins even
     when the contents want more -- and the content column clips instead of spilling. */
  const chosen = componentSize(data)

  /* What the eyes in the inspector asked to be printed here -- see inspector/cardFields.js. Memoised
     because it walks the whole field table, and this component re-renders on every frame of a drag. */
  const fields = useMemo(() => visibleCardFields(data), [data])

  return (
    <>
      {/* Outside the card, as in ZoneNode: the handles position against React Flow's own
          node element, and the card is a flex row -- a control mounted inside it that ever
          stopped being `position: absolute` would become a flex item and shove the label
          along. Four corner handles for both axes at once, plus the four edge *lines* for one axis
          at a time -- see `lineStyle` below for why the lines are drawn now when they used to be
          hidden. */}
      <NodeResizer
        /* A locked card shows no handles. Lock is about placement, and a resize is a
           placement -- offering the handles and then having them do nothing would be worse
           than not offering them. */
        isVisible={selected && !locked}
        minWidth={MIN_NODE_WIDTH}
        minHeight={MIN_NODE_HEIGHT}
        color={style.border}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        /*
         * The edge lines are visible and draggable now, which is what makes width-only and
         * height-only resizing possible -- the four corner handles can only ever change both at
         * once. They used to be `display: none`, on the grounds that a handle at each edge
         * midpoint would sit on top of the connection handles. That is still true of the *handle*,
         * so the connection dot keeps its `zIndex` and wins those few pixels; the rest of each
         * edge line is free, which is plenty to grab.
         */
        lineStyle={{ borderWidth: 1, opacity: 0.35 }}
      />

      <div
        className={`group relative flex items-center gap-2 border px-3 py-2 transition-shadow ${shapeClass} ${
          selected ? 'shadow-lg ring-2 ring-twilio-blue ring-offset-1' : 'shadow-sm'
        } ${flashing ? 'flash-border' : ''}`}
        style={{
          /*
           * Two sizing modes, and which one applies is simply whether the user has dragged a
           * handle.
           *
           * Chosen: exactly what they dragged, and the content clips inside it. A size someone
           * picked has to be honoured even when the text does not fit, or the resize handles
           * would fight the label.
           *
           * Not chosen: `fit-content` between a floor and a cap, so the card is as wide as its
           * own name needs. This is what stops a long name being truncated. Past the cap the
           * text wraps and the card grows *taller* instead -- see MAX_AUTO_NODE_WIDTH.
           *
           * Note what is deliberately absent: any measuring. An earlier attempt read
           * `scrollWidth` and wrote a bigger width back into the document, which is a
           * render-measure-write loop that has to be damped to stop oscillating, marks the
           * diagram dirty on open, and bakes one browser's font metrics into a saved file. CSS
           * already knows how wide the text is; React Flow reads the resulting box back through
           * `measured`, which is what `minZoneSize` and `childExtent` already consult.
           */
          width: chosen.width ?? (style.defaultWidth ? style.defaultWidth : 'fit-content'),
          minWidth: chosen.width ?? style.defaultWidth ?? NODE_WIDTH,
          maxWidth: chosen.width ?? MAX_AUTO_NODE_WIDTH,
          height: chosen.height ?? undefined,
          minHeight: chosen.height ?? NODE_HEIGHT,
          background: style.bg,
          color: style.text,
          borderColor: glowing?.[0]?.color ?? style.border,
          /* One ring per arriving scenario, stacked outward, so a node two paths
             reached shows both rather than the first one only. */
          boxShadow: glowing
            ? glowing.map((entry, index) => `0 0 0 ${(index + 1) * 3}px ${entry.color}55`).join(', ')
            : undefined,
          opacity: paths && !glowing ? 0.5 : undefined,
          /* An outline rather than a ring class or another box-shadow, because both of those
             are already spoken for: `selected` uses the ring and a scenario's arrival uses an
             inline box-shadow, and whichever of the three was written last would silently win.
             An outline stacks with both, so a hovered note can highlight a component that is
             also selected and also on a traced path. */
          outline: noted ? '4px solid rgba(2, 99, 224, 0.4)' : undefined,
          outlineOffset: noted ? 2 : undefined,
          /* Dashed = a template placeholder not yet bound to a real component, which
             doubles as the "planned but not built" annotation the brief wants -- unless
             the Style tab has said otherwise. See `outlineFor`. */
          borderStyle: outline.borderStyle,
          borderWidth: outline.borderWidth,
        }}
        /* The right-click target for Edit-Stage. React Flow's onNodeContextMenu
           handles the event; this only suppresses the browser menu. */
        onContextMenu={(event) => event.preventDefault()}
        onMouseEnter={enter}
        onMouseLeave={leave}
        data-kind={data.kind}
        data-node-id={id}
      >
        <AnchorTooltip visible={anchorVisible} name={data.name} anchor={anchor} step={step} />

        {/* Faint until hovered: four dots on a 200px card is a lot of furniture. */}
        <ConnectionHandles border={style.border} dim />

        <Icon size={16} aria-hidden="true" className="shrink-0 opacity-80" />

        {/* Clipped here rather than on the card, because the card is what the "Unbound"
            badge, the anchor tooltip and the scenario dots hang outside of -- clipping there
            would cut all four off to contain text that only overflows on a hand-shrunk
            node. */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {editing !== null ? (
            /* `nodrag`/`nopan` so a drag inside the field selects text rather than hauling
               the card, and `stopPropagation` on the pointer so React Flow does not treat
               the click that places the caret as a click on the node -- which would
               re-select and, on a group member, re-select every mate. */
            <input
              autoFocus
              value={editing}
              onChange={(event) => setEditing(event.target.value)}
              onBlur={commit}
              onFocus={(event) => event.target.select()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                /* Contained here, all of it. Without this Backspace in the field reaches
                   React Flow's `deleteKeyCode` and deletes the component being renamed. */
                event.stopPropagation()
                if (event.key === 'Enter') commit()
                if (event.key === 'Escape') setEditing(null)
              }}
              className="nodrag nopan w-full rounded border border-twilio-blue bg-white px-1 py-0 text-[13px] font-semibold leading-tight text-twilio-navy outline-none"
            />
          ) : (
            <div
              /* `break-words` rather than `truncate` when the card is sizing itself: at the cap
                 the name has to wrap onto a second line, and `truncate` would ellipsize it there
                 instead -- which is the cut-off text this is meant to fix, just 140px later.
                 A card the user has sized keeps truncating, because their width is the
                 instruction. */
              className={`text-[13px] font-semibold leading-tight ${
                chosen.width ? 'truncate' : 'break-words'
              }`}
              title={data.name}
              /* Double-click rather than a pencil affordance: it is what every diagramming
                 tool binds this to, and a card 200px wide has no room for another icon. The
                 inspector's field stays the way to edit a name without hunting for the card,
                 and both write through the same `setNodes`. */
              onDoubleClick={(event) => {
                if (!rename) return
                event.stopPropagation()
                setEditing(data.name ?? '')
              }}
            >
              {data.name}
            </div>
          )}
          {/*
              The fields whose eye is open, in the registry's order.
              
              The first one keeps the old meta line's styling -- small, uppercase, faded -- because
              for almost every component it *is* the old meta line: `type` and `sourceType` are both
              on by default, and that pair is what this row has always shown. The rest are printed
              underneath in sentence case, because a description in uppercase tracking is unreadable
              and a description is the field this was asked for.
          */}
          {fields.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] uppercase tracking-wide opacity-60">
              {fields
                .filter((entry) => LEAD_FIELDS.has(entry.id))
                .map((entry) => (
                  <span
                    key={entry.id}
                    title={`${entry.label}: ${entry.value}`}
                    className={chosen.width ? 'truncate' : 'break-words'}
                  >
                    {entry.value}
                  </span>
                ))}
              {/* Never the real write key -- the server masks it before it is
                  serialized, and the reveal is a separate audited request. */}
              {data.writeKeyMasked && (
                <span className="font-mono normal-case tracking-normal">{data.writeKeyMasked}</span>
              )}
            </div>
          )}

          {fields
            .filter((entry) => !LEAD_FIELDS.has(entry.id))
            .map((entry) => (
              <div
                key={entry.id}
                title={`${entry.label}: ${entry.value}`}
                className={`mt-1 text-[10px] leading-snug opacity-75 ${
                  /* A card the user has sized clips; one sizing itself wraps. Same rule as the
                     title, and for the same reason -- their width is the instruction. */
                  chosen.width ? 'line-clamp-2' : 'break-words'
                }`}
              >
                {/* The label only where the value cannot speak for itself. "The marketing site"
                    needs no "Description:" in front of it; "Daily" very much needs "Cadence". */}
                {LABELLED_FIELDS.has(entry.id) && (
                  <span className="font-semibold uppercase tracking-wide opacity-70">
                    {entry.label}:{' '}
                  </span>
                )}
                {entry.value}
              </div>
            ))}
          {/* The Identity Resolver's buckets and a profile's identifiers/traits/events.
              Renders nothing for a kind that has none, which is most of them. */}
          <InternalSections data={data} topology={topology} />
          {/* An identity resolution rule *is* its rows -- see IdentityRuleTable. Drawn
              inline rather than behind a chip like the sections above, because the rows
              are the whole content of the component and a popover would hide it. */}
          {data.kind === 'identity_setting' && <IdentityRuleTable data={data} />}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* Shown unconditionally, unlike the Unbound flag. A card that will not move needs
              to say so on its face -- otherwise the only way to find out is to try to drag
              it and watch nothing happen, which reads as the canvas being broken. */}
          {locked && (
            <span title="Placement locked. Right-click to unlock.">
              <Lock size={11} className="opacity-50" aria-hidden="true" />
            </span>
          )}
          {/* `inferred` marks a journey guessed from computed-trait names. Flagging
              it on the node keeps a heuristic from reading as a finding. */}
          {data.inferred && (
            <span title="Inferred from trait names — Segment has no Journeys API.">
              <TriangleAlert size={12} className="text-twilio-warning" aria-hidden="true" />
            </span>
          )}
          {data.workspaceUrl && (
            <a
              href={data.workspaceUrl}
              target="_blank"
              rel="noreferrer"
              /* nodrag: without it React Flow swallows the click as a drag start. */
              className="nodrag opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
              title={
                data.linkVerified
                  ? 'Open in Segment'
                  : 'Open in Segment (link pattern unverified)'
              }
              onClick={(event) => event.stopPropagation()}
            >
              <Link2 size={12} aria-hidden="true" />
            </a>
          )}
          {hasChildren && (
            <button
              type="button"
              className="nodrag opacity-60 hover:opacity-100"
              title={data.collapsed ? 'Expand nested components' : 'Collapse nested components'}
              onClick={(event) => {
                event.stopPropagation()
                data.onToggleCollapse?.(id)
              }}
            >
              {data.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>

        {isPlaceholder && (
          <span className="absolute -top-2 left-2 rounded bg-twilio-warning px-1 text-[9px] font-semibold uppercase tracking-wide text-white">
            Unbound
          </span>
        )}

        {/* Named, not just coloured. Six paths at once are six shades of ring, and
            anyone who cannot tell two of them apart has no other way to ask which is
            which -- the drawer lists them, and this is the answer in place. */}
        {paths && (
          <span className="absolute -top-1.5 right-1.5 flex gap-0.5">
            {paths.map((entry) => (
              <span
                key={entry.scenarioId}
                title={`${entry.name} — ${entry.arrived ? 'reached here' : 'did not reach here'}`}
                className="h-1.5 w-1.5 rounded-full ring-1 ring-white"
                style={{ background: entry.color, opacity: entry.arrived ? 1 : 0.4 }}
              />
            ))}
          </span>
        )}
      </div>
    </>
  )
}

export default memo(SegmentNode)
