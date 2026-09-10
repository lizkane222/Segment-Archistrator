/*
 * The walkthrough drawer: saved paths, the transport, and what is happening now.
 *
 * A bottom drawer rather than a fourth column. The walkthrough is about the canvas
 * -- the whole point is watching components light up and reading the anchor that
 * opens at each one -- so it takes height, which a diagram laid out left-to-right
 * has to spare, rather than width, which it does not.
 *
 * Paths are *buttons*, and selecting more than one plays them together. That is the
 * request's "multiple paths joined into a simultaneous walkthrough", and it is a
 * multi-select rather than a separate "combine" action because the joined case is
 * the interesting one and should not be three clicks further away than the single.
 *
 * Nothing here computes anything about the graph. Runs come from `runScenarios`,
 * frames from `combinedFrameAt`, narration from `narration.js` -- so what this shows
 * and what the canvas shows cannot disagree.
 */

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react'

import { EVENT_TYPES, skeleton } from './payload.js'
import { PLAY_MODES, runStatus } from './scenarios.js'
import { SPEEDS } from './usePlayback.js'
import { describeKind, describeStep } from './narration.js'
import { eligibleStarts } from './router.js'

export default function WalkthroughDrawer({
  graph,
  topology,
  scenarios,
  runs,
  frame,
  transport,
  mode,
  onModeChange,
  selectedIds,
  onToggleSelected,
  onAddScenario,
  onUpdateScenario,
  onRemoveScenario,
  onFocusNode,
  onClearSelection,
}) {
  const [editingId, setEditingId] = useState(null)
  const [expanded, setExpanded] = useState(true)

  /* Every component, not only the sources -- `warehouse -> reverse_etl_model ->
     destination` is a real path with no source in it. Split for the picker below, which
     still offers the sources first because that is what you usually want. */
  const starts = useMemo(() => eligibleStarts(graph), [graph])
  const editing = scenarios.find((scenario) => scenario.id === editingId) ?? null

  return (
    <section
      className="flex shrink-0 flex-col border-t border-twilio-gray-20 bg-white"
      aria-label="Event walkthrough"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-twilio-gray-60 hover:text-twilio-navy"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
          Walkthrough
        </button>

        <div className="scroll-x-thin flex min-w-0 flex-1 items-center gap-1">
          {scenarios.map((scenario) => (
            <PathButton
              key={scenario.id}
              scenario={scenario}
              selected={selectedIds.includes(scenario.id)}
              onSelect={() => onToggleSelected(scenario.id)}
              onEdit={() => setEditingId(scenario.id === editingId ? null : scenario.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              const created = onAddScenario()
              if (created) setEditingId(created.id)
            }}
            className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-twilio-gray-40 px-2.5 py-1 text-[11px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
          >
            <Plus size={11} aria-hidden="true" />
            New path
          </button>
        </div>

        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={onClearSelection}
            title="Stop and clear the highlighting. The paths themselves are kept."
            className="shrink-0 rounded border border-twilio-gray-20 px-2 py-1 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy"
          >
            Clear
          </button>
        )}
      </header>

      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-twilio-gray-10 px-3 py-2.5">
          <Transport
            transport={transport}
            mode={mode}
            onModeChange={onModeChange}
            runCount={runs.length}
          />

          {/* A selected path that cannot run at all is dropped by `runnable`, and a
              path button that lights up while nothing happens on the canvas is the
              worst version of that. */}
          {selectedIds.length > runs.length && (
            <p className="mt-2 text-[11px] leading-relaxed text-twilio-warning">
              {selectedIds.length - runs.length} selected path
              {selectedIds.length - runs.length === 1 ? '' : 's'} cannot run: the
              component it starts from is no longer on the diagram.
            </p>
          )}

          {runs.length === 0 ? (
            <p className="mt-2 text-[11px] leading-relaxed text-twilio-gray-60">
              Pick a path above to play it, or more than one to run them together. Two
              that differ by a single toggle — an insert function on and off — show where
              the same event parts company with itself.
            </p>
          ) : (
            <div className="mt-2.5 space-y-2">
              {frame.runs.map((run) => (
                <RunRow
                  key={run.scenario.id}
                  run={run}
                  graph={graph}
                  topology={topology}
                  onFocusNode={onFocusNode}
                />
              ))}
            </div>
          )}

          {editing && (
            <ScenarioEditor
              scenario={editing}
              graph={graph}
              starts={starts}
              onChange={(patch) => onUpdateScenario(editing.id, patch)}
              onRemove={() => {
                onRemoveScenario(editing.id)
                setEditingId(null)
              }}
              onClose={() => setEditingId(null)}
            />
          )}
        </div>
      )}
    </section>
  )
}

function PathButton({ scenario, selected, onSelect, onEdit }) {
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex items-center gap-1.5 rounded-l-full border py-1 pl-2.5 pr-2 text-[11px] font-medium transition-colors ${
          selected
            ? 'border-transparent text-white'
            : 'border-twilio-gray-20 bg-white text-twilio-gray-60 hover:border-twilio-gray-40'
        }`}
        style={selected ? { background: scenario.color } : undefined}
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-white/60"
          style={{ background: scenario.color }}
        />
        {scenario.name}
      </button>
      <button
        type="button"
        onClick={onEdit}
        title={`Edit “${scenario.name}”`}
        className={`rounded-r-full border border-l-0 px-1.5 py-1 text-[11px] transition-colors ${
          selected
            ? 'border-transparent text-white/80 hover:text-white'
            : 'border-twilio-gray-20 bg-white text-twilio-gray-40 hover:text-twilio-navy'
        }`}
        style={selected ? { background: scenario.color } : undefined}
      >
        ⋯
      </button>
    </span>
  )
}

function Transport({ transport, mode, onModeChange, runCount }) {
  const { tick, playing, speed, setSpeed, play, pause, reset, seek, step } = transport
  const total = transport.total ?? 0

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-0.5">
        <IconButton label="Back to the start" onClick={reset} icon={RotateCcw} />
        <IconButton label="Previous step" onClick={() => step(-1)} icon={SkipBack} disabled={tick < 0} />
        <button
          type="button"
          onClick={playing ? pause : play}
          disabled={total === 0}
          className="flex items-center gap-1 rounded-md bg-twilio-blue px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-40"
        >
          {playing ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <IconButton
          label="Next step"
          onClick={() => step(1)}
          icon={SkipForward}
          disabled={total === 0 || tick >= total - 1}
        />
      </div>

      <label className="flex min-w-32 flex-1 items-center gap-2">
        <span className="sr-only">Step</span>
        <input
          type="range"
          min={-1}
          max={Math.max(0, total - 1)}
          value={tick}
          onChange={(event) => {
            pause()
            seek(Number(event.target.value))
          }}
          className="min-w-24 flex-1 accent-twilio-blue"
        />
        <span className="w-14 shrink-0 font-mono text-[10px] text-twilio-gray-60">
          {Math.max(0, tick + 1)}/{total}
        </span>
      </label>

      {/* Only meaningful with more than one path, so it appears with the second. */}
      {runCount > 1 && (
        <div className="flex items-center gap-1">
          {[
            [PLAY_MODES.together, 'Together'],
            [PLAY_MODES.sequence, 'One after another'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onModeChange(value)}
              aria-pressed={mode === value}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${
                mode === value
                  ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
                  : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <select
        value={speed}
        onChange={(event) => setSpeed(Number(event.target.value))}
        aria-label="Playback speed"
        className="rounded-md border border-twilio-gray-20 px-1.5 py-1 text-[10px] text-twilio-gray-60"
      >
        {SPEEDS.map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>
    </div>
  )
}

/*
 * One path's current position, and the anchor for wherever its playhead is.
 *
 * `describeStep` is given the trace's step and `describeKind` the node, which is the
 * same pair the tooltip on the canvas renders -- deliberately, so the drawer is a
 * second view of one reading rather than a second opinion.
 */
function RunRow({ run, graph, topology, onFocusNode }) {
  const status = runStatus(run)
  const step = run.frame.current
  const node = useMemo(
    () => (graph?.nodes ?? []).find((entry) => entry.id === step?.nodeId) ?? null,
    [graph, step?.nodeId],
  )
  const reading = useMemo(() => describeStep(step, node), [step, node])
  const kind = useMemo(() => (node ? describeKind(node, { topology }) : null), [node, topology])

  return (
    <div className="rounded-md border border-twilio-gray-20 p-2">
      <div className="flex items-baseline gap-1.5">
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full"
          style={{ background: status.color }}
        />
        <span className="text-[11px] font-semibold text-twilio-navy">{status.name}</span>
        <span className="font-mono text-[10px] text-twilio-gray-40">
          {Math.max(0, status.index + 1)}/{status.total}
        </span>
        <span className="ml-auto text-[10px] text-twilio-gray-60">
          {status.delivered} delivered
          {status.withheld > 0 && ` · ${status.withheld} withheld`}
        </span>
      </div>

      {reading ? (
        <button
          type="button"
          onClick={() => onFocusNode?.(reading.nodeId)}
          className="mt-1 block w-full text-left"
        >
          <span className="text-[11px] font-medium text-twilio-navy">
            {kind?.title ? `${kind.title} · ` : ''}
            {reading.name}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-twilio-gray-60">
            {reading.title} — {reading.reason}
          </span>
        </button>
      ) : (
        <p className="mt-1 text-[11px] text-twilio-gray-60">
          {status.total === 0
            ? (status.notes[0] ?? 'Nothing to play: this path has no route through the diagram.')
            : 'Not started.'}
        </p>
      )}

      {/* Server-side and reducer caveats, verbatim. */}
      {status.notes.length > 0 && status.total > 0 && (
        <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">{status.notes[0]}</p>
      )}
    </div>
  )
}

/*
 * Editing a path.
 *
 * The toggle list is every component the *runs* could pass, not every component on
 * the canvas: switching off something the event never reaches changes nothing, and
 * offering it implies otherwise. Functions get three states rather than two, because
 * "assume it drops" and "switch it off entirely" are different claims -- a dropping
 * insert function still ran.
 */
function ScenarioEditor({ scenario, graph, starts, onChange, onRemove, onClose }) {
  /* Sources first and labelled, so widening the picker to every component did not
     bury the one kind that is usually the answer. */
  const startGroups = useMemo(() => {
    const sources = starts.filter((node) => (node.data?.kind ?? node.kind) === 'source')
    const rest = starts.filter((node) => (node.data?.kind ?? node.kind) !== 'source')
    return [
      ...(sources.length ? [{ label: 'Sources', nodes: sources }] : []),
      ...(rest.length ? [{ label: 'Other components', nodes: rest }] : []),
    ]
  }, [starts])

  const toggleable = useMemo(
    () =>
      (graph?.nodes ?? []).filter((node) =>
        [
          'source_insert_function',
          'source_function',
          'destination_insert_function',
          'destination_function',
          'destination_filter',
          'destination',
          'warehouse',
        ].includes(node.data?.kind ?? node.kind),
      ),
    [graph],
  )

  const disabled = new Set(scenario.disabled ?? [])

  const toggle = (nodeId) => {
    const next = new Set(disabled)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    onChange({ disabled: [...next] })
  }

  return (
    <div className="mt-3 rounded-md border border-twilio-gray-20 bg-twilio-gray-10 p-2.5">
      <div className="flex items-center gap-2">
        <input
          value={scenario.name}
          onChange={(event) => onChange({ name: event.target.value })}
          aria-label="Path name"
          className="min-w-0 flex-1 rounded border border-twilio-gray-20 px-2 py-1 text-[12px] font-semibold text-twilio-navy"
        />
        <button
          type="button"
          onClick={onRemove}
          title="Delete this path"
          className="rounded p-1 text-twilio-gray-40 hover:text-twilio-error"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-twilio-gray-40 hover:text-twilio-navy"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            Start at
          </span>
          <select
            value={scenario.sourceId ?? ''}
            onChange={(event) => onChange({ sourceId: event.target.value || null })}
            className="mt-0.5 w-full rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px]"
          >
            <option value="">First source on the diagram</option>
            {/* Grouped rather than one flat list: a source is still the usual answer, and
                on a large diagram a flat list of every component buries them. */}
            {startGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.data?.name ?? node.name ?? node.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            Event
          </span>
          {/* A fresh skeleton, not a `type` swap: an identify payload has traits
              where a track has properties and an event name, so keeping the old
              body would leave fields that do not belong to the new call. */}
          <select
            value={scenario.event?.type ?? 'track'}
            onChange={(event) => onChange({ event: skeleton(event.target.value) })}
            className="mt-0.5 w-full rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px]"
          >
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>

      {scenario.event?.type === 'track' && (
        <label className="mt-2 block">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            Event name
          </span>
          <input
            value={scenario.event.event ?? ''}
            onChange={(input) =>
              onChange({ event: { ...scenario.event, event: input.target.value } })
            }
            className="mt-0.5 w-full rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px]"
          />
        </label>
      )}

      {toggleable.length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            Switched off for this path
          </legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {toggleable.map((node) => {
              const off = disabled.has(node.id)
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => toggle(node.id)}
                  aria-pressed={off}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    off
                      ? 'border-twilio-error bg-twilio-error text-white line-through'
                      : 'border-twilio-gray-20 bg-white text-twilio-gray-60 hover:border-twilio-gray-40'
                  }`}
                >
                  {node.data?.name ?? node.name ?? node.id}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
            A filter switched off does not apply, so everything passes it. Everything
            else switched off receives nothing — which is what the reducer does, not a
            rendering choice.
          </p>
        </fieldset>
      )}
    </div>
  )
}

function IconButton({ label, onClick, icon: Icon, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-twilio-gray-60 transition-colors hover:text-twilio-navy disabled:opacity-30"
    >
      <Icon size={13} aria-hidden="true" />
    </button>
  )
}
