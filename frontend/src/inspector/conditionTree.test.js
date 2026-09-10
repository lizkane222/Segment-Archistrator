/*
 * The condition breakdown.
 *
 * Two things are being pinned, and they fail differently. The wording tests say a rule
 * reads the way its author wrote it -- a breakdown that says "is" where the FQL says
 * "!=" is worse than no breakdown, because it is confidently wrong about which events a
 * filter drops. The round-trip test says every `raw` string this module hands the UI
 * re-parses to the tree it came from, which is what makes quoting a sub-expression safe
 * when the tokenizer kept no source offsets to quote from.
 */

import { describe, expect, it } from 'vitest'

import { describeCondition, format, groupLabel } from './conditionTree.js'
import { parseCondition } from '../simulation/fql.js'

const clausesOf = (source) => flatten(describeCondition(source).tree)

function flatten(node) {
  if (!node) return []
  if (node.kind === 'group') return node.children.flatMap(flatten)
  return [node]
}

const one = (source) => {
  const clauses = clausesOf(source)
  expect(clauses).toHaveLength(1)
  return clauses[0]
}

describe('a rule with no condition', () => {
  it.each([null, undefined, '', '   '])('reports %s as empty rather than as an error', (source) => {
    const result = describeCondition(source)
    expect(result).toMatchObject({ parsed: true, empty: true, error: null, tree: null })
  })
})

describe('a rule that will not parse', () => {
  /* No partial tree. A breakdown that stopped mid-rule would show a filter selecting
     fewer events than it does, which is the direction that hides a dropped event. */
  it('carries the parser’s own message and no tree at all', () => {
    const result = describeCondition('properties.revenue >')
    expect(result.parsed).toBe(false)
    expect(result.tree).toBeNull()
    expect(result.error).toBeTruthy()
  })
})

describe('comparisons', () => {
  it.each([
    ['properties.revenue = 10', 'is', '10'],
    ['properties.revenue != 10', 'is not', '10'],
    ['properties.revenue > 10', 'is greater than', '10'],
    ['properties.revenue >= 10', 'is at least', '10'],
    ['properties.revenue < 10', 'is less than', '10'],
    ['properties.revenue <= 10', 'is at most', '10'],
  ])('reads %s in the filter builder’s words', (source, operator, value) => {
    expect(one(source)).toMatchObject({
      field: 'properties.revenue',
      operator,
      values: [value],
    })
  })

  it('quotes a string value so an empty one is still visible', () => {
    expect(one('properties.plan = ""').values).toEqual(['""'])
  })

  /* `not (x = y)` is `x != y`. Drawn as a negated group around one row it would read as
     more structure than the rule has, and the reader has to invert it themselves. */
  it('folds a negation into the operator', () => {
    expect(one('not (properties.plan = "pro")')).toMatchObject({
      field: 'properties.plan',
      operator: 'is not',
      values: ['"pro"'],
    })
    expect(one('!(properties.revenue > 10)').operator).toBe('is at most')
  })

  it('cancels a double negation instead of nesting it', () => {
    expect(one('not not (properties.plan = "pro")').operator).toBe('is')
  })

  /* Written backwards by hand often enough to be worth handling: only the field belongs
     in the first column, so the operator has to turn round with it. */
  it('puts the field first when the rule was written the other way round', () => {
    expect(one('10 < properties.revenue')).toMatchObject({
      field: 'properties.revenue',
      operator: 'is greater than',
      values: ['10'],
    })
  })

  it('leaves a path on both sides alone rather than picking one arbitrarily', () => {
    expect(one('properties.a > properties.b')).toMatchObject({
      field: 'properties.a',
      operator: 'is greater than',
      values: ['properties.b'],
    })
  })
})

describe('set membership and presence', () => {
  it('lists every item of an `in` rule', () => {
    expect(one('properties.plan in ["pro", "team", "enterprise"]')).toMatchObject({
      field: 'properties.plan',
      operator: 'is one of',
      values: ['"pro"', '"team"', '"enterprise"'],
    })
  })

  it('negates an `in` rule as a whole rather than per item', () => {
    expect(one('not (properties.plan in ["pro"])').operator).toBe('is not one of')
  })

  /* `is nil` means "is not set", so the two spellings land the opposite way round from
     the way they read in FQL -- which is exactly the inversion worth a test. */
  it('reads nil as absence in both directions', () => {
    expect(one('properties.plan is nil').operator).toBe('is not set')
    expect(one('properties.plan is not nil').operator).toBe('is set')
    expect(one('not (properties.plan is nil)').operator).toBe('is set')
  })

  it('does not claim a bare field is merely set', () => {
    /* fql.js counts 0 and "" as false here, so "is set" would be wrong for a field that
       is present and empty. */
    const clause = one('properties.vip')
    expect(clause.operator).toMatch(/zero, or empty/)
    expect(clause.values).toEqual([])
  })
})

describe('function calls', () => {
  /* The commonest string rule in Segment. A filter built as "name contains x" comes back
     from the API as `contains(...) = true`, so without this it would read as unsupported
     and the breakdown would be empty on the filters people actually write. */
  it.each([
    ['contains(properties.name, "gift") = true', 'contains'],
    ['contains(properties.name, "gift") != false', 'contains'],
    ['contains(properties.name, "gift") = false', 'does not contain'],
    ['contains(properties.name, "gift") != true', 'does not contain'],
    ['contains(properties.name, "gift")', 'contains'],
    ['not contains(properties.name, "gift")', 'does not contain'],
    ['not (contains(properties.name, "gift") = false)', 'contains'],
  ])('reads %s as a %s row', (source, operator) => {
    expect(one(source)).toMatchObject({
      field: 'properties.name',
      operator,
      values: ['"gift"'],
    })
  })

  it('warns that match is a glob and not a regular expression', () => {
    const clause = one('match(properties.email, "*@acme.com")')
    expect(clause.operator).toBe('matches')
    expect(clause.note).toMatch(/regular expression/)
  })

  /* Dropping the transform would describe a case-insensitive rule as a case-sensitive
     one, which changes which events match. */
  it('keeps a value-returning transform in the field label', () => {
    expect(one('lowercase(properties.email) = "a@acme.com"')).toMatchObject({
      field: 'lowercase(properties.email)',
      path: 'properties.email',
      operator: 'is',
    })
    expect(one('length(properties.products) >= 2').field).toBe('length(properties.products)')
  })

  it('still shows a row when both sides are transformed', () => {
    expect(one('lowercase(properties.a) = lowercase(properties.b)')).toMatchObject({
      field: 'lowercase(properties.a)',
      operator: 'is',
      values: ['lowercase(properties.b)'],
    })
  })

  it('fails to parse a function called without arguments rather than inventing a row', () => {
    expect(describeCondition('typeof properties.a').parsed).toBe(false)
  })
})

describe('and, or, and nesting', () => {
  it('keeps the join, so it is clear whether all or any must match', () => {
    const all = describeCondition('properties.a = 1 and properties.b = 2')
    expect(all.tree).toMatchObject({ kind: 'group', join: 'and', negated: false })
    expect(all.clauseCount).toBe(2)

    expect(describeCondition('properties.a = 1 or properties.b = 2').tree.join).toBe('or')
  })

  it('nests a mixed rule rather than flattening the precedence away', () => {
    const tree = describeCondition('properties.a = 1 and (properties.b = 2 or properties.c = 3)').tree
    expect(tree.join).toBe('and')
    expect(tree.children[0].kind).toBe('clause')
    expect(tree.children[1]).toMatchObject({ kind: 'group', join: 'or' })
    expect(tree.children[1].children).toHaveLength(2)
  })

  it('marks a negated group instead of pushing the negation into every row', () => {
    /* `not (a and b)` is "not both", which is not "neither" -- distributing the negation
       over the rows would turn one into the other. */
    const tree = describeCondition('not (properties.a = 1 and properties.b = 2)').tree
    expect(tree).toMatchObject({ kind: 'group', join: 'and', negated: true })
    expect(tree.children.map((child) => child.operator)).toEqual(['is', 'is'])
  })

  it('counts the clauses in a deep rule, for the summary line', () => {
    const result = describeCondition(
      'properties.a = 1 and (properties.b = 2 or (properties.c = 3 and properties.d is nil))',
    )
    expect(result.clauseCount).toBe(4)
    expect(result.unsupportedCount).toBe(0)
  })
})

describe('group headings', () => {
  const headingOf = (source) => groupLabel(describeCondition(source).tree)

  /* The negated pair, which is the whole reason this wording is a tested function rather
     than a ternary in the panel. `not (a or b)` is "none", `not (a and b)` is "not all",
     and swapped over they describe opposite sets of events -- one of them claiming a
     destination receives nothing when it receives most things. */
  it.each([
    ['properties.a = 1 and properties.b = 2', 'All of these match'],
    ['properties.a = 1 or properties.b = 2', 'Any of these matches'],
    ['not (properties.a = 1 or properties.b = 2)', 'None of these match'],
    ['not (properties.a = 1 and properties.b = 2)', 'Not all of these match'],
  ])('heads %s with %s', (source, heading) => {
    expect(headingOf(source)).toBe(heading)
  })
})

/*
 * Every `raw` string handed to the UI has to re-parse to the tree it was rendered from.
 * The tokenizer keeps no source offsets, so `raw` is a re-rendering rather than a quote,
 * and without this it could quietly show a rule that says something else -- a lost
 * bracket around an `or` being the way that happens.
 */
describe('formatting an AST back to FQL', () => {
  const SOURCES = [
    'properties.revenue > 10',
    'properties.plan != "pro"',
    'properties.plan is nil',
    'properties.plan is not nil',
    'properties.plan in ["pro", "team"]',
    'contains(properties.name, "gift") = true',
    'match(properties.email, "*@acme.com")',
    'lowercase(properties.email) = "a@acme.com"',
    'length(properties.products) >= 2',
    'properties.a = 1 and properties.b = 2',
    'properties.a = 1 or properties.b = 2',
    'properties.a = 1 and (properties.b = 2 or properties.c = 3)',
    '(properties.a = 1 or properties.b = 2) and properties.c = 3',
    'not (properties.a = 1 and properties.b = 2)',
    'properties.escaped = "a \\"quoted\\" value"',
    'properties.flag = true',
    'properties.missing = nil',
  ]

  it.each(SOURCES)('re-parses its own rendering of %s', (source) => {
    const ast = parseCondition(source)
    expect(parseCondition(format(ast))).toEqual(ast)
  })

  it('keeps the brackets that carry the precedence', () => {
    /* Without them this renders as `a or b and c`, which `and` binding tighter turns
       into a different rule -- the one bug this whole test exists for. */
    const source = '(properties.a = 1 or properties.b = 2) and properties.c = 3'
    expect(format(parseCondition(source))).toContain('(')
  })

  it('adds no brackets a reader would have to explain', () => {
    expect(format(parseCondition('properties.a = 1 and properties.b = 2'))).toBe(
      'properties.a = 1 and properties.b = 2',
    )
  })

  it('renders every clause’s raw form as valid FQL', () => {
    for (const source of SOURCES) {
      for (const clause of clausesOf(source)) {
        expect(() => parseCondition(clause.raw)).not.toThrow()
      }
    }
  })

  /* Pinned as a property of the grammar rather than of this module: fql.js's operands are
     only paths, literals and calls, so both sides of every rule have a label and the
     `unsupported` guard never fires. If a grammar change makes it fire, this is the test
     that says the panel is about to show a row nobody wrote wording for. */
  it('needs the unsupported fallback for nothing the parser can produce today', () => {
    for (const source of SOURCES) {
      expect(describeCondition(source).unsupportedCount).toBe(0)
    }
  })
})
