import { describe, expect, it } from 'vitest'

import {
  BOUND_ANY,
  BOUND_NO,
  BOUND_YES,
  TABS,
  activeFilterCount,
  applyWorkspaceFilters,
  catalogQuery,
  filtersReducer,
  initialFilters,
} from './filters.js'

const reduce = (actions, state = initialFilters) => actions.reduce(filtersReducer, state)

describe('filtersReducer', () => {
  it('toggles a facet value on and off', () => {
    const on = filtersReducer(initialFilters, { type: 'toggleCategory', category: 'CRM' })
    expect(on.categories).toEqual(['CRM'])
    expect(filtersReducer(on, { type: 'toggleCategory', category: 'CRM' }).categories).toEqual([])
  })

  it('accumulates multiple values in one facet', () => {
    const state = reduce([
      { type: 'toggleCategory', category: 'CRM' },
      { type: 'toggleCategory', category: 'Email' },
    ])
    expect(state.categories).toEqual(['CRM', 'Email'])
  })

  it('clears tab-specific facets when the tab changes', () => {
    /* Otherwise a category selected on the Catalog tab keeps filtering the
       Workspace tab, whose UI is not showing that chip. */
    const state = reduce([
      { type: 'toggleCategory', category: 'CRM' },
      { type: 'toggleZone', zone: 'unify' },
      { type: 'setSearch', search: 'braze' },
      { type: 'setTab', tab: TABS.workspace },
    ])
    expect(state.categories).toEqual([])
    expect(state.zones).toEqual([])
    expect(state.search).toBe('')
    expect(state.tab).toBe(TABS.workspace)
  })

  it('clears categories when the catalog kind changes', () => {
    // "CRM" exists for destinations and not for warehouses.
    const state = reduce([
      { type: 'toggleCategory', category: 'CRM' },
      { type: 'setCatalogKind', kind: 'warehouse' },
    ])
    expect(state.categories).toEqual([])
    expect(state.catalogKind).toBe('warehouse')
  })

  it('clear resets facets but stays on the current tab', () => {
    const state = reduce([
      { type: 'setTab', tab: TABS.catalog },
      { type: 'setCatalogKind', kind: 'source' },
      { type: 'toggleCategory', category: 'CRM' },
      { type: 'setBound', bound: BOUND_NO },
      { type: 'clear' },
    ])
    expect(state.categories).toEqual([])
    expect(state.bound).toBe(BOUND_ANY)
    // "Clear filters" must not also navigate.
    expect(state.tab).toBe(TABS.catalog)
    expect(state.catalogKind).toBe('source')
  })

  it('ignores an unknown action', () => {
    expect(filtersReducer(initialFilters, { type: 'nope' })).toBe(initialFilters)
  })
})

describe('activeFilterCount', () => {
  it('counts nothing when untouched', () => {
    expect(activeFilterCount(initialFilters)).toBe(0)
  })

  it('does not count "any" as a binding filter', () => {
    expect(activeFilterCount({ ...initialFilters, bound: BOUND_ANY })).toBe(0)
    expect(activeFilterCount({ ...initialFilters, bound: BOUND_YES })).toBe(1)
  })

  it('sums across facets', () => {
    const state = reduce([
      { type: 'setSearch', search: 'web' },
      { type: 'toggleZone', zone: 'unify' },
      { type: 'toggleZone', zone: 'engage' },
      { type: 'setBound', bound: BOUND_NO },
    ])
    expect(activeFilterCount(state)).toBe(4)
  })

  it('ignores whitespace-only search', () => {
    expect(activeFilterCount({ ...initialFilters, search: '   ' })).toBe(0)
  })
})

describe('applyWorkspaceFilters', () => {
  const nodes = [
    { id: 'source:a', kind: 'source', zone: 'connections', name: 'Website', sourceType: 'javascript', slug: 'website', segmentId: 'abc123' },
    { id: 'source:b', kind: 'source', zone: 'connections', name: 'iOS App', sourceType: 'ios', bound: false },
    { id: 'trait:t', kind: 'computed_trait', zone: 'unify', name: 'LTV', spaceId: 'spa_1' },
    { id: 'aud:x', kind: 'audience', zone: 'engage', name: 'High value', spaceId: 'spa_1' },
    { id: 'aud:y', kind: 'audience', zone: 'engage', name: 'Churn risk', spaceId: 'spa_2' },
  ]

  const filter = (overrides) => applyWorkspaceFilters(nodes, { ...initialFilters, ...overrides })

  it('returns everything with no filters', () => {
    expect(filter({})).toHaveLength(5)
  })

  it('unions within the zone facet', () => {
    const result = filter({ zones: ['unify', 'engage'] })
    expect(result.map((n) => n.id)).toEqual(['trait:t', 'aud:x', 'aud:y'])
  })

  it('intersects across facets', () => {
    // "engage zone" AND "space 1", not either-or.
    const result = filter({ zones: ['engage'], spaceId: 'spa_1' })
    expect(result.map((n) => n.id)).toEqual(['aud:x'])
  })

  it('filters by binding state', () => {
    expect(filter({ bound: BOUND_NO }).map((n) => n.id)).toEqual(['source:b'])
    expect(filter({ bound: BOUND_YES })).toHaveLength(4)
  })

  it('searches the slug and Segment id, not just the display name', () => {
    /* People paste ids straight out of the Segment UI far more often than they
       type a display name. */
    expect(filter({ search: 'abc123' }).map((n) => n.id)).toEqual(['source:a'])
    expect(filter({ search: 'website' }).map((n) => n.id)).toEqual(['source:a'])
    expect(filter({ search: 'javascript' }).map((n) => n.id)).toEqual(['source:a'])
  })

  it('searches case-insensitively and trims', () => {
    expect(filter({ search: '  HIGH value ' }).map((n) => n.id)).toEqual(['aud:x'])
  })

  it('keeps nodes with no spaceId when a space is selected', () => {
    /* Sources are not space-scoped. Hiding them when a space filter is on would
       make the source list mysteriously empty. */
    const result = filter({ spaceId: 'spa_1' })
    expect(result.map((n) => n.id)).toContain('source:a')
  })

  it('returns an empty list rather than throwing on no match', () => {
    expect(filter({ search: 'zzzz' })).toEqual([])
  })

  it('filters by kind', () => {
    expect(filter({ kinds: ['audience'] })).toHaveLength(2)
  })
})

describe('catalogQuery', () => {
  it('omits empty facets so the URL stays clean', () => {
    expect(catalogQuery(initialFilters)).toEqual({ q: undefined, category: undefined })
  })

  it('passes categories as an array for repeated params', () => {
    const state = reduce([
      { type: 'setSearch', search: ' braze ' },
      { type: 'toggleCategory', category: 'CRM' },
      { type: 'toggleCategory', category: 'Email' },
    ])
    expect(catalogQuery(state)).toEqual({ q: 'braze', category: ['CRM', 'Email'] })
  })
})
