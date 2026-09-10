/*
 * Space Schema properties -> a nested tree.
 *
 * This is the "available fields / nested data" requirement, and it exists because
 * the Space Schema API returns a *flat* list of dotted paths, not a tree:
 *
 *   properties.order_id
 *   properties.products.$.sku
 *   properties.products.$.price
 *   context.page.url
 *
 * Rendering that flat is unreadable on a real customer schema, which routinely
 * runs to hundreds of paths. So the nesting is reconstructed here.
 *
 * Pure on purpose: the parsing rules below (which separators mean what, which
 * intermediate nodes are synthetic, how a partial path is handled) are the part
 * most likely to be wrong against a live workspace, and they are far cheaper to
 * pin down in a test than by clicking through the UI.
 */

/* An array element appears as `$` in Segment's paths. `[]` and `[0]` show up in
   hand-written and older captures, so all three are accepted rather than
   producing a literal child called "[0]". */
const ARRAY_SEGMENT = /^(\$|\[\d*\])$/

/** Read a property name from whichever key this API version used. */
function pathOf(property) {
  if (typeof property === 'string') return property
  return property?.name ?? property?.property ?? property?.key ?? property?.path ?? ''
}

function typeOf(property) {
  if (typeof property === 'string') return null
  return property?.type ?? property?.dataType ?? property?.valueType ?? null
}

function samplesOf(property) {
  if (typeof property === 'string') return []
  const raw =
    property?.sampleValues ?? property?.samples ?? property?.sampleValue ?? property?.examples
  if (raw === undefined || raw === null) return []
  return Array.isArray(raw) ? raw : [raw]
}

/**
 * Build a tree from a flat Space Schema property/trait list.
 *
 * Intermediate nodes the API never listed itself are marked `synthetic: true`.
 * That distinction is worth keeping: `properties` in the example above has no
 * type and no samples of its own, and labelling it "no type reported" would read
 * as missing data rather than as a container.
 */
export function buildFieldTree(properties) {
  const roots = []
  const index = new Map() // full path -> node

  for (const property of properties ?? []) {
    const path = pathOf(property)
    if (!path) continue

    const segments = path.split('.').filter((segment) => segment !== '')
    if (!segments.length) continue

    let siblings = roots
    let prefix = ''

    segments.forEach((segment, depth) => {
      prefix = prefix ? `${prefix}.${segment}` : segment
      let node = index.get(prefix)

      if (!node) {
        node = {
          path: prefix,
          key: segment,
          isArrayItem: ARRAY_SEGMENT.test(segment),
          /* Array elements have no name of their own; showing "$" as a label
             just leaks the wire format. */
          label: ARRAY_SEGMENT.test(segment) ? 'each item' : segment,
          type: null,
          samples: [],
          count: null,
          children: [],
          synthetic: true,
        }
        index.set(prefix, node)
        siblings.push(node)
      }

      /* The API listed this exact path, so it is a real field: adopt its
         metadata. A path can be listed as both a leaf and a container (an object
         property with typed children), in which case both are true. */
      if (depth === segments.length - 1) {
        node.synthetic = false
        node.type = typeOf(property) ?? node.type
        const samples = samplesOf(property)
        if (samples.length) node.samples = samples
        const count = typeof property === 'string' ? null : property?.count
        if (count !== undefined && count !== null) node.count = count
      }

      siblings = node.children
    })
  }

  sortTree(roots)
  return roots
}

/* Containers first, then leaves, alphabetical within each. Grouping this way
   keeps a node's own scalar fields together instead of scattering them between
   expandable objects. */
function sortTree(nodes) {
  nodes.sort((a, b) => {
    const aBranch = a.children.length > 0
    const bBranch = b.children.length > 0
    if (aBranch !== bBranch) return aBranch ? -1 : 1
    return a.key.localeCompare(b.key, undefined, { sensitivity: 'base' })
  })
  for (const node of nodes) sortTree(node.children)
}

/** Leaf count, for the "142 fields" header. Containers are not fields. */
export function countFields(nodes) {
  let total = 0
  for (const node of nodes ?? []) {
    if (node.children.length) total += countFields(node.children)
    else total += 1
  }
  return total
}

/**
 * Filter the tree by a search string.
 *
 * A branch survives when it matches or when any descendant does, so searching
 * "sku" still shows the `products › each item › sku` path rather than an
 * orphaned leaf with no indication of where it lives.
 */
export function filterFieldTree(nodes, search) {
  const needle = (search ?? '').trim().toLowerCase()
  if (!needle) return nodes ?? []

  const walk = (list) =>
    list.reduce((kept, node) => {
      const children = walk(node.children)
      /* Match on the full path, not just the leaf name: someone searching
         "context.page" is describing a location, not a field name. */
      const selfMatches = node.path.toLowerCase().includes(needle)
      if (selfMatches || children.length) {
        kept.push({ ...node, children: selfMatches ? node.children : children })
      }
      return kept
    }, [])

  return walk(nodes ?? [])
}

/** Every path with a search hit, so the tree can auto-expand to reveal them. */
export function pathsToExpand(nodes) {
  const paths = []
  const walk = (list) => {
    for (const node of list) {
      if (node.children.length) {
        paths.push(node.path)
        walk(node.children)
      }
    }
  }
  walk(nodes ?? [])
  return paths
}

const SAMPLE_MAX = 48

/**
 * Render one sample value for display.
 *
 * Sample values are real customer data, so they are truncated rather than
 * wrapped: a 4KB JSON blob in a property sample would push the whole field list
 * off screen.
 */
export function formatSample(value) {
  if (value === null) return 'null'
  if (value === undefined) return '—'
  const text = typeof value === 'string' ? value : safeStringify(value)
  return text.length > SAMPLE_MAX ? `${text.slice(0, SAMPLE_MAX)}…` : text
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    // Circular, or something exotic from a future API version. Say so rather
    // than throwing inside a render.
    return String(value)
  }
}

/**
 * Normalize a Space Schema event list entry.
 *
 * Tolerant for the same reason `schemas.py` is: this surface is Alpha, and the
 * captured shapes and the published samples do not agree on field names.
 */
export function normalizeEvent(raw) {
  if (typeof raw === 'string') return { name: raw, count: null }
  return {
    name: raw?.name ?? raw?.event ?? raw?.eventName ?? '',
    count: raw?.count ?? raw?.eventCount ?? null,
  }
}
