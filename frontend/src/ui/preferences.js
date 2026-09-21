/*
 * Small UI choices the reader expects to stick: is this lane open, is that drawer expanded.
 *
 * ## Why this exists at all
 *
 * Every collapsible in this app was ephemeral `useState` -- the notes lane, the walkthrough drawer, the
 * console, the inspector, the split divider, the palette sections. Reloading reset all of them, which
 * is defensible, and *switching diagram tabs* reset them too, which is not: `Workbench` is keyed by tab
 * id, so a tab switch unmounts it and every piece of pane state with it. A reader who folded the notes
 * lane away, looked at another diagram and came back found it open again.
 *
 * There was no pattern to follow. The only browser storage in the app is one `sessionStorage` key for
 * the clipboard, which is a clip rather than a preference; `localStorage` and `indexedDB` appear only in
 * the sandbox denylist for user functions; and there is no server-side preference field or endpoint.
 * So this is the pattern, deliberately small, and it borrows the clipboard's shape: a `safeStorage()`
 * wrapped in try/catch because privacy settings can make storage throw on *access*, not just on write,
 * and an injectable storage argument so the tests never touch a real one.
 *
 * ## localStorage, not sessionStorage
 *
 * The opposite choice from the clipboard, and for the opposite reason. `sessionStorage` is per browser
 * tab, which is exactly right for a clip and exactly wrong here: "remember this across all of my tabs"
 * cannot be answered by storage that each tab has its own copy of. A preference is also not a thing
 * that becomes stale and dangerous a week later, which is the argument that put the clipboard in
 * `sessionStorage`.
 *
 * ## Why it publishes, rather than just reading once
 *
 * Two readers have to agree. In split view the same lane is mounted twice, once per pane, and a browser
 * tab opened alongside is a third. So a change notifies local subscribers *and* listens for the
 * `storage` event, which fires in every *other* tab of the same origin. That is what makes the
 * preference genuinely shared rather than merely remembered.
 *
 * Kept as `preference(key, fallback)` returning a store rather than as a hook, so the value can be read
 * outside React and so a caller subscribes with `useSyncExternalStore` -- the same shape as
 * `handleReveal` and `anchors` elsewhere in this codebase.
 */

const PREFIX = 'segment-builder:pref:'

/*
 * Storage is read through a function, not captured once at module load.
 *
 * Merely *touching* `localStorage` throws in some privacy modes, so the try/catch has to wrap the
 * access itself. Returning null leaves every operation below a no-op and the preference falls back to
 * living in memory for the session, which is strictly better than a blank page.
 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * One remembered choice.
 *
 * JSON rather than raw strings, so `false` survives the round trip -- a preference whose default is
 * `false` is the commonest kind here, and `'false'` read back as a string is truthy.
 *
 * @param key       stable name, prefixed on the way to storage
 * @param fallback  what to report before anyone has chosen, and if the stored value is unreadable
 * @param storage   injectable, for tests
 */
export function preference(key, fallback, storage = safeStorage()) {
  const at = `${PREFIX}${key}`
  const listeners = new Set()

  const read = () => {
    try {
      const raw = storage?.getItem(at)
      /* Absent and unparseable are the same answer: nobody has expressed a preference this code can
         honour, so the caller's default stands. */
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  /* Mirrored in memory so `get` is cheap enough to call on every render, and so the value is still
     correct when storage is unavailable and every write is a no-op. */
  let current = read()

  const announce = () => {
    for (const listener of listeners) listener()
  }

  /*
   * Another tab of this origin changed it.
   *
   * `event.key === null` is a `clear()`, which the spec reports with no key -- so it has to re-read
   * rather than be ignored. Anything else about a different key is not ours.
   */
  const onStorage = (event) => {
    if (event.key !== null && event.key !== at) return
    const next = read()
    if (next === current) return
    current = next
    announce()
  }
  globalThis.addEventListener?.('storage', onStorage)

  return {
    get: () => current,
    set(value) {
      if (value === current) return
      current = value
      try {
        storage?.setItem(at, JSON.stringify(value))
      } catch {
        /* Full, or blocked. The choice still holds for this session -- it is in `current` -- and only
           the remembering is lost, which is not worth interrupting anyone over. */
      }
      announce()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /* For a test, or a teardown that cares. Nothing in the app calls it: these live as long as the
       page does, which is the point of them. */
    dispose() {
      globalThis.removeEventListener?.('storage', onStorage)
      listeners.clear()
    },
    /* Exposed so a test can drive the cross-tab path without dispatching a real event. */
    notify: onStorage,
  }
}

/*
 * The preferences the app actually has, declared in one place.
 *
 * Module scope on purpose: a preference created inside a component would get a new store, and a new
 * `storage` listener, on every mount -- and in split view there are two mounts of the same pane. One
 * store per key, shared by every reader, is what makes the two panes agree.
 */
export const NOTES_LANE_OPEN = preference('notes-lane-open', true)
