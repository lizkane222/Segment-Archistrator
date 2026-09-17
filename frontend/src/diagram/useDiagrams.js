/*
 * Open / save / save-as / delete, plus "is this diagram unsaved?".
 *
 * The hook owns the *document* -- which diagram is open, what it is called, and
 * what its contents were the last time they were persisted. It deliberately does
 * not own the canvas: `open*` returns a graph for the caller to hand to
 * `useWorkspaceGraph.replace`, and `save` takes a graph back. Two reasons. React
 * Flow node state already has an owner, and a hook that reached into it would make
 * "load a template" untestable without a canvas mounted.
 *
 * Dirty tracking compares a canonical fingerprint rather than a change counter,
 * because React Flow emits change events for selection and measurement -- a
 * counter would report a freshly-opened diagram as edited before anyone touched it.
 */

import { useCallback, useEffect, useState } from 'react'

import { ApiError, diagrams as diagramsApi, templates as templatesApi } from '../services/api.js'
import { graphFingerprint } from './serialize.js'

export const UNTITLED = 'Untitled architecture'

function blank() {
  return { id: null, name: UNTITLED, description: '', sourceTemplate: '', updatedAt: null }
}

export function useDiagrams() {
  const [templates, setTemplates] = useState([])
  const [saved, setSaved] = useState([])
  const [listError, setListError] = useState(null)
  const [loadingLists, setLoadingLists] = useState(true)
  const [busy, setBusy] = useState(null) // 'open' | 'save' | 'delete' | null
  const [current, setCurrent] = useState(blank)
  /* null means "never persisted", which counts as dirty: a template that has been
     opened but not saved has changes worth keeping, even untouched. */
  const [savedPrint, setSavedPrint] = useState(null)

  const refresh = useCallback(async () => {
    setLoadingLists(true)
    try {
      const [templateResult, diagramResult] = await Promise.all([
        templatesApi.list(),
        diagramsApi.list(),
      ])
      setTemplates(templateResult?.items ?? [])
      setSaved(diagramResult?.items ?? [])
      setListError(null)
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setLoadingLists(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Open a seeded reference architecture.
   *
   * The result is an unsaved document: `id` stays null, so the first Save creates
   * a new diagram rather than editing the template. Templates are read-only in v1
   * and shared by every workspace, so writing back into one would edit everyone's.
   */
  const openTemplate = useCallback(async (key) => {
    setBusy('open')
    try {
      const template = await templatesApi.get(key)
      setCurrent({
        id: null,
        name: template.name ?? UNTITLED,
        description: template.description ?? '',
        sourceTemplate: template.key ?? key,
        updatedAt: null,
      })
      setSavedPrint(null)
      return template.graph ?? { nodes: [], edges: [] }
    } finally {
      setBusy(null)
    }
  }, [])

  const openDiagram = useCallback(async (id) => {
    setBusy('open')
    try {
      const diagram = await diagramsApi.get(id)
      setCurrent({
        id: diagram.id,
        name: diagram.name ?? UNTITLED,
        description: diagram.description ?? '',
        sourceTemplate: diagram.source_template ?? '',
        updatedAt: diagram.updated_at ?? null,
      })
      return diagram.graph ?? { nodes: [], edges: [] }
    } finally {
      setBusy(null)
    }
  }, [])

  /**
   * Adopt a diagram read from an exported file.
   *
   * Not a template and not a saved diagram, for the same reason `openTemplate` isn't:
   * `id` stays null, so the first Save creates a new diagram in this workspace rather
   * than assuming one by this name already exists here. The graph itself is not this
   * hook's concern -- the caller reads it out of the file and hands it to `applyGraph`
   * directly, same split as `openTemplate`.
   */
  const importGraph = useCallback(({ name, description, sourceTemplate } = {}) => {
    setCurrent({
      id: null,
      name: name || UNTITLED,
      description: description ?? '',
      sourceTemplate: sourceTemplate ?? '',
      updatedAt: null,
    })
    setSavedPrint(null)
  }, [])

  /**
   * Start from nothing. Not a template, not a saved diagram, not the workspace.
   *
   * `zones: []` explicitly, not omitted. `replace` fills an absent `zones` from the
   * topology so a document saved before zones were stored still loads with them --
   * which would make "blank" arrive with Segment and its three products already
   * drawn. An empty canvas is empty.
   */
  const startBlank = useCallback(() => {
    setCurrent(blank())
    setSavedPrint(null)
    return { nodes: [], edges: [], zones: [] }
  }, [])

  /**
   * Adopt whatever is on the canvas as the saved state.
   *
   * Called with the serialized form of the layout that was just applied -- not
   * with the graph that came off the wire. Loading normalizes (default `collapsed`,
   * rounded positions, zone derived from the parent), so fingerprinting the wire
   * payload would leave every freshly-opened diagram looking dirty.
   */
  const markSaved = useCallback((graph) => {
    setSavedPrint(graphFingerprint(graph))
  }, [])

  const isDirty = useCallback(
    (graph) => savedPrint === null || graphFingerprint(graph) !== savedPrint,
    [savedPrint],
  )

  /** Update an open diagram, or create one if this document has never been saved. */
  const save = useCallback(
    async (graph, { name, description } = {}) => {
      setBusy('save')
      try {
        const body = {
          name: name ?? current.name ?? UNTITLED,
          description: description ?? current.description ?? '',
          graph,
        }
        const result = current.id
          ? await diagramsApi.update(current.id, body)
          : await diagramsApi.create({ ...body, source_template: current.sourceTemplate ?? '' })

        setCurrent({
          id: result.id,
          name: result.name,
          description: result.description ?? '',
          sourceTemplate: result.source_template ?? '',
          updatedAt: result.updated_at ?? null,
        })
        /* Fingerprint what the server stored, not what was sent: the server strips
           secret-shaped fields on write, so the two can legitimately differ and the
           stored copy is the one a reload will produce. */
        setSavedPrint(graphFingerprint(result.graph ?? graph))
        refresh()
        return result
      } finally {
        setBusy(null)
      }
    },
    [current, refresh],
  )

  /** Fork: always creates, and carries the template lineage forward. */
  const saveAs = useCallback(
    async (name, graph, { description } = {}) => {
      setBusy('save')
      try {
        const result = await diagramsApi.create({
          name: name || UNTITLED,
          description: description ?? current.description ?? '',
          source_template: current.sourceTemplate ?? '',
          graph,
        })
        setCurrent({
          id: result.id,
          name: result.name,
          description: result.description ?? '',
          sourceTemplate: result.source_template ?? '',
          updatedAt: result.updated_at ?? null,
        })
        setSavedPrint(graphFingerprint(result.graph ?? graph))
        refresh()
        return result
      } finally {
        setBusy(null)
      }
    },
    [current, refresh],
  )

  /** Local until the next save -- typing in the name field should not POST. */
  const rename = useCallback((name) => {
    setCurrent((doc) => ({ ...doc, name }))
  }, [])

  const remove = useCallback(
    async (id) => {
      setBusy('delete')
      try {
        await diagramsApi.remove(id)
        /* Deleting the open diagram leaves the canvas alone and detaches it: the
           work is still on screen, and the next Save writes a new row. Wiping the
           canvas would be a destructive surprise from a list action. */
        setCurrent((doc) => (doc.id === id ? { ...doc, id: null, updatedAt: null } : doc))
        setSavedPrint(null)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  /**
   * Take over an already-loaded document, with no request.
   *
   * What a tab switch needs. Every other way into this hook fetches -- `openDiagram` reads the
   * server, `startBlank` resets -- but a tab already holds the document it was carrying when it was
   * last on screen, and re-fetching it would both cost a round trip and silently discard whatever
   * had been drawn since the last save.
   *
   * Deliberately does not touch `savedPrint`. Whether the restored graph counts as dirty is a fact
   * about the *graph*, and the caller establishes it by handing that graph to `markSaved` (or not).
   * Setting it here from a document that has no graph attached would report every restored tab as
   * clean.
   */
  const adopt = useCallback((doc) => {
    if (doc) setCurrent({ ...blank(), ...doc })
  }, [])

  return {
    templates,
    saved,
    listError,
    loadingLists,
    busy,
    current,
    refresh,
    openTemplate,
    openDiagram,
    importGraph,
    startBlank,
    save,
    saveAs,
    rename,
    remove,
    markSaved,
    isDirty,
    adopt,
  }
}
