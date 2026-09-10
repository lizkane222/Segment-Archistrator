/*
 * Phase 5's done-when, on the client side: open a template, bind placeholders,
 * save, reload -- identical.
 *
 * The server half of this is covered in tests/test_templates.py, which proves the
 * stored JSON comes back byte-identical. That is the easy half. The hard half is
 * here, because opening a diagram is not a read: it runs the graph back through
 * `buildLayout`, which is the same function that *invents* positions for a
 * freshly-discovered workspace. Every regression this file guards against looks
 * the same to a user -- "I saved it and it came back different" -- and none of
 * them would fail a backend test.
 *
 * This composes the same functions AppShell does, in the same order, without
 * React: buildLayout (open) -> applyBinding (bind) -> serializeGraph (save) ->
 * buildLayout again (reload).
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { NODE_HEIGHT, NODE_WIDTH, buildLayout } from '../canvas/layout.js'
import { styleFor } from '../canvas/kinds.js'
import { applyBinding, replacementPatch } from '../binding/bindMatch.js'
import { applyPaletteToNodes, clearPaletteFromNodes, paletteStyles } from '../canvas/palettes.js'
import { countPlaceholders, graphFingerprint, positionsFromGraph, serializeGraph } from './serialize.js'

const ZONES = [
  { id: 'connections', label: 'Connections', order: 0 },
  { id: 'unify', label: 'Unify', order: 1 },
  { id: 'engage', label: 'Engage', order: 2 },
]

/* A miniature of the shipped web-mobile template: placeholders in all three zones,
   a journey (unbound forever, because there is no Journeys API), and the fan-out
   that replaced the `segment_core` hub -- each source draws its own edge to each of
   the things it feeds, so two sources and two targets make four edges where the hub
   made three. That multiplication is the honest topology and the reason grouping
   exists. */
const TEMPLATE = {
  nodes: [
    {
      id: 'ph:web',
      kind: 'source',
      name: 'Website (JS)',
      zone: 'connections',
      bound: false,
      bindable: true,
      binds: { kind: 'source', sourceType: ['javascript'] },
    },
    {
      id: 'ph:ios',
      kind: 'source',
      name: 'iOS app',
      zone: 'connections',
      bound: false,
      bindable: true,
      binds: { kind: 'source', sourceType: ['swift'] },
    },
    {
      id: 'ph:braze',
      kind: 'destination',
      name: 'Marketing',
      zone: 'connections',
      bound: false,
      bindable: true,
      binds: { kind: 'destination', categories: ['Email Marketing'] },
    },
    { id: 'ph:space', kind: 'space', name: 'Production space', zone: 'unify', bound: false, bindable: true, binds: { kind: 'space' } },
    { id: 'ph:aud', kind: 'audience', name: 'High intent', zone: 'engage', bound: false, bindable: true, binds: { kind: 'audience' } },
    { id: 'journey:1', kind: 'journey', name: 'Onboarding', zone: 'engage', bound: false, bindable: false },
  ],
  edges: [
    { id: 'e1', source: 'ph:web', target: 'ph:braze', discovered: false },
    { id: 'e2', source: 'ph:ios', target: 'ph:braze', discovered: false },
    { id: 'e3', source: 'ph:web', target: 'ph:space', discovered: false },
    { id: 'e4', source: 'ph:ios', target: 'ph:space', discovered: false },
    { id: 'e5', source: 'ph:space', target: 'ph:aud', discovered: false },
  ],
}

const WORKSPACE = [
  {
    id: 'source:1',
    kind: 'source',
    name: 'prod-web',
    slug: 'prod-web',
    sourceType: 'javascript-website',
    segmentId: 'src_1',
    workspaceUrl: 'https://app.segment.com/acme/sources/prod-web',
    writeKeyMasked: '••••••••ab12',
    bound: true,
  },
  {
    id: 'dest:1',
    kind: 'destination',
    name: 'Braze',
    slug: 'braze',
    categories: ['Email Marketing'],
    segmentId: 'dst_1',
    bound: true,
  },
]

/** What `useWorkspaceGraph.replace` does: layout with the saved positions honoured. */
function reopen(graph) {
  return buildLayout({ zones: ZONES, ...graph }, { existingPositions: positionsFromGraph(graph) })
}

/** What the inspector does with a binding: a merge patch that also deletes. */
function bindOnCanvas(nodes, nodeId, real) {
  return nodes.map((node) => {
    if (node.id !== nodeId) return node
    const patch = replacementPatch(node.data, applyBinding(node.data, real))
    return { ...node, data: { ...node.data, ...patch } }
  })
}

describe('open a template, bind, save, reload', () => {
  it('comes back byte-identical', () => {
    const opened = reopen(TEMPLATE)
    let nodes = bindOnCanvas(opened.nodes, 'ph:web', WORKSPACE[0])
    nodes = bindOnCanvas(nodes, 'ph:braze', WORKSPACE[1])

    const saved = serializeGraph({ nodes, edges: opened.edges, viewport: { x: -120, y: 40, zoom: 0.75 } })
    const reloaded = serializeGraph(reopen(saved))

    /* Fingerprints rather than toEqual, because this is the exact comparison the
       unsaved-changes dot is made of: if these differ, a freshly-opened diagram
       reads as edited and every reload nags to save. */
    expect(graphFingerprint(reloaded)).toBe(graphFingerprint(saved))
  })

  it('keeps the bound components bound, with their real ids and links', () => {
    const opened = reopen(TEMPLATE)
    const nodes = bindOnCanvas(opened.nodes, 'ph:web', WORKSPACE[0])
    const reloaded = reopen(serializeGraph({ nodes, edges: opened.edges }))

    const web = reloaded.nodes.find((n) => n.id === 'ph:web')
    expect(web.data).toMatchObject({
      name: 'prod-web',
      segmentId: 'src_1',
      workspaceUrl: WORKSPACE[0].workspaceUrl,
      writeKeyMasked: '••••••••ab12',
      bound: true,
    })
  })

  it('keeps the node id, so every edge drawn to it still lands', () => {
    /* Binding replaces a node's identity. If it also took the real component's id,
       the five template edges would all point at nodes that no longer exist. */
    const opened = reopen(TEMPLATE)
    const nodes = bindOnCanvas(opened.nodes, 'ph:web', WORKSPACE[0])
    const saved = serializeGraph({ nodes, edges: opened.edges })

    const ids = new Set(saved.nodes.map((n) => n.id))
    expect(saved.edges).toHaveLength(5)
    for (const edge of saved.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target), edge.id).toBe(true)
    }
  })

  it('drops the placeholder count by one per binding', () => {
    const opened = reopen(TEMPLATE)
    /* Five bindable placeholders out of six nodes. The journey has no API behind it,
       so it is not work the user can do anything about. */
    expect(countPlaceholders(opened.nodes)).toBe(5)

    const nodes = bindOnCanvas(opened.nodes, 'ph:web', WORKSPACE[0])
    expect(countPlaceholders(nodes)).toBe(4)
    expect(countPlaceholders(reopen(serializeGraph({ nodes, edges: [] })).nodes)).toBe(4)
  })

  it('can be unbound again after a reload, because the stash survives the trip', () => {
    const opened = reopen(TEMPLATE)
    const nodes = bindOnCanvas(opened.nodes, 'ph:web', WORKSPACE[0])
    const reloaded = reopen(serializeGraph({ nodes, edges: [] }))

    const web = reloaded.nodes.find((n) => n.id === 'ph:web')
    expect(web.data.placeholder).toMatchObject({ name: 'Website (JS)', bound: false })
  })

  it('leaves no trace of the placeholder on a bound node besides the stash', () => {
    /* The failure this guards against is a bound node still carrying the template's
       name -- it would show the customer a component labelled with a name their
       workspace has never heard of. */
    const nodes = bindOnCanvas(reopen(TEMPLATE).nodes, 'ph:web', WORKSPACE[0])
    const web = serializeGraph({ nodes, edges: [] }).nodes.find((n) => n.id === 'ph:web')

    expect(web.name).toBe('prod-web')
    expect(web.sourceType).toBe('javascript-website')
    expect(web.placeholder.name).toBe('Website (JS)')
  })

  it('preserves a hand-arranged layout, including nodes dragged past their zone', () => {
    const opened = reopen(TEMPLATE)
    const arranged = opened.nodes.map((node) =>
      node.id === 'ph:ios' ? { ...node, position: { x: 2400, y: 480 } } : node,
    )

    const saved = serializeGraph({ nodes: arranged, edges: opened.edges })
    const reloaded = reopen(saved)

    const ios = reloaded.nodes.find((n) => n.id === 'ph:ios')
    expect(ios.position).toEqual({ x: 2400, y: 480 })

    /* And the zone grew to hold it. This is the invariant `extent: 'parent'` needs:
       a node whose box pokes out of its parent gets clamped back inward on the next
       drag, so without this the diagram silently rearranges after a reload. */
    const zone = reloaded.nodes.find((n) => n.id === 'zone-connections')
    expect(ios.position.x + NODE_WIDTH).toBeLessThanOrEqual(zone.width)
    expect(ios.position.y + NODE_HEIGHT).toBeLessThanOrEqual(zone.height)
  })

  it('keeps every node in the zone its kind requires', () => {
    const saved = serializeGraph(reopen(TEMPLATE))
    const zoneOf = Object.fromEntries(saved.nodes.map((n) => [n.id, n.zone]))
    expect(zoneOf['ph:space']).toBe('unify')
    expect(zoneOf['ph:aud']).toBe('engage')
    expect(zoneOf['journey:1']).toBe('engage')
    expect(zoneOf['ph:web']).toBe('connections')
  })

  it('is stable over a second save and reload', () => {
    const once = serializeGraph(reopen(TEMPLATE))
    const twice = serializeGraph(reopen(once))
    const thrice = serializeGraph(reopen(twice))
    expect(graphFingerprint(thrice)).toBe(graphFingerprint(twice))
    expect(graphFingerprint(twice)).toBe(graphFingerprint(once))
  })

  it('writes no parent key for a document whose zones are flat', () => {
    /* Every diagram saved before zones nested. Emitting the key -- even as null --
       would change its fingerprint, so all of them would open with the
       unsaved-changes dot already lit and nag to save a diagram nobody touched. */
    for (const zone of serializeGraph(reopen(TEMPLATE)).zones) {
      expect(Object.hasOwn(zone, 'parent')).toBe(false)
    }
  })

  it('lays a flat document out with no zone parented to anything', () => {
    const zoneNodes = reopen(TEMPLATE).nodes.filter((node) => node.type === 'zone')
    expect(zoneNodes).toHaveLength(3)
    expect(zoneNodes.some((node) => node.parentId)).toBe(false)
  })
})

/*
 * The same done-when for a document whose zones nest.
 *
 * More can go wrong here than for a flat one: a sub-zone's stored position is
 * parent-local, and its parent's size is derived from the children it has to cover.
 * A translation applied twice, or a parent re-measured on reload, both come back to
 * the user as "I saved it and it moved".
 */
describe('a document whose zones nest', () => {
  const NESTED_ZONES = [
    { id: 'segment', label: 'Segment', order: 0 },
    { id: 'connections', label: 'Connections', order: 1, parent: 'segment' },
    { id: 'unify', label: 'Unify', order: 2, parent: 'segment' },
    { id: 'profiles', label: 'Profiles', order: 3, parent: 'unify' },
    { id: 'engage', label: 'Engage', order: 4, parent: 'segment' },
  ]

  const nested = (zones = NESTED_ZONES) => ({
    zones,
    nodes: [
      { id: 'ph:web', kind: 'source', name: 'Website', zone: 'connections', bound: true },
      /* Two levels deep, which is the depth the layout has to translate through. */
      { id: 'ph:ltv', kind: 'computed_trait', name: 'Lifetime value', zone: 'profiles', bound: true },
    ],
    edges: [],
  })

  const reopenNested = (graph) =>
    buildLayout(graph, { existingPositions: positionsFromGraph(graph) })

  it('parents each zone to the one it declares, without clamping it there', () => {
    const nodes = reopenNested(nested()).nodes
    const zoneNode = (id) => nodes.find((node) => node.id === `zone-${id}`)

    expect(zoneNode('segment').parentId).toBeUndefined()
    expect(zoneNode('unify').parentId).toBe('zone-segment')
    expect(zoneNode('profiles').parentId).toBe('zone-unify')
    /* A sub-zone clamped to its parent's box cannot be pulled out to sit beside its
       sibling, which is the whole of "zones are locked in place". The parent grows to
       cover its children instead -- `growZones`. */
    expect(zoneNode('profiles').extent).toBeUndefined()
  })

  it('emits parents before children, which React Flow requires', () => {
    /* Not a style point: React Flow drops a child whose parent it has not seen yet,
       so a depth-first walk that pushed the parent last would render the sub-zone
       nowhere at all. */
    const ids = reopenNested(nested()).nodes.map((node) => node.id)
    expect(ids.indexOf('zone-segment')).toBeLessThan(ids.indexOf('zone-unify'))
    expect(ids.indexOf('zone-unify')).toBeLessThan(ids.indexOf('zone-profiles'))
  })

  it('sizes each parent to cover the sub-zone inside it', () => {
    /* `extent: 'parent'` clamps to the parent's box, so a sub-zone poking out of it
       gets yanked inward on the first drag -- and it drags its own children with it. */
    const nodes = reopenNested(nested()).nodes
    const zoneNode = (id) => nodes.find((node) => node.id === `zone-${id}`)

    for (const [child, parent] of [
      ['profiles', 'unify'],
      ['unify', 'segment'],
      ['connections', 'segment'],
    ]) {
      const box = zoneNode(child)
      const outer = zoneNode(parent)
      expect(box.position.x + box.width, child).toBeLessThanOrEqual(outer.width)
      expect(box.position.y + box.height, child).toBeLessThanOrEqual(outer.height)
    }
  })

  it('comes back byte-identical, and stays so on a second trip', () => {
    const once = serializeGraph(reopenNested(nested()))
    const twice = serializeGraph(reopenNested(once))
    const thrice = serializeGraph(reopenNested(twice))

    expect(graphFingerprint(twice)).toBe(graphFingerprint(once))
    expect(graphFingerprint(thrice)).toBe(graphFingerprint(twice))
  })

  it('carries every parent link through the save', () => {
    const saved = serializeGraph(reopenNested(nested()))
    const parentOf = Object.fromEntries(saved.zones.map((zone) => [zone.id, zone.parent]))

    expect(parentOf).toMatchObject({ connections: 'segment', unify: 'segment', profiles: 'unify' })
    expect(Object.hasOwn(saved.zones.find((z) => z.id === 'segment'), 'parent')).toBe(false)
  })

  it('keeps a component in the sub-zone it was dropped into', () => {
    /* Zones nest; components do not. A component stores exactly one zone, always the
       innermost -- so this must come back `profiles`, not `unify`. */
    const saved = serializeGraph(reopenNested(nested()))
    expect(saved.nodes.find((node) => node.id === 'ph:ltv').zone).toBe('profiles')
  })

  it('lays a zone whose declared parent is absent out as a root, keeping the claim', () => {
    /* Someone deleted Segment. Unify has to render rather than disappear inside a
       group node that was never created -- and the declared parent has to survive the
       save, or re-adding Segment later would leave Unify beside it instead of in it. */
    const orphaned = nested(NESTED_ZONES.filter((zone) => zone.id !== 'segment'))
    const laid = reopenNested(orphaned)

    expect(laid.nodes.find((node) => node.id === 'zone-unify').parentId).toBeUndefined()
    expect(serializeGraph(laid).zones.find((zone) => zone.id === 'unify').parent).toBe('segment')
  })
})

/*
 * The working area outside every zone, which is now a legitimate place to put things --
 * somewhere to park a component while working out where it goes, or to hold one that
 * belongs to two products at once.
 *
 * The failure mode this guards is quiet and total: a component saved with no zone used
 * to be reloaded into Connections. Nothing errors, nothing warns, and the user's diagram
 * has silently rearranged itself.
 */
describe('a document with components outside every zone', () => {
  const LOOSE = {
    zones: ZONES,
    nodes: [
      { id: 'source:a', kind: 'source', name: 'Website', zone: 'connections', bound: true },
      {
        id: 'settings:idres',
        kind: 'identity_resolver',
        name: 'Identity resolution',
        zone: null,
        bound: true,
        position: { x: 900, y: 640 },
      },
    ],
    edges: [],
  }

  const reopen = (graph) => buildLayout(graph, { existingPositions: positionsFromGraph(graph) })

  it('keeps it parentless and where it was left', () => {
    const nodes = reopen(LOOSE).nodes
    const loose = nodes.find((node) => node.id === 'settings:idres')

    expect(loose.parentId).toBeUndefined()
    expect(loose.data.zone).toBeNull()
    expect(loose.position).toEqual({ x: 900, y: 640 })
  })

  it('round-trips without drifting into a zone', () => {
    const first = reopen(LOOSE)
    const saved = serializeGraph({ nodes: first.nodes, edges: first.edges })

    expect(saved.nodes.find((node) => node.id === 'settings:idres').zone).toBeNull()

    const second = reopen(saved)
    expect(graphFingerprint(serializeGraph({ nodes: second.nodes, edges: second.edges }))).toBe(
      graphFingerprint(saved),
    )
  })

  it('does not lose a component whose zone was deleted', () => {
    /* Deleting a zone deletes its children on the canvas, but a *stale* zone reference
       is different: the node is still in the document naming a zone that is not. It used
       to be dropped by the layout entirely, and the next save made that permanent. */
    const orphaned = {
      ...LOOSE,
      nodes: [{ ...LOOSE.nodes[0], zone: 'a-zone-that-was-deleted' }],
    }
    const nodes = reopen(orphaned).nodes

    expect(nodes.find((node) => node.id === 'source:a')).toBeDefined()
    expect(nodes.find((node) => node.id === 'source:a').parentId).toBeUndefined()
  })
})

/*
 * A themed canvas, saved and reopened.
 *
 * The point of applying a palette is that the diagram still looks like that tomorrow, and
 * every step between here and there is a place it could be lost: `serializeNode` flattens
 * `data` and drops a list of runtime keys, `stripSecrets` drops any key that looks like a
 * credential, and `buildLayout` rebuilds the node from the document. None of those has a
 * reason to keep `style` in particular, so nothing but a test says they do.
 */
describe('a themed document', () => {
  const THEMED = {
    zones: ZONES,
    nodes: [
      { id: 'source:a', kind: 'source', name: 'Website', zone: 'connections', bound: true },
      { id: 'dest:b', kind: 'destination', name: 'Braze', zone: 'connections', bound: true },
    ],
    edges: [],
  }

  const reopen = (graph) => buildLayout(graph, { existingPositions: positionsFromGraph(graph) })
  const themed = () => applyPaletteToNodes(reopen(THEMED).nodes, 'ocean')

  it('keeps every node its palette colours across a save and a reload', () => {
    const expected = paletteStyles('ocean')
    const saved = serializeGraph({ nodes: themed(), edges: [] })
    const nodes = reopen(saved).nodes

    expect(nodes.find((node) => node.id === 'source:a').data.style).toEqual(expected.source)
    expect(nodes.find((node) => node.id === 'dest:b').data.style).toEqual(expected.destination)
  })

  it('is a change to the document, so it marks the diagram unsaved', () => {
    /* Applying a palette has to be savable work. The fingerprint reads node data, so this
       holds by construction -- and it is exactly the property that would break if `style`
       were ever moved into RUNTIME_NODE_KEYS to stop a recolour dirtying the document. */
    const before = graphFingerprint(serializeGraph({ nodes: reopen(THEMED).nodes, edges: [] }))
    const after = graphFingerprint(serializeGraph({ nodes: themed(), edges: [] }))

    expect(after).not.toBe(before)
  })

  it('comes back to the defaults when the theme is cleared', () => {
    const cleared = clearPaletteFromNodes(themed())
    const nodes = reopen(serializeGraph({ nodes: cleared, edges: [] })).nodes

    for (const node of nodes.filter((entry) => entry.type !== 'zone')) {
      /* Asserted through `styleFor` rather than as `style` being undefined, even though
         undefined is exactly what `clearPaletteFromNodes` writes. An absent override has
         two spellings by the time it has been through a reload -- `toFlowNode` normalises
         a missing one to null -- and which of the two a node carries is a detail of that
         boundary, not something this test has an opinion about. What it has an opinion
         about is that the node renders in its kind's default colours, and that it is
         still *tracking* that default rather than holding a frozen copy of it. */
      expect(node.data.style ?? {}, node.id).toEqual({})
      expect(styleFor(node.data.kind, node.data.style), node.id).toEqual(styleFor(node.data.kind))
    }
  })
})

/*
 * Resized components.
 *
 * This is the round trip that motivated storing the size under `data.size` in the first
 * place. `RUNTIME_NODE_KEYS` deletes `width` and `height` out of node data -- they are
 * React Flow's own measurement fields, and a document that stored the user's sizes there
 * would look correct on the canvas and lose every one of them on save. Nothing about that
 * failure is visible until a reload, which is why it is pinned here rather than in
 * serialize.test.js.
 */
describe('a document with resized components', () => {
  const SIZED = {
    zones: ZONES,
    nodes: [
      {
        id: 'source:a',
        kind: 'source',
        name: 'Website',
        zone: 'connections',
        bound: true,
        size: { width: 340, height: 120 },
      },
      { id: 'dest:b', kind: 'destination', name: 'Braze', zone: 'connections', bound: true },
    ],
    edges: [],
  }

  const reopen = (graph) => buildLayout(graph, { existingPositions: positionsFromGraph(graph) })

  it('keeps a chosen size across a save and a reload', () => {
    const saved = serializeGraph({ nodes: reopen(SIZED).nodes, edges: [] })
    const stored = saved.nodes.find((node) => node.id === 'source:a')
    expect(stored.size).toEqual({ width: 340, height: 120 })

    const reloaded = reopen(saved).nodes.find((node) => node.id === 'source:a')
    expect(reloaded.width).toBe(340)
    expect(reloaded.height).toBe(120)
  })

  it('leaves an un-resized component with no dimensions of its own', () => {
    const saved = serializeGraph({ nodes: reopen(SIZED).nodes, edges: [] })
    expect(saved.nodes.find((node) => node.id === 'dest:b').size).toBeUndefined()
    expect('width' in reopen(saved).nodes.find((node) => node.id === 'dest:b')).toBe(false)
  })

  it('does not persist a measurement the browser took', () => {
    /* The other half of the same guard. A `dimensions` change without `setAttributes` is a
       measurement, and Canvas ignores it -- so `measured` should never reach the document
       even when React Flow has filled it in. Baking it in would freeze one browser's text
       metrics into a saved diagram. */
    const measured = reopen(SIZED).nodes.map((node) =>
      node.type === 'zone' ? node : { ...node, measured: { width: 999, height: 777 } },
    )
    const saved = serializeGraph({ nodes: measured, edges: [] })
    for (const node of saved.nodes) {
      expect(node.measured, node.id).toBeUndefined()
      expect(node.width, node.id).toBeUndefined()
      expect(node.height, node.id).toBeUndefined()
    }
    expect(saved.nodes.find((node) => node.id === 'source:a').size).toEqual({
      width: 340,
      height: 120,
    })
  })

  it('is savable work, so a resize marks the diagram unsaved', () => {
    const plain = { ...SIZED, nodes: SIZED.nodes.map(({ size, ...rest }) => rest) }
    const before = graphFingerprint(serializeGraph({ nodes: reopen(plain).nodes, edges: [] }))
    const after = graphFingerprint(serializeGraph({ nodes: reopen(SIZED).nodes, edges: [] }))
    expect(after).not.toBe(before)
  })

  it('grows the zone so a widened card is not drawn outside its backdrop', () => {
    const wide = {
      ...SIZED,
      nodes: [{ ...SIZED.nodes[0], size: { width: 900, height: 120 } }, SIZED.nodes[1]],
    }
    const zone = reopen(wide).nodes.find((node) => node.data?.id === 'connections')
    expect(zone.width).toBeGreaterThanOrEqual(900)
  })
})

/*
 * The shipped hand-arranged template, through the real open -> save -> reload path.
 *
 * Every other case in this file uses a miniature, which is the right call for a rule:
 * a fixture with two sources says what it means. This one deliberately does not, and
 * reads apps/diagrams/fixtures/templates.json instead. The reason is what that
 * template is *for*: it is a specific arrangement somebody drew -- eleven zones, two
 * of them regions outside Segment that cannot be regenerated from the topology, and
 * seventeen components placed by hand. A miniature would prove buildLayout handles
 * nesting, which is already proven above, and would not prove the thing that can
 * actually break: that the arrangement we ship is one buildLayout gives back
 * unchanged. If it drifts, the template opens as a diagram nobody drew.
 */
describe('the shipped end-to-end template', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../apps/diagrams/fixtures/templates.json', import.meta.url),
      'utf8',
    ),
  )
  const entry = fixture.find((template) => template.key === 'end-to-end-full-pipeline')

  /* The fixture as the loader leaves it, minus the fields buildLayout never reads.
     Zone labels and descriptions are derived in Python (seed_templates._build_zone),
     so they are absent here and irrelevant to the layout. */
  const graph = { nodes: entry.nodes, edges: entry.edges, zones: entry.zones }
  const open = (g) => buildLayout(g, { existingPositions: positionsFromGraph(g) })

  it('is in the fixture at all', () => {
    expect(entry).toBeDefined()
    expect(entry.nodes).toHaveLength(17)
    expect(entry.zones).toHaveLength(11)
  })

  it('places every component in a zone the template also declares', () => {
    const declared = new Set(entry.zones.map((zone) => zone.id))
    for (const node of entry.nodes) {
      if (node.zone !== null) expect(declared.has(node.zone), node.id).toBe(true)
    }
  })

  it('nests every sub-zone inside a zone the template also declares', () => {
    const declared = new Set(entry.zones.map((zone) => zone.id))
    for (const zone of entry.zones) {
      if (zone.parent) expect(declared.has(zone.parent), zone.id).toBe(true)
    }
  })

  it('opens with every component parented to the zone it was placed in', () => {
    const opened = open(graph)
    for (const node of entry.nodes) {
      const live = opened.nodes.find((entry) => entry.id === node.id)
      const expected = node.zone === null ? undefined : `zone-${node.zone}`
      expect(live.parentId, node.id).toBe(expected)
    }
  })

  it('opens with the two regions outside Segment drawn beside it, not inside it', () => {
    const opened = open(graph)
    const custom = opened.nodes.filter((node) => node.type === 'zone' && node.data?.custom)
    expect(custom).toHaveLength(2)
    for (const zone of custom) expect(zone.parentId).toBeUndefined()
  })

  it('comes back with every position and every zone unchanged', () => {
    const saved = serializeGraph(open(graph))
    const reloaded = serializeGraph(open(saved))
    expect(reloaded).toEqual(saved)

    /* Against the fixture, not merely self-consistent: a layout that shifted
       everything by the same amount on open would satisfy the comparison above. */
    for (const node of entry.nodes) {
      expect(saved.nodes.find((n) => n.id === node.id).position, node.id).toEqual(node.position)
    }
    for (const zone of entry.zones) {
      const stored = saved.zones.find((z) => z.id === zone.id)
      expect(stored.position, zone.id).toEqual(zone.position)
      expect([stored.width, stored.height], zone.id).toEqual([zone.width, zone.height])
    }
  })

  it('is not marked dirty by simply being opened', () => {
    const saved = serializeGraph(open(graph))
    expect(graphFingerprint(serializeGraph(open(saved)))).toBe(graphFingerprint(saved))
  })
})
