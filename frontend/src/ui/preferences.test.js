/*
 * A remembered UI choice.
 *
 * The bug this exists for is subtler than "it resets on reload". `notesCollapsed` lived in `Workbench`,
 * which is keyed by tab id -- so folding the notes lane away, looking at another diagram and coming
 * back found it open again, and in split view the two panes disagreed about it. Storage fixes the
 * reload; a *shared store* is what fixes the other two.
 *
 * Storage is injected throughout. This project has no jsdom, so `localStorage` does not exist here --
 * which is the same condition a browser in a strict privacy mode presents, and the reason every access
 * in the module is wrapped rather than only the writes.
 */

import { describe, expect, it, vi } from 'vitest'

import { preference } from './preferences.js'

/** A `localStorage` stand-in, with the one behaviour that matters: it round-trips strings. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    /* Readable by a test that wants to assert the wire format rather than the round trip. */
    raw: map,
  }
}

const KEY = 'segment-builder:pref:lane'

describe('a remembered preference', () => {
  it('reports the default until something is stored', () => {
    expect(preference('lane', true, fakeStorage()).get()).toBe(true)
    expect(preference('lane', false, fakeStorage()).get()).toBe(false)
  })

  it('reads a stored choice back, including false', () => {
    /* The reason the wire format is JSON and not the raw string: `'false'` read back as a string is
       truthy, and a preference whose default is `false` is the commonest kind here. */
    expect(preference('lane', true, fakeStorage({ [KEY]: 'false' })).get()).toBe(false)
    expect(preference('lane', false, fakeStorage({ [KEY]: 'true' })).get()).toBe(true)
  })

  it('stores a choice under a prefixed key', () => {
    const storage = fakeStorage()
    preference('lane', true, storage).set(false)
    expect(storage.raw.get(KEY)).toBe('false')
  })

  it('survives a reload, which is one store handing over to the next', () => {
    const storage = fakeStorage()
    preference('lane', true, storage).set(false)
    /* A fresh store over the same storage is what a new page load looks like. */
    expect(preference('lane', true, storage).get()).toBe(false)
  })

  it('tells its subscribers, so two panes showing one lane agree', () => {
    /* The split-view case. Both panes subscribe to the same store, so one folding the lane has to move
       the other -- which per-pane `useState` could never do. */
    const store = preference('lane', true, fakeStorage())
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(false)
  })

  it('says nothing when the value has not actually changed', () => {
    /* Setting a preference to what it already is happens on every render that mirrors state into it;
       announcing it would re-render every subscriber for nothing. */
    const store = preference('lane', true, fakeStorage())
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops telling a subscriber that has unsubscribed', () => {
    const store = preference('lane', true, fakeStorage())
    const listener = vi.fn()
    store.subscribe(listener)()
    store.set(false)
    expect(listener).not.toHaveBeenCalled()
  })

  describe('another browser tab changing it', () => {
    it('picks the new value up and tells its subscribers', () => {
      /* This is what "across all of my tabs" actually asks for, and what `sessionStorage` could not
         have delivered: each tab has its own copy of that, so there would be nothing to observe. */
      const storage = fakeStorage()
      const store = preference('lane', true, storage)
      const listener = vi.fn()
      store.subscribe(listener)

      storage.raw.set(KEY, 'false')
      store.notify({ key: KEY })

      expect(store.get()).toBe(false)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('ignores a change to a different key', () => {
      const storage = fakeStorage()
      const store = preference('lane', true, storage)
      const listener = vi.fn()
      store.subscribe(listener)

      storage.raw.set('segment-builder:pref:something-else', 'false')
      store.notify({ key: 'segment-builder:pref:something-else' })

      expect(store.get()).toBe(true)
      expect(listener).not.toHaveBeenCalled()
    })

    it('re-reads on a storage clear, which reports no key at all', () => {
      /* The spec sends `key: null` for `clear()`. Ignoring anything without a matching key would leave
         this tab showing a preference the origin no longer holds. */
      const storage = fakeStorage({ [KEY]: 'false' })
      const store = preference('lane', true, storage)
      expect(store.get()).toBe(false)

      storage.raw.clear()
      store.notify({ key: null })
      expect(store.get()).toBe(true)
    })
  })

  describe('when storage is unavailable or hostile', () => {
    it('falls back to the default rather than throwing', () => {
      /* Not hypothetical: in a strict privacy mode merely *touching* `localStorage` throws, which is
         why the module wraps the access and not only the write. */
      const hostile = {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      }
      expect(preference('lane', true, hostile).get()).toBe(true)
    })

    it('still holds the choice for this session when it cannot be written', () => {
      const hostile = {
        getItem: () => null,
        setItem: () => {
          throw new Error('full')
        },
      }
      const store = preference('lane', true, hostile)
      store.set(false)
      /* Only the *remembering* is lost. Interrupting the reader over that would be worse than losing it. */
      expect(store.get()).toBe(false)
    })

    it('treats an unreadable stored value as no preference at all', () => {
      expect(preference('lane', true, fakeStorage({ [KEY]: 'not json' })).get()).toBe(true)
    })

    it('works with no storage whatsoever', () => {
      const store = preference('lane', true, null)
      store.set(false)
      expect(store.get()).toBe(false)
    })
  })
})
