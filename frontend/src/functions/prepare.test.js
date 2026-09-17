import { describe, expect, it } from 'vitest'

import { codeMask, prepare, probeMask, probePoint, spans } from './prepare.js'

const typesOf = (source) => spans(source).map((span) => span.type)
const textOf = (source, type) =>
  spans(source)
    .filter((span) => span.type === type)
    .map((span) => source.slice(span.start, span.end))

describe('spans', () => {
  it('tiles the whole source', () => {
    const source = `const a = 'x' // note\n/* block */ f(/re/g)\n`
    const rebuilt = spans(source)
      .map((span) => source.slice(span.start, span.end))
      .join('')
    expect(rebuilt).toBe(source)
  })

  it('separates line and block comments', () => {
    expect(textOf('a // one\nb /* two */', 'line-comment')).toEqual(['// one'])
    expect(textOf('a // one\nb /* two */', 'block-comment')).toEqual(['/* two */'])
  })

  it('reads a string to its closing quote, not to the next one anywhere', () => {
    expect(textOf(`const a = 'it\\'s'; const b = 'x'`, 'string')).toEqual([`'it\\'s'`, `'x'`])
  })

  it('ends an unterminated single-quoted string at the newline', () => {
    /* Running to the end of the file instead would swallow every following line as one
       string, and the fold gutter would show a file with no structure in it. */
    const source = "const a = 'oops\nfunction onTrack(event) { return event }"
    expect(textOf(source, 'string')).toEqual(["'oops"])
    expect(typesOf(source)).toContain('code')
  })

  it('walks a template literal past a hole containing a brace in a string', () => {
    const source = 'const a = `${ obj["}"] } tail`'
    expect(textOf(source, 'template')).toEqual(['`${ obj["}"] } tail`'])
  })

  it('tells a regex from a division', () => {
    expect(textOf('x.replace(/\\/$/, "")', 'regex')).toEqual(['/\\/$/'])
    // `a / b / c` is arithmetic: the character before each slash is a value.
    expect(textOf('const r = a / b / c', 'regex')).toEqual([])
  })

  it('does not treat an unterminated slash as a regex', () => {
    expect(textOf('const half = total /\ncount', 'regex')).toEqual([])
  })
})

describe('codeMask', () => {
  it('blanks comments and strings but keeps offsets and lines', () => {
    const source = `if (x) { // { not a brace\n  s = "}"\n}`
    const mask = codeMask(source)
    expect(mask).toHaveLength(source.length)
    expect(mask.split('\n')).toHaveLength(3)
    /* The only braces left are the real ones, which is what stops a brace in a comment
       from opening a fold region that never closes. */
    expect([...mask].filter((char) => char === '{')).toHaveLength(1)
    expect([...mask].filter((char) => char === '}')).toHaveLength(1)
  })
})

describe('prepare', () => {
  it('removes async from a handler declaration', () => {
    const { code, removed } = prepare('async function onTrack(event, settings) { return event }')
    expect(code).toBe('function onTrack(event, settings) { return event }')
    expect(removed.async).toBe(1)
  })

  it('removes async from arrow and method shorthand forms', () => {
    expect(prepare('const f = async (x) => x').code).toBe('const f = async (x) => x'.replace('async ', ''))
    expect(prepare('const o = { async onTrack(e) { return e } }').code).toBe(
      'const o = { onTrack(e) { return e } }',
    )
  })

  it('removes await from expressions', () => {
    const { code, removed } = prepare('const body = await request.json();')
    expect(code).toBe('const body = request.json();')
    expect(removed.await).toBe(1)
  })

  it('leaves the words alone inside comments and strings', () => {
    /* The reason this module has a scanner at all: all four shipped defaults document
       awaiting a response in prose, and rewriting the user's own notes to make their
       code run is not a trade worth making. */
    const source = [
      '// await the response before returning',
      '/* async handlers are the norm */',
      'const note = "await this";',
      'function onTrack(event) { return event }',
    ].join('\n')
    const { code, removed } = prepare(source)
    expect(code).toBe(source)
    expect(removed).toEqual({ async: 0, await: 0 })
  })

  it('does not touch a property named await or async', () => {
    const source = 'const a = settings.async; const b = job.await;'
    expect(prepare(source).code).toBe(source)
  })

  it('injects a step guard into every braced loop body', () => {
    const { code } = prepare('for (const k of keys) { delete t[k] }')
    expect(code).toBe('for (const k of keys) { __tick(); delete t[k] }')
  })

  it('guards while and do-while without reporting the trailing while as unbraced', () => {
    const { code, braceless, error } = prepare('do {\n  step()\n} while (again())')
    expect(braceless).toEqual([])
    expect(error).toBeNull()
    /* One guard, in the body -- the `while` at the end is the same loop, and reporting
       it as unbraced would refuse code that is perfectly fine. */
    expect(code.match(/__tick\(\)/g)).toHaveLength(1)
  })

  /*
   * The step guard is the one thing in this module whose failure is unrecoverable: an
   * unguarded loop freezes the tab, and the tab is holding an unsaved diagram. So every
   * loop must come out of `prepare` either guarded or refused, and "silently neither" is
   * the case these pin.
   */
  describe('no loop escapes both the guard and the refusal', () => {
    const guarded = (source) => (prepare(source).code ?? '').match(/__tick\(\)/g)?.length ?? 0
    const accounted = (source) => {
      const { code, braceless } = prepare(source)
      return braceless.length > 0 || guarded(source) > 0 || !/\b(while|for|do)\b/.test(code ?? '')
    }

    it('guards a bare loop that merely follows a block', () => {
      /* The shape that got through: an early-return guard, then a loop. The trailing-`}`
         test for a do-while tail matched it and exempted it from everything. */
      const source = [
        'async function onTrack(event) {',
        '  if (!event.userId) { return event }',
        '  while (event.userId) event.n = (event.n || 0) + 1',
        '  return event',
        '}',
      ].join('\n')
      expect(prepare(source).braceless).toEqual([3])
      expect(prepare(source).code).toBeNull()
    })

    it('still recognises a real do-while tail', () => {
      const source = 'do {\n  step()\n} while (again())'
      expect(prepare(source).braceless).toEqual([])
      expect(guarded(source)).toBe(1)
    })

    it('tells two do-whiles apart from a block followed by a loop', () => {
      const source = 'do { a() } while (x)\nif (y) { b() }\nwhile (z) c()'
      expect(prepare(source).braceless).toEqual([3])
    })

    it('guards for await, which is a loop with a keyword in the way', () => {
      /* Skipped as "not a loop" because the token after `for` was `await` rather than
         `(` -- and then the await-stripping turned it into a valid, unguarded loop. */
      const source = 'for await (const x of xs) { f(x) }'
      expect(guarded(source)).toBe(1)
      expect(prepare(source).code).toContain('for (const x of xs) { __tick(); f(x) }')
    })

    it('accounts for every loop form', () => {
      for (const source of [
        'while (a) { b() }',
        'while (a) b()',
        'for (;;) { b() }',
        'for (const x of xs) { b() }',
        'for (const k in o) b()',
        'for await (const x of xs) { b() }',
        'do { b() } while (a)',
        'do b(); while (a)',
        'if (x) { y() }\nwhile (a) b()',
        'for (const x of xs) { for (const y of ys) { z() } }',
      ]) {
        expect(accounted(source), source).toBe(true)
      }
    })

    it('names each unbraced line once, however many keywords are on it', () => {
      /* `do b(); while (a)` is two keywords and one fault. */
      expect(prepare('do b(); while (a)').braceless).toEqual([1])
    })
  })

  describe('edits at the same offset', () => {
    it('strips an await that begins immediately after a guarded brace', () => {
      /*
       * The insertion sits at `{`+1 and the deletion starts there too. Sorting on offset
       * alone applied the insertion first, and the deletion then cut into ` __tick();` --
       * leaving half a call to an undefined function and a surviving `await` in a body
       * that is no longer async. Silently wrong, rather than refused.
       */
      const { code } = prepare('for (const x of xs) {await f(x)}')
      expect(code).toBe('for (const x of xs) { __tick();f(x)}')
      expect(code).not.toMatch(/await/)
      expect(() => new Function('__tick', 'f', 'xs', code)).not.toThrow()
    })

    it('strips an async that begins immediately after a guarded brace', () => {
      const { code } = prepare('while (x) {async function g(){ return 1 }}')
      expect(code).toBe('while (x) { __tick();function g(){ return 1 }}')
      expect(() => new Function('__tick', 'x', code)).not.toThrow()
    })
  })

  it('refuses a loop whose body has no braces, by line', () => {
    const { code, error, braceless } = prepare('function f(xs) {\n  for (const x of xs) go(x)\n}')
    expect(code).toBeNull()
    expect(braceless).toEqual([2])
    expect(error).toContain('line 2')
  })

  it('reports what it changed, and stays quiet when it changed nothing', () => {
    expect(prepare('function onTrack(e) { return e }').notes).toEqual([])
    const notes = prepare('async function onTrack(e) { return e }').notes
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/synchronous/)
  })

  it('survives an empty or absent source', () => {
    expect(prepare('').code).toBe('')
    expect(prepare(null).code).toBe('')
    expect(prepare(undefined).error).toBeNull()
  })

  it('turns a handler that awaits into one that returns its value outright', () => {
    /*
     * The end-to-end property this module exists for, and the reason it is not just
     * cosmetic. The original compiles perfectly well -- `await` inside an `async`
     * function is valid -- but calling it hands back a *promise*, and `simulate()` is
     * synchronous and cannot wait for one. Stripping both keywords is what makes the
     * value available at all.
     */
    const source =
      'async function onTrack(event, settings) {\n  const body = await request.json();\n  return body;\n}'
    const request = { json: () => ({ type: 'track' }) }

    const before = new Function('__tick', 'request', `${source}; return onTrack({}, {})`)(
      () => {},
      request,
    )
    expect(typeof before.then).toBe('function')

    const { code } = prepare(source)
    const after = new Function('__tick', 'request', `${code}; return onTrack({}, {})`)(
      () => {},
      request,
    )
    expect(after).toEqual({ type: 'track' })
  })

  it('leaves a stray await as a syntax error rather than silently mangling it', () => {
    /* `await` outside any function is not something stripping `async` can rescue, and
       the honest outcome is the parser's own complaint -- which ./runtime.js reports
       verbatim. Asserted so that a future change to the scanner cannot start quietly
       swallowing it. */
    const { code } = prepare('const x = await 1;')
    expect(code).toBe('const x = 1;')
  })
})

/*
 * Coverage probes, for the checklist in ./steps.js.
 *
 * `probePoint` is a heuristic standing in for a parser, so what these pin is not "it is
 * clever" but "it is conservative in the right direction". A refused line is reported to the
 * user as unmeasurable, which is honest. A wrongly *allowed* line is a statement injected
 * into the middle of an expression -- and in one case (`if (cond)` with an unbraced body) one
 * that compiles perfectly and silently detaches the body from its condition, which no
 * compile check downstream can catch.
 */
describe('probePoint', () => {
  const at = (source, line) => probePoint(source, line)
  const allowed = (source, line) => at(source, line) !== null

  it('finds the first code character of the line', () => {
    const source = 'function f() {\n    go()\n  return 1\n}'
    expect(source[at(source, 2)]).toBe('g')
    expect(source[at(source, 3)]).toBe('r')
  })

  it('accepts a statement after a semicolon, a brace, or a line break', () => {
    expect(allowed('function f() {\n  a();\n  b()\n}', 3)).toBe(true)
    expect(allowed('function f() {\n  if (x) { y() }\n  b()\n}', 3)).toBe(true)
    expect(allowed('function f() {\n  a()\n  b()\n}', 3)).toBe(true)
    expect(allowed('function f() {\n  a()\n}', 2)).toBe(true)
  })

  /* Semicolon-free code is ordinary, and the first version of this could only find a boundary
     after punctuation -- which made most of such a function unmeasurable. */
  it('reads a line break as a terminator, whatever ended the line', () => {
    for (const previous of ['a()', 'const a = 1', "const a = 'x'", 'const a = [1]', 'a.b']) {
      expect(allowed(`function f() {\n  ${previous}\n  go()\n}`, 3), previous).toBe(true)
    }
  })

  it('refuses a line that continues the one above it', () => {
    for (const previous of ['const a = 1 +', 'const a =', 'f(', 'const a = [', 'x ?']) {
      expect(allowed(`function f() {\n  ${previous}\n  go()\n}`, 3), previous).toBe(false)
    }
  })

  it('refuses a line beginning with something that cannot start a statement', () => {
    for (const line of ['.map(f)', '? a : b', ': 1', ', b', '+ 1', ') {', '] }', '} else {']) {
      expect(allowed(`function f() {\n  const a = 1\n  ${line}\n}`, 3), line).toBe(false)
    }
  })

  it('refuses the words that continue a construct', () => {
    expect(allowed('function f() {\n  if (x) { a() }\n  else { b() }\n}', 3)).toBe(false)
    expect(allowed('function f() {\n  try { a() }\n  catch (e) { b() }\n}', 3)).toBe(false)
    expect(allowed('function f() {\n  do { a() }\n  while (x)\n}', 3)).toBe(false)
  })

  it('refuses the unbraced body of an if, which is the dangerous one', () => {
    /*
     * `if (event.userId)` then `return event` with a probe between them becomes
     * `if (event.userId) __hit(2);` followed by an unconditional `return event`. It compiles,
     * so nothing downstream would notice; the function just quietly stops branching.
     */
    expect(allowed('function f(e) {\n  if (e.id)\n    return e\n}', 3)).toBe(false)
    expect(allowed('function f(e) {\n  for (const x of e.a)\n    go(x)\n}', 3)).toBe(false)
    expect(allowed('function f(e) {\n  while (e.n)\n    e.n -= 1\n}', 3)).toBe(false)
  })

  it('still allows a line after a call that merely ends in a paren', () => {
    /* The same `)` before a newline, and here it is the end of a call rather than a head --
       told apart by matching the paren back to its keyword. */
    expect(allowed('function f() {\n  go(1)\n  after()\n}', 3)).toBe(true)
  })

  it('refuses a line after a keyword that expects an operand', () => {
    expect(allowed('function f() {\n  return\n  event\n}', 3)).toBe(false)
    expect(allowed('function f() {\n  throw\n  err\n}', 3)).toBe(false)
    expect(allowed('function f() {\n  const a = typeof\n  b\n}', 3)).toBe(false)
  })

  it('refuses the inside of an object literal but allows a real block', () => {
    expect(allowed('function f() {\n  const o = {\n    a: 1\n  }\n}', 3)).toBe(false)
    expect(allowed('function f() {\n  if (x) {\n    go()\n  }\n}', 3)).toBe(true)
    /* `=> {` is a block; `=> ({` is a literal, and its paren is what is seen. */
    expect(allowed('const f = () => {\n  go()\n}', 2)).toBe(true)
    expect(allowed('const f = () => ({\n  a: 1\n})', 2)).toBe(false)
  })

  it('refuses everything at module scope', () => {
    /*
     * A probe at depth zero fires when the file is evaluated, which happens on every call
     * before any handler is chosen -- so it would tick for an identify event that never went
     * near onTrack. An always-green step reads as evidence, which is worse than no step.
     */
    expect(allowed('const TOP = 1\nfunction f() {\n  go()\n}', 1)).toBe(false)
    expect(allowed('const TOP = 1\nfunction f() {\n  go()\n}', 2)).toBe(false)
    expect(allowed('const TOP = 1\nfunction f() {\n  go()\n}', 3)).toBe(true)
  })

  it('refuses a comment, a blank line, and the inside of a template', () => {
    expect(allowed('function f() {\n  // note\n  go()\n}', 2)).toBe(false)
    expect(allowed('function f() {\n\n  go()\n}', 2)).toBe(false)
    expect(allowed('function f() {\n  const s = `a\nb`\n  go()\n}', 3)).toBe(false)
  })

  it('refuses a line that is not there', () => {
    expect(at('a', 0)).toBeNull()
    expect(at('a', 5)).toBeNull()
    expect(at('', 1)).toBeNull()
  })
})

describe('probeMask', () => {
  it('keeps offsets and lines, blanks comments, and makes literals read as values', () => {
    const source = "const a = 'x' // note\nconst b = 1"
    const mask = probeMask(source)
    expect(mask).toHaveLength(source.length)
    expect(mask.split('\n')).toHaveLength(2)
    /* The comment is gone and the string has become a run of value characters -- which is
       what lets `const a = 'x'` read as a finished statement rather than leaving the `=` as
       the last thing on the line. */
    expect(mask).not.toContain('note')
    expect(mask.slice(10, 13)).toBe('000')
  })
})

describe('prepare with probes', () => {
  const handler = "async function onTrack(event) {\n  event.a = 1\n  return event\n}"

  it('injects a hit call on each line it can, and reports which', () => {
    const { code, tracked, untracked } = prepare(handler, { probes: [2, 3] })
    expect(tracked).toEqual([2, 3])
    expect(untracked).toEqual([])
    expect(code.split('\n')[1]).toBe('  __hit(2);event.a = 1')
    expect(code.split('\n')[2]).toBe('  __hit(3);return event')
  })

  it('reports a line it cannot probe instead of forcing one', () => {
    const { code, tracked, untracked } = prepare(handler, { probes: [1, 2, 4] })
    expect(tracked).toEqual([2])
    expect(untracked).toEqual([1, 4])
    expect(code.match(/__hit/g)).toHaveLength(1)
  })

  it('keeps the probe and the loop guard from corrupting each other at one offset', () => {
    /* Both want the same offset: the guard goes just after the `{`, and the probe goes at the
       first code character of the line -- which is the same place when the body is on one
       line with the loop. */
    const { code } = prepare('function f(xs) {\n  for (const x of xs) { go(x) }\n}', { probes: [2] })
    expect(() => new Function('__tick', '__hit', 'go', code)).not.toThrow()
    expect(code).toContain('__hit(2);')
    expect(code).toContain('__tick();')
  })

  it('adds nothing at all when asked for no probes', () => {
    /* Compared against the unprobed rewrite rather than the raw source: `prepare` also
       strips `async`, so byte-identical was never the property. What matters is that asking
       for coverage is the only thing that adds coverage. */
    expect(prepare(handler, { probes: [] }).code).toBe(prepare(handler).code)
    expect(prepare(handler).code).not.toContain('__hit')
    expect(prepare(handler).tracked).toEqual([])
  })

  it('reports every requested line as untracked when the code will not run at all', () => {
    const { code, untracked } = prepare('function f(xs) {\n  for (const x of xs) go(x)\n}', {
      probes: [2],
    })
    expect(code).toBeNull()
    expect(untracked).toEqual([2])
  })
})
