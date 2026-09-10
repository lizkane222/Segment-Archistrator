/*
 * Mapping rows.
 *
 * What is being pinned is that a row never claims a source it does not have. The failure
 * that matters here is quiet: a directive shape nobody wrote wording for rendering as a
 * blank cell, or as some other field's path, so a customer reads the panel and concludes
 * the destination is sent something it is not. Every test below is either "this shape
 * produces this source" or "this shape says out loud that it has none".
 */

import { describe, expect, it } from 'vitest'

import { DIRECTIVE_LABELS, mappingRows } from './mappingRows.js'

const one = (value) => {
  const rows = mappingRows({ target: value })
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('nothing to show', () => {
  it.each([null, undefined, '', 0, 'a string'])('reads %s as no rows rather than throwing', (mapping) => {
    expect(mappingRows(mapping)).toEqual([])
  })

  it('names a field with no source instead of leaving the cell blank', () => {
    const row = one(undefined)
    expect(row.directive).toBe('none')
    expect(row.from).toBeNull()
    expect(row.note).toMatch(/No source is recorded/)
  })

  /* The pair is the point: `null` is a value the destination receives, and an absent
     entry is a gap in the diagram. Collapsing them would describe one as the other. */
  it('separates a field mapped to null from a field mapped to nothing', () => {
    expect(one(null)).toMatchObject({ directive: 'literal', from: 'null', note: null })
  })
})

describe('the documented directives', () => {
  it('drops the JSONPath root, which is on every path and identifies none of them', () => {
    expect(one({ '@path': '$.properties.revenue' })).toMatchObject({
      directive: 'path',
      from: 'properties.revenue',
    })
  })

  it('says so when the whole event is the source', () => {
    expect(one({ '@path': '$' }).from).toBe('the whole event')
  })

  it('leaves a path that is not rooted alone rather than trimming two characters off it', () => {
    expect(one({ '@path': 'properties.revenue' }).from).toBe('properties.revenue')
  })

  it('shows a template verbatim, since the braces are the meaning', () => {
    expect(one({ '@template': '{{properties.name}} <{{traits.email}}>' })).toMatchObject({
      directive: 'template',
      from: '{{properties.name}} <{{traits.email}}>',
    })
  })

  it.each([
    [{ '@literal': 'gift' }, '"gift"'],
    [{ '@literal': '' }, '""'],
    [{ '@literal': 42 }, '42'],
    [{ '@literal': false }, 'false'],
    ['bare string', '"bare string"'],
    [7, '7'],
    [true, 'true'],
  ])('renders %s as the fixed value %s', (value, from) => {
    expect(one(value)).toMatchObject({ directive: 'literal', from })
  })
})

describe('a conditional field', () => {
  const IF = {
    '@if': {
      exists: { '@path': '$.traits.email' },
      then: { '@path': '$.traits.email' },
      else: { '@literal': 'unknown' },
    },
  }

  it('reads the test and both branches', () => {
    const row = one(IF)
    expect(row.directive).toBe('if')
    expect(row.from).toBe('when set: traits.email')
    expect(row.note).toBeNull()
    expect(row.children.map((child) => [child.field, child.from])).toEqual([
      ['then', 'traits.email'],
      ['else', '"unknown"'],
    ])
  })

  it('distinguishes blank from exists, which select opposite events', () => {
    expect(one({ '@if': { blank: { '@path': '$.traits.email' }, then: 1 } }).from).toMatch(
      /^when blank:/,
    )
  })

  /* The commonest real shape, and the one worth a sentence: with only `then`, every event
     failing the test has this field missing from its payload — which is invisible from
     the mapping unless the panel says it. */
  it('warns that a single branch leaves the field absent for everything else', () => {
    const row = one({ '@if': { exists: { '@path': '$.traits.email' }, then: 1 } })
    expect(row.children).toHaveLength(1)
    expect(row.note).toMatch(/Only one branch/)
  })

  it('says the field is never sent when neither branch is recorded', () => {
    expect(one({ '@if': { exists: { '@path': '$.x' } } }).note).toMatch(/never sent/)
  })

  it('refuses to guess the branch when no condition is recorded', () => {
    expect(one({ '@if': { then: 1, else: 2 } })).toMatchObject({
      from: null,
      note: expect.stringMatching(/not readable/),
    })
  })

  it('does not invent a label for a test it cannot read', () => {
    const row = one({ '@if': { exists: { '@nonsense': 1 }, then: 1, else: 2 } })
    expect(row.from).toMatch(/cannot read/)
  })
})

describe('a field built per array item', () => {
  it('names the array and the per-item mapping separately', () => {
    const row = one({
      '@arrayPath': ['$.properties.products', { price: { '@path': '$.price' }, sku: 'fixed' }],
    })
    expect(row).toMatchObject({ directive: 'arrayPath', from: 'properties.products', note: null })
    expect(row.children.map((child) => child.field)).toEqual(['price', 'sku'])
    expect(row.children[0].from).toBe('price')
  })

  it('says the items go as they stand when no per-item mapping is given', () => {
    const row = one({ '@arrayPath': ['$.properties.products'] })
    expect(row.children).toEqual([])
    expect(row.note).toMatch(/as it stands/)
  })

  it('tolerates the path given on its own rather than in a list', () => {
    expect(one({ '@arrayPath': '$.properties.products' }).from).toBe('properties.products')
  })
})

describe('shapes with no directive', () => {
  it('recurses into a plain object rather than stringifying it', () => {
    const row = one({ city: { '@path': '$.context.location.city' }, country: 'US' })
    expect(row.directive).toBe('object')
    expect(row.children.map((child) => [child.field, child.from])).toEqual([
      ['city', 'context.location.city'],
      ['country', '"US"'],
    ])
  })

  it('indexes a list so a reader can point at the item they mean', () => {
    const row = one([{ '@path': '$.a' }, 'b'])
    expect(row.directive).toBe('list')
    expect(row.children.map((child) => child.field)).toEqual(['[0]', '[1]'])
  })
})

describe('shapes this was not written for', () => {
  /* Reachable, unlike conditionTree's `unsupported`: Segment adds directives, and the
     table here is what was documented at the time. Naming the directive is the honest
     answer -- a row that fell back to "not recorded" would read as a gap in the
     customer's mapping rather than a gap in this tool. */
  it('names an unrecognised directive instead of reporting the field as unmapped', () => {
    const row = one({ '@flatten': { '@path': '$.properties' } })
    expect(row.directive).toBe('unknown')
    expect(row.note).toContain('@flatten')
    expect(row.note).not.toMatch(/No source is recorded/)
  })

  it('refuses to pick one key when a directive is mixed with plain fields', () => {
    const row = one({ '@path': '$.a', fallback: '$.b' })
    expect(row.directive).toBe('unknown')
    expect(row.from).toBeNull()
    expect(row.note).toContain('@path')
    expect(row.note).toContain('fallback')
  })

  it('stops descending before the rows are too narrow to read', () => {
    let value = { '@path': '$.deep' }
    for (let i = 0; i < 8; i += 1) value = { nest: value }
    const flatten = (row) => [row, ...row.children.flatMap(flatten)]
    const rows = flatten(one(value))

    expect(rows.some((row) => row.directive === 'deeper')).toBe(true)
    expect(rows.filter((row) => row.directive === 'path')).toEqual([])
  })
})

describe('a hand-drawn mapping', () => {
  /* A node someone dragged from the palette has no API payload behind it, and the list
     is what gets typed. Every spelling below turned up in the diagrams this replaces. */
  it('reads a list of destination field names with no sources', () => {
    const rows = mappingRows(['user_id', 'email'])
    expect(rows.map((row) => row.field)).toEqual(['user_id', 'email'])
    expect(rows.every((row) => row.directive === 'none')).toBe(true)
  })

  it.each([
    [{ field: 'user_id', from: '$.userId' }, 'user_id', 'userId'],
    [{ to: 'user_id', from: { '@path': '$.userId' } }, 'user_id', 'userId'],
    [{ name: 'user_id', value: 'fixed' }, 'user_id', '"fixed"'],
  ])('reads %o as %s from %s', (entry, field, from) => {
    expect(mappingRows([entry])[0]).toMatchObject({ field, from })
  })

  it('treats a blank source as nothing recorded, not as a path to nowhere', () => {
    expect(mappingRows([{ field: 'user_id', from: '  ' }])[0]).toMatchObject({
      directive: 'none',
      from: null,
    })
  })

  it('numbers an entry it cannot find a name on, rather than titling the row undefined', () => {
    expect(mappingRows([{ from: '$.userId' }])[0].field).toBe('#1')
  })
})

describe('DIRECTIVE_LABELS', () => {
  /* A row whose badge is missing renders as blank chrome beside a field, which reads as
     a rendering fault rather than as an unlabelled kind. */
  it('labels every directive the rows can produce', () => {
    const produced = [
      undefined,
      null,
      { '@path': '$.a' },
      { '@template': 'x' },
      { '@if': { exists: { '@path': '$.a' }, then: 1 } },
      { '@arrayPath': ['$.a'] },
      { plain: 1 },
      [1],
      { '@flatten': 1 },
    ]
    const flatten = (row) => [row, ...row.children.flatMap(flatten)]
    const kinds = new Set(produced.flatMap((value) => flatten(one(value))).map((row) => row.directive))

    // The depth guard is unreachable from the fixtures above; it has its own test.
    kinds.add('deeper')

    expect([...kinds].sort()).toEqual(Object.keys(DIRECTIVE_LABELS).sort())
    for (const kind of kinds) expect(DIRECTIVE_LABELS[kind]).toBeTruthy()
  })
})
