import { describe, expect, it } from 'vitest'

import { buildLayout } from '../canvas/layout.js'
import {
  countPlaceholders,
  graphFingerprint,
  isPlaceholder,
  positionsFromGraph,
  serializeEdge,
  serializeGraph,
  serializeNode,
  serializeZone,
  stableStringify,
  stripSecrets,
} from './serialize.js'

const ZONES = [
  { id: 'connections', label: 'Connections', order: 0 },
  { id: 'unify', label: 'Unify', order: 1 },
]

function flowNode(overrides = {}) {
  return {
    id: 'source:abc',
    type: 'segmentNode',
    position: { x: 32, y: 52 },
    parentId: 'zone-connections',
    extent: 'parent',
    zIndex: 1,
    selected: true,
    dragging: false,
    measured: { width: 200, height: 60 },
    data: { kind: 'source', name: 'Website', bound: true, segmentId: 'abc' },
    ...overrides,
  }
}

describe('serializeNode', () => {
  it('stores zone membership rather than the zone node id', () => {
    const node = serializeNode(flowNode())
    expect(node.zone).toBe('connections')
    expect(node.parentId).toBeUndefined()
    expect(node.extent).toBeUndefined()
  })

  it('drops React Flow runtime state', () => {
    const node = serializeNode(flowNode())
    for (const key of ['selected', 'dragging', 'measured', 'zIndex', 'type']) {
      expect(node[key], key).toBeUndefined()
    }
  })

  it('keeps the node payload', () => {
    const node = serializeNode(flowNode())
    expect(node).toMatchObject({
      id: 'source:abc',
      kind: 'source',
      name: 'Website',
      bound: true,
      segmentId: 'abc',
    })
  })

  it('rounds positions so a save is not a diff of sub-pixel noise', () => {
    const node = serializeNode(flowNode({ position: { x: 32.4999, y: 51.5 } }))
    expect(node.position).toEqual({ x: 32, y: 52 })
  })

  it('falls back to the payload zone when there is no parent', () => {
    const node = serializeNode(
      flowNode({ parentId: undefined, data: { kind: 'audience', zone: 'engage' } }),
    )
    expect(node.zone).toBe('engage')
  })

  /* Was a fallback to 'connections', from when a component had to be in some zone. A
     node with neither a parent nor a declared zone is now one in the working area, and
     writing a zone it is not in would relocate it on the next open. */
  it('records no zone when nothing says otherwise', () => {
    expect(serializeNode(flowNode({ parentId: undefined, data: {} })).zone).toBeNull()
  })

  it('handles a node with no data at all', () => {
    expect(serializeNode({ id: 'x', position: { x: 0, y: 0 } })).toMatchObject({ id: 'x' })
  })

  it('drops where the walkthrough’s playhead is', () => {
    /* Playing an event is not an edit. `graphFingerprint` reads node data, so an
       anchor left in would mark the document dirty for watching it -- and would then
       store one moment of a simulation in Postgres as if it were part of the
       diagram. */
    const playing = flowNode({
      data: { ...flowNode().data, anchor: 'step', anchorStep: { status: 'delivered' } },
    })
    const node = serializeNode(playing)
    expect(node.anchor).toBeUndefined()
    expect(node.anchorStep).toBeUndefined()
    expect(graphFingerprint({ nodes: [node] })).toBe(
      graphFingerprint({ nodes: [serializeNode(flowNode())] }),
    )
  })

  it('drops which scenarios are lighting the node up', () => {
    /* Same reason as the anchor, one level worse: `paths` changes on every tick of
       every run, so persisting it would rewrite the document several times a second
       while a walkthrough played. */
    const played = flowNode({
      data: {
        ...flowNode().data,
        paths: [{ scenarioId: 'p1', name: 'Orders', color: '#aa0000', status: 'delivered' }],
      },
    })
    const node = serializeNode(played)
    expect(node.paths).toBeUndefined()
    expect(graphFingerprint({ nodes: [node] })).toBe(
      graphFingerprint({ nodes: [serializeNode(flowNode())] }),
    )
  })
})

describe('stripSecrets', () => {
  it('removes secret-shaped keys anywhere in the tree', () => {
    const clean = stripSecrets({
      writeKey: 'live',
      nested: { apiKey: 'k', settings: { access_token: 't', region: 'us' } },
      list: [{ password: 'p', name: 'ok' }],
    })
    expect(clean).toEqual({
      nested: { settings: { region: 'us' } },
      list: [{ name: 'ok' }],
    })
  })

  it('keeps the masked fields, which are the intended display values', () => {
    expect(stripSecrets({ writeKeyMasked: '••••1234', writeKeyLast4: '1234' })).toEqual({
      writeKeyMasked: '••••1234',
      writeKeyLast4: '1234',
    })
  })

  it('is applied on the way out of serializeNode', () => {
    const node = serializeNode(
      flowNode({ data: { kind: 'source', writeKey: 'live_abc', writeKeyMasked: '••••abc' } }),
    )
    expect(node.writeKey).toBeUndefined()
    expect(node.writeKeyMasked).toBe('••••abc')
  })

  it('leaves non-objects alone', () => {
    expect(stripSecrets('token')).toBe('token')
    expect(stripSecrets(null)).toBe(null)
    expect(stripSecrets(7)).toBe(7)
  })
})

describe('serializeZone', () => {
  function zoneNode(overrides = {}) {
    return {
      id: 'zone-custom:app',
      type: 'zone',
      position: { x: 100.6, y: -40.2 },
      width: 520,
      height: 240,
      selected: true,
      data: { id: 'custom:app', label: "Customer's app", custom: true, order: 3, kindCount: 2 },
      ...overrides,
    }
  }

  it('reads geometry off the node, not out of data', () => {
    /* NodeResizer and the drag handler both write the node; neither touches
       `data`. Reading a copy from `data` would save the size the zone had when it
       was created rather than the one on screen. */
    const zone = serializeZone(zoneNode())
    expect(zone).toMatchObject({ width: 520, height: 240, position: { x: 101, y: -40 } })
  })

  it('keeps the meaning and drops the counted field', () => {
    const zone = serializeZone(zoneNode())
    expect(zone).toMatchObject({ id: 'custom:app', label: "Customer's app", custom: true, order: 3 })
    expect(zone.kindCount).toBeUndefined()
  })

  it('recovers the zone id from the node id when data has none', () => {
    const zone = serializeZone(zoneNode({ data: { label: 'Legacy' } }))
    expect(zone.id).toBe('custom:app')
  })

  it('falls back to style, for a zone that has never been through NodeResizer', () => {
    const zone = serializeZone(zoneNode({ width: undefined, height: undefined, style: { width: 300, height: 180 } }))
    expect(zone).toMatchObject({ width: 300, height: 180 })
  })
})

describe('serializeGraph', () => {
  const nodes = [
    {
      id: 'zone-connections',
      type: 'zone',
      position: { x: 0, y: 0 },
      width: 800,
      height: 300,
      data: { id: 'connections', label: 'Connections', order: 0 },
    },
    flowNode(),
    flowNode({ id: 'destination:xyz', data: { kind: 'destination', name: 'Braze' } }),
  ]

  it('splits zone backdrops out of nodes rather than discarding them', () => {
    /* `nodes` has to keep meaning "components" -- validate_architecture,
       node_count and countPlaceholders all read it without filtering -- but a
       custom zone cannot be regenerated from the topology, so it has to be
       stored somewhere. */
    const graph = serializeGraph({ nodes, edges: [] })
    expect(graph.nodes.map((n) => n.id)).toEqual(['source:abc', 'destination:xyz'])
    expect(graph.zones.map((z) => z.id)).toEqual(['connections'])
  })

  it('emits an empty zones array rather than omitting the key', () => {
    /* Absent means "saved before zones were part of the document", and buildLayout
       falls back to the topology for those. An empty array has to be able to mean
       "the user deleted them all". */
    expect(serializeGraph({ nodes: [flowNode()], edges: [] }).zones).toEqual([])
  })

  it('keeps edges between surviving nodes', () => {
    const graph = serializeGraph({
      nodes,
      edges: [
        { id: 'e1', source: 'source:abc', target: 'destination:xyz', data: { discovered: true } },
      ],
    })
    expect(graph.edges).toEqual([
      { id: 'e1', source: 'source:abc', target: 'destination:xyz', phase: null, discovered: true },
    ])
  })

  it('drops an edge whose endpoint is not on the canvas', () => {
    const graph = serializeGraph({
      nodes,
      edges: [{ id: 'e1', source: 'source:abc', target: 'ghost' }],
    })
    expect(graph.edges).toEqual([])
  })

  it('omits the viewport when there is none rather than writing a default one', () => {
    expect(serializeGraph({ nodes, edges: [] }).viewport).toBeUndefined()
  })

  it('rounds the viewport', () => {
    const graph = serializeGraph({
      nodes: [],
      edges: [],
      viewport: { x: -120.7, y: 40.2, zoom: 0.7512345 },
    })
    expect(graph.viewport).toEqual({ x: -121, y: 40, zoom: 0.751 })
  })

  it('accepts being called with nothing', () => {
    expect(serializeGraph()).toEqual({ nodes: [], edges: [], zones: [] })
  })

  describe('scenarios', () => {
    const path = {
      id: 'path:1',
      name: 'Orders, function off',
      color: '#0263e0',
      sourceId: 'source:abc',
      event: { type: 'track', event: 'Order Completed', properties: { revenue: 42 } },
      functionBehaviour: { 'fn:1': 'drop' },
      disabled: ['fn:1'],
    }

    it('stores a saved path whole', () => {
      expect(serializeGraph({ nodes, edges: [], scenarios: [path] }).scenarios).toEqual([path])
    })

    it('omits the key entirely when there are none', () => {
      /* Unlike `zones`, absent and empty mean the same thing here -- nothing falls
         back on the distinction -- so emitting `scenarios: []` would add a field to
         every diagram that never touches the walkthrough. */
      expect(serializeGraph({ nodes, edges: [] })).not.toHaveProperty('scenarios')
    })

    it('strips a secret out of an event the user typed', () => {
      /* A scenario's event is a payload someone wrote by hand, so `api_key` is a
         property they can put there. The server strips it on write regardless; doing
         it here too means what gets saved is what the client believes it saved. */
      const graph = serializeGraph({
        nodes,
        edges: [],
        scenarios: [{ ...path, event: { ...path.event, properties: { api_key: 'sk_live_1' } } }],
      })
      expect(graph.scenarios[0].event.properties).toEqual({})
      expect(JSON.stringify(graph)).not.toContain('sk_live_1')
    })

    it('marks the document dirty for renaming a path', () => {
      /* Saved paths are documentation of the architecture, so losing one to a
         navigation with no warning is losing work -- the unsaved-changes guard reads
         the fingerprint. */
      expect(graphFingerprint(serializeGraph({ nodes, edges: [], scenarios: [path] }))).not.toBe(
        graphFingerprint(
          serializeGraph({ nodes, edges: [], scenarios: [{ ...path, name: 'Renamed' }] }),
        ),
      )
    })

    it('is not marked dirty by playing one', () => {
      /* The whole of the playback state lives in RUNTIME_NODE_KEYS, so a diagram
         mid-walkthrough must fingerprint identically to the same diagram at rest. */
      const playing = nodes.map((node) =>
        node.type === 'zone'
          ? node
          : {
              ...node,
              data: {
                ...node.data,
                paths: [{ scenarioId: 'path:1', color: '#0263e0', status: 'delivered' }],
                anchor: 'step',
                anchorStep: { nodeId: node.id, status: 'delivered' },
              },
            },
      )
      expect(graphFingerprint(serializeGraph({ nodes: playing, edges: [], scenarios: [path] }))).toBe(
        graphFingerprint(serializeGraph({ nodes, edges: [], scenarios: [path] })),
      )
    })
  })

  describe('the collapse state', () => {
    it('stores the folded-away group keys', () => {
      const graph = serializeGraph({ nodes, edges: [], collapsed: ['destination:CRM'] })
      expect(graph.collapsed).toEqual(['destination:CRM'])
    })

    it('sorts them, so ticking two groups in either order is one document', () => {
      const one = serializeGraph({ nodes, edges: [], collapsed: ['source:swift', 'audience'] })
      const other = serializeGraph({ nodes, edges: [], collapsed: ['audience', 'source:swift'] })
      expect(one.collapsed).toEqual(['audience', 'source:swift'])
      expect(graphFingerprint(one)).toBe(graphFingerprint(other))
    })

    it('omits the key entirely when nothing is collapsed', () => {
      /* Every diagram saved before grouping existed. Emitting `collapsed: []` would
         change its fingerprint, so all of them would open with the unsaved-changes
         dot already lit and nag to save a diagram nobody touched. */
      expect(serializeGraph({ nodes, edges: [] })).not.toHaveProperty('collapsed')
      expect(graphFingerprint(serializeGraph({ nodes, edges: [] }))).toBe(
        graphFingerprint(serializeGraph({ nodes, edges: [], collapsed: [] })),
      )
    })

    it('marks the document dirty for collapsing a group', () => {
      /* Not an edit -- no component changes -- but arranging a diagram so a customer
         can follow it is the work this tool is for, and losing it to a navigation
         with no warning is losing work. */
      expect(graphFingerprint(serializeGraph({ nodes, edges: [] }))).not.toBe(
        graphFingerprint(serializeGraph({ nodes, edges: [], collapsed: ['destination:CRM'] })),
      )
    })

    it('does not mutate the array it was handed', () => {
      const collapsed = ['source:swift', 'audience']
      serializeGraph({ nodes, edges: [], collapsed })
      expect(collapsed).toEqual(['source:swift', 'audience'])
    })
  })
})

describe('the round trip', () => {
  it('preserves hand-placed positions through save and load', () => {
    /* The requirement this whole module exists for: without positionsFromGraph,
       loading re-runs the column layout and every manual arrangement is lost --
       which is indistinguishable from the save having failed. */
    const built = buildLayout({
      zones: ZONES,
      nodes: [
        { id: 'source:a', kind: 'source', zone: 'connections', name: 'A' },
        { id: 'space:s', kind: 'space', zone: 'unify', name: 'S' },
      ],
      edges: [],
    })

    const moved = built.nodes.map((node) =>
      node.id === 'source:a' ? { ...node, position: { x: 500, y: 300 } } : node,
    )

    const saved = serializeGraph({ nodes: moved, edges: [] })
    const reloaded = buildLayout(
      { zones: ZONES, ...saved },
      { existingPositions: positionsFromGraph(saved) },
    )

    const node = reloaded.nodes.find((n) => n.id === 'source:a')
    expect(node.position).toEqual({ x: 500, y: 300 })
    expect(node.parentId).toBe('zone-connections')
  })

  it('survives a second round trip unchanged', () => {
    const built = buildLayout({
      zones: ZONES,
      nodes: [{ id: 'source:a', kind: 'source', zone: 'connections', name: 'A' }],
      edges: [],
    })
    const once = serializeGraph({ nodes: built.nodes, edges: built.edges })
    const twice = serializeGraph(
      buildLayout({ zones: ZONES, ...once }, { existingPositions: positionsFromGraph(once) }),
    )
    expect(twice).toEqual(once)
  })

  it('keeps every node in its zone across the trip', () => {
    const saved = serializeGraph(
      buildLayout({
        zones: ZONES,
        nodes: [
          { id: 'a', kind: 'source', zone: 'connections', name: 'A' },
          { id: 'b', kind: 'computed_trait', zone: 'unify', name: 'B' },
        ],
        edges: [],
      }),
    )
    expect(saved.nodes.map((n) => [n.id, n.zone])).toEqual([
      ['a', 'connections'],
      ['b', 'unify'],
    ])
  })

  it('preserves a resized and moved zone', () => {
    const built = buildLayout({ zones: ZONES, nodes: [], edges: [] })
    const arranged = built.nodes.map((node) =>
      node.id === 'zone-unify'
        ? { ...node, position: { x: 1200, y: -300 }, width: 640, height: 210 }
        : node,
    )

    const saved = serializeGraph({ nodes: arranged, edges: [] })
    /* No `existingZones`: reloading a saved diagram is exactly the case where the
       live canvas has nothing to say, so the stored geometry has to carry it. */
    const reloaded = buildLayout(saved)
    const unify = reloaded.nodes.find((n) => n.id === 'zone-unify')

    expect(unify.position).toEqual({ x: 1200, y: -300 })
    expect(unify.width).toBe(640)
    expect(unify.height).toBe(210)
  })

  it('preserves a custom zone the topology has never heard of, and its contents', () => {
    const built = buildLayout({
      zones: [
        ...ZONES,
        {
          id: 'custom:warehouse',
          label: 'Snowflake',
          custom: true,
          order: 9,
          position: { x: 0, y: 1400 },
          width: 500,
          height: 200,
        },
      ],
      nodes: [
        { id: 'wh:1', kind: 'custom', zone: 'custom:warehouse', name: 'Orders table', bound: true },
      ],
      edges: [],
    })

    const saved = serializeGraph({ nodes: built.nodes, edges: [] })
    const twice = serializeGraph(
      buildLayout(saved, { existingPositions: positionsFromGraph(saved) }),
    )

    expect(twice).toEqual(saved)
    expect(twice.zones.find((z) => z.id === 'custom:warehouse')).toMatchObject({
      label: 'Snowflake',
      custom: true,
    })
    expect(twice.nodes[0].zone).toBe('custom:warehouse')
  })
})

describe('graphFingerprint', () => {
  it('ignores key order, which is what makes it usable across the wire', () => {
    /* Postgres returns JSON with its own key order. A plain JSON.stringify
       comparison would mark every freshly-opened diagram as unsaved. */
    const a = { nodes: [{ id: 'n', kind: 'source', name: 'A' }], edges: [] }
    const b = { nodes: [{ name: 'A', id: 'n', kind: 'source' }], edges: [] }
    expect(graphFingerprint(a)).toBe(graphFingerprint(b))
  })

  it('ignores node and edge order', () => {
    const a = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }
    const b = { nodes: [{ id: 'b' }, { id: 'a' }], edges: [] }
    expect(graphFingerprint(a)).toBe(graphFingerprint(b))
  })

  it('ignores the viewport, because panning is not an edit', () => {
    const nodes = [{ id: 'a' }]
    expect(graphFingerprint({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } })).toBe(
      graphFingerprint({ nodes, edges: [], viewport: { x: -900, y: 40, zoom: 0.3 } }),
    )
  })

  it('notices a moved node', () => {
    expect(graphFingerprint({ nodes: [{ id: 'a', position: { x: 0, y: 0 } }] })).not.toBe(
      graphFingerprint({ nodes: [{ id: 'a', position: { x: 1, y: 0 } }] }),
    )
  })

  it('notices a binding', () => {
    expect(graphFingerprint({ nodes: [{ id: 'a', bound: false }] })).not.toBe(
      graphFingerprint({ nodes: [{ id: 'a', bound: true, segmentId: 'x' }] })
    )
  })

  it('notices a new edge', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    expect(graphFingerprint({ nodes, edges: [] })).not.toBe(
      graphFingerprint({ nodes, edges: [{ id: 'e', source: 'a', target: 'b' }] }),
    )
  })

  it('notices a resized zone', () => {
    /* The unsaved-changes guard reads this. Without zones in the fingerprint, an
       arrangement someone spent time on could be lost by navigating away with no
       warning at all. */
    const nodes = [{ id: 'a' }]
    expect(
      graphFingerprint({ nodes, edges: [], zones: [{ id: 'unify', width: 600, height: 200 }] }),
    ).not.toBe(
      graphFingerprint({ nodes, edges: [], zones: [{ id: 'unify', width: 900, height: 200 }] }),
    )
  })

  it('notices a moved zone', () => {
    const nodes = [{ id: 'a' }]
    expect(
      graphFingerprint({ nodes, edges: [], zones: [{ id: 'unify', position: { x: 0, y: 0 } }] }),
    ).not.toBe(
      graphFingerprint({ nodes, edges: [], zones: [{ id: 'unify', position: { x: 0, y: 40 } }] }),
    )
  })

  it('ignores zone order', () => {
    const nodes = []
    const a = [{ id: 'unify' }, { id: 'engage' }]
    expect(graphFingerprint({ nodes, zones: a })).toBe(
      graphFingerprint({ nodes, zones: [...a].reverse() }),
    )
  })

  it('treats an absent field and an undefined one as the same', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it('sorts nested keys too', () => {
    expect(stableStringify({ s: { b: 1, a: 2 } })).toBe(stableStringify({ s: { a: 2, b: 1 } }))
  })

  it('survives a graph that is null', () => {
    expect(graphFingerprint(null)).toBe(graphFingerprint({ nodes: [], edges: [] }))
  })
})

describe('positionsFromGraph', () => {
  it('ignores nodes with no position', () => {
    expect(
      positionsFromGraph({ nodes: [{ id: 'a' }, { id: 'b', position: { x: 1, y: 2 } }] }),
    ).toEqual({ b: { x: 1, y: 2 } })
  })

  it('tolerates an empty or absent graph', () => {
    expect(positionsFromGraph(null)).toEqual({})
    expect(positionsFromGraph({})).toEqual({})
  })
})

describe('placeholder counting', () => {
  it('counts unbound nodes', () => {
    expect(isPlaceholder({ data: { bound: false } })).toBe(true)
    expect(isPlaceholder({ data: { bound: true } })).toBe(false)
  })

  it('excludes nodes that cannot be bound at all', () => {
    /* A journey has no Public API resource. Counting it leaves a banner that no
       amount of binding can clear. */
    expect(isPlaceholder({ data: { bound: false, bindable: false } })).toBe(false)
  })

  it('treats a node with no opinion as a placeholder', () => {
    expect(isPlaceholder({ data: {} })).toBe(true)
  })

  it('reads flat nodes as well as React Flow ones', () => {
    expect(isPlaceholder({ bound: false })).toBe(true)
  })

  it('ignores zone backdrops', () => {
    const nodes = [
      { id: 'z', type: 'zone', data: {} },
      { id: 'a', data: { bound: false } },
      { id: 'b', data: { bound: true } },
      { id: 'c', data: { bound: false, bindable: false } },
    ]
    expect(countPlaceholders(nodes)).toBe(1)
  })

  it('handles an empty canvas', () => {
    expect(countPlaceholders([])).toBe(0)
    expect(countPlaceholders(undefined)).toBe(0)
  })
})

describe('serializeEdge', () => {
  it('defaults discovered to false, so a hand-drawn edge stays deletable', () => {
    expect(serializeEdge({ id: 'e', source: 'a', target: 'b' })).toEqual({
      id: 'e',
      source: 'a',
      target: 'b',
      phase: null,
      discovered: false,
    })
  })

  it('carries the pipeline phase through', () => {
    expect(serializeEdge({ id: 'e', source: 'a', target: 'b', data: { phase: 'post' } }).phase).toBe(
      'post',
    )
  })

  it('drops the walkthrough’s coloured overlays', () => {
    /* This one is safe by construction -- serializeEdge is a whitelist, not a
       subtraction -- and the assertion is here so that turning it into a spread (the
       obvious "simplification") fails loudly instead of writing one tick of a
       simulation into the stored edge. */
    const edge = serializeEdge({
      id: 'e',
      source: 'a',
      target: 'b',
      data: { paths: [{ scenarioId: 'p1', color: '#aa0000', status: 'active' }] },
    })
    expect(edge.paths).toBeUndefined()
    expect(Object.keys(edge).sort()).toEqual(['discovered', 'id', 'phase', 'source', 'target'])
  })
})
