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

import { RotateCcw } from 'lucide-react'

import { borderColorFor } from '../canvas/kinds.js'
import { Section } from './primitives.jsx'

const LINE_STYLES = ['solid', 'dashed', 'dotted']

const DASH_FOR_PREVIEW = {
  solid: undefined,
  dashed: '10 6',
  dotted: '2 4',
}

export default function EdgeStyleTab({ edge, nodes, onUpdate }) {
  const override = edge.data ?? {}
  /* The same two-hop lookup FlowEdge does at render time: the source component's own
     override first, then the zone it sits in, then its kind's bare default. Read off
     `nodes` rather than off the edge, because none of it is a fact about the edge --
     it is what the edge would draw if nobody had touched this tab. */
  const sourceNode = nodes?.find((node) => node.id === edge.source)
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

  const set = (patch) => onUpdate(patch)

  return (
    <>
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
