import { describe, expect, it } from 'vitest'

import { defaultCode } from './defaults.js'
import { OUTCOME, changedPaths, runFunction, summarizeChanges } from './runtime.js'

const track = (extra = {}) => ({
  type: 'track',
  event: 'Order Completed',
  userId: 'user_1234',
  properties: { order_id: 'ord_9876', revenue: 42.5 },
  ...extra,
})

const identify = (traits) => ({ type: 'identify', userId: 'user_1234', traits })

const run = (code, event, options = {}) =>
  runFunction({ code, kind: 'destination_insert_function', event, ...options })

describe('runFunction — the ordinary case', () => {
  it('returns the event a pass-through handler hands back', () => {
    const result = run('async function onTrack(event) { return event }', track())
    expect(result.outcome).toBe(OUTCOME.returned)
    expect(result.handler).toBe('onTrack')
    expect(result.payload.event).toBe('Order Completed')
    expect(result.changed).toEqual([])
  })

  it('reports a field it stripped', () => {
    const result = run(
      'async function onTrack(event) { delete event.properties.revenue; return event }',
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.returned)
    expect(result.payload.properties).toEqual({ order_id: 'ord_9876' })
    expect(result.changed).toEqual([{ path: 'properties.revenue', from: 42.5, to: undefined }])
    expect(summarizeChanges(result.changed)).toBe('removed properties.revenue')
  })

  it('reports a field it added and a field it rewrote', () => {
    const result = run(
      `async function onTrack(event) {
         event.properties.revenue = 99;
         event.properties.currency = 'GBP';
         return event;
       }`,
      track(),
    )
    expect(summarizeChanges(result.changed)).toBe(
      'changed properties.revenue; added properties.currency',
    )
  })

  it('lets a handler change the event from one type to another', () => {
    /* Asked for explicitly as a thing the code should be able to do to the path. */
    const result = run(
      `async function onTrack(event) {
         return { type: 'identify', userId: event.userId, traits: { last_order: event.properties.order_id } };
       }`,
      track(),
    )
    expect(result.payload.type).toBe('identify')
    expect(result.payload.traits.last_order).toBe('ord_9876')
  })

  it('does not let a handler mutate the event it was given', () => {
    /* The router shares one payload object across a wave of the trace. A handler that
       mutates its argument -- which the shipped destination-insert default does -- must
       not be able to reach back into it. */
    const event = track()
    run('async function onTrack(event) { event.userId = "clobbered"; return event }', event)
    expect(event.userId).toBe('user_1234')
  })
})

describe('runFunction — the ways a function says no', () => {
  const cases = [
    ['DropEvent', OUTCOME.dropped],
    ['RetryError', OUTCOME.retry],
    ['ValidationError', OUTCOME.invalid],
    ['InvalidEventPayload', OUTCOME.invalid],
    ['EventNotSupported', OUTCOME.unsupported],
  ]

  for (const [thrown, outcome] of cases) {
    it(`maps ${thrown} to ${outcome}`, () => {
      const result = run(`async function onTrack(event) { throw new ${thrown}('nope') }`, track())
      expect(result.outcome).toBe(outcome)
      expect(result.error).toEqual({ name: thrown, message: 'nope' })
    })
  }

  it('classifies on identity, not on the name of the error', () => {
    /* Matching `error.name` would mean anyone whose own error happened to *call itself*
       DropEvent got a drop verdict painted onto their diagram -- a wrong claim about
       their architecture, arrived at from a string. */
    const result = run(
      `class MyError extends Error { constructor(m) { super(m); this.name = 'DropEvent' } }
       async function onTrack(event) { throw new MyError('mine') }`,
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.error)
    expect(result.error).toEqual({ name: 'DropEvent', message: 'mine' })
  })

  it('explains a name collision with an injected global', () => {
    /* The injected globals are parameters of the compiled function, so redeclaring one
       is a SyntaxError with a message that says nothing about why. Rare, but baffling
       when it happens. */
    const result = run('const cache = new Map();\nasync function onTrack(e) { return e }', track())
    expect(result.outcome).toBe(OUTCOME.notRunnable)
    expect(result.error.message).toContain('cache')
    expect(result.error.message).toMatch(/already provided|already declared/i)
  })

  it('treats returning nothing as delivering nothing', () => {
    const result = run('async function onTrack(event) { /* forgot to return */ }', track())
    expect(result.outcome).toBe(OUTCOME.empty)
    expect(result.error.name).toBe('ReturnedNothing')
  })

  it('treats an absent handler as blocking that event type', () => {
    /* A real Segment behaviour: an insert function with no onIdentify blocks identify
       calls outright, because there is nothing for them to call. */
    const result = run('async function onTrack(event) { return event }', identify({ plan: 'pro' }))
    expect(result.outcome).toBe(OUTCOME.noHandler)
    expect(result.error.message).toContain('onIdentify')
  })
})

describe('runFunction — the honest gaps', () => {
  it('reports fetch as unavailable rather than guessing', () => {
    const result = run(
      'async function onTrack(event) { await fetch("https://x.test"); return event }',
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.unavailable)
    expect(result.error.message).toContain('fetch')
    expect(result.error.message).toContain('local runner')
  })

  it('reports lodash and moment as unavailable through a property access', () => {
    expect(run('async function onTrack(e) { return _.omit(e, "userId") }', track()).outcome).toBe(
      OUTCOME.unavailable,
    )
    expect(run('async function onTrack(e) { e.ts = moment().format(); return e }', track()).outcome).toBe(
      OUTCOME.unavailable,
    )
  })

  it('reports a compile error without running anything', () => {
    const result = run('async function onTrack(event) { return event', track())
    expect(result.outcome).toBe(OUTCOME.notRunnable)
    expect(result.error.name).toBe('CompileError')
  })

  it('refuses a loop it cannot guard, and says which line', () => {
    const result = run(
      'async function onTrack(event) {\n  for (const k of []) noop(k)\n  return event\n}',
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.notRunnable)
    expect(result.error.message).toContain('line 2')
  })

  it('stops a runaway loop instead of freezing', () => {
    const result = run(
      'async function onTrack(event) {\n  while (true) { event.n = 1 }\n  return event\n}',
      track(),
      { deadlineMs: 50 },
    )
    expect(result.outcome).toBe(OUTCOME.error)
    expect(result.error.message).toMatch(/Stopped after/)
  })

  it('reports a promise it cannot wait for', () => {
    const result = run('function onTrack(event) { return Promise.resolve(event) }', track())
    expect(result.outcome).toBe(OUTCOME.unavailable)
    expect(result.error.message).toContain('synchronous')
  })

  it('never throws, whatever it is handed', () => {
    for (const code of ['', null, '}{', 'throw 1', 'function onTrack() { throw "a string" }']) {
      expect(() => run(code, track())).not.toThrow()
    }
  })
})

/*
 * `runFunction` documents that it never throws, and that is not a nicety: `visitFunction`
 * in ../simulation/router.js calls it from a memoised derivation that runs during render,
 * so anything escaping here takes the canvas -- and the unsaved diagram on it -- down.
 * Each of these was a way out that the ordinary cases did not cover.
 */
describe('runFunction — the ways a throw could escape', () => {
  it('reports a top-level return instead of dereferencing nothing', () => {
    /* `new Function` compiles a function *body*, so a bare `return` is legal and
       pre-empts the handler table appended after the user's code. That left the table
       undefined and the next line reading a property of it. */
    /* `globalThis` is one of the shadowed names, so this guard is satisfied and the
       `return` fires -- which is also how somebody's environment check ends up doing it. */
    const result = run('if (!globalThis) return;\nasync function onTrack(e) { return e }', track())
    expect(result.outcome).toBe(OUTCOME.notRunnable)
    expect(result.error.message).toMatch(/returned from its top level/)
  })

  it('reports a top-level return in a source function too', () => {
    const result = runFunction({
      code: 'return;\nasync function onRequest(request) { Segment.track({ userId: "u" }) }',
      kind: 'source_function',
      event: track(),
    })
    expect(result.outcome).toBe(OUTCOME.notRunnable)
  })

  it('survives a handler that returns one of the unavailable stand-ins', () => {
    /*
     * The proxies throw on *any* property read, and the first thing done with a return
     * value is `returned.then`. Reading it outside the try/catch meant `return fetch`
     * threw straight out of the runner rather than reporting `unavailable`. A plausible
     * typo, not a contrived one.
     */
    for (const global of ['fetch', '_', 'moment', 'AWS', 'https', 'crypto']) {
      const result = run(`async function onTrack(e) { return ${global} }`, track())
      expect(result.outcome, global).toBe(OUTCOME.unavailable)
      expect(result.error.message, global).toContain(global)
    }
  })

  it('survives a returned value that throws when it is walked', () => {
    /* `changedPaths` reads every key of the result, so a getter that throws was a second
       way out past the catch. */
    const result = run(
      'async function onTrack(e) { return { type: "track", get boom() { throw new Error("nope") } } }',
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.error)
    expect(result.error.message).toBe('nope')
  })

  it('refuses an event it cannot copy rather than running against the original', () => {
    /*
     * Copying is what keeps the handler out of the router's own payload and gives
     * `changedPaths` a trustworthy *before*. When it failed, this used to hand back the
     * original object -- so the handler mutated the trace's payload, and because the diff
     * short-circuits on identity the walkthrough then said "returned the event unchanged"
     * about a run that had rewritten userId. Refusing is the only honest answer.
     */
    const hostile = {
      type: 'track',
      userId: 'user_1234',
      get boom() {
        throw new Error('cannot be read')
      },
    }
    const result = run('async function onTrack(e) { e.userId = "clobbered"; return e }', hostile)
    expect(result.outcome).toBe(OUTCOME.unavailable)
    expect(result.error.name).toBe('NotCloneable')
    expect(hostile.userId).toBe('user_1234')
  })

  it('does not let a handler edit the settings object it was given', () => {
    /*
     * The router passes the node's live `data.functionSettings`. Passing it uncloned let a
     * handler write into graph state from inside a pure reducer -- and the next run then
     * saw different settings, so `simulate`'s memoisation no longer had the determinism it
     * assumes.
     */
    const settings = { region: 'eu' }
    const code = 'async function onTrack(e, settings) { settings.region = "clobbered"; return e }'
    const first = run(code, track(), { settings })
    expect(settings).toEqual({ region: 'eu' })

    const second = run(code, track(), { settings })
    expect(second.payload).toEqual(first.payload)
  })

  it('does not let a source function edit its settings either', () => {
    const settings = { region: 'eu' }
    runFunction({
      code: 'async function onRequest(request, settings) { settings.region = "clobbered"; Segment.track({ userId: "u" }) }',
      kind: 'source_function',
      event: track(),
      settings,
    })
    expect(settings).toEqual({ region: 'eu' })
  })
})

describe('runFunction — console and settings', () => {
  it('captures console output in order, with levels', () => {
    const result = run(
      `async function onTrack(event) {
         console.log('saw', event.event);
         console.warn('no currency');
         console.error('bad');
         return event;
       }`,
      track(),
    )
    expect(result.logs).toEqual([
      { level: 'log', text: 'saw Order Completed' },
      { level: 'warn', text: 'no currency' },
      { level: 'error', text: 'bad' },
    ])
  })

  it('keeps only as many log lines as it was asked for', () => {
    const result = run(
      'async function onTrack(e) { for (let i = 0; i < 50; i++) { console.log(i) } return e }',
      track(),
      { maxLogs: 3 },
    )
    expect(result.logs).toHaveLength(3)
  })

  it('passes settings to the handler', () => {
    const result = run(
      `async function onTrack(event, settings) {
         if (!settings.region) throw new ValidationError('region is required');
         event.properties.region = settings.region;
         return event;
       }`,
      track(),
      { settings: { region: 'eu' } },
    )
    expect(result.payload.properties.region).toBe('eu')
  })

  it('does not hand settings to module scope', () => {
    /* Every Segment template warns against hoisting settings -- instances are reused
       between invocations, so a module-scoped copy leaks from one event to the next --
       and Segment cannot inject one there in the first place. Code that reaches for it
       should find nothing, so the mistake shows up here rather than in production. */
    const result = run(
      'const hoisted = typeof settings;\nasync function onTrack(e) { e.properties.saw = hoisted; return e }',
      track(),
      { settings: { region: 'eu' } },
    )
    expect(result.payload.properties.saw).toBe('undefined')
  })
})

describe('runFunction — source functions', () => {
  const source = (code, event) => runFunction({ code, kind: 'source_function', event })

  it('collects what the handler emitted', () => {
    const result = source(
      `async function onRequest(request, settings) {
         const body = await request.json();
         Segment.identify({ userId: body.userId, traits: { seen: true } });
         Segment.track({ userId: body.userId, event: body.event, properties: body.properties });
       }`,
      track(),
    )
    expect(result.outcome).toBe(OUTCOME.emitted)
    expect(result.emitted.map((entry) => entry.type)).toEqual(['identify', 'track'])
    expect(result.payload.type).toBe('identify')
  })

  it('gives the handler a real Headers and URL, not a plain object', () => {
    /* The templates warn specifically about `headers['x']` versus `headers.get('x')`,
       and a plain object would quietly make the wrong one work. */
    const result = source(
      `async function onRequest(request) {
         Segment.track({
           userId: 'u',
           event: 'Probe',
           properties: {
             type: request.headers.get('content-type'),
             bracket: request.headers['content-type'] === undefined,
             host: request.url.searchParams.get('missing') === null
           }
         });
       }`,
      track(),
    )
    expect(result.emitted[0].properties).toEqual({
      type: 'application/json',
      bracket: true,
      host: true,
    })
  })

  it('treats emitting nothing as producing no event', () => {
    const result = source('async function onRequest(request) { /* silence */ }', track())
    expect(result.outcome).toBe(OUTCOME.empty)
  })

  it('reports a missing onRequest', () => {
    const result = source('async function onTrack(e) { return e }', track())
    expect(result.outcome).toBe(OUTCOME.noHandler)
    expect(result.error.message).toContain('onRequest')
  })
})

describe('the shipped defaults', () => {
  const kinds = [
    'source_function',
    'source_insert_function',
    'destination_insert_function',
    'destination_function',
  ]

  it('all compile and run', () => {
    for (const kind of kinds) {
      const result = runFunction({ code: defaultCode(kind), kind, event: track() })
      expect(result.outcome, kind).not.toBe(OUTCOME.notRunnable)
      expect(result.error?.name, kind).not.toBe('CompileError')
    }
  })

  it('all pass the event through unchanged', () => {
    /* Asked for directly: an out-of-the-box function returns the event until someone
       edits it not to. A default that quietly reshaped the payload would make the
       walkthrough report a transformation nobody asked for. */
    for (const kind of kinds) {
      const result = runFunction({ code: defaultCode(kind), kind, event: track() })
      expect(result.payload?.event, kind).toBe('Order Completed')
      expect(result.payload?.userId, kind).toBe('user_1234')
      if (kind !== 'source_function') expect(result.changed, kind).toEqual([])
    }
  })

  it('passes an identify through every kind that takes one', () => {
    for (const kind of kinds.filter((entry) => entry !== 'source_function')) {
      const result = runFunction({
        code: defaultCode(kind),
        kind,
        event: identify({ email: 'avery@example.com', plan: 'pro' }),
      })
      expect(result.outcome, kind).toBe(OUTCOME.returned)
      expect(result.payload.traits.email, kind).toBe('avery@example.com')
    }
  })

  it('drops a test event at the destination insert function, as its own comment says', () => {
    const result = runFunction({
      code: defaultCode('destination_insert_function'),
      kind: 'destination_insert_function',
      event: track({ properties: { is_test: true } }),
    })
    expect(result.outcome).toBe(OUTCOME.dropped)
  })

  it('redacts the traits it lists', () => {
    const result = runFunction({
      code: defaultCode('destination_insert_function'),
      kind: 'destination_insert_function',
      event: identify({ email: 'avery@example.com', ssn: '000-00-0000' }),
    })
    expect(result.payload.traits).toEqual({ email: 'avery@example.com' })
    expect(summarizeChanges(result.changed)).toBe('removed traits.ssn')
  })

  it('refuses a source function payload with no identity', () => {
    const result = runFunction({
      code: defaultCode('source_function'),
      kind: 'source_function',
      event: { type: 'track', event: 'Anonymous' },
    })
    expect(result.outcome).toBe(OUTCOME.invalid)
    expect(result.error.message).toContain('anonymousId')
  })
})

describe('changedPaths', () => {
  it('walks nested objects and names the leaf', () => {
    expect(changedPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([
      { path: 'a.b', from: 1, to: 2 },
    ])
  })

  it('indexes arrays of the same length, and reports a resize whole', () => {
    expect(changedPaths({ a: [1, 2] }, { a: [1, 3] })).toEqual([
      { path: 'a[1]', from: 2, to: 3 },
    ])
    expect(changedPaths({ a: [1] }, { a: [1, 2] })).toEqual([
      { path: 'a', from: [1], to: [1, 2] },
    ])
  })

  it('says nothing about an identical event', () => {
    const event = track()
    expect(changedPaths(event, structuredClone(event))).toEqual([])
  })

  it('is bounded', () => {
    const before = {}
    const after = {}
    for (let index = 0; index < 200; index += 1) after[`k${index}`] = index
    expect(changedPaths(before, after, { limit: 5 })).toHaveLength(5)
  })

  it('names a wholesale replacement rather than every field of it', () => {
    expect(changedPaths({ type: 'track' }, 'not an object')).toEqual([
      { path: '(whole event)', from: { type: 'track' }, to: 'not an object' },
    ])
  })
})
