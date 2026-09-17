/*
 * The Code tab: the function body, its settings, and a way to run one event through it.
 *
 * This is the tab that made the Rules tab stop saying "the function body is not read by
 * this tool". It used to be true, and it was the right call while the alternative was
 * transcribing code into a diagram where it would go stale. What changed is that the
 * code here is not a *transcription* -- it is the thing the walkthrough runs, so a stale
 * copy is not a risk quietly carried, it is a wrong verdict on screen where the reader
 * can see it and fix it.
 *
 * ## Testing, and where the payload comes from
 *
 * The event to test against is picked from the same five call types the palette's Events
 * tab offers, built by ../simulation/payload.js's `skeleton` -- so what is tested here
 * and what a walkthrough sends down the diagram are the same shapes, and a function that
 * passes here cannot then behave differently on the canvas for a reason nobody can see.
 * Any saved path's own event is offered too, since that is the payload the reader
 * actually curated.
 *
 * The payload is editable, because the interesting tests are the edited ones: the
 * shipped destination-insert default drops an event with `properties.is_test === true`,
 * and there is no way to see that without typing it.
 *
 * ## Why the result panel is as long as it is
 *
 * Asked for: console output, errors, and success metrics. They are not three views of
 * one thing -- a function can log four lines, return an event, and still be wrong, and a
 * panel that reported only the last of those would be the same "it seems to work" that
 * sends people to the Errors tab in the real workspace. So the run reports what it
 * *did*: which handler answered, how long it took, which fields moved, what it printed,
 * and what came out.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  Play,
  RotateCcw,
  Terminal,
  TriangleAlert,
} from 'lucide-react'

import CodeEditor from '../functions/CodeEditor.jsx'
import Checklist from './Checklist.jsx'
import { EmptyNote, Row, Section } from './primitives.jsx'
import {
  DOCS_URL,
  MAX_CODE_LENGTH,
  defaultCode,
  handlerNames,
  isDefaultCode,
} from '../functions/defaults.js'
import { OUTCOME, TEST_DEADLINE_MS, runFunction, summarizeChanges } from '../functions/runtime.js'
import {
  anchor,
  anchoredLines,
  checklistState,
  newStepId,
  unanchor,
} from '../functions/steps.js'
import { EVENT_TYPES, skeleton } from '../simulation/payload.js'

/*
 * How each outcome reads.
 *
 * `tone` drives the colour and nothing else derives it, so the badge, the border and the
 * icon cannot disagree. Three tones only -- good, stopped, unsettled -- deliberately the
 * same three readings the canvas gives a component, because someone comparing this panel
 * with the diagram beside it should not have to reconcile two vocabularies.
 */
const OUTCOMES = {
  [OUTCOME.returned]: { tone: 'good', label: 'Returned the event' },
  [OUTCOME.emitted]: { tone: 'good', label: 'Emitted events' },
  [OUTCOME.empty]: { tone: 'stopped', label: 'Returned nothing' },
  [OUTCOME.dropped]: { tone: 'stopped', label: 'Dropped the event' },
  [OUTCOME.invalid]: { tone: 'stopped', label: 'Rejected the event' },
  [OUTCOME.unsupported]: { tone: 'stopped', label: 'Event type not supported' },
  [OUTCOME.noHandler]: { tone: 'stopped', label: 'No handler for this type' },
  [OUTCOME.retry]: { tone: 'unsettled', label: 'Asked to be retried' },
  [OUTCOME.unavailable]: { tone: 'unsettled', label: 'Not simulated locally' },
  [OUTCOME.error]: { tone: 'stopped', label: 'Threw an error' },
  [OUTCOME.notRunnable]: { tone: 'stopped', label: 'Did not compile' },
}

const TONES = {
  good: {
    icon: CheckCircle2,
    box: 'border-twilio-success/40 bg-green-50',
    text: 'text-twilio-success',
  },
  stopped: {
    icon: Ban,
    box: 'border-twilio-error/40 bg-twilio-red-light',
    text: 'text-twilio-red-dark',
  },
  unsettled: {
    icon: TriangleAlert,
    box: 'border-twilio-warning/40 bg-orange-50',
    text: 'text-twilio-warning',
  },
}

const LOG_TONE = {
  error: 'text-red-300',
  warn: 'text-orange-300',
  debug: 'text-twilio-gray-40',
}

export default function CodeTab({ node, scenarios, wide, onWide, onUpdate, onNotify }) {
  const data = node.data
  const kind = data.kind

  /*
   * The code is held here and committed on blur, not on every keystroke.
   *
   * Each commit replaces the node in React Flow's store *and* re-runs the walkthrough
   * for every path through this component -- which now means executing this code. Doing
   * that per character is the lag `EditableText` in ./primitives.jsx already documents,
   * with a compile step added on top.
   *
   * The consequence is deliberate and worth knowing: the canvas catches up when you stop
   * typing. Tests below run against the draft, so the loop of edit-and-test stays tight
   * either way.
   */
  const [draft, setDraft] = useState(data.code ?? '')
  const [result, setResult] = useState(null)
  const [eventSource, setEventSource] = useState('track')
  const [payloadText, setPayloadText] = useState(() => pretty(skeleton('track')))
  const [payloadOpen, setPayloadOpen] = useState(false)

  /*
   * Give the width back on the way out.
   *
   * This tab is keyed on the node id, so selecting another component unmounts it -- and a
   * sidebar left at 42rem over a diagram nobody is editing code on is the shell holding a
   * width for a reason that has gone away. Held in a ref so the effect can stay mount-only:
   * naming `onWide` as a dependency would re-run it on every render the parent gives a fresh
   * callback, narrowing the panel while someone is typing in it.
   */
  const wideRef = useRef(onWide)
  wideRef.current = onWide
  useEffect(() => () => wideRef.current?.(false), [])

  const seeded = defaultCode(kind)
  /* Paths that begin at this component. Their walkthrough never runs this code -- see
     the note rendered for them below. */
  const startsHere = (scenarios ?? []).filter((scenario) => scenario.sourceId === node.id)

  /*
   * The checklist, resolved against the *draft* rather than the committed code.
   *
   * That matters while someone is mid-edit: the anchors live in the source, so reading them
   * from the node would show the badges on the lines they were on before the last few
   * keystrokes moved them. Resolving against the draft keeps the gutter and the code in step
   * at all times, which is the entire promise of anchoring to a line.
   *
   * `result` supplies the ticks and crosses; before a run there is none, and every anchored
   * item reads as pending rather than as failed.
   */
  const items = data.checklist ?? []
  const steps = useMemo(
    () => checklistState(items, draft, result?.hits ?? null, result?.tracked ?? null),
    [items, draft, result],
  )

  /* Committing the draft *and* a checklist change in one patch, because anchoring does both
     at once -- it writes a marker into the code and adds an item to the list -- and two
     separate `onUpdate` calls would put a graph state through the canvas in which the marker
     exists and the item does not. */
  const commit = (patch) => {
    onUpdate(patch)
    if (patch.code !== undefined) setDraft(patch.code)
  }

  const addStep = (line) => {
    const id = newStepId(items, draft)
    commit({
      code: anchor(draft, line, id),
      checklist: [...items, { id, label: '' }],
    })
    setResult(null)
  }

  const updateStep = (id, patch) => {
    onUpdate({ checklist: items.map((item) => (item.id === id ? { ...item, ...patch } : item)) })
  }

  const removeStep = (id) => {
    commit({
      code: unanchor(draft, id),
      checklist: items.filter((item) => item.id !== id),
    })
  }

  const moveStep = (id, by) => {
    const from = items.findIndex((item) => item.id === id)
    const to = from + by
    if (from < 0 || to < 0 || to >= items.length) return
    const next = [...items]
    ;[next[from], next[to]] = [next[to], next[from]]
    onUpdate({ checklist: next })
  }

  const chooseEvent = (value) => {
    setEventSource(value)
    setResult(null)
    const saved = (scenarios ?? []).find((scenario) => scenario.id === value)
    const picked = saved ? saved.event : skeleton(value)
    setPayloadText(pretty(picked ?? skeleton('track')))
  }

  const test = () => {
    let event
    try {
      event = JSON.parse(payloadText)
    } catch (err) {
      setResult(null)
      setPayloadOpen(true)
      onNotify?.({ tone: 'error', message: `That payload is not valid JSON: ${err.message}` })
      return
    }

    setResult(
      runFunction({
        code: draft,
        kind,
        event,
        settings: data.functionSettings ?? {},
        /* Longer than the walkthrough allows itself, because this run is something the
           reader asked for and is watching. See TEST_DEADLINE_MS. */
        deadlineMs: TEST_DEADLINE_MS,
        /* The anchored lines, so the run reports which of them it reached. Read off the
           draft for the same reason the checklist is. */
        probes: Object.values(anchoredLines(draft)),
      }),
    )
  }

  return (
    <>
      <Section
        title="Function body"
        note={
          kind === 'source_function'
            ? 'One handler, onRequest, and it emits events with Segment.track / Segment.identify rather than returning them.'
            : 'One handler per event type, each returning the event to pass on. An omitted handler blocks that event type outright.'
        }
        actions={
          seeded && (
            <button
              type="button"
              onClick={() => {
                setDraft(seeded)
                onUpdate({ code: seeded })
                setResult(null)
                onNotify?.({
                  tone: 'info',
                  message: isDefaultCode(kind, draft)
                    ? 'Already the starting code.'
                    : 'Replaced with the starting code for this function type.',
                })
              }}
              title="Replace this with the out-of-the-box code for this function type"
              className="nodrag flex items-center gap-1 rounded border border-twilio-gray-20 px-1.5 py-0.5 text-[10px] text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-blue"
            >
              <RotateCcw size={11} aria-hidden="true" />
              Reset
            </button>
          )
        }
      >
        <CodeEditor
          value={draft}
          max={MAX_CODE_LENGTH}
          label={`${data.name ?? 'function'} body`}
          steps={steps}
          onAddStep={addStep}
          onStepClick={(id) => document.getElementById(`step-${id}`)?.focus()}
          wide={wide}
          onWide={onWide}
          onChange={setDraft}
          onCommit={() => {
            if (draft !== (data.code ?? '')) onUpdate({ code: draft })
          }}
          onRefuse={(length) =>
            onNotify?.({
              tone: 'error',
              message: `That is ${(length - MAX_CODE_LENGTH).toLocaleString()} characters over what a diagram will hold, so the end was trimmed. A real function can be longer than this — the cap is about the document, not about Segment.`,
            })
          }
          placeholder="No code yet — click to write some, or press Reset for the starting code."
        />

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[10px] text-twilio-gray-60">
            Handlers: <span className="font-mono">{handlerNames(kind).join(', ')}</span>
          </span>
          {DOCS_URL[kind] && (
            <a
              href={DOCS_URL[kind]}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[10px] text-twilio-blue hover:underline"
            >
              <ExternalLink size={10} aria-hidden="true" />
              Segment docs
            </a>
          )}
        </div>

        {data.code === undefined && data.bound && (
          /*
           * A function discovered from the workspace, which therefore has no code here.
           *
           * Deliberately not seeded with the template: the Public API does not return a
           * function's body, so filling one in would have the walkthrough report this
           * tool's guess as this customer's behaviour. Empty is the honest state, and the
           * button beside it is how someone pastes the real thing in.
           */
          <p className="mt-1 rounded-md border border-twilio-gray-20 bg-twilio-gray-10 px-2 py-1.5 text-[10px] leading-snug text-twilio-gray-80">
            This component is bound to a function in the workspace, and Segment&rsquo;s API does not
            return a function&rsquo;s body — so nothing was read into here. Until something is pasted
            in, the walkthrough says only that this stage may reshape the event, which is all that is
            actually known about it. Copy the real body from the workspace to have it run.
          </p>
        )}

        <EmptyNote>
          Run here, in this tab, synchronously — so there is no <span className="font-mono">fetch</span>,
          no <span className="font-mono">cache</span> that survives a call, and no waiting. Code that
          needs any of those is reported as not simulated rather than guessed at, and the walkthrough
          falls back to &ldquo;this stage may reshape the event&rdquo;.
        </EmptyNote>

        {startsHere.length > 0 && (
          <p className="mt-1 rounded-md border border-twilio-warning/40 bg-orange-50 px-2 py-1.5 text-[10px] leading-snug text-twilio-gray-80">
            {startsHere.length === 1 ? 'The path ' : 'The paths '}
            {startsHere.map((scenario) => `“${scenario.name}”`).join(', ')} start
            {startsHere.length === 1 ? 's' : ''} at this component, and a walkthrough does not
            evaluate the component it starts from — so this code does not run on{' '}
            {startsHere.length === 1 ? 'it' : 'them'}. Start the path one component upstream to see
            it take effect.
          </p>
        )}
      </Section>

      <Checklist
        steps={steps}
        onUpdate={updateStep}
        onRemove={removeStep}
        onMove={moveStep}
        hasRun={Boolean(result)}
      />

      <Settings
        value={data.functionSettings}
        onUpdate={onUpdate}
        onNotify={onNotify}
      />

      <Section
        title="Test"
        note="One event, through the code above, right now. Nothing is sent anywhere."
      >
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
              Event
            </span>
            <select
              value={eventSource}
              onChange={(event) => chooseEvent(event.target.value)}
              className="mt-0.5 w-full rounded border border-twilio-gray-20 px-1.5 py-1 text-[11px]"
            >
              {/* The palette's own five, so the vocabulary is the same wherever an event
                  is chosen in this tool. */}
              <optgroup label="Sample events">
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </optgroup>
              {scenarios?.length > 0 && (
                <optgroup label="Saved paths">
                  {scenarios
                    .filter((scenario) => scenario.event)
                    .map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name} ({scenario.event.type})
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={test}
            disabled={!draft.trim()}
            className="nodrag flex shrink-0 items-center gap-1 rounded-md bg-twilio-blue px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-40"
          >
            <Play size={12} aria-hidden="true" />
            Test
          </button>
        </div>

        <details
          open={payloadOpen}
          onToggle={(event) => setPayloadOpen(event.currentTarget.open)}
          className="mt-2"
        >
          <summary className="cursor-pointer text-[10px] text-twilio-gray-60">
            Payload — edit it to test a branch
          </summary>
          <textarea
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            rows={8}
            spellCheck={false}
            aria-label="Test event payload"
            className="nodrag mt-1 w-full resize-y rounded border border-twilio-gray-20 p-2 font-mono text-[10px] outline-none focus:border-twilio-blue"
          />
        </details>

        {result && <Result result={result} />}
      </Section>
    </>
  )
}

/*
 * The function's settings, as JSON.
 *
 * A `<details>` because most functions do not need one and a always-open textarea would
 * put an empty box above the thing people came for. But it is here rather than absent,
 * because every handler in every Segment template takes `settings` as its second
 * argument, and without somewhere to put one, testing any real function stops at its
 * first `if (!settings.apiKey) throw new ValidationError(...)`.
 */
function Settings({ value, onUpdate, onNotify }) {
  const [text, setText] = useState(() => (value ? pretty(value) : ''))
  const [error, setError] = useState(null)

  const count = value && typeof value === 'object' ? Object.keys(value).length : 0

  const commit = () => {
    if (!text.trim()) {
      setError(null)
      onUpdate({ functionSettings: undefined })
      return
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Settings must be a JSON object.')
        return
      }
      setError(null)
      onUpdate({ functionSettings: parsed })
      const secret = Object.keys(parsed).filter(isSecretish)
      if (secret.length > 0) {
        /* Said out loud rather than let happen quietly. `stripSecrets` in
           diagram/serialize.js and `sanitize_graph` in apps/diagrams/models.py both drop
           these on the way to storage, which is right -- a diagram is not a place for a
           credential -- but a value that vanishes on reload with no explanation reads as
           the save having failed. */
        onNotify?.({
          tone: 'info',
          message: `${secret.join(', ')} will work for tests in this tab but is not saved with the diagram: secret-shaped keys are stripped on the way to storage.`,
        })
      }
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Section title="Settings">
      <details>
        <summary className="cursor-pointer text-[10px] text-twilio-gray-60">
          The <span className="font-mono">settings</span> object handlers receive
          {count > 0 ? ` — ${count} key${count === 1 ? '' : 's'}` : ' — none set'}
        </summary>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          rows={4}
          spellCheck={false}
          placeholder={'{\n  "endpoint": "https://api.example.com"\n}'}
          aria-label="Function settings, as JSON"
          className="nodrag mt-1 w-full resize-y rounded border border-twilio-gray-20 p-2 font-mono text-[10px] outline-none focus:border-twilio-blue"
        />
        {error ? (
          <p role="alert" className="mt-1 text-[10px] text-twilio-red-dark">
            {error}
          </p>
        ) : (
          <p className="mt-1 text-[10px] leading-snug text-twilio-gray-40">
            Keys that look like credentials — <span className="font-mono">apiKey</span>,{' '}
            <span className="font-mono">token</span>, <span className="font-mono">secret</span>,{' '}
            <span className="font-mono">password</span> — are dropped before the diagram is saved.
            They work for a test in this tab and do not survive a reload.
          </p>
        )}
      </details>
    </Section>
  )
}

function Result({ result }) {
  const reading = OUTCOMES[result.outcome] ?? { tone: 'unsettled', label: result.outcome }
  const tone = TONES[reading.tone]
  const Icon = tone.icon
  const changes = summarizeChanges(result.changed)

  return (
    <div className="mt-3 space-y-2">
      <div className={`rounded-md border px-2 py-1.5 ${tone.box}`}>
        <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${tone.text}`}>
          <Icon size={12} className="shrink-0" aria-hidden="true" />
          {reading.label}
        </p>

        {/* The metrics. Deliberately including the ones that are boring when they are
            boring: "0 fields changed" after a run is a result, and its absence would
            leave the reader unsure whether the panel had looked. */}
        <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-twilio-gray-80">
          <Metric label="handler" value={result.handler ? `${result.handler}()` : 'none'} />
          <Metric label="took" value={`${result.ms}ms`} />
          <Metric
            label="fields changed"
            value={result.changed.length === 0 ? 'none' : String(result.changed.length)}
          />
          <Metric
            label="logged"
            value={result.logs.length === 0 ? 'nothing' : `${result.logs.length} lines`}
          />
          {result.emitted.length > 0 && (
            <Metric label="emitted" value={`${result.emitted.length} events`} />
          )}
        </dl>
      </div>

      {result.error && (
        <div className="rounded-md border border-twilio-gray-20 p-2">
          <p className="flex items-start gap-1.5 text-[10px] leading-snug text-twilio-navy">
            <AlertCircle size={11} className="mt-px shrink-0 text-twilio-red-dark" aria-hidden="true" />
            <span>
              <span className="font-mono font-semibold">{result.error.name}</span>
              {': '}
              {result.error.message}
            </span>
          </p>
        </div>
      )}

      {changes && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            What changed
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.changed.map((entry) => (
              <li key={entry.path} className="flex items-start gap-1 text-[10px]">
                <ChevronRight size={10} className="mt-0.5 shrink-0 text-twilio-gray-40" aria-hidden="true" />
                <span className="min-w-0 break-all">
                  <span className="font-mono text-twilio-navy">{entry.path}</span>{' '}
                  <span className="text-twilio-gray-60">
                    {entry.from === undefined
                      ? `added as ${scalar(entry.to)}`
                      : entry.to === undefined
                        ? `removed (was ${scalar(entry.from)})`
                        : `${scalar(entry.from)} → ${scalar(entry.to)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.logs.length > 0 && (
        <div>
          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            <Terminal size={10} aria-hidden="true" />
            Console
          </p>
          {/* Dark, and monospaced, because it is a console -- and because the level
              colours need a background they can all be legible against. */}
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-twilio-navy/95 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-white">
            {result.logs.map((line, index) => (
              <div key={index} className={LOG_TONE[line.level] ?? 'text-white'}>
                {line.level !== 'log' && <span className="opacity-60">{line.level}: </span>}
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      )}

      {result.payload ? (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
            {result.outcome === OUTCOME.emitted ? 'First event emitted' : 'Event returned'}
          </p>
          <pre className="mt-1 max-h-56 overflow-auto rounded border border-twilio-gray-20 bg-twilio-gray-10 p-2 font-mono text-[10px] leading-relaxed text-twilio-slate">
            {pretty(result.payload)}
          </pre>
        </div>
      ) : (
        <p className="flex items-start gap-1.5 text-[10px] leading-snug text-twilio-gray-60">
          <CircleSlash size={11} className="mt-px shrink-0 text-twilio-gray-40" aria-hidden="true" />
          No event came out, so nothing downstream of this component would receive one.
        </p>
      )}

      {result.emitted.length > 1 && (
        <Row label="Also emitted">
          <span className="font-mono text-[10px] text-twilio-navy">
            {result.emitted
              .slice(1)
              .map((entry) => entry.type)
              .join(', ')}
          </span>
        </Row>
      )}

      {/* What ./prepare.js had to change to run it. Last, because it is true of every
          run and only interesting the first time. */}
      {result.notes.map((note) => (
        <p key={note} className="text-[10px] leading-snug text-twilio-gray-40">
          {note}
        </p>
      ))}
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <span className="flex items-baseline gap-1">
      <dt className="text-twilio-gray-60">{label}</dt>
      <dd className="font-mono font-semibold">{value}</dd>
    </span>
  )
}

const isSecretish = (key) => /(write[_-]?key|api[_-]?key|token|secret|password|credential)/i.test(key)

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/* A value as one short line, so a diff row stays a row. */
function scalar(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}
