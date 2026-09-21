/*
 * The arithmetic of collapsing.
 *
 * The failure this file exists for is not a crash. It is a canvas that got tidier
 * and quietly lost an edge -- forty destinations folded into one node and the fan-in
 * badge says 39, or says nothing. Nobody would notice from the picture, which is the
 * whole point of the picture. So the load-bearing assertion here is conservation:
 * every edge that went in comes out either drawn, counted on an aggregate, or
 * counted as internal to a stack, and never twice.
 */

import { describe, expect, it } from 'vitest'

import { COMPONENT_Z, NODE_WIDTH } from './layout.js'
import {
  AGGREGATE_PREFIX,
  GROUP_PREFIX,
  MIN_GROUP_SIZE,
  UNCATEGORISED,
  AGGREGATE_PREFIX,
  collapseGraph,
  groupKey,
  groupLabel,
  groupSections,
  groupStackSize,
  groupsOf,
  internalSections,
  translateGroupDrag,
} from './grouping.js'

const TOPOLOGY = {
  kinds: {
    source: { label: 'Source', zone: 'connections' },
    destination: { label: 'Destination', zone: 'connections' },
    warehouse: { label: 'Warehouse', zone: 'connections' },
    audience: { label: 'Audience', zone: 'engage' },
    identity_resolution: {
      label: 'Identity Resolution',
      zone: 'unify',
      buckets: ['new', 'append', 'merge'],
    },
    profile: { label: 'Profile', zone: 'profiles', expandable: true },
  },
}

function node(id, kind, { name, position, parentId = 'zone-connections', ...data } = {}) {
  return {
    id,
    type: 'segmentNode',
    position: position ?? { x: 0, y: 0 },
    parentId,
    extent: 'parent',
    data: { id, kind, name: name ?? id, ...data },
  }
}

const zone = (id, position = { x: 0, y: 0 }) => ({
  id: `zone-${id}`,
  type: 'zone',
  position,
  width: 900,
  height: 400,
  data: { id },
})

const edge = (source, target) => ({
  id: `${source}->${target}`,
  source,
  target,
  type: 'flow',
  data: { phase: null, discovered: true },
})

/** Every input edge, accounted for exactly once in the collapsed view. */
function edgeAccounting(view, inputEdges) {
  let drawn = 0
  let aggregated = 0
  for (const e of view.edges) {
    if (e.data?.aggregated) aggregated += e.data.count
    else drawn += 1
  }
  const internal = view.nodes
    .filter((n) => n.type === 'groupStack')
    .reduce((total, n) => total + n.data.internalEdges, 0)
  return { drawn, aggregated, internal, total: drawn + aggregated + internal, of: inputEdges.length }
}

describe('groupKey', () => {
  it('splits sources by their source type', () => {
    expect(groupKey(node('s1', 'source', { sourceType: 'javascript' })))
      .toEqual({ kind: 'source', type: 'javascript', key: 'source:javascript' })
  })

  it('splits destinations by their first catalog category', () => {
    /* `categories` is read off the node, which got it from the catalog's `raw`
       payload -- there is no category column to read instead. */
    expect(groupKey(node('d1', 'destination', { categories: ['Email Marketing', 'CRM'] })).key)
      .toBe('destination:Email Marketing')
  })

  it('groups a kind with no second axis by kind alone', () => {
    /* Not `audience:uncategorised`. An audience has no type facet at all, so a
       "type" header over it would be inventing a distinction. */
    expect(groupKey(node('a1', 'audience'))).toEqual({
      kind: 'audience',
      type: null,
      key: 'audience',
    })
  })

  it('puts a faceted kind with no value in one explicit bucket', () => {
    for (const missing of [{}, { categories: [] }, { categories: [''] }, { categories: ['  '] }]) {
      expect(groupKey(node('d1', 'destination', missing)).type).toBe(UNCATEGORISED)
    }
  })

  it('reads a document node as readily as a canvas node', () => {
    /* The palette holds `{id, kind, name}` and the canvas holds `{data: {...}}`.
       Both have to land in the same group or the two lists disagree about where a
       component is. */
    const canvas = groupKey(node('s1', 'source', { sourceType: 'swift' }))
    const document = groupKey({ id: 's1', kind: 'source', name: 's1', sourceType: 'swift' })
    expect(document).toEqual(canvas)
  })

  it('has no key for a node with no kind', () => {
    expect(groupKey({ id: 'zone-unify' }).key).toBeNull()
    expect(groupKey(null).key).toBeNull()
  })
})

describe('groupLabel', () => {
  it('reads as kind then type', () => {
    expect(groupLabel(TOPOLOGY, { kind: 'source', type: 'javascript-website' }))
      .toBe('Source · Javascript website')
    expect(groupLabel(TOPOLOGY, { kind: 'destination', type: 'Email Marketing' }))
      .toBe('Destination · Email Marketing')
  })

  it('names the fallback bucket rather than leaving the header blank', () => {
    expect(groupLabel(TOPOLOGY, { kind: 'destination', type: UNCATEGORISED }))
      .toBe('Destination · Uncategorised')
  })

  it('is the kind alone where there is no type', () => {
    expect(groupLabel(TOPOLOGY, { kind: 'audience', type: null })).toBe('Audience')
  })

  it('still says something for a kind the client has not heard of', () => {
    /* A kind added server-side ahead of the client must not produce a group headed
       "undefined". */
    expect(groupLabel(TOPOLOGY, { kind: 'quantum_toaster', type: null })).toBe('Quantum toaster')
  })
})

describe('groupsOf', () => {
  it('offers a group only once there are enough of them to be worth folding', () => {
    const one = groupsOf([node('s1', 'source', { sourceType: 'swift' })], TOPOLOGY)
    expect(one).toEqual([])

    const two = groupsOf(
      [node('s1', 'source', { sourceType: 'swift' }), node('s2', 'source', { sourceType: 'swift' })],
      TOPOLOGY,
    )
    expect(two).toHaveLength(1)
    expect(two[0]).toMatchObject({ key: 'source:swift', count: MIN_GROUP_SIZE })
  })

  it('does not offer a group whose members are spread one per zone', () => {
    /* Counted per parent because that is how collapseGraph partitions -- a stack is
       a React Flow node and a node has one parent. Offering this would give the user
       a checkbox that visibly does nothing when ticked. */
    const spread = [
      node('a1', 'audience', { parentId: 'zone-engage' }),
      node('a2', 'audience', { parentId: 'zone-computations' }),
    ]
    expect(groupsOf(spread, TOPOLOGY)).toEqual([])
  })

  it('ignores zone backdrops and stacks already in the view', () => {
    const nodes = [
      zone('connections'),
      zone('engage'),
      { id: `${GROUP_PREFIX}source:swift@zone-connections`, type: 'groupStack', data: { kind: 'source' } },
      node('s1', 'source', { sourceType: 'swift' }),
      node('s2', 'source', { sourceType: 'swift' }),
    ]
    expect(groupsOf(nodes, TOPOLOGY).map((group) => group.key)).toEqual(['source:swift'])
  })

  it('sorts by kind then type, and carries the header text', () => {
    const nodes = [
      node('s1', 'source', { sourceType: 'swift' }),
      node('s2', 'source', { sourceType: 'swift' }),
      node('s3', 'source', { sourceType: 'javascript' }),
      node('s4', 'source', { sourceType: 'javascript' }),
      node('d1', 'destination', { categories: ['Email Marketing'] }),
      node('d2', 'destination', { categories: ['Email Marketing'] }),
    ]
    expect(groupsOf(nodes, TOPOLOGY).map((group) => group.label)).toEqual([
      'Destination · Email Marketing',
      'Source · Javascript',
      'Source · Swift',
    ])
  })
})

describe('groupSections', () => {
  const NODES = [
    { id: 's2', kind: 'source', name: 'zebra-web', sourceType: 'javascript' },
    { id: 's1', kind: 'source', name: 'alpha-web', sourceType: 'javascript' },
    { id: 'a1', kind: 'audience', name: 'High intent' },
    { id: 'd1', kind: 'destination', name: 'Braze', categories: ['Email Marketing'] },
  ]

  it('gives every group a header, including the groups of one', () => {
    /* Unlike the canvas, where a group of one costs a node and buys nothing, a
       header over a single source in a scrolling list is still where a reader looks
       for it. */
    expect(groupSections(NODES, TOPOLOGY).map((section) => section.label)).toEqual([
      'Audience',
      'Destination · Email Marketing',
      'Source · Javascript',
    ])
  })

  it('sorts within a group by name', () => {
    const sources = groupSections(NODES, TOPOLOGY).find((s) => s.key === 'source:javascript')
    expect(sources.items.map((item) => item.name)).toEqual(['alpha-web', 'zebra-web'])
  })

  it('does not mutate the array it was handed', () => {
    const original = [...NODES]
    groupSections(NODES, TOPOLOGY)
    expect(NODES).toEqual(original)
  })

  it('is empty for a workspace with nothing in it', () => {
    expect(groupSections([], TOPOLOGY)).toEqual([])
    expect(groupSections(null, TOPOLOGY)).toEqual([])
  })
})

describe('collapseGraph with nothing collapsed', () => {
  const nodes = [zone('connections'), node('s1', 'source'), node('s2', 'source')]
  const edges = [edge('s1', 's2')]

  it('hands back the very same arrays', () => {
    /* Identity, not equality. React Flow re-renders what it is given, so a new array
       every render would mean the canvas never settles -- the same contract
       applyPathsToNodes keeps. */
    for (const collapsed of [[], null, undefined, new Set()]) {
      const view = collapseGraph(nodes, edges, collapsed)
      expect(view.nodes).toBe(nodes)
      expect(view.edges).toBe(edges)
    }
  })

  it('hands them back unchanged when the collapsed key matches nothing present', () => {
    const view = collapseGraph(nodes, edges, ['destination:Email Marketing'])
    expect(view.nodes).toBe(nodes)
    expect(view.edges).toBe(edges)
  })

  it('hands them back unchanged when the group has only one member', () => {
    const single = [zone('connections'), node('d1', 'destination', { categories: ['CRM'] })]
    expect(collapseGraph(single, [], ['destination:CRM']).nodes).toBe(single)
  })
})

describe('collapseGraph fan-in', () => {
  /* One source feeding forty destinations. This is the shape the whole module exists
     for: retiring the segment_core hub made these forty edges real, and forty lines
     converging on one column is what a customer cannot read. */
  const FAN = 40
  const destinations = Array.from({ length: FAN }, (_, index) =>
    node(`d${index}`, 'destination', { name: `Dest ${index}`, categories: ['Email Marketing'] }),
  )
  const nodes = [zone('connections'), node('s1', 'source'), ...destinations]
  const edges = destinations.map((destination) => edge('s1', destination.id))

  const view = () => collapseGraph(nodes, edges, ['destination:Email Marketing'])

  it('draws one edge where there were forty', () => {
    expect(edges).toHaveLength(FAN)
    expect(view().edges).toHaveLength(1)
  })

  it('labels that edge with the number it stands for', () => {
    /* The count is the badge. A merged edge that did not carry it would claim the
       source feeds one destination. */
    expect(view().edges[0].data.count).toBe(FAN)
  })

  it('remembers which edges it merged', () => {
    const merged = view().edges[0]
    expect(new Set(merged.data.aggregated)).toEqual(new Set(edges.map((e) => e.id)))
  })

  it('accounts for every edge exactly once', () => {
    expect(edgeAccounting(view(), edges)).toMatchObject({ total: FAN, of: FAN, internal: 0 })
  })

  it('leaves forty destinations as one stack that knows its count', () => {
    const stacks = view().nodes.filter((n) => n.type === 'groupStack')
    expect(stacks).toHaveLength(1)
    expect(stacks[0].data.count).toBe(FAN)
    expect(stacks[0].data.memberIds).toHaveLength(FAN)
  })

  it('refuses to let the merged edge be deleted', () => {
    /* One click would delete forty real edges, and the thing clicked is not any one
       of them. */
    expect(view().edges[0].deletable).toBe(false)
  })

  it('gives the merged edge an id that cannot collide with a real one', () => {
    /* Server edge ids are literally `source->target`, so an aggregate reusing that
       shape would be indistinguishable from -- and could collide with -- a real edge
       between the two endpoints. */
    expect(view().edges[0].id.startsWith(AGGREGATE_PREFIX)).toBe(true)
  })
})

describe('collapseGraph edge rewriting', () => {
  const nodes = [
    zone('connections'),
    node('s1', 'source', { sourceType: 'javascript' }),
    node('s2', 'source', { sourceType: 'javascript' }),
    node('d1', 'destination', { categories: ['CRM'] }),
    node('d2', 'destination', { categories: ['CRM'] }),
    node('w1', 'warehouse', { warehouseType: 'snowflake' }),
  ]

  it('leaves an edge with both ends visible completely alone', () => {
    const untouched = edge('s1', 'w1')
    const view = collapseGraph(nodes, [untouched], ['destination:CRM'])
    /* Identity again: a rewritten copy would remount the edge and restart any
       scenario animation running along it. */
    expect(view.edges[0]).toBe(untouched)
  })

  it('merges a many-to-many fan into one edge per resolved pair', () => {
    const edges = [edge('s1', 'd1'), edge('s1', 'd2'), edge('s2', 'd1'), edge('s2', 'd2')]
    const view = collapseGraph(nodes, edges, ['destination:CRM'])

    expect(view.edges).toHaveLength(2)
    expect(view.edges.map((e) => e.data.count)).toEqual([2, 2])
    expect(edgeAccounting(view, edges).total).toBe(4)
  })

  it('collapses both ends at once', () => {
    const edges = [edge('s1', 'd1'), edge('s1', 'd2'), edge('s2', 'd1'), edge('s2', 'd2')]
    const view = collapseGraph(nodes, edges, ['source:javascript', 'destination:CRM'])

    expect(view.edges).toHaveLength(1)
    expect(view.edges[0].data.count).toBe(4)
    expect(view.edges[0].source.startsWith(GROUP_PREFIX)).toBe(true)
    expect(view.edges[0].target.startsWith(GROUP_PREFIX)).toBe(true)
  })

  it('counts an edge between two members of one stack rather than dropping it', () => {
    /* Undrawable -- an edge needs two nodes and both ends are now the same one. It
       has to be said out loud somewhere, because "the diagram got simpler" and "the
       diagram lost a connection" look identical. */
    const edges = [edge('d1', 'd2'), edge('s1', 'd1')]
    const view = collapseGraph(nodes, edges, ['destination:CRM'])

    const stack = view.nodes.find((n) => n.type === 'groupStack')
    expect(stack.data.internalEdges).toBe(1)
    expect(edgeAccounting(view, edges)).toMatchObject({ total: 2, of: 2, internal: 1 })
  })

  it('keeps the phase and discovered flags the original edge carried', () => {
    const discovered = { ...edge('s1', 'd1'), data: { phase: 'pre', discovered: true } }
    const view = collapseGraph(nodes, [discovered], ['destination:CRM'])
    expect(view.edges[0].data).toMatchObject({ phase: 'pre', discovered: true, count: 1 })
  })
})

describe('collapseGraph stack nodes', () => {
  const nodes = [
    zone('connections'),
    node('d1', 'destination', { name: 'Zendesk', categories: ['CRM'], position: { x: 400, y: 200 } }),
    node('d2', 'destination', { name: 'Braze', categories: ['CRM'], position: { x: 320, y: 300 } }),
    node('d3', 'destination', { name: 'Amplitude', categories: ['CRM'], position: { x: 500, y: 120 } }),
  ]
  const stack = () =>
    collapseGraph(nodes, [], ['destination:CRM']).nodes.find((n) => n.type === 'groupStack')

  it('sits at the bounding-box corner of the members it replaces', () => {
    /* Not at the first member. This corner is what makes the drag translation safe:
       `extent: 'parent'` clamps the stack to x,y >= 0 inside the zone, and no member
       is above or left of the corner, so no member can be pushed out through the
       zone's top or left edge. */
    expect(stack().position).toEqual({ x: 320, y: 120 })
  })

  it('inherits the zone its members were in', () => {
    expect(stack()).toMatchObject({ parentId: 'zone-connections', extent: 'parent' })
  })

  it('sits at a component z rather than a zone z', () => {
    /* A stack stands in for components and has to behave like one. At a zone's z, a folded
       group of forty would go under the next zone dragged across it -- and its own click,
       the one that expands it again, would go with it. */
    expect(stack().zIndex).toBe(COMPONENT_Z)
  })

  it('carries an explicit size, so React Flow never has to measure it', () => {
    /* A dimensions change for an id the document does not contain goes nowhere, so
       an unmeasured stack would size itself from nothing and the extent clamp would
       be wrong on the first frame. */
    expect(stack().width).toBe(NODE_WIDTH)
    expect(stack().height).toBe(groupStackSize(3).height)
    expect(stack().height).toBeGreaterThan(0)
  })

  it('is neither selectable nor deletable', () => {
    expect(stack()).toMatchObject({ selectable: false, deletable: false, draggable: true })
  })

  it('names its members in reading order', () => {
    expect(stack().data.members.map((m) => m.name)).toEqual(['Amplitude', 'Braze', 'Zendesk'])
  })

  it('grows with the number of members, up to a point', () => {
    const two = groupStackSize(2).height
    const three = groupStackSize(3).height
    const forty = groupStackSize(40).height
    expect(three).toBeGreaterThan(two)
    /* Peeked, not listed: a stack of forty that rendered forty rows would be taller
       than the zone containing it. */
    expect(forty).toBe(groupStackSize(4).height)
  })

  it('loses no node -- every member is either drawn or inside a stack', () => {
    const view = collapseGraph(nodes, [], ['destination:CRM'])
    const drawn = new Set(view.nodes.filter((n) => n.type === 'segmentNode').map((n) => n.id))
    const stacked = new Set(
      view.nodes.filter((n) => n.type === 'groupStack').flatMap((n) => n.data.memberIds),
    )
    for (const original of nodes.filter((n) => n.type === 'segmentNode')) {
      expect(drawn.has(original.id) || stacked.has(original.id), original.id).toBe(true)
    }
  })

  it('emits the stack after the zone it belongs to', () => {
    /* React Flow drops a child whose parent it has not seen yet, so a stack emitted
       before its zone would render nowhere at all. */
    const ids = collapseGraph(nodes, [], ['destination:CRM']).nodes.map((n) => n.id)
    expect(ids.indexOf('zone-connections')).toBeLessThan(
      ids.findIndex((id) => id.startsWith(GROUP_PREFIX)),
    )
  })

  it('makes one stack per zone for a group spread across two', () => {
    const spread = [
      zone('connections'),
      zone('engage'),
      node('a1', 'audience', { parentId: 'zone-engage' }),
      node('a2', 'audience', { parentId: 'zone-engage' }),
      node('a3', 'audience', { parentId: 'zone-computations' }),
      node('a4', 'audience', { parentId: 'zone-computations' }),
    ]
    const stacks = collapseGraph(spread, [], ['audience']).nodes.filter(
      (n) => n.type === 'groupStack',
    )
    expect(stacks).toHaveLength(2)
    expect(stacks.map((s) => s.parentId).sort()).toEqual(['zone-computations', 'zone-engage'])
  })
})

describe('collapseGraph and a scenario walkthrough', () => {
  const withPaths = (id, paths) =>
    node(id, 'destination', { categories: ['CRM'], paths })

  it('lights up if the event reached any member', () => {
    /* Thirty-nine destinations received it and one was withheld. A stack that went
       dark would say the opposite of what the trace says. */
    const nodes = [
      zone('connections'),
      withPaths('d1', [{ scenarioId: 'sc1', arrived: false }]),
      withPaths('d2', [{ scenarioId: 'sc1', arrived: true }]),
    ]
    const stack = collapseGraph(nodes, [], ['destination:CRM']).nodes.find(
      (n) => n.type === 'groupStack',
    )
    expect(stack.data.paths).toEqual([{ scenarioId: 'sc1', arrived: true }])
  })

  it('carries every scenario that touched any member', () => {
    const nodes = [
      zone('connections'),
      withPaths('d1', [{ scenarioId: 'sc1', arrived: true }]),
      withPaths('d2', [{ scenarioId: 'sc2', arrived: true }]),
    ]
    const stack = collapseGraph(nodes, [], ['destination:CRM']).nodes.find(
      (n) => n.type === 'groupStack',
    )
    expect(stack.data.paths.map((p) => p.scenarioId).sort()).toEqual(['sc1', 'sc2'])
  })

  it('has no paths key at all when no scenario is running', () => {
    const nodes = [zone('connections'), withPaths('d1'), withPaths('d2')]
    const stack = collapseGraph(nodes, [], ['destination:CRM']).nodes.find(
      (n) => n.type === 'groupStack',
    )
    expect(stack.data.paths).toBeUndefined()
  })
})

describe('translateGroupDrag', () => {
  const docNodes = [
    zone('connections'),
    node('d1', 'destination', { categories: ['CRM'], position: { x: 320, y: 120 } }),
    node('d2', 'destination', { categories: ['CRM'], position: { x: 400, y: 260 } }),
    node('s1', 'source', { position: { x: 40, y: 40 } }),
  ]
  const viewNodes = collapseGraph(docNodes, [], ['destination:CRM']).nodes
  const stackId = viewNodes.find((n) => n.type === 'groupStack').id

  it('leaves changes for real nodes alone', () => {
    const changes = [{ id: 's1', type: 'position', position: { x: 60, y: 40 }, dragging: true }]
    expect(translateGroupDrag(changes, viewNodes, docNodes)).toBe(changes)
  })

  it('rewrites a stack drag into one change per member', () => {
    const changes = [
      { id: stackId, type: 'position', position: { x: 340, y: 160 }, dragging: true },
    ]
    const out = translateGroupDrag(changes, viewNodes, docNodes)

    /* The stack sits at the members' bounding-box corner (320, 120), so this is a
       drag of +20, +40. */
    expect(out).toHaveLength(2)
    expect(out.find((c) => c.id === 'd1').position).toEqual({ x: 340, y: 160 })
    expect(out.find((c) => c.id === 'd2').position).toEqual({ x: 420, y: 300 })
  })

  it('keeps the relative arrangement, so expanding gives the layout back', () => {
    const before = { x: 400 - 320, y: 260 - 120 }
    const out = translateGroupDrag(
      [{ id: stackId, type: 'position', position: { x: 0, y: 0 }, dragging: true }],
      viewNodes,
      docNodes,
    )
    const d1 = out.find((c) => c.id === 'd1').position
    const d2 = out.find((c) => c.id === 'd2').position
    expect({ x: d2.x - d1.x, y: d2.y - d1.y }).toEqual(before)
  })

  it('composes over successive frames of one drag', () => {
    /* React Flow emits an absolute position each frame against its own drag-start
       snapshot, so the frames must not compound: two frames of +10 have to end at
       +20, not +30. This models the second frame by re-collapsing after the first. */
    const step = (view, doc, position) => {
      const changes = translateGroupDrag(
        [{ id: stackId, type: 'position', position, dragging: true }],
        view,
        doc,
      )
      const moved = doc.map((n) => {
        const change = changes.find((c) => c.id === n.id)
        return change?.position ? { ...n, position: change.position } : n
      })
      return { doc: moved, view: collapseGraph(moved, [], ['destination:CRM']).nodes }
    }

    const one = step(viewNodes, docNodes, { x: 330, y: 130 })
    const two = step(one.view, one.doc, { x: 340, y: 140 })

    expect(two.doc.find((n) => n.id === 'd1').position).toEqual({ x: 340, y: 140 })
    expect(two.doc.find((n) => n.id === 'd2').position).toEqual({ x: 420, y: 280 })
  })

  it('clears the members dragging flag when the drag ends', () => {
    /* Drag stop carries `dragging: false` and no position. Dropping it would leave
       every member rendering as mid-drag for good. */
    const out = translateGroupDrag(
      [{ id: stackId, type: 'position', dragging: false }],
      viewNodes,
      docNodes,
    )
    expect(out).toHaveLength(2)
    for (const change of out) {
      expect(change.dragging).toBe(false)
      expect(change.position).toBeUndefined()
    }
  })

  it('drops a change for a stack that is no longer in the view', () => {
    /* The group was expanded between the pointer event and the change being
       applied. There is nothing to translate onto and nothing the id names. */
    const out = translateGroupDrag(
      [{ id: `${GROUP_PREFIX}source:swift@zone-connections`, type: 'position', position: { x: 0, y: 0 } }],
      viewNodes,
      docNodes,
    )
    expect(out).toEqual([])
  })

  it('passes non-position changes through untouched', () => {
    const changes = [{ id: stackId, type: 'select', selected: true }]
    expect(translateGroupDrag(changes, viewNodes, docNodes)).toBe(changes)
  })
})

describe('internalSections', () => {
  it('gives the Identity Resolver its three buckets, in the order the topology lists', () => {
    const sections = internalSections(
      { kind: 'identity_resolution', buckets: { new: ['user_id'], merge: ['email', 'anonymous_id'] } },
      TOPOLOGY,
    )
    expect(sections.map((s) => s.label)).toEqual(['New', 'Append', 'Merge'])
    expect(sections.map((s) => s.rows.length)).toEqual([1, 0, 2])
  })

  it('shows an empty bucket rather than hiding it', () => {
    /* A resolver with nothing in Append still has an Append rule. Hiding the section
       would read as "this resolver has two buckets", which is not a thing. */
    const sections = internalSections({ kind: 'identity_resolution' }, TOPOLOGY)
    expect(sections).toHaveLength(3)
    expect(sections.every((s) => s.rows.length === 0)).toBe(true)
  })

  it('gives a profile identifiers, traits and events', () => {
    const sections = internalSections(
      { kind: 'profile', identifiers: ['user_id'], traits: { plan: 'pro' }, events: [] },
      TOPOLOGY,
    )
    expect(sections.map((s) => s.id)).toEqual(['identifiers', 'traits', 'events'])
    expect(sections[1].rows).toEqual([{ id: 'plan', label: 'plan: pro' }])
  })

  it('reads a row written as an object as readily as a bare string', () => {
    /* Nothing populates these yet, so a template author hand-writes them and both
       shapes turn up. */
    const sections = internalSections(
      { kind: 'profile', identifiers: [{ id: 'i1', name: 'user_id' }, 'email'] },
      TOPOLOGY,
    )
    expect(sections[0].rows).toEqual([
      { id: 'i1', label: 'user_id' },
      { id: 'row:1', label: 'email' },
    ])
  })

  it('is empty for a kind with no internals, and for one the topology lacks', () => {
    expect(internalSections({ kind: 'source' }, TOPOLOGY)).toEqual([])
    expect(internalSections({ kind: 'quantum_toaster' }, TOPOLOGY)).toEqual([])
    expect(internalSections(null, TOPOLOGY)).toEqual([])
    expect(internalSections({ kind: 'profile' }, null)).toEqual([])
  })
})

/*
 * What an aggregate edge must NOT inherit from the member it was built from.
 *
 * A group stack registers exactly two handles and both have **no id** (nodes/GroupStackNode.jsx).
 * `collapseGraph` used to build its aggregate with `...edge`, carrying through whichever member
 * happened to be first in array order -- so an aggregate would name `'e'` or `'w'`, React Flow's
 * handle lookup would find nothing, `getEdgePosition` would return null and its own `EdgeWrapper`
 * would return null before `FlowEdge` was ever mounted. The connector was not drawn at all.
 *
 * Collapsing a group therefore lost lines. The module's own comment above says that is "the failure
 * mode this whole module could most plausibly have"; these pin the case where it actually had it.
 */
describe('an aggregate edge and the member it came from', () => {
  const sided = (source, target, extra = {}) => ({
    ...edge(source, target),
    sourceHandle: 'e',
    targetHandle: 'w',
    data: { phase: null, discovered: true, ...extra },
  })

  const collapsedFanIn = (build) => {
    const destinations = Array.from({ length: 3 }, (_, index) =>
      node(`d${index}`, 'destination', { name: `Dest ${index}`, categories: ['Email Marketing'] }),
    )
    const nodes = [zone('connections'), node('s1', 'source'), ...destinations]
    const view = collapseGraph(nodes, build(destinations), ['destination:Email Marketing'])
    return view.edges.find((e) => e.id.startsWith(AGGREGATE_PREFIX))
  }

  it('names no handle, because a stack registers none it could name', () => {
    const aggregate = collapsedFanIn((destinations) =>
      destinations.map((destination) => sided('s1', destination.id)),
    )
    expect(aggregate).toBeTruthy()
    expect(aggregate.sourceHandle).toBe(null)
    expect(aggregate.targetHandle).toBe(null)
  })

  it('drops a border anchor measured against the member’s own box', () => {
    /* A fraction along the member's side means nothing on the stack that replaced it, and applying it
       anyway puts the line's end somewhere nobody put it. */
    const aggregate = collapsedFanIn((destinations) =>
      destinations.map((destination) =>
        sided('s1', destination.id, { sourceAnchor: 'free:right:0.73', targetAnchor: 'free:left:0.2' }),
      ),
    )
    expect(aggregate.data.sourceAnchor).toBeUndefined()
    expect(aggregate.data.targetAnchor).toBeUndefined()
  })

  it('drops bends, which were absolute coordinates for a different route', () => {
    const aggregate = collapsedFanIn((destinations) =>
      destinations.map((destination) =>
        sided('s1', destination.id, { waypoints: [{ x: 10, y: 20 }], routed: 'auto' }),
      ),
    )
    expect(aggregate.data.waypoints).toBeUndefined()
    expect(aggregate.data.routed).toBeUndefined()
  })

  it('still carries what does belong to the pair, and its count', () => {
    const aggregate = collapsedFanIn((destinations) =>
      destinations.map((destination) => sided('s1', destination.id, { color: '#ff0000' })),
    )
    expect(aggregate.data.color).toBe('#ff0000')
    expect(aggregate.data.count).toBe(3)
  })
})
