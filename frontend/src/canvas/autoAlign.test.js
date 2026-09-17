import { describe, expect, it } from 'vitest'

import { absolutePositions } from './rules.js'
import { autoAlignNodes } from './autoAlign.js'

const zone = (id, x, y, { parentId, size = { width: 800, height: 400 }, locked } = {}) => ({
  id,
  type: 'zone',
  position: { x, y },
  ...(parentId ? { parentId } : {}),
  data: { id: id.replace('zone-', ''), size, ...(locked ? { locked: true } : {}) },
})

const card = (id, x, y, { parentId, size, locked } = {}) => ({
  id,
  type: 'segment',
  position: { x, y },
  ...(parentId ? { parentId } : {}),
  data: {
    kind: 'source',
    name: id,
    ...(size ? { size } : {}),
    ...(locked ? { locked: true } : {}),
  },
})

const left = (nodes, id) => absolutePositions(nodes).get(id).x
const top = (nodes, id) => absolutePositions(nodes).get(id).y

describe('autoAlignNodes', () => {
  it('does nothing to an empty or already-tidy diagram', () => {
    expect(autoAlignNodes([])).toEqual([])
    expect(autoAlignNodes(null)).toEqual(null ?? [])

    const nodes = [
      zone('zone-connections', 0, 0),
      card('a', 20, 20, { parentId: 'zone-connections', size: { width: 100, height: 60 } }),
      card('b', 20, 300, { parentId: 'zone-connections', size: { width: 100, height: 60 } }),
    ]
    expect(autoAlignNodes(nodes)).toEqual(nodes)
  })

  it('snaps two nearly-left-aligned components in the same zone to their shared edge', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 40, 20, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 48, 200, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    expect(left(out, 'a')).toBe(left(out, 'b'))
    // The median of 40 and 48 is 44 -- both move a little, neither is treated as the anchor.
    expect(left(out, 'a')).toBe(44)
  })

  it('does not cluster two components whose edges are further apart than the tolerance', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 0, 20, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      // 40px apart, over the 24px within-zone tolerance -- never counted as "meant to
      // align" in the first place, so both stay exactly where they were.
      card('b', 40, 200, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    expect(left(out, 'a')).toBe(0)
    expect(left(out, 'b')).toBe(40)
  })

  it('refuses the members of a cluster whose move would exceed the nudge cap', () => {
    /* Chain-clustered (each consecutive gap is 20, under the 24px tolerance) even though
       the cluster spans 40px end to end. The shared median is 20, so the two ends would
       each have to move 20px to reach it -- over the 16px cap -- and are left alone; only
       the middle member, already sitting on the median, needed no move at all. */
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 0, 0, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 20, 150, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('c', 40, 300, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    expect(left(out, 'a')).toBe(0)
    expect(left(out, 'b')).toBe(20)
    expect(left(out, 'c')).toBe(40)
  })

  it('evenly spaces a column of three that is already roughly, but not exactly, even', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 40, 0, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 44, 130, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('c', 40, 260, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    // Left-aligned first.
    expect(left(out, 'a')).toBe(left(out, 'b'))
    expect(left(out, 'b')).toBe(left(out, 'c'))
    // Gaps were 130 and 130 already (0->130, 130->260), so nothing further to distribute --
    // the ends (a, c) never move on this axis regardless.
    expect(top(out, 'a')).toBe(0)
    expect(top(out, 'c')).toBe(260)
  })

  it('does not cluster components from two different zones together', () => {
    const nodes = [
      zone('zone-connections', 0, 0),
      zone('zone-engage', 500, 0),
      card('a', 20, 20, { parentId: 'zone-connections', size: { width: 100, height: 60 } }),
      card('b', 22, 20, { parentId: 'zone-engage', size: { width: 100, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    // 20 vs (500+22)=522: nowhere near the within-zone tolerance, and each zone only has
    // one member, so neither node moves.
    expect(left(out, 'a')).toBe(20)
    expect(left(out, 'b')).toBe(522)
  })

  it('aligns top-level zones to each other, one level up', () => {
    const nodes = [
      zone('zone-connections', 0, 0),
      zone('zone-engage', 30, 500),
    ]
    const out = autoAlignNodes(nodes)
    expect(left(out, 'zone-connections')).toBe(left(out, 'zone-engage'))
  })

  it('never moves a locked node, and never uses one as another node’s target', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 0, 20, { parentId: 'zone-engage', size: { width: 120, height: 60 }, locked: true }),
      card('b', 10, 200, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    expect(left(out, 'a')).toBe(0)
    expect(left(out, 'b')).toBe(10)
  })

  it('never resizes a zone, even when its children move', () => {
    const nodes = [
      zone('zone-engage', 0, 0, { size: { width: 800, height: 400 } }),
      card('a', 40, 20, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 48, 200, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const out = autoAlignNodes(nodes)
    expect(out.find((node) => node.id === 'zone-engage').data.size).toEqual({
      width: 800,
      height: 400,
    })
  })

  it('leaves whole numbers behind, so a save does not diff on sub-pixels', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 41.4, 20, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 48.6, 200, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    for (const node of autoAlignNodes(nodes)) {
      expect(Number.isInteger(node.position.x)).toBe(true)
      expect(Number.isInteger(node.position.y)).toBe(true)
    }
  })

  it('is idempotent', () => {
    const nodes = [
      zone('zone-engage', 0, 0),
      card('a', 40, 0, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('b', 44, 130, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
      card('c', 40, 260, { parentId: 'zone-engage', size: { width: 120, height: 60 } }),
    ]
    const once = autoAlignNodes(nodes)
    const twice = autoAlignNodes(once)
    expect(twice.map((node) => node.position)).toEqual(once.map((node) => node.position))
  })
})
