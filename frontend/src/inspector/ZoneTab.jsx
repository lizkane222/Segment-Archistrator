/*
 * The Edit-Stage panel for a zone rather than a component.
 *
 * Zones became selectable when they became part of the document, so the inspector
 * has to answer for them too. Size is shown but not editable here: the resize
 * handles already own it and know the floor imposed by the zone's children, and a
 * second editing path would need its own copy of that check -- one that could
 * disagree, drag a component inward, and rearrange the diagram.
 */

import { RotateCcw } from 'lucide-react'

import { EditableText, EmptyNote, Row, Section } from './primitives.jsx'
import { ZONE_STYLES, ZONE_SWATCHES, zoneStyleFor } from '../canvas/kinds.js'
import { zoneProductOf } from '../canvas/frames.js'
import { zoneSize } from '../canvas/layout.js'

export default function ZoneTab({ node, onUpdate }) {
  const data = node.data
  const { width, height } = zoneSize(node)
  const style = zoneStyleFor(data)
  /* By product, so the second copy of a zone reports as the product it is a copy of. Reading the raw
     id meant `destinations~2` was not a product zone, and its colour-reset button offered a generic
     "Default" instead of the Segment default it actually falls back to -- `zoneStyleFor` in
     canvas/kinds.js has resolved by product all along. */
  const isProduct = Boolean(ZONE_STYLES[zoneProductOf(data.id)])

  return (
    <>
      <Section title="Zone">
        <EditableText
          resetKey={node.id}
          label="Name"
          value={data.label ?? ''}
          placeholder="Untitled zone"
          /* `labelRich` goes with it: it is what the header draws when it exists, so a name
             retyped here while a formatted one was stored would leave the canvas showing the old
             text and this field looking broken. Same rule as a component's name. */
          onCommit={(label) => onUpdate({ label, labelRich: undefined })}
        />
        <EditableText
          resetKey={node.id}
          label="Description"
          value={data.description ?? ''}
          placeholder="What lives in this region"
          multiline
          onCommit={(description) => onUpdate({ description })}
        />
        <Row label="Kind" value={data.custom ? 'Custom region' : 'Segment pipeline zone'} />
        <Row label="Contains" value={`${data.kindCount ?? 0} components`} />

        {data.custom && (
          <EmptyNote>
            Outside Segment, so Segment&rsquo;s zone rules do not apply here — any
            component can be dropped in, and the server accepts it on save.
          </EmptyNote>
        )}
      </Section>

      <Section
        title="Colour"
        note="The border colour. The fill is a wash of the same hue."
        actions={
          data.color && (
            <button
              type="button"
              onClick={() => onUpdate({ color: undefined })}
              className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
            >
              <RotateCcw size={11} aria-hidden="true" />
              {isProduct ? 'Segment default' : 'Default'}
            </button>
          )
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {ZONE_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onUpdate({ color })}
              title={color}
              aria-pressed={data.color === color}
              className={`nodrag h-6 w-6 rounded border-2 ${
                data.color === color ? 'border-twilio-navy' : 'border-transparent'
              }`}
              style={{ background: color }}
            />
          ))}
        </div>
      </Section>

      <Section title="Size" note="Drag any edge or corner of the zone on the canvas.">
        <Row label="Width" value={`${Math.round(width)} px`} />
        <Row label="Height" value={`${Math.round(height)} px`} />
        <Row label="Position">
          <span className="font-mono text-[11px] text-twilio-navy">
            {Math.round(node.position?.x ?? 0)}, {Math.round(node.position?.y ?? 0)}
          </span>
        </Row>
        <div
          className="mt-2 h-10 rounded border-2 border-dashed"
          style={{ background: style.bg, borderColor: style.border }}
        />
      </Section>
    </>
  )
}
