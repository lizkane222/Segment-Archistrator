/*
 * The visual vocabulary is a table, so most of it is not worth asserting -- a test that
 * `warehouse` is grey is a copy of the table. What is worth pinning is `outlineFor`,
 * because it resolves a *precedence* between two things that both want the same two CSS
 * properties: the unbound-placeholder annotation, and an override the Style tab wrote.
 * The renderer and the inspector both call it, and the failure it prevents is a panel
 * highlighting one outline while the canvas draws another.
 */

import { describe, expect, it } from 'vitest'

import { borderColorFor, outlineFor, styleFor, zoneStyleFor } from './kinds.js'

describe('styleFor', () => {
  it('carries an outline default, so the inspector has something to reset to', () => {
    expect(styleFor('source')).toMatchObject({ borderStyle: 'solid', borderWidth: 1 })
  })

  it('lets an override win, as it does for every other property', () => {
    expect(styleFor('source', { borderWidth: 4 })).toMatchObject({ borderWidth: 4 })
  })
})

describe('outlineFor', () => {
  it('is the kind default for an ordinary bound component', () => {
    expect(outlineFor({ kind: 'source', bound: true })).toEqual({
      borderStyle: 'solid',
      borderWidth: 1,
    })
  })

  it('dashes an unbound template placeholder', () => {
    expect(outlineFor({ kind: 'source', bound: false })).toEqual({
      borderStyle: 'dashed',
      borderWidth: 2,
    })
  })

  it('lets an explicit outline beat the placeholder dash', () => {
    /* The dash is an annotation, not a rule. Someone laying out a proposal is entitled to
       make a placeholder look like anything, and the request asked for the outline to be
       editable on *all* components. */
    expect(
      outlineFor({ kind: 'source', bound: false, style: { borderStyle: 'dotted', borderWidth: 3 } }),
    ).toEqual({ borderStyle: 'dotted', borderWidth: 3 })
  })

  it('overrides one property without dropping the placeholder default on the other', () => {
    expect(outlineFor({ kind: 'source', bound: false, style: { borderStyle: 'solid' } })).toEqual({
      borderStyle: 'solid',
      borderWidth: 2,
    })
  })

  it('survives a component with no kind at all', () => {
    /* A custom component has none, and this runs on every render of every node. */
    expect(outlineFor({})).toEqual({ borderStyle: 'solid', borderWidth: 1 })
    expect(outlineFor(null)).toEqual({ borderStyle: 'solid', borderWidth: 1 })
  })
})

/*
 * A zone's resolved look, now that it has one beyond a colour.
 *
 * `ZoneNode` hardcoded `rounded-xl border-2 border-dashed` into its class list and `zoneStyleFor`
 * returned only `{bg, border}` -- so a zone could be given a colour and nothing else, and the panel
 * could not offer an outline or a corner because the renderer had no way to honour one.
 *
 * The defaults moved here rather than changing, which is the property these pin: every diagram already
 * saved has to draw exactly as it did.
 */
describe('zoneStyleFor', () => {
  it('keeps the dashed 2px region look as the default', () => {
    const style = zoneStyleFor({ id: 'connections' })
    expect(style.borderStyle).toBe('dashed')
    expect(style.borderWidth).toBe(2)
    expect(style.shape).toBe('rounded')
  })

  it('still derives the background from a chosen colour rather than leaving it blank', () => {
    /* The load-bearing one. Every zone with a colour and no explicit background relies on the tint;
       reading `style.bg` first would turn all of them white. */
    const style = zoneStyleFor({ id: 'custom:zone:ab12', color: '#336699' })
    expect(style.border).toBe('#336699')
    expect(style.bg).not.toBe('#336699')
    expect(style.bg).toBeTruthy()
  })

  it('still resolves a duplicated zone by its product', () => {
    /* A second copy of Connections is Connections blue, not custom-zone grey. */
    expect(zoneStyleFor({ id: 'connections~2' }).border).toBe(zoneStyleFor({ id: 'connections' }).border)
  })

  it('lets an explicit style win over both the colour and the product', () => {
    const style = zoneStyleFor({
      id: 'connections',
      color: '#336699',
      style: { borderStyle: 'solid', borderWidth: 1, bg: '#ffffff' },
    })
    expect(style.borderStyle).toBe('solid')
    expect(style.borderWidth).toBe(1)
    expect(style.bg).toBe('#ffffff')
    /* Unmentioned fields still come from the layers underneath -- an override is additive. */
    expect(style.border).toBe('#336699')
  })
})

/*
 * A component takes the colour of the zone it is in.
 *
 * The half of "a component dropped into a zone adopts its styles" that is not parenting. The
 * parenting half is `reparentTarget`/`withParent` and is covered in rules.test.js; this is what
 * makes the card *look* like it moved, and it is resolved live at render time from the zone node's
 * own data rather than copied onto the component -- which is why recolouring a region recolours
 * everything in it, and why a card dragged between zones changes colour with no write at all.
 *
 * Worth its own block despite the "a test that a warehouse is grey is a copy of the table" rule in
 * the header above, because this is a precedence and not a value: three sources want the same CSS
 * property, and the order between them is the behaviour.
 */
describe('borderColorFor', () => {
  it('takes the zone’s colour over the kind’s own', () => {
    /* A source is blue by kind; dropped in Unify it goes purple, because on this canvas colour
       says which region a thing is in rather than what kind of thing it is. */
    const inUnify = borderColorFor({ kind: 'source' }, { id: 'unify' })
    expect(inUnify).toBe(zoneStyleFor({ id: 'unify' }).border)
    expect(inUnify).not.toBe(borderColorFor({ kind: 'source' }, null))
  })

  it('follows a zone that has been recoloured', () => {
    expect(borderColorFor({ kind: 'source' }, { id: 'unify', color: '#336699' })).toBe('#336699')
  })

  it('falls back to the kind outside every zone, rather than to a neutral grey', () => {
    /* The working area is a legitimate place to park something, and a column of identically grey
       cards there would lose the one signal a card still has. */
    expect(borderColorFor({ kind: 'source' }, null)).toBe(borderColorFor({ kind: 'source' }))
    expect(borderColorFor({ kind: 'source' })).not.toBe(borderColorFor({ kind: 'audience' }))
  })

  it('lets a hand-picked colour win over the zone', () => {
    /* The whole promise of the adopt-on-drop behaviour being automatic: it only ever fills a
       silence. Someone who coloured a card meant it, and dragging it must not undo that. */
    expect(borderColorFor({ kind: 'source', style: { border: '#ff0000' } }, { id: 'unify' })).toBe(
      '#ff0000',
    )
  })

  it('resolves a duplicated zone by its product, like everything else', () => {
    expect(borderColorFor({ kind: 'source' }, { id: 'connections~2' })).toBe(
      borderColorFor({ kind: 'source' }, { id: 'connections' }),
    )
  })

  it('gives a sub-zone’s occupant the product colour, not a doubled tint', () => {
    /* A sub-zone borrows its parent's border (`subZoneOf`), so a card in Profiles is the same
       purple as one on the bare Unify backdrop -- which is what stops a region reading as a
       fourth product. */
    expect(borderColorFor({ kind: 'profile' }, { id: 'profiles' })).toBe(
      borderColorFor({ kind: 'profile' }, { id: 'unify' }),
    )
  })

  it('gives the new Linked Events region the Connections blue its contents expect', () => {
    expect(borderColorFor({ kind: 'linked_event' }, { id: 'linked_events' })).toBe(
      borderColorFor({ kind: 'source' }, { id: 'connections' }),
    )
  })
})
