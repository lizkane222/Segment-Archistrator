/*
 * The Space Schema surface is Alpha and its captured shapes already disagree with
 * the published samples, so these tests are mostly about tolerance: whichever
 * field name the API uses for a property's name, type, or samples, the tree still
 * comes out right.
 */

import { describe, expect, it } from 'vitest'

import {
  buildFieldTree,
  countFields,
  filterFieldTree,
  formatSample,
  normalizeEvent,
  pathsToExpand,
} from './fieldTree.js'

const props = (...names) => names.map((name) => ({ name }))

describe('buildFieldTree', () => {
  it('nests dotted paths', () => {
    const tree = buildFieldTree(props('context.page.url', 'context.page.title', 'order_id'))

    const context = tree.find((n) => n.key === 'context')
    expect(context.children.map((n) => n.key)).toEqual(['page'])
    expect(context.children[0].children.map((n) => n.key)).toEqual(['title', 'url'])
    expect(tree.find((n) => n.key === 'order_id').children).toEqual([])
  })

  it('marks intermediate nodes the API never listed as synthetic', () => {
    /* `context` is not itself a property -- it only exists because
       `context.page.url` implies it. Rendering it as a field with no type would
       read as missing data rather than as a container. */
    const tree = buildFieldTree(props('context.page.url'))
    expect(tree[0].synthetic).toBe(true)
    expect(tree[0].children[0].children[0].synthetic).toBe(false)
  })

  it('un-synthetics a container that is also listed in its own right', () => {
    const tree = buildFieldTree([
      { name: 'context', type: 'object' },
      { name: 'context.page.url', type: 'string' },
    ])
    expect(tree[0].synthetic).toBe(false)
    expect(tree[0].type).toBe('object')
  })

  it('labels an array element rather than showing the wire format', () => {
    const tree = buildFieldTree(props('products.$.sku', 'products.$.price'))
    const item = tree[0].children[0]

    expect(item.isArrayItem).toBe(true)
    // "$" as a visible label just leaks Segment's path syntax at the user.
    expect(item.label).toBe('each item')
    expect(item.children.map((n) => n.key)).toEqual(['price', 'sku'])
  })

  it('treats [] and [0] as array elements too', () => {
    for (const path of ['products.[].sku', 'products.[0].sku']) {
      const item = buildFieldTree(props(path))[0].children[0]
      expect(item.isArrayItem).toBe(true)
    }
  })

  it('reads the property name from any of the observed keys', () => {
    const tree = buildFieldTree([
      { name: 'a' },
      { property: 'b' },
      { key: 'c' },
      { path: 'd' },
      'e',
    ])
    expect(tree.map((n) => n.key).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('reads the type from any of the observed keys', () => {
    const tree = buildFieldTree([
      { name: 'a', type: 'string' },
      { name: 'b', dataType: 'number' },
      { name: 'c', valueType: 'boolean' },
    ])
    expect(tree.map((n) => n.type)).toEqual(['string', 'number', 'boolean'])
  })

  it('reads sample values from any of the observed keys, array or scalar', () => {
    const tree = buildFieldTree([
      { name: 'a', sampleValues: ['x', 'y'] },
      { name: 'b', samples: ['z'] },
      // A single sample sometimes arrives unwrapped.
      { name: 'c', sampleValue: 'solo' },
    ])
    expect(tree.find((n) => n.key === 'a').samples).toEqual(['x', 'y'])
    expect(tree.find((n) => n.key === 'b').samples).toEqual(['z'])
    expect(tree.find((n) => n.key === 'c').samples).toEqual(['solo'])
  })

  it('carries the occurrence count through when present', () => {
    const tree = buildFieldTree([{ name: 'a', count: 4210 }, { name: 'b' }])
    expect(tree.find((n) => n.key === 'a').count).toBe(4210)
    expect(tree.find((n) => n.key === 'b').count).toBeNull()
  })

  it('puts containers before leaves, alphabetically within each', () => {
    /* Otherwise a node's own scalar fields get scattered between expandable
       objects and you have to hunt for them. */
    const tree = buildFieldTree(props('zeta', 'alpha', 'nested.one', 'beta.two'))
    expect(tree.map((n) => n.key)).toEqual(['beta', 'nested', 'alpha', 'zeta'])
  })

  it('sorts case-insensitively', () => {
    expect(buildFieldTree(props('Zebra', 'apple')).map((n) => n.key)).toEqual(['apple', 'Zebra'])
  })

  it('does not duplicate a shared prefix', () => {
    const tree = buildFieldTree(props('a.b', 'a.c', 'a.d'))
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(3)
  })

  it('survives an empty, missing, or nameless input', () => {
    expect(buildFieldTree([])).toEqual([])
    expect(buildFieldTree(undefined)).toEqual([])
    expect(buildFieldTree([{ type: 'string' }, {}, null])).toEqual([])
  })

  it('ignores empty path segments rather than making a blank child', () => {
    // A trailing or doubled dot would otherwise produce an unlabelled row.
    const tree = buildFieldTree(props('a..b', 'c.'))
    expect(tree.find((n) => n.key === 'a').children.map((n) => n.key)).toEqual(['b'])
    expect(tree.find((n) => n.key === 'c').children).toEqual([])
  })
})

describe('countFields', () => {
  it('counts leaves, not containers', () => {
    // context/page are structure; url, title and order_id are the actual fields.
    const tree = buildFieldTree(props('context.page.url', 'context.page.title', 'order_id'))
    expect(countFields(tree)).toBe(3)
  })

  it('is zero for an empty tree', () => {
    expect(countFields([])).toBe(0)
    expect(countFields(undefined)).toBe(0)
  })
})

describe('filterFieldTree', () => {
  const tree = buildFieldTree(props('products.$.sku', 'products.$.price', 'context.page.url'))

  it('keeps the ancestors of a match so the path stays visible', () => {
    const filtered = filterFieldTree(tree, 'sku')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].key).toBe('products')
    expect(filtered[0].children[0].children.map((n) => n.key)).toEqual(['sku'])
  })

  it('keeps the whole subtree when the container itself matches', () => {
    /* Searching for a container means "show me what is in here", so pruning its
       children to the ones that also match the needle would be wrong. */
    const filtered = filterFieldTree(tree, 'products')
    expect(filtered[0].children[0].children.map((n) => n.key)).toEqual(['price', 'sku'])
  })

  it('matches on the full path, not only the leaf name', () => {
    const filtered = filterFieldTree(tree, 'context.page')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].key).toBe('context')
  })

  it('is case-insensitive and trims', () => {
    expect(filterFieldTree(tree, '  SKU ')).toHaveLength(1)
  })

  it('returns the tree untouched for an empty search', () => {
    expect(filterFieldTree(tree, '')).toBe(tree)
    expect(filterFieldTree(tree, '   ')).toBe(tree)
  })

  it('returns nothing on no match rather than everything', () => {
    expect(filterFieldTree(tree, 'zzz')).toEqual([])
  })

  it('does not mutate the input tree', () => {
    const before = JSON.stringify(tree)
    filterFieldTree(tree, 'sku')
    expect(JSON.stringify(tree)).toBe(before)
  })
})

describe('pathsToExpand', () => {
  it('lists every container so a search result is revealed, not hidden', () => {
    const filtered = filterFieldTree(
      buildFieldTree(props('products.$.sku', 'order_id')),
      'sku',
    )
    expect(pathsToExpand(filtered)).toEqual(['products', 'products.$'])
  })

  it('lists nothing for a flat tree', () => {
    expect(pathsToExpand(buildFieldTree(props('a', 'b')))).toEqual([])
  })
})

describe('formatSample', () => {
  it('shows strings as-is', () => {
    expect(formatSample('shoes')).toBe('shoes')
  })

  it('distinguishes an explicit null from an absent value', () => {
    // "the schema recorded null" and "there is no sample" are different facts.
    expect(formatSample(null)).toBe('null')
    expect(formatSample(undefined)).toBe('—')
  })

  it('serializes objects and arrays', () => {
    expect(formatSample({ a: 1 })).toBe('{"a":1}')
    expect(formatSample([1, 2])).toBe('[1,2]')
  })

  it('truncates long values', () => {
    /* Samples are real customer data; an unbounded blob would push the rest of
       the field list off screen. */
    const formatted = formatSample('x'.repeat(500))
    expect(formatted.length).toBeLessThan(60)
    expect(formatted.endsWith('…')).toBe(true)
  })

  it('does not throw on a circular value', () => {
    const circular = {}
    circular.self = circular
    expect(() => formatSample(circular)).not.toThrow()
  })

  it('keeps false and 0 visible', () => {
    // Both are falsy, and both are real sample values worth showing.
    expect(formatSample(false)).toBe('false')
    expect(formatSample(0)).toBe('0')
  })
})

describe('normalizeEvent', () => {
  it('accepts the observed shapes', () => {
    expect(normalizeEvent({ name: 'Order Completed', count: 12 })).toEqual({
      name: 'Order Completed',
      count: 12,
    })
    expect(normalizeEvent({ eventName: 'Signed Up' }).name).toBe('Signed Up')
    expect(normalizeEvent('Bare String').name).toBe('Bare String')
  })

  it('yields an empty name rather than throwing on junk', () => {
    expect(normalizeEvent({}).name).toBe('')
    expect(normalizeEvent(null).name).toBe('')
  })
})
