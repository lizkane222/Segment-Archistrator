/*
 * How a label's text properties become CSS, in one place.
 *
 * Three renderers draw a label -- a component, a shape, a table cell -- and the text toolbar sets
 * the same three properties on all of them. Written out at each site, the mapping would be three
 * copies of the same lookup and the toolbar would be pressing buttons that worked on two of the
 * three.
 *
 * Alignment is two settings, not one, and that is the part worth stating: a label on this canvas
 * sits inside a *box* rather than in a column of prose, so "where is the text" has a horizontal
 * answer and a vertical one. Both are needed, and they are applied to different things --
 * horizontal alignment is `text-align` (it has to hold across a wrapped line, which flexbox
 * cannot express) *and* the flex justification, while vertical alignment is only the flex
 * alignment. Hence one function returning both.
 */

/* Flex classes rather than inline styles, because the container they go on is already a Tailwind
   flex row and mixing the two makes the result depend on stylesheet order. */
const JUSTIFY = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

const ITEMS = {
  top: 'items-start',
  middle: 'items-center',
  bottom: 'items-end',
}

/* What a label does when nothing has been set. Centred both ways inside a shape, because a shape's
   label is an annotation *on* the outline and anything else reads as misplaced; a component's card
   overrides the horizontal half, since a name is read from the left like any other list. */
export const DEFAULT_ALIGN = 'center'
export const DEFAULT_VALIGN = 'middle'

/**
 * @param style   a node's `data.style`, or nothing
 * @param fallback  what this renderer wants when the user has not chosen -- a card passes
 *   `{align: 'left'}`, a shape takes the centred default
 * @returns `{align, valign, justifyClass, itemsClass, textStyle}` -- `textStyle` being the inline
 *   properties to spread onto the text element itself, with `undefined` for anything unset so a
 *   Tailwind class keeps deciding it.
 */
export function labelLayout(style, fallback = {}) {
  const align = style?.textAlign ?? fallback.align ?? DEFAULT_ALIGN
  const valign = style?.textVAlign ?? fallback.valign ?? DEFAULT_VALIGN
  const size = Number(style?.fontSize)

  return {
    align,
    valign,
    justifyClass: JUSTIFY[align] ?? JUSTIFY[DEFAULT_ALIGN],
    itemsClass: ITEMS[valign] ?? ITEMS[DEFAULT_VALIGN],
    textStyle: {
      textAlign: align,
      /* Only when set, and never as a default: the renderers size their text with a Tailwind
         class, and an inline default would override it everywhere and make the class dead code
         that someone later changes with no effect. A non-numeric value is treated as unset for
         the same reason -- a document from a newer build, or a hand-edited one. */
      fontSize: Number.isFinite(size) && size > 0 ? size : undefined,
      /* Scaled from the size rather than fixed, so a 32px callout does not come out with the
         line spacing of 13px body text. 1.25 is what `leading-tight` already is. */
      lineHeight: Number.isFinite(size) && size > 0 ? 1.25 : undefined,
    },
  }
}
