/*
 * The console: a button that opens a drawer over the bottom right of the canvas.
 *
 * Sits above the minimap rather than beside it. The minimap is `!bottom-3 !right-3`
 * and 200x150, so the button clears it at 174px; the open drawer starts from the same
 * line and grows upward, which keeps both usable at once instead of the drawer
 * covering the one control that tells you where you are on a large canvas.
 *
 * Newest first, unlike a devtools console. The reason to open this is almost always
 * "what just happened", and a log that reads oldest-first makes the answer the thing
 * you have to scroll to.
 */

import { useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Info,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'

import CopyButton from '../ui/CopyButton.jsx'
import { LEVELS, bySeverity, filterEntries, formatLogText, levelCounts } from './log.js'

const ICONS = {
  error: AlertCircle,
  warning: TriangleAlert,
  success: CheckCircle2,
  info: Info,
}

const TONES = {
  error: 'text-twilio-error',
  warning: 'text-twilio-warning',
  success: 'text-twilio-success',
  info: 'text-twilio-gray-60',
}

const LABELS = {
  error: 'Errors',
  warning: 'Warnings',
  success: 'Done',
  info: 'Notes',
}

/* Local time, seconds included. The log's own export uses ISO for the reasons given
   in log.js, but on screen the reader is the person it just happened to. */
function clock(at) {
  const time = new Date(at)
  return Number.isNaN(time.getTime())
    ? '--:--:--'
    : time.toLocaleTimeString([], { hour12: false })
}

export default function ConsoleDrawer({ entries, unread, onOpen, onClear }) {
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState('all')
  const [worstFirst, setWorstFirst] = useState(false)
  const [expanded, setExpanded] = useState(null)

  const counts = useMemo(() => levelCounts(entries), [entries])

  const rows = useMemo(() => {
    const filtered = filterEntries(entries, level)
    /* Reversed, then sorted -- `bySeverity` is stable, so within a level the reversal
       survives and the newest error is still the first error. */
    const newestFirst = [...filtered].reverse()
    return worstFirst ? bySeverity(newestFirst) : newestFirst
  }, [entries, level, worstFirst])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) onOpen?.()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Open the console"
        className="absolute bottom-[174px] right-3 z-40 inline-flex items-center gap-1.5 rounded-md border border-twilio-gray-20 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-twilio-gray-60 shadow-md hover:text-twilio-navy"
      >
        <Terminal size={13} aria-hidden="true" />
        Console
        {unread > 0 && (
          <span
            className="ml-0.5 inline-flex min-w-[16px] justify-center rounded-full bg-twilio-error px-1 text-[10px] font-bold tabular-nums text-white"
            /* Counted, so the badge says how much went wrong and not merely that
               something did. */
            aria-label={`${unread} unread ${unread === 1 ? 'alert' : 'alerts'}`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="absolute bottom-[174px] right-3 z-40 flex max-h-[min(46vh,380px)] w-[26rem] flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-twilio-gray-20 px-2.5 py-1.5">
        <Terminal size={13} className="shrink-0 text-twilio-gray-60" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-twilio-navy">
          Console
          <span className="ml-1.5 font-normal tabular-nums text-twilio-gray-40">
            {entries.length}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setWorstFirst((current) => !current)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            worstFirst
              ? 'bg-twilio-blue-light text-twilio-blue'
              : 'text-twilio-gray-40 hover:text-twilio-navy'
          }`}
        >
          Worst first
        </button>
        <CopyButton text={formatLogText(entries)} label="Copy the log as text" size={12} />
        <button
          type="button"
          onClick={onClear}
          disabled={!entries.length}
          title="Clear the log"
          className="text-twilio-gray-40 hover:text-twilio-error disabled:opacity-40 disabled:hover:text-twilio-gray-40"
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Close the console"
          className="text-twilio-gray-40 hover:text-twilio-navy"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-twilio-gray-20 px-2.5 py-1.5">
        <Chip active={level === 'all'} onClick={() => setLevel('all')} count={entries.length}>
          All
        </Chip>
        {LEVELS.map((name) => (
          <Chip
            key={name}
            active={level === name}
            count={counts[name]}
            /* Left selectable at zero rather than hidden: the chips are also the
               summary, and "0 errors" is the thing someone opened this to read. */
            onClick={() => setLevel(name)}
            tone={TONES[name]}
          >
            {LABELS[name]}
          </Chip>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] leading-snug text-twilio-gray-40">
            {entries.length
              ? 'Nothing at this level.'
              : 'Nothing logged yet. Refusals, warnings and confirmations all land here, and stay after the toast has gone.'}
          </p>
        ) : (
          <ul className="divide-y divide-twilio-gray-20">
            {rows.map((entry) => {
              const Icon = ICONS[entry.level] ?? Info
              const showing = expanded === entry.id
              return (
                <li key={entry.id} className="px-2.5 py-1.5">
                  <div className="flex items-start gap-2">
                    <Icon
                      size={12}
                      className={`mt-0.5 shrink-0 ${TONES[entry.level] ?? TONES.info}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[11px] leading-snug text-twilio-navy">
                        {entry.message}
                        {(entry.count ?? 1) > 1 && (
                          <span className="ml-1 rounded bg-twilio-gray-10 px-1 text-[10px] font-semibold tabular-nums text-twilio-gray-60">
                            ×{entry.count}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] tabular-nums text-twilio-gray-40">
                        <span>{clock(entry.at)}</span>
                        {entry.source && <span>{entry.source}</span>}
                        {entry.detail && (
                          <button
                            type="button"
                            onClick={() => setExpanded(showing ? null : entry.id)}
                            className="inline-flex items-center gap-0.5 font-semibold text-twilio-blue hover:underline"
                          >
                            <ChevronDown
                              size={10}
                              className={showing ? 'rotate-180' : ''}
                              aria-hidden="true"
                            />
                            {showing ? 'Hide detail' : 'Detail'}
                          </button>
                        )}
                      </p>
                      {showing && (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-twilio-gray-10 p-1.5 text-[10px] leading-snug text-twilio-slate">
                          {entry.detail}
                        </pre>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function Chip({ active, count, tone, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
        active
          ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue'
          : `border-twilio-gray-20 bg-white hover:border-twilio-gray-40 ${tone ?? 'text-twilio-gray-60'}`
      }`}
    >
      {children}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  )
}
