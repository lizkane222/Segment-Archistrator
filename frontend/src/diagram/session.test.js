/*
 * The open tabs, across a page load.
 *
 * The bug behind this is a navigation, not a state bug: signing in leaves the page for Google, so
 * every open diagram went with the document. That is untestable here -- there is no jsdom and no
 * navigation to stage -- so what these pin is the part that is data: what gets written, what is
 * dropped first when it does not fit, and what a restored session is trusted to say.
 *
 * Storage is injected throughout, same as ui/preferences.test.js.
 */

import { describe, expect, it } from 'vitest'

import { SESSION_KEY, clearSession, readSession, trim, writeSession } from './session.js'

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    raw: map,
  }
}

/** A tab as `useTabs` holds one. */
function tab(id, { saved = true, graph = { nodes: [], edges: [] } } = {}) {
  return {
    id,
    doc: { id: saved ? `db:${id}` : null, name: `Diagram ${id}`, description: '' },
    graph,
  }
}

describe('the workbench session', () => {
  it('stores nothing when there are no tabs worth keeping', () => {
    /* One blank never-saved tab is the app's own starting state. Writing it would mean every first
       visit left a session behind that restores to exactly what a first visit produces anyway. */
    const storage = fakeStorage()
    writeSession({ tabs: [tab('t1', { saved: false, graph: null })] }, new Set(['t1']), storage)
    expect(storage.raw.has(SESSION_KEY)).toBe(false)
  })

  it('round-trips the tabs, which is the whole point', () => {
    const storage = fakeStorage()
    writeSession({ tabs: [tab('t1'), tab('t2')], activeId: 't2' }, new Set(), storage)
    const back = readSession(storage)
    expect(back.tabs.map((entry) => entry.id)).toEqual(['t1', 't2'])
    expect(back.activeId).toBe('t2')
  })

  it('keeps the graph of a tab with unsaved work', () => {
    /* The only copy in existence. Everything else here is a size optimisation; this is the
       requirement. */
    const storage = fakeStorage()
    const graph = { nodes: [{ id: 'a' }], edges: [] }
    writeSession({ tabs: [tab('t1', { graph })] }, new Set(['t1']), storage)
    expect(readSession(storage).tabs[0].graph).toEqual(graph)
    expect(readSession(storage).tabs[0].dirty).toBe(true)
  })

  it('drops the graph of a saved, unmodified tab', () => {
    /* It is on the server and `openDiagram` will fetch it, so storing a second copy spends the
       budget that the unsaved tabs need. */
    const storage = fakeStorage()
    writeSession({ tabs: [tab('t1', { graph: { nodes: [{ id: 'a' }] } })] }, new Set(), storage)
    expect(readSession(storage).tabs[0].graph).toBe(null)
    expect(readSession(storage).tabs[0].doc.id).toBe('db:t1')
  })

  it('keeps the graph of a never-saved tab even when it is clean', () => {
    /* "Clean" for a tab with no database id does not mean recoverable -- there is nowhere to
       recover it from. `useDiagrams` calls such a tab dirty by definition, and this must not be
       the one place that disagrees. */
    const storage = fakeStorage()
    const graph = { nodes: [{ id: 'a' }], edges: [] }
    writeSession({ tabs: [tab('t1', { saved: false, graph })] }, new Set(), storage)
    expect(readSession(storage).tabs[0].graph).toEqual(graph)
  })

  it('remembers the split and its orientation', () => {
    const storage = fakeStorage()
    writeSession(
      { tabs: [tab('t1')], activeId: 't1', split: true, orientation: 'horizontal' },
      new Set(),
      storage,
    )
    const back = readSession(storage)
    expect(back.split).toBe(true)
    expect(back.orientation).toBe('horizontal')
  })

  it('falls back to the first tab when the active one is gone', () => {
    const storage = fakeStorage()
    writeSession({ tabs: [tab('t1'), tab('t2')], activeId: 'tX' }, new Set(), storage)
    expect(readSession(storage).activeId).toBe('t1')
  })

  describe('reading something it cannot trust', () => {
    it('reports nothing when the key is absent', () => {
      expect(readSession(fakeStorage())).toBe(null)
    })

    it('discards an unparseable session', () => {
      expect(readSession(fakeStorage({ [SESSION_KEY]: 'not json' }))).toBe(null)
    })

    it('discards a session from an older shape rather than guessing at it', () => {
      const storage = fakeStorage({
        [SESSION_KEY]: JSON.stringify({ version: 0, tabs: [tab('t1')] }),
      })
      expect(readSession(storage)).toBe(null)
    })

    it('drops a tab that is neither saved nor carried', () => {
      /* Restoring one would put a blank canvas on screen wearing a real diagram's name, which
         reads as the diagram having been emptied. */
      const storage = fakeStorage({
        [SESSION_KEY]: JSON.stringify({
          version: 1,
          activeId: 'ghost',
          tabs: [
            { id: 'ghost', doc: { id: null, name: 'Gone' }, graph: null },
            { id: 'real', doc: { id: 'db:1', name: 'Kept' }, graph: null },
          ],
        }),
      })
      expect(readSession(storage).tabs.map((entry) => entry.id)).toEqual(['real'])
    })

    it('reports nothing when every tab was a ghost', () => {
      const storage = fakeStorage({
        [SESSION_KEY]: JSON.stringify({
          version: 1,
          tabs: [{ id: 'ghost', doc: { id: null }, graph: null }],
        }),
      })
      expect(readSession(storage)).toBe(null)
    })
  })

  describe('the tab being drawn in right now', () => {
    /*
     * The hole a browser run found and no unit test here could have.
     *
     * A pane hands its graph up to `useTabs` on unmount only, so `tabs.tabs` holds `graph: null`
     * for a tab that has never been switched away from -- which is precisely the freshly opened
     * diagram somebody is working in. Writing the session from tab state alone stored *nothing*
     * for it: null graph, no database id, so nothing restorable at all.
     *
     * The fix lives in AppShell (`publishLiveGraph`, a registry of getters the shell reads before
     * writing). What is testable here is the contract it depends on: given the live graph, this
     * stores it -- and given a null one for an unsaved tab, it honestly stores nothing rather than
     * a tab that would restore blank.
     */
    it('stores nothing for an unsaved tab whose graph it was never given', () => {
      const storage = fakeStorage()
      writeSession({ tabs: [tab('t1', { saved: false, graph: null })] }, new Set(['t1']), storage)
      expect(readSession(storage)).toBe(null)
    })

    it('stores it once the live graph is substituted in', () => {
      const storage = fakeStorage()
      const live = { nodes: [{ id: 'drawn-since' }], edges: [] }
      writeSession({ tabs: [tab('t1', { saved: false, graph: live })] }, new Set(['t1']), storage)
      expect(readSession(storage).tabs[0].graph).toEqual(live)
    })

    it('keeps a saved tab reachable even with no graph, because its id is enough', () => {
      /* The asymmetry that makes the budget work: this one reopens from the server. */
      const storage = fakeStorage()
      writeSession({ tabs: [tab('t1', { graph: null })] }, new Set(), storage)
      expect(readSession(storage).tabs[0].doc.id).toBe('db:t1')
      expect(readSession(storage).tabs[0].graph).toBe(null)
    })
  })

  describe('when it does not fit', () => {
    /* `trim` is tested directly with a tiny budget. The order is the behaviour: it is the
       difference between losing a tab that reopens from the server and losing the only copy of an
       hour's work. */
    const packed = (id, { dirty, big }) => ({
      id,
      doc: { id: `db:${id}`, name: id },
      graph: { nodes: Array.from({ length: big ? 200 : 1 }, (_, i) => ({ id: `n${i}` })) },
      dirty,
    })

    it('sheds clean graphs before dirty ones', () => {
      const out = trim([packed('clean', { dirty: false, big: true }), packed('dirty', { dirty: true, big: true })], 4000)
      expect(out.find((entry) => entry.id === 'clean').graph).toBe(null)
      expect(out.find((entry) => entry.id === 'dirty').graph).not.toBe(null)
    })

    it('leaves everything alone when it already fits', () => {
      const input = [packed('a', { dirty: true }), packed('b', { dirty: false })]
      expect(trim(input, 1_000_000)).toBe(input)
    })

    it('keeps the newest dirty tab when even the dirty ones do not fit', () => {
      /* The newest is what is being worked on, so it is the one that survives. */
      const out = trim(
        [packed('old', { dirty: true, big: true }), packed('new', { dirty: true, big: true })],
        3000,
      )
      expect(out.map((entry) => entry.id)).toEqual(['new'])
    })

    it('would rather store one oversized graph than store nothing', () => {
      /* A quota error is caught at the write. Declining to try guarantees the loss the budget was
         only guessing at. */
      const out = trim([packed('only', { dirty: true, big: true })], 10)
      expect(out.map((entry) => entry.id)).toEqual(['only'])
      expect(out[0].graph).not.toBe(null)
    })
  })

  describe('when storage is unavailable or hostile', () => {
    it('does not throw when there is no storage at all', () => {
      expect(writeSession({ tabs: [tab('t1')] }, new Set(), null)).toBe(false)
      expect(readSession(null)).toBe(null)
      expect(readSession(undefined)).toBe(null)
    })

    it('does not throw when the store is full', () => {
      const full = {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => {},
      }
      expect(writeSession({ tabs: [tab('t1')] }, new Set(['t1']), full)).toBe(false)
    })

    it('does not throw when reading throws, as a privacy mode makes it', () => {
      const hostile = {
        getItem: () => {
          throw new Error('blocked')
        },
      }
      expect(readSession(hostile)).toBe(null)
    })
  })

  it('forgets on request', () => {
    const storage = fakeStorage()
    writeSession({ tabs: [tab('t1')] }, new Set(), storage)
    clearSession(storage)
    expect(readSession(storage)).toBe(null)
  })
})
