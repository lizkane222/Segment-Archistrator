/*
 * A space's identity resolution rules, as an editable table.
 *
 * Priority, identifier, and a limit that is two things at once -- a count and a window,
 * "5 Ever" or "1 Daily". Segment publishes no API for these, so unlike every other panel
 * in the inspector nothing here is read from a workspace: the table is what someone
 * typed, and it is the only record of it the diagram has. That is also why it is
 * editable at all, and why `ruleProblems` is worth having -- a table nobody can check
 * against a live space is one where a duplicate identifier has to be caught here or not
 * at all.
 *
 * Priority is *not* a stored field. It is the row's position, and the column renders
 * `index + 1`. Storing it as well would allow two rows to both claim priority 2, and the
 * resolution -- which one actually wins? -- would be a question the table could not
 * answer about itself. Reordering is therefore the only way to change a priority, which
 * is what `moveRule` and `setPriority` both do.
 *
 * Order is the whole meaning of the table: Segment walks the identifiers in priority
 * order and the first one that matches an existing profile decides the merge. So the
 * array is the document, and every helper here returns a new array rather than mutating
 * -- these run through React state.
 */

/* The windows Segment offers, in the order its own settings page lists them: shortest
   first, with the one that means "no window at all" last. */
export const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Annually', 'Ever']

export const DEFAULT_FREQUENCY = 'Ever'

/*
 * Suggestions for the identifier column, offered and never enforced.
 *
 * Identifier *names* only -- no limits and no order. Those two are the parts that differ
 * per space, and seeding a plausible default for them would put numbers on a diagram
 * that look read from the workspace and are not. A customer's own traits can be
 * identifiers too, which is the other reason this is a datalist rather than a select.
 */
export const COMMON_IDENTIFIERS = [
  'user_id',
  'email',
  'anonymous_id',
  'phone',
  'android.id',
  'android.idfa',
  'ios.id',
  'ios.idfa',
  'ga_client_id',
  'braze_id',
]

/*
 * Row ids: a counter, because `crypto` is absent from this project's test environment and
 * a monotonic id is deterministic to assert against.
 *
 * A bare counter would not do. It restarts at zero on a reload while the document still
 * holds `rule-1`, so the first row added after reopening a diagram would collide with an
 * existing one -- and a duplicate id makes `updateRule` edit the wrong row. `claimId`
 * below is what stops it: reading a stored table advances the counter past every id in
 * it, so anything minted afterwards is beyond the highest already spent.
 */
let minted = 0
const mintId = () => `rule-${(minted += 1)}`

function claimId(id) {
  const match = /^rule-(\d+)$/.exec(id)
  if (match) minted = Math.max(minted, Number(match[1]))
}

/**
 * A stored array, coerced into rows the table can render.
 *
 * Every field is defended rather than trusted: this reads a document that may have been
 * saved by an older build, hand-edited, or written before a field existed. A row that
 * cannot be salvaged at all -- not an object, no identifier text -- is dropped, because
 * a blank row in a priority-ordered table silently shifts every priority below it.
 */
export function normalizeRules(raw) {
  const seen = new Set()
  const rules = []

  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue
    const identifier = String(entry.identifier ?? '').trim()
    if (!identifier) continue

    if (typeof entry.id === 'string' && entry.id) claimId(entry.id)
    let id = typeof entry.id === 'string' && entry.id ? entry.id : mintId()
    /* A duplicated id would make React reuse one row's DOM for another and make
       `updateRule` edit whichever came first. Re-minting is the only repair. */
    while (seen.has(id)) id = mintId()
    seen.add(id)

    rules.push({
      id,
      identifier,
      limit: normalizeLimit(entry.limit),
      frequency: normalizeFrequency(entry.frequency),
    })
  }

  return rules
}

/* At least one, and whole. A limit of 0 would mean an identifier that matches nothing,
   which is not a rule but a deletion, and a limit of 2.5 is not a thing Segment can be
   told. Anything unreadable becomes 1 -- the strictest rule, so a mangled document
   errs towards fewer merges rather than more. */
function normalizeLimit(value) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number >= 1 ? number : 1
}

/* Case-insensitively, because the value round-trips through a document someone may have
   typed by hand. An unrecognised window becomes `Ever`, which is Segment's own default
   and the one that changes nothing about when a rule applies. */
function normalizeFrequency(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return FREQUENCIES.find((frequency) => frequency.toLowerCase() === text) ?? DEFAULT_FREQUENCY
}

/** Rows with their priority attached, for rendering. Never stored. */
export function withPriorities(rules) {
  return (rules ?? []).map((rule, index) => ({ ...rule, priority: index + 1 }))
}

/**
 * A new row at the end of the table.
 *
 * At the end, not the start: the lowest priority is the safe place for a rule nobody has
 * thought about yet. Inserting at the top would silently demote every existing rule and
 * change which identifier decides a merge.
 */
export function addRule(rules, patch = {}) {
  return [
    ...(rules ?? []),
    {
      id: mintId(),
      identifier: String(patch.identifier ?? '').trim(),
      limit: normalizeLimit(patch.limit ?? 1),
      frequency: normalizeFrequency(patch.frequency),
    },
  ]
}

/**
 * One field of one row.
 *
 * The identifier is *not* trimmed and the limit is *not* clamped here, though both are
 * in `normalizeRules`. A user typing "email" passes through an empty string, and a user
 * typing a limit passes through the moment the field is cleared -- normalising mid-edit
 * would fight the cursor and rewrite the "1" the moment they deleted it to type "12".
 * `ruleProblems` is what reports the intermediate states, and the save path normalises.
 */
export function updateRule(rules, id, patch) {
  return (rules ?? []).map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
}

export function removeRule(rules, id) {
  return (rules ?? []).filter((rule) => rule.id !== id)
}

/** Up or down by `delta` places, clamped. A no-op returns the same array identity. */
export function moveRule(rules, id, delta) {
  const list = rules ?? []
  const from = list.findIndex((rule) => rule.id === id)
  if (from < 0) return list
  return setPriority(list, id, from + 1 + delta)
}

/**
 * Move a row to a priority, by number.
 *
 * Splice-out-then-in rather than a swap: dragging priority 6 to priority 1 has to push
 * the other five down by one, and a swap would exchange it with whatever was at the top
 * and leave the middle four alone -- a different table from the one the user asked for.
 */
export function setPriority(rules, id, priority) {
  const list = rules ?? []
  const from = list.findIndex((rule) => rule.id === id)
  if (from < 0) return list

  const to = Math.min(Math.max(Math.floor(Number(priority)) - 1, 0), list.length - 1)
  if (!Number.isFinite(to) || to === from) return list

  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** "5 Ever", "1 Daily" -- the form the request asked for, and Segment's own wording. */
export function formatLimit(rule) {
  return `${normalizeLimit(rule?.limit)} ${normalizeFrequency(rule?.frequency)}`
}

/**
 * The inverse, for a value pasted out of Segment's settings page.
 *
 * Returns null rather than a partial guess: a paste that read half-correctly would write
 * a limit the user never chose and leave them to notice. Order is not insisted on --
 * "Ever 5" reads the same -- because the two halves are unambiguous separately.
 */
export function parseLimit(text) {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length !== 2) return null

  const number = words.find((word) => /^\d+$/.test(word))
  const window = words.find((word) => FREQUENCIES.some((f) => f.toLowerCase() === word.toLowerCase()))
  if (!number || !window) return null

  const limit = Number(number)
  return limit >= 1 ? { limit, frequency: normalizeFrequency(window) } : null
}

/**
 * What is wrong with the table, per row, in words.
 *
 * Reported rather than prevented. A half-typed row is a normal state of an editable
 * table and refusing the keystroke that produced it is the wrong cure; what matters is
 * that nobody walks a customer through a diagram whose identity rules contain a
 * duplicate nobody spotted. Keyed by row id and field so the offending cell can be
 * marked, rather than a list of sentences at the bottom.
 */
export function ruleProblems(rules) {
  const list = rules ?? []
  const problems = []
  const counts = new Map()

  for (const rule of list) {
    const key = String(rule.identifier ?? '').trim().toLowerCase()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (const rule of list) {
    const identifier = String(rule.identifier ?? '').trim()
    if (!identifier) {
      problems.push({ id: rule.id, field: 'identifier', message: 'Name the identifier.' })
    } else if (counts.get(identifier.toLowerCase()) > 1) {
      /* Two rows for one identifier means two limits for it, and the lower-priority row
         can never be the one that applies -- so this is not a style point, it is a rule
         that does nothing sitting in a table someone is reading as authoritative. */
      problems.push({
        id: rule.id,
        field: 'identifier',
        message: `${identifier} is listed more than once — only the highest priority row applies.`,
      })
    }

    const limit = Number(rule.limit)
    if (!Number.isInteger(limit) || limit < 1) {
      problems.push({
        id: rule.id,
        field: 'limit',
        message: 'The limit is a whole number of values, at least 1.',
      })
    }

    if (!FREQUENCIES.includes(rule.frequency)) {
      problems.push({
        id: rule.id,
        field: 'frequency',
        message: `Choose one of ${FREQUENCIES.join(', ')}.`,
      })
    }
  }

  return problems
}

/** The problems for one cell, for the renderer. */
export function problemFor(problems, id, field) {
  return (problems ?? []).find((problem) => problem.id === id && problem.field === field) ?? null
}

/*
 * --- Per space, in the document ---------------------------------------------
 *
 * Stored as `graph.identityRules`, a map of space id to rows, alongside `scenarios` and
 * `collapsed` and for the same reason those are top-level: the rules belong to a space,
 * not to whichever node happens to be depicting it. Two `identity_setting` components in
 * one diagram would otherwise hold two tables for one space and disagree, and
 * `serializeNode` spreads all of `data`, so a per-node field rides into the document
 * whether or not that was intended.
 *
 * What this does not do: follow a space into a *different* diagram. That needs a
 * server-side store keyed by space, which is a separate piece of work -- reopening the
 * saved diagram is what "returns to the site" means here.
 */

/** A space's rows, normalised. Empty for a space with none, never undefined. */
export function rulesForSpace(map, spaceId) {
  if (!spaceId) return []
  return normalizeRules(map?.[spaceId])
}

/**
 * The map with one space's rows replaced.
 *
 * An emptied table drops its key rather than storing `[]`. Absent and empty mean the
 * same thing for this field -- unlike `zones`, where empty has to mean "the user deleted
 * them all" -- so keeping the key would leave every space anyone ever clicked into in
 * the document, and mark it dirty for a table that was opened and closed.
 */
export function withRulesForSpace(map, spaceId, rules) {
  if (!spaceId) return map ?? {}
  const next = { ...(map ?? {}) }
  const normalized = normalizeRules(rules)
  if (normalized.length) next[spaceId] = normalized
  else delete next[spaceId]
  return next
}

/** Drop rows for spaces no longer on the canvas, so deleting a space takes its rules. */
export function pruneRules(map, spaceIds) {
  const kept = new Set(spaceIds ?? [])
  return Object.fromEntries(Object.entries(map ?? {}).filter(([id]) => kept.has(id)))
}

/*
 * Which space's rules a node is showing.
 *
 * Identity resolution is configured per space, but the components that depict it -- the
 * Identity Resolution node and the hand-written Identity Resolution Rule -- are not
 * spaces. So the space is found by walking *upstream*: a space feeds identity
 * resolution, which feeds the rest of Unify, and every one of those edges points away
 * from the space.
 *
 * Breadth-first and bounded by the node count rather than by depth, because the walk is
 * over a graph a user drew and there is nothing stopping them drawing a cycle in it.
 *
 * The fallback matters more than the walk does: a diagram with exactly one space has an
 * unambiguous answer whether or not anyone drew the edge, and a hand-placed rule
 * component usually has no edges at all. With two spaces and no edge there is no answer,
 * and inventing one would attach a table to the wrong customer's space.
 */
export function spaceIdForNode(node, nodes, edges) {
  const all = nodes ?? []
  const spaces = all.filter((entry) => (entry.data?.kind ?? entry.kind) === 'space')
  const spaceIds = new Set(spaces.map((entry) => entry.id))
  if (!node) return spaces.length === 1 ? spaces[0].id : null
  if (spaceIds.has(node.id)) return node.id

  const incoming = new Map()
  for (const edge of edges ?? []) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    incoming.get(edge.target).push(edge.source)
  }

  const seen = new Set([node.id])
  const queue = [node.id]
  while (queue.length) {
    const current = queue.shift()
    for (const source of incoming.get(current) ?? []) {
      if (spaceIds.has(source)) return source
      if (seen.has(source)) continue
      seen.add(source)
      queue.push(source)
    }
  }

  return spaces.length === 1 ? spaces[0].id : null
}
