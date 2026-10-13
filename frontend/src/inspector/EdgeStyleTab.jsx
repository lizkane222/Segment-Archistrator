/*
 * Style: per-connector colour, dash pattern and arrow direction.
 *
 * The same override/reset shape as StyleTab -- an override is additive and Reset is a
 * delete rather than a re-assignment, so a change to the *default* (the source
 * component's own colour, via `borderColorFor`) still reaches every connector that
 * never overrode it. There is no "apply to every edge" here, unlike StyleTab's "apply to
 * every kind": a connector's default is already inherited from where it starts, which is
 * the bulk behaviour a flat colour picker would otherwise be standing in for.
 */

import { ArrowLeftRight, RotateCcw } from 'lucide-react'

import { borderColorFor } from '../canvas/kinds.js'
import { SIDES, endpointSidePatch, parseFreeHandle } from '../canvas/handles.js'
import { sideOf } from '../canvas/direction.js'
import { looseEnds } from '../canvas/edges/looseEnds.js'
import { edgeActionRows } from './edgeActions.js'
import { Row, Section } from './primitives.jsx'

const LINE_STYLES = ['solid', 'dashed', 'dotted']

/* The three route shapes, paired with what a reader calls them rather than with the stored id --
   `orthogonal` is the field's value and nobody would pick it off a menu. Mirrors `LINE_STYLES` in
   canvas/edges/routing.js, which is the list that actually decides what is drawn. */
const ROUTE_SHAPES = [
  ['orthogonal', 'Right angles'],
  ['curved', 'Curved'],
  ['straight', 'Straight'],
]

const DASH_FOR_PREVIEW = {
  solid: undefined,
  dashed: '10 6',
  dotted: '2 4',
}

export default function EdgeStyleTab({
  edge,
  nodes,
  onUpdate,
  onUpdateEnds,
  onReverse,
  sourceName,
  targetName,
  /* The same context the right-click menu is given, plus a way to run one of its commands -- the
     Actions section below is that menu, laid out as buttons. Absent, the section is not drawn. */
  commandContext = null,
  onRunCommand = null,
  onPreview = null,
}) {
  const override = edge.data ?? {}
  const free = looseEnds(edge)
  /* The same two-hop lookup FlowEdge does at render time: the source component's own
     override first, then the zone it sits in, then its kind's bare default. Read off
     `nodes` rather than off the edge, because none of it is a fact about the edge --
     it is what the edge would draw if nobody had touched this tab. */
  /* A connector loose at its source takes its colour from where it arrives -- as FlowEdge does. */
  const sourceNode = nodes?.find((node) => node.id === (free.source ? edge.target : edge.source))
  const zoneNode = nodes?.find((node) => node.id === sourceNode?.parentId)
  const defaultColor = borderColorFor(sourceNode?.data, zoneNode?.data)

  const color = override.color ?? defaultColor
  const lineStyle = override.strokeStyle ?? 'solid'
  const arrowStart = override.arrowStart ?? false
  const arrowEnd = override.arrowEnd ?? true

  const hasOverride =
    override.color != null ||
    override.strokeStyle != null ||
    override.arrowStart != null ||
    override.arrowEnd != null

  const shape = override.line ?? 'orthogonal'
  const bends = override.waypoints?.length ?? 0
  /* Absent means a hand placed them -- see `serializeEdge`. Read here only to word the note below,
     because "these will be recalculated" and "these are yours" are opposite promises. */
  const routedBy = bends > 0 ? (override.routed ?? 'hand') : null

  const set = (patch) => onUpdate(patch)

  /* A connector read from the workspace cannot be turned round: its direction is a fact about the
     customer's setup rather than a drawing decision. The same rule the menu item states, said here
     because this is the other place the operation is offered. */
  const discovered = (override.discovered ?? edge.discovered) === true

  /* Which side each end currently meets, and whether that was *chosen* or merely where the
     defaults landed. `sideOf` resolves the handle exactly as the canvas does -- including the
     pre-four-sides default of east/west for a null one -- so the buttons agree with the drawing.
     An anchor is what distinguishes a decision from a default: see `endpointSidePatch`. */
  const ends = [
    {
      end: 'source',
      label: 'Leaves from',
      name: sourceName,
      side: sideOf(edge, edge.source)?.side ?? null,
      chosen: Boolean(parseFreeHandle(override.sourceAnchor)),
      loose: free.source,
    },
    {
      end: 'target',
      label: 'Arrives at',
      name: targetName,
      side: sideOf(edge, edge.target)?.side ?? null,
      chosen: Boolean(parseFreeHandle(override.targetAnchor)),
      loose: free.target,
    },
  ]

  const actionRows = commandContext && onRunCommand ? edgeActionRows({ ...commandContext, edge }) : []

  return (
    <>
      {/*
        * Which way it points, and which side each end meets.
        *
        * First, above colour, because these are the two questions about a connector that have a
        * *right* answer -- a line pointing the wrong way is a component the walkthrough can never
        * reach, and an end on the wrong side is a line that crosses the card it just left. Colour
        * and dash pattern are preferences. Both operations existed only in the right-click menu
        * and on the canvas, which is not where anyone looks to find out whether they are possible.
        */}
      <Section title="Ends">
        <Row label="Direction">
          <span className="min-w-0 flex-1 truncate pt-px text-twilio-navy" title={`${sourceName} → ${targetName}`}>
            {sourceName} → {targetName}
          </span>
          <button
            type="button"
            onClick={onReverse}
            disabled={discovered}
            title={
              discovered
                ? 'This connection was read from your workspace, so its direction is a fact rather than a choice.'
                : 'Point this connector the other way.'
            }
            className="nodrag ml-auto flex shrink-0 items-center gap-1 rounded border border-twilio-gray-20 px-2 py-0.5 text-[11px] text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeftRight size={10} aria-hidden="true" />
            Reverse
          </button>
        </Row>

        {ends.map((entry) =>
          entry.loose ? (
            /* A loose end has no component and so no side to pick -- see canvas/edges/looseEnds.js. */
            <Row key={entry.end} label={entry.label}>
              <span className="pt-px italic text-twilio-gray-60" data-testid={`loose-${entry.end}`}>
                Not connected yet — drag the dashed ring onto a component
              </span>
            </Row>
          ) : (
          <Row key={entry.end} label={entry.label}>
            <div className="flex overflow-hidden rounded border border-twilio-gray-20">
              {/* `Auto` is not a fifth side -- it is the absence of a choice, which hands the end
                  back to whichever side faces the other component and to the fan-out that shares
                  a busy side between several connectors. So it leads. */}
              <button
                type="button"
                onClick={() => onUpdateEnds?.(endpointSidePatch(entry.end, null))}
                aria-pressed={!entry.chosen}
                title="Follow whichever side faces the other component, and spread out when several connectors share it."
                className={`px-2 py-0.5 text-[11px] transition-colors ${
                  entry.chosen
                    ? 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                    : 'bg-twilio-blue text-white'
                }`}
              >
                Auto
              </button>
              {SIDES.map((side) => (
                <button
                  key={side.id}
                  type="button"
                  onClick={() => onUpdateEnds?.(endpointSidePatch(entry.end, side.position))}
                  /* Compared against `position`, which is what `sideOf` returns and what the click
                     writes -- not against `label`, which is the word on the button. The two are the
                     same string for all four sides today, so getting this wrong would look correct
                     until somebody renamed one. */
                  aria-pressed={entry.chosen && entry.side === side.position}
                  title={`Meet the ${side.label} of ${entry.name}`}
                  className={`border-l border-twilio-gray-20 px-2 py-0.5 text-[11px] capitalize transition-colors ${
                    entry.chosen && entry.side === side.position
                      ? 'bg-twilio-blue text-white'
                      : 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                  }`}
                >
                  {side.label}
                </button>
              ))}
            </div>
          </Row>
          ),
        )}
        <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
          {ends.some((entry) => entry.chosen)
            ? 'A side you have picked stays put when the components move. On Auto, an end follows whichever side faces the other component.'
            : 'On Auto, each end follows whichever side faces the other component and moves with it. Pick a side to pin it — or drag the ring at either end of the line on the canvas to place it exactly.'}
        </p>
      </Section>

      <Section
        title="This connector"
        actions={
          hasOverride && (
            <button
              type="button"
              /* Deletes the four fields rather than writing the resolved defaults back
                 in, so the connector keeps tracking its source's colour if that source
                 is later dragged into a different zone. */
              onClick={() =>
                onUpdate({
                  color: undefined,
                  strokeStyle: undefined,
                  arrowStart: undefined,
                  arrowEnd: undefined,
                })
              }
              className="nodrag flex items-center gap-1 text-[10px] text-twilio-gray-60 hover:text-twilio-blue"
            >
              <RotateCcw size={11} aria-hidden="true" />
              Reset
            </button>
          )
        }
      >
        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Label</span>
          <input
            type="text"
            value={override.label ?? ''}
            placeholder="None"
            /* `undefined` rather than '' when cleared, so an unlabelled connector stores nothing. */
            onChange={(event) => set({ label: event.target.value || undefined })}
            className="nodrag min-w-0 flex-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-xs text-twilio-navy placeholder:text-twilio-gray-40 focus:border-twilio-blue focus:outline-none"
            title="Text drawn on the connector"
          />
        </div>

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Colour</span>
          <input
            type="color"
            value={color}
            onChange={(event) => set({ color: event.target.value })}
            className="nodrag h-6 w-10 shrink-0 cursor-pointer rounded border border-twilio-gray-20 bg-white"
            title="Line colour"
          />
          <span className="font-mono text-[10px] uppercase text-twilio-gray-60">{color}</span>
          {override.color ? (
            <span
              className="ml-auto text-[9px] uppercase tracking-wide text-twilio-warning"
              title="Overrides the source component's colour"
            >
              custom
            </span>
          ) : (
            <span className="ml-auto text-[9px] italic text-twilio-gray-60">from source</span>
          )}
        </div>

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Pattern</span>
          <div className="flex flex-wrap gap-1">
            {LINE_STYLES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => set({ strokeStyle: option })}
                title={`${option} line`}
                className={`nodrag rounded border px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                  lineStyle === option
                    ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                    : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 py-1 text-xs">
          <span className="w-28 shrink-0 text-twilio-gray-60">Arrows</span>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => set({ arrowStart: !arrowStart })}
              title="Arrow at the source end"
              className={`nodrag rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                arrowStart
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                  : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
              }`}
            >
              Start
            </button>
            <button
              type="button"
              onClick={() => set({ arrowEnd: !arrowEnd })}
              title="Arrow at the target end"
              className={`nodrag rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                arrowEnd
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                  : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
              }`}
            >
              End
            </button>
          </div>
        </div>
      </Section>

      {/*
        * Route: the shape of the line, and the bends in it.
        *
        * Here because this panel is where a reader looks, and until now it offered colour, pattern and
        * arrows and said nothing whatever about routing -- so a user who could not find the on-canvas
        * bend handles had every reason to conclude connectors could not be re-routed at all. They
        * always could. The line-style switch existed only in the right-click menu, which is not
        * somewhere anyone looks to answer "can I change this".
        *
        * The sentence at the bottom is doing real work: the handles are on the canvas, and no panel
        * control can substitute for dragging one. What a panel can do is say they are there.
        */}
      <Section title="Route">
        <Row label="Shape">
          <div className="flex overflow-hidden rounded border border-twilio-gray-20">
            {ROUTE_SHAPES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => set({ line: value })}
                aria-pressed={shape === value}
                className={`px-2 py-0.5 text-[11px] transition-colors ${
                  shape === value
                    ? 'bg-twilio-blue text-white'
                    : 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        {/* The count and the button are both children rather than `value` plus children, because `Row`
            resolves them with `children ?? value` -- and a `false` from a short-circuited `&&` is not
            nullish, so a conditional child silently blanks the row instead of falling back. */}
        <Row label="Bends">
          <span className="pt-px text-twilio-navy">
            {bends === 0 ? 'None' : `${bends}${routedBy === 'auto' ? ' (automatic)' : ''}`}
          </span>
          {bends > 0 && (
            <button
              type="button"
              /* Clears the router's marker along with the bends. A straightened connector is a
                 decision, and leaving `routed: 'auto'` behind would let the next component move
                 re-derive the very route that was just flattened. */
              onClick={() => set({ waypoints: undefined, routed: undefined })}
              className="ml-auto shrink-0 rounded border border-twilio-gray-20 px-2 py-0.5 text-[11px] text-twilio-gray-60 transition-colors hover:border-twilio-gray-40"
            >
              Straighten
            </button>
          )}
        </Row>
        <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
          Click the connector on the canvas to show its handles: drag a diamond to move a corner, a
          bar to slide a whole segment sideways, a small square to add a step (two new corners) so the
          line can go round something, or a dot to add a bend. Double-click a bend to remove it. Drag
          either ring to re-attach an end, or drop it on empty canvas to leave it unconnected.{' '}
          {routedBy === 'auto'
            ? 'These bends were placed automatically to get around a component, and will be recalculated when either end moves — dragging any of them makes the route yours and stops that.'
            : 'A route you have adjusted by hand is never recalculated when components move.'}
        </p>
      </Section>

      {/*
        * Everything the connector's right-click menu offers, as buttons.
        *
        * Generated from the menu's own command table (see edgeActions.js), so nothing the menu can do
        * is missing here and a refusal reads the same in both places. A submenu becomes a row of
        * options; hovering a Flow option previews it on the canvas exactly as hovering the menu row
        * does.
        */}
      {actionRows.length > 0 && (
        <Section title="Actions">
          {actionRows.map((row) =>
            row.children ? (
              <div key={row.id} className="py-1 text-xs">
                <span className="mb-1 block text-twilio-gray-60">{row.label}</span>
                <div className="flex flex-wrap gap-1">
                  {row.children.map((child) => (
                    <ActionButton
                      key={child.id}
                      item={child}
                      disabled={!row.enabled || !child.enabled}
                      reason={row.enabled ? child.reason : row.reason}
                      onRun={onRunCommand}
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div key={row.id} className="py-1">
                <ActionButton
                  item={row}
                  disabled={!row.enabled}
                  reason={row.reason}
                  onRun={onRunCommand}
                  onPreview={onPreview}
                  wide
                />
              </div>
            ),
          )}
        </Section>
      )}

      <Section title="Preview">
        <div className="flex justify-center rounded-md bg-twilio-gray-10 p-3">
          <svg width={180} height={32} viewBox="0 0 180 32" aria-hidden="true">
            <line
              x1={16}
              y1={16}
              x2={164}
              y2={16}
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={DASH_FOR_PREVIEW[lineStyle]}
            />
            {arrowStart && <polygon points="16,16 24,11 24,21" fill={color} />}
            {arrowEnd && <polygon points="164,16 156,11 156,21" fill={color} />}
          </svg>
        </div>
      </Section>
    </>
  )
}

/* One command as a button. The refusal is the tooltip, as it is the greyed row's hint in the menu. */
function ActionButton({ item, disabled, reason, onRun, onPreview, wide = false }) {
  const danger = item.id === 'delete-edge'
  return (
    <button
      type="button"
      data-command={item.id}
      disabled={disabled}
      title={disabled ? (reason ?? undefined) : (item.hint ?? undefined)}
      onClick={() => {
        onPreview?.(null)
        onRun(item.id)
      }}
      onMouseEnter={() => !disabled && item.preview && onPreview?.(item.preview)}
      onMouseLeave={() => item.preview && onPreview?.(null)}
      className={`nodrag rounded border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        wide ? 'w-full text-left' : ''
      } ${
        danger
          ? 'border-twilio-gray-20 text-twilio-red hover:border-twilio-red'
          : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40 hover:text-twilio-navy'
      }`}
    >
      {item.label}
    </button>
  )
}
