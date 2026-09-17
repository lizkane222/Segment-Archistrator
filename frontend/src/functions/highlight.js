/*
 * Colouring the read view of a function body.
 *
 * Not a general syntax highlighter, and it should not grow into one. It draws the few
 * distinctions that make a folded 400-line function scannable: the comment blocks are the
 * parts you skip, the strings are the field names and event names you are usually looking
 * for, the keywords are where the control flow is -- and, set apart from all of those in
 * bold, Segment's own API surface, which is what tells you at a glance which handler you are
 * in and what it throws.
 *
 * It costs almost nothing because ./prepare.js's `spans` has already done the hard
 * part. Anything beyond this (types, member expressions, JSX) would mean a real parser,
 * and a diagram tool has no business carrying one.
 */

import { spans } from './prepare.js'

/* The words worth picking out. `return` and `throw` earn their place twice over: on a
   Segment function the whole contract is what you return and what you throw. */
const KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
])

/*
 * Segment's own vocabulary, set apart from ordinary JavaScript and from each other.
 *
 * The distinction is worth drawing because these are the words that make a function body a
 * *Segment* function body rather than any old JavaScript, and they are what a reader scans
 * for: which handler is this, what does it throw, what does it emit. `SEGMENT_WORDS` is
 * rendered bold, because it is the API surface and the thing you are looking for; the
 * parameters below are coloured but not bold, because they are everywhere and bolding them
 * would make the whole file bold.
 */
const SEGMENT_WORDS = new Set([
  /* The error classes. On these four the whole contract rests: what you throw decides
     whether Segment retries, drops, or rejects. */
  'DropEvent',
  'EventNotSupported',
  'InvalidEventPayload',
  'RetryError',
  'ValidationError',
  /* The globals the platform injects. */
  'Segment',
  'cache',
  /* The handlers. An omitted one blocks its event type, so which of these a file declares
     is a fact about the pipeline and not just about the code. */
  'onRequest',
  'onIdentify',
  'onTrack',
  'onPage',
  'onScreen',
  'onGroup',
  'onAlias',
  'onDelete',
  'onBatch',
])

/* What a handler is handed, plus the literals. Coloured, not bold. */
const RUNTIME_WORDS = new Set([
  'console',
  'event',
  'settings',
  'request',
  'null',
  'undefined',
  'true',
  'false',
])

/*
 * Whole expressions worth marking, not just words.
 *
 * `Segment.track` reads as one thing and `track` on its own is far too generic to colour, so
 * the member access is matched as a unit. Same for `cache.load`, whose TTL argument is the
 * single most common mistake in a real function, and for the request accessors the templates
 * warn about by name.
 */
const SEGMENT_MEMBERS =
  /\bSegment\s*\.\s*(?:identify|track|page|screen|group|alias|set)\b|\bcache\s*\.\s*load\b|\brequest\s*\.\s*(?:json|text|headers|url)\b/g

/** The class names the editor styles. Kept as data so the CSS lives in one place. */
export const TOKEN = Object.freeze({
  comment: 'comment',
  string: 'string',
  keyword: 'keyword',
  /** Segment's own API surface: the error classes, the globals, the handler names. Bold. */
  segment: 'segment',
  runtime: 'runtime',
  number: 'number',
  plain: 'plain',
})

/**
 * `source` as one array of `{text, token}` segments per line.
 *
 * Per line rather than one flat list, because the read view renders a row at a time and
 * folds hide whole ranges of them -- a flat list would have to be re-sliced on every
 * fold. Segments never span a newline, so a row can be rendered without looking at its
 * neighbours.
 */
export function highlightLines(source) {
  const text = String(source ?? '')
  const classes = classify(text)
  const lines = text.split('\n')

  const out = []
  let offset = 0
  for (const line of lines) {
    out.push(group(line, classes, offset))
    offset += line.length + 1
  }
  return out
}

/** A token class per character of `text`. */
function classify(text) {
  const classes = new Array(text.length).fill(TOKEN.plain)

  for (const span of spans(text)) {
    if (span.type === 'code') continue
    const token =
      span.type === 'line-comment' || span.type === 'block-comment' ? TOKEN.comment : TOKEN.string
    for (let index = span.start; index < span.end; index += 1) classes[index] = token
  }

  /* Words and numbers, but only where the character is still plain -- so `for` inside a
     comment stays a comment and a URL inside a string stays a string. */
  const word = /[A-Za-z_$][\w$]*|\d[\w.]*/g
  let match
  while ((match = word.exec(text)) !== null) {
    if (classes[match.index] !== TOKEN.plain) continue
    const token = tokenFor(match[0])
    if (!token) continue
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      classes[index] = token
    }
  }

  /*
   * Member expressions last, so they win over the word pass.
   *
   * `Segment.track` has already been partly coloured by then -- `Segment` as a segment word,
   * `track` as nothing -- and this paints the whole run, dot included, so it reads as the one
   * call it is rather than as a coloured object beside a plain method.
   */
  SEGMENT_MEMBERS.lastIndex = 0
  while ((match = SEGMENT_MEMBERS.exec(text)) !== null) {
    if (classes[match.index] === TOKEN.comment || classes[match.index] === TOKEN.string) continue
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      classes[index] = TOKEN.segment
    }
  }

  return classes
}

function tokenFor(word) {
  if (KEYWORDS.has(word)) return TOKEN.keyword
  if (SEGMENT_WORDS.has(word)) return TOKEN.segment
  if (RUNTIME_WORDS.has(word)) return TOKEN.runtime
  if (/^\d/.test(word)) return TOKEN.number
  return null
}

/** Consecutive characters of one class, collapsed into segments. */
function group(line, classes, offset) {
  const segments = []
  for (let index = 0; index < line.length; index += 1) {
    const token = classes[offset + index] ?? TOKEN.plain
    const last = segments[segments.length - 1]
    if (last && last.token === token) last.text += line[index]
    else segments.push({ token, text: line[index] })
  }
  return segments
}
