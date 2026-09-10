/*
 * Layout is where zone membership becomes React Flow structure: a component gets its
 * zone's group node as `parentId`, so moving a zone moves its contents.
 *
 * What is asserted throughout is the *absence* of `extent: 'parent'`. Containment used
 * to be a clamp React Flow enforced; it is advice now, because a component can belong
 * to two products at once and the canvas outside every zone is a working area. The
 * clamp coming back would silently make several features impossible, so it is pinned.
 */

import { describe, expect, it } from 'vitest'

import {
  COMPONENT_Z,
  MIN_CHILD_GAP,
  MIN_ZONE_HEIGHT,
  MIN_ZONE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  buildLayout,
  capturePositions,
  captureZones,
  componentSize,
  droppedZoneSize,
  growZones,
  minZoneSize,
  orderForFlow,
  scaleFloor,
  scaleZoneChildren,
  toFlowEdge,
  toFlowNode,
  ZONE_Z,
  zoneDescriptor,
  zoneNodeId,
  zoneSize,
} from './layout.js'

const ZONES = [
  { id: 'connections', label: 'Connections', order: 0 },
  { id: 'unify', label: 'Unify', order: 1 },
  { id: 'engage', label: 'Engage', order: 2 },
]

const graph = (nodes, edges = []) => ({ zones: ZONES, nodes, edges })

const node = (id, kind, zone, extra = {}) => ({ id, kind, zone, name: id, ...extra })

describe('buildLayout', () => {
  it('emits one group node per zone plus a node per component', () => {
    const { nodes } = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('audience:b', 'audience', 'engage')]),
    )

    const zoneNodes = nodes.filter((n) => n.type === 'zone')
    expect(zoneNodes.map((n) => n.id)).toEqual([
      zoneNodeId('connections'),
      zoneNodeId('unify'),
      zoneNodeId('engage'),
    ])
    expect(nodes.filter((n) => n.type === 'segmentNode')).toHaveLength(2)
  })

  it('parents every component to its own zone without clamping it there', () => {
    const { nodes } = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('trait:t', 'computed_trait', 'unify')]),
    )

    const source = nodes.find((n) => n.id === 'source:a')
    const trait = nodes.find((n) => n.id === 'trait:t')

    expect(source.parentId).toBe(zoneNodeId('connections'))
    expect(trait.parentId).toBe(zoneNodeId('unify'))
    /* `extent: 'parent'` used to be asserted here, because containment was a hard
       guarantee: React Flow clamps a child's drag to its parent's box. It has to be
       absent now -- a component may be dragged into another product or out onto the
       bare canvas, which is what Canvas's onNodeDragStop then re-parents. */
    expect(source.extent).toBeUndefined()
    expect(trait.extent).toBeUndefined()
  })

  it('renders zones in declared order, stacked without overlap', () => {
    const { nodes } = buildLayout(graph([node('source:a', 'source', 'connections')]))
    const zoneNodes = nodes.filter((n) => n.type === 'zone')

    for (let i = 1; i < zoneNodes.length; i += 1) {
      const previous = zoneNodes[i - 1]
      const current = zoneNodes[i]
      expect(current.position.y).toBeGreaterThanOrEqual(previous.position.y + previous.height)
    }
  })

  it('sorts zones by order rather than by array position', () => {
    const shuffled = {
      zones: [ZONES[2], ZONES[0], ZONES[1]],
      nodes: [],
      edges: [],
    }
    const zoneNodes = buildLayout(shuffled).nodes.filter((n) => n.type === 'zone')
    expect(zoneNodes.map((n) => n.data.id)).toEqual(['connections', 'unify', 'engage'])
  })

  it('places nodes in pipeline columns: source left, processing middle, destination right', () => {
    const { nodes } = buildLayout(
      graph([
        node('source:a', 'source', 'connections'),
        node('filter:f', 'destination_filter', 'connections'),
        node('destination:d', 'destination', 'connections'),
      ]),
    )
    const x = (id) => nodes.find((n) => n.id === id).position.x

    expect(x('source:a')).toBeLessThan(x('filter:f'))
    expect(x('filter:f')).toBeLessThan(x('destination:d'))
  })

  it('stacks same-kind nodes vertically without overlapping', () => {
    const { nodes } = buildLayout(
      graph([
        node('source:a', 'source', 'connections'),
        node('source:b', 'source', 'connections'),
        node('source:c', 'source', 'connections'),
      ]),
    )
    const sources = nodes.filter((n) => n.id.startsWith('source:'))

    expect(new Set(sources.map((n) => n.position.x)).size).toBe(1)
    const ys = sources.map((n) => n.position.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NODE_HEIGHT)
    }
  })

  it('gives a zone explicit dimensions large enough for its contents', () => {
    /* React Flow does not measure group nodes from their children, so a zone with
       no size collapses and its children render outside the visible box. */
    const { nodes } = buildLayout(
      graph([
        node('source:a', 'source', 'connections'),
        node('source:b', 'source', 'connections'),
        node('destination:d', 'destination', 'connections'),
      ]),
    )
    const zone = nodes.find((n) => n.id === zoneNodeId('connections'))

    expect(zone.width).toBeGreaterThan(NODE_WIDTH)
    expect(zone.height).toBeGreaterThan(NODE_HEIGHT * 2)

    for (const child of nodes.filter((n) => n.parentId === zone.id)) {
      expect(child.position.x + NODE_WIDTH).toBeLessThanOrEqual(zone.width)
      expect(child.position.y + NODE_HEIGHT).toBeLessThanOrEqual(zone.height)
    }
  })

  it('sizes zones top-level rather than in style, where NodeResizer would not see it', () => {
    /* React Flow resolves `node.width ?? node.style.width`, and NodeResizer only
       ever writes the top-level pair. A zone carrying its size in `style` would
       render at one size and serialize at another the moment a handle moved. */
    const zone = buildLayout(graph([])).nodes.find((n) => n.type === 'zone')
    expect(zone.width).toBeGreaterThan(0)
    expect(zone.style?.width).toBeUndefined()
  })

  it('sizes an empty zone rather than collapsing it to zero', () => {
    /* A workspace without Unify is normal. The zone still has to be a visible,
       droppable target. */
    const zone = buildLayout(graph([])).nodes.find((n) => n.id === zoneNodeId('unify'))
    expect(zone.height).toBeGreaterThan(0)
    expect(zone.width).toBeGreaterThan(0)
    expect(zone.data.kindCount).toBe(0)
  })

  it('makes zones movable only by their header strip', () => {
    /* Selectable so the resize handles can appear, draggable so a region can be
       arranged -- but confined to `.zone-handle`, because a draggable backdrop
       would turn a click on empty space inside a zone into a move of the whole
       thing, and would swallow palette drops aimed at the space it covers. */
    const zone = buildLayout(graph([])).nodes.find((n) => n.type === 'zone')
    expect(zone.selectable).toBe(true)
    expect(zone.draggable).toBe(true)
    expect(zone.dragHandle).toBe('.zone-handle')
    // Still behind its children, or the backdrop covers the components.
    expect(zone.zIndex).toBe(ZONE_Z)
    expect(ZONE_Z).toBeLessThan(COMPONENT_Z)
  })

  it('leaves enough room between a zone and a component for zones to nest', () => {
    /* Not decoration: React Flow lifts a child above its parent by *adding* to the parent's
       z (`calculateChildXYZ`), so a zone one level down resolves to ZONE_Z + 1 and one two
       levels down to ZONE_Z + 2. With the two constants one apart -- which is what they were
       -- a sub-zone tied with the components and a sub-sub-zone beat them, and the losing
       card was not merely painted over but unclickable, because the z lands on the wrapper
       div React Flow hangs the hit target on.

       Four levels of headroom against a topology that nests two, so a customer's own zones
       drawn inside a sub-zone still cannot reach a component. */
    expect(COMPONENT_Z - ZONE_Z).toBeGreaterThanOrEqual(4)
  })

  it('preserves supplied positions so a refresh does not discard manual placement', () => {
    const existingPositions = { 'source:a': { x: 999, y: 777 } }
    const { nodes } = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('source:b', 'source', 'connections')]),
      { existingPositions },
    )

    expect(nodes.find((n) => n.id === 'source:a').position).toEqual({ x: 999, y: 777 })
    // Nodes with no saved position still get a computed one.
    expect(nodes.find((n) => n.id === 'source:b').position.x).toBeGreaterThanOrEqual(0)
  })

  it('grows a zone to contain the positions restored into it', () => {
    /* `extent: 'parent'` clamps to the zone box, so a saved node beyond it would be
       yanked back inward on the first drag after reopening -- the diagram would
       survive the save and then quietly rearrange itself. */
    const { nodes } = buildLayout(
      graph([node('source:a', 'source', 'connections')]),
      { existingPositions: { 'source:a': { x: 1400, y: 620 } } },
    )

    const zone = nodes.find((n) => n.id === zoneNodeId('connections'))
    expect(zone.width).toBeGreaterThanOrEqual(1400 + NODE_WIDTH)
    expect(zone.height).toBeGreaterThanOrEqual(620 + NODE_HEIGHT)
  })

  it('grows only the zone the node belongs to', () => {
    const { nodes } = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('trait:t', 'computed_trait', 'unify')]),
      { existingPositions: { 'source:a': { x: 1400, y: 0 } } },
    )

    const connections = nodes.find((n) => n.id === zoneNodeId('connections'))
    const unify = nodes.find((n) => n.id === zoneNodeId('unify'))
    expect(connections.width).toBeGreaterThan(unify.width)
    // And the taller Connections zone still pushes Unify down rather than overlapping it.
    expect(unify.position.y).toBeGreaterThanOrEqual(connections.position.y + connections.height)
  })

  it('spreads the server payload onto data so no field is silently dropped', () => {
    const { nodes } = buildLayout(
      graph([
        node('source:a', 'source', 'connections', {
          writeKeyMasked: '••••1234',
          docsUrl: 'https://docs',
          somethingNew: 'from a future API version',
        }),
      ]),
    )
    const data = nodes.find((n) => n.id === 'source:a').data

    expect(data.writeKeyMasked).toBe('••••1234')
    expect(data.somethingNew).toBe('from a future API version')
  })

  it('defaults nodes to bound and expanded', () => {
    const { nodes } = buildLayout(graph([node('source:a', 'source', 'connections')]))
    const data = nodes.find((n) => n.id === 'source:a').data
    expect(data.bound).toBe(true)
    expect(data.collapsed).toBe(false)
  })

  it('keeps an explicit bound:false for template placeholders', () => {
    const { nodes } = buildLayout(
      graph([node('ph:1', 'source', 'connections', { bound: false })]),
    )
    expect(nodes.find((n) => n.id === 'ph:1').data.bound).toBe(false)
  })

  /* This used to assert a fallback to Connections. A node with no zone is now a node in
     the working area outside every zone, and defaulting it into a product would move
     something the user parked on purpose. */
  it('leaves a node with no zone on the bare canvas', () => {
    const { nodes } = buildLayout({ zones: ZONES, nodes: [{ id: 'x', kind: 'source', name: 'x' }] })
    const loose = nodes.find((n) => n.id === 'x')
    expect(loose.parentId).toBeUndefined()
    expect(loose.data.zone).toBeNull()
  })

  /* The bug this pins: `bucket` only ever emitted nodes whose zone was a zone present in
     the document, so a node naming a deleted zone vanished from the layout -- and the
     next save made that permanent. */
  it('keeps a node whose zone is not in the document', () => {
    const { nodes } = buildLayout({
      zones: ZONES,
      nodes: [{ id: 'orphan', kind: 'source', name: 'x', zone: 'deleted-zone' }],
    })
    const orphan = nodes.find((n) => n.id === 'orphan')
    expect(orphan).toBeDefined()
    expect(orphan.parentId).toBeUndefined()
  })

  it('keeps a loose node where it was left', () => {
    const { nodes } = buildLayout({
      zones: ZONES,
      nodes: [{ id: 'x', kind: 'source', name: 'x', zone: null, position: { x: 640, y: 900 } }],
    })
    expect(nodes.find((n) => n.id === 'x').position).toEqual({ x: 640, y: 900 })
  })

  it('handles a completely empty graph', () => {
    const { nodes, edges } = buildLayout({})
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })

  describe('minZoneSpan', () => {
    /* The empty canvas is a real starting point now -- someone with no token
       drags components straight onto seeded backdrops -- and a zone sized for its
       (zero) contents is a 264px box that fits one column. */
    it('gives an empty zone room for several components', () => {
      const withFloor = buildLayout(graph([]), { minZoneSpan: { columns: 4, rows: 2 } })
      const withoutFloor = buildLayout(graph([]))

      const width = (result, zone) => result.nodes.find((n) => n.id === zoneNodeId(zone)).width

      expect(width(withFloor, 'connections')).toBeGreaterThan(4 * NODE_WIDTH)
      expect(width(withFloor, 'connections')).toBeGreaterThan(width(withoutFloor, 'connections'))
      expect(withFloor.nodes.find((n) => n.id === zoneNodeId('unify')).height).toBeGreaterThan(
        2 * NODE_HEIGHT,
      )
    })

    it('is a floor, not a size: a full zone is still sized by its contents', () => {
      const many = Array.from({ length: 6 }, (_, index) =>
        node(`source:${index}`, 'source', 'connections'),
      )
      const floored = buildLayout(graph(many), { minZoneSpan: { columns: 4, rows: 2 } })
      const natural = buildLayout(graph(many))

      const zone = (result) => result.nodes.find((n) => n.id === zoneNodeId('connections'))
      expect(zone(floored).height).toBe(zone(natural).height)
    })

    it('does not apply to a zone that carries its own size', () => {
      /* The floor exists for a zone the layout sized. Folding it into an explicit
         size would silently refuse to let anyone make a region small. */
      const tiny = { ...ZONES[0], position: { x: 0, y: 0 }, width: 300, height: 120 }
      const { nodes } = buildLayout(
        { zones: [tiny], nodes: [], edges: [] },
        { minZoneSpan: { columns: 4, rows: 2 } },
      )
      expect(nodes[0].width).toBe(300)
      expect(nodes[0].height).toBe(120)
    })

    it('does not push zones apart when the floor does not apply', () => {
      /* Zones stack, so a taller Connections moves Unify down. A floor that
         changed spacing for a populated diagram would move every saved node's
         zone out from under it. */
      const many = Array.from({ length: 6 }, (_, index) =>
        node(`source:${index}`, 'source', 'connections'),
      )
      const y = (result, id) => result.nodes.find((n) => n.id === zoneNodeId(id)).position.y

      expect(y(buildLayout(graph(many), { minZoneSpan: { columns: 4, rows: 2 } }), 'unify')).toBe(
        y(buildLayout(graph(many)), 'unify'),
      )
    })
  })

  describe('stored and live zone geometry', () => {
    const custom = {
      id: 'custom:app',
      label: "Customer's app",
      order: 9,
      custom: true,
      position: { x: -400, y: 900 },
      width: 520,
      height: 240,
    }

    it('places a zone that carries its own geometry verbatim', () => {
      const { nodes } = buildLayout({ zones: [...ZONES, custom], nodes: [], edges: [] })
      const drawn = nodes.find((n) => n.id === zoneNodeId('custom:app'))

      expect(drawn.position).toEqual({ x: -400, y: 900 })
      expect(zoneSize(drawn)).toEqual({ width: 520, height: 240 })
      expect(drawn.data.custom).toBe(true)
    })

    it('keeps geometry out of data, where a stale copy could contradict the node', () => {
      const { nodes } = buildLayout({ zones: [custom], nodes: [], edges: [] })
      expect(nodes[0].data).not.toHaveProperty('width')
      expect(nodes[0].data).not.toHaveProperty('position')
    })

    it('lets live canvas geometry win over what the document stored', () => {
      /* The order that matters on a workspace refresh: /api/workspace/graph returns
         the three product zones with no geometry at all, so anything but
         live-first would snap a resized zone back to its computed size. */
      const { nodes } = buildLayout(
        { zones: [custom], nodes: [], edges: [] },
        { existingZones: { 'custom:app': { position: { x: 5, y: 6 }, width: 700, height: 300 } } },
      )

      expect(nodes[0].position).toEqual({ x: 5, y: 6 })
      expect(zoneSize(nodes[0])).toEqual({ width: 700, height: 300 })
    })

    it('still stacks the zones that have no geometry, clear of the placed one', () => {
      const placed = { ...ZONES[0], position: { x: 0, y: 0 }, width: 400, height: 600 }
      const { nodes } = buildLayout({ zones: [placed, ZONES[1]], nodes: [], edges: [] })
      const unify = nodes.find((n) => n.id === zoneNodeId('unify'))

      expect(unify.position.y).toBeGreaterThanOrEqual(600)
    })

    it('round-trips through captureZones', () => {
      const first = buildLayout({ zones: [...ZONES, custom], nodes: [], edges: [] })
      const resized = first.nodes.map((n) =>
        n.id === zoneNodeId('unify') ? { ...n, width: 999, height: 444 } : n,
      )
      const second = buildLayout(
        { zones: [...ZONES, custom], nodes: [], edges: [] },
        { existingZones: captureZones(resized) },
      )

      const unify = second.nodes.find((n) => n.id === zoneNodeId('unify'))
      expect(zoneSize(unify)).toEqual({ width: 999, height: 444 })
    })
  })

  describe('zoneDescriptor', () => {
    it('is the inverse of toZoneNode, minus the counted field', () => {
      const zone = {
        id: 'custom:warehouse',
        label: 'Snowflake',
        custom: true,
        color: '#0263e0',
        order: 4,
        position: { x: 100, y: 200 },
        width: 480,
        height: 220,
      }
      const [zoneNode] = buildLayout({ zones: [zone], nodes: [], edges: [] }).nodes

      expect(zoneDescriptor(zoneNode)).toEqual(zone)
    })
  })
})

describe('minZoneSize', () => {
  const child = (x, y, extra = {}) => ({
    id: `n${x}`,
    parentId: zoneNodeId('connections'),
    position: { x, y },
    ...extra,
  })

  it('has a floor for an empty zone, so it cannot be resized away entirely', () => {
    const { width, height } = minZoneSize(zoneNodeId('connections'), [])
    expect(width).toBeGreaterThan(NODE_WIDTH)
    expect(height).toBeGreaterThan(NODE_HEIGHT)
  })

  it('grows past the floor to cover the furthest child', () => {
    /* Without this, dragging a handle inward past a component would let
       `extent: 'parent'` yank it back -- the resize would silently move the
       diagram, and that rearrangement is what would get saved. */
    const { width, height } = minZoneSize(zoneNodeId('connections'), [child(900, 500)])
    expect(width).toBeGreaterThanOrEqual(900 + NODE_WIDTH)
    expect(height).toBeGreaterThanOrEqual(500 + NODE_HEIGHT)
  })

  it('measures each child rather than assuming the default size', () => {
    const measured = minZoneSize(zoneNodeId('connections'), [
      child(0, 0, { measured: { width: 800, height: 400 } }),
    ])
    expect(measured.width).toBeGreaterThanOrEqual(800)
    expect(measured.height).toBeGreaterThanOrEqual(400)
  })

  it('ignores components in other zones', () => {
    const other = { id: 'x', parentId: zoneNodeId('engage'), position: { x: 5000, y: 5000 } }
    expect(minZoneSize(zoneNodeId('connections'), [other])).toEqual(
      minZoneSize(zoneNodeId('connections'), []),
    )
  })
})

describe('toFlowEdge', () => {
  it('protects discovered edges from deletion but not hand-drawn ones', () => {
    /* An edge that came from the customer's workspace is a fact. Letting someone
       delete it would make the diagram silently disagree with reality. */
    expect(toFlowEdge({ id: 'e1', source: 'a', target: 'b', discovered: true }).deletable).toBe(
      false,
    )
    expect(toFlowEdge({ id: 'e2', source: 'a', target: 'b', discovered: false }).deletable).toBe(
      true,
    )
  })

  it('carries the pre/post phase through for the simulator', () => {
    const edge = toFlowEdge({ id: 'e', source: 'a', target: 'b', phase: 'post' })
    expect(edge.data.phase).toBe('post')
  })
})

describe('capturePositions', () => {
  it('snapshots component positions and skips zone backdrops', () => {
    const { nodes } = buildLayout(graph([node('source:a', 'source', 'connections')]))
    const positions = capturePositions(nodes)

    expect(Object.keys(positions)).toEqual(['source:a'])
    expect(positions['source:a']).toHaveProperty('x')
  })

  it('round-trips through buildLayout unchanged', () => {
    const first = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('audience:b', 'audience', 'engage')]),
    )
    const moved = first.nodes.map((n) =>
      n.type === 'zone' ? n : { ...n, position: { x: 10, y: 20 } },
    )
    const second = buildLayout(
      graph([node('source:a', 'source', 'connections'), node('audience:b', 'audience', 'engage')]),
      { existingPositions: capturePositions(moved) },
    )

    for (const n of second.nodes.filter((x) => x.type === 'segmentNode')) {
      expect(n.position).toEqual({ x: 10, y: 20 })
    }
  })
})

describe('growZones', () => {
  /* Hand-built rather than through buildLayout: the point of these is a zone that is
     already too small for what it holds, which buildLayout by construction never
     produces. CHILD_MARGIN is 20 and is not exported, so the expectations read the
     margin off the arithmetic rather than restating the constant. */
  const zone = (id, extra = {}) => ({
    id: zoneNodeId(id),
    type: 'zone',
    position: { x: 0, y: 0 },
    width: MIN_ZONE_WIDTH,
    height: MIN_ZONE_HEIGHT,
    data: { id },
    ...extra,
  })
  const child = (id, parent, position) => ({
    id,
    type: 'segmentNode',
    parentId: zoneNodeId(parent),
    position,
    data: { id, zone: parent },
  })

  it('grows a zone to cover a child dragged past its edge', () => {
    const grown = growZones([zone('connections'), child('a', 'connections', { x: 900, y: 40 })])
    const { width } = zoneSize(grown.find((n) => n.id === zoneNodeId('connections')))
    expect(width).toBeGreaterThanOrEqual(900 + NODE_WIDTH)
  })

  it('never shrinks a zone whose contents moved inward', () => {
    /* A zone larger than it needs to be is a size the user chose by dragging a handle.
       Tightening it up on the next drag would undo that, and the two cases are
       indistinguishable after the fact. */
    const wide = zone('connections', { width: 1200, height: 800 })
    const grown = growZones([wide, child('a', 'connections', { x: 10, y: 10 })])
    expect(zoneSize(grown.find((n) => n.id === zoneNodeId('connections')))).toEqual({
      width: 1200,
      height: 800,
    })
  })

  it('grows a parent from a sub-zone that has itself just grown', () => {
    /* Depth-first, and this is what depends on it: Profiles has to be grown by its own
       child before Unify measures Profiles. A single pass over the array in declaration
       order would leave Unify a frame behind on every drag. */
    const grown = growZones([
      zone('unify'),
      zone('profiles', { parentId: zoneNodeId('unify'), position: { x: 20, y: 40 } }),
      child('t', 'profiles', { x: 600, y: 30 }),
    ])
    const profiles = zoneSize(grown.find((n) => n.id === zoneNodeId('profiles')))
    const unify = zoneSize(grown.find((n) => n.id === zoneNodeId('unify')))
    expect(profiles.width).toBeGreaterThanOrEqual(600 + NODE_WIDTH)
    expect(unify.width).toBeGreaterThanOrEqual(20 + profiles.width)
  })

  it('returns the same array when nothing has to change', () => {
    /* Identity, not equality. This runs from a node-change handler on every drag frame,
       and a fresh array is a re-render of every node on the canvas. */
    const nodes = [zone('connections', { width: 1200, height: 800 })]
    expect(growZones(nodes)).toBe(nodes)
  })

  it('does not hang on a parent cycle', () => {
    const a = zone('a', { parentId: zoneNodeId('b') })
    const b = zone('b', { parentId: zoneNodeId('a') })
    expect(() => growZones([a, b])).not.toThrow()
  })
})

describe('orderForFlow', () => {
  const zone = (id, parent = null, size = null) => ({
    id: zoneNodeId(id),
    type: 'zone',
    ...(parent ? { parentId: zoneNodeId(parent) } : {}),
    ...(size ? { width: size.width, height: size.height } : {}),
    data: { id, parent },
  })
  const child = (id, parent) => ({
    id,
    type: 'segmentNode',
    parentId: zoneNodeId(parent),
    data: { id, zone: parent },
  })
  const ids = (nodes) => orderForFlow(nodes).map((entry) => entry.id)

  /* The reported bug: drop a zone onto a canvas that already has components, drag one
     in, and the component -- still at its old index -- precedes the zone it is now
     inside. React Flow reads the array once, so it reports the parent as missing and
     draws the child's zone-local position as though it were absolute. */
  it('puts a zone before a component that was on the canvas first', () => {
    expect(ids([child('a', 'engage'), zone('engage')])).toEqual(['zone-engage', 'a'])
  })

  it('orders a nested zone after the zone it is in, however they were added', () => {
    const nodes = [zone('unify', 'segment'), zone('segment'), child('a', 'unify')]
    expect(ids(nodes)).toEqual(['zone-segment', 'zone-unify', 'a'])
  })

  it('leaves siblings of the same size in the order they were given', () => {
    /* Two overlapping hand-drawn zones of one size: with nothing to choose between them,
       reordering would change which is drawn on top, and that is a visible edit nobody
       asked for. */
    const box = { width: 600, height: 300 }
    const nodes = [
      zone('custom:zone:b', null, box),
      zone('custom:zone:a', null, box),
      child('a', 'custom:zone:b'),
    ]
    expect(ids(nodes)).toEqual(['zone-custom:zone:b', 'zone-custom:zone:a', 'a'])
  })

  it('paints a bigger sibling behind a smaller one, whenever it was added', () => {
    /* The arrangement rule: drag a large zone over a small one and the small one stays on
       top and stays clickable. Array order is paint order among nodes at one z, and every
       zone is at one z, so this sort *is* the rule -- there is nowhere else it lives.

       Both orderings asserted, because a sort that happened to leave the input alone would
       satisfy either one on its own. */
    const big = zone('custom:zone:big', null, { width: 1200, height: 800 })
    const small = zone('custom:zone:small', null, { width: 300, height: 200 })

    expect(ids([small, big])).toEqual(['zone-custom:zone:big', 'zone-custom:zone:small'])
    expect(ids([big, small])).toEqual(['zone-custom:zone:big', 'zone-custom:zone:small'])
  })

  it('sorts on the size the drag has already committed, not the one last measured', () => {
    /* A resize writes `width` and `measured` catches up a frame later. Reading `measured`
       first re-sorts the canvas one frame behind the pointer, which shows up as a zone that
       flickers in front of the one it is being dragged over. */
    const shrunk = { ...zone('custom:zone:a', null, { width: 200, height: 100 }), measured: { width: 1200, height: 800 } }
    const other = zone('custom:zone:b', null, { width: 600, height: 300 })
    expect(ids([shrunk, other])).toEqual(['zone-custom:zone:b', 'zone-custom:zone:a'])
  })

  it('does not sort an unmeasured component to the front as though it were tiny', () => {
    /* Area 0 would sort last, which is on top -- so a card React Flow has not measured yet
       would come forward over everything it overlaps for a frame. */
    const unmeasured = { id: 'a', type: 'segmentNode', data: { id: 'a' } }
    const small = zone('custom:zone:small', null, { width: 120, height: 40 })
    expect(ids([unmeasured, small])).toEqual(['a', 'zone-custom:zone:small'])
  })

  it('returns the same array when it is already in order', () => {
    /* Identity, not equality. This runs on every canvas render, and a fresh array each
       time is a new prop for React Flow to diff every node against. */
    const nodes = [zone('engage'), child('a', 'engage')]
    expect(orderForFlow(nodes)).toBe(nodes)
  })

  it('keeps a node whose parent is absent rather than reparenting it to the root', () => {
    /* Dropping the link would move the node: its position is parent-relative. A node in
       this state is a bug upstream of here, and hiding it is not this function's job. */
    const orphan = child('a', 'engage')
    expect(orderForFlow([orphan])).toEqual([orphan])
  })

  it('does not hang on a parent cycle', () => {
    const a = { id: 'a', parentId: 'b' }
    const b = { id: 'b', parentId: 'a' }
    expect(() => orderForFlow([a, b])).not.toThrow()
  })

  it('handles an empty canvas and a missing list', () => {
    expect(orderForFlow([])).toEqual([])
    expect(orderForFlow(undefined)).toEqual([])
  })
})

describe('scaleZoneChildren', () => {
  const zone = (id, size, extra = {}) => ({
    id: zoneNodeId(id),
    type: 'zone',
    position: { x: 0, y: 0 },
    width: size.width,
    height: size.height,
    data: { id },
    ...extra,
  })
  const child = (id, parent, position) => ({
    id,
    type: 'segmentNode',
    parentId: zoneNodeId(parent),
    position,
    data: { id, zone: parent },
  })

  it('scales a child position by the same ratio the zone changed', () => {
    const nodes = [zone('connections', { width: 1000, height: 500 }), child('a', 'connections', { x: 400, y: 200 })]
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, { width: 500, height: 250 })
    expect(scaled.find((n) => n.id === 'a').position).toEqual({ x: 200, y: 100 })
  })

  it('leaves component sizes alone', () => {
    /* A 200x60 card at 60% is unreadable. What is being adjusted is the arrangement,
       not the type size. */
    const nodes = [
      zone('connections', { width: 1000, height: 500 }),
      { ...child('a', 'connections', { x: 400, y: 200 }), measured: { width: NODE_WIDTH, height: NODE_HEIGHT } },
    ]
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, { width: 500, height: 250 })
    const card = scaled.find((n) => n.id === 'a')
    expect(card.measured).toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT })
    expect(card.width).toBeUndefined()
  })

  it('scales a nested zone and its own contents with it', () => {
    /* A sub-zone that kept its width while its parent halved would hang out of it -- and
       leaving its components where they were would leave them hanging out of the smaller
       sub-zone. Both have to move, which is why this recurses. */
    const nodes = [
      zone('unify', { width: 1000, height: 600 }),
      zone('profiles', { width: 600, height: 400 }, {
        parentId: zoneNodeId('unify'),
        position: { x: 200, y: 100 },
      }),
      child('t', 'profiles', { x: 300, y: 200 }),
    ]
    const scaled = scaleZoneChildren(nodes, zoneNodeId('unify'), { width: 1000, height: 600 }, { width: 500, height: 300 })

    const profiles = scaled.find((n) => n.id === zoneNodeId('profiles'))
    expect(profiles.position).toEqual({ x: 100, y: 50 })
    expect(zoneSize(profiles)).toEqual({ width: 300, height: 200 })
    /* x is 80 rather than the 150 the ratio alone gives: Profiles ends up 300 wide and
       the card stays 200, so 80 is as far right as it can sit and still fit. The clamp
       is the other half of this -- scaling positions without it leaves the card
       overhanging a zone it was just scaled into. */
    expect(scaled.find((n) => n.id === 't').position).toEqual({ x: 80, y: 100 })
  })

  it('pulls a child that would overhang back inside the smaller zone', () => {
    const nodes = [
      zone('connections', { width: 1000, height: 500 }),
      { ...child('a', 'connections', { x: 700, y: 300 }), measured: { width: NODE_WIDTH, height: NODE_HEIGHT } },
    ]
    /* Fits before: 700 + 200 = 900, inside 1000. The scale takes x to 210, and 210 + 200
       is outside 300 -- the position shrank and the card did not. */
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, { width: 300, height: 200 })
    expect(scaled.find((n) => n.id === 'a').position).toEqual({ x: 80, y: 120 })
  })

  it('leaves growZones nothing to grow, so the shrink sticks', () => {
    /* The point of the clamp. Without it a shrink is undone by the next drag: growZones
       finds a child overhanging and snaps the zone back out, which is the "the resize
       floor is the contents" behaviour scaling exists to remove -- deferred to a later
       gesture, where it looks like the canvas fighting the user. */
    const nodes = [
      zone('connections', { width: 1000, height: 500 }),
      { ...child('a', 'connections', { x: 700, y: 300 }), measured: { width: NODE_WIDTH, height: NODE_HEIGHT } },
    ]
    const to = { width: 400, height: 250 }
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, to).map(
      (n) => (n.type === 'zone' ? { ...n, ...to } : n),
    )

    expect(growZones(scaled)).toBe(scaled)
  })

  it('still fits a card in a zone dragged down to the minimum', () => {
    /* The tight case, and it is tight: ZONE_PADDING_X 32 + NODE_WIDTH 200 + CHILD_MARGIN
       20 is 252, four pixels under MIN_ZONE_WIDTH. A card fits, but only just, so the
       arithmetic is pinned rather than left to be rediscovered. */
    const nodes = [
      zone('connections', { width: 1000, height: 500 }),
      { ...child('a', 'connections', { x: 700, y: 300 }), measured: { width: NODE_WIDTH, height: NODE_HEIGHT } },
    ]
    const to = { width: MIN_ZONE_WIDTH, height: MIN_ZONE_HEIGHT }
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, to)

    const pinned = scaled.map((n) => (n.type === 'zone' ? { ...n, ...to } : n))
    expect(scaled.find((n) => n.id === 'a').position).toEqual({ x: 40, y: 70 })
    expect(growZones(pinned)).toBe(pinned)
  })

  it('floors a nested zone at the minimum rather than scaling it to nothing', () => {
    const nodes = [
      zone('unify', { width: 1000, height: 600 }),
      zone('profiles', { width: 400, height: 300 }, { parentId: zoneNodeId('unify'), position: { x: 0, y: 0 } }),
    ]
    const scaled = scaleZoneChildren(nodes, zoneNodeId('unify'), { width: 1000, height: 600 }, { width: 100, height: 60 })
    expect(zoneSize(scaled.find((n) => n.id === zoneNodeId('profiles')))).toEqual({
      width: MIN_ZONE_WIDTH,
      height: MIN_ZONE_HEIGHT,
    })
  })

  it('is a no-op when the size did not change', () => {
    const nodes = [zone('connections', { width: 800, height: 400 }), child('a', 'connections', { x: 10, y: 10 })]
    expect(scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 800, height: 400 }, { width: 800, height: 400 })).toBe(nodes)
  })

  it('does not divide by a zero previous size', () => {
    const nodes = [zone('connections', { width: 0, height: 0 }), child('a', 'connections', { x: 10, y: 10 })]
    const scaled = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 0, height: 0 }, { width: 400, height: 200 })
    expect(scaled.find((n) => n.id === 'a').position).toEqual({ x: 10, y: 10 })
  })

  it('does not hang on a parent cycle', () => {
    const a = zone('a', { width: 500, height: 500 }, { parentId: zoneNodeId('b') })
    const b = zone('b', { width: 500, height: 500 }, { parentId: zoneNodeId('a') })
    expect(() =>
      scaleZoneChildren([a, b], zoneNodeId('a'), { width: 500, height: 500 }, { width: 250, height: 250 }),
    ).not.toThrow()
  })
})

/*
 * Component size. Two things are pinned here and neither is obvious from reading the
 * code: that the size lives under `data.size` and not `data.width` (serialize.js deletes
 * the latter, so storing it there loses every resize on save), and that an *absent* size
 * stays absent rather than being filled in with the default -- a card with a height
 * written into it can no longer grow with its own contents.
 */
describe('componentSize', () => {
  it('reads a raw document payload', () => {
    expect(componentSize({ id: 'a', size: { width: 320, height: 90 } })).toEqual({
      width: 320,
      height: 90,
    })
  })

  it('reads a React Flow node, so buildLayout can use it on either side of toFlowNode', () => {
    expect(componentSize({ id: 'a', data: { size: { width: 320, height: 90 } } })).toEqual({
      width: 320,
      height: 90,
    })
  })

  it('is nulls for a node nobody has resized, not the defaults', () => {
    expect(componentSize({ id: 'a' })).toEqual({ width: null, height: null })
    expect(componentSize(null)).toEqual({ width: null, height: null })
  })

  it('reports one axis when only one was chosen', () => {
    expect(componentSize({ size: { width: 320 } })).toEqual({ width: 320, height: null })
  })
})

describe('toFlowNode sizing', () => {
  it('gives React Flow explicit dimensions for a resized component', () => {
    const flow = toFlowNode(node('a', 'source', 'connections', { size: { width: 320, height: 90 } }), 'connections', { x: 0, y: 0 })
    expect(flow.width).toBe(320)
    expect(flow.height).toBe(90)
    expect(flow.data.size).toEqual({ width: 320, height: 90 })
  })

  it('leaves width and height off a component nobody has resized', () => {
    const flow = toFlowNode(node('a', 'source', 'connections'), 'connections', { x: 0, y: 0 })
    /* Not `toBeUndefined`: React Flow prefers a top-level width over everything else, so
       even a `width: undefined` key is safe but a defaulted one would freeze the card at
       NODE_WIDTH forever -- and `measured` would then agree with it. */
    expect('width' in flow).toBe(false)
    expect('height' in flow).toBe(false)
  })

  it('carries one axis alone', () => {
    const flow = toFlowNode(node('a', 'source', 'connections', { size: { width: 320 } }), 'connections', { x: 0, y: 0 })
    expect(flow.width).toBe(320)
    expect('height' in flow).toBe(false)
  })

  it('puts a component above every zone, wherever it is', () => {
    /* Including one on bare canvas: the working area outside the zones overlaps them once a
       zone is dragged across it, and a card there at a zone's own z would disappear under
       the backdrop with no way to click it back out. */
    expect(toFlowNode(node('a', 'source', 'connections'), 'connections', { x: 0, y: 0 }).zIndex).toBe(
      COMPONENT_Z,
    )
    expect(toFlowNode(node('a', 'source', null), null, { x: 0, y: 0 }).zIndex).toBe(COMPONENT_Z)
  })
})

describe('minZoneSize with resized components', () => {
  const child = (extra) => ({
    id: 'n',
    parentId: zoneNodeId('connections'),
    position: { x: 0, y: 0 },
    ...extra,
  })

  it('covers a component that was dragged wider', () => {
    const { width, height } = minZoneSize(zoneNodeId('connections'), [
      child({ data: { size: { width: 900, height: 400 } } }),
    ])
    expect(width).toBeGreaterThanOrEqual(900)
    expect(height).toBeGreaterThanOrEqual(400)
  })

  it('prefers the chosen size over a stale measurement', () => {
    /* The frame after a resize, `measured` still describes the old box. Reading it first
       would leave the zone one gesture behind the card it has to contain. */
    const { width } = minZoneSize(zoneNodeId('connections'), [
      child({ data: { size: { width: 900 } }, measured: { width: 200, height: 60 } }),
    ])
    expect(width).toBeGreaterThanOrEqual(900)
  })

  it('still falls back to the measurement on the axis that was not chosen', () => {
    const { height } = minZoneSize(zoneNodeId('connections'), [
      child({ data: { size: { width: 900 } }, measured: { width: 200, height: 400 } }),
    ])
    expect(height).toBeGreaterThanOrEqual(400)
  })
})

describe('buildLayout with resized components', () => {
  it('grows a zone to cover a restored position plus the resized card at it', () => {
    const built = buildLayout(graph([node('a', 'source', 'connections', { size: { width: 600, height: 200 } })]), {
      existingPositions: { a: { x: 400, y: 300 } },
    })
    const zone = built.nodes.find((entry) => entry.id === zoneNodeId('connections'))
    expect(zone.width).toBeGreaterThanOrEqual(400 + 600)
    expect(zone.height).toBeGreaterThanOrEqual(300 + 200)
  })
})

describe('droppedZoneSize', () => {
  it('gives Segment the full span, because it has to contain the others', () => {
    expect(droppedZoneSize('segment').width).toBe(4 * NODE_WIDTH + 3 * 90 + 64)
  })

  it('gives every other zone a quarter of that width', () => {
    const quarter = droppedZoneSize('unify')
    expect(quarter.width).toBe(Math.round(droppedZoneSize('segment').width / 4))
  })

  it('treats a custom zone like any other non-Segment zone', () => {
    /* Its id is minted at drop time (`custom:zone:<uuid>`), so this is the case a lookup
       table keyed by the known zone ids would silently miss. */
    expect(droppedZoneSize('custom:zone:9f2a1c04').width).toBe(droppedZoneSize('unify').width)
  })

  it('never drops below the width a zone needs for its own label', () => {
    expect(droppedZoneSize('unify').width).toBeGreaterThanOrEqual(MIN_ZONE_WIDTH)
  })

  it('leaves the height alone', () => {
    /* A quarter-height zone has no room for a component under its own label, and it was
       the width that was asked about. */
    expect(droppedZoneSize('unify').height).toBe(droppedZoneSize('segment').height)
    expect(droppedZoneSize('unify').height).toBeGreaterThanOrEqual(MIN_ZONE_HEIGHT)
  })
})

/*
 * The floor on how much a shrinking zone may crowd its own contents.
 *
 * Every case here has two children side by side, because that is the whole subject: with
 * one child there are no gaps to protect and the old behaviour -- scale, then clamp inside
 * the smaller box -- is exactly right, which is what the `scaleZoneChildren` cases above
 * pin. What was wrong was that the same arithmetic ran with several children and happily
 * took the gaps between them to nothing, leaving the connectors that had been drawn between
 * them with nowhere to be seen.
 */
describe('shrinking a zone without squashing its contents', () => {
  const zone = (id, size, extra = {}) => ({
    id: zoneNodeId(id),
    type: 'zone',
    position: { x: 0, y: 0 },
    ...size,
    data: { id },
    ...extra,
  })
  const sized = (id, parent, position, box = { width: NODE_WIDTH, height: NODE_HEIGHT }) => ({
    id,
    type: 'segmentNode',
    parentId: zoneNodeId(parent),
    position,
    data: { id, zone: parent, size: box },
  })

  /* Two 200-wide cards with a 200px gap: a lot of slack, so a modest shrink is honoured in
     full and a drastic one is not. */
  const pair = () => [
    zone('connections', { width: 1000, height: 400 }),
    sized('a', 'connections', { x: 0, y: 100 }),
    sized('b', 'connections', { x: 400, y: 100 }),
  ]

  const gapBetween = (nodes) => {
    const a = nodes.find((node) => node.id === 'a')
    const b = nodes.find((node) => node.id === 'b')
    return b.position.x - (a.position.x + NODE_WIDTH)
  }

  it('scales the gap while there is slack to give up', () => {
    const out = scaleZoneChildren(pair(), zoneNodeId('connections'), { width: 1000, height: 400 }, { width: 700, height: 400 })
    /* 400 * 0.7 = 280, so the gap goes 200 -> 80. Well clear of the floor, so the ratio is
       honoured exactly. */
    expect(out.find((node) => node.id === 'b').position.x).toBe(280)
    expect(gapBetween(out)).toBe(80)
  })

  it('stops scaling once the two cards are as close as the gap allows', () => {
    /* Dragged to a fifth of the width: the ratio alone would put b at 80, which is *inside*
       a. The floor holds the pair at MIN_CHILD_GAP apart instead. */
    const out = scaleZoneChildren(pair(), zoneNodeId('connections'), { width: 1000, height: 400 }, { width: 200, height: 400 })
    expect(gapBetween(out)).toBe(MIN_CHILD_GAP)
  })

  it('never lets the clamp finish the job the floor refused', () => {
    /* The clamp pulls an overhanging child back inside, and it clamps each child on its own
       -- so without a floor on the room it works against, both cards get pulled to the same
       limit and land on top of each other. That would undo the gap by a second route. */
    const out = scaleZoneChildren(pair(), zoneNodeId('connections'), { width: 1000, height: 400 }, { width: 150, height: 400 })
    expect(gapBetween(out)).toBeGreaterThanOrEqual(MIN_CHILD_GAP)
  })

  it('leaves a lone child clamped inside the smaller zone, as before', () => {
    /* The floor is about gaps between children. One child has none, so the old behaviour is
       unchanged and the shrink still sticks -- which is what keeps `growZones` from
       snapping the zone back out on the next drag. */
    const nodes = [
      zone('connections', { width: 1000, height: 500 }),
      sized('a', 'connections', { x: 700, y: 300 }),
    ]
    const to = { width: 300, height: 200 }
    const out = scaleZoneChildren(nodes, zoneNodeId('connections'), { width: 1000, height: 500 }, to)
    expect(out.find((node) => node.id === 'a').position.x).toBe(80)
    const pinned = out.map((node) => (node.type === 'zone' ? { ...node, ...to } : node))
    expect(growZones(pinned)).toBe(pinned)
  })

  it('does not push apart a pair the user placed closer than the gap', () => {
    /* A floor on crowding a *resize* introduces, not an opinion about a hand-made layout.
       Two cards deliberately touching stay touching. */
    const touching = [
      zone('connections', { width: 1000, height: 400 }),
      sized('a', 'connections', { x: 0, y: 100 }),
      sized('b', 'connections', { x: 200, y: 100 }),
    ]
    const out = scaleZoneChildren(touching, zoneNodeId('connections'), { width: 1000, height: 400 }, { width: 500, height: 400 })
    expect(gapBetween(out)).toBeLessThanOrEqual(0)
  })

  it('ignores a pair in different rows, which slide past each other freely', () => {
    /* Counting these as competing for the same span would floor a tall zone's width at the
       width of its widest row and stop most narrowing dead. */
    const rows = [
      zone('connections', { width: 1000, height: 600 }),
      sized('a', 'connections', { x: 0, y: 0 }),
      sized('b', 'connections', { x: 400, y: 300 }),
    ]
    const out = scaleZoneChildren(rows, zoneNodeId('connections'), { width: 1000, height: 600 }, { width: 400, height: 600 })
    expect(out.find((node) => node.id === 'b').position.x).toBe(160)
  })

  it('does not floor a zone being grown', () => {
    /* Spreading things out cannot make two of them harder to tell apart, and flooring both
       directions would stop a zone being widened past its tightest pair's ratio. */
    const out = scaleZoneChildren(pair(), zoneNodeId('connections'), { width: 1000, height: 400 }, { width: 2000, height: 400 })
    expect(out.find((node) => node.id === 'b').position.x).toBe(800)
  })
})

describe('scaleFloor', () => {
  const sized = (id, position, box = { width: 200, height: 60 }) => ({
    id,
    type: 'segmentNode',
    position,
    data: { id, size: box },
  })

  it('is 0 when nothing constrains the axis', () => {
    expect(scaleFloor([sized('a', { x: 0, y: 0 })], 'x')).toBe(0)
    expect(scaleFloor([], 'x')).toBe(0)
  })

  it('is the ratio at which the tightest side-by-side pair reaches the gap', () => {
    /* Origins 400 apart, first card 200 wide: the gap after scaling by f is 400f - 200, and
       that reaches MIN_CHILD_GAP at f = (200 + 24) / 400. */
    const floor = scaleFloor([sized('a', { x: 0, y: 0 }), sized('b', { x: 400, y: 0 })], 'x')
    expect(floor).toBeCloseTo((200 + MIN_CHILD_GAP) / 400)
  })

  it('never exceeds 1, so a floor can only ever limit a shrink', () => {
    const tight = [sized('a', { x: 0, y: 0 }), sized('b', { x: 210, y: 0 })]
    expect(scaleFloor(tight, 'x')).toBeLessThanOrEqual(1)
  })
})
