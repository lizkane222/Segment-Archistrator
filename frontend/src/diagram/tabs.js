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

import { useCallback, useMemo, useRef, useState } from 'react'

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
 * Tabs coming back from storage, with ids that cannot collide.
 *
 * The counter above starts from zero on every page load, but a restored tab keeps the id it was
 * stored with -- so without this, the first tab opened after a reload was minted `tab:1` beside a
 * restored `tab:1`. Two tabs with one id are one tab as far as everything keyed on it is concerned:
 * the strip highlighted both and could select neither apart, and the unmount capture wrote one
 * pane's graph into both. And because the session is rewritten from tab state, the duplicate was
 * stored and came back on the next load too.
 *
 * So the counter is moved past every restored id, and a duplicate already in storage gets a fresh
 * id rather than being dropped -- its doc may differ from its twin's, and dropping it could lose
 * the only copy of something. Other fields are passed through untouched (`dirty` included), so
 * the caller can key anything else it seeds from the restored set on the same ids.
 */
export function restoreTabs(list) {
  for (const tab of list ?? []) {
    const match = /^tab:(\d+)$/.exec(tab?.id ?? '')
    if (match) counter = Math.max(counter, Number(match[1]))
  }
  const seen = new Set()
  return (list ?? []).map((tab) => {
    const id = tab?.id && !seen.has(tab.id) ? tab.id : nextTabId()
    seen.add(id)
    return id === tab?.id ? tab : { ...tab, id }
  })
}

/**
 * The group a tab opened from a saved diagram belongs in, as the arguments `open` takes.
 *
 * A diagram saved from a tab remembers that tab's group label. Opened again, it brings the label
 * back: into the connected workspace's group when the label is that workspace's name, otherwise as
 * a group of the user's own. Empty when the diagram was saved from no group, which leaves the new
 * tab to be born where the one in front of you is, as it always was.
 */
export function groupForSaved(entry, connections = [], signedIn = false) {
  const label = String(entry?.group_name ?? '').trim()
  if (!label) return {}
  const workspace = signedIn
    ? connections.find((item) => item.id === entry.workspace_id && item.name === label)
    : null
  return workspace ? { workspaceId: workspace.id } : { workspaceId: null, groupName: label }
}

/**
 * The saved list as the Open dialog shows it: named groups first, each with its diagrams, then
 * whatever was saved from no group. Groups are ordered by their most recent diagram, and the
 * diagrams in each by recency -- the server's own order, which this keeps.
 */
export function groupSaved(saved = []) {
  const byName = new Map()
  const loose = []
  for (const diagram of saved) {
    const name = String(diagram.group_name ?? '').trim()
    if (!name) loose.push(diagram)
    else if (byName.has(name)) byName.get(name).push(diagram)
    else byName.set(name, [diagram])
  }
  return {
    groups: [...byName].map(([name, diagrams]) => ({ name, diagrams })),
    loose,
  }
}

/**
 * What groups a tab on the strip: its connected workspace, else its custom group name, else nothing.
 *
 * A custom group is the user's own label -- "Acme", "Q4 pitch" -- for organising tabs. It carries no
 * credential and reaches no workspace: only `workspaceId` does, and a tab has one or the other.
 */
export function groupKeyOf(tab) {
  if (tab?.workspaceId) return tab.workspaceId
  return tab?.groupName ? `name:${tab.groupName}` : null
}

/**
 * A new tab.
 *
 * `graph` may be null, which means "nothing loaded yet" -- a blank tab. That is distinct from an
 * empty graph (`{nodes: [], ...}`), which means the user has a diagram open and has deleted
 * everything in it, and would be saved as such.
 */
export function newTab({ id, doc, graph = null, workspaceId = null, groupName = null, opening = null } = {}) {
  return {
    id: id ?? nextTabId(),
    /* A load to perform when the pane mounts -- `{template: key}` or `{diagram: id}` -- so Open can
       start a tab and fill it, rather than replacing the canvas of the tab you are in. Transient: not
       stored in the session, and ignored once the tab has a graph. */
    ...(opening ? { opening } : {}),
    /* A label of the user's own, for a tab that is in no connected workspace. Never both. */
    groupName: workspaceId ? null : String(groupName ?? '').trim() || null,
    /* The workspace group this tab belongs to, or null for a tab about no workspace. The group is
       the workspace's id, and the credential is the server's to look up -- see
       `WorkspaceSessionAuthentication._scope`. */
    workspaceId: workspaceId || null,
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
    /* A fork stays in its original's group: it is a copy of a diagram about that workspace. */
    workspaceId: tab?.workspaceId ?? null,
    groupName: tab?.groupName ?? null,
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
 * The tabs in display order: grouped by workspace, groups in the order they first appeared, and
 * tabs within a group in the order they were opened.
 *
 * A group is only ever *shown* contiguously -- the stored order is left alone, because split and
 * "the tab to the right" are about position and a drag should not reshuffle unrelated tabs.
 */
export function groupTabs(tabs) {
  const groups = []
  const byKey = new Map()
  for (const tab of tabs ?? []) {
    const key = groupKeyOf(tab)
    if (!byKey.has(key)) {
      const group = { key, workspaceId: tab.workspaceId ?? null, groupName: tab.workspaceId ? null : (tab.groupName ?? null), tabs: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    byKey.get(key).tabs.push(tab)
  }
  return groups
}

/** Does this graph hold components bound to a real workspace resource? Same test as the server's. */
export function hasBoundComponents(graph) {
  return (graph?.nodes ?? []).some((node) => {
    const data = { ...node, ...(node?.data ?? {}) }
    return Boolean(data.bound && data.segmentId)
  })
}

/**
 * Whether a tab may be dragged into another workspace's group.
 *
 * Components bound from workspace A carry A's ids, names and links. Moving that diagram under B
 * would show them on a tab whose requests, shared diagrams and saves are all B's -- and a diagram
 * saved there is about B, though every bound component came from A. So a diagram with bound
 * components stays where its components came from; an unbound one has nothing to leak and can go
 * anywhere. Moving *into* "no workspace" is a move out of a group, held to the same rule.
 */
export function canMoveToGroup(tab, graph, workspaceId) {
  const target = workspaceId ?? null
  /* Same workspace -- including moving between custom groups, or into one from "no workspace": only
     the user's own label changes, so there is nothing for a bound component to leak into. */
  if ((tab?.workspaceId ?? null) === target) return { ok: true }
  if (hasBoundComponents(graph ?? tab?.graph)) {
    return {
      ok: false,
      reason:
        'This diagram has components bound from its workspace, so it has to stay in that workspace. Fork it and unbind the components to move a copy.',
    }
  }
  return { ok: true }
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

  /* The next tab along *in the same group*, wrapping to the previous one when the active tab is last
     -- so splitting while the rightmost tab is active shows something rather than showing one pane
     and an apology. Two panes share one set of workspace requests, so a pane from another group
     beside this one would be reading and saving under the wrong workspace. */
  const mates = list.filter(
    (tab, position) => position !== index && groupKeyOf(tab) === groupKeyOf(active),
  )
  const after = mates.find((tab) => list.indexOf(tab) > index)
  const partner = after ?? mates[mates.length - 1] ?? null
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
export function useTabs(initial, restored = {}) {
  /* Mapped through `newTab` rather than trusted as-is: a restored tab comes from storage, so it
     may be missing a field a later build added, and `newTab` is where a tab's defaults live. */
  const [tabs, setTabs] = useState(() =>
    initial?.length ? restoreTabs(initial).map((tab) => newTab(tab)) : [newTab()],
  )
  /* The tab that was on screen, when it is still among them. Falls back to the first rather than
     to nothing, so a stored id that no longer matches cannot leave the strip with no selection. */
  const [activeId, setActiveId] = useState(() => {
    const first = tabs[0].id
    if (!initial?.length) return first
    return tabs.some((tab) => tab.id === restored.activeId) ? restored.activeId : first
  })
  /* Split view and its orientation are part of the arrangement too: coming back from a sign-in to
     one pane, having left two side by side, reads as work having been lost even when none was. */
  const [split, setSplit] = useState(() => Boolean(restored.split))
  const [orientation, setOrientation] = useState(() => restored.orientation ?? SPLIT_VERTICAL)

  /* The active tab's group, readable from callbacks that must not change identity when it moves. */
  const activeGroupRef = useRef({ workspaceId: null, groupName: null })
  const activeIdRef = useRef(null)

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  activeGroupRef.current = { workspaceId: activeTab?.workspaceId ?? null, groupName: activeTab?.groupName ?? null }
  activeIdRef.current = activeTab?.id ?? null

  const visible = useMemo(() => visibleTabs(tabs, activeId, { split }), [tabs, activeId, split])

  /**
   * Store a pane's current graph and document against its tab.
   *
   * A no-op when neither has actually changed, and that is a correctness requirement rather than an
   * optimization. A pane reports its document on every change, so a version of this that always
   * replaced the tab object would hand that pane a new `tab` prop, which would re-run the effect that
   * reported it, for ever. Returning the identical array -- and the identical tab objects within it --
   * is what makes "tell me again" free.
   *
   * Compared by reference on purpose. Both values are rebuilt wholesale by their owners rather than
   * mutated, so identity is the honest test, and a deep comparison of a three-hundred-node graph on
   * every report would cost more than the write it avoided.
   */
  const capture = useCallback((tabId, { graph, doc }) => {
    setTabs((current) => {
      let changed = false
      const next = current.map((tab) => {
        if (tab.id !== tabId) return tab
        const graphChanged = graph !== undefined && graph !== tab.graph
        const docChanged = Boolean(doc) && doc !== tab.doc
        if (!graphChanged && !docChanged) return tab
        changed = true
        return { ...tab, ...(graphChanged ? { graph } : {}), ...(docChanged ? { doc } : {}) }
      })
      return changed ? next : current
    })
  }, [])

  const open = useCallback((tab) => {
    /* A new tab is born in the group of the one you are looking at, unless told otherwise: opening
       a diagram "next to" this one means about the same workspace. `workspaceId: null` is a
       decision (a tab about no workspace); leaving it out is not. */
    const stated = tab && ('workspaceId' in tab || 'groupName' in tab)
    const created = newTab({
      ...tab,
      workspaceId: stated ? (tab.workspaceId ?? null) : activeGroupRef.current.workspaceId,
      groupName: stated ? (tab.groupName ?? null) : activeGroupRef.current.groupName,
    })
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

  /* Put a tab in a group. Whether it *may* go is `canMoveToGroup`'s call, made by the caller, which is
     the one with the live graph; this only does it. */
  const setGroup = useCallback((tabId, workspaceId, groupName = null) => {
    const name = workspaceId ? null : String(groupName ?? '').trim() || null
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId &&
        ((tab.workspaceId ?? null) !== (workspaceId ?? null) || (tab.groupName ?? null) !== name)
          ? { ...tab, workspaceId: workspaceId ?? null, groupName: name }
          : tab,
      ),
    )
  }, [])

  /* Tabs whose workspace is no longer connected fall back to no workspace, so a stale id can never
     attach one to whichever workspace is connected under that id next. */
  const pruneGroups = useCallback((validIds) => {
    const valid = new Set(validIds)
    setTabs((current) =>
      current.some((tab) => tab.workspaceId && !valid.has(tab.workspaceId))
        ? current.map((tab) =>
            tab.workspaceId && !valid.has(tab.workspaceId) ? { ...tab, workspaceId: null } : tab,
          )
        : current,
    )
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
        /* A second pane must come from the *same group* -- see `visibleTabs` -- so having other
           tabs open is not enough: if none of them is in this group, fork the active one. */
        const active = list.find((tab) => tab.id === activeIdRef.current) ?? list[0]
        const hasMate = list.some(
          (tab) => tab !== active && groupKeyOf(tab) === groupKeyOf(active),
        )
        return hasMate ? list : [...list, forkTab(active)]
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
    setGroup,
    pruneGroups,
  }
}
