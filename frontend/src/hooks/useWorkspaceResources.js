/*
 * The connected workspace's real components, read once and shared by every tab.
 *
 * Held above the panes, not in one: each pane is keyed by its tab and unmounts on a switch, so a read
 * held inside one would be lost, and re-read, every time the reader changed tabs. It is also only a
 * *list* -- the Workspace tab and the Bind tab read it -- and never touches a canvas. Putting a
 * workspace on a canvas is a separate, explicit act ("Visualize all").
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { workspace as workspaceApi } from '../services/api.js'

export function useWorkspaceResources(workspace) {
  const [graph, setGraph] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  /* So a response for a workspace that has since been disconnected or swapped is dropped rather
     than shown under the new one's name. */
  const generation = useRef(0)

  const load = useCallback(async ({ refresh = false } = {}) => {
    const mine = ++generation.current
    setStatus('loading')
    setError(null)
    try {
      const result = await workspaceApi.graph({ refresh })
      if (mine !== generation.current) return null
      setGraph(result)
      setStatus('ready')
      return result
    } catch (err) {
      if (mine !== generation.current) return null
      setError(err)
      setStatus('error')
      throw err
    }
  }, [])

  const workspaceId = workspace?.id ?? null
  useEffect(() => {
    generation.current += 1
    setGraph(null)
    setError(null)
    setStatus('idle')
    if (!workspaceId) return
    load().catch(() => {})
  }, [workspaceId, load])

  return { graph, status, error, load }
}
