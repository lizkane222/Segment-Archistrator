/*
 * Reading an identity resolution rule table out of a screenshot.
 *
 * The screenshot is the Segment settings page's table -- Priority, Identifier, Seen, Value limit, Blocked
 * values -- and what the diagram's own table keeps is three of those: the row's position (priority), its
 * identifier (`externalId`), and the limit (`limit` and `frequency`). OCR gives back words with boxes; this
 * turns them into rows, and does nothing else. It is pure, so the part that has opinions about layout is
 * tested without a browser, an image or an OCR engine.
 *
 * ## How the table is found
 *
 * By its header, not by pixel positions: the words "Priority", "Identifier", "Value" and "Blocked" say
 * where those columns start in *this* image, at whatever size and crop it was taken. A row is a number in
 * the Priority column; everything to its right and level with it (down to the next row's number) belongs
 * to it. A value that wraps over two lines -- "10" over "weekly" -- therefore stays one value.
 *
 * ## What it will not claim
 *
 * OCR is wrong sometimes, most often on underscores. So the result is a *proposal*: the dialog shows it
 * for correction before anything is written, and a row whose text looked doubtful is flagged.
 */

import { LIMIT_FREQUENCIES } from '../canvas/nodes/IdentityRuleTable.jsx'

/* What the settings page calls each window, in its own words, to the app's. */
const WINDOWS = [
  [/^dai/i, 'Day'],
  [/^week/i, 'Week'],
  [/^month/i, 'Month'],
  [/^quarter/i, 'Quarter'],
  [/^(year|annual)/i, 'Year'],
  [/^ever/i, 'Ever'],
]

const word = (w) => String(w.text ?? '').trim()
const centreY = (w) => (w.y0 + w.y1) / 2
/* A short fragment OCR was hardly sure of is a smudge or a stray mark, not part of a name. */
const smudge = (w) => typeof w.confidence === 'number' && w.confidence < 35 && word(w).length <= 3

/**
 * An identifier as it was meant to read.
 *
 * OCR drops underscores or splits a name where one was -- "uncredentialed_member. id" -- so the pieces are
 * rejoined with `_`, stray punctuation at either end goes, and anything that cannot be part of an
 * identifier is dropped. A dot *inside* a name stays: `android.id` is a real identifier.
 */
export function cleanIdentifier(tokens) {
  const pieces = tokens
    .map((token) => String(token).replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9_@]+$/g, '').replace(/[^A-Za-z0-9_.@-]/g, ''))
    .filter(Boolean)
  return pieces.join('_').replace(/_{2,}/g, '_')
}

/**
 * "5 weekly" -> `{limit: 5, frequency: 'Week'}`; a bare "1" -> `{limit: 1, frequency: 'Ever'}`.
 * Null when there is no number at all, which is a cell OCR could not read rather than an answer.
 */
export function parseLimit(tokens) {
  const text = tokens.join(' ')
  const number = /\d+/.exec(text)
  if (!number) return null
  const limit = Math.max(1, Number.parseInt(number[0], 10))
  let frequency = 'Ever'
  for (const token of tokens) {
    const hit = WINDOWS.find(([pattern]) => pattern.test(token.replace(/[^A-Za-z]/g, '')))
    if (hit) {
      frequency = hit[1]
      break
    }
  }
  return { limit, frequency: LIMIT_FREQUENCIES.includes(frequency) ? frequency : 'Ever' }
}

/**
 * @param words  `{text, x0, y0, x1, y1}` from OCR, in the image's own pixels
 * @returns `{rows, problems}` -- rows are `{externalId, limit, frequency}` in priority order
 */
export function parseRuleTable(words) {
  const all = (words ?? []).filter((entry) => word(entry))
  const find = (pattern) =>
    all
      .filter((entry) => pattern.test(word(entry).replace(/[^A-Za-z]/g, '')))
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)[0]

  const priority = find(/^priority$/i)
  const identifier = find(/^identifier$/i)
  const seen = find(/^seen$/i)
  const value = find(/^value$/i)
  const blocked = find(/^blocked$/i)

  if (!priority || !identifier) {
    return {
      rows: [],
      problems: ['Could not find the Priority and Identifier column headings. Crop the screenshot to include the header row.'],
    }
  }

  const width = Math.max(...all.map((entry) => entry.x1), 1)
  const pad = width * 0.012
  const headerBottom = Math.max(priority.y1, identifier.y1, value?.y1 ?? 0)

  const columns = {
    priority: [-Infinity, identifier.x0 - pad],
    identifier: [identifier.x0 - pad, (seen ?? value ?? blocked)?.x0 - pad || Infinity],
    limit: value ? [value.x0 - pad * 2, (blocked?.x0 ?? Infinity) - pad] : null,
  }
  const inColumn = (entry, [from, to]) => entry.x0 >= from && entry.x0 < to

  /*
   * One row per *line of identifier*, not per number in the priority column.
   *
   * The numbers were tried first and OCR drops them: the "1" of the first row came back as a vertical
   * bar, and a row with no number to anchor it was swallowed by the one above. An identifier is the one
   * thing every row has, and it is a single line, so the lines are what rows are counted from. The
   * numbers are only a cross-check.
   */
  const names = all
    .filter(
      (entry) =>
        inColumn(entry, columns.identifier) &&
        entry.y0 > headerBottom &&
        !smudge(entry) &&
        /[A-Za-z0-9]{2,}/.test(word(entry)),
    )
    .sort((a, b) => centreY(a) - centreY(b))
  if (!names.length) {
    return { rows: [], problems: ['Found the header but no identifiers under it.'] }
  }
  const heights = names.map((entry) => entry.y1 - entry.y0).sort((a, b) => a - b)
  const lineGap = Math.max(heights[Math.floor(heights.length / 2)] * 1.1, 8)
  const lines = []
  for (const entry of names) {
    const last = lines[lines.length - 1]
    if (last && centreY(entry) - last.y <= lineGap) {
      last.words.push(entry)
      last.y = last.words.reduce((sum, w) => sum + centreY(w), 0) / last.words.length
    } else {
      lines.push({ y: centreY(entry), words: [entry] })
    }
  }

  const bands = lines.map((line, index) => {
    const previous = lines[index - 1] ? (lines[index - 1].y + line.y) / 2 : headerBottom
    const next = lines[index + 1] ? (lines[index + 1].y + line.y) / 2 : Infinity
    return [previous, next]
  })

  const numbered = all.filter(
    (entry) => inColumn(entry, columns.priority) && entry.y0 > headerBottom && /^\d{1,2}$/.test(word(entry)),
  ).length

  const problems = []
  /* More numbers than names means a name was missed. The reverse is just OCR losing a digit. */
  if (numbered > lines.length) {
    problems.push(`The table shows ${numbered} priorities but only ${lines.length} identifiers were read -- a row may be missing.`)
  }
  const rows = []
  bands.forEach(([top, bottom], index) => {
    const inBand = (entry) => centreY(entry) >= top && centreY(entry) < bottom
    const reading = (entry) => [Math.round(centreY(entry) / 12), entry.x0]
    const inOrder = (list) => [...list].sort((a, b) => reading(a)[0] - reading(b)[0] || a.x0 - b.x0)

    const nameTokens = inOrder(all.filter((entry) => inBand(entry) && inColumn(entry, columns.identifier) && !smudge(entry))).map(word)
    const externalId = cleanIdentifier(nameTokens)
    const limitTokens = columns.limit
      ? inOrder(all.filter((entry) => inBand(entry) && inColumn(entry, columns.limit) && !smudge(entry))).map(word)
      : []
    const limit = parseLimit(limitTokens)

    if (!externalId) {
      problems.push(`Row ${index + 1}: could not read the identifier.`)
      return
    }
    if (columns.limit && !limit) problems.push(`Row ${index + 1}: could not read the value limit, so it is set to 1 Ever.`)
    rows.push({ externalId, limit: limit?.limit ?? 1, frequency: limit?.frequency ?? 'Ever' })
  })

  return { rows, problems }
}
