/*
 * Where the shared chrome gets drawn.
 *
 * Small, and worth its own file because the failure mode is silent: this project has no jsdom, so
 * nothing here renders, and returning `none` where it should return `portal` produces a workbench
 * with no palette and no inspector and no error anywhere to say why. The layout bug in `SplitView`
 * that shipped once was the same shape.
 */

import { describe, expect, it } from 'vitest'

import { chromePlacement } from './AppShell.jsx'

const slots = { top: {}, left: {}, right: {} }

describe('chromePlacement', () => {
  it('portals into a mounted slot for the pane that owns the chrome', () => {
    expect(chromePlacement({ chromeOwner: true, slots, slot: slots.left })).toBe('portal')
  })

  it('draws nothing at all for a pane that does not own the chrome', () => {
    /* Not `visibility: hidden`, and not a second copy portalled elsewhere: a second Inspector would
       mount a second copy of every per-kind branch against the same node and race the first one's
       edits. */
    expect(chromePlacement({ chromeOwner: false, slots, slot: slots.left })).toBe('none')
    expect(chromePlacement({ chromeOwner: false, slots: null, slot: null })).toBe('none')
  })

  it('draws in place when no slots were supplied', () => {
    /* A `Workbench` mounted on its own -- a test, a future embed -- has to be a whole workbench, not
       a canvas with its sidebars missing. */
    expect(chromePlacement({ chromeOwner: true, slots: null, slot: null })).toBe('inline')
    expect(chromePlacement({ chromeOwner: true, slots: undefined, slot: undefined })).toBe('inline')
  })

  it('waits rather than drawing in place when the slot has not mounted yet', () => {
    /* One frame, between AppShell's first render and its callback refs landing. Falling back to
       inline for that frame would put the palette inside the pane and then move it, which is a
       visible jump. */
    expect(chromePlacement({ chromeOwner: true, slots, slot: null })).toBe('none')
    expect(chromePlacement({ chromeOwner: true, slots, slot: undefined })).toBe('none')
  })

  it('never portals into a slot it was not given', () => {
    /* `createPortal(content, null)` throws, so this is the one case that would be loud rather than
       silent -- and it would take the whole app down on the first render. */
    for (const chromeOwner of [true, false]) {
      for (const slot of [null, undefined, false, 0, '']) {
        expect(chromePlacement({ chromeOwner, slots, slot }), `${chromeOwner}/${slot}`).not.toBe(
          'portal',
        )
      }
    }
  })
})
