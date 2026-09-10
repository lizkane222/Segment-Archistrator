/*
 * The tab model.
 *
 * Two things here are worth testing and the rest is bookkeeping:
 *
 *  - **A fork must not be able to overwrite its original.** `doc.id` cleared is the whole of what
 *    makes that true, and if it were ever left in place, "fork" would silently become "open the
 *    same diagram twice and save over it from whichever pane was last touched". That is data loss
 *    with no error, so it is asserted from several directions.
 *  - **Which tab is showing after a close**, because the obvious implementations are wrong in ways
 *    nobody notices until they have closed four tabs and been thrown to the far end of the strip.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_PANES,
  SPLIT_VERTICAL,
  forkName,
  forkTab,
  newTab,
  nextActiveId,
  nextTabId,
  visibleTabs,
} from './tabs.js'
import { UNTITLED } from './useDiagrams.js'

const saved = (name = 'Acme CDP', id = 'dg_1') =>
  newTab({
    doc: { id, name, description: 'x', sourceTemplate: 'end-to-end', updatedAt: '2026-09-01' },
    graph: { nodes: [{ id: 'src:1' }], edges: [], zones: [] },
  })

describe('newTab', () => {
  it('gives every tab its own id', () => {
    expect(nextTabId()).not.toBe(nextTabId())
    expect(newTab().id).not.toBe(newTab().id)
  })

  it('starts untitled, unsaved and empty', () => {
    const tab = newTab()
    expect(tab.doc.id).toBeNull()
    expect(tab.doc.name).toBe(UNTITLED)
    /* Null, not `{nodes: []}`. "Nothing loaded" and "a diagram the user emptied" are different
       states -- the second one saves as empty, the first has nothing to save. */
    expect(tab.graph).toBeNull()
  })
})

describe('forking a tab', () => {
  it('clears the saved id, so saving the copy cannot overwrite the original', () => {
    /* The assertion this whole module exists to make. `useDiagrams` treats a null id as "never
       persisted", which is what routes the copy's save to a create. */
    const fork = forkTab(saved())
    expect(fork.doc.id).toBeNull()
  })

  it('leaves the original completely untouched', () => {
    const original = saved()
    const before = JSON.parse(JSON.stringify(original))
    forkTab(original)
    expect(original).toEqual(before)
  })

  it('gets its own tab id', () => {
    const original = saved()
    expect(forkTab(original).id).not.toBe(original.id)
  })

  it('carries the drawing across', () => {
    const original = saved()
    expect(forkTab(original).graph).toEqual(original.graph)
  })

  it('forgets when it was last saved, because it never was', () => {
    /* Inherited, this would claim the copy had been persisted -- and the dot that marks unsaved
       work reads exactly this field. */
    expect(forkTab(saved()).doc.updatedAt).toBeNull()
  })

  it('keeps which reference architecture it descends from', () => {
    /* Still true of a copy, and it is what the template picker reads to say "based on". */
    expect(forkTab(saved()).doc.sourceTemplate).toBe('end-to-end')
  })

  it('takes a name it is given', () => {
    expect(forkTab(saved(), { name: 'For the call' }).doc.name).toBe('For the call')
  })

  it('survives being handed nothing', () => {
    const fork = forkTab(null)
    expect(fork.doc.id).toBeNull()
    expect(fork.graph).toBeNull()
  })
})

describe('forkName', () => {
  it('marks the first copy', () => {
    expect(forkName('Acme CDP')).toBe('Acme CDP (copy)')
  })

  it('counts on instead of nesting', () => {
    /* "(copy) (copy) (copy)" is a name with no information left in it. */
    expect(forkName('Acme CDP (copy)')).toBe('Acme CDP (copy 2)')
    expect(forkName('Acme CDP (copy 2)')).toBe('Acme CDP (copy 3)')
    expect(forkName('Acme CDP (copy 9)')).toBe('Acme CDP (copy 10)')
  })

  it('does not mistake a name that merely mentions a copy', () => {
    expect(forkName('Copy of Acme')).toBe('Copy of Acme (copy)')
    expect(forkName('Acme (copy of prod)')).toBe('Acme (copy of prod) (copy)')
  })

  it('falls back to the untitled name for a blank one', () => {
    expect(forkName('')).toBe(`${UNTITLED} (copy)`)
    expect(forkName('   ')).toBe(`${UNTITLED} (copy)`)
    expect(forkName(undefined)).toBe(`${UNTITLED} (copy)`)
  })
})

describe('which tab shows after a close', () => {
  const three = [newTab({ id: 'a' }), newTab({ id: 'b' }), newTab({ id: 'c' })]

  it('moves to the one on the right', () => {
    /* Position of the eye, not identity of a tab: closing several in a row walks along the strip
       rather than jumping back to whichever was opened first. */
    expect(nextActiveId(three, 'b')).toBe('c')
    expect(nextActiveId(three, 'a')).toBe('b')
  })

  it('falls back to the left when the last one closes', () => {
    expect(nextActiveId(three, 'c')).toBe('b')
  })

  it('answers null when the only tab closes, so the caller opens a blank one', () => {
    expect(nextActiveId([newTab({ id: 'a' })], 'a')).toBeNull()
  })

  it('answers null for a tab that is not there', () => {
    expect(nextActiveId(three, 'zz')).toBeNull()
  })
})

describe('what is on screen', () => {
  const three = [newTab({ id: 'a' }), newTab({ id: 'b' }), newTab({ id: 'c' })]

  it('shows one pane unsplit', () => {
    expect(visibleTabs(three, 'b').map((tab) => tab.id)).toEqual(['b'])
  })

  it('shows the active tab and the next one along when split', () => {
    expect(visibleTabs(three, 'a', { split: true }).map((tab) => tab.id)).toEqual(['a', 'b'])
    expect(visibleTabs(three, 'b', { split: true }).map((tab) => tab.id)).toEqual(['b', 'c'])
  })

  it('pairs backwards when the active tab is last', () => {
    /* Otherwise splitting while the rightmost tab is active shows one pane and an apology. */
    expect(visibleTabs(three, 'c', { split: true }).map((tab) => tab.id)).toEqual(['c', 'b'])
  })

  it('never shows more panes than there are', () => {
    const one = [newTab({ id: 'a' })]
    expect(visibleTabs(one, 'a', { split: true }).map((tab) => tab.id)).toEqual(['a'])
    for (const activeId of ['a', 'b', 'c', 'nope']) {
      expect(visibleTabs(three, activeId, { split: true }).length).toBeLessThanOrEqual(MAX_PANES)
    }
  })

  it('falls back to the first tab when the active id is unknown', () => {
    /* Reachable: a tab can be closed by one pane while the other still names it. Showing the first
       tab is better than showing none, which would render an empty workbench. */
    expect(visibleTabs(three, 'gone').map((tab) => tab.id)).toEqual(['a'])
  })

  it('answers nothing when there are no tabs', () => {
    expect(visibleTabs([], 'a')).toEqual([])
    expect(visibleTabs(undefined, 'a')).toEqual([])
  })
})

describe('the split settings', () => {
  it('offers two panes and two orientations', () => {
    /* A hard limit rather than a default. Each pane is a full React Flow instance, and three would
       need a layout tree and would give each pane a third of the screen. */
    expect(MAX_PANES).toBe(2)
    expect(SPLIT_VERTICAL).toBe('vertical')
  })
})
