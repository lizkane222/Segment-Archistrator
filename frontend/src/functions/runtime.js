/*
 * Running a Segment function against one event, here, now, synchronously.
 *
 * Two callers, one runner. ../simulation/router.js calls it while tracing a path, so
 * a function's code has a real effect on the payload that reaches the next component;
 * ../inspector/CodeTab.jsx calls it when someone presses Test, and shows the console
 * output and the diff. They must not be able to disagree about what a function does,
 * which is the whole reason this is one module and not two.
 *
 * ## What this is not
 *
 * It is not a sandbox in the security sense, and nothing here should be read as
 * claiming otherwise. Code compiled with `new Function` can reach the realm it was
 * compiled in -- `(function(){}).constructor` is enough -- so the parameter list below
 * is defence in depth rather than a boundary. What makes the risk acceptable is
 * narrower and more checkable: the runner hands the code *no* network, no DOM, no
 * storage, and a step budget, so the worst a hostile function can do is throw or burn
 * a bounded amount of CPU. Diagrams are scoped per workspace and there is deliberately
 * no sharing primitive (see apps/diagrams/models.py), so this is the user's own code
 * in the user's own tab -- the same trust level as the CSV the Data tab lets them
 * paste.
 *
 * ## The honest gaps
 *
 * `fetch`, `crypto.createHash`, `https`, `AWS`, `moment` and lodash's `_` are all
 * present and all throw, each naming itself. That is deliberate and it is the
 * important design decision in this file: a function that enriches from an API cannot
 * be simulated locally, and the two ways to handle that are to guess or to say so.
 * Reaching one of them produces `OUTCOME.unavailable`, which the router maps back to
 * exactly the verdict it gave before any of this existed -- "this stage may reshape
 * the event, and its code is not read". A wrong payload shown confidently would be
 * worse than no payload.
 *
 * ## Determinism
 *
 * `simulate()` is memoised on (graph, event), which holds only if running the same
 * code over the same event twice gives the same answer. So the runner offers nothing
 * that varies by itself: no clock beyond the deadline check, no `randomUUID`, no
 * network. Code that reaches for `Math.random()` can still make its own walkthrough
 * unstable, which is a thing the user has done rather than a thing the tool did.
 */

import { HANDLER_FOR_TYPE, REQUEST_HANDLER, handlerNames } from './defaults.js'
import { prepare } from './prepare.js'

/* How the run ended. The router maps these onto its own statuses; the panel prints them. */
export const OUTCOME = Object.freeze({
  /** The handler returned an event. The ordinary case. */
  returned: 'returned',
  /** A source function emitted at least one event. */
  emitted: 'emitted',
  /** Returned nothing, or emitted nothing. Downstream receives nothing. */
  empty: 'empty',
  /** `throw new DropEvent(...)` — deliberate, and the commonest reason to write one of these. */
  dropped: 'dropped',
  /** `throw new RetryError(...)` — transient, so whether it eventually lands is unknowable here. */
  retry: 'retry',
  /** `ValidationError` or `InvalidEventPayload` — permanent reject, no retry. */
  invalid: 'invalid',
  /** `EventNotSupported` — this function does not handle that event type. */
  unsupported: 'unsupported',
  /** No handler declared for this event type. For an insert function that blocks the type. */
  noHandler: 'no_handler',
  /** The code asked for something the local runner does not have. Not a fault in the code. */
  unavailable: 'unavailable',
  /** The code threw something else, or ran away and was stopped. */
  error: 'error',
  /** It could not be compiled at all, so it was never run. */
  notRunnable: 'not_runnable',
})

/*
 * Budgets.
 *
 * The router's deadline is short on purpose: it runs inside a memoised derivation
 * during render, once per function on the path, and a slow one is felt as the canvas
 * stuttering. The tester's is long enough to be worth pressing a button for.
 */
export const ROUTER_DEADLINE_MS = 120
export const TEST_DEADLINE_MS = 2000
const MAX_STEPS = 500000

const MAX_LOGS = 100
const MAX_LOG_LENGTH = 600
const MAX_EMITTED = 20
const MAX_CHANGED = 40

/* --- the error classes a function is written against ----------------------- */

/*
 * Real classes, created once, and handed to the code as globals. They have to be
 * identities rather than names so `error instanceof DropEvent` is what classifies the
 * outcome: matching on `error.name` would mean any error a user happened to call
 * "DropEvent" silently became a drop verdict on their diagram.
 */
class FunctionError extends Error {
  constructor(message) {
    super(message)
    this.name = new.target.name
  }
}

export class DropEvent extends FunctionError {}
export class RetryError extends FunctionError {}
export class ValidationError extends FunctionError {}
export class InvalidEventPayload extends FunctionError {}
export class EventNotSupported extends FunctionError {}

/** Thrown by the injected loop guard. Internal: the code cannot catch what it cannot name. */
class StepLimitExceeded extends Error {}
/** Thrown by everything the local runner does not have. */
class NotAvailableLocally extends Error {}

/* --- the injected globals -------------------------------------------------- */

/*
 * Names shadowed to nothing, so ambient browser capability is not simply lying around.
 *
 * `eval` and `arguments` are absent from this list because a strict-mode function
 * cannot take them as parameter names -- which is also why the header above does not
 * claim this contains anything.
 */
const SHADOWED = [
  'window',
  'document',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'location',
  'history',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'alert',
  'require',
  'process',
  'module',
  'exports',
  'postMessage',
  'open',
]

const PROVIDED = [
  '__tick',
  '__hit',
  'console',
  'Segment',
  'cache',
  'crypto',
  'fetch',
  'https',
  'AWS',
  'moment',
  '_',
  'DropEvent',
  'RetryError',
  'ValidationError',
  'InvalidEventPayload',
  'EventNotSupported',
]

/* `settings` is deliberately NOT here. Every one of Segment's own templates warns
   against hoisting it to module scope -- instances are reused between invocations, so
   a global settings value leaks between events -- and Segment cannot inject one in the
   first place. It is passed to the handler, which is the only place it belongs. */
const PARAMS = [...PROVIDED, ...SHADOWED]

/**
 * Something the local runner does not have, which announces itself when touched.
 *
 * A Proxy rather than a function that throws, so `_.get(...)`, `moment().format()` and
 * `AWS.S3` all fail with the same sentence instead of `undefined is not a function`.
 * `typeof` does not trip the trap, so a guard like `if (typeof fetch === 'function')`
 * still reads as true and fails at the call -- which is the more useful place to fail.
 */
function unavailable(name, because) {
  const fail = () => {
    throw new NotAvailableLocally(`\`${name}\` is not available in the local runner — ${because}`)
  }
  return new Proxy(fail, { get: fail, apply: fail, construct: fail })
}

function format(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function consoleSink(logs, limit) {
  const at = (level) => (...args) => {
    if (logs.length >= limit) return
    logs.push({ level, text: args.map(format).join(' ').slice(0, MAX_LOG_LENGTH) })
  }
  return { log: at('log'), info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') }
}

/**
 * The loop guard the prepared source calls at the top of every loop body.
 *
 * Two budgets, because they catch different mistakes: a step count catches a loop that
 * spins without doing anything, and a wall clock catches one that does a little work
 * each time round. The clock is only read every 1024 steps -- reading it every step is
 * itself the cost being guarded against.
 */
function ticker(deadlineMs) {
  const started = Date.now()
  let steps = 0
  return () => {
    steps += 1
    if (steps > MAX_STEPS) {
      throw new StepLimitExceeded(
        `Stopped after ${MAX_STEPS.toLocaleString()} loop steps. A loop here does not appear to finish.`,
      )
    }
    if ((steps & 1023) === 0 && Date.now() - started > deadlineMs) {
      throw new StepLimitExceeded(
        `Stopped after ${deadlineMs}ms. This ran for longer than the walkthrough can wait for it.`,
      )
    }
  }
}

/** A per-run `cache`. Process-local and empty at the start of every run, exactly as Segment's is in its own editor. */
function cacheStub() {
  const store = new Map()
  return {
    load(key, ttl, loader) {
      /* `load(key, loader)` with the TTL omitted is legal, and the TTL is ignored here
         regardless: a cache that expired inside a single synchronous run would be
         measuring something that cannot happen. */
      const load = typeof ttl === 'function' ? ttl : loader
      if (store.has(key)) return store.get(key)
      const value = typeof load === 'function' ? load() : undefined
      store.set(key, value)
      return value
    },
  }
}

/** The `Segment` global, and the events it collected. Source functions only. */
function emitter() {
  const events = []
  const emit = (type) => (payload = {}) => {
    if (events.length >= MAX_EMITTED) return
    events.push({ type, ...payload })
  }
  return {
    events,
    api: {
      identify: emit('identify'),
      track: emit('track'),
      page: emit('page'),
      screen: emit('screen'),
      group: emit('group'),
      alias: emit('alias'),
      /* The Object API. Its collection name must be lowercase and it does not appear in
         the Source Debugger -- neither of which this runner is in a position to check. */
      set: emit('set'),
    },
  }
}

/**
 * The `request` a source function is handed.
 *
 * `json()` returns the object rather than a promise, which is what makes `await
 * request.json()` work after ./prepare.js has removed the `await`. `headers` and `url`
 * are the real platform types where the environment has them, because the templates
 * warn specifically about the difference between `headers.get('x')` and `headers['x']`
 * and a plain object would quietly make the wrong one work.
 */
function requestFor(event) {
  const body = clone(event) ?? {}
  const headers =
    typeof Headers === 'function'
      ? new Headers({ 'content-type': 'application/json' })
      : { get: () => null }
  const url =
    typeof URL === 'function'
      ? new URL('https://fn.segmentapis.com/functions/webhook')
      : { searchParams: { get: () => null } }

  return {
    json: () => clone(body),
    text: () => JSON.stringify(body),
    headers,
    url,
  }
}

/** Thrown when an event cannot be copied, and therefore cannot be run against safely. */
class NotCloneable extends Error {
  constructor(message) {
    super(`This event cannot be copied (${message}), and running the code against the original would let it edit the walkthrough's own payload.`)
    this.name = 'NotCloneable'
  }
}

/**
 * A private copy of `value`, or nothing.
 *
 * Copying is not a convenience here, it is what two guarantees rest on: a handler must
 * not be able to reach back into the payload the router is threading through the trace,
 * and `changedPaths` needs a *before* that the handler could not have edited.
 *
 * So a failure to copy is a refusal, not a fallback. This used to return the original
 * object as a last resort, which broke both guarantees at once and did it invisibly: the
 * handler mutated the router's own payload, and because `changedPaths` short-circuits on
 * `a === b`, the walkthrough then reported "ran and returned the event unchanged" about a
 * run that had rewritten `userId`. A refusal the panel can print is far better than a
 * confident wrong answer.
 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    /* A payload holding something structuredClone refuses -- a function, a DOM node --
       may still survive a JSON round trip, which is what a hand-typed event is anyway. */
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (err) {
      throw new NotCloneable(err?.message ?? 'the payload could not be copied')
    }
  }
}

/* --- compiling ------------------------------------------------------------- */

/*
 * Compiled sources, keyed on the code exactly as the user typed it.
 *
 * The *factory* is cached, not the handlers: the handlers close over a run's console,
 * its emitter and its step budget, so they have to be rebuilt each run. What is
 * expensive is `new Function`, and that is what this avoids -- the router re-runs
 * every function on the path whenever the graph changes, and recompiling a 400-line
 * source on each of those is felt.
 *
 * Cleared wholesale rather than evicted one at a time. The bound exists to stop a
 * session from growing without limit, and an LRU here would be more machinery than the
 * problem deserves.
 */
const compiled = new Map()
const CACHE_LIMIT = 32

/**
 * Compile `code`, with coverage probes on `probes` wherever they can be placed.
 *
 * ## The fallback, which is the part worth reading
 *
 * `probePoint` in ./prepare.js decides where a probe may go from a set of conservative
 * rules rather than from a parse, so it can be wrong. When it is, the thing to give up is
 * the *coverage*, not the run: a checklist that admits it could not measure a line is a
 * small loss, and a function that stopped working because someone added a checkbox to it
 * is not.
 *
 * So a compile failure with probes is retried without them, and the difference between the
 * two attempts is what tells the caller which lines to report as untracked. A real syntax
 * error in the user's own code fails both ways and is reported as itself.
 */
function factoryFor(code, kind, probes = []) {
  const wanted = [...new Set(probes ?? [])].sort((a, b) => a - b)
  const key = `${kind}\u0000${wanted.join(',')}\u0000${code}`
  const cached = compiled.get(key)
  if (cached) return cached

  let entry = compileOnce(code, kind, wanted)

  if (!entry.factory && wanted.length > 0) {
    const bare = compileOnce(code, kind, [])
    if (bare.factory) {
      entry = { ...bare, prepared: { ...bare.prepared, tracked: [], untracked: wanted } }
    }
  }

  if (compiled.size >= CACHE_LIMIT) compiled.clear()
  compiled.set(key, entry)
  return entry
}

function compileOnce(code, kind, probes) {
  const prepared = prepare(code, { probes })
  if (prepared.error) return { prepared, factory: null, error: prepared.error }

  /*
   * Every handler name is looked up with `typeof`, which is safe on a name that was
   * never declared -- so a function that declares three of the seven returns nulls
   * for the rest, and the caller can tell "not declared" from "declared and threw".
   * That distinction matters: an omitted handler on an insert function *blocks* that
   * event type, which is a real Segment behaviour worth reporting.
   */
  const names = [...handlerNames(kind), REQUEST_HANDLER, ...Object.values(HANDLER_FOR_TYPE)]
  const table = [...new Set(names)]
    .map((name) => `${JSON.stringify(name)}: typeof ${name} === 'function' ? ${name} : null`)
    .join(', ')

  try {
    return {
      prepared,
      factory: new Function(...PARAMS, `'use strict';\n${prepared.code}\n;return {${table}};`),
      error: null,
    }
  } catch (err) {
    return { prepared, factory: null, error: explainCompileError(err) }
  }
}

/**
 * A compile failure, in terms the person editing the code can act on.
 *
 * Mostly the parser's own message, which is usually good. The one case worth
 * intercepting is a collision with an injected global: those arrive as parameters of
 * the compiled function, so `const cache = new Map()` is "Identifier 'cache' has
 * already been declared" -- true, and completely silent about who declared it.
 */
function explainCompileError(err) {
  const message = `${err.name}: ${err.message}`
  const collision = /Identifier '([^']+)' has already been declared/.exec(err.message ?? '')
  if (collision && PROVIDED.includes(collision[1])) {
    return `${message} — \`${collision[1]}\` is already provided to every function by the runtime, so it cannot be declared again. Rename yours.`
  }
  return message
}

/* --- running --------------------------------------------------------------- */

const blank = (extra) => ({
  outcome: OUTCOME.notRunnable,
  handler: null,
  payload: null,
  emitted: [],
  logs: [],
  changed: [],
  error: null,
  notes: [],
  ms: 0,
  hits: [],
  tracked: [],
  untracked: [],
  ...extra,
})

/**
 * Run the handler for `event` and report what happened.
 *
 * Never throws: every failure is a value, because both callers render the result and
 * one of them is a pure reducer that must not be able to take the canvas down.
 *
 * @param code       the function body, as the user typed it
 * @param kind       which of the four function kinds this component is
 * @param event      the payload to run against. Cloned, so a handler that mutates its
 *                   argument -- which the shipped destination-insert default does --
 *                   cannot reach back into the trace's own payload.
 * @param settings   the function's settings object, or nothing
 * @param deadlineMs how long it may run for. See ROUTER_DEADLINE_MS / TEST_DEADLINE_MS.
 * @param maxLogs    how much console output to keep. The router keeps a little (it
 *                   reports only a count); the tester keeps it all, since showing it
 *                   is the point.
 * @param probes     1-based lines whose execution to record, for the checklist. Comes from
 *                   the `@step` markers in the source -- see ./steps.js. The result reports
 *                   `hits` (lines reached), `tracked` (lines a probe was placed on) and
 *                   `untracked` (lines that could not take one), because "did not run" and
 *                   "could not be measured" are different answers and only one is a cross.
 */
export function runFunction({
  code,
  kind,
  event,
  settings = {},
  deadlineMs = ROUTER_DEADLINE_MS,
  maxLogs = MAX_LOGS,
  probes = [],
} = {}) {
  if (!code || !String(code).trim()) {
    return blank({ error: { name: 'NoCode', message: 'This component carries no code.' } })
  }

  const { prepared, factory, error: compileError } = factoryFor(String(code), kind, probes)
  const notes = prepared?.notes ?? []
  const coverage = { tracked: prepared?.tracked ?? [], untracked: prepared?.untracked ?? [] }

  if (!factory) {
    return blank({
      notes,
      ...coverage,
      untracked: [...new Set(probes ?? [])],
      tracked: [],
      error: { name: 'CompileError', message: compileError ?? 'The code could not be compiled.' },
    })
  }

  const logs = []
  const stream = emitter()
  const hits = new Set()
  const started = Date.now()

  const globals = [
    ticker(deadlineMs),
    /* The coverage probe. A Set, so a line inside a loop counts once however many times it
       runs -- the checklist asks "did this happen", not "how often". */
    (line) => hits.add(line),
    consoleSink(logs, maxLogs),
    stream.api,
    cacheStub(),
    unavailable(
      'crypto',
      "the browser's SubtleCrypto is asynchronous and this runner is not. Comment the hashing out to test the rest.",
    ),
    unavailable('fetch', 'the local runner makes no network calls. What a real function fetches is not simulated.'),
    unavailable('https', 'the local runner makes no network calls.'),
    unavailable('AWS', 'the AWS SDK is not bundled into this tool.'),
    unavailable('moment', 'moment is not bundled into this tool. Use Date instead to test locally.'),
    unavailable('_', 'lodash is not bundled into this tool.'),
    DropEvent,
    RetryError,
    ValidationError,
    InvalidEventPayload,
    EventNotSupported,
    ...SHADOWED.map(() => undefined),
  ]

  let handlers
  try {
    handlers = factory(...globals)
  } catch (err) {
    /* A throw from module scope, before any handler was reached: a top-level constant
       built from something that is not there. Reported as its own thing, because
       "your code did not finish loading" is a different problem from "your handler
       rejected this event". */
    return blank({
      notes,
      ...coverage,
      hits: [...hits].sort((a, b) => a - b),
      ms: Date.now() - started,
      logs,
      outcome: classify(err).outcome,
      error: describe(err),
    })
  }

  /*
   * The factory returned something other than the handler table it was told to.
   *
   * `new Function` compiles a function *body*, so a top-level `return` in the user's code
   * is legal and pre-empts the `return {…}` appended after it -- which left `handlers`
   * undefined and the dereference below throwing out of a function that documents never
   * throwing, from inside a reducer running during render. Reported as not runnable, which
   * is what it is.
   */
  if (!handlers || typeof handlers !== 'object') {
    return blank({
      notes,
      ...coverage,
      logs,
      ms: Date.now() - started,
      error: {
        name: 'CompileError',
        message:
          'The code returned from its top level before any handler could be collected. A function body should declare handlers rather than return — a bare `return` outside a handler stops the whole file.',
      },
    })
  }

  const carry = { logs, notes, started, hits, coverage }
  return kind === 'source_function'
    ? runRequest({ handlers, stream, event, settings, ...carry })
    : runHandler({ handlers, kind, event, settings, ...carry })
}

/** The six event-shaped kinds: one handler per event type, and it returns the event. */
function runHandler({ handlers, kind, event, settings, logs, notes, started, hits, coverage }) {
  const type = event?.type
  const name = HANDLER_FOR_TYPE[type]
  /* `hits` is read at the moment `done` is called, not captured earlier: the probes fire
     during the handler, so snapshotting the Set before that would report an empty run. */
  const done = (extra) => ({
    handler: name ?? null,
    emitted: [],
    logs,
    notes,
    changed: [],
    payload: null,
    error: null,
    ms: Date.now() - started,
    hits: [...hits].sort((a, b) => a - b),
    ...coverage,
    ...extra,
  })

  if (!name) {
    return done({
      outcome: OUTCOME.noHandler,
      error: {
        name: 'NoHandler',
        message: `This runner dispatches on \`event.type\`, and “${type ?? 'nothing'}” is not one of ${Object.keys(HANDLER_FOR_TYPE).join(', ')}.`,
      },
    })
  }

  if (typeof handlers[name] !== 'function') {
    return done({
      outcome: OUTCOME.noHandler,
      error: {
        name: 'NoHandler',
        message: `No \`${name}\` is declared, so there is nothing for a ${type} event to call.`,
      },
    })
  }

  /*
   * The call *and* everything that reads its result are inside one try.
   *
   * Inspecting the return value outside it looked harmless and was not: the handler can
   * hand back one of the `unavailable()` proxies -- `return fetch`, or `return _` after a
   * typo -- whose `get` trap fires on the very first `.then` read. That threw straight out
   * of `runFunction`, which promises never to throw and is called from a memoised reducer
   * during render, so it took the canvas down instead of reporting `unavailable`.
   * `changedPaths` walks the value too, and had the same exposure.
   */
  try {
    const input = clone(event)
    const returned = handlers[name](clone(event), clone(settings ?? {}))

    if (returned && typeof returned.then === 'function') {
      /* ./prepare.js removes `async` from declarations, so a promise here was built
         explicitly. There is no way to wait for it inside a synchronous reducer, and
         pretending the event passed through unchanged would be a claim about code this
         runner did not finish. */
      return done({
        outcome: OUTCOME.unavailable,
        error: {
          name: 'NotAvailableLocally',
          message: `\`${name}\` returned a promise. The local runner is synchronous, so it cannot wait for one.`,
        },
      })
    }

    if (returned === undefined || returned === null) {
      return done({
        outcome: OUTCOME.empty,
        error: {
          name: 'ReturnedNothing',
          message: `\`${name}\` returned nothing. Whatever an insert function returns is what the destination receives, so nothing is delivered.`,
        },
      })
    }

    return done({
      outcome: OUTCOME.returned,
      payload: returned,
      changed: changedPaths(input, returned),
    })
  } catch (err) {
    return done({ outcome: classify(err).outcome, error: describe(err) })
  }
}

/** A source function: one `onRequest`, and events come out of `Segment.*` rather than a return. */
function runRequest({ handlers, stream, event, settings, logs, notes, started, hits, coverage }) {
  const done = (extra) => ({
    handler: REQUEST_HANDLER,
    emitted: [],
    logs,
    notes,
    changed: [],
    payload: null,
    error: null,
    ms: Date.now() - started,
    hits: [...hits].sort((a, b) => a - b),
    ...coverage,
    ...extra,
  })

  if (typeof handlers[REQUEST_HANDLER] !== 'function') {
    return done({
      outcome: OUTCOME.noHandler,
      error: {
        name: 'NoHandler',
        message: 'No `onRequest` is declared. A source function has exactly one handler, and this is it.',
      },
    })
  }

  try {
    handlers[REQUEST_HANDLER](requestFor(event), clone(settings ?? {}))
  } catch (err) {
    return done({ outcome: classify(err).outcome, error: describe(err), emitted: stream.events })
  }

  if (stream.events.length === 0) {
    return done({
      outcome: OUTCOME.empty,
      error: {
        name: 'EmittedNothing',
        message:
          'The handler returned without calling Segment.track, Segment.identify or any other emitter, so no event was produced.',
      },
    })
  }

  /*
   * The first emitted event carries the path onward, and *only* what the code put on
   * it -- plus the timestamp, which Segment stamps itself and whose absence would
   * otherwise look like a fact about the function rather than about this runner.
   * Nothing else is filled in: a downstream filter reading `context.app.name` should
   * find it nil if the function never set it, because that is what would really
   * happen.
   */
  const first = stream.events[0]
  return done({
    outcome: OUTCOME.emitted,
    emitted: stream.events,
    payload: { ...first, timestamp: first.timestamp ?? event?.timestamp },
  })
}

/* --- reading a throw ------------------------------------------------------- */

function classify(err) {
  if (err instanceof DropEvent) return { outcome: OUTCOME.dropped }
  if (err instanceof RetryError) return { outcome: OUTCOME.retry }
  if (err instanceof ValidationError || err instanceof InvalidEventPayload) {
    return { outcome: OUTCOME.invalid }
  }
  if (err instanceof EventNotSupported) return { outcome: OUTCOME.unsupported }
  if (err instanceof NotAvailableLocally) return { outcome: OUTCOME.unavailable }
  /* `unavailable` rather than `error`, because it is a limit of this runner meeting an
     unusual payload rather than a fault in the code -- so the walkthrough falls back to
     its honest "this stage may reshape the event" instead of blaming the function. */
  if (err instanceof NotCloneable) return { outcome: OUTCOME.unavailable }
  if (err instanceof StepLimitExceeded) return { outcome: OUTCOME.error }
  return { outcome: OUTCOME.error }
}

function describe(err) {
  if (err instanceof Error) return { name: err.name || 'Error', message: err.message || String(err) }
  /* `throw 'a string'` is legal and happens. */
  return { name: 'Error', message: format(err) }
}

/* --- what changed ---------------------------------------------------------- */

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The dotted field paths where `after` differs from `before`.
 *
 * This is what makes "a real effect on the event" legible: an insert function that
 * strips one trait out of fifteen produces one line here, where a side-by-side JSON
 * dump would produce thirty and leave the reader to find it. `from: undefined` means
 * the field was added; `to: undefined` means it was removed.
 *
 * Bounded, because a handler that replaces the whole payload would otherwise produce a
 * list as long as the event.
 */
export function changedPaths(before, after, { limit = MAX_CHANGED } = {}) {
  const found = []
  compare(before, after, '', found, limit)
  return found
}

function compare(a, b, path, found, limit) {
  if (found.length >= limit) return
  if (a === b) return

  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      compare(a[key], b[key], path ? `${path}.${key}` : key, found, limit)
    }
    return
  }

  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let index = 0; index < a.length; index += 1) {
      compare(a[index], b[index], `${path}[${index}]`, found, limit)
    }
    return
  }

  found.push({ path: path || '(whole event)', from: a, to: b })
}

/** A one-line summary of a change, for the walkthrough's own narration. */
export function summarizeChanges(changed) {
  if (!changed?.length) return null
  const added = changed.filter((entry) => entry.from === undefined).map((entry) => entry.path)
  const removed = changed.filter((entry) => entry.to === undefined).map((entry) => entry.path)
  const edited = changed
    .filter((entry) => entry.from !== undefined && entry.to !== undefined)
    .map((entry) => entry.path)

  const parts = []
  if (removed.length) parts.push(`removed ${removed.join(', ')}`)
  if (edited.length) parts.push(`changed ${edited.join(', ')}`)
  if (added.length) parts.push(`added ${added.join(', ')}`)
  return parts.join('; ')
}
