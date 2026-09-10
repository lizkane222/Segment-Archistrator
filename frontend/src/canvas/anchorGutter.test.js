/*
 * The gutter is geometry, so this is where the feature is actually pinned down: there is
 * no jsdom in this project and the renderer around it cannot be tested at all.
 *
 * Two invariants matter more than the exact numbers. A note is *outside* the drawing --
 * the whole reason it moved -- and two notes in one column never overlap. Both are things
 * a plausible-looking implementation gets wrong on the arrangements nobody demos: a
 * component nested two zones deep, and a column of components closer together than a note
 * is tall.
 */

import { describe, expect, it } from 'vitest'

import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import {
  GUTTER_OFFSET,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_WIDTH,
  annotatedBounds,
  layoutAnchorNotes,
} from './anchorGutter.js'

const node = (id, x, y, extra = {}) => ({
  id,
  type: 'segmentNode',
  position: { x, y },
  ...extra,
})

const zone = (id, x, y, width, height, extra = {}) => ({
  id,
  type: 'zone',
  position: { x, y },
  width,
  height,
  ...extra,
})

/* One wide zone with a component near each end: the minimum arrangement that exercises
   both columns and gives the midline something to split. */
const SPREAD = [
  zone('zone-segment', 0, 0, 1200, 400),
  node('left', 40, 100, { parentId: 'zone-segment' }),
  node('right', 900, 100, { parentId: 'zone-segment' }),
]

const noteFor = (notes, id) => notes.find((note) => note.id === id)

describe('layoutAnchorNotes', () => {
  it('has nothing to place on an empty canvas', () => {
    expect(layoutAnchorNotes([])).toEqual([])
    expect(layoutAnchorNotes(null)).toEqual([])
  })

  it('has nothing to place for zones alone', () => {
    /* A zone is annotated by the notes of what is inside it. An empty Connections with a
       note of its own would put a card in the gutter pointing at a backdrop. */
    expect(layoutAnchorNotes([zone('zone-connections', 0, 0, 400, 300)])).toEqual([])
  })

  it('puts a note on the same side as the component it describes', () => {
    const notes = layoutAnchorNotes(SPREAD)

    expect(noteFor(notes, 'left').side).toBe('left')
    expect(noteFor(notes, 'right').side).toBe('right')
  })

  it('places both columns outside the drawing, not merely outside the components', () => {
    /* The zone is 1200 wide and the right-most component ends at 1100. A gutter measured
       from the components would sit *inside* the Segment backdrop, which is the overlap
       this whole change exists to remove. */
    const notes = layoutAnchorNotes(SPREAD)

    expect(noteFor(notes, 'right').x).toBe(1200 + GUTTER_OFFSET)
    expect(noteFor(notes, 'left').x).toBe(0 - GUTTER_OFFSET - NOTE_WIDTH)
  })

  it('centres a note on its component when the column has room', () => {
    const notes = layoutAnchorNotes(SPREAD)
    const centre = 100 + NODE_HEIGHT / 2

    expect(noteFor(notes, 'right').y).toBe(Math.round(centre - NOTE_HEIGHT / 2))
    expect(noteFor(notes, 'right').line.y2).toBe(centre)
  })

  it('never overlaps two notes in the same column', () => {
    /* Components 30px apart and a note four times that tall: the case that decides whether
       a column is readable at all. */
    const stacked = [
      zone('zone-segment', 0, 0, 600, 600),
      node('a', 40, 0, { parentId: 'zone-segment' }),
      node('b', 40, 30, { parentId: 'zone-segment' }),
      node('c', 40, 60, { parentId: 'zone-segment' }),
    ]

    const notes = layoutAnchorNotes(stacked).filter((note) => note.side === 'left')
    expect(notes).toHaveLength(3)

    for (let index = 1; index < notes.length; index += 1) {
      const previous = notes[index - 1]
      expect(notes[index].y, notes[index].id).toBeGreaterThanOrEqual(
        previous.y + previous.height + NOTE_GAP,
      )
    }
  })

  it('keeps the column in the same order as the components it describes', () => {
    /* Pushed down and never up, so the note for the topmost component is the topmost note.
       A column that reordered itself would be unreadable the moment the leader lines are
       not showing, which is most of the time -- they are drawn on hover only. */
    const stacked = [
      zone('zone-segment', 0, 0, 600, 900),
      node('bottom', 40, 400, { parentId: 'zone-segment' }),
      node('middle', 40, 200, { parentId: 'zone-segment' }),
      node('top', 40, 0, { parentId: 'zone-segment' }),
    ]

    const order = layoutAnchorNotes(stacked)
      .filter((note) => note.side === 'left')
      .map((note) => note.id)

    expect(order).toEqual(['top', 'middle', 'bottom'])
  })

  it('orders two components sitting level with each other deterministically', () => {
    /* By id, because the only alternative is document order -- and document order changes
       when a node is re-serialized, which would make two notes swap places on a save. */
    const level = [
      zone('zone-segment', 0, 0, 600, 400),
      node('zulu', 40, 100, { parentId: 'zone-segment' }),
      node('alpha', 40, 100, { parentId: 'zone-segment' }),
    ]

    expect(layoutAnchorNotes(level).map((note) => note.id)).toEqual(['alpha', 'zulu'])
    expect(layoutAnchorNotes([level[0], level[2], level[1]]).map((note) => note.id)).toEqual([
      'alpha',
      'zulu',
    ])
  })

  it('resolves a component nested two zones deep', () => {
    /* Positions are parent-relative at *every* level. A single-level walk puts this note's
       leader at 300 instead of 900 -- short, and therefore still inside the diagram, which
       is why the bug would look like a slightly wonky line rather than a wrong one. */
    const nested = [
      zone('zone-segment', 0, 0, 1400, 800),
      zone('zone-unify', 400, 200, 600, 400, { parentId: 'zone-segment' }),
      node('trait', 300, 100, { parentId: 'zone-unify' }),
    ]

    const note = noteFor(layoutAnchorNotes(nested), 'trait')
    expect(note.line.x2).toBe(400 + 300 + NODE_WIDTH)
    expect(note.line.y2).toBe(200 + 100 + NODE_HEIGHT / 2)
  })

  it('draws the leader from the inner edge of the note to the near edge of the component', () => {
    const notes = layoutAnchorNotes(SPREAD)

    const right = noteFor(notes, 'right')
    expect(right.line.x1).toBe(right.x)
    expect(right.line.x2).toBe(900 + NODE_WIDTH)

    /* The far edge on the left, so the line leaves the card on the side facing the
       drawing. Reading `x` on both sides would draw it out through the back of the note. */
    const left = noteFor(notes, 'left')
    expect(left.line.x1).toBe(left.x + NOTE_WIDTH)
    expect(left.line.x2).toBe(40)
  })

  it('measures a component that has been rendered rather than assuming the default', () => {
    const measured = [
      zone('zone-segment', 0, 0, 600, 400),
      node('tall', 40, 100, { parentId: 'zone-segment', measured: { width: 240, height: 180 } }),
    ]

    const note = noteFor(layoutAnchorNotes(measured), 'tall')
    expect(note.line.x2).toBe(40)
    expect(note.line.y2).toBe(100 + 90)
  })

  it('still places a note for a component dragged outside every zone', () => {
    /* Nothing clamps a drag to its parent any more, so a component can sit past the
       backdrop -- and `diagramBounds` grows to include it, which is what keeps the gutter
       outside the component rather than under it. */
    const escaped = [
      zone('zone-segment', 0, 0, 600, 400),
      node('escaped', 800, 100),
    ]

    const note = noteFor(layoutAnchorNotes(escaped), 'escaped')
    expect(note.side).toBe('right')
    expect(note.x).toBeGreaterThanOrEqual(800 + NODE_WIDTH + GUTTER_OFFSET)
  })

  it('takes note dimensions from the caller', () => {
    const [note] = layoutAnchorNotes([node('solo', 0, 0)], {
      width: 100,
      height: 40,
      offset: 10,
    })

    expect(note.width).toBe(100)
    expect(note.height).toBe(40)
    expect(note.x).toBe(NODE_WIDTH + 10)
  })
})

describe('annotatedBounds', () => {
  it('reaches past both columns, so switching the notes on does not put them off screen', () => {
    const bounds = annotatedBounds(SPREAD)

    expect(bounds.x).toBe(0 - GUTTER_OFFSET - NOTE_WIDTH)
    expect(bounds.x + bounds.width).toBe(1200 + GUTTER_OFFSET + NOTE_WIDTH)
  })

  it('reaches past a note pushed below the drawing by the stack', () => {
    /* A column taller than what it annotates is the normal case for a busy zone, and a
       viewport fitted to the diagram would cut the bottom of it off. */
    const stacked = [
      zone('zone-segment', 0, 0, 600, 200),
      node('a', 40, 0, { parentId: 'zone-segment' }),
      node('b', 40, 30, { parentId: 'zone-segment' }),
    ]

    const bounds = annotatedBounds(stacked)
    expect(bounds.y + bounds.height).toBeGreaterThan(200)
  })

  it('is the diagram alone when there is nothing to annotate', () => {
    expect(annotatedBounds([zone('zone-connections', 10, 20, 400, 300)])).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    })
  })

  it('is null for an empty canvas', () => {
    expect(annotatedBounds([])).toBeNull()
    expect(annotatedBounds(null)).toBeNull()
  })
})
