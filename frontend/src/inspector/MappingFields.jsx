/*
 * The fields an actions mapping sends, one row each.
 *
 * mappingRows.js does the reading. What this file adds is the indent: a nested directive
 * is drawn inside its parent field rather than as a sibling, because `@if` and `@arrayPath`
 * are about one destination field and a flat list would read as several.
 */

import { mappingRows, DIRECTIVE_LABELS } from './mappingRows.js'
import { EmptyNote } from './primitives.jsx'

export default function MappingFields({ fields }) {
  const rows = mappingRows(fields)

  if (rows.length === 0) {
    return (
      <EmptyNote>
        No field mapping is recorded. An actions destination with no enabled mapping is
        connected and still sends nothing, so this is worth confirming in the workspace
        rather than reading as &ldquo;the defaults apply&rdquo;.
      </EmptyNote>
    )
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row, index) => (
        <FieldRow key={`${row.field}-${index}`} row={row} />
      ))}
    </ul>
  )
}

function FieldRow({ row }) {
  return (
    <li className="rounded border border-twilio-gray-20 px-1.5 py-1">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="break-all font-mono text-[11px] text-twilio-navy">{row.field}</span>
        <span className="shrink-0 rounded bg-twilio-gray-10 px-1 text-[9px] uppercase tracking-wide text-twilio-gray-60">
          {DIRECTIVE_LABELS[row.directive]}
        </span>
        {row.from && (
          <span className="break-all font-mono text-[11px] text-twilio-blue">{row.from}</span>
        )}
      </div>
      {row.note && <p className="mt-0.5 text-[10px] leading-relaxed text-twilio-warning">{row.note}</p>}
      {row.children.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 border-l border-twilio-gray-20 pl-2">
          {row.children.map((child, index) => (
            <FieldRow key={`${child.field}-${index}`} row={child} />
          ))}
        </ul>
      )}
    </li>
  )
}
