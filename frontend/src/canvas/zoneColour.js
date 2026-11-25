/*
 * A zone's colour, handed down.
 *
 * What a component looks like inside a zone is read off the zone live (`borderColorFor`), which is why a
 * recoloured zone recolours the components that never chose a colour of their own. Three things stood in
 * the way of that being true everywhere:
 *
 *   - a component that was ever given its own border (a palette applied to it, a style copied from
 *     another) keeps that border for good, so it carries on wearing the old colour;
 *   - a zone inside the zone -- Sources inside a custom region, say -- has a colour of its own, so
 *     recolouring the outer one left everything inside the inner one as it was;
 *   - a connector wears its start's colour, and a connector given one by hand never changes.
 *
 * Recolouring a zone is a statement about everything inside it, so this takes the three overrides away
 * (and gives the zones inside the new colour). Run when the border colour is changed, not on every render:
 * a component styled by hand *afterwards* is still its own.
 */

/** Every node below any of `zoneIds`, at any depth, as a Set of ids. The zones themselves are not in it. */
export function descendantsOf(nodes, zoneIds) {
  const roots = new Set(zoneIds)
  const below = new Set()
  const parents = new Map((nodes ?? []).map((node) => [node.id, node.parentId ?? null]))
  for (const node of nodes ?? []) {
    let at = node.parentId
    const seen = new Set()
    while (at && !seen.has(at)) {
      seen.add(at)
      if (roots.has(at)) {
        below.add(node.id)
        break
      }
      at = parents.get(at)
    }
  }
  return below
}

/** The nodes with the new colour handed down. Same array when nothing below needed changing. */
export function cascadeNodes(nodes, zoneIds, border) {
  if (!border) return nodes
  const below = descendantsOf(nodes, zoneIds)
  let changed = false
  const next = nodes.map((node) => {
    if (!below.has(node.id)) return node
    if (node.type === 'zone') {
      if (node.data?.style?.border === border && !node.data?.color) return node
      changed = true
      const { color: _drop, ...rest } = node.data ?? {}
      return { ...node, data: { ...rest, style: { ...(node.data?.style ?? {}), border } } }
    }
    if (!node.data?.style?.border) return node
    changed = true
    const { border: _gone, ...style } = node.data.style
    return { ...node, data: { ...node.data, style } }
  })
  return changed ? next : nodes
}

/** The connectors starting at anything below a zone, with any colour chosen by hand taken off. */
export function cascadeEdges(edges, nodes, zoneIds) {
  const below = descendantsOf(nodes, zoneIds)
  let changed = false
  const next = (edges ?? []).map((edge) => {
    if (!below.has(edge.source) || !edge.data?.color) return edge
    changed = true
    const { color: _gone, ...data } = edge.data
    return { ...edge, data }
  })
  return changed ? next : edges
}
