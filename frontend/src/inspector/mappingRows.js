/*
 * An actions destination's field mapping, as rows.
 *
 * The request asks for the individual fields rather than a count of them, and a mapping's
 * values are not values: they are directives -- `{"@path": "$.properties.revenue"}` and
 * its relatives -- saying where the destination's own field is fetched from. Rendering
 * the raw JSON puts the answer on screen without answering anything, which is what the
 * existing actions row does and why it is not the model for this one.
 *
 * Nothing here resolves a directive against an event. That is the line router.js already
 * draws at `visitMapping`: which mapping fires is simulated, what the destination
 * receives is not, because resolving it means reproducing that integration's payload
 * shape and being wrong about it later.
 *
 * The directive table is deliberately short. Only the five whose semantics are documented
 * get wording; anything else `@`-prefixed becomes a row that names the directive and stops.
 * Unlike conditionTree's `unsupported` guard this branch is reachable and expected to
 * fire -- Segment adds directives, and naming one is honest where describing it would be
 * a guess about what a customer's payload contains.
 */

/* Reading depth, not recursion safety: a mapping five levels of `@if` deep is not
   legible in a 20rem panel however it is drawn, and the workspace is a better place to
   read it than a column two characters wide. */
const MAX_DEPTH = 5

/** The badge each row carries, keyed by `row.directive`. */
export const DIRECTIVE_LABELS = {
  path: 'from',
  template: 'template',
  literal: 'fixed',
  if: 'conditional',
  arrayPath: 'per item of',
  object: 'nested',
  list: 'list',
  none: 'not recorded',
  unknown: 'unrecognised',
  deeper: 'nested further',
}

/**
 * One row per destination field.
 *
 * @param mapping the mapping object as the API returns it, keyed by destination field.
 *   A hand-drawn array is read too -- see `entriesOf`.
 * @returns `[{field, directive, from, note, children}]`. `children` is always an array,
 *   so a renderer never has to test for it.
 */
export function mappingRows(mapping) {
  return entriesOf(mapping).map(([field, value]) => row(field, value, 0))
}

/*
 * The two shapes a mapping arrives in.
 *
 * Keyed by destination field is what the API returns. The array is what someone drawing
 * a diagram by hand types, and they type it three ways -- so the label and the source
 * are each looked for under the spellings that turn up rather than one being declared
 * correct and the others rendering blank.
 */
function entriesOf(mapping) {
  if (!mapping || typeof mapping !== 'object') return []
  if (!Array.isArray(mapping)) return Object.entries(mapping)

  return mapping.map((entry, index) => {
    const fallback = `#${index + 1}`
    if (typeof entry === 'string') return [entry, undefined]
    if (!entry || typeof entry !== 'object') return [fallback, entry]

    const field = entry.field ?? entry.to ?? entry.name ?? fallback
    /* `from` and `value` are not two spellings of one key. `from` names a source, so a
       bare string under it is a path someone did not wrap in a directive -- reading it as
       a fixed value would tell a customer their destination receives the text
       "$.userId". `value` is the opposite key and means exactly that literal. */
    if ('from' in entry) return [String(field), asSource(entry.from)]
    if ('value' in entry) return [String(field), entry.value]
    return [String(field), undefined]
  })
}

/* A blank string is nothing recorded rather than a path to nowhere: it would otherwise
   render as a "from" badge with an empty cell after it, which reads as a broken panel. */
const asSource = (value) => {
  if (typeof value !== 'string') return value
  return value.trim() ? { '@path': value } : undefined
}

function row(field, value, depth) {
  const base = { field, directive: 'none', from: null, note: null, children: [] }

  /* Distinct from null on purpose: a field mapped to null is sent as null, and a field
     with nothing recorded against it is a gap in the diagram. */
  if (value === undefined) {
    return { ...base, note: 'No source is recorded for this field.' }
  }

  if (value === null || typeof value !== 'object') {
    return { ...base, directive: 'literal', from: literalLabel(value) }
  }

  if (depth >= MAX_DEPTH) {
    return {
      ...base,
      directive: 'deeper',
      note: 'Nested deeper than this panel reads — open the mapping in the workspace.',
    }
  }

  if (Array.isArray(value)) {
    return {
      ...base,
      directive: 'list',
      children: value.map((item, index) => row(`[${index}]`, item, depth + 1)),
    }
  }

  const keys = Object.keys(value)
  const directives = keys.filter((key) => key.startsWith('@'))

  if (directives.length === 0) {
    return {
      ...base,
      directive: 'object',
      children: keys.map((key) => row(key, value[key], depth + 1)),
    }
  }

  /* A directive object carries exactly one key. Anything else is either a shape this was
     written before or a mistake in a hand-drawn node, and both want naming rather than
     one of the keys being picked to describe the row. */
  if (keys.length > 1) {
    return {
      ...base,
      directive: 'unknown',
      note: `Recorded as ${keys.join(', ')} together, which is not one directive — shown by name only rather than guessed at.`,
    }
  }

  switch (directives[0]) {
    case '@path':
      return { ...base, directive: 'path', from: pathLabel(value['@path']) }

    case '@literal':
      return { ...base, directive: 'literal', from: literalLabel(value['@literal']) }

    case '@template':
      return { ...base, directive: 'template', from: String(value['@template'] ?? '') }

    case '@if':
      return conditionalRow(field, value['@if'], depth)

    case '@arrayPath':
      return arrayPathRow(field, value['@arrayPath'], depth)

    default:
      return {
        ...base,
        directive: 'unknown',
        note: `${directives[0]} is a directive this panel has no wording for, so the field is named and left at that.`,
      }
  }
}

/*
 * `@if`, whose branches are the interesting part.
 *
 * A conditional field is the commonest reason a destination receives a field for some
 * events and not others, and with only one branch recorded it receives nothing for the
 * rest -- which is why a missing branch is called out rather than rendered as an absence.
 */
function conditionalRow(field, spec, depth) {
  const test = spec && typeof spec === 'object' ? spec : {}
  const operator = ['exists', 'blank'].find((key) => key in test) ?? null

  const children = []
  if ('then' in test) children.push(row('then', test.then, depth + 1))
  if ('else' in test) children.push(row('else', test.else, depth + 1))

  return {
    field,
    directive: 'if',
    from: operator
      ? `${operator === 'exists' ? 'when set:' : 'when blank:'} ${sourceLabel(test[operator], depth)}`
      : null,
    note: note(operator, children),
    children,
  }
}

function note(operator, children) {
  if (children.length === 0) return 'Neither branch is recorded, so this field is never sent.'
  if (!operator) return 'No condition is recorded, so which branch is taken is not readable here.'
  if (children.length === 1) {
    return 'Only one branch is recorded — for events on the other side of the condition this field is absent.'
  }
  return null
}

function arrayPathRow(field, spec, depth) {
  const [path, shape] = Array.isArray(spec) ? spec : [spec, undefined]
  const nested = shape && typeof shape === 'object' && !Array.isArray(shape)

  return {
    field,
    directive: 'arrayPath',
    from: typeof path === 'string' ? pathLabel(path) : sourceLabel(path, depth),
    note: nested ? null : 'Each item is sent as it stands, with no per-item mapping.',
    children: nested ? Object.keys(shape).map((key) => row(key, shape[key], depth + 1)) : [],
  }
}

/* A directive nested where a label is wanted rather than a row -- inside an `@if` test.
   Reusing `row` keeps one reader of the directive grammar; the label is the same string
   the row would have shown. */
function sourceLabel(value, depth) {
  return row('', value, depth + 1).from ?? 'something this panel cannot read'
}

/* JSONPath against the event, always rooted at `$`. Dropping the root reads as the field
   path a customer would recognise; `$` alone is the whole event and has to say so. */
function pathLabel(value) {
  if (typeof value !== 'string') return value == null ? null : String(value)
  const text = value.trim()
  if (text === '$') return 'the whole event'
  return text.startsWith('$.') ? text.slice(2) : text
}

/* Quoted, so a fixed empty string is visible as one rather than as a blank cell. */
function literalLabel(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}
