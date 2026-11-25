import { describe, expect, it } from 'vitest'

import { applyRows, detectDelimiter, parsePaste } from './tablePaste.js'
import { normalizeTable } from './tables.js'

describe('delimited text', () => {
  it('reads CSV, quotes and all', () => {
    const { rows, header, format } = parsePaste('name,note\n"Smith, A","says ""hi"""\nJones,plain')
    expect(format).toBe('text')
    expect(rows).toEqual([
      ['name', 'note'],
      ['Smith, A', 'says "hi"'],
      ['Jones', 'plain'],
    ])
    expect(header).toBe(true)
  })
  it('reads what a spreadsheet copies: tabs', () => {
    expect(parsePaste('a\tb\n1\t2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('detects a delimiter by how evenly it splits the lines', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe('semicolon')
    expect(detectDelimiter('one sentence, with a comma, and prose\nand another line entirely')).toBe('comma')
    expect(detectDelimiter('nothing here')).toBeNull()
  })
  it('splits by whatever was typed, and rows by something else', () => {
    expect(parsePaste('a::b::c', { delimiter: 'custom', custom: '::' }).rows).toEqual([['a', 'b', 'c']])
    expect(parsePaste('a,b;c,d;e,f', { delimiter: 'comma', rowSeparator: 'custom', customRows: ';' }).rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ])
    expect(parsePaste('a|b\\nc|d', { delimiter: 'custom', custom: '|' }).rows[0]).toEqual(['a', 'b\\nc', 'd'])
  })
  it('turns a list into a row, or with transpose a column', () => {
    expect(parsePaste('a, b, c').rows).toEqual([['a', 'b', 'c']])
    expect(parsePaste('a, b, c', { transpose: true }).rows).toEqual([['a'], ['b'], ['c']])
  })
  it('puts lines without a separator in one column and skips blanks', () => {
    expect(parsePaste('one\n\ntwo\nthree').rows).toEqual([['one'], ['two'], ['three']])
  })
  it('honours an explicit header choice over the guess', () => {
    expect(parsePaste('a,b\n1,2', { header: false }).header).toBe(false)
    expect(parsePaste('1,2\n3,4').header).toBe(false)
  })
})

describe('JSON', () => {
  it('makes an array of objects a table with the keys as the header, flattening nested ones', () => {
    const { rows, header, format } = parsePaste('[{"id":1,"user":{"name":"A"}},{"id":2,"user":{"name":"B"},"extra":true}]')
    expect(format).toBe('json')
    expect(header).toBe(true)
    expect(rows).toEqual([
      ['id', 'user.name', 'extra'],
      ['1', 'A', ''],
      ['2', 'B', 'true'],
    ])
  })
  it('can keep nested values whole', () => {
    expect(parsePaste('[{"a":{"b":1}}]', { flatten: false }).rows[1]).toEqual(['{"b":1}'])
  })
  it('reads arrays of arrays and arrays of plain values', () => {
    expect(parsePaste('[[1,2],[3,4]]').rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(parsePaste('["a","b","c"]').rows).toEqual([['a'], ['b'], ['c']])
  })
  it('reads a single object as key and value, and an object of objects keyed by its keys', () => {
    expect(parsePaste('{"plan":"pro","seats":5}').rows).toEqual([
      ['key', 'value'],
      ['plan', 'pro'],
      ['seats', '5'],
    ])
    expect(parsePaste('{"u1":{"n":1},"u2":{"n":2}}').rows).toEqual([
      ['key', 'n'],
      ['u1', '1'],
      ['u2', '2'],
    ])
  })
  it('reads the comma-separated body with its brackets left off', () => {
    expect(parsePaste('{"a":1},{"a":2}').rows).toEqual([['a'], ['1'], ['2']])
    expect(parsePaste('"x","y","z"').rows).toEqual([['x'], ['y'], ['z']])
  })
})

describe('into a table', () => {
  const rows = [
    ['name', 'plan'],
    ['Avery', 'pro'],
  ]
  it('replaces with a grid sized to the data', () => {
    const table = applyRows(null, rows, { header: true })
    expect(table.cells[1][0]).toEqual({ text: 'Avery' })
    expect(table.columns).toHaveLength(2)
    expect(table.header).toBe(true)
  })
  it('adds rows underneath, growing the grid when the new data is wider', () => {
    const existing = applyRows(null, [['a'], ['b']], { header: true })
    const next = applyRows(existing, [['c', 'd']], { mode: 'rows' })
    expect(next.cells).toHaveLength(3)
    expect(next.columns).toHaveLength(2)
    expect(normalizeTable(next).cells[0]).toHaveLength(2)
    expect(next.header).toBe(true)
  })
  it('adds columns beside what is there', () => {
    const existing = applyRows(null, [['a'], ['b']])
    const next = applyRows(existing, [['x'], ['y'], ['z']], { mode: 'columns' })
    expect(next.columns).toHaveLength(2)
    expect(next.cells).toHaveLength(3)
    expect(next.cells[2][1]).toEqual({ text: 'z' })
  })
})
