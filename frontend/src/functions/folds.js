/*
 * Which parts of a function body can be folded away, and what is left showing.
 *
 * A workspace function is often several hundred lines: a header comment, a handful of
 * shared helpers, then seven handlers of which two matter. Read in a 384px sidebar
 * that is a great deal of scrolling to establish something the reader could have seen
 * at a glance, so every brace block and every multi-line comment collapses to its
 * first line.
 *
 * Pure and separate from ./CodeEditor.jsx for the usual reason: "where does this
 * function end" is a question about JavaScript, not about React, and it is the part
 * worth testing.
 *
 * Brace matching runs on ./prepare.js's `codeMask`, not on the source, so a `{` inside
 * a string or a comment cannot open a region that never closes -- which would fold the
 * entire rest of the file away and look like the code had been deleted.
 */

import { codeMask, spans } from './prepare.js'

/*
 * How many lines a region must span to be worth folding.
 *
 * A region whose closing brace is on the next line hides nothing when collapsed -- the
 * chevron would be a control that visibly does nothing. Three lines means at least one
 * line actually disappears.
 */
const MIN_LINES = 3

/**
 * The foldable regions of `source`, as `{start, end, kind}` with 0-based line numbers.
 *
 * `start` stays visible when the region is collapsed; `start + 1` through `end` are
 * what gets hidden. Sorted by start, then widest first, so a line that opens more than
 * one region (`}) {` chains, or a comment that begins on the same line as a brace)
 * folds the larger of them -- the reader clicking a chevron means "hide this whole
 * thing".
 */
export function foldRegions(source) {
  const text = String(source ?? '')
  if (!text) return []

  const starts = lineStarts(text)
  const lineOf = (offset) => {
    /* Binary search rather than counting newlines: this is called twice per region and
       a 500-line source has a few hundred of them. */
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low
  }

  const regions = []

  /* Block comments first. A seventy-line header is the single most valuable thing on
     this list -- it is the region a reader folds once and never opens again. */
  for (const span of spans(text)) {
    if (span.type !== 'block-comment') continue
    const start = lineOf(span.start)
    const end = lineOf(span.end - 1)
    if (end - start + 1 >= MIN_LINES) regions.push({ start, end, kind: 'comment' })
  }

  /* Then brace blocks, from the masked source so only real braces count. */
  const mask = codeMask(text)
  const open = []
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === '{') open.push(index)
    else if (mask[index] === '}') {
      const from = open.pop()
      if (from === undefined) continue
      const start = lineOf(from)
      const end = lineOf(index)
      if (end - start + 1 >= MIN_LINES) regions.push({ start, end, kind: 'block' })
    }
  }

  return regions.sort((a, b) => a.start - b.start || b.end - a.end)
}

function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/**
 * One region per line that can be folded, keyed by its first line.
 *
 * A line can open several regions -- `function f() { /* … *\/` -- and only one chevron
 * fits in the gutter, so the widest wins. Built as a Map because both the gutter and
 * `visibleRows` ask the same question ("what does line N fold?") and deriving it twice
 * from the sorted list would be two different answers waiting to happen.
 */
export function foldsByLine(regions) {
  const byLine = new Map()
  for (const region of regions ?? []) {
    const held = byLine.get(region.start)
    if (!held || region.end > held.end) byLine.set(region.start, region)
  }
  return byLine
}

/**
 * The lines to render, given which folds the reader has closed.
 *
 * @param source     the code
 * @param collapsed  a Set of 0-based line numbers whose regions are closed
 * @returns `[{index, text, fold, hidden}]` where `index` is the real line number (so
 *   the gutter keeps counting through a fold rather than renumbering), `fold` is
 *   `'open' | 'closed' | null`, and `hidden` is how many lines this row stands for
 *   when closed.
 *
 * A collapsed region inside another collapsed region simply is not rendered, which is
 * why this walks forward rather than filtering: the outer fold's hidden range already
 * covers it, and the reader who opens the outer one should find the inner one still
 * closed. That is what makes folding a header and then folding a handler inside it
 * behave the way it looks like it should.
 */
export function visibleRows(source, collapsed = new Set()) {
  const lines = String(source ?? '').split('\n')
  const byLine = foldsByLine(foldRegions(source))
  const rows = []

  let index = 0
  while (index < lines.length) {
    const region = byLine.get(index)
    const closed = Boolean(region) && collapsed.has(index)

    rows.push({
      index,
      text: lines[index],
      fold: region ? (closed ? 'closed' : 'open') : null,
      hidden: closed ? region.end - region.start : 0,
    })

    index = closed ? region.end + 1 : index + 1
  }

  return rows
}

/** Every foldable line in `source`. What the "collapse all" control acts on. */
export function allFoldableLines(source) {
  return [...foldsByLine(foldRegions(source)).keys()]
}
