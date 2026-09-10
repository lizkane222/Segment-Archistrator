/*
 * Several diagrams open at once, and one or two of them on screen.
 *
 * ## What a tab is, and what it is not
 *
 * A tab is `{id, doc, graph}` -- a *document*, not a canvas. `doc` is the same record
 * `useDiagrams` owns (which saved diagram this is, its name, when it was last persisted) and
 * `graph` is a serialized `{nodes, edges, zones, ...}`, exactly what `serializeGraph` produces and
 * `buildLayout` consumes.
 *
 * That split is what makes this cheap, and it is the reason `useDiagrams` was written not to own
 * the canvas: only the tabs actually *on screen* have a React Flow store, and switching a tab is a
 * remount from its stored graph rather than N live canvases competing for the pointer, each with
 * its own culling pass and its own minimap.
 *
 * The `id` is the tab's own, minted here, and is deliberately not the diagram's database id: two
 * tabs can hold the same saved diagram (open it, fork it, compare), and a never-saved diagram has
 * no database id at all.
 *
 * ## Forking
 *
 * A fork is the whole point of the feature and it needs no backend at all. `useDiagrams` already
 * treats `doc.id === null` as "never persisted, therefore dirty", so a fork is: copy the graph,
 * clear the database id, and name it something the user can tell apart. The original is untouched
 * and unsaved-by-definition applies to the copy.
 *
 * ## Everything here is pure
 *
 * No React. The interesting behaviour is "which tab is showing after this one closes" and "what
 * does a fork inherit", and both are answerable from data -- so they are answered in tests rather
 * than by clicking around. The hook that holds this in state is `useTabs`, at the bottom.
 */

import { useCallback, useMemo, useState } from 'react'

import { UNTITLED } from './useDiagrams.js'

/* How many panes the side-by-side view will show. Two, and a hard limit rather than a default:
   each pane is a full React Flow instance with its own store, culling pass and minimap, and the
   divider is a single fraction. Three would need a layout tree and would give each pane a third of
   the screen, which for a diagram is not a view of anything. */
export const MAX_PANES = 2

export const SPLIT_VERTICAL = 'vertical'
export const SPLIT_HORIZONTAL = 'horizontal'

let counter = 0

/** A tab id. Sequential rather than random, so a test can name one and a log line can be read. */
export function nextTabId() {
  counter += 1
  return `tab:${counter}`
}

/**
 * A new tab.
 *
 * `graph` may be null, which means "nothing loaded yet" -- a blank tab. That is distinct from an
 * empty graph (`{nodes: [], ...}`), which means the user has a diagram open and has deleted
 * everything in it, and would be saved as such.
 */
export function newTab({ id, doc, graph = null } = {}) {
  return {
    id: id ?? nextTabId(),
    doc: doc ?? { id: null, name: UNTITLED, description: '', sourceTemplate: '', updatedAt: null },
    graph,
  }
}

/**
 * A copy of `tab`, as a new tab holding the same drawing but no saved identity.
 *
 * `doc.id` cleared is the load-bearing part: it is what makes `useDiagrams` treat the copy as
 * never-persisted, so saving it creates a second diagram instead of overwriting the one it came
 * from. Forgetting it would make "fork" a synonym for "open twice and overwrite from whichever
 * pane you saved last", which is the one behaviour a fork must not have.
 *
 * `sourceTemplate` is kept. It records which reference architecture this descends from, which is
 * still true of a copy and is what the template picker reads to say "based on".
 */
export function forkTab(tab, { id, name } = {}) {
  const from = tab?.doc ?? {}
  return newTab({
    id,
    doc: {
      ...from,
      id: null,
      name: name || forkName(from.name),
      /* Never persisted, so there is no such time. Left over from the original it would claim the
         copy had been saved, and the dot that marks unsaved work reads this. */
      updatedAt: null,
    },
    /* The same graph object, not a clone. Nothing mutates a stored graph -- `serializeGraph`
       always builds a fresh one and `buildLayout` only reads -- so sharing the reference is safe
       and means forking a 300-node diagram costs nothing. The moment either pane edits, its own
       canvas produces a new object. */
    graph: tab?.graph ?? null,
  })
}

/** `Acme CDP` -> `Acme CDP (copy)`, and again -> `Acme CDP (copy 2)`. */
export function forkName(name) {
  const base = (name ?? '').trim() || UNTITLED
  const match = base.match(/^(.*) \(copy(?: (\d+))?\)$/)
  if (!match) return `${base} (copy)`
  /* Counting on from an existing copy rather than nesting "(copy) (copy)", which after three
     forks is a name with no information left in it. */
  const seen = match[2] ? Number(match[2]) : 1
  return `${match[1]} (copy ${seen + 1})`
}

/**
 * Which tab is showing after `closing` goes.
 *
 * The one to its right, or -- when it was last -- the one to its left. That is what every tabbed
 * editor does, and the reason is that it keeps the *position* of the eye rather than the identity
 * of a tab: closing several in a row walks along the strip instead of jumping to whichever tab
 * happened to be created first.
 *
 * Returns null when the last tab is closing, which the caller has to handle by opening a blank one
 * -- an editor with no tabs has nowhere to draw.
 */
export function nextActiveId(tabs, closingId) {
  const list = tabs ?? []
  const index = list.findIndex((tab) => tab.id === closingId)
  if (index < 0) return null
  const remaining = list.filter((tab) => tab.id !== closingId)
  if (!remaining.length) return null
  return (list[index + 1] ?? list[index - 1]).id
}

/**
 * The tabs that are on screen, given the active one and the split state.
 *
 * Single pane: just the active tab. Split: the active tab and the next one along, which is why
 * splitting with only one tab open has to create a second -- the caller does that.
 *
 * Returned as a list because that is what the view maps over, and its length *is* the number of
 * panes; there is no second source of truth about how many there are.
 */
export function visibleTabs(tabs, activeId, { split = false } = {}) {
  const list = tabs ?? []
  if (!list.length) return []
  const index = Math.max(0, list.findIndex((tab) => tab.id === activeId))
  const active = list[index] ?? list[0]
  if (!split) return [active]

  /* The next tab along, wrapping to the previous one when the active tab is last -- so splitting
     while the rightmost tab is active shows something rather than showing one pane and an
     apology. */
  const partner = list[index + 1] ?? list[index - 1] ?? null
  return partner ? [active, partner] : [active]
}

/* --- the hook --------------------------------------------------------------- */

/**
 * Tabs in state, plus the split view's own two settings.
 *
 * The graph of a tab that is *on screen* is not stored here -- it lives in that pane's React Flow
 * store, which is the authority while the pane is mounted. `capture` is how a pane hands its graph
 * back, and it is called when a pane is about to stop being shown (a switch, a close, a split
 * collapsing). Storing every keystroke here instead would mean serializing a 300-node diagram on
 * every drag frame.
 */
export function useTabs(initial) {
  const [tabs, setTabs] = useState(() => (initial?.length ? initial : [newTab()]))
  const [activeId, setActiveId] = useState(() => (initial?.length ? initial[0].id : tabs[0].id))
  const [split, setSplit] = useState(false)
  const [orientation, setOrientation] = useState(SPLIT_VERTICAL)

  const visible = useMemo(() => visibleTabs(tabs, activeId, { split }), [tabs, activeId, split])

  /** Store a pane's current graph and document against its tab. */
  const capture = useCallback((tabId, { graph, doc }) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? { ...tab, ...(graph !== undefined ? { graph } : {}), ...(doc ? { doc } : {}) }
          : tab,
      ),
    )
  }, [])

  const open = useCallback((tab) => {
    const created = newTab(tab)
    setTabs((current) => [...current, created])
    setActiveId(created.id)
    return created
  }, [])

  const fork = useCallback((tabId) => {
    let created = null
    setTabs((current) => {
      const from = current.find((tab) => tab.id === tabId)
      if (!from) return current
      created = forkTab(from)
      /* Inserted right after its original rather than at the end: a fork is *about* the tab it
         came from, and the two being adjacent is what makes them easy to flip between -- and what
         makes the split view show them together, since it pairs the active tab with the next. */
      const index = current.findIndex((tab) => tab.id === tabId)
      return [...current.slice(0, index + 1), created, ...current.slice(index + 1)]
    })
    if (created) setActiveId(created.id)
    return created
  }, [])

  const close = useCallback((tabId) => {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== tabId)
      if (!remaining.length) {
        /* Never zero tabs. An editor with no tabs has nowhere to draw, and the blank one it gets
           instead is what the app opens with anyway. */
        const blank = newTab()
        setActiveId(blank.id)
        return [blank]
      }
      setActiveId((active) => (active === tabId ? nextActiveId(current, tabId) : active))
      return remaining
    })
  }, [])

  /*
   * Turning the split on may need a second tab, and that is decided here rather than by the
   * button: "side by side" with one tab open is a request for a second pane, and the least
   * surprising thing to put in it is a copy of what is already there.
   */
  const toggleSplit = useCallback(() => {
    setSplit((current) => {
      if (current) return false
      setTabs((list) => {
        if (list.length > 1) return list
        return [...list, forkTab(list[0])]
      })
      return true
    })
  }, [])

  return {
    tabs,
    activeId,
    active: tabs.find((tab) => tab.id === activeId) ?? tabs[0],
    visible,
    split,
    orientation,
    setActiveId,
    setOrientation,
    toggleSplit,
    capture,
    open,
    fork,
    close,
  }
}
