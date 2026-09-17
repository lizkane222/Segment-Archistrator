import { describe, expect, it } from 'vitest'

import { defaultCode } from './defaults.js'
import { runFunction } from './runtime.js'
import {
  anchor,
  anchorable,
  anchoredLines,
  checklistState,
  markerFor,
  newStepId,
  summarizeSteps,
  unanchor,
  usedIds,
} from './steps.js'

const track = (properties = {}) => ({
  type: 'track',
  event: 'Order Completed',
  userId: 'u1',
  properties,
})

/* Semicolon-free on purpose: the first version of `probePoint` could only find a boundary
   after `;`, `{` or `}`, so a function written in this perfectly ordinary style was almost
   entirely unanchorable. */
const HANDLER = `async function onTrack(event, settings) {
  if (event.properties?.is_test === true) {
    throw new DropEvent('test traffic')
  }
  event.properties.region = 'eu'
  delete event.properties.plan
  return event
}`

describe('ids', () => {
  it('numbers from one and skips what is taken', () => {
    expect(newStepId([], '')).toBe('s1')
    expect(newStepId([{ id: 's1' }], '')).toBe('s2')
    /* Taken counts markers left in the source as well as items on the node: an item deleted
       from the list while its marker survived must not have its id handed out again. */
    expect(newStepId([], 'const a = 1 // @step s1')).toBe('s2')
    expect(newStepId([{ id: 's2' }], '// @step s1')).toBe('s3')
  })

  it('reads the ids in use out of a source', () => {
    expect(usedIds('a // @step s1\nb  // @step  s4')).toEqual(['s1', 's4'])
    expect(usedIds('')).toEqual([])
  })
})

describe('anchoring', () => {
  it('appends a marker to the line asked for', () => {
    const anchored = anchor(HANDLER, 5, 's1')
    expect(anchored.split('\n')[4]).toBe(`  event.properties.region = 'eu'  ${markerFor('s1')}`)
    expect(anchoredLines(anchored)).toEqual({ s1: 5 })
  })

  it('moves an anchor rather than leaving two', () => {
    /* Two markers with one id would leave a first-occurrence rule deciding which line the
       item was really on, which is the kind of thing nobody can debug from the UI. */
    const moved = anchor(anchor(HANDLER, 5, 's1'), 7, 's1')
    expect(usedIds(moved)).toEqual(['s1'])
    expect(anchoredLines(moved)).toEqual({ s1: 7 })
  })

  it('keeps several anchors apart', () => {
    let code = HANDLER
    for (const [line, id] of [
      [3, 's1'],
      [5, 's2'],
      [7, 's3'],
    ]) {
      code = anchor(code, line, id)
    }
    expect(anchoredLines(code)).toEqual({ s1: 3, s2: 5, s3: 7 })
  })

  it('joins a comment that is already on the line', () => {
    const code = 'const a = 1 // why'
    const anchored = anchor(code, 1, 's1')
    expect(anchored).toContain('// why')
    expect(anchoredLines(anchored)).toEqual({ s1: 1 })
  })

  it('removes a marker and the comment it was alone in', () => {
    const anchored = anchor('  return event', 1, 's1')
    expect(unanchor(anchored, 's1')).toBe('  return event')
  })

  it('removes only the marker when the comment says something too', () => {
    const anchored = anchor('const a = 1 // why', 1, 's1')
    expect(unanchor(anchored, 's1')).toBe('const a = 1 // why')
  })

  it('leaves other ids alone', () => {
    const code = anchor(anchor(HANDLER, 5, 's1'), 7, 's2')
    expect(anchoredLines(unanchor(code, 's1'))).toEqual({ s2: 7 })
  })

  /*
   * The property the whole marker-in-the-source design exists for. Storing a line number on
   * the item would make every one of these silently wrong.
   */
  describe('surviving an edit', () => {
    const anchored = anchor(anchor(HANDLER, 5, 's1'), 7, 's2')

    it('follows its line when lines are inserted above it', () => {
      const lines = anchored.split('\n')
      lines.splice(1, 0, '  console.log(1)', '  console.log(2)')
      expect(anchoredLines(lines.join('\n'))).toEqual({ s1: 7, s2: 9 })
    })

    it('follows its line when lines are removed above it', () => {
      const lines = anchored.split('\n')
      lines.splice(1, 3) // the whole if-block
      expect(anchoredLines(lines.join('\n'))).toEqual({ s1: 2, s2: 4 })
    })

    it('follows its line when the body is reordered', () => {
      const lines = anchored.split('\n')
      const [moved] = lines.splice(4, 1) // the `region` line, carrying s1
      lines.splice(5, 0, moved)
      expect(anchoredLines(lines.join('\n')).s1).toBe(6)
    })

    it('goes away when the line does', () => {
      const lines = anchored.split('\n')
      lines.splice(4, 1)
      expect(anchoredLines(lines.join('\n'))).toEqual({ s2: 6 })
    })
  })

  it('ignores a marker that is not in a comment', () => {
    /* A function building the text `@step s1` is a coincidence, not an anchor. */
    const code = `function onTrack(e) {\n  e.note = '@step s1'\n  return e\n}`
    expect(anchoredLines(code)).toEqual({})
  })
})

describe('anchorable', () => {
  const check = (source) =>
    source.split('\n').map((_, index) => anchorable(source, index + 1))

  it('accepts an ordinary statement inside a handler', () => {
    expect(check(HANDLER)).toEqual([false, true, true, false, true, true, true, false])
  })

  it('refuses what cannot carry a probe', () => {
    const tricky = `const TOP = [1]
async function onTrack(event) {
  const shape = {
    a: 1
  }
  if (event.userId)
    return event
  const url = \`a
b\`
  return event
    .valueOf()
}`
    const got = check(tricky)
    const refused = (line) => expect(got[line - 1], `line ${line}`).toBe(false)

    refused(1) // module scope: would tick for every event, whichever handler ran
    refused(2) // ditto, and it is a declaration
    refused(4) // inside an object literal, where a statement cannot go
    refused(5) // a closing brace
    refused(7) // the unbraced body of an `if`: a probe here detaches it from its condition
    refused(8) // opens a multi-line template
    refused(9) // inside that template
    refused(11) // continues a method chain
    refused(12) // the closing brace

    expect(got[2]).toBe(true) // `const shape = {`
    expect(got[5]).toBe(true) // the `if` line itself
    expect(got[9]).toBe(true) // `return event`
  })

  it('refuses a blank line and a comment-only line', () => {
    expect(anchorable('function f() {\n\n  // just a note\n  return 1\n}', 2)).toBe(false)
    expect(anchorable('function f() {\n\n  // just a note\n  return 1\n}', 3)).toBe(false)
    expect(anchorable('function f() {\n\n  // just a note\n  return 1\n}', 4)).toBe(true)
  })

  it('refuses a line that is not there', () => {
    expect(anchorable(HANDLER, 0)).toBe(false)
    expect(anchorable(HANDLER, 999)).toBe(false)
    expect(anchorable('', 1)).toBe(false)
  })
})

describe('checklistState', () => {
  const items = [
    { id: 's1', label: 'Drops test traffic' },
    { id: 's2', label: 'Stamps the region' },
    { id: 's3', label: 'Never anchored' },
  ]
  const code = anchor(anchor(HANDLER, 3, 's1'), 5, 's2')

  it('is pending before anything has been run', () => {
    expect(checklistState(items, code).map((item) => item.status)).toEqual([
      'pending',
      'pending',
      'unanchored',
    ])
  })

  it('ticks the line that ran and crosses the one that did not', () => {
    const state = checklistState(items, code, [5], [3, 5])
    expect(state.map((item) => item.status)).toEqual(['missed', 'done', 'unanchored'])
    expect(state[1].line).toBe(5)
  })

  it('keeps untracked apart from missed', () => {
    /* Collapsing these into one red cross would blame the function for a limitation of the
       runner. */
    expect(checklistState(items, code, [5], [5])[0].status).toBe('untracked')
  })

  it('drops an item with no id rather than rendering a blank row', () => {
    expect(checklistState([{ label: 'orphan' }], code)).toEqual([])
    expect(checklistState(null, code)).toEqual([])
  })

  it('summarises only what was measured', () => {
    expect(summarizeSteps(checklistState(items, code, [5], [3, 5]))).toMatchObject({
      done: 1,
      total: 2,
    })
    /* Nothing measurable, so nothing to claim. */
    expect(summarizeSteps(checklistState(items, code))).toBeNull()
    expect(summarizeSteps([])).toBeNull()
  })
})

/*
 * The end of the feature: anchors in, a run, ticks and crosses out. Written against
 * `runFunction` rather than against a mock, because the thing worth pinning is that the
 * probes ./prepare.js places and the anchors ./steps.js reads agree about line numbers.
 */
describe('anchors through a real run', () => {
  const code = [
    [3, 's1'],
    [5, 's2'],
    [6, 's3'],
    [7, 's4'],
  ].reduce((source, [line, id]) => anchor(source, line, id), HANDLER)

  const items = ['s1', 's2', 's3', 's4'].map((id) => ({ id, label: id }))
  const run = (event) =>
    runFunction({
      code,
      kind: 'destination_insert_function',
      event,
      probes: Object.values(anchoredLines(code)),
    })

  const statuses = (event) => {
    const result = run(event)
    return checklistState(items, code, result.hits, result.tracked).map((item) => item.status)
  }

  it('ticks the steps an ordinary event reaches', () => {
    expect(statuses(track({ plan: 'pro' }))).toEqual(['missed', 'done', 'done', 'done'])
  })

  it('ticks the drop and crosses everything after it', () => {
    expect(statuses(track({ is_test: true }))).toEqual(['done', 'missed', 'missed', 'missed'])
  })

  it('leaves the code the runner sees behaving identically to the code without markers', () => {
    /* The markers are comments and the probes are injected, so neither may change what comes
       out. If this ever fails, the checklist has started altering the thing it measures. */
    const withSteps = run(track({ plan: 'pro' }))
    const without = runFunction({
      code: HANDLER,
      kind: 'destination_insert_function',
      event: track({ plan: 'pro' }),
    })
    expect(withSteps.payload).toEqual(without.payload)
    expect(withSteps.outcome).toBe(without.outcome)
  })

  it('counts a line inside a loop once', () => {
    const looped = anchor(
      `async function onTrack(event) {\n  for (const k of ['a', 'b', 'c']) {\n    event.properties[k] = 1\n  }\n  return event\n}`,
      3,
      's1',
    )
    const result = runFunction({
      code: looped,
      kind: 'destination_insert_function',
      event: track(),
      probes: [3],
    })
    expect(result.hits).toEqual([3])
  })
})

describe('the shipped defaults', () => {
  const kinds = [
    'source_function',
    'source_insert_function',
    'destination_insert_function',
    'destination_function',
  ]

  it('all have lines worth anchoring, and probing every one of them still runs', () => {
    for (const kind of kinds) {
      const code = defaultCode(kind)
      const lines = code
        .split('\n')
        .map((_, index) => index + 1)
        .filter((line) => anchorable(code, line))

      expect(lines.length, kind).toBeGreaterThan(5)

      const result = runFunction({
        code,
        kind,
        event: track({ order_id: 'o1' }),
        probes: lines,
      })
      /* Every offered anchor is actually placeable -- `anchorable` and the runner must not
         disagree, or the button would hand out anchors that always read as a cross. */
      expect(result.untracked, kind).toEqual([])
      expect(result.outcome, kind).not.toBe('not_runnable')
      expect(result.hits.length, kind).toBeGreaterThan(0)
    }
  })
})
