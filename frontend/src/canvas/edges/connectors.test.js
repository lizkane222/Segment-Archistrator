/*
 * The connector behaviours, one block per promise.
 *
 * A connector joins two components -- or one component and a point where a component has not been
 * drawn yet. Its route can be reshaped by dragging, including adding new corners to get round
 * something. Wherever it meets a component it meets it square-on, so the arrowhead points into the
 * side it touches. And it wears the colour of the component it comes from.
 *
 * Geometry is asserted against coordinates for the reason routing.test.js gives: a wrong line is a
 * bug you can only see.
 */

import { describe, expect, it } from 'vitest'

import {
  PIN_HANDLE,
  PIN_TYPE,
  detachEnd,
  endBox,
  isLoose,
  isPinId,
  looseEnds,
  loosePoint,
  looseSide,
  pinId,
  pinNodesFor,
  pinnedEdges,
  withoutPoint,
} from './looseEnds.js'
import {
  LINE_STYLES,
  directionOf,
  dragSegment,
  dragSplit,
  routeEdge,
  routeHitsAny,
  splitHandles,
} from './routing.js'
import { edgeStrokeWidth } from './FlowEdge.jsx'
import { reverseEdge } from '../direction.js'
import { collapseGraph } from '../grouping.js'
import { toFlowEdge } from '../layout.js'
import { serializeEdge, serializeGraph } from '../../diagram/serialize.js'
import { copyNodes, pasteNodes } from '../../commands/clipboard.js'
import { revisitable } from '../../simulation/router.js'
import { EDGE_MENU, commandsFor } from '../../commands/registry.js'
import { edgeActionIds, edgeActionRows } from '../../inspector/edgeActions.js'

/** Every coordinate pair in a path string, in order. */
function coordinates(path) {
  return [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }))
}

/* The direction the path is travelling as it *arrives*, from its last two distinct coordinates --
   which for a bezier is the last control point to the end point, i.e. the tangent SVG orients the
   arrowhead along. */
function arrival(path) {
  const points = coordinates(path)
  const end = points[points.length - 1]
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const dx = end.x - points[index].x
    const dy = end.y - points[index].y
    const length = Math.hypot(dx, dy)
    if (length > 0.5) return { x: dx / length, y: dy / length }
  }
  return null
}

function departure(path) {
  const points = coordinates(path)
  const start = points[0]
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - start.x
    const dy = points[index].y - start.y
    const length = Math.hypot(dx, dy)
    if (length > 0.5) return { x: dx / length, y: dy / length }
  }
  return null
}

const close = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/* --- perpendicular at every component ---------------------------------------- */

describe('a connector meets every component square-on', () => {
  /* Every combination of side pair and a handful of relative placements, including the awkward ones:
     the target behind the source, level with it, and diagonally away. */
  const sides = ['left', 'right', 'top', 'bottom']
  const targets = [
    { x: 400, y: 250 },
    { x: -300, y: 180 },
    { x: 20, y: -260 },
    { x: 400, y: 0 },
  ]
  const bends = [undefined, [{ x: 150, y: -120 }], [{ x: -80, y: 90 }, { x: 260, y: 300 }]]

  for (const line of LINE_STYLES) {
    it(`leaves along the source side's normal and arrives against the target side's -- ${line}`, () => {
      for (const sourcePosition of sides) {
        for (const targetPosition of sides) {
          for (const target of targets) {
            for (const waypoints of bends) {
              const { path } = routeEdge({
                source: { x: 0, y: 0 },
                target,
                sourcePosition,
                targetPosition,
                waypoints,
                line,
              })
              const label = `${line} ${sourcePosition}->${targetPosition} to ${target.x},${target.y} bends=${waypoints?.length ?? 0}`
              expect(path, label).not.toMatch(/NaN/)
              /* Leaving: travelling out of the side. Arriving: travelling *into* the side, which is
                 the opposite of that side's outward normal -- and is the direction the arrowhead
                 points. */
              expect(close(departure(path), directionOf(sourcePosition)), `depart ${label}`).toBe(true)
              const into = directionOf(targetPosition)
              expect(close(arrival(path), { x: -into.x, y: -into.y }), `arrive ${label}`).toBe(true)
            }
          }
        }
      }
    })
  }

  /* Two consecutive legs of a route fold back on each other when they point in opposite directions. */
  const folds = (a, b, c) => {
    const u = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) }
    const v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) }
    return u.x * v.x + u.y * v.y < 0
  }
  const behind = (waypoint) =>
    routeEdge({
      source: { x: 0, y: 50 },
      target: { x: 400, y: 50 },
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints: [waypoint],
      line: 'orthogonal',
    }).points

  it('turns before doubling back over the card it leaves, when the first bend is behind it', () => {
    /* A bend dragged round the back of the source. Carrying straight on out of the stub would run
       back along it and over the card. */
    const points = behind({ x: -100, y: -60 })
    expect(folds(points[0], points[1], points[2])).toBe(false)
    const card = { x: -200, y: 0, width: 200, height: 100 }
    expect(routeHitsAny(points.slice(1, 3), [card])).toBe(false)
  })

  it('never folds back at the arrowhead when the last bend is behind the target', () => {
    const points = behind({ x: 500, y: -60 })
    const n = points.length
    expect(folds(points[n - 3], points[n - 2], points[n - 1])).toBe(false)
  })

  it('never retraces a segment it has just drawn', () => {
    /* The old walk carried on along the last axis even when the next point was behind, running back
       over the previous leg. */
    for (const waypoints of [
      [{ x: 200, y: 0 }, { x: 200, y: -60 }],
      [{ x: 100, y: 200 }, { x: 300, y: 200 }, { x: 300, y: -100 }],
      [{ x: -50, y: 120 }],
    ]) {
      const { points } = routeEdge({
        source: { x: 0, y: 0 },
        target: { x: 600, y: 0 },
        sourcePosition: 'right',
        targetPosition: 'left',
        waypoints,
        line: 'orthogonal',
      })
      for (let index = 2; index < points.length; index += 1) {
        expect(folds(points[index - 2], points[index - 1], points[index]), JSON.stringify(waypoints)).toBe(false)
      }
    }
  })
})

/* --- adding angles by dragging ------------------------------------------------ */

describe('adding new corners to get round something', () => {
  /* A straight run with a card sitting on it -- the case sliding the whole segment cannot fix without
     moving the line off both components. */
  const points = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
  ]

  it('splits a segment and steps the far part to the pointer, keeping every angle square', () => {
    const waypoints = dragSplit(points, 0, { x: 200, y: 0 }, { x: 250, y: -80 })
    expect(waypoints).toEqual([
      { x: 200, y: 0 },
      { x: 200, y: -80 },
    ])
    const { points: drawn } = routeEdge({
      source: points[0],
      target: points[1],
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints,
      line: 'orthogonal',
    })
    for (let index = 1; index < drawn.length; index += 1) {
      const dx = Math.abs(drawn[index].x - drawn[index - 1].x)
      const dy = Math.abs(drawn[index].y - drawn[index - 1].y)
      expect(dx < 0.5 || dy < 0.5, `segment ${index}`).toBe(true)
    }
  })

  it('jogs round an obstacle in two steps', () => {
    const card = { x: 250, y: -30, width: 100, height: 60 }
    const drawn = (waypoints) =>
      routeEdge({
        source: points[0],
        target: points[1],
        sourcePosition: 'right',
        targetPosition: 'left',
        waypoints,
        line: 'orthogonal',
      }).points
    /* Each gesture works on the route as drawn, which is what the canvas hands it. */
    const first = dragSplit(drawn([]), 1, { x: 200, y: 0 }, { x: 0, y: -60 })
    const afterFirst = drawn(first)
    /* Now the long run at y=-60 continues to the target; split it past the card and bring it back. */
    const runIndex = afterFirst.findIndex(
      (point, index) => index > 0 && afterFirst[index - 1].y === -60 && point.y === -60,
    )
    expect(runIndex).toBeGreaterThan(0)
    const second = dragSplit(afterFirst, runIndex - 1, { x: 400, y: -60 }, { x: 0, y: 0 })
    const final = drawn(second)
    expect(routeHitsAny(final, [card])).toBe(false)
    /* And it comes back down to the level it started at, rather than arriving from above. */
    expect(final.at(-2).y).toBe(0)
  })

  it('never moves the endpoints', () => {
    const waypoints = dragSplit(points, 0, { x: 400, y: 0 }, { x: 0, y: 120 })
    const drawn = routeEdge({
      source: points[0],
      target: points[1],
      sourcePosition: 'right',
      targetPosition: 'left',
      waypoints,
      line: 'orthogonal',
    }).points
    expect(drawn[0]).toEqual(points[0])
    expect(drawn.at(-1)).toEqual(points[1])
  })

  it('keeps the split on the segment even when the grab is a little off it', () => {
    expect(dragSplit(points, 0, { x: 900, y: 7 }, { x: 0, y: 50 })[0]).toEqual({ x: 600, y: 0 })
  })

  it('refuses a diagonal, which has no square way to step', () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(dragSplit(diagonal, 0, { x: 50, y: 50 }, { x: 0, y: 0 })).toEqual([])
  })

  it('offers step handles only on runs long enough to aim at', () => {
    expect(splitHandles(points)).toHaveLength(2)
    expect(
      splitHandles([
        { x: 0, y: 0 },
        { x: 60, y: 0 },
      ]),
    ).toEqual([])
    for (const handle of splitHandles(points)) expect(handle.axis).toBe('x')
  })

  it('still slides a whole segment, which is the other gesture', () => {
    const z = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 380, y: 200 },
      { x: 400, y: 200 },
    ]
    expect(dragSegment(z, 2, { x: 260, y: 0 })).toContainEqual({ x: 260, y: 0 })
  })
})

/* --- loose ends ---------------------------------------------------------------- */

const looseEdge = {
  id: 'e1',
  source: 'a',
  target: null,
  type: 'flow',
  data: { discovered: false, targetPoint: { x: 500, y: 40 } },
}

describe('a connector with one end attached to nothing yet', () => {
  it('knows which end is loose and where it is', () => {
    expect(looseEnds(looseEdge)).toEqual({ source: false, target: true })
    expect(loosePoint(looseEdge, 'target')).toEqual({ x: 500, y: 40 })
    expect(loosePoint(looseEdge, 'source')).toBeNull()
    expect(isLoose(looseEdge)).toBe(true)
    expect(isLoose({ id: 'x', source: 'a', target: 'b', data: {} })).toBe(false)
  })

  it('is not loose without a usable point -- that is a broken edge, not an unfinished one', () => {
    expect(isLoose({ id: 'x', source: 'a', target: null, data: {} })).toBe(false)
    expect(isLoose({ id: 'x', source: 'a', target: null, data: { targetPoint: { x: 'n' } } })).toBe(false)
  })

  it('gets a hidden pin React Flow can draw to, and nothing a reader can touch', () => {
    const [pin] = pinNodesFor([looseEdge])
    expect(pin.id).toBe(pinId('e1', 'target'))
    expect(isPinId(pin.id)).toBe(true)
    expect(pin.type).toBe(PIN_TYPE)
    expect(pin.position).toEqual({ x: 500, y: 40 })
    expect(pin.hidden).toBe(true)
    expect(pin.selectable).toBe(false)
    expect(pin.draggable).toBe(false)
    expect(pin.connectable).toBe(false)
    expect(pin.deletable).toBe(false)
    /* What React Flow's `isNodeInitialized` checks: a handle list and a size, stated up front because
       a hidden node is never measured. Without both the edge is never drawn. */
    expect(pin.handles.map((handle) => handle.type).sort()).toEqual(['source', 'target'])
    expect(pin.handles.every((handle) => handle.id === PIN_HANDLE)).toBe(true)
    expect(pin.width).toBeGreaterThan(0)
    expect(pin.height).toBeGreaterThan(0)
  })

  it('is pointed at its pin for React Flow only', () => {
    const [pinned] = pinnedEdges([looseEdge])
    expect(pinned.source).toBe('a')
    expect(pinned.target).toBe(pinId('e1', 'target'))
    expect(pinned.targetHandle).toBe(PIN_HANDLE)
    /* The pinned copy still reads as loose, so the edge renderer finds the point from it. */
    expect(loosePoint(pinned, 'target')).toEqual({ x: 500, y: 40 })
  })

  it('leaves a diagram with no loose ends alone, same array and all', () => {
    const edges = [{ id: 'x', source: 'a', target: 'b', data: {} }]
    expect(pinnedEdges(edges)).toBe(edges)
    expect(pinNodesFor(edges)).toEqual([])
  })

  it('saves as a null end plus the point, and opens again the same', () => {
    const saved = serializeEdge(pinnedEdges([looseEdge])[0])
    expect(saved.source).toBe('a')
    expect(saved.target).toBeNull()
    expect(saved.targetPoint).toEqual({ x: 500, y: 40 })
    expect(saved.sourcePoint).toBeUndefined()

    const reopened = toFlowEdge(saved)
    expect(reopened.target).toBeNull()
    expect(reopened.data.targetPoint).toEqual({ x: 500, y: 40 })
    expect(serializeEdge(reopened)).toEqual(saved)
  })

  it('survives a whole-document save instead of being dropped as an orphan', () => {
    const graph = serializeGraph({
      nodes: [{ id: 'a', type: 'segmentNode', position: { x: 0, y: 0 }, data: { id: 'a', kind: 'source' } }],
      edges: [looseEdge, { id: 'gone', source: 'a', target: 'missing', data: {} }],
    })
    expect(graph.edges.map((edge) => edge.id)).toEqual(['e1'])
  })

  it('is dropped when loose at both ends, which connects nothing', () => {
    const graph = serializeGraph({
      nodes: [],
      edges: [
        {
          id: 'nothing',
          source: null,
          target: null,
          data: { sourcePoint: { x: 0, y: 0 }, targetPoint: { x: 10, y: 10 } },
        },
      ],
    })
    expect(graph.edges).toEqual([])
  })

  it('never stores a point for an end that is attached', () => {
    const saved = serializeEdge({ id: 'x', source: 'a', target: 'b', data: { targetPoint: { x: 1, y: 2 } } })
    expect(saved.targetPoint).toBeUndefined()
  })

  it('is made by letting go of an end, which forgets how that end was attached', () => {
    const attached = {
      id: 'e2',
      source: 'a',
      target: 'b',
      sourceHandle: 'e',
      targetHandle: 'w',
      data: { targetAnchor: 'free:left:0.30', waypoints: [{ x: 1, y: 2 }], routed: 'auto' },
    }
    const detached = detachEnd(attached, 'target', { x: 300.4, y: 99.6 })
    expect(detached.target).toBeNull()
    expect(detached.targetHandle).toBeNull()
    expect(detached.data.targetAnchor).toBeUndefined()
    expect(detached.data.targetPoint).toEqual({ x: 300, y: 100 })
    /* The router's route was for an attachment that no longer exists. */
    expect(detached.data.waypoints).toBeUndefined()
    expect(detached.data.routed).toBeUndefined()
    /* The other end is untouched. */
    expect(detached.source).toBe('a')
    expect(detached.sourceHandle).toBe('e')
  })

  it("keeps a hand-placed route when an end is let go of", () => {
    const hand = { id: 'e3', source: 'a', target: 'b', data: { waypoints: [{ x: 1, y: 2 }] } }
    expect(detachEnd(hand, 'target', { x: 0, y: 0 }).data.waypoints).toEqual([{ x: 1, y: 2 }])
  })

  it('drops the point once the end is attached again', () => {
    expect(withoutPoint({ targetPoint: { x: 1, y: 1 }, color: 'red' }, 'target')).toEqual({ color: 'red' })
  })

  it('arrives travelling the way it was going, since there is no side to face', () => {
    /* Approached from the left, the end faces left -- so the line arrives travelling right. */
    expect(looseSide({ x: 500, y: 40 }, { x: 0, y: 40 })).toBe('left')
    expect(looseSide({ x: 500, y: 40 }, { x: 500, y: 400 })).toBe('bottom')
    const { path } = routeEdge({
      source: { x: 0, y: 0 },
      target: { x: 500, y: 40 },
      sourcePosition: 'right',
      targetPosition: looseSide({ x: 500, y: 40 }, { x: 0, y: 0 }),
      line: 'straight',
      free: { source: false, target: true },
    })
    const heading = arrival(path)
    /* Straight, with no lead at the loose end: it arrives along the direct line. */
    expect(heading.x).toBeGreaterThan(0.9)
  })

  it('offers its point as a box for the attached end to face', () => {
    expect(endBox(looseEdge, 'target', () => null)).toEqual({ x: 500, y: 40, width: 0, height: 0 })
    expect(endBox(looseEdge, 'source', (id) => ({ id }))).toEqual({ id: 'a' })
  })

  it('keeps its point on the right end when reversed', () => {
    const reversed = reverseEdge(looseEdge)
    expect(reversed.source).toBeNull()
    expect(reversed.target).toBe('a')
    expect(reversed.data.sourcePoint).toEqual({ x: 500, y: 40 })
    expect(reversed.data.targetPoint).toBeUndefined()
    expect(looseEnds(reversed)).toEqual({ source: true, target: false })
  })

  it('is not merged with another loose connector when its component is collapsed into a stack', () => {
    const nodes = ['a', 'b', 'c'].map((id) => ({
      id,
      type: 'segmentNode',
      parentId: 'zone',
      position: { x: 0, y: 0 },
      data: { id, kind: 'destination', name: id },
    }))
    const edges = [
      { ...looseEdge, id: 'l1', source: 'a' },
      { ...looseEdge, id: 'l2', source: 'b', data: { ...looseEdge.data, targetPoint: { x: 9, y: 9 } } },
    ]
    const collapsedKeys = ['kind:destination']
    const view = collapseGraph(nodes, edges, collapsedKeys)
    if (view.edges === edges) return // this topology did not collapse; nothing to check
    expect(view.edges).toHaveLength(2)
    for (const edge of view.edges) expect(isLoose(edge)).toBe(true)
  })

  it('is copied with the component it leaves, and pasted with its point shifted alongside', () => {
    const nodes = [{ id: 'a', type: 'segmentNode', position: { x: 0, y: 0 }, data: { id: 'a', kind: 'source', name: 'A' } }]
    const clip = copyNodes(nodes, [looseEdge], ['a'])
    expect(clip.edges).toHaveLength(1)
    const pasted = pasteNodes(clip, { nodes, topology: null })
    expect(pasted.edges).toHaveLength(1)
    const [edge] = pasted.edges
    expect(edge.source).toBe(pasted.nodes[0].id)
    expect(edge.target).toBeNull()
    expect(edge.targetPoint.x).not.toBe(500)
    expect(edge.targetPoint.x - 500).toBe(pasted.nodes[0].position.x - 0)
  })

  it('is not a second way into a component for the walkthrough', () => {
    const graph = {
      edges: [
        { id: '1', source: 'x', target: 'b' },
        { id: '2', source: null, target: 'b', sourcePoint: { x: 0, y: 0 } },
      ],
    }
    expect(revisitable(graph).has('b')).toBe(false)
  })
})

/* --- selection ----------------------------------------------------------------- */

describe('a selected connector is visibly selected', () => {
  it('draws thicker when selected', () => {
    expect(edgeStrokeWidth({ selected: true })).toBeGreaterThan(edgeStrokeWidth({ selected: false }) ?? 1)
    expect(edgeStrokeWidth({ selected: true, base: 2 })).toBe(3)
  })

  it('keeps a merged line heavier than a single one, selected or not', () => {
    expect(edgeStrokeWidth({ merged: 8 })).toBe(4)
    expect(edgeStrokeWidth({ merged: 8, selected: true })).toBe(5)
  })
})

/* --- the sidebar offers what the right-click menu offers ------------------------ */

describe('the connector sidebar mirrors its right-click menu', () => {
  const edge = { id: 'e', source: 'a', target: 'b', deletable: true, data: { waypoints: [{ x: 1, y: 1 }] } }
  const ctx = { edge, edges: [edge], nodes: [], scenarios: [{ id: 'p', name: 'Path', sourceId: 'a' }], actions: {} }

  it('lists every command the menu does, in the same order', () => {
    const menu = commandsFor(EDGE_MENU, ctx)
    const rows = edgeActionRows(ctx)
    expect(edgeActionIds(rows)).toEqual(edgeActionIds(menu))
    /* The ones the request is about, named so a rename cannot quietly drop one. */
    const ids = edgeActionIds(rows)
    for (const id of ['line-orthogonal', 'line-curved', 'line-straight', 'straighten', 'flow-right', 'reverse-edge', 'delete-edge', 'add-to-path-0']) {
      expect(ids, id).toContain(id)
    }
  })

  it('refuses in the sidebar for the reason the menu gives', () => {
    const fact = { ...edge, deletable: false, data: { discovered: true } }
    const rows = edgeActionRows({ ...ctx, edge: fact })
    const del = rows.find((row) => row.id === 'delete-edge')
    expect(del.enabled).toBe(false)
    expect(del.reason).toMatch(/workspace/)
  })

  it('shows nothing without a connector to act on', () => {
    expect(edgeActionRows({ ...ctx, edge: null })).toEqual([])
  })
})
