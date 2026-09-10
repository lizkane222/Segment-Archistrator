/*
 * The derived problem title, in the browser.
 *
 * A mirror of `apps/feedback/titles.py`, and it exists for one reason only: to *show* the reporter how
 * their report will be filed while they are still typing it. Someone who can see the title writes a
 * first sentence that reads well in a list view, which is the point of deriving it from the description
 * rather than asking for it as a separate field.
 *
 * The server's copy is the one that is stored. This value is never sent, so the two cannot disagree
 * about what was recorded -- the worst a drift between them could do is show a preview that differs
 * slightly from the record, which is why `feedbackTitle.test.js` checks the two word lists against
 * each other by reading the Python.
 */

/* Both lists, in the same order as the Python, so a diff between the two files is readable. */
const ARTICLES = [
  'a', 'an', 'the', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'their', 'they', 'them',
]

const PREPOSITIONS = [
  'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'as', 'at',
  'before', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'by',
  'down', 'during', 'except', 'for', 'from',
  'in', 'inside', 'into', 'like', 'near',
  'of', 'off', 'on', 'onto', 'out', 'outside', 'over',
  'past', 'since', 'through', 'throughout', 'to', 'toward', 'towards',
  'under', 'underneath', 'until', 'up', 'upon', 'with', 'within', 'without',
]

export const SKIPPED = new Set([...ARTICLES, ...PREPOSITIONS])

export const TITLE_WORDS = 5
export const MAX_TITLE = 120

/* Letters, digits, and the punctuation that lives *inside* words: apostrophes so "doesn't" stays one
   word, hyphens for "side-by-side", dots and underscores because a bug report names `data.paths` and
   `sql_table` and those are the most informative words in the sentence. */
const WORD = /[A-Za-z0-9][A-Za-z0-9'’._-]*/g

export function problemTitle(description) {
  const text = String(description ?? '').trim()
  if (!text) return 'Untitled feedback'

  const words = text.match(WORD)
  if (!words?.length) return 'Untitled feedback'

  const kept = []
  for (const word of words) {
    if (SKIPPED.has(word.toLowerCase())) continue
    kept.push(word)
    if (kept.length === TITLE_WORDS) break
  }

  /* Every word was a skipped one -- "in the on" is a thing a person types. A title that reads oddly
     beats a blank one on a record nobody can then find. */
  const chosen = kept.length ? kept : words.slice(0, TITLE_WORDS)
  const title = chosen.join(' ')
  if (title.length <= MAX_TITLE) return title

  const trimmed = title.slice(0, MAX_TITLE).replace(/\s+\S*$/, '')
  return `${(trimmed || title.slice(0, MAX_TITLE)).trimEnd()}…`
}
