/*
 * Editing a rich label in place.
 *
 * A `contentEditable` that React seeds once and then leaves alone, which is the decision the rest
 * of this file follows from. The alternative -- a controlled tree re-rendered on every keystroke
 * -- means owning the caret: React replaces the DOM nodes the browser's selection points into, so
 * the caret has to be found, measured in characters, and restored after every render. That is a
 * text editor, and it is what every "why does my cursor jump to the end" question is about.
 *
 * So the browser owns typing, the caret and the marks (`document.execCommand`, which is
 * deprecated, universally implemented, and the only thing that applies bold to *the selection*
 * without reimplementing selection), and this component owns two moments: seeding the DOM on the
 * way in, and reading it back on the way out (`richFromDom`).
 *
 * ## Nothing is ever handed HTML
 *
 * The seed is built with `createElement`/`createTextNode`, not with an HTML string. There is no
 * `innerHTML` anywhere in this file and no HTML in the document -- see canvas/richText.js for why
 * that matters on a diagram that can be shared with a workspace.
 *
 * ## Two kinds of label
 *
 * A shape's label and a table cell are multi-line: Enter is a new line and the edit is committed
 * by clicking away or pressing Escape's opposite, Cmd-Enter. A component's name and a zone's
 * label are single-line: Enter commits, because that is what the `<input>` it replaced did and a
 * component name with a newline in it is a card that no longer fits its own box.
 */

import { useEffect, useRef } from 'react'

import { useChrome } from '../chrome.js'
import {
  applyMark,
  clearMarks,
  isEmptyRich,
  markState,
  richFromDom,
  richFromText,
  richToText,
  setList,
} from '../richText.js'

/**
 * @param value       the rich value, or null for a label that has only ever been plain
 * @param text        the plain fallback, so a never-formatted label seeds from `data.name`
 * @param sessionKey  what identifies this editor to the toolbar. Unique per label, so a table
 *   with nine cells has nine of them and clicking between two closes one and opens the other.
 * @param nodeId      which node the toolbar's node-wide controls (align, size, colour) apply to
 * @param multiline   Enter inserts a line rather than committing
 * @param onCommit    given `{rich, text}` -- both, because every caller stores both and deriving
 *   the plain text at each call site is how the two would drift
 * @param onCancel    Escape. Nothing is written.
 * @param onTab       given `+1` or `-1`, after the edit has been committed. Only a table passes
 *   one: moving to the next cell is the one keyboard gesture a grid of editable cells has to have,
 *   and only the grid knows what "next" is. Without it, Tab would leave the canvas entirely.
 */
export default function RichEditor({
  value,
  text = '',
  sessionKey,
  nodeId,
  multiline = false,
  align,
  onCommit,
  onCancel,
  onTab,
  className = '',
  style,
}) {
  const host = useRef(null)
  const { textEditing } = useChrome()
  /* The committed-or-cancelled flag. `blur` fires after Escape as well, and without this the
     cancel would be immediately followed by a commit of the DOM it had just abandoned. */
  const settled = useRef(false)

  /*
   * Seed, focus, select, and announce the session. Once, on mount.
   *
   * The empty dependency list is deliberate and load-bearing: re-running this on a change to
   * `value` would rewrite the DOM under the caret on every keystroke, since the parent's `value`
   * comes from the document and the document is written on commit. The editor is a *session* --
   * it starts from what was there and ends with what the user typed.
   */
  useEffect(() => {
    const element = host.current
    if (!element) return

    seed(element, value && !isEmptyRich(value) ? value : richFromText(text))
    element.focus()
    selectAll(element)

    /*
     * The session, including the four things the toolbar does to a mark.
     *
     * They live here rather than in the toolbar because they are DOM work -- read the runs out of
     * the element, apply a pure transform, put them back, restore the caret -- and the toolbar's
     * job is to be a row of buttons. See `mark` below for why this does not use `execCommand`.
     */
    textEditing?.begin({
      key: sessionKey,
      nodeId,
      element,
      multiline,
      mark: (name) => transform(element, (rich, from, to) =>
        applyMark(rich, from, to, name, markState(rich, from, to, name) !== 'all'),
      ),
      list: (style) => transform(element, (rich, from, to) => {
        const current = blockList(rich, from)
        return setList(rich, from, to, current === style ? null : style)
      }),
      clearFormatting: () => transform(element, (rich) => clearMarks(rich)),
      /* What the toolbar reads to draw a button pressed. From the runs rather than from
         `queryCommandState`, for the same reason the marks are applied that way. */
      state: (name) => {
        const rich = richFromDom(element)
        const { start, end } = textOffsets(element)
        return markState(rich, start, end, name)
      },
      listState: () => {
        const rich = richFromDom(element)
        return blockList(rich, textOffsets(element).start)
      },
    })
    return () => textEditing?.end(sessionKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    const rich = richFromDom(host.current)
    onCommit?.({ rich, text: richToText(rich) })
  }

  const cancel = () => {
    if (settled.current) return
    settled.current = true
    onCancel?.()
  }

  return (
    <div
      ref={host}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={multiline}
      aria-label="Label"
      /* `nodrag`/`nopan` so a drag inside the text selects it rather than hauling the node or
         panning the canvas. */
      className={`nodrag nopan cursor-text whitespace-pre-wrap break-words outline-none ${className}`}
      style={{ textAlign: align, ...style }}
      /* Without this, the click that places the caret is also a click on the node: it re-selects,
         and on a group member it re-selects every mate. */
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        /* All of it, unconditionally. Without this Backspace reaches React Flow's `deleteKeyCode`
           and deletes the component whose label is being typed into. */
        event.stopPropagation()

        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
          /* Blurs, which is what returns the keyboard to the canvas. `settled` is what stops the
             blur handler committing the text this just abandoned. */
          host.current?.blur()
          return
        }
        /*
         * The keyboard's own bold/italic/underline, routed through the model.
         *
         * The browser would otherwise handle these itself with `execCommand`, which is the exact
         * thing `transform` exists to avoid -- see the note there. Intercepted rather than left
         * alone so the shortcut and the toolbar button do the same thing.
         */
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
          const mark = { b: 'b', i: 'i', u: 'u' }[event.key.toLowerCase()]
          if (mark) {
            event.preventDefault()
            textEditing?.current()?.mark(mark)
            return
          }
        }

        if (event.key === 'Tab' && onTab) {
          /* Committed *before* moving, so the cell being left keeps what was typed into it. The
             browser's own Tab would move focus out of the canvas entirely. */
          event.preventDefault()
          commit()
          onTab(event.shiftKey ? -1 : 1)
          return
        }
        if (event.key === 'Enter') {
          /* Cmd/Ctrl-Enter always commits, so a multi-line label has a keyboard way out that is
             not "click somewhere else". */
          if (!multiline || event.metaKey || event.ctrlKey) {
            event.preventDefault()
            host.current?.blur()
          }
        }
      }}
      /*
       * Paste as plain text.
       *
       * The model can express four marks, so a paste from a browser or a word processor brings
       * mostly things it cannot hold -- fonts, sizes, colours, tables, images -- and
       * `richFromDom` would drop them on the next commit anyway. Dropping them *now* means what
       * lands in the label is what the user sees, rather than styling that survives until they
       * next click away and then vanishes.
       */
      onPaste={(event) => {
        event.preventDefault()
        const plain = event.clipboardData?.getData('text/plain') ?? ''
        if (plain) document.execCommand('insertText', false, plain)
      }}
    />
  )
}

/*
 * Apply a transform to what is in the editor, and put the caret back.
 *
 * The one place the editor stops being uncontrolled, and it is deliberately narrow: it runs when a
 * *mark* changes, which is a button press or a shortcut, never a keystroke. Typing stays entirely the
 * browser's, which is what keeps the caret out of this file's hands for everything except this.
 *
 * ## Why not `execCommand`
 *
 * `document.execCommand('bold')` is the obvious implementation and it is wrong here, for a reason
 * that took a browser to find: Chrome decides whether a selection is already bold by reading its
 * *computed* font weight, and every label on this canvas is `font-semibold` -- 600, which counts.
 * So the browser believed every card name and every table header was already bold, and the Bold
 * button ran backwards: it wrapped the selection in `font-weight: normal` and, once the commit
 * dropped that (the model has no "explicitly not bold"), appeared to do nothing at all.
 *
 * Going through the model has no such disagreement. `applyMark` and `markState` are pure, tested,
 * and answer about the runs rather than about CSS -- so bold means bold whatever the label's base
 * weight is, and the toolbar's pressed state is the same answer the transform acts on.
 */
function transform(element, change) {
  const rich = richFromDom(element)
  const { start, end } = textOffsets(element)
  const next = change(rich, start, end)
  seed(element, next)
  /* The same range, restored by offset: the DOM nodes it pointed into no longer exist, and a caret
     left where it happened to land after a re-seed is a caret at the start of the label. */
  placeSelection(element, start, end)
  element.focus()
}

/** The list style of the block a plain-text offset falls in, or null. */
function blockList(rich, offset) {
  let cursor = 0
  for (const [index, block] of (rich?.blocks ?? []).entries()) {
    if (index > 0) cursor += 1
    const length = (block.runs ?? []).reduce((sum, run) => sum + (run.text?.length ?? 0), 0)
    if (offset <= cursor + length) return block.list ?? null
    cursor += length
  }
  return null
}

/*
 * The selection, as offsets into the plain text.
 *
 * The coordinate system `applyMark` works in, and the only one that survives the DOM being rebuilt.
 * Walked over the editor's own text nodes, counting one character per line boundary because that is
 * what `richToText` puts between two blocks -- so the offsets here and the offsets there agree.
 */
function textOffsets(root) {
  const selection = window.getSelection?.()
  if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) {
    const length = richToText(richFromDom(root)).length
    /* No selection inside the editor: treat it as the whole label. A mark button pressed in that
       state is a user who means "all of this", which is also what opening the editor selects. */
    return { start: 0, end: length }
  }
  const range = selection.getRangeAt(0)
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/* How many plain-text characters precede a (node, offset) position. */
function offsetOf(root, node, offset) {
  let count = 0
  let found = null

  const walk = (current, isFirstBlock) => {
    if (found !== null) return isFirstBlock
    if (current === node && current.nodeType !== 3) {
      /* An element-level position: `offset` counts child *nodes*, so everything before it. */
      let seen = 0
      for (let index = 0; index < offset && index < current.childNodes.length; index += 1) {
        seen += lengthOf(current.childNodes[index])
      }
      found = count + seen
      return isFirstBlock
    }
    if (current.nodeType === 3) {
      if (current === node) {
        found = count + Math.min(offset, current.nodeValue?.length ?? 0)
        return isFirstBlock
      }
      count += current.nodeValue?.length ?? 0
      return isFirstBlock
    }

    const tag = (current.tagName ?? '').toLowerCase()
    if (tag === 'br') {
      count += 1
      return false
    }
    let first = isFirstBlock
    if (current !== root && (tag === 'div' || tag === 'p' || tag === 'li')) {
      if (!first) count += 1
      first = false
    }
    for (const child of current.childNodes) first = walk(child, first)
    return first
  }

  walk(root, true)
  return found ?? count
}

/* The plain-text length of a subtree, counting a line break as one character. */
function lengthOf(node) {
  if (node.nodeType === 3) return node.nodeValue?.length ?? 0
  if (node.nodeType !== 1) return 0
  const tag = (node.tagName ?? '').toLowerCase()
  if (tag === 'br') return 1
  let total = tag === 'div' || tag === 'p' || tag === 'li' ? 0 : 0
  for (const child of node.childNodes) total += lengthOf(child)
  return total
}

/* Put a selection back at two plain-text offsets, after the DOM has been rebuilt. */
function placeSelection(root, start, end) {
  const selection = window.getSelection?.()
  if (!selection) return
  const from = positionAt(root, start)
  const to = positionAt(root, end)
  if (!from || !to) return
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}

/* The (text node, offset) a plain-text offset lands on. Falls back to the end of the last text node,
   which is where a caret belongs when the offset is past the end. */
function positionAt(root, offset) {
  let count = 0
  let last = null
  let firstBlock = true

  const walk = (node) => {
    if (node.nodeType === 3) {
      const length = node.nodeValue?.length ?? 0
      last = { node, offset: length }
      if (count + length >= offset) return { node, offset: Math.max(0, offset - count) }
      count += length
      return null
    }
    if (node.nodeType !== 1) return null
    const tag = (node.tagName ?? '').toLowerCase()
    if (tag === 'br') {
      count += 1
      return null
    }
    if (node !== root && (tag === 'div' || tag === 'p' || tag === 'li')) {
      if (!firstBlock) count += 1
      firstBlock = false
      /* An empty line has no text node to land in, so the block itself is the position. */
      if (!node.childNodes.length || (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR')) {
        last = { node, offset: 0 }
        if (count >= offset) return { node, offset: 0 }
      }
    }
    for (const child of node.childNodes) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }

  return walk(root) ?? last ?? { node: root, offset: 0 }
}

/*
 * Build the DOM for a rich value: one element per line, one nested tag per mark.
 *
 * `replaceChildren()` first, so re-seeding is not additive -- and `createTextNode` for the text,
 * which is what makes this incapable of injecting markup however odd a label's contents are.
 */
function seed(root, rich) {
  root.replaceChildren()
  let list = null

  for (const block of rich.blocks ?? []) {
    const line = document.createElement(block.list ? 'li' : 'div')
    /* Runs with no text are skipped rather than appended as empty text nodes, which is what makes
       the `<br>` below actually happen for an empty line -- `richFromText('')` produces one run
       holding `''`, so a naive loop leaves the line with a child and no content. */
    for (const run of block.runs ?? []) {
      if (run?.text) line.appendChild(runNode(run))
    }
    /*
     * An empty line needs a `<br>`, and it is not cosmetic.
     *
     * A block containing only an empty text node has no height, so an empty cell cannot be seen or
     * clicked into -- and the browser refuses to insert into it at all: `execCommand('insertText')`
     * returns false and typing goes nowhere, because there is no valid caret position in it. Every
     * engine represents an empty editable block this way for exactly that reason.
     *
     * `richFromDom` drops this one again on the way out, so it never reaches the document -- see
     * `childrenOf` in canvas/richText.js.
     */
    if (!line.childNodes.length) line.appendChild(document.createElement('br'))

    if (block.list) {
      const tag = block.list === 'number' ? 'ol' : 'ul'
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag)
        /* The list's own indent, matching what RichLabel draws when it is not being edited --
           otherwise the text jumps sideways the moment the editor opens. */
        list.style.paddingLeft = '1.1em'
        list.style.listStyle = tag === 'ol' ? 'decimal' : 'disc'
        root.appendChild(list)
      }
      list.appendChild(line)
    } else {
      list = null
      root.appendChild(line)
    }
  }
}

const MARK_TAGS = [
  ['s', 's'],
  ['u', 'u'],
  ['i', 'em'],
  ['b', 'strong'],
]

function runNode(run) {
  let node = document.createTextNode(run.text ?? '')
  for (const [mark, tag] of MARK_TAGS) {
    if (!run[mark]) continue
    const wrapper = document.createElement(tag)
    wrapper.appendChild(node)
    node = wrapper
  }
  return node
}

/*
 * Select the whole label on open, which is what the `<input>` this replaced did with
 * `event.target.select()`.
 *
 * The gesture is a double-click on a card whose name is usually being replaced outright, so
 * selecting it means the next keystroke does that. Clicking once more puts the caret where it was
 * clicked, so nothing is lost for the other case.
 */
function selectAll(element) {
  const selection = window.getSelection?.()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}
