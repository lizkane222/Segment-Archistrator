/*
 * The open tabs, across a page load.
 *
 * ## The bug this exists for
 *
 * Signing in is a full-page navigation. `AccountMenu` renders an anchor to
 * `/api/auth/google/start` rather than a button, and it has to -- the target answers with a
 * cross-origin redirect to Google, which a `fetch` cannot usefully follow, so the browser
 * itself leaves. Google then redirects back to `/?signed_in=...`.
 *
 * Tabs lived in `useState` inside `useTabs`, called with no initial value. So the document was
 * torn down with every open diagram in it and the app booted fresh with one blank tab. Nothing
 * *cleared* the tabs; they simply never existed in the new page.
 *
 * The cruel part is which button does it. The sign-in link is titled "Keep your diagrams after
 * this browser session ends" -- it is the action the UI recommends for durability, and it was
 * the single most destructive click in the app. There was no `beforeunload` guard either, so it
 * took unsaved work with it silently.
 *
 * ## What is stored, and what is deliberately not
 *
 * A saved, unmodified tab needs only its `doc`: the graph is on the server and `openDiagram`
 * will fetch it. A tab with unsaved work needs its graph, because nothing else in the world has
 * it. So the graph is carried for dirty tabs and dropped for clean ones, and that is a budget
 * decision as much as a correctness one -- `localStorage` gives about 5MB per origin and a
 * three-hundred-node diagram is not small.
 *
 * `trim` is what happens when even that does not fit: clean tabs go first (recoverable from
 * their id), and a tab that is neither saved nor carried is dropped entirely rather than
 * restored as a blank canvas wearing a real diagram's name. A dirty graph is never dropped to
 * make room for anything else.
 *
 * ## Who supplies the graph
 *
 * Not this module, and not `useTabs` either -- which is the subtlety that made the first version of
 * this store nothing at all for the tab that mattered most. A pane hands its graph up on *unmount*,
 * because serializing three hundred nodes per drag frame would cost the frame rate, so the tab
 * record for a diagram nobody has switched away from still says `graph: null`. A freshly opened
 * diagram being actively drawn in is exactly that.
 *
 * So `AppShell` keeps a registry of live-graph getters that mounted panes publish into
 * (`publishLiveGraph`), and substitutes them in before calling `writeSession` -- on a tab change,
 * and again on `pagehide`. This module is handed finished graphs and does not know where they came
 * from; what it does guarantee is the honest failure, which is that a tab it was given nothing for
 * and which has no database id is stored as nothing rather than as a tab that restores blank.
 *
 * ## localStorage, not sessionStorage
 *
 * `sessionStorage` survives a same-tab navigation, which is all the OAuth round trip strictly
 * needs, and it would be the tidier choice for that alone. It loses a browser crash and a
 * restored window, which are the two cases the person who redownloads the same diagram five
 * times is actually afraid of. So: `localStorage`, one key, rewritten wholesale.
 *
 * Pure apart from `safeStorage`, with storage injected throughout, because this project has no
 * jsdom -- and that constraint matches reality anyway, since touching `localStorage` throws
 * outright in some privacy modes.
 */

const KEY = 'segment-builder:session'

/* Bumped when the stored shape changes incompatibly. A session from an older shape is discarded
   rather than migrated: it is at most one page load old, and guessing wrong about it would
   restore a diagram into the wrong tab. */
const VERSION = 1

/* About 2MB of JSON, well inside a 5MB origin budget with room for the clipboard and the
   preferences beside it. Characters rather than bytes -- `length` is what a quota error is
   actually counted in for a UTF-16 store, near enough for a budget this loose. */
const BUDGET = 2_000_000

function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * What to persist for one tab.
 *
 * `dirty` is recorded rather than recomputed, because it is not knowable on the way back in:
 * dirtiness is a comparison against the last-saved fingerprint, which lives in a mounted pane.
 * Storing it is what lets the restored strip show its dots immediately instead of after each
 * pane has mounted and reported.
 */
function packTab(tab, { dirty }) {
  return {
    id: tab.id,
    doc: tab.doc ?? null,
    /* A clean, saved tab is refetched on mount. A dirty one, or one that was never saved, has
       nowhere else to come from. */
    graph: dirty || !tab.doc?.id ? (tab.graph ?? null) : null,
    dirty: Boolean(dirty),
  }
}

/** Is this packed tab worth restoring at all? */
function restorable(tab) {
  return Boolean(tab?.id && (tab.graph || tab.doc?.id))
}

/**
 * Drop what has to be dropped to fit the budget, least valuable first.
 *
 * Exported for its own test: the order is the whole behaviour, and it is the difference between
 * losing a tab that can be reopened from the server and losing the only copy of an hour's work.
 */
export function trim(tabs, budget = BUDGET) {
  const size = (list) => JSON.stringify(list).length
  let out = tabs
  if (size(out) <= budget) return out

  /* 1. Clean tabs lose their graph. They keep their id, so they reopen from the server. */
  out = out.map((tab) => (tab.dirty ? tab : { ...tab, graph: null }))
  if (size(out) <= budget) return out.filter(restorable)

  /* 2. Then clean tabs go entirely -- a clean tab with no id and no graph is nothing. */
  out = out.filter(restorable)
  if (size(out) <= budget) return out

  /* 3. Only then dirty tabs, oldest first, because the newest is what is being worked on. A
     single graph over budget is still written: the quota error is caught, and trying and failing
     costs nothing next to declining to try. */
  const kept = []
  for (const tab of [...out].reverse()) {
    kept.unshift(tab)
    if (size(kept) > budget && kept.length > 1) {
      kept.shift()
      break
    }
  }
  return kept
}

/**
 * Write the whole workbench session.
 *
 * @param session `{tabs, activeId, split, orientation}` as `useTabs` holds them
 * @param dirtyIds a Set of tab ids with unsaved work
 */
export function writeSession(session, dirtyIds, storage = safeStorage()) {
  if (!storage) return false
  const dirty = dirtyIds ?? new Set()
  /* Filtered before the budget is considered, not only inside `trim`: a tab with neither a graph
     nor an id is not a small thing to store, it is nothing to store, and it would restore as a
     blank canvas wearing a real diagram's name. The blank tab every first visit starts with is
     exactly this, which is why writing it at all had to be the case that stores nothing. */
  const packed = trim(
    (session?.tabs ?? [])
      .map((tab) => packTab(tab, { dirty: dirty.has(tab.id) }))
      .filter(restorable),
  )
  /* Nothing worth keeping is an active decision to forget: leaving a stale session behind would
     restore a diagram the reader had closed. */
  if (!packed.length) return clearSession(storage)
  try {
    storage.setItem(
      KEY,
      JSON.stringify({
        version: VERSION,
        savedAt: new Date().toISOString(),
        activeId: session.activeId ?? packed[0].id,
        split: Boolean(session.split),
        orientation: session.orientation ?? null,
        tabs: packed,
      }),
    )
    return true
  } catch {
    /* Full, or blocked. Nothing is lost that was not already only in memory, and interrupting
       somebody mid-drawing over a storage quota would be worse than the thing it warns about. */
    return false
  }
}

/**
 * Read a session back, or null when there is nothing usable.
 *
 * Tolerant by design -- this is persisted, hand-editable, and written by a possibly older build
 * of the app. Anything it cannot make sense of is discarded in favour of a clean boot, because
 * the failure mode of trusting it is a blank canvas labelled with a real diagram's name.
 */
export function readSession(storage = safeStorage()) {
  let raw
  try {
    raw = storage?.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.tabs)) return null

  const tabs = parsed.tabs.filter(restorable)
  if (!tabs.length) return null

  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      doc: tab.doc ?? undefined,
      graph: tab.graph ?? null,
      /* Carried through so the caller can tell "restore this from storage" from "refetch this
         from the server", which is the one thing the graph being null does not distinguish. */
      dirty: Boolean(tab.dirty),
    })),
    activeId: tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : tabs[0].id,
    split: Boolean(parsed.split),
    orientation: parsed.orientation ?? null,
    savedAt: parsed.savedAt ?? null,
  }
}

export function clearSession(storage = safeStorage()) {
  try {
    storage?.removeItem(KEY)
  } catch {
    /* Nothing to do about it, and nothing depends on it having worked. */
  }
  return false
}

/** Exposed so a test can name the key without hardcoding it in two places. */
export const SESSION_KEY = KEY
