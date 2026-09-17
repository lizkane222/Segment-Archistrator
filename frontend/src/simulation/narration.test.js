/*
 * Anchor narration.
 *
 * `KINDS` is the table's own key list rather than a subset chosen here, unlike the
 * deliberate subset in rules.test.js: exhaustiveness is the whole point of this suite,
 * and a retyped list is how a kind gets added to the table and silently goes unexercised.
 * It therefore also covers `custom`, which is not a topology kind (see kinds.js) but is
 * the one kind a user creates by hand, and so the one most likely to be on screen with
 * nothing else to explain it.
 *
 * The other half of the guard is in tests/test_topology.py: a kind in topology.py with no
 * narration at all cannot fail here, because it would be missing from both lists. That is
 * the only test that can see the Python table and this file at once.
 */

import { describe, expect, it } from 'vitest'

import { NARRATED_KINDS, STATUS_LABELS, describeKind, describeStep } from './narration.js'
import { STATUS, simulate } from './router.js'

const KINDS = NARRATED_KINDS

const TOPOLOGY = { kinds: { source: { label: 'Source' } } }

describe('describeKind', () => {
  it.each(KINDS)('narrates %s from nothing but its kind', (kind) => {
    /* `{id, kind}` and nothing else: a node dragged from the palette a moment ago
       has no query, no condition, no sourceType, and this is where a template
       function reading one of those would throw. */
    const anchor = describeKind({ id: 'n', kind })

    expect(anchor.known).toBe(true)
    expect(anchor.title).toBeTruthy()
    expect(anchor.what.length).toBeGreaterThan(30)
    expect(anchor.why.length).toBeGreaterThan(30)
  })

  it.each(KINDS)('never renders a placeholder value for %s', (kind) => {
    const anchor = describeKind({ id: 'n', kind })
    const prose = [anchor.what, anchor.why, anchor.caveat ?? ''].join(' ')
    // The failure mode of an unguarded `${data.query}`.
    expect(prose).not.toMatch(/undefined|null|NaN|\[object/)
  })

  it('names a filter’s own condition, so the anchor is about this filter', () => {
    const anchor = describeKind({
      id: 'f',
      kind: 'destination_filter',
      condition: 'event = "Order Completed"',
    })
    expect(anchor.what).toContain('event = "Order Completed"')
  })

  it('still reads as a sentence for a filter reporting no condition', () => {
    const anchor = describeKind({ id: 'f', kind: 'destination_filter' })
    expect(anchor.what).toContain('condition')
    expect(anchor.what).not.toContain('“”')
  })

  it('names an audience’s query', () => {
    const anchor = describeKind({
      id: 'a',
      kind: 'audience',
      query: 'event("Order Completed").count() >= 2',
    })
    expect(anchor.what).toContain('event("Order Completed").count() >= 2')
  })

  it('shortens a query too long to read at a glance', () => {
    /* An anchor is read while pointing at a diagram. The inspector is where the
       whole query lives; a 40-line FQL string in a tooltip covers the diagram it is
       annotating. */
    const query = Array.from({ length: 40 }, (_, i) => `trait("t${i}") = true`).join(' and ')
    const anchor = describeKind({ id: 'a', kind: 'audience', query })

    expect(anchor.what).toContain('trait("t0")')
    expect(anchor.what).not.toContain('trait("t39")')
    expect(anchor.what).toContain('…')
    // A bound on the whole sentence, not just the quoted part, so surrounding prose
    // that grew past a tooltip is caught too.
    expect(anchor.what.length).toBeLessThan(350)
  })

  it('names the tracking plan a source’s schema controls enforce', () => {
    const anchor = describeKind({
      id: 'sc',
      kind: 'source_schema_control',
      trackingPlan: 'Core plan',
    })
    expect(anchor.what).toContain('Core plan')
  })

  /* The three modes differ by everything downstream, so the anchor has to say which one
     applies -- and the no-mode case has to name all three rather than assume the
     permissive one, which is both the default and the one people assume is off. */
  it.each([
    ['block', /blocked here/],
    ['omit', /stripped from the payload/],
    ['allow', /let through/],
  ])('says what a source set to %s does with an unplanned event', (unplanned, expected) => {
    expect(describeKind({ id: 'sc', kind: 'source_schema_control', unplanned }).what).toMatch(
      expected,
    )
  })

  it('names all three outcomes when the source records none of them', () => {
    const what = describeKind({ id: 'sc', kind: 'source_schema_control' }).what
    expect(what).toMatch(/allowed/)
    expect(what).toMatch(/stripped/)
    expect(what).toMatch(/blocked/)
  })

  it('names a mapping’s trigger and counts its fields', () => {
    const anchor = describeKind({
      id: 'm',
      kind: 'destination_mapping',
      trigger: 'type = "track"',
      fields: { user_id: 'userId', email: 'traits.email' },
    })
    expect(anchor.what).toContain('type = "track"')
    expect(anchor.what).toContain('2 fields mapped')
  })

  /* Both shapes tolerated, because a mapping read from the API arrives keyed by
     destination field and a hand-drawn one is as likely to be a list. */
  it('counts a mapping’s fields given as a list, and does not pluralise one', () => {
    expect(
      describeKind({ id: 'm', kind: 'destination_mapping', fields: ['user_id'] }).what,
    ).toContain('1 field mapped')
  })

  it('leaves the count out entirely rather than saying no fields', () => {
    const what = describeKind({ id: 'm', kind: 'destination_mapping' }).what
    expect(what).not.toMatch(/0 field/)
    expect(what).toMatch(/field by field/)
  })

  it('names a source’s type when the workspace reported one', () => {
    expect(describeKind({ id: 's', kind: 'source', sourceType: 'javascript' }).what).toContain(
      'javascript',
    )
  })

  it('reads a custom component’s own description, which is all there is to read', () => {
    const anchor = describeKind({
      id: 'c',
      kind: 'custom',
      description: 'Their checkout service posts an order to our internal API.',
    })
    expect(anchor.what).toBe('Their checkout service posts an order to our internal API.')
  })

  it('asks for a description rather than leaving a custom component blank', () => {
    const anchor = describeKind({ id: 'c', kind: 'custom', description: '   ' })
    expect(anchor.what).toContain('inspector')
  })

  it('says a disabled component receives nothing', () => {
    const anchor = describeKind({ id: 'd', kind: 'destination', enabled: false })
    expect(anchor.caveat).toContain('nothing is delivered')
  })

  it('says the opposite for a disabled filter, which is what the reducer does', () => {
    /* The pair is the point. A disabled filter does not block -- it stops applying,
       so everything passes it. One caveat text for both would be wrong for one of
       them, and wrong in the direction that hides a destination receiving traffic
       nobody expected. */
    const anchor = describeKind({ id: 'f', kind: 'destination_filter', enabled: false })
    expect(anchor.caveat).toContain('passes')
    expect(anchor.caveat).not.toContain('nothing is delivered')
  })

  it('keeps a kind’s own caveat when nothing is switched off', () => {
    expect(describeKind({ id: 'f', kind: 'source_insert_function' }).caveat).toContain(
      'not read',
    )
  })

  it.each([
    'source_function',
    'source_insert_function',
    'destination_insert_function',
    'destination_function',
  ])('stops saying the body is unread once %s carries code', (kind) => {
    /*
     * The anchor and the verdict printed under it have to agree. A component whose code
     * the walkthrough just *ran* -- see visitFunction in ./router.js -- cannot also be
     * described as one whose body is not read; the reader would be looking at both
     * sentences at once.
     */
    const bare = describeKind({ id: 'f', kind })
    expect(bare.caveat).toContain('not read')
    expect(bare.caveat).toContain('Code tab')

    const coded = describeKind({ id: 'f', kind, code: 'async function onTrack(e) { return e }' })
    expect(coded.caveat).not.toContain('not read')
    expect(coded.caveat).toContain('run against the event')
  })

  it('does not count whitespace as code', () => {
    expect(describeKind({ id: 'f', kind: 'destination_function', code: '   \n\n' }).caveat).toContain(
      'not read',
    )
  })

  it('refuses to invent narration for a kind it does not know', () => {
    const anchor = describeKind({ id: 'x', kind: 'quantum_toaster' })
    expect(anchor.known).toBe(false)
    expect(anchor.what).toBeTruthy()
  })

  it('does not throw on a node with no kind at all', () => {
    expect(describeKind({ id: 'x' }).known).toBe(false)
    expect(describeKind(null).known).toBe(false)
  })

  it('reads through React Flow’s data wrapper', () => {
    // The canvas holds nodes nested; a stored graph holds them flat.
    expect(describeKind({ id: 's', data: { kind: 'source' } }).known).toBe(true)
  })

  it('prefers the label the node carries, then the topology’s', () => {
    expect(describeKind({ id: 's', kind: 'source' }, { topology: TOPOLOGY }).title).toBe('Source')
    expect(describeKind({ id: 's', kind: 'source', kindLabel: 'Web source' }).title).toBe(
      'Web source',
    )
    // No topology loaded yet, and no label on the node: still not blank.
    expect(describeKind({ id: 's', kind: 'source' }).title).toBeTruthy()
  })
})

describe('describeStep', () => {
  const graph = {
    nodes: [
      { id: 'src', kind: 'source', name: 'Test source' },
      { id: 'fn', kind: 'source_insert_function', name: 'Transform' },
      { id: 'filter', kind: 'destination_filter', name: 'Drop everything', actions: [{ type: 'DROP' }] },
      { id: 'dest', kind: 'destination', name: 'Webhook' },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'fn' },
      { id: 'e2', source: 'fn', target: 'filter' },
      { id: 'e3', source: 'filter', target: 'dest' },
    ],
  }
  const trace = simulate(graph, { type: 'track', event: 'Anything', userId: 'u1' })
  const nodeOf = (id) => graph.nodes.find((node) => node.id === id)
  const anchorAt = (id) => describeStep(trace.visited[id], nodeOf(id))

  it('reports the trace’s own reason, not a second account of it', () => {
    /* Identity, not similarity. The reducer is the only thing that knows why a node
       was never reached, so a reworded copy here would be a second explanation
       engine to keep in step. */
    expect(anchorAt('dest').reason).toBe(trace.visited.dest.reason)
  })

  it('labels the status in words', () => {
    expect(anchorAt('src').title).toBe(STATUS_LABELS[STATUS.origin])
    expect(anchorAt('filter').title).toBe(STATUS_LABELS[STATUS.dropped])
  })

  it('separates arriving from being explained', () => {
    // The filter is on the path and the destination is not, though both have copy.
    expect(anchorAt('fn').arrived).toBe(true)
    expect(anchorAt('dest').arrived).toBe(false)
  })

  it('carries the step index and depth, so playback can find its anchor', () => {
    expect(anchorAt('src').index).toBe(0)
    expect(anchorAt('fn').depth).toBe(1)
  })

  it('names the node, for an anchor read away from the node itself', () => {
    expect(anchorAt('dest').name).toBe('Webhook')
  })

  it('is null for a node the trace has nothing to say about', () => {
    // Every node in this graph is visited, so ask about one that is not in it.
    expect(describeStep(trace.visited.ghost, undefined)).toBeNull()
  })
})

describe('STATUS_LABELS', () => {
  it.each(Object.entries(STATUS))('labels the %s status', (_name, status) => {
    /* A status the reducer can produce and the UI cannot name would render as the
       raw enum string in front of a customer. */
    expect(STATUS_LABELS[status]).toBeTruthy()
  })
})
