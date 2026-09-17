/*
 * How a label's text settings become CSS.
 *
 * Small, and worth a file for one reason: three renderers read this, and the failure mode of
 * getting it wrong is a toolbar button that works on two of the three with nothing to say which.
 * The `undefined`s are the load-bearing part -- an inline default would silently override the
 * Tailwind class each renderer sizes its text with.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_ALIGN, DEFAULT_VALIGN, labelLayout } from './labelStyle.js'

describe('labelLayout', () => {
  it('centres both ways when nothing has been set', () => {
    const layout = labelLayout(undefined)
    expect(layout.align).toBe(DEFAULT_ALIGN)
    expect(layout.valign).toBe(DEFAULT_VALIGN)
    expect(layout.justifyClass).toBe('justify-center')
    expect(layout.itemsClass).toBe('items-center')
  })

  /* A card's name is read from the left like any other list, so the renderer says so rather than
     every card having to store an override. */
  it('lets a renderer ask for a different default', () => {
    const layout = labelLayout(undefined, { align: 'left' })
    expect(layout.align).toBe('left')
    expect(layout.justifyClass).toBe('justify-start')
  })

  it('prefers what the user set over the renderer’s default', () => {
    const layout = labelLayout({ textAlign: 'right' }, { align: 'left' })
    expect(layout.align).toBe('right')
    expect(layout.justifyClass).toBe('justify-end')
  })

  it('maps every vertical setting', () => {
    expect(labelLayout({ textVAlign: 'top' }).itemsClass).toBe('items-start')
    expect(labelLayout({ textVAlign: 'middle' }).itemsClass).toBe('items-center')
    expect(labelLayout({ textVAlign: 'bottom' }).itemsClass).toBe('items-end')
  })

  it('falls back rather than producing no class for a value it does not know', () => {
    /* A document from a newer build, or a hand-edited one. No class at all would leave the label
       wherever flexbox put it, which is not obviously wrong and therefore hard to diagnose. */
    const layout = labelLayout({ textAlign: 'justify', textVAlign: 'baseline' })
    expect(layout.justifyClass).toBe('justify-center')
    expect(layout.itemsClass).toBe('items-center')
  })

  it('carries the alignment into the inline style, for a wrapped line', () => {
    /* Flexbox positions the block; only `text-align` decides where the second line of a wrapped
       label sits, so both are needed. */
    expect(labelLayout({ textAlign: 'right' }).textStyle.textAlign).toBe('right')
  })

  describe('font size', () => {
    it('is absent until it is set, so the renderer’s own class decides', () => {
      expect(labelLayout(undefined).textStyle.fontSize).toBeUndefined()
      expect(labelLayout({}).textStyle.fontSize).toBeUndefined()
    })

    it('is applied when set, with a line height to match', () => {
      const layout = labelLayout({ fontSize: 32 })
      expect(layout.textStyle.fontSize).toBe(32)
      /* Scaled rather than fixed: a 32px callout with 13px line spacing has its lines on top of
         each other. */
      expect(layout.textStyle.lineHeight).toBe(1.25)
    })

    it('accepts a number stored as a string, which is what an input produces', () => {
      expect(labelLayout({ fontSize: '20' }).textStyle.fontSize).toBe(20)
    })

    it('treats nonsense as unset rather than rendering it', () => {
      expect(labelLayout({ fontSize: 'huge' }).textStyle.fontSize).toBeUndefined()
      expect(labelLayout({ fontSize: 0 }).textStyle.fontSize).toBeUndefined()
      expect(labelLayout({ fontSize: -4 }).textStyle.fontSize).toBeUndefined()
    })
  })
})
