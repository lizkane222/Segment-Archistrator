/*
 * One pane's canvas state: the React Flow nodes and edges, and how a stored graph is put on them.
 *
 * Reading the workspace is not done here. That list lives above the panes in
 * `useWorkspaceResources`, so it is shared by every tab and never lands on a canvas by itself.
 */

import { useCallback, useState } from 'react'
import { useEdgesState, useNodesState } from '@xyflow/react'

import { buildLayout } from '../canvas/layout.js'
import { positionsFromGraph } from '../diagram/serialize.js'

export function useWorkspaceGraph({ topology }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [status, setStatus] = useState('idle') // idle | ready

  /*
   * Replace the canvas wholesale -- used by template open and diagram load, which
   * supply a stored graph rather than fetching one.
   *
   * Two things this must not do, both of which look like data loss:
   *
   *   - re-run the column layout. `existingPositions` keeps every hand-placed
   *     node where it was left; without it, opening a saved diagram rearranges it
   *     into tidy columns, which is indistinguishable from the save having failed.
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
    setStatus('idle')
  }, [setNodes, setEdges])

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    status,
    replace,
    clear,
  }
}
