/*
 * Palette filter state.
 *
 * A reducer rather than a pile of useStates because the filters interact: picking
 * a different tab has to clear category selections that do not exist on the new
 * tab, and "clear all" has to reset several fields atomically. Pure and exported
 * so the interaction rules can be tested without rendering anything.
 *
 * Multi-select is a union within a facet and an intersection across facets --
 * "CRM or Email" *and* "unbound". That is what people expect from filter chips,
 * and it is the only combination that never yields a surprising empty list.
 */

export const TABS = {
  components: 'components',
  catalog: 'catalog',
  workspace: 'workspace',
  events: 'events',
}

export const BOUND_ANY = 'any'
export const BOUND_YES = 'bound'
export const BOUND_NO = 'unbound'

export const initialFilters = {
  tab: TABS.components,
  search: '',
  /* Catalog tab: which catalog to browse. */
  catalogKind: 'destination',
  categories: [],
  /* Workspace tab. */
  zones: [],
  kinds: [],
  bound: BOUND_ANY,
  spaceId: null,
}

export function filtersReducer(state, action) {
  switch (action.type) {
    case 'setTab':
      /* Categories are catalog-kind specific and zones/kinds are workspace
         specific, so switching tabs drops them. Keeping them would silently
         filter the new tab by a facet its UI is not showing. */
      return { ...state, tab: action.tab, search: '', categories: [], zones: [], kinds: [] }

    case 'setSearch':
      return { ...state, search: action.search }

    case 'setCatalogKind':
      return { ...state, catalogKind: action.kind, categories: [] }

    case 'toggleCategory':
      return { ...state, categories: toggle(state.categories, action.category) }

    case 'toggleZone':
      return { ...state, zones: toggle(state.zones, action.zone) }

    case 'toggleKind':
      return { ...state, kinds: toggle(state.kinds, action.kind) }

    case 'setBound':
      return { ...state, bound: action.bound }

    case 'setSpace':
      return { ...state, spaceId: action.spaceId }

    case 'clear':
      /* Deliberately keeps `tab` and `catalogKind`: "clear filters" means clear
         the filters, not navigate somewhere else. */
      return {
        ...state,
        search: '',
        categories: [],
        zones: [],
        kinds: [],
        bound: BOUND_ANY,
        spaceId: null,
      }

    default:
      return state
  }
}

function toggle(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/** How many facets are narrowing the list, for the "Clear (3)" affordance. */
export function activeFilterCount(state) {
  return (
    /* Trimmed, because `applyWorkspaceFilters` trims too. Counting "   " as a
       filter would offer a "Clear 1 filter" button that visibly changes nothing. */
    (state.search.trim() ? 1 : 0) +
    state.categories.length +
    state.zones.length +
    state.kinds.length +
    (state.bound === BOUND_ANY ? 0 : 1) +
    (state.spaceId ? 1 : 0)
  )
}

/**
 * Filter workspace nodes client-side.
 *
 * Workspace resources are already in memory from /api/workspace/graph, so
 * filtering them locally is instant and costs no rate budget. The catalog is the
 * opposite case -- hundreds of entries, filtered server-side via query params.
 */
export function applyWorkspaceFilters(nodes, state) {
  const needle = state.search.trim().toLowerCase()

  return nodes.filter((node) => {
    if (state.zones.length && !state.zones.includes(node.zone)) return false
    if (state.kinds.length && !state.kinds.includes(node.kind)) return false

    if (state.bound === BOUND_YES && node.bound === false) return false
    if (state.bound === BOUND_NO && node.bound !== false) return false

    if (state.spaceId && node.spaceId && node.spaceId !== state.spaceId) return false

    if (needle) {
      /* Match the slug and the Segment id too: people paste ids out of the
         Segment UI far more often than they type a display name. */
      const haystack = [node.name, node.slug, node.segmentId, node.sourceType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(needle)) return false
    }

    return true
  })
}

/** Query params for the server-side catalog search. */
export function catalogQuery(state) {
  return {
    q: state.search.trim() || undefined,
    category: state.categories.length ? state.categories : undefined,
  }
}
