/*
 * The CSV parser and the query subset.
 *
 * This is a hand-written subset of SQL, chosen over a 1.5MB WASM SQLite for reasons in the module
 * header. The trade only holds if the subset is *honest*: anything it cannot do has to be refused with
 * a reason, never quietly ignored. A WHERE clause that parsed as "true" because the parser did not
 * understand it would show the reader a filtered table that is not filtered — which is worse than an
 * error, because nothing on screen says so.
 *
 * So the refusals get as much attention here as the happy paths.
 */

import { describe, expect, it } from 'vitest'

import { MAX_ROWS, SUPPORTED, parseCsv, runQuery } from './sqlTable.js'

const CSV = `id,email,plan,total
1,a@example.com,pro,120
2,b@example.com,free,0
3,c@example.com,pro,45
4,d@example.com,,900`

const table = () => parseCsv(CSV)
const run = (query) => runQuery(query, table())

describe('parseCsv', () => {
  it('reads a header and rows', () => {
    const { columns, rows } = table()
    expect(columns).toEqual(['id', 'email', 'plan', 'total'])
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ id: '1', email: 'a@example.com', plan: 'pro', total: '120' })
  })

  it('handles a quoted field with a comma in it', () => {
    /* The first thing that breaks a `split(',')`, and it is in every real warehouse export. */
    const { rows } = parseCsv('name,note\n"Acme, Inc.",big')
    expect(rows[0]).toEqual({ name: 'Acme, Inc.', note: 'big' })
  })

  it('handles a doubled quote and an embedded newline', () => {
    const { rows } = parseCsv('a,b\n"say ""hi""","two\nlines"')
    expect(rows[0].a).toBe('say "hi"')
    expect(rows[0].b).toBe('two\nlines')
  })

  it('treats CRLF as one break', () => {
    /* Without this every other row is empty, which reads as a corrupted file. */
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('drops the empty row a trailing newline creates', () => {
    expect(parseCsv('a\n1\n').rows).toEqual([{ a: '1' }])
  })

  it('strips a BOM, which is what a spreadsheet export starts with', () => {
    /* Left in, the first column is named "﻿id" and every query naming `id` fails with "no such
       column" against a file that visibly has one. */
    expect(parseCsv('﻿id,name\n1,x').columns).toEqual(['id', 'name'])
  })

  it('names a blank header rather than leaving it unaddressable', () => {
    expect(parseCsv('a,,c\n1,2,3').columns).toEqual(['a', 'column_2', 'c'])
  })

  it('answers empty for empty input', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(parseCsv(value)).toEqual({ columns: [], rows: [] })
    }
  })
})

describe('an absent query', () => {
  it('shows the whole table, because that is the honest answer', () => {
    /* Not an error and not empty: it is the state a table starts in. */
    const result = runQuery('', table())
    expect(result.error).toBeNull()
    expect(result.rows).toHaveLength(4)
    expect(result.columns).toEqual(['id', 'email', 'plan', 'total'])
  })
})

describe('SELECT', () => {
  it('projects named columns in the order asked for', () => {
    const result = run('SELECT email, id FROM t')
    expect(result.columns).toEqual(['email', 'id'])
    expect(result.rows[0]).toEqual({ email: 'a@example.com', id: '1' })
  })

  it('honours an alias', () => {
    expect(run('SELECT email AS who FROM t').columns).toEqual(['who'])
  })

  it('expands a star', () => {
    expect(run('SELECT * FROM t').columns).toEqual(['id', 'email', 'plan', 'total'])
  })

  it('names a column that is not there, and guesses a transposed typo', () => {
    /* The reason this parser exists rather than a general engine: a real one says "no such column
       emial", and this can say "did you mean email". On a hand-typed query against a hand-pasted CSV
       the typo is the overwhelmingly likely cause. */
    const result = run('SELECT emial FROM t')
    expect(result.error).toMatch(/no column “emial”/)
    expect(result.error).toMatch(/did you mean “email”/i)
  })

  it('lists the real columns when there is no near match', () => {
    expect(run('SELECT nonsense FROM t').error).toMatch(/id, email, plan, total/)
  })
})

describe('WHERE', () => {
  const ids = (query) => run(query).rows.map((row) => row.id)

  it('compares text case-insensitively', () => {
    expect(ids("SELECT id FROM t WHERE plan = 'PRO'")).toEqual(['1', '3'])
  })

  it('compares numbers as numbers, not as strings', () => {
    /* `'900' > '120'` is true as text and as numbers, but `'45' > '120'` is true only as text. The
       second is the one that catches a string comparison pretending to be numeric. */
    expect(ids('SELECT id FROM t WHERE total > 120')).toEqual(['4'])
    expect(ids('SELECT id FROM t WHERE total >= 120')).toEqual(['1', '4'])
  })

  it('supports every comparator it claims to', () => {
    expect(ids('SELECT id FROM t WHERE total <> 0')).toEqual(['1', '3', '4'])
    expect(ids('SELECT id FROM t WHERE total != 0')).toEqual(['1', '3', '4'])
    expect(ids('SELECT id FROM t WHERE total < 46')).toEqual(['2', '3'])
    expect(ids('SELECT id FROM t WHERE total <= 45')).toEqual(['2', '3'])
  })

  it('does not mistake <= for <', () => {
    /* The two-character operators have to be tried first, or `total <= 45` parses as `total < (= 45)`
       and compares against a literal beginning with an equals sign. */
    expect(ids('SELECT id FROM t WHERE total <= 0')).toEqual(['2'])
  })

  it('supports LIKE with % and _', () => {
    expect(ids("SELECT id FROM t WHERE email LIKE 'a%'")).toEqual(['1'])
    /* `_` is exactly one character, and every address here is one letter before the `@` -- so this
       matches all four. Pinned as a match rather than as a miss precisely because it is the case
       where `_` and `%` would look identical if `_` were wrongly treated as "any run". */
    expect(ids("SELECT id FROM t WHERE email LIKE '_@example.com'")).toEqual(['1', '2', '3', '4'])
    expect(ids("SELECT id FROM t WHERE email LIKE '__@example.com'")).toEqual([])
    /* `free` contains an `r` too, which is the point of checking a substring pattern rather than a
       prefix -- an implementation that anchored `%x%` would return only the two `pro` rows. */
    expect(ids("SELECT id FROM t WHERE plan LIKE '%r%'")).toEqual(['1', '2', '3'])
    expect(ids("SELECT id FROM t WHERE plan LIKE 'p%'")).toEqual(['1', '3'])
  })

  it('escapes regex metacharacters in a LIKE pattern', () => {
    /* `.` in an email would otherwise match any character, so `LIKE 'a@example.com'` would also match
       `a@examplexcom`. Silent and wrong. */
    expect(ids("SELECT id FROM t WHERE email LIKE 'a@exampleXcom'")).toEqual([])
  })

  it('supports IN and NOT IN', () => {
    expect(ids("SELECT id FROM t WHERE plan IN ('pro','free')")).toEqual(['1', '2', '3'])
    expect(ids("SELECT id FROM t WHERE plan NOT IN ('pro')")).toEqual(['2', '4'])
  })

  it('treats an empty cell as NULL', () => {
    /* A CSV has no NULL, it has an empty cell. This is the only reading that makes IS NULL useful on
       this data, and it is in the help text so it is not a surprise. */
    expect(ids('SELECT id FROM t WHERE plan IS NULL')).toEqual(['4'])
    expect(ids('SELECT id FROM t WHERE plan IS NOT NULL')).toEqual(['1', '2', '3'])
  })

  it('combines with AND and OR', () => {
    expect(ids("SELECT id FROM t WHERE plan = 'pro' AND total > 100")).toEqual(['1'])
    expect(ids("SELECT id FROM t WHERE plan = 'free' OR total > 500")).toEqual(['2', '4'])
  })

  it('respects parentheses over AND binding tighter than OR', () => {
    /* Without the paren handling this reads as `pro AND (total>100 OR total=0)` and returns row 1
       only -- a wrong answer with nothing on screen to suggest it. */
    expect(ids("SELECT id FROM t WHERE (plan = 'pro' OR plan = 'free') AND total = 0")).toEqual(['2'])
  })

  it('does not split on a keyword inside a quoted value', () => {
    /* `WHERE plan LIKE '%order by%'` is a legitimate query that a regex split tears in half. */
    const result = run("SELECT id FROM t WHERE email LIKE '%order by%'")
    expect(result.error).toBeNull()
    expect(result.rows).toEqual([])
  })

  it('does not match a keyword inside a column name', () => {
    const wide = parseCsv('from_email,order_total\nx,5')
    const result = runQuery('SELECT from_email FROM t WHERE order_total > 1', wide)
    expect(result.error).toBeNull()
    expect(result.rows).toEqual([{ from_email: 'x' }])
  })

  it('refuses a condition it cannot read, rather than passing everything', () => {
    /* The most important refusal in the file. A clause that silently evaluated true would show an
       unfiltered table that claims to be filtered. */
    const result = run('SELECT id FROM t WHERE total BETWEEN 1 AND 5')
    expect(result.error).toBeTruthy()
    expect(result.rows).toEqual([])
  })

  it('names an unknown column in a condition', () => {
    expect(run('SELECT id FROM t WHERE emial = 1').error).toMatch(/did you mean “email”/i)
  })
})

describe('ORDER BY and LIMIT', () => {
  it('sorts numerically when both sides are numbers', () => {
    expect(run('SELECT id FROM t ORDER BY total').rows.map((r) => r.id)).toEqual(['2', '3', '1', '4'])
  })

  it('sorts descending', () => {
    expect(run('SELECT id FROM t ORDER BY total DESC').rows.map((r) => r.id)).toEqual([
      '4', '1', '3', '2',
    ])
  })

  it('does not reorder the source rows', () => {
    /* The parsed CSV is shared with every other query run against it. An in-place sort would make the
       *next* query's unsorted result depend on this one. */
    const parsed = table()
    runQuery('SELECT id FROM t ORDER BY total DESC', parsed)
    expect(parsed.rows.map((row) => row.id)).toEqual(['1', '2', '3', '4'])
  })

  it('applies LIMIT and says it did', () => {
    const result = run('SELECT id FROM t LIMIT 2')
    expect(result.rows).toHaveLength(2)
    expect(result.note).toMatch(/2 of 4/)
  })

  it('does not claim a limit it did not need to apply', () => {
    expect(run('SELECT id FROM t LIMIT 99').note).toBeNull()
  })

  it('refuses a LIMIT that is not a whole number', () => {
    expect(run('SELECT id FROM t LIMIT two').error).toMatch(/whole number/)
    expect(run('SELECT id FROM t LIMIT -1').error).toMatch(/whole number/)
  })

  it('names an unknown ORDER BY column', () => {
    expect(run('SELECT id FROM t ORDER BY nope').error).toMatch(/no column “nope”/)
  })

  it('caps the rows it will render, and says so', () => {
    const many = parseCsv(`id\n${Array.from({ length: MAX_ROWS + 40 }, (_, i) => i).join('\n')}`)
    const result = runQuery('SELECT * FROM t', many)
    expect(result.rows).toHaveLength(MAX_ROWS)
    expect(result.note).toMatch(new RegExp(`first ${MAX_ROWS}`))
  })
})

describe('what it refuses outright', () => {
  it('refuses anything that is not a SELECT', () => {
    for (const query of ['DELETE FROM t', 'UPDATE t SET a = 1', 'DROP TABLE t', 'INSERT INTO t VALUES (1)']) {
      expect(run(query).error, query).toMatch(/Only SELECT/)
    }
  })

  it('refuses JOIN, GROUP BY and HAVING with a reason', () => {
    /* Named individually rather than "syntax error", because the reason is specific: there is one
       table made from one CSV, so there is nothing to join and nothing to aggregate across. */
    expect(run('SELECT id FROM t JOIN u ON t.id = u.id').error).toMatch(/JOIN is not supported/)
    expect(run('SELECT plan FROM t GROUP BY plan').error).toMatch(/GROUP BY is not supported/)
    expect(run('SELECT plan FROM t GROUP BY plan HAVING x').error).toBeTruthy()
  })

  it('refuses an empty SELECT list', () => {
    expect(run('SELECT FROM t').error).toMatch(/at least one column/)
  })

  it('tolerates a trailing semicolon', () => {
    expect(run('SELECT id FROM t;').error).toBeNull()
  })

  it('documents its own limits for the UI to show', () => {
    /* The boundary has to be visible rather than discovered by a query returning nothing. */
    expect(SUPPORTED.length).toBeGreaterThan(3)
    expect(SUPPORTED.join(' ')).toMatch(/WHERE/)
    expect(SUPPORTED.join(' ')).toMatch(/LIMIT/)
  })
})
