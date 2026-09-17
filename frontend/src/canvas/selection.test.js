/*
 * The multi-selection actions.
 *
 * The case worth most of this file is two components in *different* zones: their stored
 * positions are in different frames, so an implementation that reads and writes those
 * numbers directly passes every same-zone test and then flings a card across the canvas
 * the first time a real diagram is aligned. Every alignment case below therefore puts its
 * two subjects under different parents on purpose.
 */

import { describe, expect, it } from 'vitest'

import { NODE_HEIGHT, NODE_WIDTH, orderForFlow } from './layout.js'
import { absolutePositions } from './rules.js'
import {
  alignNodes,
  anyLocked,
  arrangeNodes,
  distributeNodes,
  groupNodes,
  setLocked,
  matchSize,
  matchStyle,
  selectedComponents,
  ungroupNodes,
  groupSelectionChanges,
  withGroupMates,
} from './selection.js'

const zone = (id, x, y, parentId = undefined) => ({
  id,
  type: 'zone',
  position: { x, y },
  ...(parentId ? { parentId } : {}),
  data: { id: id.replace('zone-', ''), size: { width: 800, height: 400 } },
})

const card = (id, x, y, { parentId, size, style, group } = {}) => ({
  id,
  type: 'segment',
  position: { x, y },
  selected: true,
  ...(parentId ? { parentId } : {}),
  data: {
    kind: 'source',
    name: id,
    ...(size ? { size } : {}),
    ...(style ? { style } : {}),
    ...(group ? { group } : {}),
  },
})

const left = (nodes, id) => absolutePositions(nodes).get(id).x
const top = (nodes, id) => absolutePositions(nodes).get(id).y
const idsOf = (nodes) => nodes.filter((node) => node.selected).map((node) => node.id)

/* Two cards 100px apart on screen, in zones that are themselves 400px apart -- so their
   stored positions differ by 300 in the other direction. Nothing here lines up by
   accident. */
const crossZone = () => [
  zone('zone-connections', 0, 0),
  zone('zone-unify', 400, 200),
  card('a', 50, 30, { parentId: 'zone-connections' }),
  card('b', -250, -100, { parentId: 'zone-unify' }),
]

describe('selectedComponents', () => {
  it('leaves zones out of a selection', () => {
    const nodes = [{ ...zone('zone-unify', 0, 0), selected: true }, card('a', 0, 0)]
    expect(selectedComponents(nodes, ['zone-unify', 'a']).map((node) => node.id)).toEqual(['a'])
  })

  it('ignores ids that are not in the document', () => {
    expect(selectedComponents([card('a', 0, 0)], ['a', 'gone']).map((n) => n.id)).toEqual(['a'])
  })
})

describe('alignNodes', () => {
  it('lines up left edges on screen, not in each card’s own frame', () => {
    const nodes = crossZone()
    const before = left(nodes, 'a')
    const after = alignNodes(nodes, idsOf(nodes), 'left')

    expect(left(after, 'a')).toBe(before)
    expect(left(after, 'b')).toBe(before)
  })

  it('lines up right edges against the widest card, sizes included', () => {
    const nodes = crossZone()
    nodes[3] = { ...nodes[3], data: { ...nodes[3].data, size: { width: 300, height: 60 } } }
    const after = alignNodes(nodes, idsOf(nodes), 'right')

    expect(left(after, 'a') + NODE_WIDTH).toBe(left(after, 'b') + 300)
  })

  it('centres both cards on the selection’s own middle', () => {
    const nodes = crossZone()
    const after = alignNodes(nodes, idsOf(nodes), 'centerX')

    expect(left(after, 'a') + NODE_WIDTH / 2).toBe(left(after, 'b') + NODE_WIDTH / 2)
  })

  it('aligns tops and bottoms on the vertical axis', () => {
    const nodes = crossZone()
    expect(top(alignNodes(nodes, idsOf(nodes), 'top'), 'a')).toBe(
      top(alignNodes(nodes, idsOf(nodes), 'top'), 'b'),
    )

    const bottomed = alignNodes(nodes, idsOf(nodes), 'bottom')
    expect(top(bottomed, 'a') + NODE_HEIGHT).toBe(top(bottomed, 'b') + NODE_HEIGHT)
  })

  it('is idempotent, because the reference is the bounding box and not a member', () => {
    const nodes = crossZone()
    const once = alignNodes(nodes, idsOf(nodes), 'left')
    const twice = alignNodes(once, idsOf(once), 'left')
    expect(twice.map((node) => node.position)).toEqual(once.map((node) => node.position))
  })

  it('leaves whole numbers behind, so a save does not diff on sub-pixels', () => {
    const nodes = crossZone()
    nodes[2] = { ...nodes[2], position: { x: 50.4, y: 30.7 } }
    const after = alignNodes(nodes, idsOf(nodes), 'middleY')
    for (const node of after) {
      expect(Number.isInteger(node.position.x)).toBe(true)
      expect(Number.isInteger(node.position.y)).toBe(true)
    }
  })

  it('moves nothing when only one component is selected', () => {
    const nodes = [zone('zone-unify', 0, 0), card('a', 50, 30, { parentId: 'zone-unify' })]
    expect(alignNodes(nodes, ['a'], 'left')).toEqual(nodes)
  })

  it('moves nothing for an alignment it does not know', () => {
    const nodes = crossZone()
    expect(alignNodes(nodes, idsOf(nodes), 'diagonal')).toEqual(nodes)
  })

  it('aligns a zone caught in the selection like any other box', () => {
    /* A zone that joins the selection is a genuine member now, not a passenger: it widens
       the bounding box to its own edge, so a card that was already the leftmost of the two
       cards still has to move once the zone's own further-left edge joins the reference. */
    const nodes = crossZone()
    nodes[0] = { ...nodes[0], selected: true }
    const after = alignNodes(nodes, idsOf(nodes), 'left')

    expect(left(after, 'zone-connections')).toBe(0)
    expect(left(after, 'a')).toBe(0)
    expect(left(after, 'b')).toBe(0)
  })

  it('aligns to the size the user just chose, not the one the browser last measured', () => {
    /* The frame after a resize `measured` still describes the old box, so reading it lines
       a card up against a width it no longer has. Same invariant `centreOf` documents. */
    const nodes = crossZone()
    nodes[3] = {
      ...nodes[3],
      measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: { ...nodes[3].data, size: { width: 300, height: 60 } },
    }
    const after = alignNodes(nodes, idsOf(nodes), 'right')

    expect(left(after, 'a') + NODE_WIDTH).toBe(left(after, 'b') + 300)
  })
})

describe('matchSize', () => {
  it('gives the others the model’s chosen box', () => {
    const nodes = [card('a', 0, 0, { size: { width: 320, height: 90 } }), card('b', 0, 100)]
    const after = matchSize(nodes, ['a', 'b'], 'a')
    expect(after[1].data.size).toEqual({ width: 320, height: 90 })
  })

  it('falls back to the model’s default box when it has never been resized', () => {
    /* Otherwise "make same size" against an untouched card writes nulls and does nothing
       visible, which is indistinguishable from a broken button. */
    const nodes = [card('a', 0, 0), card('b', 0, 100, { size: { width: 400, height: 200 } })]
    const after = matchSize(nodes, ['a', 'b'], 'a')
    expect(after[1].data.size).toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT })
  })

  it('leaves the model itself alone', () => {
    const nodes = [card('a', 0, 0, { size: { width: 320, height: 90 } }), card('b', 0, 100)]
    expect(matchSize(nodes, ['a', 'b'], 'a')[0]).toBe(nodes[0])
  })

  it('does nothing when the model is not in the selection', () => {
    const nodes = [card('a', 0, 0, { size: { width: 320, height: 90 } }), card('b', 0, 100)]
    expect(matchSize(nodes, ['b'], 'a')).toEqual(nodes)
  })
})

describe('matchStyle', () => {
  const red = { fill: '#fee', border: '#c00' }

  it('copies the whole override', () => {
    const nodes = [card('a', 0, 0, { style: red }), card('b', 0, 100)]
    expect(matchStyle(nodes, ['a', 'b'], 'a')[1].data.style).toEqual(red)
  })

  it('clears an override when the model has none', () => {
    /* The load-bearing half. A merge would leave the red card red through every attempt to
       match it to a plain one, so "apply the same style" could never undo a style. */
    const nodes = [card('a', 0, 0), card('b', 0, 100, { style: red })]
    expect(matchStyle(nodes, ['a', 'b'], 'a')[1].data.style).toBeUndefined()
  })

  it('replaces rather than merging, so a stale key cannot survive', () => {
    const nodes = [
      card('a', 0, 0, { style: { fill: '#eef' } }),
      card('b', 0, 100, { style: red }),
    ]
    expect(matchStyle(nodes, ['a', 'b'], 'a')[1].data.style).toEqual({ fill: '#eef' })
  })

  it('does not carry size along with style', () => {
    /* Two separate actions, as asked. One quietly doing the other is the failure. */
    const nodes = [
      card('a', 0, 0, { style: red, size: { width: 320, height: 90 } }),
      card('b', 0, 100),
    ]
    expect(matchStyle(nodes, ['a', 'b'], 'a')[1].data.size).toBeUndefined()
  })
})

describe('grouping', () => {
  it('writes one id across every selected component', () => {
    const nodes = [card('a', 0, 0), card('b', 0, 100)]
    const after = groupNodes(nodes, ['a', 'b'], 'grp:1234abcd')
    expect(after.map((node) => node.data.group)).toEqual(['grp:1234abcd', 'grp:1234abcd'])
  })

  it('refuses a group of one', () => {
    const nodes = [card('a', 0, 0)]
    expect(groupNodes(nodes, ['a'], 'grp:1234abcd')).toEqual(nodes)
  })

  it('never groups a zone in with the cards', () => {
    const nodes = [{ ...zone('zone-unify', 0, 0), selected: true }, card('a', 0, 0), card('b', 0, 9)]
    const after = groupNodes(nodes, ['zone-unify', 'a', 'b'], 'grp:1234abcd')
    expect(after[0].data.group).toBeUndefined()
  })

  it('releases every member of a touched group, not only the selected ones', () => {
    /* Half-released is indistinguishable from a failed ungroup: the remainder still moves
       as one, and there is no way to select it, because selecting one member selects all. */
    const nodes = [
      card('a', 0, 0, { group: 'grp:1' }),
      card('b', 0, 100, { group: 'grp:1' }),
      card('c', 0, 200, { group: 'grp:1' }),
    ]
    const after = ungroupNodes(nodes, ['a'])
    expect(after.map((node) => node.data.group)).toEqual([undefined, undefined, undefined])
  })

  it('leaves other groups intact', () => {
    const nodes = [card('a', 0, 0, { group: 'grp:1' }), card('b', 0, 100, { group: 'grp:2' })]
    expect(ungroupNodes(nodes, ['a'])[1].data.group).toBe('grp:2')
  })

  it('returns the document untouched when nothing selected is grouped', () => {
    const nodes = [card('a', 0, 0), card('b', 0, 100)]
    expect(ungroupNodes(nodes, ['a', 'b'])).toEqual(nodes)
  })
})

describe('withGroupMates', () => {
  it('pulls in the rest of a group when one member is selected', () => {
    const nodes = [
      card('a', 0, 0, { group: 'grp:1' }),
      card('b', 0, 100, { group: 'grp:1' }),
      card('c', 0, 200),
    ]
    expect(withGroupMates(nodes, ['a']).sort()).toEqual(['a', 'b'])
  })

  it('returns the same array when nothing is grouped', () => {
    /* Identity, not equality: this runs on every selection change, and a fresh array would
       re-render every node on the canvas for a click that changed nothing. */
    const nodes = [card('a', 0, 0), card('b', 0, 100)]
    const ids = ['a']
    expect(withGroupMates(nodes, ids)).toBe(ids)
  })

  it('returns the same array when the whole group is already selected', () => {
    const nodes = [card('a', 0, 0, { group: 'grp:1' }), card('b', 0, 100, { group: 'grp:1' })]
    const ids = ['a', 'b']
    expect(withGroupMates(nodes, ids)).toBe(ids)
  })

  it('unions the members of several groups at once', () => {
    const nodes = [
      card('a', 0, 0, { group: 'grp:1' }),
      card('b', 0, 100, { group: 'grp:1' }),
      card('c', 0, 200, { group: 'grp:2' }),
      card('d', 0, 300, { group: 'grp:2' }),
      card('e', 0, 400),
    ]
    expect(withGroupMates(nodes, ['a', 'c']).sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

/*
 * The change stream a grouped selection produces.
 *
 * Written against streams rather than against id lists, because the ordering is the part
 * that was wrong: React Flow emits a plain click as deselect-everything followed by
 * select-one, so a rule that produced the right *set* in the wrong *order* still came out
 * as a selection the user could not see.
 */
describe('groupSelectionChanges', () => {
  const grouped = () => [
    card('a', 0, 0, { group: 'grp:1' }),
    card('b', 0, 100, { group: 'grp:1' }),
    card('c', 0, 200, { group: 'grp:1' }),
    card('loner', 0, 300),
  ]

  const select = (id) => ({ id, type: 'select', selected: true })
  const deselect = (id) => ({ id, type: 'select', selected: false })

  it('adds the rest of the group when one member is selected', () => {
    expect(groupSelectionChanges(grouped(), [select('a')])).toEqual([select('b'), select('c')])
  })

  /* The half that was missing. Without it, releasing one member left the other two
     selected with no ring anywhere to say so, and the next drag moved all three. */
  it('releases the rest of the group when one member is deselected', () => {
    expect(groupSelectionChanges(grouped(), [deselect('a')])).toEqual([
      deselect('b'),
      deselect('c'),
    ])
  })

  /*
   * A plain click on a group member: React Flow deselects everything, then selects the one
   * clicked. Both halves name mates, and they disagree -- so the result has to end with the
   * group selected, because that is what the user just did.
   */
  it('resolves a click, which deselects everything and then selects one', () => {
    const changes = [deselect('a'), deselect('b'), deselect('c'), deselect('loner'), select('a')]
    const extra = groupSelectionChanges(grouped(), changes)

    /* Nothing about `b` and `c` before the selects: they are already being deselected by
       the stream itself, so repeating it would be noise. */
    expect(extra).toEqual([select('b'), select('c')])
    /* And the appended selects land after the stream's own deselects. */
    expect([...changes, ...extra].filter((change) => change.id === 'b').at(-1)).toEqual(select('b'))
  })

  it('says nothing about a selection with no groups in it', () => {
    expect(groupSelectionChanges(grouped(), [select('loner')])).toEqual([])
  })

  it('says nothing when the whole group is already named', () => {
    expect(groupSelectionChanges(grouped(), [select('a'), select('b'), select('c')])).toEqual([])
  })

  it('ignores changes that are not about selection', () => {
    const changes = [
      { id: 'a', type: 'position', position: { x: 10, y: 10 } },
      { id: 'a', type: 'dimensions', dimensions: { width: 10, height: 10 } },
    ]
    expect(groupSelectionChanges(grouped(), changes)).toEqual([])
  })

  /* A lasso that caught one member of each of two groups: both groups come along whole. */
  it('handles several groups in one stream', () => {
    const nodes = [
      card('a', 0, 0, { group: 'grp:1' }),
      card('b', 0, 100, { group: 'grp:1' }),
      card('c', 0, 200, { group: 'grp:2' }),
      card('d', 0, 300, { group: 'grp:2' }),
    ]
    expect(groupSelectionChanges(nodes, [select('a'), select('c')])).toEqual([
      select('b'),
      select('d'),
    ])
  })
})

/*
 * Distribute.
 *
 * Every case here uses cards of *different* widths, because equal-gap and equal-centre
 * spacing agree on a row of identical boxes and disagree on any real one -- so a test built
 * from same-sized cards would pass against either implementation.
 */
describe('distributeNodes', () => {
  const row = () => [
    card('a', 0, 0, { size: { width: 100, height: 60 } }),
    card('b', 150, 0, { size: { width: 40, height: 60 } }),
    card('c', 400, 0, { size: { width: 100, height: 60 } }),
  ]

  it('puts equal gaps between the boxes, not between their centres', () => {
    const out = distributeNodes(row(), ['a', 'b', 'c'], 'horizontal')
    /* Span is 0..500, occupied is 100+40+100 = 240, so each of the two gaps is 130.
       a ends at 100, so b starts at 230 -- which a centre-based spacing would put at 230
       too only by coincidence of these numbers, so the gap after b is what separates them:
       b ends at 270 and c starts at 400, which is 130. */
    expect(left(out, 'b')).toBe(230)
    expect(left(out, 'c')).toBe(400)
    expect(left(out, 'b') - (left(out, 'a') + 100)).toBe(130)
    expect(left(out, 'c') - (left(out, 'b') + 40)).toBe(130)
  })

  it('leaves the outermost two where they are', () => {
    /* What makes this a distribution rather than a layout: the user placed the ends, and
       moving them would mean the button could not be pressed twice without the run
       creeping across the canvas. */
    const out = distributeNodes(row(), ['a', 'b', 'c'], 'horizontal')
    expect(left(out, 'a')).toBe(0)
    expect(left(out, 'c')).toBe(400)
  })

  it('is idempotent', () => {
    const once = distributeNodes(row(), ['a', 'b', 'c'], 'horizontal')
    const twice = distributeNodes(once, ['a', 'b', 'c'], 'horizontal')
    expect(twice.map((node) => node.position)).toEqual(once.map((node) => node.position))
  })

  it('distributes vertically on the other axis, leaving x alone', () => {
    const column = [
      card('a', 30, 0, { size: { width: 100, height: 100 } }),
      card('b', 70, 120, { size: { width: 100, height: 40 } }),
      card('c', 10, 400, { size: { width: 100, height: 100 } }),
    ]
    /* Span 0..500, occupied 100+40+100 = 240, so each gap is 130: a ends at 100, b starts
       at 230. */
    const out = distributeNodes(column, ['a', 'b', 'c'], 'vertical')
    expect(top(out, 'b')).toBe(230)
    expect(left(out, 'b')).toBe(70)
    expect(left(out, 'c')).toBe(10)
  })

  it('works across zones, whose stored positions are in different frames', () => {
    const nodes = [
      zone('zone-connections', 0, 0),
      zone('zone-unify', 400, 200),
      card('a', 0, 0, { parentId: 'zone-connections', size: { width: 100, height: 60 } }),
      card('b', -250, -200, { parentId: 'zone-unify', size: { width: 40, height: 60 } }),
      card('c', 400, 0, { parentId: 'zone-connections', size: { width: 100, height: 60 } }),
    ]
    const out = distributeNodes(nodes, ['a', 'b', 'c'], 'horizontal')
    expect(left(out, 'b')).toBe(230)
    /* The stored position is a delta on the old one, in Unify's frame -- not the flow
       coordinate, which would fling it 400px right. */
    expect(out.find((node) => node.id === 'b').position.x).toBe(-170)
  })

  it('refuses two, because one gap is already equal to itself', () => {
    const nodes = [card('a', 0, 0), card('b', 300, 0)]
    expect(distributeNodes(nodes, ['a', 'b'], 'horizontal')).toBe(nodes)
  })

  it('refuses an axis it does not know', () => {
    const nodes = row()
    expect(distributeNodes(nodes, ['a', 'b', 'c'], 'diagonal')).toBe(nodes)
  })

  it('spreads an overlap evenly rather than refusing', () => {
    /* Three 100-wide cards in a 150 span cannot be given a positive gap. Distributing them
       to -25 each is a legible signal to widen the run; a refusal is not. */
    const tight = [
      card('a', 0, 0, { size: { width: 100, height: 60 } }),
      card('b', 10, 0, { size: { width: 100, height: 60 } }),
      card('c', 50, 0, { size: { width: 100, height: 60 } }),
    ]
    const out = distributeNodes(tight, ['a', 'b', 'c'], 'horizontal')
    expect(left(out, 'b') - (left(out, 'a') + 100)).toBe(left(out, 'c') - (left(out, 'b') + 100))
  })

  it('distributes a zone caught in the selection like any other box', () => {
    /* Same arithmetic as 'puts equal gaps between the boxes' -- widths 100, 40, 100 -- with
       the zone standing in for the first card, to show it plays exactly that role. */
    const nodes = [
      { ...zone('zone-connections', 0, 0), data: { id: 'connections', size: { width: 100, height: 60 } } },
      card('a', 150, 0, { size: { width: 40, height: 60 } }),
      card('b', 400, 0, { size: { width: 100, height: 60 } }),
    ]
    const out = distributeNodes(nodes, ['zone-connections', 'a', 'b'], 'horizontal')
    expect(left(out, 'zone-connections')).toBe(0)
    expect(left(out, 'a')).toBe(230)
    expect(left(out, 'b')).toBe(400)
  })
})

/*
 * Arrange.
 *
 * Read through `orderForFlow`, not by inspecting `data.arrange`, because the number is an
 * implementation detail and what the user is promised is a paint order. A test asserting
 * `arrange === 3` would pass while the canvas drew something else.
 */
describe('arrangeNodes', () => {
  /* Same size on purpose. The size rule is the default ordering, and equal areas are exactly
     the case where an offset-based implementation ties and silently does nothing. */
  const stack = () => [
    card('a', 0, 0, { size: { width: 100, height: 100 } }),
    card('b', 10, 10, { size: { width: 100, height: 100 } }),
    card('c', 20, 20, { size: { width: 100, height: 100 } }),
  ]
  const painted = (nodes) => orderForFlow(nodes).map((node) => node.id)

  it('brings one node to the front', () => {
    expect(painted(arrangeNodes(stack(), ['a'], 'front'))).toEqual(['b', 'c', 'a'])
  })

  it('sends one node to the back', () => {
    expect(painted(arrangeNodes(stack(), ['c'], 'back'))).toEqual(['c', 'a', 'b'])
  })

  it('moves one node exactly one place forward', () => {
    expect(painted(arrangeNodes(stack(), ['a'], 'forward'))).toEqual(['b', 'a', 'c'])
  })

  it('moves one node exactly one place backward', () => {
    expect(painted(arrangeNodes(stack(), ['c'], 'backward'))).toEqual(['a', 'c', 'b'])
  })

  it('takes several presses to cross several neighbours', () => {
    /* The whole reason `arrange` is a dense index rather than an offset: `arrange + 1` on a
       set of equal-sized cards ties with the neighbour it was meant to pass, the tie falls
       through to the size rule, and the menu item appears to do nothing. */
    let nodes = stack()
    nodes = arrangeNodes(nodes, ['a'], 'forward')
    expect(painted(nodes)).toEqual(['b', 'a', 'c'])
    nodes = arrangeNodes(nodes, ['a'], 'forward')
    expect(painted(nodes)).toEqual(['b', 'c', 'a'])
  })

  it('stops at the front rather than wrapping round', () => {
    const nodes = arrangeNodes(stack(), ['c'], 'forward')
    expect(painted(nodes)).toEqual(['a', 'b', 'c'])
  })

  it('changes nothing, and no identity, when the node is already at the front', () => {
    const nodes = stack()
    expect(arrangeNodes(nodes, ['c'], 'front')).toBe(nodes)
  })

  it('keeps a moved run in its own order', () => {
    const nodes = arrangeNodes(stack(), ['a', 'b'], 'front')
    expect(painted(nodes)).toEqual(['c', 'a', 'b'])
  })

  it('moves a contiguous run one place without shuffling it internally', () => {
    const nodes = arrangeNodes(stack(), ['a', 'b'], 'forward')
    expect(painted(nodes)).toEqual(['c', 'a', 'b'])
  })

  it('overrides the size rule, which is only a default', () => {
    /* Two overlapping zones: the big one paints behind by default, and bringing it forward
       has to win -- otherwise the guess keeps overruling the instruction. */
    const nodes = [
      { ...zone('zone-big', 0, 0), width: 900, height: 500 },
      { ...zone('zone-small', 50, 50), width: 300, height: 200 },
    ]
    expect(painted(nodes)).toEqual(['zone-big', 'zone-small'])
    expect(painted(arrangeNodes(nodes, ['zone-big'], 'front'))).toEqual([
      'zone-small',
      'zone-big',
    ])
  })

  it('restacks zones without disturbing components, and the reverse', () => {
    /* Two separate pools. A zone sent to the back must not spend its travel getting past
       components it was always behind -- they are on a different z band entirely. */
    const nodes = [
      { ...zone('zone-big', 0, 0), width: 900, height: 500 },
      { ...zone('zone-small', 50, 50), width: 300, height: 200 },
      card('a', 0, 0, { size: { width: 100, height: 100 } }),
      card('b', 10, 10, { size: { width: 100, height: 100 } }),
    ]
    const out = arrangeNodes(nodes, ['zone-small'], 'back')
    expect(out.find((node) => node.id === 'a').data.arrange).toBeUndefined()
    expect(out.find((node) => node.id === 'b').data.arrange).toBeUndefined()
  })

  it('arranges within each parent separately', () => {
    /* Siblings only: array order is paint order between nodes React Flow resolves at the
       same depth, so "in front of that card over in Engage" is not a question it answers. */
    const nodes = [
      zone('zone-connections', 0, 0),
      zone('zone-unify', 400, 0),
      card('a', 0, 0, { parentId: 'zone-connections', size: { width: 100, height: 100 } }),
      card('b', 10, 10, { parentId: 'zone-connections', size: { width: 100, height: 100 } }),
      card('x', 0, 0, { parentId: 'zone-unify', size: { width: 100, height: 100 } }),
    ]
    const out = arrangeNodes(nodes, ['a'], 'front')
    expect(out.find((node) => node.id === 'x').data.arrange).toBeUndefined()
    expect(painted(out).filter((id) => ['a', 'b'].includes(id))).toEqual(['b', 'a'])
  })

  it('refuses a move it does not know', () => {
    const nodes = stack()
    expect(arrangeNodes(nodes, ['a'], 'sideways')).toBe(nodes)
  })

  it('refuses an empty selection', () => {
    const nodes = stack()
    expect(arrangeNodes(nodes, [], 'front')).toBe(nodes)
  })
})

describe('setLocked and anyLocked', () => {
  it('pins a component', () => {
    const out = setLocked([card('a', 0, 0)], ['a'], true)
    expect(out[0].data.locked).toBe(true)
  })

  it('pins a zone too, which is most of the point', () => {
    /* Resizing a zone moves every component in it, so a zone is the thing a stray gesture
       can disturb most -- and the one every other action in this module refuses. */
    const out = setLocked([zone('zone-unify', 0, 0)], ['zone-unify'], true)
    expect(out[0].data.locked).toBe(true)
  })

  it('removes the key on unlock rather than writing false', () => {
    /* So an unlocked node is byte-identical to one never locked, and does not carry a key
       into every saved document. */
    const locked = setLocked([card('a', 0, 0)], ['a'], true)
    const out = setLocked(locked, ['a'], false)
    expect('locked' in out[0].data).toBe(false)
  })

  it('leaves everything else alone', () => {
    const nodes = [card('a', 0, 0), card('b', 100, 0)]
    const out = setLocked(nodes, ['a'], true)
    expect(out[1]).toBe(nodes[1])
  })

  it('returns the same array when nothing changed', () => {
    const nodes = [card('a', 0, 0)]
    expect(setLocked(nodes, ['a'], false)).toBe(nodes)
    expect(setLocked(nodes, [], true)).toBe(nodes)
  })

  it('reports a mixed selection as locked, so the menu offers Unlock', () => {
    /* The direction that cannot lose work: unlocking a thing that was not locked is a
       no-op, where locking a mixed selection would pin cards the user was trying to free. */
    const nodes = setLocked([card('a', 0, 0), card('b', 100, 0)], ['a'], true)
    expect(anyLocked(nodes, ['a', 'b'])).toBe(true)
    expect(anyLocked(nodes, ['b'])).toBe(false)
  })
})
