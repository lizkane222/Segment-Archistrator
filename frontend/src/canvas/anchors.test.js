/*
 * The focus store, which is the only part of the anchor machinery that can be tested here
 * -- there is no jsdom in this project, so the note and the card that read it cannot be
 * rendered. That is fine, because the failures worth pinning are all in the store: which
 * of the two slots wins, what survives a mouseleave, and when a listener is *not* called.
 *
 * That last one is not a performance nicety. Every node on the canvas subscribes, so a
 * store that emitted on a no-op change would put a whole-canvas render on every mouse
 * move across a 300-node architecture -- the thing the whole external-store arrangement
 * exists to avoid, and invisible in a screenshot.
 */

import { describe, expect, it } from 'vitest'

import { createAnchorFocus } from './anchors.js'

const counted = () => {
  const focus = createAnchorFocus()
  let calls = 0
  focus.subscribe(() => {
    calls += 1
  })
  return { focus, calls: () => calls }
}

describe('hover', () => {
  it('lights the hovered note and nothing else', () => {
    const focus = createAnchorFocus()
    focus.set('source:a')
    expect(focus.focused('source:a')).toBe(true)
    expect(focus.focused('source:b')).toBe(false)
  })

  it('only clears the id it was given', () => {
    /* The pointer can move from a component straight onto its own note: the mouseleave on
       the component arrives *after* the mouseenter on the note, so an unconditional clear
       would blank the hover that had already moved on. */
    const focus = createAnchorFocus()
    focus.set('source:a')
    focus.set('note-target')
    focus.clear('source:a')
    expect(focus.focused('note-target')).toBe(true)
  })

  it('says nothing is focused rather than that everything is', () => {
    /* `focused(node.id)` runs for every node, and a node whose id is missing must not
       light up just because nothing is hovered. */
    const focus = createAnchorFocus()
    expect(focus.focused(null)).toBe(false)
    expect(focus.focused(undefined)).toBe(false)
  })
})

describe('pinning', () => {
  it('outlives the pointer, which is the whole point of a click', () => {
    const focus = createAnchorFocus()
    focus.set('source:a')
    focus.pin('source:a')
    focus.clear('source:a')
    expect(focus.focused('source:a')).toBe(true)
  })

  it('toggles off when the same note is clicked again', () => {
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.pin('source:a')
    expect(focus.pinned()).toBe(null)
    expect(focus.focused('source:a')).toBe(false)
  })

  it('moves rather than accumulating when a second note is clicked', () => {
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.pin('source:b')
    expect(focus.focused('source:a')).toBe(false)
    expect(focus.focused('source:b')).toBe(true)
  })

  it('stays lit while the pointer visits a neighbour', () => {
    /* Both, on purpose: a pinned note that dimmed the moment you looked at the next one
       would have lost the only thing pinning bought. */
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.set('source:b')
    expect(focus.focused('source:a')).toBe(true)
    expect(focus.focused('source:b')).toBe(true)
  })

  it('is released by clearPin, which is what a click on bare canvas does', () => {
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.clearPin()
    expect(focus.focused('source:a')).toBe(false)
  })
})

describe('the leader line', () => {
  it('follows the pointer over the pin', () => {
    /* One line, not two: a second dashed line across the diagram reads as an edge, which
       is the one thing the leader must never be mistaken for. */
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.set('source:b')
    expect(focus.leader()).toBe('source:b')
  })

  it('falls back to the pin once the pointer leaves', () => {
    const focus = createAnchorFocus()
    focus.pin('source:a')
    focus.set('source:b')
    focus.clear('source:b')
    expect(focus.leader()).toBe('source:a')
  })
})

describe('notification', () => {
  it('tells subscribers when the hover moves', () => {
    const { focus, calls } = counted()
    focus.set('source:a')
    expect(calls()).toBe(1)
  })

  it('tells subscribers when a pin lands or is released', () => {
    const { focus, calls } = counted()
    focus.pin('source:a')
    focus.pin('source:a')
    expect(calls()).toBe(2)
  })

  it('stays silent when nothing changed', () => {
    /* Every node subscribes. An emit per redundant mouse-enter is a whole-canvas render
       per mouse move, which is what the external store was built to prevent. */
    const { focus, calls } = counted()
    focus.set('source:a')
    focus.set('source:a')
    focus.clear('source:b')
    focus.clearPin()
    expect(calls()).toBe(1)
  })
})
