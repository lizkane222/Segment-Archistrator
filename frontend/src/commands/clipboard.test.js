import { describe, expect, it } from 'vitest'

import {
  CLIPBOARD_KEY,
  PASTE_OFFSET,
  copyNodes,
  dedupeName,
  duplicateNodes,
  pasteNodes,
  readClipboard,
  writeClipboard,
} from './clipboard.js'

const TOPOLOGY = {
  zones: [
    { id: 'segment', label: 'Segment', order: 0 },
    { id: 'connections', label: 'Connections', order: 1, parent: 'segment' },
    { id: 'unify', label: 'Unify', order: 2, parent: 'segment' },
    { id: 'profiles', label: 'Profiles', order: 3, parent: 'unify' },
  ],
  kinds: {
    source: { label: 'Source', zone: 'connections', allowedTargets: ['destination'] },
    destination: { label: 'Destination', zone: 'connections', allowedTargets: [] },
    computed_trait: { label: 'Computed trait', zone: 'unify', allowedTargets: [] },
  },
}

const zoneNode = (id, extra = {}) => ({
  id: `zone-${id}`,
  type: 'zone',
  position: { x: 0, y: 0 },
  width: 800,
  height: 400,
  data: { id, label: TOPOLOGY.zones.find((z) => z.id === id)?.label ?? id, ...extra },
})

const componentNode = (id, kind, zone, data = {}) => ({
  id,
  type: 'segmentNode',
  parentId: `zone-${zone}`,
  extent: 'parent',
  position: { x: 100, y: 40 },
  measured: { width: 200, height: 60 },
  selected: true,
  data: { id, kind, zone, name: id, bound: true, ...data },
})

const CANVAS = [
  zoneNode('connections'),
  zoneNode('unify'),
  componentNode('source:1', 'source', 'connections', { name: 'Website' }),
  componentNode('destination:1', 'destination', 'connections', { name: 'Braze' }),
  componentNode('trait:1', 'computed_trait', 'unify', { name: 'LTV' }),
]

const EDGES = [
  { id: 'source:1->destination:1', source: 'source:1', target: 'destination:1', discovered: true },
]

const connections = () => CANVAS.find((node) => node.id === 'zone-connections').data
const unify = () => CANVAS.find((node) => node.id === 'zone-unify').data

describe('copyNodes', () => {
  it('serializes the chosen nodes into document shape', () => {
    const clip = copyNodes(CANVAS, EDGES, ['source:1'])
    expect(clip.nodes).toEqual([
      {
        id: 'source:1',
        kind: 'source',
        name: 'Website',
        bound: true,
        zone: 'connections',
        position: { x: 100, y: 40 },
      },
    ])
    /* Through serializeNode, so React Flow's own state is already gone -- no
       `selected`, no `measured`, no `parentId`. A clip carrying `selected: true` would
       paste a node that arrives pre-selected and steals the next drag. */
    expect(clip.nodes[0]).not.toHaveProperty('selected')
  })

  it('takes an edge only when both of its ends are in the clip', () => {
    expect(copyNodes(CANVAS, EDGES, ['source:1', 'destination:1']).edges).toHaveLength(1)
    /* One end outside: after paste re-mints ids there is nothing for the other end to
       reach, so a kept edge would be a dangling reference the server rejects. */
    expect(copyNodes(CANVAS, EDGES, ['source:1']).edges).toEqual([])
  })

  it('never copies a zone or a collapsed stack', () => {
    /* A zone is a region, and its geometry and children make no sense apart from the
       document. A stack is a rendering of several nodes and is in no document at all. */
    expect(copyNodes(CANVAS, EDGES, ['zone-connections'])).toBe(null)
    expect(copyNodes([{ id: 'group:destination:email', type: 'groupStack' }], [], ['group:destination:email'])).toBe(
      null,
    )
  })

  it('is null for an empty selection, so a stray cmd-c keeps the previous clip', () => {
    expect(copyNodes(CANVAS, EDGES, [])).toBe(null)
    expect(copyNodes(CANVAS, EDGES, ['nope'])).toBe(null)
  })
})

describe('dedupeName', () => {
  it('appends, then numbers', () => {
    expect(dedupeName('Braze', [])).toBe('Braze copy')
    expect(dedupeName('Braze', ['Braze copy'])).toBe('Braze copy 2')
    expect(dedupeName('Braze', ['Braze copy', 'Braze copy 2'])).toBe('Braze copy 3')
  })

  it('copies a copy without stacking the suffix', () => {
    /* "Braze copy copy" is what a naive version produces, and after five duplicates it
       is unreadable. */
    expect(dedupeName('Braze copy', ['Braze copy'])).toBe('Braze copy 2')
    expect(dedupeName('Braze copy 2', ['Braze copy', 'Braze copy 2'])).toBe('Braze copy 3')
  })

  it('does not mind a name it has never seen', () => {
    expect(dedupeName('Braze copy', [])).toBe('Braze copy')
    expect(dedupeName(null, [])).toBe('Component copy')
  })
})

describe('pasteNodes', () => {
  const clipOf = (...ids) => copyNodes(CANVAS, EDGES, ids)

  it('mints new ids rather than reusing the originals', () => {
    const clip = clipOf('source:1')
    const { nodes } = pasteNodes(clip, {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 300, y: 300 },
    })

    /* Reusing the id is the failure that looks like nothing happened: React Flow keys
       on it, so the paste renders as the original node moving. Worse, the next save
       writes two nodes with one id and the second silently wins. */
    expect(nodes[0].id).not.toBe('source:1')
    expect(nodes[0].id).toMatch(/^manual:source:[0-9a-f]{8}$/)
  })

  it('lands the clip where it was aimed', () => {
    const { nodes } = pasteNodes(clipOf('source:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 300, y: 220 },
    })
    expect(nodes[0].position).toEqual({ x: 300, y: 220 })
    expect(nodes[0].zone).toBe('connections')
  })

  it('lands a paste aimed at bare canvas where the cursor was, not beside the original', () => {
    /* Bare canvas is aimed too. Deciding that on `zone` rather than on `position` -- which is
       the reading that looks right, since there is no zone to put anything in -- sends this
       down the in-place branch, and the copy appears 24px from the original at the far end of
       the canvas from where the user right-clicked. */
    const { nodes } = pasteNodes(clipOf('source:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: null,
      position: { x: 700, y: 500 },
    })
    expect(nodes[0].position).toEqual({ x: 700, y: 500 })
    expect(nodes[0].zone).toBe(null)
  })

  it('keeps the arrangement of a group it pastes', () => {
    const spread = [
      { id: 'a', kind: 'source', zone: 'connections', name: 'A', position: { x: 100, y: 100 } },
      { id: 'b', kind: 'source', zone: 'connections', name: 'B', position: { x: 180, y: 260 } },
    ]
    const { nodes } = pasteNodes(
      { nodes: spread, edges: [] },
      { nodes: CANVAS, topology: TOPOLOGY, zone: connections(), position: { x: 0, y: 0 } },
    )
    /* The top-left of the group goes to the cursor and everything holds its relative
       offset -- otherwise pasting five nodes stacks them all on one point. */
    expect(nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 160 },
    ])
  })

  it('renames, so a copy is distinguishable from what it was copied from', () => {
    const { nodes } = pasteNodes(clipOf('destination:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(nodes[0].name).toBe('Braze copy')
  })

  it('gives each of several copies of one node a distinct name', () => {
    const twice = { nodes: [...clipOf('destination:1').nodes, ...clipOf('destination:1').nodes], edges: [] }
    const { nodes } = pasteNodes(twice, {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(nodes.map((node) => node.name)).toEqual(['Braze copy', 'Braze copy 2'])
  })

  it('comes back unbound, with nothing tying it to the original workspace resource', () => {
    const bound = [
      {
        id: 'destination:1',
        kind: 'destination',
        zone: 'connections',
        name: 'Braze',
        bound: true,
        slug: 'braze',
        categories: ['Email Marketing'],
        segmentId: 'abc123',
        workspaceUrl: 'https://app.segment.com/acme/destinations/braze',
        linkVerified: true,
        writeKeyMasked: '••••1234',
        writeKeyLast4: '1234',
        position: { x: 0, y: 0 },
      },
    ]
    const { nodes } = pasteNodes(
      { nodes: bound, edges: [] },
      { nodes: CANVAS, topology: TOPOLOGY, zone: connections(), position: { x: 0, y: 0 } },
    )

    /* Two nodes claiming one Segment resource is a lie the Bind tab already treats as a
       conflict, and Stage 7's build mode would compose two writes for it. */
    expect(nodes[0].bound).toBe(false)
    expect(nodes[0]).not.toHaveProperty('segmentId')
    expect(nodes[0]).not.toHaveProperty('workspaceUrl')
    expect(nodes[0]).not.toHaveProperty('linkVerified')
    expect(nodes[0]).not.toHaveProperty('writeKeyMasked')
    expect(nodes[0]).not.toHaveProperty('writeKeyLast4')

    /* But it is still a Braze destination. What kind of thing it is survives; which
       instance it was does not. */
    expect(nodes[0].slug).toBe('braze')
    expect(nodes[0].categories).toEqual(['Email Marketing'])
  })

  it('remaps the internal edges onto the new ids', () => {
    const { nodes, edges } = pasteNodes(clipOf('source:1', 'destination:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    const [source, destination] = nodes.map((node) => node.id)

    expect(edges).toEqual([
      {
        id: `${source}->${destination}`,
        source,
        target: destination,
        discovered: false,
        phase: null,
      },
    ])
  })

  it('marks a copied edge as the user\'s, not as discovered', () => {
    /* `discovered` means "we read this out of the customer's workspace", which a copy
       of it is not -- and `toFlowEdge` reads the flag to decide whether the edge may be
       deleted again, so a copy inheriting it would be undeletable. */
    const { edges } = pasteNodes(clipOf('source:1', 'destination:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(EDGES[0].discovered).toBe(true)
    expect(edges[0].discovered).toBe(false)
  })

  it('deep-copies, so editing the copy does not edit the original', () => {
    const original = componentNode('destination:1', 'destination', 'connections', {
      name: 'Braze',
      details: { mappings: [{ event: 'Order Completed' }] },
      checklist: { 'create-destination': true },
    })
    const { nodes } = pasteNodes(copyNodes([original], [], ['destination:1']), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })

    expect(nodes[0].details).toEqual({ mappings: [{ event: 'Order Completed' }] })
    expect(nodes[0].checklist).toEqual({ 'create-destination': true })
    nodes[0].details.mappings.push({ event: 'Signed Up' })
    expect(original.data.details.mappings).toHaveLength(1)
  })

  it('advises about an unconventional zone and pastes into it anyway', () => {
    /* This assertion is the inverse of the one it replaces, and the reversal is the point.
       A drop is only ever advised about, never blocked, so a paste that refused was the app
       forbidding the copy of a node it had already accepted -- and `place` bails on `error`
       without adding nodes, so the whole symptom was that nothing appeared. */
    const result = pasteNodes(clipOf('trait:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(result.error).toBeUndefined()
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].zone).toBe('connections')
    expect(result.advisories).toEqual(['Computed trait belongs in Unify, not Connections.'])
  })

  it('lands every node of a mixed paste and advises only about the odd one', () => {
    /* All-or-nothing was the old rule, on the argument that a partial paste leaves a diagram
       the user believes is complete. Nothing is partial now -- every node arrives -- so the
       argument no longer applies, and the count is what pins that: two in, two out. */
    const mixed = {
      nodes: [
        { id: 'a', kind: 'source', zone: 'connections', name: 'A', position: { x: 0, y: 0 } },
        { id: 'b', kind: 'computed_trait', zone: 'connections', name: 'B', position: { x: 0, y: 0 } },
      ],
      edges: [],
    }
    const result = pasteNodes(mixed, {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(result.nodes).toHaveLength(2)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0]).toContain('belongs in Unify')
  })

  it('accepts a sub-zone of the kind\'s own zone', () => {
    /* Same ancestors-only rule as a palette drop: Profiles is inside Unify, so a
       computed trait belongs there too. The descriptor carries `parent` because a real
       one does -- `toZoneNode` spreads the topology entry into `data`, and that is what
       `zoneChain` climbs. */
    const result = pasteNodes(clipOf('trait:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: { id: 'profiles', label: 'Profiles', parent: 'unify' },
      position: { x: 0, y: 0 },
    })
    /* Silence, not merely the absence of a refusal: nothing refuses over placement any more,
       so `error` being undefined here would hold however wrong the zone was. */
    expect(result.advisories).toEqual([])
    expect(result.nodes[0].zone).toBe('profiles')
  })

  it('takes anything into a zone the customer drew themselves, without comment', () => {
    const result = pasteNodes(clipOf('trait:1'), {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: { id: 'custom:zone:abc', label: 'Their app', custom: true },
      position: { x: 0, y: 0 },
    })
    expect(result.advisories).toEqual([])
  })

  it('refuses an empty clip instead of pasting nothing successfully', () => {
    expect(pasteNodes(null, { nodes: CANVAS, topology: TOPOLOGY }).error).toBeTruthy()
    expect(pasteNodes({ nodes: [] }, { nodes: CANVAS, topology: TOPOLOGY }).error).toBeTruthy()
  })
})

describe('pasting a clip that spans zones', () => {
  /* What cmd-a produces, and what pasting one canvas into another produces. There is no
     single zone that could hold it, so the cursor has nothing to mean and each node
     goes back to the zone it came from. */
  const clip = copyNodes(CANVAS, EDGES, ['source:1', 'trait:1'])

  it('keeps each node in its own zone and ignores where the cursor was', () => {
    const { nodes } = pasteNodes(clip, {
      nodes: CANVAS,
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 999, y: 999 },
    })
    expect(nodes.map((node) => node.zone)).toEqual(['connections', 'unify'])
    expect(nodes[0].position).toEqual({ x: 100 + PASTE_OFFSET, y: 40 + PASTE_OFFSET })
  })

  it('drops a node onto bare canvas when its zone is not here, and rewrites its zone to match', () => {
    /* The hazard the old refusal guarded is real and is what the rewritten `zone` handles:
       parented to a zone that is not here, React Flow resolves `parentId` to no parent at
       all, so a node still *claiming* `unify` would be drawn against the flow origin while
       the save recorded it inside a zone the document does not contain. Cross-canvas paste
       is the whole reason the clip lives in sessionStorage, so refusing it was refusing the
       feature; landing it outside every zone and saying so is the honest version. */
    const result = pasteNodes(clip, {
      nodes: [zoneNode('connections')],
      topology: TOPOLOGY,
      zone: connections(),
      position: { x: 0, y: 0 },
    })
    expect(result.error).toBeUndefined()
    expect(result.nodes.map((node) => node.zone)).toEqual(['connections', null])
    expect(result.advisories).toEqual([
      'This canvas has no unify zone, so LTV was placed outside every zone.',
    ])
  })

  it('re-checks the zone the clip claims rather than trusting it', () => {
    /* A document written by an older client, or one whose zone was retyped: the clip says
       `connections` and the kind says Unify. Still re-checked -- only the consequence
       changed, from a refusal to a line in the console drawer. */
    const wrong = {
      nodes: [
        { id: 'a', kind: 'source', zone: 'connections', name: 'A', position: { x: 0, y: 0 } },
        { id: 'b', kind: 'computed_trait', zone: 'connections', name: 'B', position: { x: 0, y: 0 } },
      ],
      edges: [],
    }
    /* No `position`, so this takes the in-place branch even though the two nodes share a
       zone -- which is exactly the shape `duplicateNodes` passes. */
    const result = pasteNodes(wrong, { nodes: CANVAS, topology: TOPOLOGY, zone: null })
    expect(result.nodes).toHaveLength(2)
    expect(result.advisories).toEqual(['Computed trait belongs in Unify, not Connections.'])
  })
})

describe('duplicateNodes', () => {
  it('copies in place, offset so the copy is visible', () => {
    const { nodes } = duplicateNodes(CANVAS, EDGES, ['destination:1'], { topology: TOPOLOGY })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('Braze copy')
    expect(nodes[0].zone).toBe('connections')
    expect(nodes[0].position).toEqual({ x: 100 + PASTE_OFFSET, y: 40 + PASTE_OFFSET })
  })

  it('brings the sub-parts and the edges between what was selected', () => {
    const { nodes, edges } = duplicateNodes(CANVAS, EDGES, ['source:1', 'destination:1'], {
      topology: TOPOLOGY,
    })
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe(nodes[0].id)
  })

  it('says so rather than doing nothing when nothing is selected', () => {
    expect(duplicateNodes(CANVAS, EDGES, [], { topology: TOPOLOGY }).error).toBeTruthy()
  })

  it('duplicates a component sitting in a zone that only ever advised against it', () => {
    /* The reported bug, exactly: Duplicate on a node the user had already been allowed to
       drop produced no visible node and one red console line. `duplicateNodes` passes no
       position, which takes the in-place branch, which is where the refusal lived -- so this
       is the case that has to keep passing if the reversal above is ever undone. */
    const misplaced = componentNode('trait:2', 'computed_trait', 'connections', { name: 'LTV' })
    const canvas = [zoneNode('connections'), misplaced]

    const result = duplicateNodes(canvas, [], ['trait:2'], { topology: TOPOLOGY })
    expect(result.error).toBeUndefined()
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].name).toBe('LTV copy')
    expect(result.nodes[0].zone).toBe('connections')
    expect(result.advisories).toEqual(['Computed trait belongs in Unify, not Connections.'])
  })

  it('duplicates a component that is in no zone at all', () => {
    /* The other half of the same bug and the one no advisory covers: bare canvas is a place
       you are allowed to work, so `zone: null` has nothing to report -- but `present.get(null)`
       is undefined, and the old code read that as "the zone is missing" and refused. */
    const loose = {
      id: 'manual:source:abcd1234',
      type: 'segmentNode',
      position: { x: 500, y: 300 },
      data: { id: 'manual:source:abcd1234', kind: 'source', zone: null, name: 'Kiosk' },
    }
    const result = duplicateNodes([zoneNode('connections'), loose], [], [loose.id], {
      topology: TOPOLOGY,
    })
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].zone).toBe(null)
    expect(result.nodes[0].position).toEqual({ x: 500 + PASTE_OFFSET, y: 300 + PASTE_OFFSET })
    expect(result.advisories).toEqual([])
  })
})

describe('the clipboard store', () => {
  function fakeStorage() {
    const store = new Map()
    return {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      store,
    }
  }

  it('round-trips a clip', () => {
    const storage = fakeStorage()
    const clip = copyNodes(CANVAS, EDGES, ['source:1', 'destination:1'])
    expect(writeClipboard(clip, storage)).toBe(true)
    expect(readClipboard(storage)).toEqual(clip)
    expect(storage.store.has(CLIPBOARD_KEY)).toBe(true)
  })

  it('is JSON, which is what makes the other tab able to read it', () => {
    /* The whole of cross-canvas paste: a clip is a document fragment, so it survives
       stringify/parse unchanged and needs no machinery beyond this. */
    const clip = copyNodes(CANVAS, EDGES, ['source:1'])
    expect(JSON.parse(JSON.stringify(clip))).toEqual(clip)
  })

  it('reads nothing rather than throwing on junk', () => {
    const storage = fakeStorage()
    storage.setItem(CLIPBOARD_KEY, 'not json')
    expect(readClipboard(storage)).toBe(null)

    storage.setItem(CLIPBOARD_KEY, JSON.stringify({ nodes: [] }))
    expect(readClipboard(storage)).toBe(null)
    expect(readClipboard(null)).toBe(null)
  })

  it('reports a failed write instead of losing the keystroke to an exception', () => {
    /* Storage can be full, or blocked outright by the browser's privacy settings. The
       copy is still usable in this tab; only the other one loses out. */
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(writeClipboard({ nodes: [] }, blocked)).toBe(false)
  })
})
