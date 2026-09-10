import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BIND,
  FIELDS,
  LINKS,
  OVERVIEW,
  RULES,
  RULES_KINDS,
  STYLE,
  ZONE,
  bindable,
  reconcileTab,
  resolveSpace,
  rulesSubject,
  spacesFromGraph,
  tabsFor,
  DATA,
} from './tabs.js'

const node = (kind, data = {}) => ({ id: `${kind}:1`, data: { kind, ...data } })

describe('tabsFor', () => {
  it('always offers Overview, Style and Links', () => {
    for (const kind of ['source', 'warehouse', 'audience', 'profile', 'identity_setting']) {
      const tabs = tabsFor(node(kind))
      expect(tabs).toContain(OVERVIEW)
      expect(tabs).toContain(STYLE)
      expect(tabs).toContain(LINKS)
    }
  })

  it('opens on Overview', () => {
    expect(tabsFor(node('audience'))[0]).toBe(OVERVIEW)
  })

  it('offers Rules only where there are rules to show', () => {
    /* An always-present but always-empty tab is worse than no tab: it invites a
       click that teaches nothing. */
    expect(tabsFor(node('destination'))).toContain(RULES)
    expect(tabsFor(node('audience'))).toContain(RULES)
    expect(tabsFor(node('warehouse'))).not.toContain(RULES)
    expect(tabsFor(node('source'))).not.toContain(RULES)
  })

  it('offers Fields only where a profile schema is meaningful', () => {
    expect(tabsFor(node('audience'))).toContain(FIELDS)
    expect(tabsFor(node('space'))).toContain(FIELDS)
    expect(tabsFor(node('source'))).toContain(FIELDS)
    // A warehouse has no "available fields" in any sense a reader expects.
    expect(tabsFor(node('warehouse'))).not.toContain(FIELDS)
    expect(tabsFor(node('destination'))).not.toContain(FIELDS)
  })

  it('keeps the tab order stable regardless of kind', () => {
    const tabs = tabsFor(node('audience'))
    expect(tabs).toEqual([OVERVIEW, FIELDS, RULES, STYLE, LINKS])
  })

  it('returns nothing when there is no node', () => {
    expect(tabsFor(null)).toEqual([])
    expect(tabsFor(undefined)).toEqual([])
  })

  it('still gives an unknown kind the universal tabs', () => {
    // A kind added server-side before the client knows about it must not lose
    // the inspector entirely.
    expect(tabsFor(node('quantum_toaster'))).toEqual([OVERVIEW, STYLE, LINKS])
  })
})

describe('bindable', () => {
  it('is true for a node drawn as a placeholder', () => {
    expect(bindable(node('source', { bound: false }))).toBe(true)
  })

  it('is false for a component discovered in the workspace', () => {
    /* There is nothing to bind it to that it is not already. */
    expect(bindable(node('source', { bound: true, segmentId: 'abc' }))).toBe(false)
  })

  it('needs bound to say false, not merely to be absent', () => {
    /* Deliberately unlike isPlaceholder, which counts silence as unbound because
       over-counting a banner is harmless. Offering a Bind tab on a node nothing
       has claimed is unbound is not: the tab would lead, on every node. */
    expect(bindable(node('source'))).toBe(false)
  })

  it('is false for a kind with no Public API to bind against', () => {
    // A journey is authored by hand; no candidate list can ever be produced.
    expect(bindable(node('journey', { bound: false, bindable: false }))).toBe(false)
  })

  it('stays true after binding, because unbinding needs somewhere to live', () => {
    const bound = node('source', { bound: true, segmentId: 'abc', placeholder: { bound: false } })
    expect(bindable(bound)).toBe(true)
  })

  it('does not throw on a zone backdrop or a missing node', () => {
    expect(bindable(null)).toBe(false)
    expect(bindable({ id: 'zone-unify', type: 'zone' })).toBe(false)
  })
})

describe('the Bind tab', () => {
  it('leads, so a placeholder opens on the only useful action', () => {
    const tabs = tabsFor(node('source', { bound: false }))
    expect(tabs[0]).toBe(BIND)
    expect(tabs).toEqual([BIND, OVERVIEW, FIELDS, STYLE, LINKS])
  })

  it('is absent from a bound component', () => {
    expect(tabsFor(node('source', { bound: true }))).not.toContain(BIND)
  })

  it('opens a placeholder on Bind even when another tab was selected', () => {
    expect(reconcileTab(FIELDS, node('destination', { bound: false }))).toBe(BIND)
  })

  it('does not drag a bound node back to Bind', () => {
    /* Binding one placeholder then clicking the next should land on Bind; clicking
       a real component afterwards must not. */
    expect(reconcileTab(BIND, node('destination', { bound: true }))).toBe(OVERVIEW)
  })
})

describe('rulesSubject', () => {
  it('names what the tab is about, per kind', () => {
    expect(rulesSubject(node('destination'))).toBe('Destination filters')
    expect(rulesSubject(node('audience'))).toBe('Audience definition')
    expect(rulesSubject(node('reverse_etl_model'))).toBe('Model query')
  })

  it('is null for kinds with no rules surface', () => {
    expect(rulesSubject(node('warehouse'))).toBeNull()
    expect(rulesSubject(null)).toBeNull()
  })

  /*
   * The other half of the promise, read out of RulesTab.jsx's source.
   *
   * Ugly, and the alternative is worse: there is no jsdom in this project, so a kind whose
   * heading is declared here and whose branch was never written cannot be caught by
   * rendering it. It is caught by a customer, in a session, reading "nothing configured on
   * this component" about a tracking plan that has forty events in it -- the tool making a
   * false claim about their workspace, which is the one failure this whole panel exists to
   * avoid. Six kinds were in that state until the editors were written.
   *
   * Same shape as the narration guard in tests/test_topology.py, and the same fragility:
   * it reads `case '<kind>':` lines, so restructuring the switch into a lookup table breaks
   * this rather than the thing it guards. That is the right way round -- it fails loudly and
   * gets rewritten, instead of passing while checking nothing.
   */
  it('has a branch in RulesTab.jsx for every kind it promises a tab to', () => {
    const source = readFileSync(new URL('./RulesTab.jsx', import.meta.url), 'utf8')
    const handled = new Set(
      [...source.matchAll(/^\s*case '([a-z_]+)':/gm)].map((match) => match[1]),
    )
    expect([...RULES_KINDS].filter((kind) => !handled.has(kind))).toEqual([])
  })

  /* And the reverse, so the switch does not accumulate branches for kinds that no longer
     reach it -- an unreachable branch reads as support for something the tab never opens
     on. */
  it('promises a tab to every kind RulesTab.jsx has a branch for', () => {
    const source = readFileSync(new URL('./RulesTab.jsx', import.meta.url), 'utf8')
    const handled = [...source.matchAll(/^\s*case '([a-z_]+)':/gm)].map((match) => match[1])
    expect(handled.filter((kind) => !RULES_KINDS.includes(kind))).toEqual([])
  })
})

describe('resolveSpace', () => {
  const spaces = [
    { id: 'space:a', kind: 'space', segmentId: 'spa_1', name: 'Prod' },
    { id: 'space:b', kind: 'space', segmentId: 'spa_2', name: 'Staging' },
  ]

  it('prefers the space the node itself carries', () => {
    expect(resolveSpace(node('audience', { spaceId: 'spa_2' }), spaces)).toEqual({
      spaceId: 'spa_2',
      inferred: false,
    })
  })

  it('treats a space node as its own answer', () => {
    const result = resolveSpace(node('space', { segmentId: 'spa_1' }), spaces)
    expect(result).toEqual({ spaceId: 'spa_1', inferred: false })
  })

  it('infers the only space when there is exactly one', () => {
    const result = resolveSpace(node('source'), [spaces[0]])
    expect(result.spaceId).toBe('spa_1')
    // Flagged, because the UI has to admit it guessed.
    expect(result.inferred).toBe(true)
  })

  it('refuses to guess between several spaces', () => {
    /* Silently picking one would show a source's fields from the wrong space,
       which looks like real data and is wrong. Force the choice instead. */
    expect(resolveSpace(node('source'), spaces).spaceId).toBeNull()
  })

  it('returns no space when the workspace has none', () => {
    expect(resolveSpace(node('source'), []).spaceId).toBeNull()
    expect(resolveSpace(node('source'), undefined).spaceId).toBeNull()
  })

  it('ignores spaces with no id rather than inferring a broken one', () => {
    expect(resolveSpace(node('source'), [{ kind: 'space', name: 'Broken' }]).spaceId).toBeNull()
  })

  it('does not throw on a missing node', () => {
    expect(resolveSpace(null, spaces).spaceId).toBeNull()
  })
})

describe('spacesFromGraph', () => {
  it('picks out the space nodes', () => {
    const graph = {
      nodes: [
        { id: 'source:a', kind: 'source' },
        { id: 'space:a', kind: 'space', segmentId: 'spa_1' },
      ],
    }
    expect(spacesFromGraph(graph).map((n) => n.id)).toEqual(['space:a'])
  })

  it('is empty for a workspace with no Unify, or no graph at all', () => {
    expect(spacesFromGraph({ nodes: [{ kind: 'source' }] })).toEqual([])
    expect(spacesFromGraph(null)).toEqual([])
  })
})

describe('reconcileTab', () => {
  it('keeps the current tab when the new node also has it', () => {
    /* Comparing the Fields of two audiences in a row should not bounce back to
       Overview between clicks. */
    expect(reconcileTab(FIELDS, node('audience'))).toBe(FIELDS)
  })

  it('falls back to Overview when the new node lacks that tab', () => {
    expect(reconcileTab(FIELDS, node('warehouse'))).toBe(OVERVIEW)
    expect(reconcileTab(RULES, node('source'))).toBe(OVERVIEW)
  })

  it('falls back to Overview with no node', () => {
    expect(reconcileTab(STYLE, null)).toBe(OVERVIEW)
  })

  /*
   * The contract the Inspector's panel body depends on, over every pair it can be asked
   * about.
   *
   * The panel picks what to render from (tab, node) together, so a tab the node does not
   * have is a component rendered against a node it was not written for. That is not a
   * blank panel: StyleTab against a zone reads a kind that is not there, and
   * `.toLowerCase()` on the missing label blanked the whole app. Inspector.jsx reconciles
   * while rendering so the pair can never occur -- which is only true while this holds.
   */
  it('never returns a tab the node does not have', () => {
    const nodes = [
      node('audience'),
      node('warehouse'),
      node('source'),
      node('destination', { bound: false }),
      node('journey', { bound: false, bindable: false }),
      { id: 'zone-unify', type: 'zone', data: { label: 'Unify' } },
    ]
    for (const candidate of nodes) {
      const available = tabsFor(candidate)
      for (const current of [BIND, OVERVIEW, FIELDS, RULES, STYLE, LINKS, ZONE]) {
        expect(available).toContain(reconcileTab(current, candidate))
      }
    }
  })
})

/*
 * The Data tab.
 *
 * It appears for exactly two kinds, and the test that matters is the negative one: a Data tab on a
 * source would be an empty textarea claiming a source has a config, which is a wrong statement about
 * Segment rather than a cosmetic slip.
 */
describe('the Data tab', () => {
  const node = (kind) => ({ id: `n:${kind}`, type: 'segmentNode', data: { kind, name: kind } })

  it('appears for a SQL Table and a Data Graph', () => {
    expect(tabsFor(node('sql_table'))).toContain(DATA)
    expect(tabsFor(node('data_graph'))).toContain(DATA)
  })

  it('appears for nothing else', () => {
    for (const kind of ['source', 'destination', 'audience', 'linked_audience', 'space', 'warehouse']) {
      expect(tabsFor(node(kind)), kind).not.toContain(DATA)
    }
  })

  it('comes before Style, because for those two kinds it is the component', () => {
    /* A Data Graph with no config and a SQL Table with no CSV are both empty boxes, so this is the
       first thing anyone does after dropping one -- and tab order is what a panel opens on. */
    const tabs = tabsFor(node('sql_table'))
    expect(tabs.indexOf(DATA)).toBeLessThan(tabs.indexOf(STYLE))
  })

  it('never appears on a zone, which has no kind at all', () => {
    expect(tabsFor({ id: 'zone-unify', type: 'zone', data: { id: 'unify' } })).not.toContain(DATA)
  })
})
