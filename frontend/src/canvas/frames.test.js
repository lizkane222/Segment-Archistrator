/*
 * Dividers, and the same zone twice.
 *
 * Two things here are worth a test and the rest is arithmetic around them:
 *
 *   - `shiftSections` is the whole of "sections carry their contents". The rule is *per section*,
 *     and the failure it guards against is the one that looks like a bug rather than a design
 *     choice: a node near a divider being moved by the wrong section's delta and jumping across the
 *     line the user was dragging.
 *   - `zoneProductOf` has to be exactly reversible with `instanceZoneId`, because everything that
 *     knows what a zone *is* -- its colour, where its components belong, what the topology calls it
 *     -- goes through it. A product id that round-tripped wrongly would give a copy of Connections
 *     custom-zone grey and an advisory on every component in it.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SPLIT,
  FRAME_AXES,
  dividesX,
  dividesY,
  instanceLabel,
  instanceZoneId,
  nextZoneInstance,
  normalizeFrame,
  sectionAt,
  sectionsOf,
  shiftSections,
  splitFromPointer,
  zoneInstanceOf,
  zoneProductOf,
} from './frames.js'

const box = { width: 1000, height: 600 }

describe('normalizeFrame', () => {
  it('fills in the defaults', () => {
    expect(normalizeFrame(undefined)).toEqual({
      axis: 'vertical',
      splitX: DEFAULT_SPLIT,
      splitY: DEFAULT_SPLIT,
      labels: [],
    })
  })

  it('keeps a split away from the edges', () => {
    /* A section with nothing in it is fine; a section too narrow to put anything in reads as a
       frame that has been broken. */
    expect(normalizeFrame({ splitX: 0 }).splitX).toBeGreaterThan(0)
    expect(normalizeFrame({ splitX: 1 }).splitX).toBeLessThan(1)
    expect(normalizeFrame({ splitX: -3 }).splitX).toBeGreaterThan(0)
  })

  it('rounds, so a drag does not produce a new document on every frame', () => {
    expect(normalizeFrame({ splitX: 0.3333333 }).splitX).toBe(0.333)
  })

  it('falls back for an axis it does not know', () => {
    expect(normalizeFrame({ axis: 'diagonal' }).axis).toBe('vertical')
    for (const axis of FRAME_AXES) expect(normalizeFrame({ axis }).axis).toBe(axis)
  })
})

describe('sectionsOf', () => {
  it('divides a vertical frame into two columns', () => {
    const sections = sectionsOf({ axis: 'vertical', splitX: 0.5 }, box)
    expect(sections).toEqual([
      { x: 0, y: 0, width: 500, height: 600 },
      { x: 500, y: 0, width: 500, height: 600 },
    ])
  })

  it('divides a horizontal frame into two rows', () => {
    const sections = sectionsOf({ axis: 'horizontal', splitY: 0.5 }, box)
    expect(sections).toEqual([
      { x: 0, y: 0, width: 1000, height: 300 },
      { x: 0, y: 300, width: 1000, height: 300 },
    ])
  })

  it('divides a cross into four, in reading order', () => {
    const sections = sectionsOf({ axis: 'cross', splitX: 0.5, splitY: 0.5 }, box)
    expect(sections).toHaveLength(4)
    expect(sections.map((section) => [section.x, section.y])).toEqual([
      [0, 0],
      [500, 0],
      [0, 300],
      [500, 300],
    ])
  })

  it('honours an off-centre split', () => {
    const [left, right] = sectionsOf({ axis: 'vertical', splitX: 0.25 }, box)
    expect(left.width).toBe(250)
    expect(right.width).toBe(750)
    /* The two together are always the whole frame -- a rounding error here leaves a one-pixel gap
       or overlap down the middle of every diagram. */
    expect(left.width + right.width).toBe(box.width)
  })

  it('knows which axes each shape divides on', () => {
    expect([dividesX('vertical'), dividesY('vertical')]).toEqual([true, false])
    expect([dividesX('horizontal'), dividesY('horizontal')]).toEqual([false, true])
    expect([dividesX('cross'), dividesY('cross')]).toEqual([true, true])
  })
})

describe('sectionAt', () => {
  const frame = { axis: 'cross', splitX: 0.5, splitY: 0.5 }

  it('finds the section a point is in', () => {
    expect(sectionAt(frame, box, { x: 100, y: 100 })).toBe(0)
    expect(sectionAt(frame, box, { x: 900, y: 100 })).toBe(1)
    expect(sectionAt(frame, box, { x: 100, y: 500 })).toBe(2)
    expect(sectionAt(frame, box, { x: 900, y: 500 })).toBe(3)
  })

  /* A node dropped precisely on the line has to land in one section rather than in neither. */
  it('puts a point on a divider in the section after it', () => {
    expect(sectionAt(frame, box, { x: 500, y: 100 })).toBe(1)
    expect(sectionAt(frame, box, { x: 100, y: 300 })).toBe(2)
  })

  it('puts a point on the far border in the last section, not nowhere', () => {
    expect(sectionAt(frame, box, { x: 1000, y: 600 })).toBe(3)
  })

  it('says nowhere for a point outside the frame', () => {
    expect(sectionAt(frame, box, { x: -10, y: 100 })).toBe(-1)
    expect(sectionAt(frame, box, { x: 100, y: 900 })).toBe(-1)
  })
})

describe('shiftSections', () => {
  const child = (id, x, y, parentId = 'frame-1') => ({ id, parentId, position: { x, y } })
  const at = (nodes, id) => nodes.find((node) => node.id === id).position

  const before = { frame: { axis: 'vertical', splitX: 0.5 }, width: 1000, height: 600 }

  it('moves the section whose origin moved, and only that one', () => {
    /* The divider dragged 40px right. The right-hand section now starts 40px further along, so its
       contents come with it; the left-hand section starts where it always did. */
    const after = { frame: { axis: 'vertical', splitX: 0.54 }, width: 1000, height: 600 }
    const nodes = [child('left', 100, 100), child('right', 600, 100)]
    const out = shiftSections(nodes, 'frame-1', before, after)

    expect(at(out, 'left')).toEqual({ x: 100, y: 100 })
    expect(at(out, 'right')).toEqual({ x: 640, y: 100 })
  })

  it('moves a section by where it now starts when the frame is resized', () => {
    /* The right edge dragged 100px out, split still at half: the right section starts 50px further
       along, so its contents move 50 -- not 100, and not zero. */
    const after = { frame: { axis: 'vertical', splitX: 0.5 }, width: 1100, height: 600 }
    const nodes = [child('left', 100, 100), child('right', 600, 100)]
    const out = shiftSections(nodes, 'frame-1', before, after)

    expect(at(out, 'left')).toEqual({ x: 100, y: 100 })
    expect(at(out, 'right')).toEqual({ x: 650, y: 100 })
  })

  it('moves all four sections of a cross independently', () => {
    const crossBefore = { frame: { axis: 'cross', splitX: 0.5, splitY: 0.5 }, width: 1000, height: 600 }
    const crossAfter = { frame: { axis: 'cross', splitX: 0.6, splitY: 0.5 }, width: 1000, height: 600 }
    const nodes = [child('topLeft', 10, 10), child('topRight', 600, 10), child('bottomRight', 600, 400)]
    const out = shiftSections(nodes, 'frame-1', crossBefore, crossAfter)

    expect(at(out, 'topLeft')).toEqual({ x: 10, y: 10 })
    expect(at(out, 'topRight')).toEqual({ x: 700, y: 10 })
    expect(at(out, 'bottomRight')).toEqual({ x: 700, y: 400 })
  })

  it('leaves other nodes alone', () => {
    const after = { frame: { axis: 'vertical', splitX: 0.6 }, width: 1000, height: 600 }
    const nodes = [
      child('mine', 600, 100),
      child('theirs', 600, 100, 'frame-2'),
      /* Not in any frame: a component parked on bare canvas beside one. */
      child('loose', 600, 100, null),
    ]
    const out = shiftSections(nodes, 'frame-1', before, after)

    expect(at(out, 'theirs')).toEqual({ x: 600, y: 100 })
    expect(at(out, 'loose')).toEqual({ x: 600, y: 100 })
  })

  /* Identity, not equality: React Flow re-renders what it is handed, and a fresh array for a drag
     that changed nothing is a re-render of every node on the canvas per frame. */
  it('hands back the same array when nothing moved', () => {
    const nodes = [child('left', 100, 100)]
    expect(shiftSections(nodes, 'frame-1', before, before)).toBe(nodes)
  })

  it('does nothing when the frame changed shape', () => {
    /* Two sections becoming four is not a move -- there is no section-to-section mapping to shift
       along -- so the contents stay where they are and the user rearranges them. */
    const after = { frame: { axis: 'cross', splitX: 0.5, splitY: 0.5 }, width: 1000, height: 600 }
    const nodes = [child('left', 100, 100)]
    expect(shiftSections(nodes, 'frame-1', before, after)).toBe(nodes)
  })
})

describe('splitFromPointer', () => {
  it('is the offset over the size', () => {
    expect(splitFromPointer(250, 1000)).toBe(0.25)
  })

  it('clamps to the same floor a stored split has', () => {
    expect(splitFromPointer(-100, 1000)).toBe(normalizeFrame({ splitX: 0 }).splitX)
    expect(splitFromPointer(2000, 1000)).toBe(normalizeFrame({ splitX: 1 }).splitX)
  })

  it('survives a frame that has not been measured', () => {
    expect(splitFromPointer(10, 0)).toBe(DEFAULT_SPLIT)
  })
})

describe('the same zone more than once', () => {
  it('leaves the first copy’s id alone', () => {
    /* Load-bearing: every diagram already saved has `connections`, and a scheme that renamed the
       original would orphan every component in it. */
    expect(instanceZoneId('connections', 1)).toBe('connections')
  })

  it('gives later copies their own id', () => {
    expect(instanceZoneId('connections', 2)).toBe('connections~2')
    expect(instanceZoneId('connections', 3)).toBe('connections~3')
  })

  it('reads the product back out', () => {
    expect(zoneProductOf('connections~2')).toBe('connections')
    expect(zoneProductOf('connections')).toBe('connections')
    expect(zoneProductOf('profile_sources~4')).toBe('profile_sources')
  })

  /* A custom zone's id is `custom:zone:ab12` and a component's is `manual:source:ab12`. Neither
     contains a tilde, which is exactly why the tilde was chosen. */
  it('does not mistake the existing id shapes for instances', () => {
    expect(zoneProductOf('custom:zone:ab12')).toBe('custom:zone:ab12')
    expect(zoneInstanceOf('custom:zone:ab12')).toBe(1)
    expect(zoneProductOf('identity_settings')).toBe('identity_settings')
  })

  it('counts which copy it is', () => {
    expect(zoneInstanceOf('connections')).toBe(1)
    expect(zoneInstanceOf('connections~2')).toBe(2)
    /* Nonsense after the tilde is the original, not a NaN-th copy. */
    expect(zoneInstanceOf('connections~x')).toBe(1)
    expect(zoneInstanceOf('connections~0')).toBe(1)
  })

  it('finds the next free id', () => {
    expect(nextZoneInstance('connections', [])).toBe('connections')
    expect(nextZoneInstance('connections', ['connections'])).toBe('connections~2')
    expect(nextZoneInstance('connections', ['connections', 'connections~2'])).toBe('connections~3')
    /* Counted from the highest in use, not from how many there are: deleting the second of three
       and adding another must not reproduce an id that is still on the canvas. */
    expect(nextZoneInstance('connections', ['connections', 'connections~3'])).toBe('connections~4')
    /* Another product's copies are not this one's business. */
    expect(nextZoneInstance('unify', ['connections~2', 'connections~3'])).toBe('unify')
  })

  it('numbers the label of a copy', () => {
    expect(instanceLabel('Connections', 'connections')).toBe('Connections')
    expect(instanceLabel('Connections', 'connections~2')).toBe('Connections (2)')
  })
})
