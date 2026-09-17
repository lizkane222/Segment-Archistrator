/*
 * What order a fork's arms are taken in.
 *
 * ## The thing this is not
 *
 * A path's route is not stored. It is walked -- outward from the start, along the arrows -- so there
 * is no list anywhere to drag rows around in, and reordering it in the obvious sense would mean
 * rewiring the diagram. What *is* a genuine choice, and the only one that needs no rewiring, is what
 * happens where the walk has more than one way to go: a fork.
 *
 * By default the event takes every arm of a fork at once, which is right and is what a fan-out to
 * twenty destinations means. But a fork is also the one place a *story* has an order -- "first it goes
 * to Adobe, and separately it also goes to the AEP endpoint" -- and telling that story needs the arms
 * taken one at a time, in a chosen order. Nothing about the diagram changes; only which moment each
 * arm plays on.
 *
 * ## The shape
 *
 *   branches: { [forkNodeId]: [childNodeId, ...] }
 *
 * A key being *present* means "one at a time, in this order". Absent means together. One field for
 * both facts on purpose: ordering arms you have not sequenced is meaningless -- they happen at the
 * same instant -- so asking for an order *is* asking for a sequence, and a second flag could
 * contradict the first.
 *
 * Unlisted children are appended in the order the walk found them rather than dropped. A stored order
 * outlives the diagram it was recorded against: draw a third connector out of a fork you had already
 * sequenced and it has to appear somewhere sensible, not vanish from the path.
 *
 * Pure, and shared by the editor and the scheduler (`scheduleWaves` in simulation/router.js) so the
 * order the reader drags into the Route and the order the event actually takes cannot disagree.
 */

/**
 * A fork's children in the order this path takes them, or null for "all at once".
 *
 * @param branches  the scenario's `branches` map
 * @param nodeId    the component the arms leave from
 * @param children  every child id the walk found, in trace order
 */
export function sequenceOf(branches, nodeId, children) {
  const stored = branches?.[nodeId]
  if (!Array.isArray(stored) || stored.length === 0) return null

  const present = new Set(children ?? [])
  /* Stored ids that are no longer children are dropped -- a connector the user has since deleted or
     turned round must not leave a hole in the order. */
  const ordered = stored.filter((id) => present.has(id))
  const listed = new Set(ordered)
  /* Then anything the order has not heard of, in the order the walk found it. */
  return [...ordered, ...(children ?? []).filter((id) => !listed.has(id))]
}

/** Is this component's fork played one arm at a time? */
export function sequenced(branches, nodeId) {
  return Array.isArray(branches?.[nodeId]) && branches[nodeId].length > 0
}

/**
 * The order after moving one child by `delta` places. Returns a whole new `branches` map.
 *
 * Moving an arm is also what *starts* a sequence: the map gains a key it did not have, because
 * ordering arms that play simultaneously is not a thing anyone can mean. So this takes the full child
 * list and writes it out in full, which makes the first move and every later one the same operation.
 *
 * Out-of-range moves return the map unchanged rather than clamping, so the first arm's "earlier"
 * button is a no-op the caller can also render as disabled -- and the document is not marked dirty by
 * a click that changed nothing.
 */
export function moveBranch(branches, nodeId, childId, delta, children) {
  const order = sequenceOf(branches, nodeId, children) ?? [...(children ?? [])]
  const from = order.indexOf(childId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return branches ?? {}

  const next = [...order]
  next.splice(to, 0, ...next.splice(from, 1))
  return { ...(branches ?? {}), [nodeId]: next }
}

/** Sequence a fork without moving anything -- "one at a time", in the order the walk found them. */
export function sequenceBranches(branches, nodeId, children) {
  if (!children?.length) return branches ?? {}
  return { ...(branches ?? {}), [nodeId]: [...children] }
}

/**
 * Back to all at once.
 *
 * The key is *removed* rather than set to `[]`. Absent is what a scenario that never used this looks
 * like, and writing an empty array would leave every path the reader had experimented with carrying a
 * field that means nothing -- and would mark it dirty against its saved copy for a setting they had
 * just undone.
 */
export function unsequenceBranches(branches, nodeId) {
  if (!branches || !(nodeId in branches)) return branches ?? {}
  const next = { ...branches }
  delete next[nodeId]
  return next
}
