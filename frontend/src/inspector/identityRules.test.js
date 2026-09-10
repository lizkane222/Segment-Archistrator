import { describe, expect, it, vi } from 'vitest'

import {
  COMMON_IDENTIFIERS,
  DEFAULT_FREQUENCY,
  FREQUENCIES,
  addRule,
  formatLimit,
  moveRule,
  normalizeRules,
  parseLimit,
  problemFor,
  pruneRules,
  removeRule,
  ruleProblems,
  rulesForSpace,
  setPriority,
  spaceIdForNode,
  updateRule,
  withPriorities,
  withRulesForSpace,
} from './identityRules.js'

const table = (...identifiers) =>
  normalizeRules(identifiers.map((identifier, index) => ({ id: `r${index}`, identifier })))

const ids = (rules) => rules.map((rule) => rule.identifier)

describe('the frequency vocabulary', () => {
  it('is the five the request names, shortest window first', () => {
    expect(FREQUENCIES).toEqual(['Daily', 'Weekly', 'Monthly', 'Annually', 'Ever'])
  })

  it('defaults to the one that means no window', () => {
    /* Ever is Segment's own default and the only choice that cannot narrow when a rule
       applies, so it is the safe thing to fall back to for a value nobody set. */
    expect(DEFAULT_FREQUENCY).toBe('Ever')
    expect(FREQUENCIES).toContain(DEFAULT_FREQUENCY)
  })

  it('suggests identifier names and no limits with them', () => {
    /* The names are documented Segment identifiers; the limits and the order are what
       differ per space. A default limit here would put a number on a diagram that reads
       as though it came from the workspace. */
    expect(COMMON_IDENTIFIERS).toContain('user_id')
    expect(COMMON_IDENTIFIERS).toContain('email')
    expect(COMMON_IDENTIFIERS.every((entry) => typeof entry === 'string')).toBe(true)
  })
})

describe('normalizeRules', () => {
  it('reads a stored table back as it was', () => {
    const rules = normalizeRules([{ id: 'a', identifier: 'user_id', limit: 1, frequency: 'Ever' }])
    expect(rules).toEqual([{ id: 'a', identifier: 'user_id', limit: 1, frequency: 'Ever' }])
  })

  it('is empty for anything that is not a table', () => {
    expect(normalizeRules(null)).toEqual([])
    expect(normalizeRules(undefined)).toEqual([])
    expect(normalizeRules('user_id')).toEqual([])
    expect(normalizeRules([null, 7, 'x'])).toEqual([])
  })

  it('drops a row with no identifier rather than keeping a blank one', () => {
    /* A blank row in a priority-ordered table shifts every priority below it, so the
       table would read differently from the one that was saved. */
    const rules = normalizeRules([
      { identifier: 'user_id' },
      { identifier: '   ' },
      {},
      { identifier: 'email' },
    ])
    expect(ids(rules)).toEqual(['user_id', 'email'])
  })

  it('trims the identifier, so two spellings of one name collide as they should', () => {
    expect(normalizeRules([{ identifier: '  email  ' }])[0].identifier).toBe('email')
  })

  it('floors a fractional limit and refuses one below 1', () => {
    /* A limit of 0 is not a rule, it is a deletion; 2.5 is not something Segment can be
       told. Falling back to 1 errs towards fewer merges, which is the recoverable
       direction -- two profiles that should be one is a support ticket, one profile that
       should be two is a customer seeing someone else's data. */
    const limits = normalizeRules([
      { identifier: 'a', limit: 2.7 },
      { identifier: 'b', limit: 0 },
      { identifier: 'c', limit: -3 },
      { identifier: 'd', limit: 'five' },
      { identifier: 'e' },
    ]).map((rule) => rule.limit)
    expect(limits).toEqual([2, 1, 1, 1, 1])
  })

  it('accepts a frequency in any case and falls back for one it does not know', () => {
    const frequencies = normalizeRules([
      { identifier: 'a', frequency: 'daily' },
      { identifier: 'b', frequency: 'ANNUALLY' },
      { identifier: 'c', frequency: 'Fortnightly' },
      { identifier: 'd' },
    ]).map((rule) => rule.frequency)
    expect(frequencies).toEqual(['Daily', 'Annually', 'Ever', 'Ever'])
  })

  it('mints an id for a row that has none', () => {
    const rules = normalizeRules([{ identifier: 'user_id' }])
    expect(rules[0].id).toBeTruthy()
  })

  it('re-mints a duplicated id rather than letting two rows share one', () => {
    /* Two rows with one id makes React reuse one row's inputs for the other, and
       `updateRule` edit whichever comes first -- so editing the second row silently
       edits the first. */
    const rules = normalizeRules([
      { id: 'same', identifier: 'user_id' },
      { id: 'same', identifier: 'email' },
    ])
    expect(rules).toHaveLength(2)
    expect(rules[0].id).not.toBe(rules[1].id)
  })

  it('does not mint an id a stored row already holds', async () => {
    /* The reload collision: the counter starts at zero in a fresh tab while the document
       still holds rule-1, so a row added after reopening would collide with one already
       there. Reading the table has to claim the ids in it.

       Imported fresh, because the counter is module state and a reload is the whole
       premise. Asserting this against the module the rest of the file shares proves
       nothing: the tests above have already minted past rule-2, so the ids collide with
       nothing and the assertion holds whether or not anything claims them. */
    vi.resetModules()
    const fresh = await import('./identityRules.js')

    const stored = fresh.normalizeRules([
      { id: 'rule-1', identifier: 'user_id' },
      { id: 'rule-2', identifier: 'email' },
    ])
    const added = fresh.addRule(stored, { identifier: 'phone' })
    expect(new Set(added.map((rule) => rule.id)).size).toBe(3)
  })
})

describe('withPriorities', () => {
  it('numbers from 1 down the array', () => {
    expect(withPriorities(table('user_id', 'email')).map((rule) => rule.priority)).toEqual([1, 2])
  })

  it('does not store the priority it renders', () => {
    /* The reason the column is derived: two rows both claiming priority 2 would leave the
       table unable to answer which identifier actually decides a merge, which is the one
       question it exists to answer. */
    expect(table('user_id')[0].priority).toBeUndefined()
  })

  it('is empty rather than throwing for no table at all', () => {
    expect(withPriorities(null)).toEqual([])
  })
})

describe('addRule', () => {
  it('adds at the lowest priority, not the highest', () => {
    /* Inserting at the top would demote every existing rule and change which identifier
       decides a merge -- as a side effect of clicking Add. */
    const rules = addRule(table('user_id', 'email'), { identifier: 'phone' })
    expect(ids(rules)).toEqual(['user_id', 'email', 'phone'])
  })

  it('starts a new row at 1 Ever', () => {
    const [rule] = addRule([], {})
    expect(formatLimit(rule)).toBe('1 Ever')
  })

  it('does not mutate the table it was given', () => {
    const before = table('user_id')
    addRule(before, { identifier: 'email' })
    expect(before).toHaveLength(1)
  })
})

describe('updateRule', () => {
  it('changes one field of one row', () => {
    const rules = updateRule(table('user_id', 'email'), table('user_id', 'email')[1].id, {
      limit: 5,
    })
    expect(rules[0].limit).toBe(1)
  })

  it('leaves a half-typed value alone rather than normalising mid-edit', () => {
    /* Clamping here would rewrite the field the moment someone cleared it to type "12",
       and trimming would stop them typing a space. `ruleProblems` reports the
       intermediate state instead, and the save path normalises. */
    const rules = table('user_id')
    expect(updateRule(rules, rules[0].id, { limit: '' })[0].limit).toBe('')
    expect(updateRule(rules, rules[0].id, { identifier: 'user ' })[0].identifier).toBe('user ')
  })

  it('ignores an id that is not in the table', () => {
    const rules = table('user_id')
    expect(updateRule(rules, 'nope', { limit: 9 })).toEqual(rules)
  })
})

describe('removeRule', () => {
  it('takes the row and closes the gap in the priorities', () => {
    const rules = table('user_id', 'email', 'phone')
    const left = removeRule(rules, rules[1].id)
    expect(withPriorities(left).map((rule) => [rule.priority, rule.identifier])).toEqual([
      [1, 'user_id'],
      [2, 'phone'],
    ])
  })
})

describe('moveRule and setPriority', () => {
  it('moves a row up and down by one', () => {
    const rules = table('a', 'b', 'c')
    expect(ids(moveRule(rules, rules[2].id, -1))).toEqual(['a', 'c', 'b'])
    expect(ids(moveRule(rules, rules[0].id, 1))).toEqual(['b', 'a', 'c'])
  })

  it('stops at the ends instead of falling off them', () => {
    const rules = table('a', 'b')
    expect(ids(moveRule(rules, rules[0].id, -1))).toEqual(['a', 'b'])
    expect(ids(moveRule(rules, rules[1].id, 1))).toEqual(['a', 'b'])
  })

  it('pushes the rows it passes down rather than swapping with one', () => {
    /* The distinction that matters: sending priority 4 to priority 1 has to make the old
       1, 2 and 3 into 2, 3 and 4. A swap would exchange it with the top row and leave the
       middle two where they were, which is a different table from the one asked for. */
    const rules = table('a', 'b', 'c', 'd')
    expect(ids(setPriority(rules, rules[3].id, 1))).toEqual(['d', 'a', 'b', 'c'])
  })

  it('clamps a priority outside the table', () => {
    const rules = table('a', 'b', 'c')
    expect(ids(setPriority(rules, rules[0].id, 99))).toEqual(['b', 'c', 'a'])
    expect(ids(setPriority(rules, rules[2].id, -4))).toEqual(['c', 'a', 'b'])
  })

  it('returns the same array when nothing moves', () => {
    /* Identity, not just equality: this feeds React state, and a new array every
       keystroke would mark the document dirty for a move nobody made. */
    const rules = table('a', 'b')
    expect(setPriority(rules, rules[0].id, 1)).toBe(rules)
    expect(setPriority(rules, 'nope', 2)).toBe(rules)
    expect(setPriority(rules, rules[0].id, 'x')).toBe(rules)
  })
})

describe('formatLimit', () => {
  it('reads as the request wrote it', () => {
    expect(formatLimit({ limit: 5, frequency: 'Ever' })).toBe('5 Ever')
    expect(formatLimit({ limit: 1, frequency: 'Daily' })).toBe('1 Daily')
  })

  it('formats a mangled row without printing NaN at a customer', () => {
    expect(formatLimit({})).toBe('1 Ever')
    expect(formatLimit(null)).toBe('1 Ever')
  })
})

describe('parseLimit', () => {
  it('reads a value pasted out of the settings page', () => {
    expect(parseLimit('5 Ever')).toEqual({ limit: 5, frequency: 'Ever' })
    expect(parseLimit('  1   daily ')).toEqual({ limit: 1, frequency: 'Daily' })
  })

  it('takes the two halves in either order', () => {
    expect(parseLimit('Ever 5')).toEqual({ limit: 5, frequency: 'Ever' })
  })

  it('refuses anything it cannot read completely', () => {
    /* Null rather than a half-guess: a paste read as "1 Ever" because only the window
       parsed would write a limit the user never chose and leave them to notice. */
    expect(parseLimit('5')).toBe(null)
    expect(parseLimit('Ever')).toBe(null)
    expect(parseLimit('5 Fortnightly')).toBe(null)
    expect(parseLimit('five Ever')).toBe(null)
    expect(parseLimit('0 Ever')).toBe(null)
    expect(parseLimit('1 2 Ever')).toBe(null)
    expect(parseLimit('')).toBe(null)
    expect(parseLimit(null)).toBe(null)
  })
})

describe('ruleProblems', () => {
  it('is silent about a table that is fine', () => {
    expect(ruleProblems(table('user_id', 'email'))).toEqual([])
  })

  it('names a blank identifier', () => {
    const rules = [{ id: 'a', identifier: '', limit: 1, frequency: 'Ever' }]
    expect(problemFor(ruleProblems(rules), 'a', 'identifier').message).toMatch(/name the identifier/i)
  })

  it('reports a duplicate identifier on both rows and says which one applies', () => {
    /* Not a style point: the lower-priority row can never be the one that applies, so it
       is a rule doing nothing in a table someone is reading as authoritative. */
    const rules = [
      { id: 'a', identifier: 'email', limit: 1, frequency: 'Ever' },
      { id: 'b', identifier: 'Email', limit: 5, frequency: 'Ever' },
    ]
    const problems = ruleProblems(rules)
    expect(problemFor(problems, 'a', 'identifier')).toBeTruthy()
    expect(problemFor(problems, 'b', 'identifier').message).toMatch(/highest priority/i)
  })

  it('reports a limit that is blank, fractional or below one', () => {
    for (const limit of ['', '0', 0, 2.5, -1, 'x']) {
      const rules = [{ id: 'a', identifier: 'email', limit, frequency: 'Ever' }]
      expect(problemFor(ruleProblems(rules), 'a', 'limit'), String(limit)).toBeTruthy()
    }
  })

  it('accepts a limit typed as digits, which is what an input gives back', () => {
    /* A number input hands back a string. Reporting "5" as a bad limit would light up
       every row the moment it was edited. */
    const rules = [{ id: 'a', identifier: 'email', limit: '5', frequency: 'Ever' }]
    expect(ruleProblems(rules)).toEqual([])
  })

  it('reports an unknown frequency and lists the five', () => {
    const rules = [{ id: 'a', identifier: 'email', limit: 1, frequency: 'Fortnightly' }]
    expect(problemFor(ruleProblems(rules), 'a', 'frequency').message).toContain('Annually')
  })

  it('finds nothing to say about no table', () => {
    expect(ruleProblems(null)).toEqual([])
    expect(problemFor(null, 'a', 'limit')).toBe(null)
  })
})

describe('rules per space', () => {
  it('reads a space back out of the document', () => {
    const map = { 'space:1': [{ id: 'a', identifier: 'user_id', limit: 1, frequency: 'Ever' }] }
    expect(ids(rulesForSpace(map, 'space:1'))).toEqual(['user_id'])
  })

  it('is empty for a space with no rules and for no space at all', () => {
    expect(rulesForSpace({}, 'space:1')).toEqual([])
    expect(rulesForSpace(null, 'space:1')).toEqual([])
    expect(rulesForSpace({ 'space:1': [] }, null)).toEqual([])
  })

  it('keeps one space out of another', () => {
    const map = withRulesForSpace(
      withRulesForSpace({}, 'space:1', table('user_id')),
      'space:2',
      table('email'),
    )
    expect(ids(rulesForSpace(map, 'space:1'))).toEqual(['user_id'])
    expect(ids(rulesForSpace(map, 'space:2'))).toEqual(['email'])
  })

  it('drops the key when a table is emptied instead of storing an empty array', () => {
    /* Absent and empty mean the same thing for this field, so keeping the key would leave
       every space anyone clicked into in the document -- and mark it unsaved for a table
       that was opened and closed. */
    const map = withRulesForSpace({ 'space:1': table('user_id') }, 'space:1', [])
    expect(map).toEqual({})
    expect('space:1' in map).toBe(false)
  })

  it('does not mutate the map it was given', () => {
    const before = { 'space:1': table('user_id') }
    withRulesForSpace(before, 'space:2', table('email'))
    expect(Object.keys(before)).toEqual(['space:1'])
  })

  it('prunes the rules of a space that is no longer on the canvas', () => {
    /* Otherwise deleting a space leaves its rules in the document forever, invisible and
       still counting towards the unsaved-changes check. */
    const map = { 'space:1': table('user_id'), 'space:2': table('email') }
    expect(Object.keys(pruneRules(map, ['space:1']))).toEqual(['space:1'])
    expect(pruneRules(map, [])).toEqual({})
    expect(pruneRules(null, ['space:1'])).toEqual({})
  })
})

describe('spaceIdForNode', () => {
  const node = (id, kind) => ({ id, data: { kind } })
  const edge = (source, target) => ({ id: `${source}->${target}`, source, target })

  const CANVAS = [
    node('space:1', 'space'),
    node('ir:1', 'identity_resolution'),
    node('trait:1', 'computed_trait'),
    node('rule:1', 'identity_setting'),
  ]

  it('answers with the space itself', () => {
    expect(spaceIdForNode(node('space:1', 'space'), CANVAS, [])).toBe('space:1')
  })

  it('walks upstream to the space that feeds a node', () => {
    /* Upstream, because every edge in Unify points away from the space -- a space feeds
       identity resolution, which feeds the traits. Following the arrows would walk away
       from the answer. */
    const edges = [edge('space:1', 'ir:1'), edge('ir:1', 'trait:1')]
    expect(spaceIdForNode(node('trait:1', 'computed_trait'), CANVAS, edges)).toBe('space:1')
  })

  it('falls back to the only space on the canvas when nothing is wired', () => {
    /* The commonest case for the hand-placed rule component, which usually has no edges
       at all: one space is an unambiguous answer whether or not anyone drew the arrow. */
    expect(spaceIdForNode(node('rule:1', 'identity_setting'), CANVAS, [])).toBe('space:1')
    /* And with nothing selected at all, which is its own branch. */
    expect(spaceIdForNode(null, CANVAS, [])).toBe('space:1')
  })

  it('refuses to guess between two spaces', () => {
    /* The important refusal. Attaching a table to the wrong space files a customer's
       identity rules under the wrong space and nothing on screen would say so. */
    const two = [...CANVAS, node('space:2', 'space')]
    expect(spaceIdForNode(node('rule:1', 'identity_setting'), two, [])).toBe(null)
    /* Refused for no selection too. That branch returns before the walk, so the ambiguity
       has to be counted twice -- asserting it only against a node leaves the no-selection
       copy free to guess. */
    expect(spaceIdForNode(null, two, [])).toBe(null)
  })

  it('still finds the wired space when there are two', () => {
    const two = [...CANVAS, node('space:2', 'space')]
    const edges = [edge('space:2', 'ir:1')]
    expect(spaceIdForNode(node('ir:1', 'identity_resolution'), two, edges)).toBe('space:2')
  })

  it('is null when there is no space at all', () => {
    expect(spaceIdForNode(node('rule:1', 'identity_setting'), [node('rule:1')], [])).toBe(null)
    expect(spaceIdForNode(null, [], [])).toBe(null)
  })

  it('terminates on a cycle the user drew', () => {
    /* The graph is whatever someone dragged out, and nothing stops them wiring a loop.
       A walk with no seen-set would hang the panel, on the thread that renders it. */
    const nodes = [node('space:1', 'space'), node('a', 'computed_trait'), node('b', 'computed_trait')]
    const edges = [edge('a', 'b'), edge('b', 'a')]
    expect(spaceIdForNode(node('a', 'computed_trait'), nodes, edges)).toBe('space:1')
  })
})
