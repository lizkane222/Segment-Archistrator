/*
 * Rich text: what a label is when a word inside it can be bold.
 *
 * Every label on this canvas -- a component's name, a zone's, a shape's, a table cell's -- is
 * plain text with one style for the whole of it. That is right for a component called
 * "Braze" and wrong the moment a shape is being used as a callout, which is most of what
 * shapes are for: an annotation wants two lines, an emphasised word, and a list.
 *
 * ## Runs, not HTML
 *
 * The obvious storage is a fragment of HTML, and it is the wrong one. A saved diagram can be
 * shared with a workspace (`Diagram.shared_with_workspace`), which means one person's label is
 * rendered in another person's browser -- so HTML in the document is a stored-XSS surface, and
 * defending it means an allowlist sanitiser that has to be right forever. There is nothing to
 * gain from that risk: the formatting actually being asked for is bold, italic, underline and
 * strikethrough on a span of characters.
 *
 * So the document stores a structure of its own, and rendering builds React elements from it.
 * A `<script>` cannot be expressed in the model, so there is nothing to sanitise:
 *
 *   {blocks: [{list: 'bullet' | 'number' | null, runs: [{text, b, i, u, s}]}]}
 *
 * One block per line, one run per stretch of identical formatting. Marks are stored as flags
 * rather than as nesting, because nesting has an ordering problem the flags do not: `<b><i>x`
 * and `<i><b>x` are the same text and would compare, fingerprint and diff as different
 * documents.
 *
 * ## The plain text stays authoritative
 *
 * Nothing here replaces `data.name`. Export, search, the minimap, the unsaved-changes
 * fingerprint, feedback titles, the server's validators and every toast read that field, and a
 * label that became a structure would break all of them at once. Rich text is *additive*: a
 * node carries `nameRich` alongside `name`, whoever commits an edit writes both, and `name` is
 * always `richToText(nameRich)`. So a reader that knows nothing about this file keeps working,
 * and one that does gets the formatting.
 *
 * ## Offsets are over the plain text
 *
 * `applyMark` takes a start and an end in plain-text characters, not a block and a run index.
 * That is the coordinate system a text selection actually arrives in -- `richToText` and the
 * DOM agree on it -- and it means the caller never has to know how the runs happen to be split.
 * Splitting and re-merging is this module's problem, which is what `normalizeRich` is for.
 */

/* The four marks, and the whole list. Colour and size are deliberately absent: they are set
   for a whole label at a time (`data.style`), because a diagram with two type sizes inside one
   card is not a thing anyone has asked for and every per-run property is another dimension the
   normaliser has to compare. */
export const MARKS = ['b', 'i', 'u', 's']

/* One block per line. The separator is what `richToText` joins with and what `richFromText`
   splits on, so the round trip through plain text is lossless in the one way that matters. */
const NEWLINE = '\n'

const emptyRun = (text = '') => ({ text })

/** A rich value holding exactly this plain text, with no formatting. */
export function richFromText(text) {
  const lines = String(text ?? '').split(NEWLINE)
  return { blocks: lines.map((line) => ({ runs: [emptyRun(line)] })) }
}

/**
 * The plain text of a rich value.
 *
 * The projection everything else in the app reads, so it has to be exact rather than
 * approximate: it is what gets stored in `data.name`, and a mismatch would show up as a card
 * whose label and whose tooltip disagree.
 *
 * A list marker is *not* included. The bullet is formatting -- the model records that the line
 * is a list item, and the renderer draws the dot -- so putting "• " in the plain text would put
 * it in the component's name, in search results and in the exported PNG's alt text.
 */
export function richToText(rich) {
  if (!rich) return ''
  return (rich.blocks ?? [])
    .map((block) => (block.runs ?? []).map((run) => run.text ?? '').join(''))
    .join(NEWLINE)
}

/** Is there nothing here? An empty value is stored as `undefined`, never as empty blocks. */
export function isEmptyRich(rich) {
  return richToText(rich).length === 0 && !(rich?.blocks ?? []).some((block) => block.list)
}

/**
 * Is there any formatting here, as opposed to plain text that happens to be in a rich shape?
 *
 * What decides whether a commit stores `nameRich` at all. It usually should not: the plain `name`
 * already round-trips, and `RichLabel` renders it -- newlines included -- so a label nobody has
 * formatted must serialize byte-identically to the way it did before rich labels existed. Anything
 * else marks every diagram in the database dirty the first time a label is touched.
 */
export function hasFormatting(rich) {
  return (rich?.blocks ?? []).some(
    (block) => block.list || (block.runs ?? []).some((run) => MARKS.some((mark) => run?.[mark])),
  )
}

/** Do two rich values say the same thing, formatting included? */
export function sameRich(a, b) {
  return JSON.stringify(normalizeRich(a)) === JSON.stringify(normalizeRich(b))
}

/*
 * Runs with the same formatting, merged; runs with no text, dropped.
 *
 * Called after every edit, and it is what keeps the document stable. Without it, marking a word
 * bold and then unmarking it leaves three runs where there was one -- the same text, a
 * different structure, and therefore a different `graphFingerprint`, so the diagram reads as
 * having unsaved changes after an edit that undid itself. It is also what keeps two identical
 * labels comparing equal however they were typed.
 *
 * A block with no runs keeps one empty run rather than none: an empty line is a line, and the
 * editor needs somewhere to put the caret.
 */
export function normalizeRich(rich) {
  const blocks = (rich?.blocks ?? []).map((block) => {
    const runs = []
    for (const run of block.runs ?? []) {
      const text = run?.text ?? ''
      if (!text) continue
      const marks = markFlags(run)
      const last = runs[runs.length - 1]
      if (last && sameMarks(last, marks)) last.text += text
      else runs.push({ text, ...marks })
    }
    return {
      ...(block.list ? { list: block.list } : {}),
      runs: runs.length ? runs : [emptyRun()],
    }
  })
  return { blocks: blocks.length ? blocks : [{ runs: [emptyRun()] }] }
}

/* Only the marks that are on, in a fixed key order, so two runs formatted the same way produce
   byte-identical JSON. `{b: true}` and `{b: true, i: false}` mean the same thing and must not
   serialize differently -- the fingerprint compares the document, not its meaning. */
function markFlags(run) {
  const flags = {}
  for (const mark of MARKS) if (run?.[mark]) flags[mark] = true
  return flags
}

function sameMarks(a, b) {
  return MARKS.every((mark) => Boolean(a?.[mark]) === Boolean(b?.[mark]))
}

/**
 * Turn a mark on or off over a range of the plain text.
 *
 * `on` decides which way, and the caller decides what "which way" means: a toolbar button that
 * toggles reads `markState` first, so the whole selection is made bold unless all of it already
 * is -- which is what every editor does and what nobody can describe until they use one that
 * gets it wrong.
 *
 * Offsets are clamped and an empty or reversed range is a no-op returning the same value, so a
 * button pressed with no selection cannot mark the entire label by accident.
 */
export function applyMark(rich, start, end, mark, on = true) {
  if (!MARKS.includes(mark)) return rich
  const text = richToText(rich)
  const from = Math.max(0, Math.min(text.length, Math.min(start, end)))
  const to = Math.max(0, Math.min(text.length, Math.max(start, end)))
  if (from === to) return rich

  /* Walked as a running offset over the whole value, splitting each run where the range starts
     or ends. The newline between two blocks counts as one character, because that is what
     `richToText` puts there and therefore what the caller's offsets are measured against. */
  let cursor = 0
  const blocks = (normalizeRich(rich).blocks ?? []).map((block, index) => {
    if (index > 0) cursor += NEWLINE.length
    const runs = []
    for (const run of block.runs ?? []) {
      const length = run.text.length
      const runStart = cursor
      const runEnd = cursor + length
      cursor = runEnd

      /* Entirely outside: kept as it is. */
      if (runEnd <= from || runStart >= to) {
        runs.push(run)
        continue
      }

      const head = run.text.slice(0, Math.max(0, from - runStart))
      const body = run.text.slice(Math.max(0, from - runStart), Math.min(length, to - runStart))
      const tail = run.text.slice(Math.min(length, to - runStart))

      if (head) runs.push({ ...run, text: head })
      if (body) {
        const marked = { ...run, text: body }
        if (on) marked[mark] = true
        else delete marked[mark]
        runs.push(marked)
      }
      if (tail) runs.push({ ...run, text: tail })
    }
    return { ...block, runs }
  })

  return normalizeRich({ blocks })
}

/**
 * Whether a mark is on across a range: `'all'`, `'some'` or `'none'`.
 *
 * Three answers rather than a boolean because a toolbar needs all three. `all` is what makes the
 * button look pressed and what makes pressing it *remove* the mark; `some` has to look
 * unpressed and still add it, or bolding a selection that happens to contain one bold word
 * would un-bold that word instead.
 */
export function markState(rich, start, end, mark) {
  const text = richToText(rich)
  const from = Math.max(0, Math.min(text.length, Math.min(start, end)))
  const to = Math.max(0, Math.min(text.length, Math.max(start, end)))
  if (from === to) return 'none'

  let cursor = 0
  let marked = 0
  let total = 0
  for (const [index, block] of (normalizeRich(rich).blocks ?? []).entries()) {
    if (index > 0) cursor += NEWLINE.length
    for (const run of block.runs ?? []) {
      const runStart = cursor
      const runEnd = cursor + run.text.length
      cursor = runEnd
      const overlap = Math.min(runEnd, to) - Math.max(runStart, from)
      if (overlap <= 0) continue
      total += overlap
      if (run[mark]) marked += overlap
    }
  }

  if (!total || !marked) return 'none'
  return marked === total ? 'all' : 'some'
}

/** Every mark removed, formatting reset, text kept. What the toolbar's eraser does. */
export function clearMarks(rich) {
  return richFromText(richToText(rich))
}

/** Set, change or remove the list style of the blocks a range touches. */
export function setList(rich, start, end, list) {
  const text = richToText(rich)
  const from = Math.max(0, Math.min(text.length, Math.min(start, end)))
  const to = Math.max(0, Math.min(text.length, Math.max(start, end)))

  let cursor = 0
  const blocks = (normalizeRich(rich).blocks ?? []).map((block, index) => {
    if (index > 0) cursor += NEWLINE.length
    const length = (block.runs ?? []).reduce((sum, run) => sum + run.text.length, 0)
    const blockStart = cursor
    const blockEnd = cursor + length
    cursor = blockEnd

    /* `<=` on both ends, unlike `applyMark`'s range test: a caret sitting at the end of a line
       with nothing selected is still *in* that line, and "make this a bullet" with no selection
       is the ordinary way anyone uses the button. */
    const touched = blockStart <= to && blockEnd >= from
    if (!touched) return block
    const next = { ...block }
    if (list) next.list = list
    else delete next.list
    return next
  })
  return normalizeRich({ blocks })
}

/* --- reading an edit back out of the DOM ------------------------------------- */

/*
 * The one function here that knows what a browser is.
 *
 * The editor is an uncontrolled `contentEditable`: React seeds it once and then the browser owns
 * the caret, the typing and the marks (`document.execCommand`, which is deprecated and
 * universally implemented -- and reimplementing caret-aware bold over a controlled tree is a
 * text editor, not a diagramming tool). So an edit ends as DOM, and this converts it back.
 *
 * Deliberately narrow. Everything the browser produces that is not one of the four marks or a
 * line break is *dropped* -- a pasted `<img>`, a `<span style="font-family: Comic Sans">`, a
 * whole nested table -- because the model has nowhere to put it, which is the same property that
 * makes the model safe to store. Paste of formatted text therefore keeps the four marks it can
 * express and loses the rest, which is the honest outcome.
 */
export function richFromDom(root) {
  if (!root) return richFromText('')

  const blocks = [{ runs: [] }]
  /*
   * Whether anything has been emitted yet, which is what decides if a block-level element starts
   * a *new* line or fills the first one. Without it the rule has to be "start a new block unless
   * the current one is empty", and that reads two consecutive empty lines as one -- so pressing
   * Enter twice in a shape label produced one blank line and the second press appeared to do
   * nothing.
   */
  let started = false

  const pushRun = (text, marks) => {
    if (!text) return
    blocks[blocks.length - 1].runs.push({ text, ...marks })
    started = true
  }
  const newBlock = () => {
    blocks.push({ runs: [] })
    started = true
  }

  const walk = (node, marks) => {
    /* Node.TEXT_NODE === 3, Node.ELEMENT_NODE === 1. Compared as numbers because this runs in
       whatever the caller's environment is, and a test has no `Node` global. */
    if (node.nodeType === 3) {
      pushRun(node.nodeValue ?? '', marks)
      return
    }
    if (node.nodeType !== 1) return

    const tag = (node.tagName ?? '').toLowerCase()
    if (tag === 'br') return newBlock()

    /* A block-level element starts a new line -- which is how a browser represents Enter, and it
       varies: Chrome gives `<div>`, Firefox has historically given `<br>`, and a paste can bring
       `<p>`. All three end up as one block per line. */
    const block = tag === 'div' || tag === 'p' || tag === 'li'
    if (block) {
      if (started) newBlock()
      started = true
    }
    /* Which block this element's own content belongs to, remembered *before* its children are
       walked. An empty list item is `<li><br></li>` in some browsers, and reading the flag off
       the last block afterwards would put "this line is a bullet" on the line the `<br>`
       started rather than on the item itself. */
    const at = blocks.length - 1

    const next = { ...marks }
    if (tag === 'b' || tag === 'strong') next.b = true
    if (tag === 'i' || tag === 'em') next.i = true
    if (tag === 'u') next.u = true
    if (tag === 's' || tag === 'strike' || tag === 'del') next.s = true
    /* execCommand may produce inline styles instead of tags, depending on the browser and on
       `styleWithCSS`. Read as well as the tags, or bold would silently not persist. */
    const style = node.style ?? {}
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) next.b = true
    if (style.fontStyle === 'italic') next.i = true
    if (String(style.textDecoration ?? '').includes('underline')) next.u = true
    if (String(style.textDecoration ?? '').includes('line-through')) next.s = true

    for (const child of childrenOf(node)) walk(child, next)

    if (tag === 'li' && blocks[at]) {
      const ordered = (node.parentNode?.tagName ?? '').toLowerCase() === 'ol'
      blocks[at].list = ordered ? 'number' : 'bullet'
    }
  }

  for (const child of childrenOf(root)) walk(child, {})
  return normalizeRich({ blocks })
}

/*
 * An element's children, minus the trailing `<br>` browsers add as filler.
 *
 * Every engine puts one inside an otherwise-empty editable block so it can be focused and shown
 * -- it is not a line the user typed, and counting it appends a blank line to the label on every
 * commit. The cost is that a label deliberately ending in a blank line loses it, which is the
 * trade every editor makes here because the two are indistinguishable in the DOM.
 */
function childrenOf(node) {
  const children = [...(node.childNodes ?? [])]
  const last = children[children.length - 1]
  if (last?.nodeType === 1 && (last.tagName ?? '').toLowerCase() === 'br') children.pop()
  return children
}
