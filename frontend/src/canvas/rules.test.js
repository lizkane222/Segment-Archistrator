/*
 * Client-side rule enforcement.
 *
 * The topology fixture here is a hand-written subset of what /api/meta/topology
 * returns. It is deliberately NOT the full table: these tests check that the
 * functions read the payload correctly, and the Python suite checks that the
 * payload says the right things. Duplicating the real table here would just mean
 * two copies to update.
 */

import { describe, expect, it } from 'vitest'

import {
  absolutePosition,
  absolutePositions,
  attachTargetFor,
  centreOf,
  explainMisplacement,
  explainRejection,
  isDescendant,
  isValidPlacement,
  makeConnectionValidator,
  placementZones,
  reparentTarget,
  toZoneLocal,
  zoneAtPosition,
  zoneLabel,
  zoneOfParent,
  zoneOrigin,
} from './rules.js'

const TOPOLOGY = {
  /* Nested, because the ancestor walk is the part most worth testing: Profiles sits
     inside Unify, and the three products sit inside Segment. */
  zones: [
    { id: 'segment', label: 'Segment', order: 0, parent: null },
    { id: 'connections', label: 'Connections', order: 1, parent: 'segment' },
    /* A sub-zone that is *not* a subdivision, so the ascent has something to be
       narrow about. Protocols is the real one: a product of its own that happens to
       sit inside Connections. */
    { id: 'protocols', label: 'Protocols', order: 2, parent: 'connections' },
    { id: 'unify', label: 'Unify', order: 3, parent: 'segment' },
    { id: 'profiles', label: 'Profiles', order: 4, parent: 'unify', subdivision: true },
    {
      id: 'profile_sources',
      label: 'Profile Sources',
      order: 5,
      parent: 'unify',
      subdivision: true,
    },
    { id: 'engage', label: 'Engage', order: 6, parent: 'segment' },
  ],
  kinds: {
    source: {
      label: 'Source',
      zone: 'connections',
      allowedTargets: ['destination_filter', 'destination'],
    },
    destination_filter: {
      label: 'Destination Filter',
      zone: 'connections',
      allowedTargets: ['destination'],
    },
    destination: { label: 'Destination', zone: 'connections', allowedTargets: [] },
    warehouse: { label: 'Warehouse', zone: 'connections', allowedTargets: [] },
    space: { label: 'Space', zone: 'unify', allowedTargets: ['computed_trait', 'audience'] },
    computed_trait: { label: 'Computed Trait', zone: 'unify', allowedTargets: ['audience'] },
    profile: { label: 'Profile', zone: 'profiles', allowedTargets: [] },
    profile_source: { label: 'Profile Source', zone: 'profile_sources', allowedTargets: [] },
    tracking_plan: { label: 'Tracking Plan', zone: 'protocols', allowedTargets: ['source'] },
    audience: { label: 'Audience', zone: 'engage', allowedTargets: ['destination'] },
  },
  kindsByZone: {
    connections: ['source', 'destination_filter', 'destination', 'warehouse'],
    protocols: ['tracking_plan'],
    unify: ['space', 'computed_trait'],
    profiles: ['profile'],
    profile_sources: ['profile_source'],
    engage: ['audience'],
  },
}

const flowNode = (id, kind) => ({ id, type: 'segmentNode', data: { kind } })

/* The zone *descriptor* -- a zone node's `data` -- which is what isValidPlacement
   and explainMisplacement take. Never a bare id: a custom zone's answer depends on
   its `custom` flag, and a signature accepting either would silently treat a
   forgotten `.data` as an unknown zone and refuse every drop into it.

   Read out of the fixture rather than built from the id, so the descriptor carries
   the `parent` link `zoneChain` starts from. Built by hand, every sub-zone would look
   like a root and the nesting assertions below would pass vacuously. */
const zone = (id, extra = {}) => ({
  ...(TOPOLOGY.zones.find((entry) => entry.id === id) ?? { id, label: zoneLabel(TOPOLOGY, id) }),
  ...extra,
})

describe('zoneOfParent', () => {
  it('extracts the zone id from a group node id', () => {
    expect(zoneOfParent('zone-unify')).toBe('unify')
  })

  it('returns null for anything that is not a zone parent', () => {
    expect(zoneOfParent('source:abc')).toBeNull()
    expect(zoneOfParent(undefined)).toBeNull()
  })
})

describe('isValidPlacement', () => {
  it('accepts a kind in its own zone', () => {
    expect(isValidPlacement(TOPOLOGY, 'source', zone('connections'))).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'audience', zone('engage'))).toBe(true)
  })

  it('refuses the specific misplacement the brief calls out', () => {
    // A Unify component must not be droppable into the Connections pipeline.
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', zone('connections'))).toBe(false)
  })

  it('refuses an unknown kind rather than defaulting it somewhere', () => {
    expect(isValidPlacement(TOPOLOGY, 'not_a_kind', zone('connections'))).toBe(false)
  })

  it('accepts anything at all in a custom zone', () => {
    /* A custom zone is somewhere outside Segment -- the customer's app, a warehouse
       they own -- so Segment's pipeline zones have no jurisdiction there. */
    const outside = zone('custom:app', { label: "Customer's app", custom: true })
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', outside)).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'audience', outside)).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'custom', outside)).toBe(true)
  })

  it('still refuses a misplacement in a product zone, so the relaxation stays narrow', () => {
    /* The assertion that matters: if `custom` leaked into the product zones the
       whole segregation rule would be gone and no other test would notice. */
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', zone('connections', { custom: false }))).toBe(
      false,
    )
  })

  it('accepts a rule-free kind in a product zone too', () => {
    /* A warehouse the customer runs is a real destination *and* a thing outside
       Segment. Refusing it in Connections would force a custom zone for a component
       that legitimately belongs in the pipeline. */
    expect(isValidPlacement(TOPOLOGY, 'custom', zone('connections'))).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'custom', zone('unify'))).toBe(true)
  })

  it('refuses when there is no zone at all', () => {
    expect(isValidPlacement(TOPOLOGY, 'source', null)).toBe(false)
    expect(isValidPlacement(TOPOLOGY, 'source', undefined)).toBe(false)
  })

  it('accepts a kind in a sub-zone of the zone it belongs to', () => {
    /* Zones nest now. A computed trait belongs in Unify, and Unify's Profiles
       sub-zone is still inside Unify -- so refusing it there would make the sub-zones
       undroppable for everything but the one kind whose `zone` names them. */
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', zone('profiles'))).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', zone('unify'))).toBe(true)
  })

  it('refuses a kind in a zone that merely contains its own', () => {
    /* Ancestors, never descendants: the direction of the walk *is* the constraint. A
       warehouse in Unify is refused although both are inside Segment, which is the
       assertion that fails if the walk ever becomes total.

       The Segment backdrop used to be the second example here and is now excepted
       outright -- see the CONTAINER_ZONES describe below. It was never the case this
       test was about: the backdrop is excepted because it holds products, not because
       the walk reaches it. */
    expect(isValidPlacement(TOPOLOGY, 'warehouse', zone('unify'))).toBe(false)
    expect(isValidPlacement(TOPOLOGY, 'warehouse', zone('connections'))).toBe(true)
  })

  it('accepts a kind in the product zone its home merely subdivides', () => {
    /* The reported symptom, from the other side: the console filled up with "Profile
       belongs in Profiles, not Unify" every time one was dropped on the Unify
       backdrop. Profiles is an optional box -- a diagram may not draw it at all -- so
       the warning named a zone that need not exist, about a component that was filed
       correctly. */
    expect(isValidPlacement(TOPOLOGY, 'profile', zone('unify'))).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'profile_source', zone('unify'))).toBe(true)
  })

  it('stops the ascent at the product and refuses the move sideways', () => {
    /* Profiles and Profile Sources are siblings inside Unify, so a rule that ascended
       and then descended would make a profile legal in Profile Sources. That is the one
       misfiling among the subdivisions that is real, and it is what this asserts.

       That the ascent stops below Segment is no longer observable through this
       function, since the backdrop is excepted for a different reason -- it is still
       observable through `placementZones`, which is asserted directly below. */
    expect(placementZones(TOPOLOGY, 'profile')).not.toContain('segment')
    expect(isValidPlacement(TOPOLOGY, 'profile', zone('profile_sources'))).toBe(false)
    expect(isValidPlacement(TOPOLOGY, 'profile_source', zone('profiles'))).toBe(false)
  })

  it('does not let a sub-zone that is not a subdivision ascend', () => {
    /* Protocols carries no `subdivision` flag, and that is the whole difference: a
       tracking plan in bare Connections stays refused, which is what keeps the flag
       meaning something rather than being true of every sub-zone. */
    expect(isValidPlacement(TOPOLOGY, 'tracking_plan', zone('protocols'))).toBe(true)
    expect(isValidPlacement(TOPOLOGY, 'tracking_plan', zone('connections'))).toBe(false)
    expect(isValidPlacement(TOPOLOGY, 'source', zone('protocols'))).toBe(true)
  })

  it('refuses rather than hanging on a zone tree that is its own ancestor', () => {
    /* The chain is walked on every drag frame, so a table with a cycle in it has to
       fail a test rather than lock the tab up. */
    const looped = {
      ...TOPOLOGY,
      zones: [
        { id: 'a', label: 'A', parent: 'b' },
        { id: 'b', label: 'B', parent: 'a' },
      ],
    }
    expect(isValidPlacement(looped, 'source', { id: 'a', label: 'A', parent: 'b' })).toBe(false)
  })
})

describe('placementZones', () => {
  it('lists the home first and then what it subdivides', () => {
    /* Order is part of the contract: innermost first, matching zone_chain, so the
       first entry is still the answer to "where does this go by default". */
    expect(placementZones(TOPOLOGY, 'profile')).toEqual(['profiles', 'unify'])
    expect(placementZones(TOPOLOGY, 'computed_trait')).toEqual(['unify'])
    expect(placementZones(TOPOLOGY, 'tracking_plan')).toEqual(['protocols'])
  })

  it('is empty for a kind the topology has never heard of', () => {
    expect(placementZones(TOPOLOGY, 'not_a_kind')).toEqual([])
    expect(placementZones(null, 'profile')).toEqual([])
  })

  it('terminates on a subdivision loop instead of climbing forever', () => {
    /* Walked on every drag frame like zoneChain, and a hand-written table is one typo
       from a cycle -- with `subdivision` on both ends of it, which zoneChain's own
       guard would never see because this walk does not go through zoneChain. */
    const looped = {
      ...TOPOLOGY,
      zones: [
        { id: 'a', label: 'A', parent: 'b', subdivision: true },
        { id: 'b', label: 'B', parent: 'a', subdivision: true },
      ],
      kinds: { ...TOPOLOGY.kinds, thing: { label: 'Thing', zone: 'a', allowedTargets: [] } },
    }
    expect(placementZones(looped, 'thing')).toEqual(['a', 'b'])
  })
})

describe('makeConnectionValidator', () => {
  const nodes = [
    flowNode('s1', 'source'),
    flowNode('f1', 'destination_filter'),
    flowNode('d1', 'destination'),
    { id: 'zone-connections', type: 'zone', data: { id: 'connections' } },
  ]
  const getNode = (id) => nodes.find((n) => n.id === id)

  const validator = (edges = []) => makeConnectionValidator({ topology: TOPOLOGY, getNode, edges })

  it('permits a legal connection', () => {
    expect(validator()({ source: 's1', target: 'f1' })).toBe(true)
  })

  it('permits any pair of kinds, not just an adjacent one', () => {
    /* The allowlist is gone: a diagram may draw any component into any other, in
       either direction. */
    expect(validator()({ source: 'd1', target: 's1' })).toBe(true)
  })

  it('permits a self-connection', () => {
    /* Each node has exactly one fixed target handle and one fixed source handle, so
       drawing one back to itself is deliberate and there is no rule left to refuse
       it by. */
    expect(validator()({ source: 's1', target: 's1' })).toBe(true)
  })

  it('permits connecting to a zone backdrop', () => {
    // A zone can feed another zone now, so it is a legal endpoint like any node.
    expect(validator()({ source: 's1', target: 'zone-connections' })).toBe(true)
  })

  it('refuses a duplicate edge', () => {
    const edges = [{ id: 'e', source: 's1', target: 'f1' }]
    expect(validator(edges)({ source: 's1', target: 'f1' })).toBe(false)
  })

  it('lets the reverse direction be drawn too, once the first is already there', () => {
    const edges = [{ id: 'e', source: 's1', target: 'f1' }]
    expect(validator(edges)({ source: 'f1', target: 's1' })).toBe(true)
  })

  it('refuses when either endpoint does not exist', () => {
    expect(validator()({ source: 's1', target: 'ghost' })).toBe(false)
  })

  it('refuses a null-ended connection without throwing', () => {
    expect(validator()({ source: null, target: 'f1' })).toBe(false)
  })

  it('lets a custom component connect to anything, either direction', () => {
    const withCustom = [...nodes, flowNode('wh', 'custom')]
    const lookup = (id) => withCustom.find((n) => n.id === id)
    const isValid = makeConnectionValidator({ topology: TOPOLOGY, getNode: lookup, edges: [] })

    expect(isValid({ source: 'wh', target: 'd1' })).toBe(true)
    expect(isValid({ source: 'd1', target: 'wh' })).toBe(true)
  })

  it('refuses everything when the topology has not loaded yet', () => {
    /* Fail closed. Permitting edges before the rules arrive would let someone
       draw an edge the server then rejects at save time. */
    const isValid = makeConnectionValidator({ topology: null, getNode, edges: [] })
    expect(isValid({ source: 's1', target: 'f1' })).toBe(false)
  })
})

describe('explainRejection', () => {
  it('reports a duplicate', () => {
    const message = explainRejection({
      from: flowNode('s1', 'source'),
      to: flowNode('f1', 'destination_filter'),
      edges: [{ id: 'e', source: 's1', target: 'f1' }],
    })
    expect(message).toContain('already connected')
  })

  it('names a missing endpoint', () => {
    const message = explainRejection({ from: null, to: flowNode('f1', 'destination_filter'), edges: [] })
    expect(message).toContain('missing')
  })
})

describe('explainMisplacement', () => {
  it('names the correct zone, per the brief', () => {
    const message = explainMisplacement({
      topology: TOPOLOGY,
      kind: 'computed_trait',
      attemptedZone: zone('connections'),
    })
    expect(message).toContain('Computed Trait')
    expect(message).toContain('Unify')
    expect(message).toContain('Connections')
  })

  it('says so plainly for an unknown kind', () => {
    const message = explainMisplacement({
      topology: TOPOLOGY,
      kind: 'quantum_toaster',
      attemptedZone: zone('unify'),
    })
    expect(message).toContain('not a component')
  })

  it('uses a custom zone’s own name, which the topology has never heard of', () => {
    const message = explainMisplacement({
      topology: TOPOLOGY,
      kind: 'computed_trait',
      attemptedZone: { id: 'custom:app', label: "Customer's app", custom: true },
    })
    expect(message).toContain("Customer's app")
  })
})

describe('zoneAtPosition', () => {
  const zones = [
    {
      id: 'zone-connections',
      type: 'zone',
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      data: { id: 'connections' },
    },
    {
      id: 'zone-unify',
      type: 'zone',
      position: { x: 0, y: 150 },
      width: 100,
      height: 100,
      data: { id: 'unify' },
    },
  ]

  it('reads the size NodeResizer writes, not the style it never touches', () => {
    /* A hit test on a stale size means a drop that visually lands inside a resized
       zone gets refused, or lands in the zone underneath. */
    const resized = [{ ...zones[0], width: 900, style: { width: 100, height: 100 } }]
    expect(zoneAtPosition(resized, { x: 800, y: 50 })).not.toBeNull()
  })

  it('finds the zone containing a point', () => {
    expect(zoneAtPosition(zones, { x: 50, y: 50 }).data.id).toBe('connections')
    expect(zoneAtPosition(zones, { x: 50, y: 200 }).data.id).toBe('unify')
  })

  it('returns null in the gutter between zones', () => {
    // Dropping here must be refused, not silently snapped into a neighbour.
    expect(zoneAtPosition(zones, { x: 50, y: 125 })).toBeNull()
  })

  it('returns null outside every zone', () => {
    expect(zoneAtPosition(zones, { x: 5000, y: 5000 })).toBeNull()
  })

  it('includes the boundary', () => {
    expect(zoneAtPosition(zones, { x: 100, y: 100 })).not.toBeNull()
  })

  it('ignores component nodes', () => {
    const mixed = [...zones, flowNode('s1', 'source')]
    expect(zoneAtPosition(mixed, { x: 50, y: 50 }).type).toBe('zone')
  })
})

/*
 * The same hit test once zones nest, which is where it gets interesting: every
 * ancestor of the zone under the cursor is also a hit, and a nested zone's own
 * `position` is parent-relative rather than in flow coordinates.
 */
describe('zoneAtPosition with nested zones', () => {
  const nested = [
    {
      id: 'zone-segment',
      type: 'zone',
      position: { x: 0, y: 0 },
      width: 1000,
      height: 1000,
      data: { id: 'segment' },
    },
    {
      id: 'zone-unify',
      type: 'zone',
      parentId: 'zone-segment',
      position: { x: 100, y: 100 },
      width: 400,
      height: 400,
      data: { id: 'unify' },
    },
    {
      id: 'zone-profiles',
      type: 'zone',
      parentId: 'zone-unify',
      position: { x: 50, y: 50 },
      width: 100,
      height: 100,
      data: { id: 'profiles' },
    },
  ]

  it('gives the deepest zone containing the point, not the outermost', () => {
    /* Segment contains everything, so a first-match loop would answer "segment" for
       every drop on the canvas and nothing would ever land in a product zone. */
    expect(zoneAtPosition(nested, { x: 200, y: 200 }).data.id).toBe('profiles')
  })

  it('falls back to the containing ancestor outside the sub-zone', () => {
    expect(zoneAtPosition(nested, { x: 400, y: 400 }).data.id).toBe('unify')
    expect(zoneAtPosition(nested, { x: 800, y: 800 }).data.id).toBe('segment')
  })

  it('resolves a child’s box through its ancestors rather than reading it as absolute', () => {
    /* Profiles is at local (50,50) inside Unify at (100,100), so it covers 150..250 in
       flow coordinates. Comparing against the raw position would claim 50..150 and
       answer "profiles" for a point outside it -- a drop that visually landed on the
       Unify backdrop would be parented into Profiles. */
    expect(zoneAtPosition(nested, { x: 120, y: 120 }).data.id).toBe('unify')
  })
})

describe('toZoneLocal', () => {
  it('rebases an absolute position onto the zone origin', () => {
    /* Child positions in React Flow are relative to their group. Getting this
       wrong puts every dropped node a zone-offset away from the cursor. */
    const zone = { position: { x: 40, y: 200 } }
    expect(toZoneLocal(zone, { x: 90, y: 260 })).toEqual({ x: 50, y: 60 })
  })

  it('sums the parent chain for a sub-zone, whose own position is already local', () => {
    const nodes = [
      { id: 'zone-unify', type: 'zone', position: { x: 100, y: 100 }, width: 500, height: 400 },
      {
        id: 'zone-profiles',
        type: 'zone',
        parentId: 'zone-unify',
        position: { x: 20, y: 30 },
        width: 200,
        height: 200,
      },
    ]
    const profiles = nodes[1]

    expect(zoneOrigin(profiles, nodes)).toEqual({ x: 120, y: 130 })
    expect(toZoneLocal(profiles, { x: 200, y: 200 }, nodes)).toEqual({ x: 80, y: 70 })
  })

  it('needs the node list to see the chain at all', () => {
    /* Pinned because the omission is silent and looks like it works: without `nodes`
       the ancestors are unreachable, the offset comes out short by Unify's own
       position, and the node lands that far from where it was dropped. */
    const profiles = { id: 'zone-profiles', parentId: 'zone-unify', position: { x: 20, y: 30 } }
    expect(toZoneLocal(profiles, { x: 200, y: 200 })).toEqual({ x: 180, y: 170 })
  })
})

describe('absolutePositions', () => {
  const NODES = [
    { id: 'zone-segment', type: 'zone', position: { x: 10, y: 20 }, width: 1200, height: 800 },
    {
      id: 'zone-unify',
      type: 'zone',
      parentId: 'zone-segment',
      position: { x: 100, y: 200 },
      width: 500,
      height: 400,
    },
    { id: 'trait', type: 'segmentNode', parentId: 'zone-unify', position: { x: 40, y: 60 } },
    { id: 'parked', type: 'segmentNode', position: { x: 900, y: 40 } },
  ]

  it('gives the same answer as resolving one node at a time', () => {
    /* The whole reason it exists is to build the id map once, and "faster" is not a
       property worth having on its own -- so what is pinned is that it did not become a
       different answer in the process. */
    const positions = absolutePositions(NODES)
    for (const node of NODES) {
      expect(positions.get(node.id), node.id).toEqual(absolutePosition(node, NODES))
    }
  })

  it('sums every level, not just the immediate parent', () => {
    expect(absolutePositions(NODES).get('trait')).toEqual({ x: 150, y: 280 })
  })

  it('leaves a node outside every zone where it is', () => {
    expect(absolutePositions(NODES).get('parked')).toEqual({ x: 900, y: 40 })
  })

  it('does not hang on a parent chain that loops', () => {
    /* Same reason the single-node walk is guarded: the chain comes from a document that
       may have been written by an older or a broken client, and a hang is worse than a
       wrong offset. */
    const looped = [
      { id: 'a', type: 'zone', parentId: 'b', position: { x: 1, y: 1 } },
      { id: 'b', type: 'zone', parentId: 'a', position: { x: 2, y: 2 } },
    ]
    expect(absolutePositions(looped).get('a')).toEqual({ x: 3, y: 3 })
  })
})

describe('centreOf', () => {
  const NODES = [
    { id: 'zone-unify', type: 'zone', position: { x: 100, y: 100 }, width: 600, height: 400 },
    {
      id: 'trait',
      type: 'segmentNode',
      parentId: 'zone-unify',
      position: { x: 40, y: 60 },
      measured: { width: 200, height: 60 },
    },
  ]

  it('resolves through the parent chain rather than reading the raw position', () => {
    expect(centreOf(NODES[1], NODES)).toEqual({ x: 240, y: 190 })
  })

  it('falls back to the supplied size for a node the DOM has not measured', () => {
    const unmeasured = { ...NODES[1], measured: undefined }
    expect(centreOf(unmeasured, NODES, { width: 200, height: 60 })).toEqual({ x: 240, y: 190 })
  })

  it('reads a zone size off its explicit dimensions, which are never measured', () => {
    expect(centreOf(NODES[0], NODES)).toEqual({ x: 400, y: 300 })
  })

  it('prefers a chosen size over a stale measurement', () => {
    /* The frame after a resize, `measured` is still the old box. This is what re-homes a
       component on drag stop, so getting it wrong drops a card into the zone its previous
       centre was over. */
    const resized = { ...NODES[1], data: { size: { width: 400, height: 200 } } }
    expect(centreOf(resized, NODES)).toEqual({ x: 340, y: 260 })
  })

  it('still measures the axis that was not chosen', () => {
    const resized = { ...NODES[1], data: { size: { width: 400 } } }
    expect(centreOf(resized, NODES)).toEqual({ x: 340, y: 190 })
  })
})

describe('isDescendant', () => {
  const NODES = [
    { id: 'zone-segment', type: 'zone', position: { x: 0, y: 0 } },
    { id: 'zone-unify', type: 'zone', parentId: 'zone-segment', position: { x: 0, y: 0 } },
    { id: 'trait', parentId: 'zone-unify', position: { x: 0, y: 0 } },
  ]

  it('walks the whole chain, not just the immediate parent', () => {
    expect(isDescendant(NODES, 'zone-segment', 'trait')).toBe(true)
  })

  it('is false in the other direction', () => {
    expect(isDescendant(NODES, 'trait', 'zone-segment')).toBe(false)
  })

  it('counts a node as its own descendant, which is what stops self-parenting', () => {
    expect(isDescendant(NODES, 'zone-unify', 'zone-unify')).toBe(true)
  })

  it('does not hang on a cycle', () => {
    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    expect(isDescendant(cyclic, 'c', 'a')).toBe(false)
  })
})

describe('reparentTarget', () => {
  /* The geometry: Segment covers 0,0-800,600 and holds Connections at 20,60 (360x200)
     and Unify at 420,60 (360x200) beside it. A node's size comes in through `size`
     because nothing here has been through the DOM. */
  const SIZE = { size: { width: 200, height: 60 } }
  const base = () => [
    { id: 'zone-segment', type: 'zone', position: { x: 0, y: 0 }, width: 800, height: 600, data: { id: 'segment' } },
    { id: 'zone-connections', type: 'zone', parentId: 'zone-segment', position: { x: 20, y: 60 }, width: 360, height: 200, data: { id: 'connections' } },
    { id: 'zone-unify', type: 'zone', parentId: 'zone-segment', position: { x: 420, y: 60 }, width: 360, height: 200, data: { id: 'unify' } },
  ]
  const component = (position, parentId) => ({
    id: 'source:a',
    type: 'segmentNode',
    ...(parentId ? { parentId } : {}),
    position,
    data: { id: 'source:a', kind: 'source' },
  })

  it('returns null when the node is already in the zone it landed in', () => {
    const nodes = [...base(), component({ x: 40, y: 40 }, 'zone-connections')]
    expect(reparentTarget(nodes[3], nodes, SIZE)).toBeNull()
  })

  it('re-homes a component dragged into a sibling zone, in that zone’s coordinates', () => {
    /* Absolute 420+40=460, 60+40=100; centre 560,130 is inside Unify. Unify's origin is
       420,60, so the local position is the absolute minus that. */
    const nodes = [...base(), component({ x: 440, y: 40 }, 'zone-connections')]
    const target = reparentTarget(nodes[3], nodes, SIZE)

    expect(target.zone.id).toBe('zone-unify')
    expect(target.position).toEqual({ x: 40, y: 40 })
  })

  it('decides by the node’s centre, not by its corner', () => {
    /* Corner at absolute 380,100 -- outside Unify, which starts at x=420. Centre at
       480,130 -- inside it. A corner test would leave a component the user clearly
       dropped in Unify parented to Connections. */
    const nodes = [...base(), component({ x: 360, y: 40 }, 'zone-connections')]
    expect(reparentTarget(nodes[3], nodes, SIZE).zone.id).toBe('zone-unify')
  })

  it('drops a component out to the working area when its centre is outside every zone', () => {
    const nodes = [...base(), component({ x: 1200, y: 1200 }, 'zone-connections')]
    const target = reparentTarget(nodes[3], nodes, SIZE)

    expect(target.zone).toBeNull()
    /* Flow coordinates, absolute: the working area has no origin to subtract. Absolute
       is 20+1200, 60+1200. */
    expect(target.position).toEqual({ x: 1220, y: 1260 })
  })

  it('picks the innermost zone when they nest', () => {
    const nodes = [...base(), component({ x: 100, y: 100 })]
    expect(reparentTarget(nodes[3], nodes, SIZE).zone.id).toBe('zone-connections')
  })

  it('will not make a zone a child of a zone inside it', () => {
    /* Dragging Segment onto Unify. Every chain walk -- the coordinate sums here,
       growZones, React Flow's own renderer -- would recurse until it gave up. Segment's
       centre is at 400,300, which is not inside Unify anyway, so the case is forced by
       moving Segment so that its centre lands there. */
    const nodes = base()
    const segment = { ...nodes[0], position: { x: 200, y: -140 } }
    const moved = [segment, nodes[1], nodes[2]]

    expect(centreOf(segment, moved)).toEqual({ x: 600, y: 160 })
    expect(reparentTarget(segment, moved)).toBeNull()
  })

  it('moves a sub-zone out of its parent, keeping it where it was dropped', () => {
    /* Unify pulled clear of Segment: absolute 900,700, centre 1080,800, outside
       everything. The returned position has to be absolute or Unify jumps by Segment's
       own offset the moment it stops being Segment's child. */
    const nodes = base()
    const unify = { ...nodes[2], position: { x: 900, y: 700 } }
    const moved = [nodes[0], nodes[1], unify]
    const target = reparentTarget(unify, moved)

    expect(target.zone).toBeNull()
    expect(target.position).toEqual({ x: 900, y: 700 })
  })
})

describe('attachTargetFor', () => {
  /* No zones: attachTargetFor only cares about a candidate's box and the dragged
     node's centre, both in flow coordinates. Sizes come in through `size` for the
     same reason reparentTarget's do -- nothing here has been through the DOM. */
  const SIZE = { size: { width: 200, height: 60 } }
  const mapping = (position) => ({
    id: 'mapping:a',
    type: 'segmentNode',
    position,
    data: { id: 'mapping:a', kind: 'destination_mapping' },
  })
  const destination = (id, position, kind = 'destination') => ({
    id,
    type: 'segmentNode',
    position,
    data: { id, kind },
  })

  it('attaches to the destination the mapping was dropped onto', () => {
    const dest = destination('destination:a', { x: 0, y: 0 })
    const nodes = [dest, mapping({ x: 40, y: 10 })]
    expect(attachTargetFor(nodes[1], nodes, SIZE)).toBe(dest)
  })

  it('attaches to a destination function the same way', () => {
    const fn = destination('fn:a', { x: 0, y: 0 }, 'destination_function')
    const nodes = [fn, mapping({ x: 40, y: 10 })]
    expect(attachTargetFor(nodes[1], nodes, SIZE)).toBe(fn)
  })

  it('returns null when nothing is underneath', () => {
    const dest = destination('destination:a', { x: 0, y: 0 })
    const nodes = [dest, mapping({ x: 900, y: 900 })]
    expect(attachTargetFor(nodes[1], nodes, SIZE)).toBeNull()
  })

  it('ignores a candidate the centre only passed near, not over', () => {
    /* Mapping's box is 200x60 at 400,10 -- centre 500,40. The destination sits at
       0,0-200,60, nowhere near that, so proximity alone must not attach it. */
    const dest = destination('destination:a', { x: 0, y: 0 })
    const nodes = [dest, mapping({ x: 400, y: 10 })]
    expect(attachTargetFor(nodes[1], nodes, SIZE)).toBeNull()
  })

  it('ignores a candidate of the wrong kind', () => {
    const source = destination('source:a', { x: 0, y: 0 }, 'source')
    const nodes = [source, mapping({ x: 40, y: 10 })]
    expect(attachTargetFor(nodes[1], nodes, SIZE)).toBeNull()
  })

  it('breaks a tie between two overlapping destinations by the nearer centre', () => {
    const near = destination('destination:near', { x: 0, y: 0 })
    const far = destination('destination:far', { x: -150, y: 0 })
    /* Both boxes are 200x60; near's spans 0-200, far's spans -150-50, so 40,10
       falls inside both. Near's centre (100,30) is closer to the mapping's (140,40)
       than far's (-50,30) is. */
    const nodes = [near, far, mapping({ x: 40, y: 10 })]
    expect(attachTargetFor(nodes[2], nodes, SIZE)).toBe(near)
  })
})

describe('the Segment backdrop as a placement', () => {
  /* It holds products, not components -- see CONTAINER_ZONES. A component parked on it
     is one that belongs to two products or to none, which is a real answer and used to
     be reported as a misplacement on every save. */
  const backdrop = { id: 'segment', label: 'Segment' }

  it('accepts a component that belongs to two products at once', () => {
    expect(isValidPlacement(TOPOLOGY, 'computed_trait', backdrop)).toBe(true)
  })

  it('accepts a component whose kind is homed in a sub-zone', () => {
    expect(isValidPlacement(TOPOLOGY, 'profile', backdrop)).toBe(true)
  })

  it('still reports a genuine misfiling inside a product zone', () => {
    /* The assertion that keeps the exemption narrow: if it had been widened to the
       backdrop's children, this would pass too and the rule would be gone. */
    expect(isValidPlacement(TOPOLOGY, 'source', { id: 'engage', label: 'Engage' })).toBe(false)
  })
})
