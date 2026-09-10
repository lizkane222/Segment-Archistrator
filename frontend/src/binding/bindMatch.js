/*
 * Which real workspace components can be bound to a template placeholder.
 *
 * Two decisions worth stating, because both are the opposite of what "filter"
 * suggests:
 *
 *  1. The `binds` hint ranks candidates; it does not exclude them. A placeholder
 *     labelled "iOS app" suggests sources whose type is ios, but every source is
 *     still offered further down the list. The hint is the template author's
 *     guess about a workspace they have never seen, and a guess must not be able
 *     to hide the component the user is actually looking for. Kind is the one
 *     hard constraint -- binding across kinds would move a node into the wrong
 *     zone and invalidate its connections.
 *
 *  2. Components already bound elsewhere on the canvas are shown, but marked and
 *     sorted last. Binding the same source to two placeholders is usually a
 *     mistake, and occasionally exactly what someone means (the same source
 *     feeding two documented paths), so it is discouraged rather than forbidden.
 */

/** Weights, roughly "how much does this tell us it is the right component". */
const SCORE = {
  sourceType: 40,
  warehouseType: 40,
  slug: 60,
  category: 12,
  nameWord: 8,
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function list(value) {
  if (Array.isArray(value)) return value.map(lower).filter(Boolean)
  const single = lower(value)
  return single ? [single] : []
}

/* Words too generic to be evidence of anything. Matching a placeholder called
   "Product analytics" against every destination with "analytics" in its name
   would rank the whole Analytics category above an exact type match. */
const STOP_WORDS = new Set([
  'the', 'and', 'source', 'sources', 'destination', 'destinations', 'app', 'apps',
  'data', 'test', 'under', 'control', 'model', 'space', 'warehouse', 'filter',
  'trait', 'audience', 'journey', 'function', 'new', 'my', 'main', 'prod',
  'production', 'staging', 'dev',
])

function words(value) {
  return lower(value)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}

/**
 * How well does `candidate` (a real workspace node) match `binds`?
 *
 * Returns `{score, reasons}`. Reasons are shown in the UI: "why is this one at
 * the top" is the question a ranked list always provokes, and answering it is
 * what makes the ranking trustworthy rather than magic.
 */
export function scoreCandidate(binds, candidate, placeholder) {
  const reasons = []
  let score = 0

  const candidateType = lower(candidate.sourceType || candidate.warehouseType)
  for (const key of ['sourceType', 'warehouseType']) {
    const wanted = list(binds?.[key])
    if (!wanted.length || !candidateType) continue
    /* Substring rather than equality: real metadata slugs are things like
       'analytics-swift' and 'javascript-website' where the hint is 'swift' or
       'javascript'. */
    const hit = wanted.find((want) => candidateType.includes(want) || want.includes(candidateType))
    if (hit) {
      score += SCORE[key]
      reasons.push(`type ${candidateType}`)
    }
  }

  const wantedSlugs = list(binds?.slug)
  if (wantedSlugs.length && wantedSlugs.includes(lower(candidate.slug))) {
    score += SCORE.slug
    reasons.push(`slug ${candidate.slug}`)
  }

  const wantedCategories = list(binds?.categories)
  if (wantedCategories.length) {
    const shared = (candidate.categories ?? [])
      .map(lower)
      .filter((category) => wantedCategories.some((w) => category.includes(w) || w.includes(category)))
    if (shared.length) {
      score += SCORE.category * shared.length
      reasons.push(shared.length === 1 ? `category ${shared[0]}` : `${shared.length} categories`)
    }
  }

  /* Name overlap is the weakest signal and deliberately last: it is what catches
     a customer who named their source the same thing the template did. */
  const placeholderWords = new Set(words(placeholder?.name))
  const overlap = words(candidate.name).filter((word) => placeholderWords.has(word))
  if (overlap.length) {
    score += SCORE.nameWord * overlap.length
    reasons.push(`name mentions ${overlap[0]}`)
  }

  return { score, reasons }
}

/**
 * Candidates for one placeholder, best first.
 *
 * @param placeholder  the unbound node's `data`
 * @param graphNodes   canonical nodes from /api/workspace/graph
 * @param usedIds      segmentIds already bound somewhere on the canvas
 */
export function candidatesFor(placeholder, graphNodes, usedIds = new Set()) {
  const kind = placeholder?.binds?.kind ?? placeholder?.kind
  if (!kind) return []

  return (graphNodes ?? [])
    .filter((node) => node.kind === kind && node.segmentId && node.bound !== false)
    .map((node) => {
      const { score, reasons } = scoreCandidate(placeholder.binds, node, placeholder)
      const alreadyUsed = usedIds.has(node.segmentId)
      return {
        node,
        score,
        reasons,
        alreadyUsed,
        suggested: score > 0 && !alreadyUsed,
      }
    })
    .sort(compareCandidates)
}

function compareCandidates(a, b) {
  // Already-bound components sink regardless of score.
  if (a.alreadyUsed !== b.alreadyUsed) return a.alreadyUsed ? 1 : -1
  if (b.score !== a.score) return b.score - a.score
  return (a.node.name ?? '').localeCompare(b.node.name ?? '', undefined, {
    sensitivity: 'base',
  })
}

/** Every segmentId currently bound on the canvas, for the already-used marker. */
export function boundSegmentIds(nodes, exceptNodeId = null) {
  const used = new Set()
  for (const node of nodes ?? []) {
    if (node.type === 'zone' || node.id === exceptNodeId) continue
    const id = node.data?.segmentId
    if (id && node.data?.bound !== false) used.add(id)
  }
  return used
}

/*
 * The binding itself.
 *
 * Everything factual comes from the real component -- ids, links, status, the
 * masked write key. Two things are kept from the template:
 *
 *   - `binds`, so the node can be re-bound to something else later.
 *   - the template's description, but only when the real component has none.
 *     Segment descriptions are usually empty, and the template's text explains
 *     the component's *architectural role*, which is what the diagram is for.
 *
 * The pre-binding data is stashed under `placeholder` so unbinding is exact
 * rather than reconstructed.
 */
export function applyBinding(placeholder, real) {
  /* `id` is dropped along with position and style. The canvas node keeps the id it
     was created with, because every edge on the diagram references it -- adopting
     the real component's id here would leave `data.id` disagreeing with the node
     it is attached to. `segmentId` is the field that identifies the resource. */
  const { id, position, style, ...realFields } = real
  return {
    ...realFields,
    id: placeholder.id,
    /* Not from the real component: a placeholder that was hand-styled keeps its
       colours through a binding. */
    style: placeholder.style ?? null,
    binds: placeholder.binds ?? null,
    /* Collapse is a view preference about this box on this canvas, not a fact
       about the component, so it survives binding. */
    collapsed: placeholder.collapsed ?? false,
    bindable: true,
    bound: true,
    description: real.description || placeholder.description || '',
    /* The template's own label, so a bound node can still say what role it was
       drawn to play when the customer's name for it is opaque ("prod-js-2"). */
    templateName: placeholder.templateName ?? placeholder.name ?? null,
    placeholder: placeholder.placeholder ?? stashOf(placeholder),
  }
}

export function undoBinding(data) {
  /* Fall back to clearing the resource fields when there is no stash -- a node
     bound before this shipped, or one bound by hand. */
  return (
    data?.placeholder ?? {
      ...data,
      bound: false,
      segmentId: null,
      workspaceUrl: null,
      writeKeyMasked: null,
      placeholder: undefined,
    }
  )
}

/**
 * Turn a complete replacement into a patch that is safe to *merge*.
 *
 * The inspector's `onUpdate` merges into a node's existing data, so any field the
 * replacement drops would otherwise survive it: a `segmentId` left behind on a node
 * that was just unbound, or a template's `sourceType` hint left on a node bound to a
 * component that has none. Both read as the binding half-working. An explicit
 * `undefined` deletes the key on merge, and is dropped on serialization.
 */
export function replacementPatch(previous, next) {
  const patch = { ...next }
  for (const key of Object.keys(previous ?? {})) {
    if (!(key in patch)) patch[key] = undefined
  }
  return patch
}

function stashOf(placeholder) {
  const { placeholder: _nested, ...rest } = placeholder
  return rest
}
