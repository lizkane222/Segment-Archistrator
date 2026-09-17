/*
 * Which way a connector points.
 *
 * The case this file exists for is a real one out of the database: a diagram whose every
 * connector was drawn from the downstream card back to the upstream one, so the stored
 * pipeline read end-to-start and a walkthrough starting at the first component found
 * nothing connected to it. Reversing has to put that right without moving a single line on
 * screen -- the bends and the sides the user placed by hand are the drawing, and only the
 * arrowheads should change.
 *
 * The fan-in test below is the reason there is no automatic orientation pass. Two sources
 * feeding one destination cannot be told apart, locally, from a chain drawn backwards, so
 * anything that "works the directions out" turns one of the two into nonsense. See the
 * header of direction.js.
 */

import { describe, expect, it } from 'vitest'

import {
  FLOW_DIRECTIONS,
  connectorSides,
  flowsAlong,
  orientAlong,
  orientSide,
  pointingInto,
  reverseEdge,
  orientConnection,
  reversible,
  routeToReach,
  sideOf,
} from './direction.js'
import { LEGACY_SOURCE, LEGACY_TARGET } from './handles.js'

const edge = (id, source, target, extra = {}) => ({ id, source, target, ...extra })

/* The shape of the JPMC diagram that prompted all of this: one chain, drawn backwards, so
   the stored source is the last component and the stored target is the first. */
const reversedChain = () => [
  edge('e1', 'reports', 'connection'),
  edge('e2', 'connection', 'dataset'),
  edge('e3', 'dataset', 'connector'),
  edge('e4', 'connector', 'formatting'),
  edge('e5', 'formatting', 'analytics'),
]

describe('reverseEdge', () => {
  it('swaps the ends', () => {
    const flipped = reverseEdge(edge('e1', 'a', 'b'))
    expect(flipped.source).toBe('b')
    expect(flipped.target).toBe('a')
  })

  it('keeps the id, because playback and the waypoint writes key on it', () => {
    expect(reverseEdge(edge('e1', 'a', 'b')).id).toBe('e1')
  })

  it('swaps the handles, so the line stays on the sides it was drawn on', () => {
    const flipped = reverseEdge(edge('e1', 'a', 'b', { sourceHandle: 'e', targetHandle: 'n' }))
    expect(flipped.sourceHandle).toBe('n')
    expect(flipped.targetHandle).toBe('e')
  })

  it('swaps a free anchor along with the handle it describes', () => {
    /* `sourceHandle`/`targetHandle` are always a fixed id now (see `fixedHandleForSide` in
       canvas/handles.js); the precise point along that side rides separately in `data`, and has
       to move with its handle for the same reason the handles themselves swap. */
    const flipped = reverseEdge(
      edge('e1', 'a', 'b', {
        sourceHandle: 'e',
        targetHandle: 'n',
        data: { sourceAnchor: 'free:right:0.25' },
      }),
    )
    expect(flipped.sourceHandle).toBe('n')
    expect(flipped.targetHandle).toBe('e')
    expect(flipped.data.sourceAnchor).toBeNull()
    expect(flipped.data.targetAnchor).toBe('free:right:0.25')
  })

  it('leaves an edge with no anchor without either anchor key', () => {
    const flipped = reverseEdge(edge('e1', 'a', 'b', { data: { discovered: false } }))
    expect(flipped.data).not.toHaveProperty('sourceAnchor')
    expect(flipped.data).not.toHaveProperty('targetAnchor')
  })

  it('reverses the bends, so the route is visually identical', () => {
    /* Waypoints are absolute coordinates listed source-to-target. Read from the new source
       the reversed list is the same corners in the same places. */
    const flipped = reverseEdge(
      edge('e1', 'a', 'b', { data: { waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }] } }),
    )
    expect(flipped.data.waypoints).toEqual([{ x: 2, y: 2 }, { x: 1, y: 1 }])
  })

  it('leaves an edge with no bends without a waypoints key', () => {
    /* `serializeEdge` omits absent waypoints so an untouched edge serializes byte-identically.
       Writing `waypoints: []` here would mark every reversed diagram dirty in a new way. */
    const flipped = reverseEdge(edge('e1', 'a', 'b', { data: { discovered: false } }))
    expect(flipped.data).not.toHaveProperty('waypoints')
  })

  it('is its own inverse', () => {
    const original = edge('e1', 'a', 'b', {
      sourceHandle: 'e',
      targetHandle: 'w',
      data: { waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    })
    expect(reverseEdge(reverseEdge(original))).toEqual(original)
  })
})

describe('reversible', () => {
  it('names every connector when given no ids, which is "reverse all"', () => {
    expect(reversible(reversedChain()).reverse).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  })

  it('restricts to the ids asked for', () => {
    expect(reversible(reversedChain(), ['e2', 'e4']).reverse).toEqual(['e2', 'e4'])
  })

  it('holds back connectors read from the workspace rather than dropping them silently', () => {
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'c', 'd', { data: { discovered: true } })]
    expect(reversible(edges)).toEqual({ reverse: ['e1'], blocked: ['e2'] })
  })

  it('reads `discovered` at the top level too, which is where a loaded edge carries it', () => {
    expect(reversible([edge('e1', 'a', 'b', { discovered: true })]).blocked).toEqual(['e1'])
  })

  it('skips a self-loop, which reversing would not change', () => {
    expect(reversible([edge('e1', 'a', 'a')]).reverse).toEqual([])
  })

  it('leaves a legitimate fan-in for the user to decide about', () => {
    /* The whole reason nothing here infers direction. Two sources feeding one destination
       is a correct diagram; an orientation pass rooted at either source would turn the
       other one's connector round and make the destination feed a source. */
    const fanIn = [edge('e1', 's1', 'dest'), edge('e2', 's2', 'dest')]
    expect(reversible(fanIn, ['e1']).reverse).toEqual(['e1'])
    expect(reversible(fanIn, []).reverse).toEqual([])
  })
})

describe('FLOW_DIRECTIONS', () => {
  it('offers the four directions, with the two a diagram is read in first', () => {
    expect(FLOW_DIRECTIONS.map((entry) => entry.id)).toEqual(['right', 'down', 'left', 'up'])
  })
})

describe('flowsAlong', () => {
  const a = { x: 0, y: 0 }

  it('reads left-to-right off the x axis', () => {
    expect(flowsAlong(a, { x: 10, y: 0 }, 'right')).toBe(true)
    expect(flowsAlong(a, { x: -10, y: 0 }, 'right')).toBe(false)
  })

  it('reads top-to-bottom off the y axis', () => {
    /* y grows downward in flow coordinates, so a larger y is further down the diagram. */
    expect(flowsAlong(a, { x: 0, y: 10 }, 'down')).toBe(true)
    expect(flowsAlong(a, { x: 0, y: -10 }, 'down')).toBe(false)
  })

  it('handles the two reverse directions', () => {
    expect(flowsAlong(a, { x: -10, y: 0 }, 'left')).toBe(true)
    expect(flowsAlong(a, { x: 0, y: -10 }, 'up')).toBe(true)
  })

  it('ignores the other axis entirely', () => {
    /* A connector going right and far down is still going right. Judging it on the larger
       of the two deltas would make "flow right" mean something different for a steep line
       than for a shallow one, which is not a rule anyone could predict. */
    expect(flowsAlong(a, { x: 10, y: 500 }, 'right')).toBe(true)
  })

  it('is satisfied by components level on the axis, so the command is a no-op', () => {
    expect(flowsAlong(a, { x: 50, y: 0 }, 'down')).toBe(true)
    expect(flowsAlong(a, { x: 0, y: 50 }, 'right')).toBe(true)
  })

  it('is satisfied by an unknown direction or a missing position', () => {
    expect(flowsAlong(a, { x: 10, y: 0 }, 'sideways')).toBe(true)
    expect(flowsAlong(a, null, 'right')).toBe(true)
  })
})

describe('orientAlong', () => {
  /* The real JPMC diagram: laid out as a vertical stack, every connector drawn from the
     lower card back up to the one above it. Asking for "top to bottom" is the whole fix. */
  const stacked = [
    edge('e1', 'b', 'a'),
    edge('e2', 'c', 'b'),
    edge('e3', 'd', 'c'),
  ]
  const centres = new Map([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 0, y: 100 }],
    ['c', { x: 0, y: 200 }],
    ['d', { x: 0, y: 300 }],
  ])

  it('names every connector running against the direction asked for', () => {
    expect(orientAlong(stacked, centres, 'down').reverse).toEqual(['e1', 'e2', 'e3'])
  })

  it('names none when they already flow that way', () => {
    expect(orientAlong(stacked, centres, 'up').reverse).toEqual([])
  })

  it('leaves connectors on the other axis alone', () => {
    /* A vertical stack has nothing to say about "left to right", and a command that flipped
       lines because they were merely not horizontal would be unusable on a real diagram. */
    expect(orientAlong(stacked, centres, 'right').reverse).toEqual([])
  })

  it('restricts to the ids asked for', () => {
    expect(orientAlong(stacked, centres, 'down', ['e2']).reverse).toEqual(['e2'])
  })

  it('skips a connector whose ends have no measured position yet', () => {
    const dangling = [edge('e9', 'ghost', 'a')]
    expect(orientAlong(dangling, centres, 'down').reverse).toEqual([])
  })

  it('still holds back workspace connectors', () => {
    const discovered = [edge('e1', 'b', 'a', { data: { discovered: true } })]
    expect(orientAlong(discovered, centres, 'down')).toMatchObject({
      reverse: [],
      blocked: ['e1'],
    })
  })

  it('reverses to exactly the orientation it promised', () => {
    /* The property that matters: after applying what it returns, every connector flows the
       way that was asked for. Asserting the ids alone would not catch a sign error. */
    const flipping = new Set(orientAlong(stacked, centres, 'down').reverse)
    const applied = stacked.map((entry) => (flipping.has(entry.id) ? reverseEdge(entry) : entry))
    for (const entry of applied) {
      expect(flowsAlong(centres.get(entry.source), centres.get(entry.target), 'down')).toBe(true)
    }
  })
})

describe('pointingInto', () => {
  it('names the connectors arriving at a component', () => {
    /* What the "this path has nowhere to go" message lists: the chain is backwards, so the
       intended first component has one connector and it arrives rather than leaves. */
    expect(pointingInto(reversedChain(), 'analytics')).toEqual(['e5'])
  })

  it('is empty for a component the flow leaves', () => {
    expect(pointingInto([edge('e1', 'a', 'b')], 'a')).toEqual([])
  })

  it('ignores a self-loop, which neither enters nor leaves', () => {
    expect(pointingInto([edge('e1', 'a', 'a')], 'a')).toEqual([])
  })
})

describe('sideOf', () => {
  it('reads the source handle at the source end', () => {
    expect(sideOf(edge('e1', 'a', 'b', { sourceHandle: 'n' }), 'a')).toMatchObject({
      side: 'top',
      flow: 'out',
    })
  })

  it('reads the target handle at the target end', () => {
    expect(sideOf(edge('e1', 'a', 'b', { targetHandle: 's' }), 'b')).toMatchObject({
      side: 'bottom',
      flow: 'in',
    })
  })

  it('resolves a free anchor to its side', () => {
    expect(sideOf(edge('e1', 'a', 'b', { sourceHandle: 'free:left:0.4' }), 'a').side).toBe('left')
  })

  it('falls back the way React Flow resolves a null handle', () => {
    /* Every connector saved before four-sided handles has null on both ends. Filing those
       under the wrong side would mis-describe every old diagram. */
    const legacy = edge('e1', 'a', 'b')
    expect(sideOf(legacy, 'a').side).toBe('right')
    expect(sideOf(legacy, 'b').side).toBe('left')
    expect([LEGACY_SOURCE, LEGACY_TARGET]).toEqual(['e', 'w'])
  })

  it('is null for a connector that does not touch the node, and for a self-loop', () => {
    expect(sideOf(edge('e1', 'a', 'b'), 'z')).toBeNull()
    expect(sideOf(edge('e1', 'a', 'a'), 'a')).toBeNull()
  })
})

describe('connectorSides', () => {
  it('groups by side and reports the direction of each', () => {
    const edges = [
      edge('e1', 'mid', 'x', { sourceHandle: 'e' }),
      edge('e2', 'mid', 'y', { sourceHandle: 'e' }),
      edge('e3', 'w1', 'mid', { targetHandle: 'w' }),
    ]
    expect(connectorSides(edges, 'mid')).toEqual([
      { side: 'right', count: 2, flow: 'out', edgeIds: ['e1', 'e2'] },
      { side: 'left', count: 1, flow: 'in', edgeIds: ['e3'] },
    ])
  })

  it('calls a side with lines both ways mixed', () => {
    const edges = [
      edge('e1', 'mid', 'x', { sourceHandle: 'n' }),
      edge('e2', 'y', 'mid', { targetHandle: 'n' }),
    ]
    expect(connectorSides(edges, 'mid')[0]).toMatchObject({ side: 'top', flow: 'mixed' })
  })

  it('omits sides with nothing on them', () => {
    const sides = connectorSides([edge('e1', 'mid', 'x', { sourceHandle: 'e' })], 'mid')
    expect(sides.map((entry) => entry.side)).toEqual(['right'])
  })
})

describe('orientSide', () => {
  it('names only the connectors on that side not already flowing that way', () => {
    const edges = [
      edge('e1', 'mid', 'x', { sourceHandle: 'e' }),
      edge('e2', 'y', 'mid', { targetHandle: 'e' }),
      edge('e3', 'z', 'mid', { targetHandle: 'w' }),
    ]
    /* e2 arrives on the right and so has to flip; e1 already leaves it; e3 is another side. */
    expect(orientSide(edges, 'mid', 'right', 'out')).toEqual(['e2'])
  })

  it('returns nothing for a side already uniform, so the write is a no-op', () => {
    const edges = [edge('e1', 'mid', 'x', { sourceHandle: 'e' })]
    expect(orientSide(edges, 'mid', 'right', 'out')).toEqual([])
  })

  it('never names a discovered connector', () => {
    const edges = [edge('e1', 'y', 'mid', { targetHandle: 'e', data: { discovered: true } })]
    expect(orientSide(edges, 'mid', 'right', 'out')).toEqual([])
  })
})

/*
 * "Put this component on that path."
 *
 * The reported case: a path stops two thirds of the way down a diagram and there is no obvious way to
 * extend it. The cause is always the same -- the connectors past that point are stored backwards --
 * and the reason it needs its own operation is that a path cannot be *told* to include a component.
 * A path is walked along the arrows, so the only honest way to add one is to make it reachable.
 */
describe('routeToReach', () => {
  /* The bottom of the JPMC diagram exactly as stored: three vertical connectors drawn bottom-up, so
     the chain reads backwards from the component the path actually reaches. */
  const jpmcTail = () => [
    edge('up1', 'dataset', 'endpoint'),
    edge('up2', 'connection', 'dataset'),
    edge('up3', 'reports', 'connection'),
  ]

  it('names every connector between the path and the component', () => {
    const { found, reverse } = routeToReach(jpmcTail(), ['endpoint'], 'reports')
    expect(found).toBe(true)
    /* All three, in the order they are travelled -- reversing only the first would move the dead end
       one component along. */
    expect(reverse).toEqual(['up1', 'up2', 'up3'])
  })

  it('reports the route as well as the fix', () => {
    expect(routeToReach(jpmcTail(), ['endpoint'], 'reports').route).toEqual(['up1', 'up2', 'up3'])
  })

  it('names nothing to change when the component is already reachable', () => {
    const edges = [edge('a', 'src', 'mid'), edge('b', 'mid', 'far')]
    const { found, reverse } = routeToReach(edges, ['src', 'mid'], 'far')
    expect(found).toBe(true)
    /* Reachable already, so whatever is keeping it off the path is not a direction -- the caller has
       to look elsewhere rather than flip a line that was right. */
    expect(reverse).toEqual([])
  })

  it('says so when nothing joins them at all', () => {
    const edges = [edge('a', 'src', 'mid')]
    const { found, reverse } = routeToReach(edges, ['src'], 'island')
    /* Not a reversal but a connector the user has yet to draw. Reporting this as "nothing to do"
       would leave a menu item that appears broken. */
    expect(found).toBe(false)
    expect(reverse).toEqual([])
  })

  it('treats a component already on the path as nothing to do', () => {
    const { found, reverse } = routeToReach(jpmcTail(), ['endpoint'], 'endpoint')
    expect(found).toBe(true)
    expect(reverse).toEqual([])
  })

  /* Fewest arrowheads disturbed. Reaching a component the long way round would turn connectors the
     user never asked about, which is the failure the removed auto-orient tool was removed for. */
  it('takes the shortest way round rather than the first it finds', () => {
    const edges = [
      edge('short', 'target', 'onpath'),
      edge('long1', 'target', 'detour'),
      edge('long2', 'detour', 'onpath'),
    ]
    expect(routeToReach(edges, ['onpath'], 'target').reverse).toEqual(['short'])
  })

  /* The whole reached set at once, so which component the route joins the path at is not something
     the user has to work out and name. */
  it('joins the path at whichever reached component is nearest', () => {
    const edges = [edge('far', 'target', 'a'), edge('near', 'target', 'b')]
    const { route } = routeToReach(edges, ['a', 'b'], 'target')
    expect(route).toHaveLength(1)
  })

  it('leaves a connector read from the workspace alone, and says which', () => {
    const edges = [edge('fact', 'target', 'onpath', { data: { discovered: true } })]
    const { found, reverse, blocked } = routeToReach(edges, ['onpath'], 'target')
    expect(found).toBe(true)
    expect(reverse).toEqual([])
    /* Named rather than silently skipped: a fix that appeared to run and changed nothing is worse
       than one that explains why it cannot. */
    expect(blocked).toEqual(['fact'])
  })

  /*
   * The property that makes this safe where orienting outward from a start was not. Two sources
   * feeding one destination is the commonest shape on a Segment diagram, and it must survive.
   */
  it('does not disturb a fan-in it is not routing through', () => {
    const edges = [
      edge('s1', 'srcA', 'dest'),
      edge('s2', 'srcB', 'dest'),
      edge('backwards', 'orphan', 'dest'),
    ]
    const { reverse } = routeToReach(edges, ['srcA', 'dest'], 'orphan')
    /* Only the connector on the route to the named component. The other route into `dest` is a real
       fan-in and is none of this operation's business. */
    expect(reverse).toEqual(['backwards'])
  })

  it('cannot be sent round a cycle', () => {
    const edges = [edge('a', 'x', 'y'), edge('b', 'y', 'z'), edge('c', 'z', 'x')]
    expect(routeToReach(edges, ['x'], 'z').found).toBe(true)
  })

  it('ignores a self-loop rather than routing through one', () => {
    const edges = [edge('loop', 'target', 'target')]
    expect(routeToReach(edges, ['onpath'], 'target').found).toBe(false)
  })

  it('survives being asked nothing', () => {
    expect(routeToReach(null, ['a'], 'b').found).toBe(false)
    expect(routeToReach([], [], 'b').found).toBe(false)
    expect(routeToReach(jpmcTail(), ['endpoint'], null).found).toBe(false)
  })
})

/*
 * The direction a hand-drawn connector comes out pointing.
 *
 * This is the bug that produced every backwards diagram in the database. Each side of a card carries a
 * source and a target handle stacked under one id, and React Flow reports a drag begun on a *target*
 * handle with the ends the other way round -- so the direction of a new connector was decided by which
 * of two invisible, identically-placed handles was painted last. It was consistently the target.
 *
 * The rule now is the gesture: data flows the way you dragged. These tests are about nothing else.
 */
describe('orientConnection', () => {
  const drawn = {
    source: 'destination',
    target: 'app',
    sourceHandle: 'w',
    targetHandle: 'e',
  }

  it('turns a connection round when the drag began at the reported target', () => {
    /* The user dragged from the app to the destination; React Flow reported the reverse. */
    const fixed = orientConnection(drawn, { nodeId: 'app' })
    expect(fixed.source).toBe('app')
    expect(fixed.target).toBe('destination')
  })

  it('moves the handles with the ends, so the line stays on the sides it was drawn between', () => {
    const fixed = orientConnection(drawn, { nodeId: 'app' })
    expect(fixed.sourceHandle).toBe('e')
    expect(fixed.targetHandle).toBe('w')
  })

  it('leaves a connection already running from the drag origin alone', () => {
    const already = { source: 'app', target: 'destination', sourceHandle: 'e', targetHandle: 'w' }
    expect(orientConnection(already, { nodeId: 'app' })).toBe(already)
  })

  it('keeps everything else the connection carried', () => {
    const extra = { ...drawn, somethingElse: true }
    expect(orientConnection(extra, { nodeId: 'app' }).somethingElse).toBe(true)
  })

  /* A drag whose origin is neither end cannot be reasoned about, and guessing would turn a line round
     for a reason the user could not see. */
  it('leaves a connection alone when the origin is not one of its ends', () => {
    expect(orientConnection(drawn, { nodeId: 'somewhere-else' })).toBe(drawn)
  })

  it('leaves a self-loop alone', () => {
    const loop = { source: 'app', target: 'app', sourceHandle: 'e', targetHandle: 'w' }
    expect(orientConnection(loop, { nodeId: 'app' })).toBe(loop)
  })

  it('is a no-op with no recorded origin, so nothing depends on the gesture being captured', () => {
    expect(orientConnection(drawn, null)).toBe(drawn)
    expect(orientConnection(drawn, {})).toBe(drawn)
    expect(orientConnection(null, { nodeId: 'app' })).toBe(null)
  })

  /* Applying it twice must not undo it: the same connection goes through `isValidConnection` mid-drag
     and `onConnect` on release, and the second pass sees the already-corrected pair. */
  it('is idempotent', () => {
    const once = orientConnection(drawn, { nodeId: 'app' })
    expect(orientConnection(once, { nodeId: 'app' })).toBe(once)
  })
})
