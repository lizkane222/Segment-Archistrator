/*
 * Overview: what this component is, and its identifiers.
 *
 * Name and description are editable because the brief makes them standardized
 * fields on every component -- a diagram is a document, and "Website (JS)" often
 * wants to read "Marketing site — GA4 + Braze" for an audience that does not know
 * the workspace. The edit is local to the diagram: it never writes back to
 * Segment, and the original name stays visible underneath when it differs.
 *
 * A custom component gets one extra section: free-form `details` rows. It stands
 * for something outside Segment, so there is no schema to render -- whatever the
 * customer needs recorded about their own service is whatever they type.
 */

import { Link2Off, Plus, Trash2 } from 'lucide-react'

import { EditableText, EmptyNote, IdRow, Row, Section, WriteKeyRow } from './primitives.jsx'
import { cardField, fieldShown, toggleField } from './cardFields.js'
import { labelForKind } from '../canvas/kinds.js'

export default function OverviewTab({ node, topology, zoneName, onUpdate, onNotify }) {
  const data = node.data

  /*
   * The eye beside a row: is this field printed on the card, and how to flip it.
   *
   * Returns null for a field the registry does not know, which is what makes the spacer appear
   * instead -- so a row that is deliberately not toggleable (Name) and one that has simply not been
   * added to the registry look the same, and neither shifts the label column.
   *
   * `toggleField` returns the whole `showFields` object rather than a patch, because `onUpdate`
   * merges at the top level: patching `{showFields: {zone: true}}` would replace the object
   * wholesale anyway, so building the new one here is the honest version of what happens.
   */
  const eye = (id) =>
    cardField(id)
      ? {
          shown: fieldShown(data, id),
          onToggle: (shown) => onUpdate({ showFields: toggleField(data, id, shown) }),
        }
      : null

  return (
    <>
      <Section title="Component">
        <EditableText
          resetKey={node.id}
          label="Name"
          value={data.name ?? ''}
          placeholder="Untitled"
          onCommit={(name) =>
            onUpdate({
              name,
              /* Remember what Segment calls it, once, on the first rename of a
                 bound component. Without this the diagram loses its only link back
                 to the workspace resource a reader would search for. */
              segmentName:
                data.bound === false ? undefined : (data.segmentName ?? data.name),
            })
          }
        />
        <EditableText
          resetKey={node.id}
          label="Description"
          value={data.description ?? ''}
          placeholder="What this does, in the customer's words"
          multiline
          field={eye('description')}
          onCommit={(description) => onUpdate({ description })}
        />
        {/* Renaming a node is a diagram-level relabel. Showing the Segment name
            when they differ keeps the diagram traceable back to the workspace. */}
        {data.segmentName && data.segmentName !== data.name && (
          <Row label="Name in Segment" value={data.segmentName} field={eye('segmentName')} />
        )}
        <Row label="Type" value={labelForKind(topology, data.kind)} field={eye('type')} />
        <Row label="Zone" value={zoneName} field={eye('zone')} />
        {data.sourceType && (
          <Row label="Source type" value={data.sourceType} field={eye('sourceType')} />
        )}
        {data.warehouseType && (
          <Row label="Warehouse" value={data.warehouseType} field={eye('warehouseType')} />
        )}
        {data.categories?.length > 0 && (
          <Row label="Categories" value={data.categories.join(', ')} field={eye('categories')} />
        )}
      </Section>

      {data.kind === 'custom' && (
        <DetailsSection node={node} details={data.details} onUpdate={onUpdate} />
      )}

      <Section title="Status">
        {data.bound === false ? (
          <div className="flex items-start gap-2 rounded-md border border-twilio-warning/40 bg-orange-50 p-2">
            <Link2Off size={13} className="mt-px shrink-0 text-twilio-warning" aria-hidden="true" />
            <p className="text-[11px] leading-relaxed text-twilio-gray-80">
              Not bound to a real component. It renders dashed, which doubles as a
              &ldquo;planned but not built&rdquo; annotation — leave it unbound on purpose, or
              bind it from the palette.
            </p>
          </div>
        ) : (
          <>
            <Row
              label="Enabled"
              value={data.enabled === false ? 'Disabled in Segment' : 'Enabled'}
              field={eye('enabled')}
            />
            {data.status && <Row label="State" value={data.status} field={eye('status')} />}
            {data.size !== null && data.size !== undefined && (
              <Row label="Size" value={data.size.toLocaleString?.() ?? data.size} />
            )}
            {data.computeCadence && (
              <Row label="Cadence" value={data.computeCadence} field={eye('computeCadence')} />
            )}
            {data.deployedAt && (
              <Row label="Deployed" value={data.deployedAt} field={eye('deployedAt')} />
            )}
          </>
        )}
        {data.kind === 'custom' && (
          <EmptyNote>
            Not a Segment component, so none of Segment&rsquo;s placement or connection
            rules apply to it. It can sit in any zone and connect to anything.
          </EmptyNote>
        )}
        {data.synthetic && (
          <EmptyNote>
            Drawn by this tool rather than read from the API. It is a real part of the
            architecture with no resource of its own to fetch — so what it says is what
            someone asserted about the workspace, not something verified against it.
          </EmptyNote>
        )}
        {data.inferred && (
          <EmptyNote>
            Inferred from computed-trait names. Segment has no Journeys API, so the
            steps below are a best guess and their order is unknown.
          </EmptyNote>
        )}
      </Section>

      {(data.segmentId || data.writeKeyMasked) && (
        <Section
          title="Identifiers"
          note="Hidden by default — these panels get screen-shared."
        >
          <IdRow label="ID" value={data.segmentId} />
          {data.slug && <Row label="Slug" value={data.slug} mono copy field={eye('slug')} />}
          {data.spaceId && <IdRow label="Space ID" value={data.spaceId} />}
          {/* A destination's sourceId is which source it hangs off, not its own id. */}
          {data.sourceId && <IdRow label="Source ID" value={data.sourceId} />}
          {data.destinationId && <IdRow label="Destination ID" value={data.destinationId} />}
          {data.metadataId && <Row label="Metadata ID" value={data.metadataId} mono copy />}
          {data.traitKey && (
            <Row label="Trait key" value={data.traitKey} mono copy field={eye('traitKey')} />
          )}
          {data.audienceKey && (
            <Row label="Audience key" value={data.audienceKey} mono copy field={eye('audienceKey')} />
          )}
          <WriteKeyRow
            sourceId={data.segmentId}
            masked={data.writeKeyMasked}
            onNotify={onNotify}
          />
        </Section>
      )}
    </>
  )
}

/*
 * Free-form label/value rows for a custom component.
 *
 * Every edit rewrites the whole array rather than patching a row in place, because
 * `onUpdate` merges: a patch of `{details: [...]}` replaces the array wholesale
 * anyway, and building the new array here keeps the row indices from being a
 * second thing that can go stale.
 */
function DetailsSection({ node, details, onUpdate }) {
  const rows = Array.isArray(details) ? details : []
  const write = (next) => onUpdate({ details: next })

  return (
    <Section
      title="Details"
      note="Anything worth recording about this component. It is your own field list — nothing here is read from Segment."
      actions={
        <button
          type="button"
          onClick={() => write([...rows, { label: '', value: '' }])}
          className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
        >
          <Plus size={11} aria-hidden="true" />
          Add
        </button>
      }
    >
      {rows.length === 0 && <EmptyNote>No details yet.</EmptyNote>}

      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <EditableText
              resetKey={`${node.id}:${index}:label`}
              label="Field"
              value={row.label ?? ''}
              placeholder="Field name"
              onCommit={(label) =>
                write(rows.map((r, i) => (i === index ? { ...r, label } : r)))
              }
            />
            <EditableText
              resetKey={`${node.id}:${index}:value`}
              label="Value"
              value={row.value ?? ''}
              placeholder="Value"
              multiline
              onCommit={(value) =>
                write(rows.map((r, i) => (i === index ? { ...r, value } : r)))
              }
            />
          </div>
          <button
            type="button"
            onClick={() => write(rows.filter((_, i) => i !== index))}
            title="Remove this detail"
            className="nodrag mt-1 shrink-0 text-twilio-gray-40 transition-colors hover:text-twilio-error"
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </Section>
  )
}
