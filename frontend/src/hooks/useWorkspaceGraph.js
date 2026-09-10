/*
 * Load /api/workspace/graph and keep the React Flow node/edge state in sync.
 *
 * The graph is fetched on demand rather than on mount. On a large workspace the
 * call fans out over every source (two requests each), so firing it automatically
 * would spend a chunk of the customer's rate budget before anyone asked for a
 * diagram.
 *
 * `warnings` from the server is surfaced rather than swallowed: a partial graph
 * is the normal case (no Unify, a rate limit mid-fanout, inferred journeys), and
 * a diagram with a caveat is more useful than an error page.
 */

import { useCallback, useState } from 'react'
import { useEdgesState, useNodesState } from '@xyflow/react'

import { workspace as workspaceApi } from '../services/api.js'
import { buildLayout, capturePositions, captureZones, zoneDescriptor } from '../canvas/layout.js'
import { positionsFromGraph } from '../diagram/serialize.js'

/*
 * The server's zones, plus any the user drew that it has never heard of.
 *
 * A custom zone describes somewhere outside Segment, so `build_graph` cannot know
 * about it. Dropping it here would mean loading the workspace deletes a region the
 * user drew -- and, because React Flow deletes a group's children with it, the
 * components inside it too.
 */
function mergeDrawnZones(serverZones, nodes) {
  const known = new Set((serverZones ?? []).map((zone) => zone.id))
  return [
    ...(serverZones ?? []),
    ...nodes
      .filter((node) => node.type === 'zone' && !known.has(node.data?.id))
      .map(zoneDescriptor),
  ]
}

export function useWorkspaceGraph({ topology }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [graph, setGraph] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)

  const load = useCallback(
    async ({ refresh = false } = {}) => {
      setStatus('loading')
      setError(null)
      try {
        const result = await workspaceApi.graph({ refresh })
        /* Preserve hand-placed positions across a refresh. Without this, hitting
           refresh silently discards every manual adjustment. */
        const existingPositions = refresh ? capturePositions(nodes) : undefined
        const layout = buildLayout(
          { ...result, zones: mergeDrawnZones(result.zones, nodes) },
          /* Zone geometry always, not only on a refresh: the server's zones carry
             no position or size, so a first load would otherwise reset the three
             product zones to their computed stack. */
          { existingPositions, existingZones: captureZones(nodes) },
        )
        setGraph(result)
        setNodes(layout.nodes)
        setEdges(layout.edges)
        setStatus('ready')
        return result
      } catch (err) {
        setError(err)
        setStatus('error')
        throw err
      }
    },
    [nodes, setNodes, setEdges],
  )

  /*
   * Replace the canvas wholesale -- used by template open and diagram load, which
   * supply a stored graph rather than fetching one.
   *
   * Two things this must not do, both of which look like data loss:
   *
   *   - re-run the column layout. `existingPositions` keeps every hand-placed
   *     node where it was left; without it, opening a saved diagram rearranges it
   *     into tidy columns, which is indistinguishable from the save having failed.
   *   - overwrite `graph`. That holds the *workspace* payload -- the real
   *     components the palette lists and the binding UI offers. Replacing it with
   *     the opened diagram would leave a template with nothing to bind against.
   *
   * Returns the layout so the caller can fingerprint exactly what it put on the
   * canvas rather than guessing at how it was normalized.
   */
  const replace = useCallback(
    (savedGraph) => {
      const layout = buildLayout(
        { zones: topology?.zones ?? [], ...savedGraph },
        {
          existingPositions: positionsFromGraph(savedGraph),
          /* Same floor as seedZones: "empty" should be the same size however the
             canvas got there, and an almost-empty zone is a drop target too. */
          minZoneSpan: { columns: 4, rows: 2 },
        },
      )
      setNodes(layout.nodes)
      setEdges(layout.edges)
      setStatus('ready')
      /* The viewport rides along rather than being applied here: moving the canvas
         is React Flow instance state, not node state, and belongs to whoever holds
         the instance. */
      return { ...layout, viewport: savedGraph?.viewport ?? null }
    },
    [topology, setNodes, setEdges],
  )

  /* There used to be a `seedZones` here, called from an effect on mount, which put the
     empty Segment/Connections/Unify/Engage backdrops on a cold canvas. It existed
     because a component could only be dropped inside a zone, so a canvas with no zones
     refused the first thing anyone tried. Dropping onto bare canvas is allowed now, and
     an empty canvas is meant to be empty -- the zones come from a template, from the
     workspace, or from the user drawing one. */

  const clear = useCallback(() => {
    setNodes([])
    setEdges([])
    setGraph(null)
    setStatus('idle')
  }, [setNodes, setEdges])

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    graph,
    status,
    error,
    warnings: graph?.warnings ?? [],
    inferredJourneys: graph?.inferredJourneys ?? [],
    load,
    replace,
    clear,
  }
}
