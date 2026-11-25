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

/*
 * Which sub-zone a kind is drawn in, when the diagram boxes it off.
 *
 * Sources, Destinations and Warehouse are drawing choices dividing Connections, so no workspace
 * component *stores* one of them as its zone -- it stores `connections`. A Pipeline chip for
 * "Destinations" compared against the stored zone therefore matched nothing, ever. The kind is what
 * says which box it would go in, and the kind ids are regular enough to say it by name.
 */
const SUBDIVISION_OF_KIND = (kind) => {
  if (/^source(_|$)/.test(kind)) return 'sources'
  if (/^destination(_|$)/.test(kind)) return 'destinations'
  if (kind === 'warehouse' || kind === 'reverse_etl_model') return 'warehouses'
  return null
}

/**
 * Is a workspace component in a Pipeline zone, counting the zones around it?
 *
 * Its own zone, any zone that contains that one (a destination is in Connections, and Connections is
 * in Segment), or the sub-zone its kind would be boxed in. A chip for a zone then returns everything a
 * reader would call "in" it.
 */
export function inPipelineZone(node, zoneId, topology = null) {
  if (node.zone === zoneId) return true
  const byId = new Map((topology?.zones ?? []).map((zone) => [zone.id, zone]))
  const seen = new Set()
  for (let current = byId.get(node.zone); current && !seen.has(current.id); current = byId.get(current.parent)) {
    if (current.id === zoneId) return true
    seen.add(current.id)
  }
  return SUBDIVISION_OF_KIND(node.kind) === zoneId
}

/**
 * Filter workspace nodes client-side.
 *
 * Workspace resources are already in memory from /api/workspace/graph, so
 * filtering them locally is instant and costs no rate budget. The catalog is the
 * opposite case -- hundreds of entries, filtered server-side via query params.
 */
export function applyWorkspaceFilters(nodes, state, topology = null) {
  const needle = state.search.trim().toLowerCase()

  return nodes.filter((node) => {
    if (state.zones.length && !state.zones.some((zone) => inPipelineZone(node, zone, topology))) return false
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
