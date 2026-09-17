/*
 * The rich text model.
 *
 * Three things carry the weight here, and they are the three that would fail silently:
 *
 *   - `richToText` is what gets written into `data.name`, which is what export, search, the
 *     minimap and the server all read. If it drifts from what the canvas draws, a card's label
 *     and its tooltip disagree and nothing errors.
 *   - `normalizeRich` is what keeps an edit and its undo produce the same document. Without it,
 *     bolding a word and unbolding it leaves a different structure holding the same text, so
 *     `graphFingerprint` reports unsaved changes forever.
 *   - offsets are over the plain text, including the newline between blocks. Off by one there
 *     marks the wrong character and only shows up on a multi-line label.
 */

import { describe, expect, it } from 'vitest'

import {
  MARKS,
  applyMark,
  clearMarks,
  isEmptyRich,
  markState,
  normalizeRich,
  richFromDom,
  richFromText,
  richToText,
  sameRich,
  setList,
} from './richText.js'

const text = (rich) => richToText(rich)
const runsOf = (rich, block = 0) => normalizeRich(rich).blocks[block].runs

describe('richFromText / richToText', () => {
  it('round-trips plain text', () => {
    expect(text(richFromText('Braze'))).toBe('Braze')
    expect(text(richFromText(''))).toBe('')
  })

  it('round-trips several lines', () => {
    const rich = richFromText('one\ntwo\nthree')
    expect(rich.blocks).toHaveLength(3)
    expect(text(rich)).toBe('one\ntwo\nthree')
  })

  it('survives an absent value', () => {
    expect(text(null)).toBe('')
    expect(text(undefined)).toBe('')
    expect(text({})).toBe('')
  })

  it('keeps an empty line in the middle', () => {
    expect(text(richFromText('a\n\nb'))).toBe('a\n\nb')
  })

  /* The bullet is drawn by the renderer, not stored in the text: a list marker in the plain
     text would end up in the component's name, in search and in an export. */
  it('does not put a list marker in the plain text', () => {
    const listed = setList(richFromText('first\nsecond'), 0, 12, 'bullet')
    expect(text(listed)).toBe('first\nsecond')
  })
})

describe('normalizeRich', () => {
  it('merges neighbouring runs with the same marks', () => {
    const rich = { blocks: [{ runs: [{ text: 'Bra' }, { text: 'ze' }] }] }
    expect(runsOf(rich)).toEqual([{ text: 'Braze' }])
  })

  it('keeps runs whose marks differ', () => {
    const rich = { blocks: [{ runs: [{ text: 'a' }, { text: 'b', b: true }] }] }
    expect(runsOf(rich)).toHaveLength(2)
  })

  it('drops runs with no text', () => {
    const rich = { blocks: [{ runs: [{ text: '' }, { text: 'x' }, { text: '' }] }] }
    expect(runsOf(rich)).toEqual([{ text: 'x' }])
  })

  it('leaves an empty block with somewhere to put the caret', () => {
    expect(normalizeRich({ blocks: [{ runs: [] }] }).blocks[0].runs).toEqual([{ text: '' }])
    expect(normalizeRich({ blocks: [] }).blocks).toHaveLength(1)
  })

  /* `{b: true}` and `{b: true, i: false}` mean the same thing, and the fingerprint compares the
     document rather than its meaning -- so a mark that is off must be absent, not false. */
  it('stores only the marks that are on', () => {
    const rich = { blocks: [{ runs: [{ text: 'x', b: true, i: false, u: undefined }] }] }
    expect(runsOf(rich)).toEqual([{ text: 'x', b: true }])
  })

  it('drops a falsy list style rather than storing it', () => {
    expect(normalizeRich({ blocks: [{ list: null, runs: [{ text: 'x' }] }] }).blocks[0]).toEqual({
      runs: [{ text: 'x' }],
    })
  })
})

describe('applyMark', () => {
  const plain = () => richFromText('Send to Braze')

  it('marks exactly the range asked for', () => {
    const bold = applyMark(plain(), 8, 13, 'b')
    expect(runsOf(bold)).toEqual([{ text: 'Send to ' }, { text: 'Braze', b: true }])
    expect(text(bold)).toBe('Send to Braze')
  })

  it('marks a range in the middle, leaving both sides alone', () => {
    const bold = applyMark(plain(), 5, 7, 'b')
    expect(runsOf(bold)).toEqual([
      { text: 'Send ' },
      { text: 'to', b: true },
      { text: ' Braze' },
    ])
  })

  it('removes a mark it is told to turn off', () => {
    const bold = applyMark(plain(), 0, 13, 'b')
    const back = applyMark(bold, 0, 13, 'b', false)
    /* Byte-identical to never having been marked -- this is the property that stops an edit and
       its undo leaving the diagram permanently dirty. */
    expect(back).toEqual(normalizeRich(plain()))
  })

  it('stacks marks on the same run', () => {
    const both = applyMark(applyMark(plain(), 8, 13, 'b'), 8, 13, 'i')
    expect(runsOf(both)).toEqual([{ text: 'Send to ' }, { text: 'Braze', b: true, i: true }])
  })

  it('does nothing for an empty selection', () => {
    const rich = plain()
    expect(applyMark(rich, 4, 4, 'b')).toBe(rich)
  })

  it('does nothing for a mark it does not know', () => {
    const rich = plain()
    expect(applyMark(rich, 0, 4, 'blink')).toBe(rich)
  })

  it('accepts a backwards selection, which is how dragging right-to-left arrives', () => {
    expect(applyMark(plain(), 13, 8, 'b')).toEqual(applyMark(plain(), 8, 13, 'b'))
  })

  it('clamps a range past the end rather than inventing text', () => {
    const bold = applyMark(plain(), 8, 900, 'b')
    expect(text(bold)).toBe('Send to Braze')
    expect(runsOf(bold)).toEqual([{ text: 'Send to ' }, { text: 'Braze', b: true }])
  })

  /*
   * The newline counts as one character, because that is what `richToText` puts between two
   * blocks and therefore what the caller's offsets are measured against. Getting this wrong
   * marks the character next to the one the user selected, and only on a multi-line label.
   */
  it('counts the line break when the selection spans two lines', () => {
    const rich = richFromText('one\ntwo')
    const bold = applyMark(rich, 2, 5, 'b')
    expect(runsOf(bold, 0)).toEqual([{ text: 'on' }, { text: 'e', b: true }])
    expect(runsOf(bold, 1)).toEqual([{ text: 't', b: true }, { text: 'wo' }])
  })

  it('marks a whole later line at the right offset', () => {
    const rich = richFromText('one\ntwo\nthree')
    const bold = applyMark(rich, 8, 13, 'b')
    expect(runsOf(bold, 2)).toEqual([{ text: 'three', b: true }])
    expect(runsOf(bold, 1)).toEqual([{ text: 'two' }])
  })

  it('covers every mark the toolbar offers', () => {
    for (const mark of MARKS) {
      const marked = applyMark(plain(), 0, 4, mark)
      expect(runsOf(marked)[0][mark]).toBe(true)
    }
  })
})

describe('markState', () => {
  const partly = () => applyMark(richFromText('Send to Braze'), 8, 13, 'b')

  it('says all when the whole range is marked', () => {
    expect(markState(partly(), 8, 13, 'b')).toBe('all')
  })

  it('says some when part of it is', () => {
    /* The case a boolean gets wrong: bolding a selection that already contains a bold word has
       to make all of it bold, not un-bold that word. */
    expect(markState(partly(), 0, 13, 'b')).toBe('some')
  })

  it('says none when none of it is', () => {
    expect(markState(partly(), 0, 4, 'b')).toBe('none')
    expect(markState(partly(), 0, 13, 'i')).toBe('none')
  })

  it('says none for an empty selection', () => {
    expect(markState(partly(), 9, 9, 'b')).toBe('none')
  })
})

describe('clearMarks', () => {
  it('keeps the text and drops the formatting', () => {
    const fancy = applyMark(applyMark(richFromText('a b'), 0, 1, 'b'), 2, 3, 'u')
    const bare = clearMarks(fancy)
    expect(text(bare)).toBe('a b')
    expect(runsOf(bare)).toEqual([{ text: 'a b' }])
  })

  it('keeps the lines', () => {
    expect(text(clearMarks(richFromText('a\nb')))).toBe('a\nb')
  })
})

describe('setList', () => {
  it('makes the blocks a selection touches into list items', () => {
    const listed = setList(richFromText('one\ntwo\nthree'), 0, 7, 'bullet')
    expect(listed.blocks.map((block) => block.list)).toEqual(['bullet', 'bullet', undefined])
  })

  /* Pressing the bullet button with no selection is the ordinary way anyone uses it, so a caret
     inside a line -- or at the very end of one -- has to count as being in that line. */
  it('works from a caret with nothing selected', () => {
    const listed = setList(richFromText('one\ntwo'), 5, 5, 'number')
    expect(listed.blocks.map((block) => block.list)).toEqual([undefined, 'number'])
  })

  it('changes one list style to the other', () => {
    const bullets = setList(richFromText('one'), 0, 3, 'bullet')
    expect(setList(bullets, 0, 3, 'number').blocks[0].list).toBe('number')
  })

  it('removes the list style', () => {
    const bullets = setList(richFromText('one'), 0, 3, 'bullet')
    expect(setList(bullets, 0, 3, null).blocks[0].list).toBeUndefined()
  })
})

describe('isEmptyRich and sameRich', () => {
  it('knows an empty value from a value', () => {
    expect(isEmptyRich(richFromText(''))).toBe(true)
    expect(isEmptyRich(null)).toBe(true)
    expect(isEmptyRich(richFromText('x'))).toBe(false)
  })

  it('counts an empty bullet as content, because it is a line the user made', () => {
    expect(isEmptyRich(setList(richFromText(''), 0, 0, 'bullet'))).toBe(false)
  })

  it('compares two values by what they say, not by how they are split', () => {
    const split = { blocks: [{ runs: [{ text: 'Bra' }, { text: 'ze' }] }] }
    expect(sameRich(split, richFromText('Braze'))).toBe(true)
    expect(sameRich(richFromText('Braze'), applyMark(richFromText('Braze'), 0, 5, 'b'))).toBe(false)
  })
})

/*
 * Reading an edit back out of the DOM.
 *
 * Tested against a hand-built tree of the shape browsers actually produce, because there is no
 * jsdom here -- and because the interesting cases are the *variations*: Chrome wraps a new line
 * in a `div`, execCommand may produce a tag or an inline style depending on `styleWithCSS`, and
 * a paste can bring anything at all.
 */
describe('richFromDom', () => {
  const t = (value) => ({ nodeType: 3, nodeValue: value })
  const el = (tagName, children = [], { style = {}, parentNode } = {}) => {
    const node = { nodeType: 1, tagName, childNodes: children, style, parentNode }
    for (const child of children) if (child.nodeType === 1) child.parentNode = node
    return node
  }
  const root = (children) => el('DIV', children)

  it('reads plain text', () => {
    expect(text(richFromDom(root([t('Braze')])))).toBe('Braze')
  })

  it('reads a bold word from a tag', () => {
    const rich = richFromDom(root([t('Send to '), el('B', [t('Braze')])]))
    expect(runsOf(rich)).toEqual([{ text: 'Send to ' }, { text: 'Braze', b: true }])
  })

  it('reads the tags a browser uses instead', () => {
    const rich = richFromDom(
      root([el('STRONG', [t('a')]), el('EM', [t('b')]), el('DEL', [t('c')])]),
    )
    expect(runsOf(rich)).toEqual([
      { text: 'a', b: true },
      { text: 'b', i: true },
      { text: 'c', s: true },
    ])
  })

  /* execCommand with `styleWithCSS` on produces spans with inline styles rather than tags.
     Without this branch, bold would appear to work and silently not persist. */
  it('reads a mark expressed as an inline style', () => {
    const rich = richFromDom(
      root([
        el('SPAN', [t('a')], { style: { fontWeight: 'bold' } }),
        el('SPAN', [t('b')], { style: { textDecoration: 'underline line-through' } }),
      ]),
    )
    expect(runsOf(rich)).toEqual([
      { text: 'a', b: true },
      { text: 'b', u: true, s: true },
    ])
  })

  it('reads nested marks', () => {
    const rich = richFromDom(root([el('B', [el('I', [t('x')])])]))
    expect(runsOf(rich)).toEqual([{ text: 'x', b: true, i: true }])
  })

  it('reads a line break as a new line', () => {
    expect(text(richFromDom(root([t('one'), el('BR'), t('two')])))).toBe('one\ntwo')
  })

  it('reads the div-per-line shape a browser produces for Enter', () => {
    const rich = richFromDom(root([t('one'), el('DIV', [t('two')]), el('DIV', [t('three')])]))
    expect(text(rich)).toBe('one\ntwo\nthree')
  })

  it('reads a list', () => {
    const items = [el('LI', [t('one')]), el('LI', [t('two')])]
    const rich = richFromDom(root([el('UL', items)]))
    expect(text(rich)).toBe('one\ntwo')
    expect(rich.blocks.map((block) => block.list)).toEqual(['bullet', 'bullet'])
  })

  it('reads a numbered list', () => {
    const rich = richFromDom(root([el('OL', [el('LI', [t('one')])])]))
    expect(rich.blocks[0].list).toBe('number')
  })

  /* The property that makes the model safe to store: anything the model cannot express is
     dropped rather than carried, so a pasted script tag or a font choice simply is not there. */
  it('drops everything it cannot express', () => {
    const rich = richFromDom(
      root([
        el('SCRIPT', [t('alert(1)')]),
        t('safe'),
        el('IMG'),
        el('SPAN', [t(' text')], { style: { fontFamily: 'Comic Sans' } }),
      ]),
    )
    /* The script's *text* comes through as text -- it is characters in a label, which is
       harmless -- and no element survives to execute anything. */
    expect(text(rich)).toBe('alert(1)safe text')
    expect(runsOf(rich)).toEqual([{ text: 'alert(1)safe text' }])
  })

  it('survives an empty editor and a missing root', () => {
    expect(text(richFromDom(root([])))).toBe('')
    expect(text(richFromDom(null))).toBe('')
  })
})

/*
 * The shapes a real contentEditable produces for pressing Enter, which is where this reader
 * earns its keep: there is no one shape. What matters is that the *count* of lines comes back
 * right, because an extra or missing blank line is the kind of drift nobody notices until a
 * label has been edited four times.
 */
describe('richFromDom and the browser’s idea of a new line', () => {
  const t = (value) => ({ nodeType: 3, nodeValue: value })
  const el = (tagName, children = [], { style = {} } = {}) => {
    const node = { nodeType: 1, tagName, childNodes: children, style }
    for (const child of children) if (child.nodeType === 1) child.parentNode = node
    return node
  }
  const root = (children) => el('DIV', children)
  const emptyLine = () => el('DIV', [el('BR')])

  it('reads two consecutive empty lines as two', () => {
    /* The case the old "new block unless the current one is empty" rule got wrong: the second
       press of Enter appeared to do nothing at all. */
    expect(richToText(richFromDom(root([emptyLine(), emptyLine(), el('DIV', [t('x')])])))).toBe(
      '\n\nx',
    )
  })

  it('reads a leading empty line', () => {
    expect(richToText(richFromDom(root([emptyLine(), el('DIV', [t('x')])])))).toBe('\nx')
  })

  it('ignores the filler break inside an empty block', () => {
    /* Every engine puts a `<br>` inside an empty editable block so it can be focused. Counting
       it appends a blank line to the label on every single commit. */
    expect(richToText(richFromDom(root([el('DIV', [t('one')]), emptyLine()])))).toBe('one\n')
  })

  it('puts the bullet on the item, not on the line its filler break started', () => {
    const items = [el('LI', [t('one')]), el('LI', [el('BR')])]
    const rich = richFromDom(root([el('UL', items)]))
    expect(rich.blocks.map((block) => block.list)).toEqual(['bullet', 'bullet'])
    expect(richToText(rich)).toBe('one\n')
  })

  it('reads a list after a paragraph', () => {
    const rich = richFromDom(
      root([el('DIV', [t('why:')]), el('UL', [el('LI', [t('one')]), el('LI', [t('two')])])]),
    )
    expect(richToText(rich)).toBe('why:\none\ntwo')
    expect(rich.blocks.map((block) => block.list)).toEqual([undefined, 'bullet', 'bullet'])
  })
})
