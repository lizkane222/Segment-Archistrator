/*
 * The visual vocabulary is a table, so most of it is not worth asserting -- a test that
 * `warehouse` is grey is a copy of the table. What is worth pinning is `outlineFor`,
 * because it resolves a *precedence* between two things that both want the same two CSS
 * properties: the unbound-placeholder annotation, and an override the Style tab wrote.
 * The renderer and the inspector both call it, and the failure it prevents is a panel
 * highlighting one outline while the canvas draws another.
 */

import { describe, expect, it } from 'vitest'

import { outlineFor, styleFor } from './kinds.js'

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
