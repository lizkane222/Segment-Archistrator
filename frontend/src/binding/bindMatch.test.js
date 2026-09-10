import { describe, expect, it } from 'vitest'

import {
  applyBinding,
  boundSegmentIds,
  candidatesFor,
  replacementPatch,
  scoreCandidate,
  undoBinding,
} from './bindMatch.js'

const WORKSPACE = [
  { id: 'source:1', kind: 'source', name: 'prod-js-2', slug: 'prod-js-2', sourceType: 'javascript', segmentId: '1' },
  { id: 'source:2', kind: 'source', name: 'iOS Production', slug: 'ios-prod', sourceType: 'analytics-swift', segmentId: '2' },
  { id: 'source:3', kind: 'source', name: 'Orders service', slug: 'orders', sourceType: 'node', segmentId: '3' },
  { id: 'dest:1', kind: 'destination', name: 'Braze', slug: 'braze', categories: ['CRM', 'Email Marketing'], segmentId: 'd1' },
  { id: 'dest:2', kind: 'destination', name: 'Amplitude', slug: 'amplitude', categories: ['Analytics'], segmentId: 'd2' },
]

describe('candidatesFor', () => {
  it('ranks a matching source type first', () => {
    const ranked = candidatesFor(
      { kind: 'source', name: 'iOS app', binds: { kind: 'source', sourceType: ['ios', 'swift'] } },
      WORKSPACE,
    )
    expect(ranked[0].node.segmentId).toBe('2')
    expect(ranked[0].suggested).toBe(true)
  })

  it('still offers every component of the kind, ranked lower', () => {
    /* The hint is the template author guessing about a workspace they have never
       seen. It must not be able to hide the component the user actually wants. */
    const ranked = candidatesFor(
      { kind: 'source', name: 'iOS app', binds: { kind: 'source', sourceType: ['ios'] } },
      WORKSPACE,
    )
    expect(ranked).toHaveLength(3)
    expect(ranked.filter((c) => c.suggested)).toHaveLength(1)
  })

  it('never offers a component of a different kind', () => {
    const ranked = candidatesFor({ kind: 'destination', binds: { kind: 'destination' } }, WORKSPACE)
    expect(ranked.map((c) => c.node.kind)).toEqual(['destination', 'destination'])
  })

  it('matches a source type by substring, because real slugs are compound', () => {
    // 'swift' should find 'analytics-swift'.
    const { score } = scoreCandidate({ sourceType: ['swift'] }, WORKSPACE[1], {})
    expect(score).toBeGreaterThan(0)
  })

  it('ranks by shared categories when there is no type hint', () => {
    const ranked = candidatesFor(
      {
        kind: 'destination',
        name: 'Email / push',
        binds: { kind: 'destination', categories: ['Email Marketing'] },
      },
      WORKSPACE,
    )
    expect(ranked[0].node.name).toBe('Braze')
    expect(ranked[0].reasons.join()).toMatch(/email/i)
  })

  it('sinks components already bound elsewhere, but keeps them selectable', () => {
    const ranked = candidatesFor(
      { kind: 'source', binds: { kind: 'source', sourceType: ['ios'] } },
      WORKSPACE,
      new Set(['2']),
    )
    expect(ranked.at(-1).node.segmentId).toBe('2')
    expect(ranked.at(-1).alreadyUsed).toBe(true)
    expect(ranked.at(-1).suggested).toBe(false)
  })

  it('skips workspace nodes with no segmentId, which cannot be bound to', () => {
    const ranked = candidatesFor({ kind: 'source', binds: { kind: 'source' } }, [
      { kind: 'source', name: 'Synthetic', segmentId: null },
      ...WORKSPACE,
    ])
    expect(ranked).toHaveLength(3)
  })

  it('returns nothing when the placeholder has no kind', () => {
    expect(candidatesFor({}, WORKSPACE)).toEqual([])
  })

  it('returns nothing when the workspace has not been loaded', () => {
    expect(candidatesFor({ kind: 'source' }, null)).toEqual([])
  })

  it('sorts equal scores alphabetically, case-insensitively', () => {
    const ranked = candidatesFor({ kind: 'source', binds: { kind: 'source' } }, WORKSPACE)
    expect(ranked.map((c) => c.node.name)).toEqual([
      'iOS Production',
      'Orders service',
      'prod-js-2',
    ])
  })

  it('gives a reason for every suggestion', () => {
    const ranked = candidatesFor(
      { kind: 'source', name: 'Backend service', binds: { kind: 'source', sourceType: ['node'] } },
      WORKSPACE,
    )
    for (const candidate of ranked.filter((c) => c.suggested)) {
      expect(candidate.reasons.length).toBeGreaterThan(0)
    }
  })
})

describe('name-word scoring', () => {
  it('ignores words too generic to be evidence', () => {
    /* "Product analytics" must not promote every destination with 'analytics' in
       its name above an exact type match. */
    const { score } = scoreCandidate({}, { name: 'Test source app', categories: [] }, {
      name: 'Test source app',
    })
    expect(score).toBe(0)
  })

  it('does count a distinctive shared word', () => {
    const { score, reasons } = scoreCandidate({}, { name: 'Braze Europe' }, { name: 'Braze' })
    expect(score).toBeGreaterThan(0)
    expect(reasons[0]).toMatch(/braze/)
  })
})

describe('applyBinding', () => {
  const placeholder = {
    kind: 'source',
    name: 'iOS app',
    description: 'Analytics-Swift. Shares the taxonomy with web.',
    bound: false,
    bindable: true,
    binds: { kind: 'source', sourceType: ['ios'] },
    style: { bg: '#eef' },
  }
  const real = {
    id: 'source:2',
    kind: 'source',
    name: 'iOS Production',
    description: '',
    segmentId: '2',
    slug: 'ios-prod',
    sourceType: 'analytics-swift',
    workspaceUrl: 'https://app.segment.com/acme/sources/ios-prod',
    writeKeyMasked: '••••••••ab12',
    bound: true,
  }

  it('takes the real component name, ids and links', () => {
    const bound = applyBinding(placeholder, real)
    expect(bound).toMatchObject({
      name: 'iOS Production',
      segmentId: '2',
      workspaceUrl: real.workspaceUrl,
      writeKeyMasked: '••••••••ab12',
      bound: true,
    })
  })

  it("keeps the template's description when Segment has none", () => {
    /* Segment descriptions are usually empty, and the template's text is what
       explains the component's architectural role -- the reason for the diagram. */
    expect(applyBinding(placeholder, real).description).toBe(placeholder.description)
  })

  it('prefers a real description when there is one', () => {
    expect(
      applyBinding(placeholder, { ...real, description: 'The real one' }).description,
    ).toBe('The real one')
  })

  it('keeps hand-applied styling through the binding', () => {
    expect(applyBinding(placeholder, real).style).toEqual({ bg: '#eef' })
  })

  it('keeps the binds hint so the node can be re-bound later', () => {
    expect(applyBinding(placeholder, real).binds).toEqual(placeholder.binds)
  })

  it("remembers the template's label for the node's role", () => {
    expect(applyBinding(placeholder, real).templateName).toBe('iOS app')
  })

  it('keeps the canvas node id, because every edge on the diagram references it', () => {
    /* `segmentId` identifies the Segment resource. Adopting the catalog node's own
       id here would leave data.id disagreeing with the node it is attached to. */
    const bound = applyBinding({ ...placeholder, id: 'source:placeholder-7' }, real)
    expect(bound.id).toBe('source:placeholder-7')
    expect(bound.segmentId).toBe('2')
  })

  it('keeps the node collapsed if it was collapsed', () => {
    expect(applyBinding({ ...placeholder, collapsed: true }, real).collapsed).toBe(true)
  })

  it('does not take the real node position, which would jump the node', () => {
    const bound = applyBinding(placeholder, { ...real, position: { x: 999, y: 999 } })
    expect(bound.position).toBeUndefined()
  })

  it('round-trips: unbinding restores the placeholder exactly', () => {
    const bound = applyBinding(placeholder, real)
    expect(undoBinding(bound)).toEqual(placeholder)
  })

  it('re-binding does not nest one stash inside another', () => {
    const once = applyBinding(placeholder, real)
    const twice = applyBinding(once, { ...real, segmentId: '3', name: 'Other' })
    expect(undoBinding(twice)).toEqual(placeholder)
  })

  it('unbinding without a stash clears the resource fields instead', () => {
    const cleared = undoBinding({
      kind: 'source',
      name: 'Hand-made',
      bound: true,
      segmentId: 'x',
      workspaceUrl: 'https://app.segment.com/a/sources/b',
      writeKeyMasked: '••••1',
    })
    expect(cleared).toMatchObject({
      bound: false,
      segmentId: null,
      workspaceUrl: null,
      writeKeyMasked: null,
    })
  })
})

describe('replacementPatch', () => {
  /* The inspector merges patches into a node's existing data. Binding and unbinding
     replace a node's identity, so anything the replacement drops has to be deleted
     explicitly or it survives -- a real segmentId left on a dashed placeholder. */
  it('deletes fields the replacement no longer has', () => {
    const patch = replacementPatch(
      { kind: 'source', name: 'Real', segmentId: 'abc', writeKeyMasked: '••••1' },
      { kind: 'source', name: 'iOS app' },
    )
    expect(patch).toEqual({
      kind: 'source',
      name: 'iOS app',
      segmentId: undefined,
      writeKeyMasked: undefined,
    })
  })

  it('leaves a field the replacement sets to null alone', () => {
    const patch = replacementPatch({ segmentId: 'abc' }, { segmentId: null })
    expect(patch.segmentId).toBe(null)
  })

  it('applied over the previous data, produces exactly the replacement', () => {
    const previous = { kind: 'source', name: 'Real', segmentId: 'abc', slug: 'real' }
    const next = { kind: 'source', name: 'iOS app', bound: false }
    const merged = { ...previous, ...replacementPatch(previous, next) }
    /* undefined keys survive a spread, so compare on the defined ones. */
    expect(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined))).toEqual(
      next,
    )
  })

  it('tolerates being given nothing to replace', () => {
    expect(replacementPatch(null, { a: 1 })).toEqual({ a: 1 })
  })
})

describe('boundSegmentIds', () => {
  it('collects the ids already used on the canvas', () => {
    const used = boundSegmentIds([
      { id: 'z', type: 'zone', data: {} },
      { id: 'a', data: { segmentId: '1', bound: true } },
      { id: 'b', data: { segmentId: '2', bound: false } },
      { id: 'c', data: {} },
    ])
    expect([...used]).toEqual(['1'])
  })

  it('excludes the node being bound, so re-binding it to itself is not "used"', () => {
    const nodes = [{ id: 'a', data: { segmentId: '1', bound: true } }]
    expect([...boundSegmentIds(nodes, 'a')]).toEqual([])
  })
})
