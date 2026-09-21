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
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react'

import CopyButton from '../ui/CopyButton.jsx'
import { EVENT_TYPES, skeleton } from './payload.js'
import {
  PATH_STATE,
  PATH_STATE_ROWS,
  PLAY_MODES,
  pathStateFor,
  pathStatePatch,
  runStatus,
} from './scenarios.js'
import {
  moveBranch,
  sequenceBranches,
  sequenceOf,
  sequenced,
  unsequenceBranches,
} from './branches.js'
import { SPEEDS } from './usePlayback.js'
import { describeKind, describeStep } from './narration.js'
import {
  DEFAULT_FALLBACK,
  FALLBACK,
  STATUS,
  acceptsModify,
  eligibleStarts,
  foldLegacyBehaviour,
  hasArrived,
  indeterminate,
  revisitable,
} from './router.js'

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
  onDuplicateScenario,
  onUpdateScenario,
  onRemoveScenario,
  onFocusNode,
  onClearSelection,
  /*
   * Which path's editor is open, owned by the app rather than by this drawer.
   *
   * Lifted because a path can be created from outside the drawer -- the toolbar's own button --
   * and a new path has to open its editor wherever it was made, since it has no start yet and
   * cannot run until it is given one. Held here it only opened for paths created by the button a
   * few lines below.
   */
  editingId,
  onEdit,
  /* The edited path's own run, from the app. Computed there rather than here because nothing in
     this file evaluates anything about the graph -- see the header. */
  editingRun,
  /* Builds the pasteable report, on demand. A function for the same reason it is not computed
     here: the app owns the document and the runs, and the report should be assembled when it is
     asked for rather than on every tick. */
  getDiagnostics,
}) {
  const [expanded, setExpanded] = useState(true)
  /* A path with no start cannot run, and the editor is the only place to give it one -- so
     opening one expands the drawer if the reader had collapsed it. */
  const setEditingId = (id) => {
    if (id) setExpanded(true)
    onEdit?.(id)
  }

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

        {/* The animation is the one thing that cannot go in a bug report, so this is the way to
            hand somebody what happened. Lazy: the report is a few hundred lines and is built on the
            click, not on every render -- see simulation/diagnostics.js. */}
        {getDiagnostics && (
          <span
            className="flex shrink-0 items-center gap-1 rounded border border-twilio-gray-20 px-2 py-1 text-[10px] text-twilio-gray-60"
            title="Copy a text report of this path — the route it took, every connector and which way it points, and where it stopped."
          >
            <CopyButton text={getDiagnostics} label="Copy path diagnostics" size={11} />
            Diagnostics
          </span>
        )}

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
              trace={editingRun?.trace ?? null}
              onChange={(patch) => onUpdateScenario(editing.id, patch)}
              onRemove={() => {
                onRemoveScenario(editing.id)
                setEditingId(null)
              }}
              /* The app opens the copy's own editor, so this does not close anything -- the editor
                 stays open and is now showing the duplicate, which is what "duplicate and edit"
                 means. */
              onDuplicate={() => onDuplicateScenario?.(editing.id)}
              onClose={() => setEditingId(null)}
              onFocusNode={onFocusNode}
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
            /* Named for what is on screen rather than for the timing, because that is the only thing
               that distinguishes it from the row above: end to end either way, but here only one
               path is lit at a time. This is the mode for several *events* in an order. */
            [PLAY_MODES.chain, 'One at a time'],
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
  /*
   * Every component the event last landed at, not one.
   *
   * A fork has it at both branches at once, so this is a list -- it used to read a single
   * `frame.current` and report one of them, which made the drawer disagree with the canvas: two
   * components ringed, one named.
   *
   * `arrived` rather than `current` because `current` is empty while the event is between two
   * components, and reading it here flashed "Not started." once per hop. Transit is reported by the
   * label below instead, which is the honest way to say it.
   */
  const travelling = run.frame.kind === 'edge'
  const readings = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((entry) => [entry.id, entry]))
    return (run.frame.arrived ?? [])
      .map((step) => {
        const node = byId.get(step.nodeId) ?? null
        return {
          step,
          reading: describeStep(step, node),
          kind: node ? describeKind(node, { topology }) : null,
        }
      })
      .filter((entry) => entry.reading)
  }, [run.frame.arrived, graph, topology])

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
        {/* Said rather than left to be inferred from the components below not having changed. Half of
            every hop is spent between two of them, and during that half the reading underneath is
            where the event *was*, not where it is. */}
        {travelling && (
          <span className="text-[10px] italic text-twilio-gray-40">in transit…</span>
        )}
        <span className="ml-auto text-[10px] text-twilio-gray-60">
          {status.delivered} delivered
          {status.withheld > 0 && ` · ${status.withheld} withheld`}
        </span>
      </div>

      {readings.length > 0 ? (
        /* One row per component in flight. A fork is one moment at two places, and listing only
           one of them would leave the reader looking for the second ring on the canvas. */
        readings.map(({ step, reading, kind }) => (
          <button
            /* By step, so a component the path stops at twice is two readings rather than a
               duplicate key. */
            key={step.index}
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
        ))
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
 * The toggle list is every component *this path passes*, not every component on the canvas.
 * That was always the intent -- switching off something the event never reaches changes nothing,
 * and offering it implies otherwise -- but it was implemented as "every component of a switchable
 * kind", which on a real diagram listed a dozen destinations the path has nothing to do with under
 * a heading reading "Switched off for this path". It read as though the tool had switched them off
 * itself. So the list is now derived from the path's own trace.
 *
 * Two different things can be done to a component on the route, and they are deliberately separate
 * controls because they are different claims:
 *
 *   - Leaving it *out* (the timeline) says "this path is not about that component". The event steps
 *     over it and carries on, so the rest of the route is unaffected.
 *   - Switching it *off* says "what would arrive if this were not there". The event stops dead,
 *     which is the question the toggles exist to ask.
 *
 * Merging them into one control would lose that, and it is the distinction the whole feature turns
 * on. Functions keep three states for the same reason: "assume it drops" and "switch it off
 * entirely" are different claims, because a dropping insert function still ran.
 */
function ScenarioEditor({
  scenario,
  graph,
  starts,
  trace,
  onChange,
  onRemove,
  onDuplicate,
  onClose,
  onFocusNode,
}) {
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

  /*
   * The route, wave by wave, as the reader will watch it.
   *
   * Built from the trace rather than from the graph, so it is the path's own story: the components
   * it reaches, in the order and the groupings it reaches them in, with a fork's branches on one
   * row because they happen at one moment.
   *
   * A rejoin is dropped. It is a second connector into a component already on the row above, and
   * showing the component twice would suggest the event arrives at it twice.
   *
   * A *revisit* is kept, and marked, for the opposite reason: the event does arrive at it twice, which
   * is what the reader asked for when they ticked it. So the bubble appears on both rows and the second
   * one says which pass it is -- an unmarked repeat would read as the timeline having stuttered.
   */
  const timeline = useMemo(() => {
    if (!trace?.waves?.length) return []
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]))
    return trace.waves
      .map((indices) =>
        indices
          .map((index) => trace.steps[index])
          .filter((step) => step && !step.rejoin)
          .map((step) => ({
            /* Both, because they answer different questions: the node id is what a toggle acts on and
               what the canvas focuses, the step index is what makes this row unique when one component
               is on two of them. */
            nodeId: step.nodeId,
            stepIndex: step.index,
            status: step.status,
            name: byId.get(step.nodeId)?.data?.name ?? byId.get(step.nodeId)?.name ?? step.nodeId,
            kind: byId.get(step.nodeId)?.data?.kind ?? byId.get(step.nodeId)?.kind ?? null,
            isStart: step.nodeId === trace.sourceId,
            returning: step.revisit === true,
          })),
      )
      .filter((row) => row.length > 0)
  }, [trace, graph])

  /*
   * Every place this path has more than one way to go.
   *
   * Derived from the trace's parent links rather than from the rows above, and that is the whole
   * reason it is separate: sequencing a fork *moves its arms onto different rows*, so a fork found by
   * looking for two bubbles side by side would disappear the moment it was used and there would be no
   * way to change the order again or put it back.
   *
   * Rejoins are excluded. A second connector into a component already reached is not a choice about
   * where to go next -- the component has its verdict, and the connector is travelled either way.
   *
   * Blocked arms are excluded too, and that is a bug fix rather than a refinement. A reader who had set
   * ten components to Block still saw them listed here, still ordered them, and still watched the event
   * animate through them -- because a fork was read straight off the walk, and pass two records a
   * blocked component as a step like any other. A component the event never reaches is not one of the
   * ways this path can go. Dropping them can leave a fork with a single arm, and a fork with one arm is
   * not a fork, so the length test comes *after* the filter rather than before it -- otherwise a card
   * would sit there offering an order over one row.
   *
   * Skipped arms stay. A skipped component genuinely does pass the event on to whatever it feeds, so it
   * is a real branch of the route; that is the whole distinction between Skip and Block.
   *
   * Grouped by parent *step* and not by parent component, which matters once a path stops at one
   * component twice: keying on the id pools both stops' children, so a component with one connector out
   * of each pass would look like a single two-armed fork that neither pass actually has. The `branches`
   * entry is still stored under the component's id -- `sequenceOf` filters a stored order down to the
   * children actually present, so each pass reads its own arms out of the one entry.
   */
  const forks = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]))
    const nameOf = (id) => byId.get(id)?.data?.name ?? byId.get(id)?.name ?? id
    const steps = trace?.steps ?? []

    const stopped = new Set(scenario.disabled ?? [])

    const kids = new Map()
    for (const step of steps) {
      if (step.fromIndex == null || step.rejoin) continue
      if (stopped.has(step.nodeId)) continue
      if (!kids.has(step.fromIndex)) kids.set(step.fromIndex, [])
      kids.get(step.fromIndex).push(step.nodeId)
    }

    return [...kids]
      /* After the filter, so a fork reduced to one arm stops being offered at all. */
      .filter(([, children]) => children.length > 1)
      .map(([parentIndex, children]) => {
        const parentId = steps[parentIndex].nodeId
        return {
          /* The step, so two passes of one component are two cards with distinct React keys. */
          parentIndex,
          parentId,
          parentName: nameOf(parentId),
          /* Marked when the fork belongs to a second stop, so a reader looking at two cards headed with
             the same component name can tell which pass each one is about. */
          returning: steps[parentIndex].revisit === true,
          oneAtATime: sequenced(scenario.branches, parentId),
          /* In the order the path takes them, which for an unsequenced fork is the order the walk found
             them -- so switching to one-at-a-time does not reshuffle anything as its first act. */
          arms: (sequenceOf(scenario.branches, parentId, children) ?? children).map((nodeId) => ({
            nodeId,
            name: nameOf(nodeId),
          })),
          children,
        }
      })
  }, [trace, graph, scenario.branches, scenario.disabled])

  /*
   * Only the components this path actually passes, and only those where "off" means something.
   *
   * Read off the trace, which is what makes this stop listing the whole canvas. Excluded components
   * are left out too: something already stepped over cannot also be switched off, and offering both
   * on one component invites the reader to wonder which wins.
   */
  const excluded = new Set(scenario.excluded ?? [])
  const toggleable = useMemo(() => {
    const onPath = new Set(Object.keys(trace?.visited ?? {}))
    return (graph?.nodes ?? []).filter((node) => {
      if (!onPath.has(node.id) || excluded.has(node.id)) return false
      return [
        'source_insert_function',
        'source_function',
        'destination_insert_function',
        'destination_function',
        'destination_filter',
        'destination',
        'warehouse',
      ].includes(node.data?.kind ?? node.kind)
    })
    /* `excluded` is a fresh Set each render; keyed on the array it came from instead. */
  }, [graph, trace, scenario.excluded])

  const disabled = new Set(scenario.disabled ?? [])

  /*
   * The switched-off chips, routed through the same patch as the route bubbles.
   *
   * These write `disabled`, which is now the Block half of one three-way choice -- so they used to be
   * able to disagree with the bubble: this handler set `disabled` without clearing `excluded`, leaving a
   * component both stepped over and switched off. `visit` checks stepped-over first, so Skip silently
   * won and the chip looked like it had done nothing. Going through `pathStatePatch` makes the two
   * surfaces one control with two shapes, which is what they always were.
   */
  const toggle = (nodeId) =>
    onChange(
      pathStatePatch(scenario, nodeId, disabled.has(nodeId) ? PATH_STATE.pass : PATH_STATE.block),
    )

  /* All three go through `onChange` like every other field, so a reorder lands on the same undo stack
     and the same dirty check as renaming the path. */
  const moveArm = (parentId, nodeId, delta, children) =>
    onChange({ branches: moveBranch(scenario.branches, parentId, nodeId, delta, children) })

  const setOneAtATime = (parentId, children, on) =>
    onChange({
      branches: on
        ? sequenceBranches(scenario.branches, parentId, children)
        : unsequenceBranches(scenario.branches, parentId),
    })

  /*
   * What this path does with one component: Pass, Skip or Block.
   *
   * One choice over two stored fields, which is the point. `excluded` and `disabled` have always been
   * three states in disguise -- they are mutually exclusive, they map exactly onto the green, amber and
   * red the reducer already produces, and the only control for either was a single `×` that toggled one
   * of them. A reader could not tell from it that "the event steps over this" and "the event stops here"
   * were different claims, let alone pick between them.
   *
   *   Pass   neither field    the component acts on the event      green
   *   Skip   `excluded`       stepped over, event carries on        amber
   *   Block  `disabled`       the event stops here                  red
   *
   * Setting any one of them clears the other two, so the fields can never make contradictory claims
   * about the same component. `revisit` goes with them: a component the event steps over or never
   * reaches cannot be stopped at, let alone twice.
   */
  const setPathState = (nodeId, state) => onChange(pathStatePatch(scenario, nodeId, state))
  const pathStateOf = (nodeId) => pathStateFor(scenario, nodeId)

  const revisited = new Set(scenario.revisit ?? [])

  /*
   * The components where a second stop is a thing the diagram could actually do -- see `revisitable`
   * in simulation/router.js, which is where the "more than one connector in" test lives and is tested.
   *
   * Anything already named is kept regardless of what the graph now says, so the control cannot
   * disappear at the moment it is used and leave no way to undo it.
   */
  const canRevisit = useMemo(() => {
    const ids = revisitable(graph)
    for (const id of scenario.revisit ?? []) ids.add(id)
    return ids
  }, [graph, scenario.revisit])

  /*
   * The components this path can be told what to assume about, and what it currently assumes.
   *
   * From `indeterminate(graph)` -- the graph and each node's kind, never the trace. Setting a fallback
   * to Block truncates the path, so a trace-derived list would delete the very row that undid it. That
   * mistake has already been made twice in this file's history; the helper exists so it cannot be made
   * a third time.
   *
   * Sorted by name so the list does not reshuffle when a fallback changes, and `disabled` components
   * are marked rather than dropped: `visit` checks switched-off first, so their fallback genuinely
   * cannot apply and the row says so instead of silently doing nothing.
   */
  const assumptions = useMemo(() => {
    const ids = indeterminate(graph)
    const merged = {
      ...foldLegacyBehaviour(scenario.functionBehaviour),
      ...(scenario.fallback ?? {}),
    }
    for (const id of Object.keys(merged)) ids.add(id)

    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]))
    return [...ids]
      .map((nodeId) => {
        const node = byId.get(nodeId)
        const kind = node?.data?.kind ?? node?.kind ?? null
        return {
          nodeId,
          kind,
          name: node?.data?.name ?? node?.name ?? nodeId,
          how: merged[nodeId] ?? DEFAULT_FALLBACK,
          canModify: acceptsModify(kind),
          switchedOff: (scenario.disabled ?? []).includes(nodeId),
        }
      })
      .filter((entry) => entry.kind !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [graph, scenario.fallback, scenario.functionBehaviour, scenario.disabled])

  const setFallback = (nodeId, how) => {
    const next = { ...(scenario.fallback ?? {}) }
    /* Removed rather than written as `allow`, so a path the reader experimented with and put back does
       not carry a field that means nothing -- and is not marked dirty against its saved copy for a
       setting they just undid. The same rule `unsequenceBranches` follows. */
    if (how === DEFAULT_FALLBACK) delete next[nodeId]
    else next[nodeId] = how
    /* The legacy spelling is dropped for any component named here, or it would keep overriding the
       control the reader just used. */
    const legacy = { ...(scenario.functionBehaviour ?? {}) }
    delete legacy[nodeId]
    onChange({ fallback: next, functionBehaviour: legacy })
  }

  const toggleRevisit = (nodeId) => {
    const next = new Set(revisited)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    /* The other direction of the same rule as above: asking for a second stop takes the component back
       into the path, because there is nothing to stop at otherwise. */
    const stillExcluded = (scenario.excluded ?? []).filter((id) => !next.has(id))
    onChange({ revisit: [...next], excluded: stillExcluded })
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
        {/* Beside Delete rather than on the path's own pill in the strip above: the pill is already a
            two-part control on a row that scrolls, and duplicating is something you want at the moment
            you are looking at what you are about to copy. */}
        <button
          type="button"
          onClick={onDuplicate}
          title="Duplicate this path — the copy keeps this start, this event and these assumptions, and opens for editing"
          className="rounded p-1 text-twilio-gray-40 hover:text-twilio-blue"
        >
          <Copy size={13} aria-hidden="true" />
        </button>
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
            className={`mt-0.5 w-full rounded border px-1.5 py-1 text-[11px] ${
              scenario.sourceId
                ? 'border-twilio-gray-20'
                : /* Ringed until it is answered. An unanswered start is the one thing stopping the
                     path from running, and a plain select looks like a filled-in field. */
                  'border-twilio-warning bg-orange-50'
            }`}
          >
            {/* Not a default. This used to read "First source on the diagram" and silently pick
                one, which made a path run from a component the reader never chose -- see
                `runnable`. Disabled so it cannot be chosen back. */}
            <option value="" disabled>
              Choose a component…
            </option>
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

      <PathTimeline
        rows={timeline}
        stateOf={pathStateOf}
        revisited={revisited}
        canRevisit={canRevisit}
        hasStart={Boolean(scenario.sourceId)}
        onSetState={setPathState}
        onRevisit={toggleRevisit}
        onFocusNode={onFocusNode}
      />

      <BranchOrder forks={forks} onMove={moveArm} onOneAtATime={setOneAtATime} />

      <Assumptions entries={assumptions} onSet={setFallback} onFocusNode={onFocusNode} />

      {toggleable.length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            Ask “what if this were switched off?”
          </legend>
          {/* Renamed from "Switched off for this path", which described the *state* of the chips
              rather than what the control is for -- so a list of components that were all still on
              read as a list of components the tool had switched off. */}
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
            Only components this path passes are listed. A filter switched off does not apply, so
            everything passes it; everything else switched off receives nothing, and the event
            stops there. To keep a component on the route but leave it out of the story, use the
            timeline above instead.
          </p>
        </fieldset>
      )}
    </div>
  )
}

/*
 * The route as bubbles, one row per wave.
 *
 * A row is a moment: the components a wave reaches are side by side because the event reaches them
 * together, so a fork is visibly a fork rather than a list you have to infer branching from. This is
 * the same grouping the transport advances through, so what the reader clicks here and what they
 * watch on the canvas are the same structure.
 *
 * Clicking a bubble leaves that component out of the path, or puts it back. Excluded components stay
 * on the timeline, struck through -- they have to, or there would be no way to undo it: the router
 * steps over them but still records them, which is what keeps them visible here.
 *
 * The start is not clickable. A path with its own start left out is not a path.
 */
function PathTimeline({
  rows,
  stateOf,
  revisited,
  canRevisit,
  hasStart,
  onSetState,
  onRevisit,
  onFocusNode,
}) {
  if (!hasStart) {
    return (
      <p className="mt-2 rounded-md border border-twilio-warning/40 bg-orange-50 px-2 py-1.5 text-[10px] leading-relaxed text-twilio-gray-80">
        Choose where this path starts and the route will appear here, component by component.
      </p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="mt-2 rounded-md border border-twilio-gray-20 bg-white px-2 py-1.5 text-[10px] leading-relaxed text-twilio-gray-60">
        Nothing is connected downstream of the component this path starts at, so there is no route
        to walk. Check which way the connectors point — an arrowhead facing the wrong way is the
        usual reason.
      </p>
    )
  }

  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
        Route · {rows.length} step{rows.length === 1 ? '' : 's'}
      </p>
      <ol className="mt-1 space-y-1">
        {rows.map((row, wave) => (
          <li key={wave} className="flex items-start gap-1.5">
            <span className="mt-1 w-3 shrink-0 text-right font-mono text-[9px] text-twilio-gray-40">
              {wave + 1}
            </span>
            {/* Wrapping, because a fan-out to a dozen destinations is one wave and one row. */}
            <div className="flex min-w-0 flex-wrap gap-1">
              {row.map((entry) => (
                <TimelineBubble
                  /* By step, not by component: a path that doubles back has one component on two
                     rows, and keying on its id would be a duplicate key within the same list. */
                  key={entry.stepIndex}
                  entry={entry}
                  state={stateOf(entry.nodeId)}
                  twice={revisited.has(entry.nodeId)}
                  offerRevisit={canRevisit.has(entry.nodeId)}
                  onSetState={onSetState}
                  onRevisit={onRevisit}
                  onFocusNode={onFocusNode}
                />
              ))}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
        Each row is one moment — components on the same row receive the event together. The second
        target on each says what this path does with that component: <strong>Pass</strong> it through,
        <strong> Skip</strong> it so the event steps over and carries on, or <strong>Block</strong> it so
        the event stops there. Click ↺ where the path doubles back through a component, to stop at it a
        second time instead of only lighting the connector.
      </p>
    </div>
  )
}

/*
 * What order the path takes each fork's arms in.
 *
 * ## Why this is a block of its own and not a drag handle on the route
 *
 * The route above is *derived* -- it is the walk, not a list -- so there is no order in it to drag
 * around. The only order a path can genuinely choose without rewiring the diagram is what happens
 * where the walk has more than one way to go, and that is a fact about a *fork* rather than about a
 * row. It has to be stated per fork for a plain reason too: choosing one-at-a-time moves the arms onto
 * separate rows, so controls living on a row would vanish the moment they were used.
 *
 * The route redraws as soon as anything here changes, which is what ties the two together: press
 * "one at a time" and the row above visibly splits.
 *
 * Buttons rather than mouse dragging. Reordering has to be reachable from the keyboard, and it keeps
 * the list arithmetic a pure function (simulation/branches.js) that this project can test -- there is
 * no DOM in the test environment, so a drag implementation would be the one part of this feature
 * nothing could check.
 */
function BranchOrder({ forks, onMove, onOneAtATime }) {
  if (!forks?.length) return null

  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
        Where the path splits
      </p>

      <div className="mt-1 space-y-1.5">
        {forks.map((fork) => (
          <div
            key={fork.parentIndex}
            className="rounded-md border border-twilio-gray-20 bg-white px-2 py-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-twilio-navy">
                {/* Marked where this is the fork on the event's *second* pass through the component, so
                    two cards under one name are told apart by more than their position. */}
                {fork.returning ? `↺ ${fork.parentName}` : fork.parentName}
              </span>
              {/* Two states named for what the reader sees, not for the field underneath. */}
              <div className="flex shrink-0 overflow-hidden rounded border border-twilio-gray-20">
                {[
                  [false, 'Together'],
                  [true, 'One at a time'],
                ].map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onOneAtATime(fork.parentId, fork.children, value)}
                    aria-pressed={fork.oneAtATime === value}
                    className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                      fork.oneAtATime === value
                        ? 'bg-twilio-blue text-white'
                        : 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <ol className="mt-1 space-y-0.5">
              {fork.arms.map((arm, at) => (
                <li key={arm.nodeId} className="flex items-center gap-1">
                  {/* Numbered only when the order means something. Numbering simultaneous arms would
                      claim a sequence the event does not take. */}
                  <span className="w-3 shrink-0 text-right font-mono text-[9px] text-twilio-gray-40">
                    {fork.oneAtATime ? `${at + 1}` : '·'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-twilio-gray-80">
                    {arm.name}
                  </span>
                  {/* Moving an arm is also what asks for a sequence -- ordering arms that arrive at the
                      same instant is not something anyone can mean -- so these stay live even when the
                      fork is set to Together, and pressing one switches it. */}
                  <button
                    type="button"
                    onClick={() => onMove(fork.parentId, arm.nodeId, -1, fork.children)}
                    disabled={at === 0}
                    title="Take this branch earlier"
                    aria-label={`Take ${arm.name} earlier`}
                    className="rounded p-0.5 text-twilio-gray-40 enabled:hover:text-twilio-blue disabled:opacity-30"
                  >
                    <ArrowUp size={11} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(fork.parentId, arm.nodeId, 1, fork.children)}
                    disabled={at === fork.arms.length - 1}
                    title="Take this branch later"
                    aria-label={`Take ${arm.name} later`}
                    className="rounded p-0.5 text-twilio-gray-40 enabled:hover:text-twilio-blue disabled:opacity-30"
                  >
                    <ArrowDown size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
        Together, the event goes down every branch at once — which is what really happens. One at a
        time tells the story branch by branch instead: the route above gains a row for each, and the
        diagram is not changed either way.
      </p>
    </div>
  )
}

/* Status to colour. Deliberately the same three readings the canvas uses -- arrived, stopped, and
   unsettled -- so a bubble and the component it stands for cannot appear to disagree. */
/*
 * What to assume about each component whose real behaviour the diagram does not record.
 *
 * ## Why this exists at all
 *
 * Because the simulator used to decide for itself, and decided badly. A destination filter with no
 * condition and no actions matched every event, found no action to take, and dropped it -- so an empty
 * box read as an architectural finding and took the rest of the walkthrough down with it. Since the
 * fields that would have said otherwise are read-only in the inspector, there was no way to argue.
 *
 * So the default is now "let it through", and this is where the reader says otherwise. Three answers,
 * because two were never enough: the drawer has claimed in a comment for a long time that "assume it
 * drops" and "switch it off entirely" are different statements -- a dropping insert function still ran
 * -- and there was no UI anywhere that could express the difference.
 *
 * ## Why it is a separate block from the switched-off chips
 *
 * They answer different questions and one is not a special case of the other. Switching a component off
 * is a claim about the workspace: it is not there, nothing reaches it, and it applies to components
 * whose rules we *can* read perfectly well. This is a claim about a gap in the diagram, and it only
 * applies where there is a gap. A component that is switched off is shown here but marked, because
 * `visit` checks switched-off first and its fallback truly cannot apply -- saying so beats a control
 * that silently does nothing.
 *
 * `Modify` appears only for components that could actually reshape a payload. An audience decides
 * whether a profile is in a set; it does not rewrite an event, and offering the option there would
 * invite a claim the diagram cannot support.
 */
function Assumptions({ entries, onSet, onFocusNode }) {
  if (!entries?.length) return null

  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
        Where the diagram does not say
      </p>

      <div className="mt-1 space-y-1.5">
        {entries.map((entry) => {
          const options = [
            [FALLBACK.allow, 'Allow'],
            [FALLBACK.block, 'Block'],
            ...(entry.canModify ? [[FALLBACK.modify, 'Modify']] : []),
          ]
          return (
            <div
              key={entry.nodeId}
              className="rounded-md border border-twilio-gray-20 bg-white px-2 py-1.5"
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onFocusNode?.(entry.nodeId)}
                  title={`Show “${entry.name}” on the canvas`}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-twilio-navy hover:underline"
                >
                  {entry.name}
                </button>
                {/* Labelled, because three unlabelled buttons repeated down a list are three buttons a
                    screen reader reads as "Allow, Block, Modify" with no way to tell which component
                    they belong to. */}
                <div
                  role="group"
                  aria-label={`What to assume about “${entry.name}”`}
                  className="flex shrink-0 overflow-hidden rounded border border-twilio-gray-20"
                >
                  {options.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => onSet(entry.nodeId, value)}
                      aria-pressed={entry.how === value}
                      disabled={entry.switchedOff}
                      title={
                        entry.switchedOff
                          ? `“${entry.name}” is switched off for this path, so nothing reaches it and this makes no difference.`
                          : undefined
                      }
                      className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                        entry.how === value
                          ? 'bg-twilio-blue text-white'
                          : 'bg-white text-twilio-gray-60 hover:bg-twilio-gray-10'
                      } ${entry.switchedOff ? 'cursor-default opacity-40' : ''}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {entry.switchedOff && (
                <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
                  Switched off for this path, so nothing reaches it and this setting does not apply.
                </p>
              )}
            </div>
          )
        })}
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-twilio-gray-40">
        These components carry rules this tool cannot always read — a filter with no actions recorded, a
        function body, an audience needing profile history. Allow is the default: the event passes and
        the route reads green. Block stops it here. Modify passes it on with the payload treated as
        reshaped. None of this changes the diagram, and where the rules *can* be read they win — a
        filter whose condition the event does not match still leaves it alone whatever you set.
      </p>
    </div>
  )
}

function bubbleTone(status, off) {
  if (off) return 'border-twilio-gray-20 bg-twilio-gray-10 text-twilio-gray-40 line-through'
  if (status === STATUS.dropped || status === STATUS.blocked || status === STATUS.unmatched) {
    return 'border-twilio-error/40 bg-red-50 text-twilio-red-dark'
  }
  if (hasArrived(status)) return 'border-twilio-success/40 bg-green-50 text-twilio-gray-80'
  return 'border-twilio-warning/40 bg-orange-50 text-twilio-gray-80'
}

/* The mark on the state target, and the whole of what it has to say at a glance. */
const PATH_STATE_MARK = {
  [PATH_STATE.pass]: '✓',
  [PATH_STATE.skip]: '↷',
  [PATH_STATE.block]: '×',
}

function TimelineBubble({ entry, state, twice, offerRevisit, onSetState, onRevisit, onFocusNode }) {
  const { nodeId, name, status, isStart, returning } = entry
  const [choosing, setChoosing] = useState(false)
  const off = state !== PATH_STATE.pass

  return (
    <span className="relative flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => onFocusNode?.(nodeId)}
        title={`Show “${name}” on the canvas`}
        className={`max-w-40 truncate rounded-l-full border py-0.5 pl-2 pr-1 text-[10px] transition-colors hover:brightness-95 ${bubbleTone(status, off)}`}
      >
        {/* The mark rides with the name rather than in a tone of its own, because a second stop is not
            a different verdict -- it is the same component reporting again, and colouring it
            differently would say the walk found something new here. */}
        {returning ? `↺ ${name}` : name}
      </button>
      {/* Separate targets from the name, so "show me this", "what does this path do with it" and "come
          back through this" cannot be mis-hit for one another.

          The return control is offered only where the diagram has a second way in, because everywhere
          else it is a button that cannot change anything. */}
      {offerRevisit && !isStart && (
        <button
          type="button"
          onClick={() => onRevisit(nodeId)}
          disabled={off}
          aria-pressed={twice}
          title={
            off
              ? `“${name}” is not passed through on this path, so there is nothing to stop at.`
              : twice
                ? `Stop at “${name}” once — a second arrival will just light the connector`
                : `Stop at “${name}” twice, where this path doubles back through it`
          }
          className={`border border-l-0 px-1 py-0.5 text-[10px] transition-colors ${bubbleTone(status, off)} ${
            off ? 'cursor-default opacity-40' : 'hover:brightness-95'
          } ${twice ? 'font-semibold' : 'opacity-60'}`}
        >
          ↺
        </button>
      )}
      {/*
        * Three states behind one target, where there used to be a two-way toggle.
        *
        * The `×` this replaces could only reach `excluded`, and nothing about it said that "the event
        * steps over this" was one of three answers rather than the only alternative to Pass -- so the
        * red state was unreachable and the amber one looked like deletion. Opening a small menu costs a
        * click and makes all three visible at once, which is the only way a reader learns the middle one
        * exists.
        */}
      <button
        type="button"
        onClick={() => !isStart && setChoosing((open) => !open)}
        disabled={isStart}
        aria-haspopup="menu"
        aria-expanded={choosing}
        title={
          isStart
            ? 'This is where the path starts, so the event always passes through it.'
            : `This path ${state === PATH_STATE.pass ? 'passes the event through' : state === PATH_STATE.skip ? 'steps over' : 'stops the event at'} “${name}” — click to change`
        }
        className={`rounded-r-full border border-l-0 px-1.5 py-0.5 text-[10px] transition-colors ${bubbleTone(status, off)} ${
          isStart ? 'cursor-default opacity-40' : 'hover:brightness-95'
        }`}
      >
        {isStart ? '◆' : PATH_STATE_MARK[state]}
      </button>

      {choosing && (
        <>
          {/* Closes on the next click anywhere, which is what a menu with no framework behind it needs.
              Behind the menu in paint order and in front of everything else. */}
          <span
            className="fixed inset-0 z-20"
            onClick={() => setChoosing(false)}
            aria-hidden="true"
          />
          <span
            role="menu"
            aria-label={`What this path does with “${name}”`}
            className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-twilio-gray-20 bg-white shadow-lg"
          >
            {PATH_STATE_ROWS.map(([value, label, note]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={state === value}
                onClick={() => {
                  onSetState(nodeId, value)
                  setChoosing(false)
                }}
                className={`block w-full px-2 py-1.5 text-left transition-colors hover:bg-twilio-gray-10 ${
                  state === value ? 'bg-twilio-blue-light' : ''
                }`}
              >
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-twilio-navy">
                  <span className="w-3 text-center">{PATH_STATE_MARK[value]}</span>
                  {label}
                </span>
                <span className="mt-0.5 block pl-[18px] text-[10px] leading-snug text-twilio-gray-60">
                  {note}
                </span>
              </button>
            ))}
          </span>
        </>
      )}
    </span>
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
