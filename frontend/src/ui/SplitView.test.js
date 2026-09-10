/*
 * The split view's layout invariants.
 *
 * There is no jsdom in this project, so this cannot render anything -- but the bug worth guarding
 * against was never about behaviour. It was a class name: the single pane was dropped straight into a
 * `flex` row, and since a pane's own root is a full-height flex column with no `flex-grow`, it
 * shrink-wrapped to its content. The whole workbench rendered as a narrow strip with most of the
 * window empty beside it, and nothing threw.
 *
 * So the classes are named constants and the rule is asserted on them directly. Cheap, and it pins
 * exactly the thing that went wrong rather than a proxy for it.
 */

import { describe, expect, it } from 'vitest'

import { FIRST_PANE, SECOND_PANE, SOLO_PANE } from './SplitView.jsx'

const WRAPPERS = { SOLO_PANE, FIRST_PANE, SECOND_PANE }

describe('every pane wrapper', () => {
  it('is not itself a flex container', () => {
    /* The bug. A pane as a direct flex item has no `flex-grow`, so it shrink-wraps; as a block child
       it is full width for free. `flex-1` and `flex-col` are fine -- it is the bare `flex` display
       utility that must not appear. */
    for (const [name, className] of Object.entries(WRAPPERS)) {
      expect(className.split(/\s+/), name).not.toContain('flex')
      expect(className.split(/\s+/), name).not.toContain('inline-flex')
    }
  })

  it('may shrink below its own content on both axes', () => {
    /* `min-width`/`min-height` default to `auto` for a flex item, which means "never smaller than my
       content" -- and a React Flow canvas reports a very large content. Without these a pane refuses
       to give up space and the divider cannot be dragged past it. */
    for (const [name, className] of Object.entries(WRAPPERS)) {
      expect(className, name).toMatch(/\bmin-w-0\b/)
      expect(className, name).toMatch(/\bmin-h-0\b/)
    }
  })
})

describe('how the two panes divide the axis', () => {
  it('gives the first a fixed basis and the second the rest', () => {
    /* The first pane's size comes from an inline `flex` basis (the dragged fraction), so its class
       must not also claim `flex-1` -- two opinions about one axis, and the later one wins silently. */
    expect(FIRST_PANE.split(/\s+/)).not.toContain('flex-1')
    expect(SECOND_PANE.split(/\s+/)).toContain('flex-1')
  })

  it('clips each pane, so neither bleeds into the other', () => {
    expect(FIRST_PANE).toMatch(/\boverflow-hidden\b/)
    expect(SECOND_PANE).toMatch(/\boverflow-hidden\b/)
  })

  it('does not clip a single pane', () => {
    /* Nothing to clip against, and adding one would silently change what a lone workbench may
       overflow -- which it never had to think about before this component existed. */
    expect(SOLO_PANE).not.toMatch(/\boverflow-hidden\b/)
  })

  it('makes a single pane grow to fill the frame', () => {
    expect(SOLO_PANE.split(/\s+/)).toContain('flex-1')
  })
})
