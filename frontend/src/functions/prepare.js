/*
 * Making a Segment function body runnable in this browser, synchronously.
 *
 * A real function runs on Lambda: its handlers are `async`, and they may `await` a
 * `fetch`, a cached token, a lookup. The simulator that has to run them is
 * `simulate()` in ../simulation/router.js, which is pure, synchronous, and memoised
 * on (graph, event) so that dragging the walkthrough scrubber does not re-evaluate
 * the whole diagram sixty times a second. Those two facts cannot both be honoured,
 * so this module is where the compromise is written down.
 *
 * The compromise: the local runner is synchronous and has no network. `async` is
 * removed from function declarations and `await` from expressions, which is
 * semantics-preserving *because* nothing the sandbox hands the code returns a
 * promise (see ./runtime.js -- `request.json()` returns the object, `cache.load()`
 * calls its loader). Code that genuinely needs to wait fails at the missing API with
 * a message naming the local runner, rather than being guessed at.
 *
 * ## Why a scanner and not a regex
 *
 * `source.replace(/\bawait\b/g, '')` also rewrites the word in a comment. Every one
 * of the four Segment templates this ships defaults from has paragraphs of prose
 * about awaiting responses, and a REFERENCE block of commented-out code full of
 * `await fetch(...)`. Corrupting the user's own documentation to make their code run
 * is not a trade worth making, so `spans()` classifies the source first and only
 * `code` spans are ever edited.
 *
 * ## The loop guard
 *
 * `while (true) {}` in a function body would freeze the tab -- and the tab is
 * holding an unsaved diagram, which is the failure this codebase already bends
 * around elsewhere. There is no way to interrupt synchronous JavaScript, so the
 * budget has to be inside the loop: a `__tick()` call is inserted at the top of
 * every loop body, and ./runtime.js throws from it once a step count or a wall-clock
 * deadline is passed.
 *
 * That needs a `{` to insert after. A loop written `for (const x of xs) f(x)` has
 * nowhere to put the guard, so it is *refused* rather than run unguarded -- reported
 * by line number so the fix is one keystroke. All four shipped defaults brace their
 * loop bodies.
 */

/*
 * A ceiling on how finely one source is classified.
 *
 * The loop below always advances, so this is not what makes it terminate -- it is a
 * bound on memory for a pathological input. Deliberately far above MAX_CODE_LENGTH in
 * ./defaults.js (a span cannot be shorter than a character), so it never trips on
 * anything the editor will accept.
 */
const MAX_SPANS = 100000

/**
 * Classify `source` into `code`, comment, string, template and regex spans.
 *
 * Adjacent spans tile the whole string: `spans(s).map(x => s.slice(x.start, x.end)).join('')`
 * is `s`. Exported because folds.js and highlight.js need the same classification, and
 * two scanners would eventually disagree about where a comment ends.
 */
export function spans(source) {
  const text = String(source ?? '')
  const out = []
  let index = 0
  let start = 0

  const push = (type, from, to) => {
    if (to > from) out.push({ type, start: from, end: to })
  }

  /*
   * Does a `/` here open a regex literal, or divide?
   *
   * Decided by the last significant character, which is the standard heuristic and
   * the only one available without a parser: division follows a *value* (an
   * identifier, a number, a closing bracket), a regex follows an operator or the
   * start of a statement. Getting it wrong costs a mis-classified span, which
   * surfaces as a compile error the panel reports verbatim -- not a silent rewrite.
   */
  const regexAllowed = (at) => {
    for (let back = at - 1; back >= 0; back -= 1) {
      const char = text[back]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue
      return !/[\w$)\]]/.test(char)
    }
    return true
  }

  while (index < text.length && out.length < MAX_SPANS) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '/' && next === '/') {
      push('code', start, index)
      const stop = text.indexOf('\n', index)
      const end = stop === -1 ? text.length : stop
      push('line-comment', index, end)
      index = end
      start = end
      continue
    }

    if (char === '/' && next === '*') {
      push('code', start, index)
      const stop = text.indexOf('*/', index + 2)
      /* An unterminated block comment runs to the end of the file. That is what the
         JavaScript parser does with it too, so treating it any other way here would
         make the highlighting disagree with the compile error. */
      const end = stop === -1 ? text.length : stop + 2
      push('block-comment', index, end)
      index = end
      start = end
      continue
    }

    if (char === '"' || char === "'") {
      push('code', start, index)
      const end = closeQuote(text, index)
      push('string', index, end)
      index = end
      start = end
      continue
    }

    if (char === '`') {
      push('code', start, index)
      const end = closeTemplate(text, index)
      push('template', index, end)
      index = end
      start = end
      continue
    }

    if (char === '/' && regexAllowed(index)) {
      const end = closeRegex(text, index)
      if (end > index) {
        push('code', start, index)
        push('regex', index, end)
        index = end
        start = end
        continue
      }
    }

    index += 1
  }

  push('code', start, text.length)
  return out
}

/** Past the closing quote of the string opening at `open`, or the end of the line. */
function closeQuote(text, open) {
  const quote = text[open]
  let index = open + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    /* A raw newline ends an unterminated single-quoted string. Running to the end of
       the file instead would swallow the entire rest of the source as one string. */
    if (char === '\n') return index
    if (char === quote) return index + 1
    index += 1
  }
  return text.length
}

/**
 * Past the closing backtick, accounting for `${...}` holes.
 *
 * The hole is walked rather than skipped to the next `}` because it can contain
 * strings and further templates of its own, and `` `${ obj['}'] }` `` is legal.
 */
function closeTemplate(text, open) {
  let index = open + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') return index + 1
    if (char === '$' && text[index + 1] === '{') {
      index = closeBrace(text, index + 1)
      continue
    }
    index += 1
  }
  return text.length
}

/** Past the `}` matching the `{` at `open`, skipping strings and comments inside it. */
function closeBrace(text, open) {
  let depth = 0
  let index = open
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      index = closeQuote(text, index)
      continue
    }
    if (char === '`') {
      index = closeTemplate(text, index)
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const stop = text.indexOf('\n', index)
      index = stop === -1 ? text.length : stop
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const stop = text.indexOf('*/', index + 2)
      index = stop === -1 ? text.length : stop + 2
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return text.length
}

/** Past the closing `/` and flags of the regex at `open`, or `open` if it is not one. */
function closeRegex(text, open) {
  let index = open + 1
  let inClass = false
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    /* A regex cannot span lines, so a newline means this `/` was division after all
       and the caller should treat it as ordinary code. */
    if (char === '\n') return open
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      index += 1
      while (index < text.length && /[a-z]/i.test(text[index])) index += 1
      return index
    }
    index += 1
  }
  return open
}

/**
 * `source` with every non-code span blanked to spaces, same length, newlines kept.
 *
 * This is what brace matching and keyword hunting run against, so a `{` in a string
 * cannot open a fold region and the word `for` in a comment cannot look like a loop.
 * Same length as the input on purpose: every offset found in the mask is a valid
 * offset into the original.
 */
export function codeMask(source) {
  const text = String(source ?? '')
  const chars = new Array(text.length).fill(' ')
  for (const span of spans(source)) {
    for (let index = span.start; index < span.end; index += 1) {
      /* Newlines survive in every span type, so line numbers are preserved through
         a forty-line block comment. */
      chars[index] = span.type === 'code' || text[index] === '\n' ? text[index] : ' '
    }
  }
  return chars.join('')
}

/** Is the identifier at `at` a standalone word, rather than `.await` or `x_await`? */
function standalone(mask, at, word) {
  const before = mask[at - 1]
  const after = mask[at + word.length]
  if (before === '.') return false
  if (before !== undefined && /[\w$]/.test(before)) return false
  if (after !== undefined && /[\w$]/.test(after)) return false
  return true
}

/** The offset of the next character in `mask` that is not whitespace, from `from`. */
function nextSignificant(mask, from) {
  let index = from
  while (index < mask.length && /\s/.test(mask[index])) index += 1
  return index
}

/** The offset of the previous non-whitespace character, or -1. */
function prevSignificant(mask, from) {
  let index = from - 1
  while (index >= 0 && /\s/.test(mask[index])) index -= 1
  return index
}

/* Words that continue a statement rather than beginning one. A probe inserted before any
   of these is a syntax error, and `while` is worse than that -- it would be the tail of a
   `do`, where an inserted statement separates the loop from its condition. */
const CONTINUATIONS = new Set(['else', 'case', 'default', 'catch', 'finally', 'while'])

/*
 * Words that expect an operand next, so a newline after them terminates nothing.
 *
 * `return` is the one that matters. JavaScript's own ASI rules make `return` followed by a
 * newline mean `return;`, so a reader might think a probe there is harmless -- but
 * `return __hit(7); event` returns the probe's value and abandons the event.
 */
const EXPECTS_OPERAND = new Set([
  'return',
  'throw',
  'typeof',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'instanceof',
  'yield',
  'await',
  'case',
  'else',
  'do',
  'extends',
])

/* Keywords whose parenthesised head must not be separated from the body that follows it.
   `if (cond)` on one line and its unbraced body on the next is the one break a compile
   check cannot catch -- it compiles, and silently detaches the body from the condition. */
const HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with'])

/* Characters that cannot begin a statement. `.` is the giveaway for a wrapped method chain,
   and `(` and `[` are the classic ASI hazards: a line starting with either continues the
   expression above it however it looks. */
const NOT_A_START = new Set([
  '}', ')', ']', '.', ',', ':', '?', '+', '-', '*', '/', '%', '&', '|', '^', '=', '<', '>',
  '`', '(', '[',
])

/* Stands in for a string, template or regex literal in `probeMask`. A digit, because what
   matters to the reasoning below is that a literal is a *value*: `const a = 'x'` ends a
   statement, and a mask that blanked it to spaces would leave the `=` as the last
   significant character and make this refuse a perfectly good line. */
const LITERAL = '0'

/**
 * `source` masked for statement-boundary reasoning.
 *
 * Comments become spaces -- they are not code and terminate nothing. Literals become a run
 * of `LITERAL`, so they read as values rather than disappearing. Same length as the input,
 * newlines preserved, exactly like `codeMask`, which it deliberately does not replace:
 * `codeMask` is what brace matching and keyword hunting want, and a literal that looked
 * like a value there would break both.
 */
export function probeMask(source) {
  const text = String(source ?? '')
  const chars = new Array(text.length).fill(' ')
  for (const span of spans(source)) {
    for (let index = span.start; index < span.end; index += 1) {
      if (text[index] === '\n') {
        chars[index] = '\n'
      } else if (span.type === 'code') {
        chars[index] = text[index]
      } else if (span.type === 'line-comment' || span.type === 'block-comment') {
        chars[index] = ' '
      } else {
        chars[index] = LITERAL
      }
    }
  }
  return chars.join('')
}

/**
 * The identifier ending at `end` (exclusive), skipping whitespace, or ''.
 *
 * Skipping matters. Without it `if (` -- with the space Segment's own style puts there --
 * made this return '' rather than 'if', which let a probe be placed between an `if` head
 * and its unbraced body: the one rewrite that compiles cleanly and silently detaches the
 * body from the condition.
 */
function wordEndingAt(mask, end) {
  let index = end - 1
  while (index >= 0 && /\s/.test(mask[index])) index -= 1
  return /[\w$]+$/.exec(mask.slice(0, index + 1))?.[0] ?? ''
}

/** How many unclosed `{` precede `at`. Zero means module scope. */
function braceDepth(mask, at) {
  let depth = 0
  for (let index = 0; index < at; index += 1) {
    if (mask[index] === '{') depth += 1
    else if (mask[index] === '}') depth -= 1
  }
  return depth
}

/** The offset of the `(` matching the `)` at `at`, or -1. */
function openParenFor(mask, at) {
  let depth = 0
  for (let index = at; index >= 0; index -= 1) {
    if (mask[index] === ')') depth += 1
    else if (mask[index] === '(') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Is the `{` at `at` a block, or the start of an object literal?
 *
 * It matters because a block's first statement can be prefixed with a probe and an object
 * literal's first *property* cannot -- `{ __hit(3); a: 1 }` is not a thing. Decided by what
 * comes before the brace, which is the only signal available without a parser: a block
 * follows a `)`, another brace, a `;`, or one of the keywords that introduces one, while a
 * literal follows an `=`, a `(`, a `,`, a `:` or a `return`.
 *
 * The bias is deliberately towards saying "no": an anchor this refuses is reported to the
 * user as untrackable, which is honest, while one it wrongly allows is a probe in the middle
 * of an expression.
 */
function isBlockBrace(mask, at) {
  const before = prevSignificant(mask, at)
  if (before < 0) return false
  const char = mask[before]
  if (char === ')' || char === '{' || char === '}' || char === ';') return true
  /* `=> {` is a block; `=> ({` is not, and its `(` is what this sees instead. */
  if (char === '>' && mask[before - 1] === '=') return true
  const word = wordEndingAt(mask, before + 1)
  return word === 'else' || word === 'do' || word === 'try' || word === 'finally'
}

/**
 * Where a coverage probe may go on line `line` (1-based), or null.
 *
 * Exported because two callers need exactly the same answer and must not each have their
 * own: the runner places the probes, and the UI decides whether to *offer* an anchor on a
 * line. If those disagreed, the button would hand out anchors that always report a cross.
 *
 * A probe goes at the first code character of the line, and only where the text before it
 * proves a statement ended there. Three ways it can have:
 *
 *   - an explicit `;`
 *   - a `}`, or the `{` of a real block
 *   - a newline, where the character before it could end an expression -- which is
 *     JavaScript's own rule, and is what makes semicolon-free code trackable at all
 *
 * The exclusions are where the care is. `)` before a newline is ambiguous: it ends a call,
 * or it closes the head of an `if` whose unbraced body is on the next line. The second
 * compiles perfectly with a probe wedged in and quietly detaches the body from its
 * condition, so the paren is matched back to its keyword to tell them apart. `return`
 * before a newline is refused for the same reason.
 */
export function probePoint(text, line) {
  const lines = String(text ?? '').split('\n')
  if (line < 1 || line > lines.length) return null

  /* Its own mask, deliberately not the `codeMask` the rest of this module runs on: this
     reasoning needs a literal to read as a *value*, and one blanked to spaces would leave
     the `=` of `const a = 'x'` as the last significant character and make a perfectly good
     line unprobeable. */
  const pm = probeMask(text)

  let offset = 0
  for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + 1
  const end = offset + lines[line - 1].length

  /* The first real code on the line. A line that is only a comment has none, and cannot be
     probed -- nothing on it executes. */
  let at = offset
  while (at < end && /\s/.test(pm[at] ?? '')) at += 1
  if (at >= end || !(pm[at] ?? '').trim()) return null

  /* Inside a literal, which for a multi-line template means the middle of a string. */
  if (pm[at] === LITERAL) return null

  /*
   * Module scope, which is not what anyone means by "did this step happen".
   *
   * A probe at depth zero fires when the file is *evaluated*, which the runner does on every
   * call before dispatching to a handler -- so a line like `async function onTrack(...)` or a
   * top-level `const REDACTED = [...]` would report a tick for an identify event that never
   * went near onTrack. An always-green step is worse than no step: it reads as evidence.
   */
  if (braceDepth(pm, at) === 0) return null

  if (NOT_A_START.has(pm[at])) return null
  const first = /^[\w$]+/.exec(pm.slice(at, end))?.[0]
  if (first && CONTINUATIONS.has(first)) return null

  const before = prevSignificant(pm, at)
  if (before < 0) return at

  const char = pm[before]
  if (char === ';') return at
  if (char === '}') return at
  if (char === '{') return isBlockBrace(pm, before) ? at : null

  /* Nothing punctuated the end of the previous statement, so the only thing that can have
     ended it is the line break -- and only if what precedes the break could finish an
     expression. */
  if (!pm.slice(before, at).includes('\n')) return null

  if (char === ')') {
    const open = openParenFor(pm, before)
    return open >= 0 && HEADS.has(wordEndingAt(pm, open)) ? null : at
  }
  if (char === ']' || char === LITERAL) return at
  if (/[\w$]/.test(char)) {
    return EXPECTS_OPERAND.has(wordEndingAt(pm, before + 1)) ? null : at
  }
  /* An operator, a comma, an opening bracket: the statement is still going. */
  return null
}

/** Which 1-based line `offset` falls on. */
function lineAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/**
 * Rewrite `source` into something the synchronous runner can execute.
 *
 * @param probes 1-based lines to record the execution of, for the checklist in ./steps.js.
 *   A line that cannot take a probe is skipped and reported in `untracked` rather than
 *   forced -- an anchor that always reads as a cross would be worse than one that admits
 *   it cannot be measured.
 * @param tick   the loop-guard call to inject
 * @param hit    the coverage call to inject
 *
 * @returns
 *   `code`      the rewritten source, or null when it cannot be made runnable
 *   `notes`     what was changed, in the user's terms, for the panel to print
 *   `braceless` 1-based line numbers of loops whose body has no `{` to guard
 *   `removed`   `{async, await}` counts, so the panel can stay quiet when nothing changed
 *   `tracked`   lines a probe was placed on
 *   `untracked` lines that were asked for and could not take one
 */
export function prepare(source, { tick = '__tick', hit = '__hit', probes = [] } = {}) {
  const text = String(source ?? '')
  const mask = codeMask(text)
  const edits = []
  const braceless = []
  const removed = { async: 0, await: 0 }
  /* Offsets of the `}` that closes a `do` body, so its trailing `while` is not mistaken
     for an unbraced loop. See the branch that reads it. */
  const doBodyEnds = new Set()
  let loops = 0

  /*
   * Coverage probes, added to the same edit list as everything else.
   *
   * Sharing the list is the point: a probe lands at the first code character of a line, and
   * a loop guard lands just after a `{`, and `for (const x of xs) { doThing() }` puts those
   * two at the same offset. One list means one sort, and the tie-break in `applyEdits`
   * settles it -- two passes over the string would each be correct alone and corrupt each
   * other's offsets.
   */
  const tracked = []
  const untracked = []
  for (const line of [...new Set(probes ?? [])].sort((a, b) => a - b)) {
    const at = probePoint(text, line)
    if (at === null) {
      untracked.push(line)
      continue
    }
    edits.push({ start: at, end: at, text: `${hit}(${line});`, probe: true })
    tracked.push(line)
  }

  const keyword = /\b(async|await|while|for|do)\b/g
  let match
  while ((match = keyword.exec(mask)) !== null) {
    const at = match.index
    const word = match[1]
    if (!standalone(mask, at, word)) continue

    if (word === 'async') {
      /*
       * Only where it actually marks a function: `async function f`, `async (x) =>`,
       * `async x =>`, and the `async name()` method shorthand. Anywhere else `async`
       * is an ordinary identifier -- somebody's variable -- and deleting it would
       * break code that was fine.
       */
      const after = nextSignificant(mask, at + word.length)
      if (after === at + word.length) continue // `asyncfoo` cannot happen, but `async` at EOF can
      if (!/[\w$(]/.test(mask[after] ?? '')) continue
      edits.push({ start: at, end: after, text: '' })
      removed.async += 1
      continue
    }

    if (word === 'await') {
      /* The word and the whitespace after it. `await(p)` keeps its parens, which is
         still a valid expression. */
      const after = nextSignificant(mask, at + word.length)
      edits.push({ start: at, end: after, text: '' })
      removed.await += 1
      continue
    }

    /* --- loops: find the body's `{` and insert the guard, or refuse ---------- */

    let bodyAt
    if (word === 'do') {
      bodyAt = nextSignificant(mask, at + word.length)
    } else {
      let head = nextSignificant(mask, at + word.length)
      /*
       * `for await (...)`, which is a loop with a keyword in the way.
       *
       * Without this it failed the `(` test below and was skipped as "not a loop" -- and
       * then the `await` branch above rewrote it into an ordinary `for` that this scan
       * had already walked past, so the result was a perfectly valid loop with no step
       * budget on it at all. Silently unguarded is the one outcome this module must not
       * produce.
       */
      if (word === 'for' && mask.startsWith('await', head) && standalone(mask, head, 'await')) {
        head = nextSignificant(mask, head + 'await'.length)
      }
      if (mask[head] !== '(') continue // not a loop: `for` cannot appear bare
      bodyAt = nextSignificant(mask, closeParen(mask, head))
    }

    if (mask[bodyAt] === '{') {
      edits.push({ start: bodyAt + 1, end: bodyAt + 1, text: ` ${tick}();` })
      /* Where this `do`'s body closes, so its trailing `while` can be recognised below by
         identity rather than by shape. */
      if (word === 'do') doBodyEnds.add(closeBrace(mask, bodyAt) - 1)
      loops += 1
      continue
    }

    /*
     * The `while` of a `do { … } while (…)`, whose body was guarded when `do` was seen.
     *
     * Recognised by *which* brace precedes it, not by there merely being one. Testing
     * only for a `}` matched every unbraced loop that happened to follow a block --
     * `if (!event.userId) { return event }` then `while (x) event.n++` -- and exempted it
     * from both the guard and the refusal, which is the hang this module exists to
     * prevent, reachable from an ordinary early-return guard.
     */
    if (word === 'while' && doBodyEnds.has(prevSignificant(mask, at))) continue

    braceless.push(lineAt(text, at))
  }

  const notes = []
  if (removed.async > 0 || removed.await > 0) {
    notes.push(
      'This runner is synchronous, so `async` and `await` were removed before running. Nothing the sandbox returns is a promise, so that changes no behaviour — but it does mean a function that really has to wait for something cannot be simulated here.',
    )
  }
  if (loops > 0) {
    notes.push(
      `A step limit was added to ${loops} loop${loops === 1 ? '' : 's'}, so a runaway loop stops instead of freezing this tab.`,
    )
  }

  if (braceless.length > 0) {
    /* Deduplicated and ordered: a `do stmt; while (c)` is refused twice, once for each
       keyword, and naming the same line twice reads as two separate faults. */
    const lines = [...new Set(braceless)].sort((a, b) => a - b)
    return {
      code: null,
      notes,
      braceless: lines,
      removed,
      tracked: [],
      untracked: [...(probes ?? [])],
      error: `The local runner needs braces around a loop body so it can enforce a step limit. Add { } to the loop on line ${lines.join(', line ')}.`,
    }
  }

  return {
    code: applyEdits(text, edits),
    notes,
    braceless,
    removed,
    tracked,
    untracked,
    error: null,
  }
}

/**
 * The same rewrite with every probe dropped.
 *
 * The escape hatch for `probePoint` being a heuristic. ./runtime.js compiles the probed
 * source first, and when that fails falls back to this: coverage is the thing worth losing,
 * because a checklist that cannot be measured is a smaller loss than a function that cannot
 * be run. The checklist then reports its items as untracked, which is true.
 */
export function prepareWithoutProbes(source, options = {}) {
  return prepare(source, { ...options, probes: [] })
}

/** Past the `)` matching the `(` at `open`, on an already-masked source. */
function closeParen(mask, open) {
  let depth = 0
  for (let index = open; index < mask.length; index += 1) {
    if (mask[index] === '(') depth += 1
    else if (mask[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return mask.length
}

/*
 * Applied back to front, so an earlier edit cannot shift a later one's offsets.
 *
 * The tie-break is not decoration. A guard insertion sits at `bodyAt + 1` -- immediately
 * after a `{` -- and an `async`/`await` deletion beginning at that same offset is exactly
 * what `for (const x of xs) {await f(x)}` produces. Sorting on `start` alone left the
 * zero-width insertion first, whose text then shifted the deletion's range into the middle
 * of ` __tick();`, and the result was silently mangled rather than refused: half a call to
 * an undefined function, and a surviving `await` in a body that is no longer async.
 *
 * Widest first resolves it, because a deletion has to happen before anything is inserted
 * at the point it starts from.
 */
function applyEdits(text, edits) {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}
