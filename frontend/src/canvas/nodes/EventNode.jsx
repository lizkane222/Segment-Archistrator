/*
 * An event on the canvas: its name, and whichever of its fields have been switched on.
 *
 * Nothing is shown to begin with -- an event can carry fifty fields and a card with all of them is a
 * wall -- so a card is a title until the reader picks rows with the eye toggles in the Event tab. A
 * sample card reads its own `eventPayload`; a preview card reads `eventNow`, the payload the
 * walkthrough holds at the place it is attached to (a runtime field the app writes, never saved).
 *
 * Connectable like any card, so it can be tied to what it describes. Connectors to a card are drawn
 * only: the walkthrough does not route through them -- see `withoutCards` in AppShell.jsx.
 */

import { memo } from 'react'
import { NodeResizer } from '@xyflow/react'
import { MapPin, Zap } from 'lucide-react'

import ConnectionHandles from './ConnectionHandles.jsx'
import { shownRows, displayValue } from '../../simulation/eventCard.js'
import { MIN_NODE_WIDTH } from '../layout.js'

function EventNode({ id, data, selected }) {
  const preview = data.preview ?? null
  const payload = preview ? data.eventNow : data.eventPayload
  const rows = payload ? shownRows(payload, data.shownFields) : []
  const stacked = data.eventLayout === 'stacked'
  const text = data.style?.text ?? '#354052'
  const border = data.style?.border ?? '#0263e0'
  const background = data.style?.bg ?? '#ffffff'
  const fontSize = Number(data.style?.fontSize) || undefined

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_NODE_WIDTH}
        minHeight={40}
        color={border}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1, opacity: 0.35 }}
      />
      <div
        data-kind="event"
        data-node-id={id}
        className="nokey group relative rounded-md border-2 shadow-sm"
        style={{
          width: data.size?.width ?? 240,
          minHeight: data.size?.height,
          borderColor: border,
          background,
          color: text,
          fontSize,
        }}
      >
        <ConnectionHandles border={border} />
        <div className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ borderBottom: rows.length ? `1px solid ${border}33` : undefined }}>
          {preview ? (
            <MapPin size={12} className="shrink-0" style={{ color: border }} aria-hidden="true" />
          ) : (
            <Zap size={12} className="shrink-0" style={{ color: border }} aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{data.name || 'Event'}</span>
          {data.eventType && (
            <span className="shrink-0 rounded bg-twilio-gray-10 px-1 text-[9px] uppercase tracking-wide text-twilio-gray-60">
              {data.eventType}
            </span>
          )}
        </div>

        {preview && !payload && (
          <p className="px-2.5 py-1.5 text-[10px] italic text-twilio-gray-60">
            {data.eventNow === null
              ? 'This path never reaches here, so there is no event to show.'
              : 'Choose a path with an event in the Event tab to see it here.'}
          </p>
        )}

        {rows.length > 0 && (
          /* Side by side by default: the keys take the width they need on one line and the values get
             everything that is left -- a long, short card. `eventLayout: 'stacked'` puts each key above its
             value instead -- a narrow, tall one. Chosen per card in the Event tab. */
          <dl
            className={`grid items-baseline gap-x-3 px-2.5 py-1.5 ${stacked ? 'gap-y-1.5' : 'gap-y-0.5'}`}
            style={{ gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'max-content minmax(0, 1fr)' }}
          >
            {rows.map((row) => (
              <div key={row.path} className="contents text-[11px] leading-snug">
                <dt className={`font-mono text-[10px] opacity-70 ${stacked ? 'break-all' : 'whitespace-nowrap'}`}>{row.path}</dt>
                <dd className="min-w-0 break-words font-mono">{displayValue(row.value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  )
}

export default memo(EventNode)
