import { describe, expect, it } from 'vitest'

import {
  DOCS_URL,
  FUNCTION_KINDS,
  HANDLER_FOR_TYPE,
  MAX_CODE_LENGTH,
  codeSeed,
  defaultCode,
  handlerNames,
  isDefaultCode,
  isFunctionKind,
} from './defaults.js'
import { EVENT_TYPES } from '../simulation/payload.js'

describe('the function kinds', () => {
  it('are exactly the four that run JavaScript', () => {
    expect(FUNCTION_KINDS).toEqual([
      'source_function',
      'source_insert_function',
      'destination_insert_function',
      'destination_function',
    ])
    expect(isFunctionKind('destination_mapping')).toBe(false)
    expect(isFunctionKind(undefined)).toBe(false)
  })

  it('each have a default, a docs link and handler names', () => {
    for (const kind of FUNCTION_KINDS) {
      expect(defaultCode(kind), kind).toBeTruthy()
      expect(DOCS_URL[kind], kind).toMatch(/^https:\/\//)
      expect(handlerNames(kind).length, kind).toBeGreaterThan(0)
    }
    expect(defaultCode('destination')).toBeNull()
  })

  it('gives a source function one handler and the rest seven', () => {
    expect(handlerNames('source_function')).toEqual(['onRequest'])
    expect(handlerNames('source_insert_function')).toHaveLength(7)
  })

  it('has a handler for every event type the simulator can build', () => {
    /* If the palette's Events tab can produce a call type, a function has to have
       somewhere to dispatch it -- otherwise testing that event reports "no handler" for a
       reason that is this tool's gap rather than the code's. */
    for (const type of EVENT_TYPES) {
      expect(HANDLER_FOR_TYPE[type], type).toBeTruthy()
    }
  })
})

describe('the defaults themselves', () => {
  it('fit well inside the cap, so there is room to edit them', () => {
    for (const kind of FUNCTION_KINDS) {
      expect(defaultCode(kind).length, kind).toBeLessThan(MAX_CODE_LENGTH / 2)
    }
  })

  it('declare every handler their kind dispatches to', () => {
    /* An omitted handler blocks that event type. A default that shipped without
       `onScreen` would silently make screen calls undeliverable through it. */
    for (const kind of FUNCTION_KINDS) {
      for (const handler of handlerNames(kind)) {
        expect(defaultCode(kind), `${kind}.${handler}`).toContain(`function ${handler}(`)
      }
    }
  })

  it('link to the docs from the top of the file', () => {
    for (const kind of FUNCTION_KINDS) {
      /* Trimmed from the template scaffolds' seventy-line headers, which are excellent in
         a checked-out repo and nine screens of scrolling in a 384px sidebar. The link is
         what is kept in their place. */
      expect(defaultCode(kind).split('\n').length, kind).toBeLessThan(140)
    }
  })

  it('recognises its own output, and nothing else', () => {
    expect(isDefaultCode('source_insert_function', defaultCode('source_insert_function'))).toBe(true)
    /* Trailing whitespace is not an edit. */
    expect(isDefaultCode('source_insert_function', `${defaultCode('source_insert_function')}\n\n`)).toBe(
      true,
    )
    expect(isDefaultCode('source_insert_function', 'async function onTrack(e) { return e }')).toBe(false)
    expect(isDefaultCode('destination', 'anything')).toBe(false)
  })
})

/*
 * The seeding rule, which is the one judgement call in this file.
 *
 * A hand-drawn function gets a body so it does something the moment it is on the canvas.
 * A function bound to a real workspace component does not, and must not: Segment's API
 * does not return a function's code, so seeding a template would have the walkthrough
 * report this tool's guess as the customer's behaviour -- on a diagram whose whole value
 * is being trustworthy about their pipeline.
 */
describe('codeSeed', () => {
  it('seeds a function drawn by hand', () => {
    expect(codeSeed('source_insert_function')).toEqual({
      code: defaultCode('source_insert_function'),
    })
  })

  it('refuses to seed a function bound to a real workspace component', () => {
    expect(codeSeed('source_insert_function', { bound: true })).toBeNull()
  })

  it('has nothing to say about a kind that does not run code', () => {
    expect(codeSeed('destination')).toBeNull()
    expect(codeSeed('warehouse', { bound: false })).toBeNull()
  })

  it('spreads into a node without adding a key when there is nothing to add', () => {
    /* How Canvas.jsx uses it: `...codeSeed(kind, {bound})` in an object literal, where
       null has to be a no-op rather than an error. */
    expect({ id: 'n', ...codeSeed('destination') }).toEqual({ id: 'n' })
    expect(Object.keys({ id: 'n', ...codeSeed('destination_function') })).toEqual(['id', 'code'])
  })
})
