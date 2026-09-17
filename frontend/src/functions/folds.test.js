import { describe, expect, it } from 'vitest'

import { defaultCode } from './defaults.js'
import { allFoldableLines, foldRegions, foldsByLine, visibleRows } from './folds.js'

/* Written as line arrays so the expected line numbers below are countable by eye. */
const src = (...lines) => lines.join('\n')

describe('foldRegions', () => {
  it('folds a brace block from its opening line to its closing one', () => {
    const source = src('function onTrack(event) {', '  return event', '}')
    expect(foldRegions(source)).toEqual([{ start: 0, end: 2, kind: 'block' }])
  })

  it('leaves a block too short to hide anything alone', () => {
    /* A chevron whose region closes on the next line is a control that visibly does
       nothing when you click it. */
    expect(foldRegions(src('if (x) {', '}'))).toEqual([])
  })

  it('folds a multi-line block comment, which is the one worth folding most', () => {
    const source = src('/**', ' * A long header.', ' * Several screens of it.', ' */', 'const a = 1')
    expect(foldRegions(source)).toEqual([{ start: 0, end: 3, kind: 'comment' }])
  })

  it('ignores a brace inside a string or a comment', () => {
    /* The failure this guards against is the bad one: an unmatched `{` from a comment
       opens a region that never closes, folding the rest of the file away, which looks
       exactly like the code having been deleted. */
    const source = src(
      'function f() { // opens { here',
      '  const s = "} not a brace";',
      '  return s',
      '}',
    )
    expect(foldRegions(source)).toEqual([{ start: 0, end: 3, kind: 'block' }])
  })

  it('nests, outer first', () => {
    const source = src(
      'function outer() {',
      '  if (x) {',
      '    go()',
      '  }',
      '  return 1',
      '}',
    )
    expect(foldRegions(source)).toEqual([
      { start: 0, end: 5, kind: 'block' },
      { start: 1, end: 3, kind: 'block' },
    ])
  })

  it('survives an unbalanced source rather than inventing a region', () => {
    expect(() => foldRegions('function f() {\n  return 1\n')).not.toThrow()
    expect(() => foldRegions('}\n}\n}')).not.toThrow()
    expect(foldRegions('')).toEqual([])
    expect(foldRegions(null)).toEqual([])
  })
})

describe('foldsByLine', () => {
  it('keeps the widest region when one line opens several', () => {
    /* Only one chevron fits in the gutter, and a reader clicking it means "hide this
       whole thing". */
    const regions = [
      { start: 4, end: 6, kind: 'block' },
      { start: 4, end: 40, kind: 'block' },
    ]
    expect(foldsByLine(regions).get(4)).toEqual({ start: 4, end: 40, kind: 'block' })
  })
})

describe('visibleRows', () => {
  const source = src(
    '/**',
    ' * Header.',
    ' * More header.',
    ' */',
    'function onTrack(event) {',
    '  console.log(1)',
    '  return event',
    '}',
  )

  it('shows every line, with a chevron on the ones that fold', () => {
    const rows = visibleRows(source)
    expect(rows).toHaveLength(8)
    expect(rows.filter((row) => row.fold === 'open').map((row) => row.index)).toEqual([0, 4])
    expect(rows.every((row) => row.hidden === 0)).toBe(true)
  })

  it('hides a closed region but keeps its first line and the real numbering', () => {
    const rows = visibleRows(source, new Set([0]))
    expect(rows.map((row) => row.index)).toEqual([0, 4, 5, 6, 7])
    expect(rows[0]).toMatchObject({ index: 0, fold: 'closed', hidden: 3 })
    /* The gutter keeps counting through the fold rather than renumbering, so a line
       number in an error message still points at the line the reader can see. */
    expect(rows[1].index).toBe(4)
  })

  it('collapses everything when every foldable line is closed', () => {
    const rows = visibleRows(source, new Set(allFoldableLines(source)))
    expect(rows.map((row) => row.index)).toEqual([0, 4])
  })

  it('keeps an inner fold closed while the outer one is closed over it', () => {
    /* Opening the outer fold should find the inner one still shut, which is what makes
       folding feel like it remembers what you did. */
    const nested = src('function outer() {', '  if (x) {', '    go()', '  }', '  return 1', '}')
    const collapsed = new Set([0, 1])
    expect(visibleRows(nested, collapsed).map((row) => row.index)).toEqual([0])
    collapsed.delete(0)
    expect(visibleRows(nested, collapsed).map((row) => row.index)).toEqual([0, 1, 4, 5])
  })

  it('renders a single line with no trailing blank for a source with no newline', () => {
    expect(visibleRows('const a = 1')).toEqual([
      { index: 0, text: 'const a = 1', fold: null, hidden: 0 },
    ])
  })
})

describe('the shipped defaults', () => {
  it('all have something to fold', () => {
    /* The gutter earns its place only if the code it ships with can use it -- each
       default opens with a header comment and declares handlers. */
    for (const kind of [
      'source_function',
      'source_insert_function',
      'destination_insert_function',
      'destination_function',
    ]) {
      const lines = allFoldableLines(defaultCode(kind))
      expect(lines.length, kind).toBeGreaterThan(1)
      expect(lines, kind).toContain(0)
    }
  })

  it('collapses to a readable outline', () => {
    const code = defaultCode('source_insert_function')
    const rows = visibleRows(code, new Set(allFoldableLines(code)))
    /* Every handler signature on one row each, which is the outline someone folds a
       400-line function down to in order to find their way around it. */
    const shown = rows.map((row) => row.text.trim()).filter(Boolean)
    expect(shown).toContain('async function onTrack(event, settings) {')
    expect(shown).toContain('async function onDelete(event, settings) {')
    expect(rows.length).toBeLessThan(code.split('\n').length / 2)
  })
})
