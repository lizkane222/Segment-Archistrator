/*
 * The three mutable registries the canvas chrome carries.
 *
 * All three exist to keep something that changes on every pointer frame out of React state, so
 * what is worth pinning is the part that is easy to get wrong once it is outside React's
 * equality checks: emitting only on a real change (or every subscriber re-renders per frame,
 * which is the cost this was avoiding), and clearing by id (because two elements hand a gesture
 * to each other, and their events arrive in the unhelpful order).
 */

import { describe, expect, it, vi } from 'vitest'

import { dragAnchor, edgeRoutes, handleReveal } from './chrome.js'

describe('handleReveal', () => {
  it('starts with nothing revealed', () => {
    const reveal = handleReveal()
    expect(reveal.near()).toBe(null)
    expect(reveal.revealed('a')).toBe(false)
  })

  it('answers only for the node the pointer is at', () => {
    const reveal = handleReveal()
    reveal.set('a')
    expect(reveal.revealed('a')).toBe(true)
    expect(reveal.revealed('b')).toBe(false)
  })

  it('is never revealed for a node with no id', () => {
    /* A node renderer can be handed `undefined` from `useNodeId()` outside a flow, and `near`
       is null then too -- so without the guard `revealed(undefined)` would come out true and
       every such node would draw its handles. */
    const reveal = handleReveal()
    expect(reveal.revealed(undefined)).toBe(false)
    expect(reveal.revealed(null)).toBe(false)
  })

  it('tells its subscribers when the answer changes', () => {
    const reveal = handleReveal()
    const listener = vi.fn()
    reveal.subscribe(listener)

    reveal.set('a')
    expect(listener).toHaveBeenCalledTimes(1)
    reveal.set('b')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  /* The whole reason this is a store and not state: `onNodeMouseMove` fires on every pointer
     frame, and it calls `set` with the same id each time. An emit per frame would re-render the
     node sixty times a second to leave its handles exactly as they were. */
  it('says nothing when the answer has not changed', () => {
    const reveal = handleReveal()
    const listener = vi.fn()
    reveal.subscribe(listener)

    reveal.set('a')
    reveal.set('a')
    reveal.set('a')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clears only for the node that was revealed', () => {
    /* The pointer leaves one node by entering the next, and the leave arrives *after* the
       move -- so an unconditional clear would blank the reveal that had already moved on. */
    const reveal = handleReveal()
    reveal.set('b')
    reveal.clear('a')
    expect(reveal.revealed('b')).toBe(true)
    reveal.clear('b')
    expect(reveal.near()).toBe(null)
  })

  it('stops telling a subscriber that has unsubscribed', () => {
    const reveal = handleReveal()
    const listener = vi.fn()
    reveal.subscribe(listener)()
    reveal.set('a')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('dragAnchor', () => {
  it('hands back the anchor the drag left, once', () => {
    const anchor = dragAnchor()
    anchor.set('a', 'right', 0.4)
    expect(anchor.take('a')).toEqual({ nodeId: 'a', side: 'right', t: 0.4 })
    /* Read once and cleared with the read: an override belongs to the connection that produced
       it, and a second one drawn from the same node must start from its own gesture. */
    expect(anchor.take('a')).toBe(null)
  })

  it('refuses to hand one node’s anchor to another', () => {
    const anchor = dragAnchor()
    anchor.set('a', 'right', 0.4)
    expect(anchor.take('b')).toBe(null)
  })

  it('forgets a drag that ended without connecting', () => {
    const anchor = dragAnchor()
    anchor.set('a', 'top', 0.1)
    anchor.clear()
    expect(anchor.take('a')).toBe(null)
  })
})

describe('edgeRoutes', () => {
  it('keeps a route the event layer can follow', () => {
    const routes = edgeRoutes()
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    routes.publish('e1', points)
    expect(routes.get('e1')).toBe(points)
  })

  /* A one-point "route" is not a line, and an event told to travel along it would divide by a
     zero-length path. */
  it('refuses a route with nothing to travel along', () => {
    const routes = edgeRoutes()
    routes.publish('e1', [{ x: 0, y: 0 }])
    expect(routes.get('e1')).toBe(null)
    routes.publish('e2', undefined)
    expect(routes.get('e2')).toBe(null)
  })

  it('forgets a route when its edge unmounts', () => {
    const routes = edgeRoutes()
    routes.publish('e1', [{ x: 0, y: 0 }, { x: 1, y: 1 }])
    routes.forget('e1')
    expect(routes.get('e1')).toBe(null)
  })
})

/*
 * Two ends, not one.
 *
 * `dragAnchor` was a single slot, justified by "there is never more than one node with anything worth
 * writing here" -- which was only true because of a bug. A connection has two ends and the reader
 * places both, but only the node a drag *began* on ever published an anchor, so `data.targetAnchor`
 * was read, stored, reversed and tested across the app and written by nothing at all. Every arriving
 * end therefore snapped to one of four side midpoints however carefully it was dropped.
 */
describe('dragAnchor holding both ends of one connection', () => {
  it('keeps the leaving end and the arriving end apart', () => {
    const anchor = dragAnchor()
    anchor.set('from', 'right', 0.75)
    anchor.set('to', 'left', 0.33)
    expect(anchor.take('from')).toEqual({ nodeId: 'from', side: 'right', t: 0.75 })
    expect(anchor.take('to')).toEqual({ nodeId: 'to', side: 'left', t: 0.33 })
  })

  it('still reads each one only once', () => {
    const anchor = dragAnchor()
    anchor.set('from', 'right', 0.75)
    anchor.set('to', 'left', 0.33)
    anchor.take('from')
    expect(anchor.take('from')).toBe(null)
    /* Taking one end must not consume the other -- the single slot could not have held both. */
    expect(anchor.take('to')).toEqual({ nodeId: 'to', side: 'left', t: 0.33 })
  })

  it('keeps the last point a node reported, not the first', () => {
    /* The pointer slides along a border for the length of a gesture; where it ended up is the answer. */
    const anchor = dragAnchor()
    anchor.set('to', 'left', 0.1)
    anchor.set('to', 'left', 0.6)
    expect(anchor.take('to').t).toBe(0.6)
  })

  it('forgets both when a drag ends without connecting', () => {
    const anchor = dragAnchor()
    anchor.set('from', 'right', 0.5)
    anchor.set('to', 'left', 0.5)
    anchor.clear()
    expect(anchor.take('from')).toBe(null)
    expect(anchor.take('to')).toBe(null)
  })
})
