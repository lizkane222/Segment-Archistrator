/*
 * What a multi-selection can have done to it: align, match size, match style, group.
 *
 * Pure, and taking the whole node array rather than the selected subset, because none of
 * these questions can be answered from the selection alone. Two things force that:
 *
 *   - Positions are parent-relative. A card in Connections and a card in Engage have
 *     coordinates in different frames, so "align these two to the left" is only the same
 *     gesture as "give them the same x" when they happen to share a parent. Every
 *     alignment here is computed in flow coordinates and written back as a *delta* on the
 *     local position, which is the one form that is right in both cases.
 *   - Size is three-valued. `data.size` is what the user chose, `measured` is what the
 *     browser found, and NODE_WIDTH is the fallback -- so the box a card actually occupies
 *     is not on the node under any single key. See `componentSize` in layout.js.
 *
 * Zones are excluded from matching size and style: matching a zone's size would scale its
 * contents (`scaleZoneChildren`), so a "make these the same size" aimed at two components
 * would silently rearrange a third that merely happened to be selected with them. Align and
 * distribute are different -- a zone's box is exactly as usable as a component's for "line
 * these up" or "space these evenly", and there is no version of that request a user could
 * mean by selecting components instead when what they have selected is two zones. Those two
 * take `selectedAny`; everything else here still takes `selectedComponents`.
 */

import { NODE_HEIGHT, NODE_WIDTH, arrangeOf, componentSize, nodeArea } from './layout.js'
import { absolutePositions } from './rules.js'

/* The six the request names -- "align top/middle/right/left/bottom/center" -- under the
   axis each one actually works on, because `center` and `middle` are the same word twice
   in the same list and the id is what the code has to read. */
export const ALIGNMENTS = ['left', 'centerX', 'right', 'top', 'middleY', 'bottom']

/* Distribute puts equal *gaps* between boxes rather than equal spacing between their
   centres. With cards of different widths those two are different arrangements, and it is
   the gaps a reader sees. */
export const DISTRIBUTIONS = ['horizontal', 'vertical']

/* One step, or all the way. The same four Lucid binds to cmd-[ / cmd-] and their shifted
   pair, which is what the request asked to match. */
export const ARRANGE_MOVES = ['front', 'forward', 'backward', 'back']

export const GROUP_ID_PREFIX = 'grp:'

/** The nodes a selection action applies to: the selected components, in document order. */
export function selectedComponents(nodes, ids) {
  const wanted = new Set(ids ?? [])
  return (nodes ?? []).filter((node) => wanted.has(node.id) && node.type !== 'zone')
}

/**
 * The same, but zones included.
 *
 * Arrange and lock are the two things that genuinely apply to *anything on the canvas*,
 * which is how the request words both of them -- which of two overlapping regions is in
 * front is exactly the question a zone raises, and pinning a zone down so a stray drag
 * cannot shift a whole product is most of the point of a lock. Every other action here
 * still refuses zones; see the module header for why.
 */
export function selectedAny(nodes, ids) {
  const wanted = new Set(ids ?? [])
  return (nodes ?? []).filter((node) => wanted.has(node.id))
}

/**
 * The box a node occupies in flow coordinates.
 *
 * Chosen size first, for the same reason `childExtent` and `centreOf` do it: the frame
 * after a resize, `measured` still describes the box before it, and an align that read it
 * would leave every card a gesture behind the one it was lining up with.
 */
export function boxOf(node, positions) {
  const at = positions.get(node.id) ?? { x: 0, y: 0 }
  const chosen = componentSize(node)
  return {
    x: at.x,
    y: at.y,
    width: chosen.width ?? node.measured?.width ?? NODE_WIDTH,
    height: chosen.height ?? node.measured?.height ?? NODE_HEIGHT,
  }
}

/**
 * Where a set of boxes sits, taken together.
 *
 * The selection's own bounding box is the reference for every alignment, rather than one
 * chosen member: "align left" against the leftmost card is what a user means by it, and
 * it makes the operation idempotent -- doing it twice moves nothing the second time, which
 * a reference that moved with the result would not.
 */
function selectionBounds(boxes) {
  return {
    left: Math.min(...boxes.map((box) => box.x)),
    right: Math.max(...boxes.map((box) => box.x + box.width)),
    top: Math.min(...boxes.map((box) => box.y)),
    bottom: Math.max(...boxes.map((box) => box.y + box.height)),
  }
}

function alignedOrigin(box, bounds, alignment) {
  switch (alignment) {
    case 'left':
      return { x: bounds.left, y: box.y }
    case 'right':
      return { x: bounds.right - box.width, y: box.y }
    case 'centerX':
      return { x: (bounds.left + bounds.right) / 2 - box.width / 2, y: box.y }
    case 'top':
      return { x: box.x, y: bounds.top }
    case 'bottom':
      return { x: box.x, y: bounds.bottom - box.height }
    case 'middleY':
      return { x: box.x, y: (bounds.top + bounds.bottom) / 2 - box.height / 2 }
    default:
      return { x: box.x, y: box.y }
  }
}

/**
 * Line the selected components up on one edge or axis.
 *
 * Needs two to mean anything: with one selected the bounding box *is* that card, so every
 * alignment is a no-op that still marks the document dirty.
 */
export function alignNodes(nodes, ids, alignment) {
  const members = selectedAny(nodes, ids)
  if (members.length < 2 || !ALIGNMENTS.includes(alignment)) return nodes ?? []

  const positions = absolutePositions(nodes)
  const boxes = new Map(members.map((node) => [node.id, boxOf(node, positions)]))
  const bounds = selectionBounds([...boxes.values()])

  return (nodes ?? []).map((node) => {
    const box = boxes.get(node.id)
    if (!box) return node
    const target = alignedOrigin(box, bounds, alignment)
    /* A delta on the stored position, not the absolute target: the stored one is relative
       to whatever this node is a child of, and writing a flow coordinate into it would
       fling every card in a zone off by its zone's own origin. Rounded because a sub-pixel
       position produces a diff on every save. */
    return {
      ...node,
      position: {
        x: Math.round((node.position?.x ?? 0) + (target.x - box.x)),
        y: Math.round((node.position?.y ?? 0) + (target.y - box.y)),
      },
    }
  })
}

/**
 * Space the selected components evenly along one axis.
 *
 * The outermost two do not move. That is what makes this a *distribution* rather than a
 * layout: the user has already decided where the run starts and ends by placing those two,
 * and everything between them is what they are asking to be tidied. Moving the ends as
 * well would mean the button could not be pressed twice without the group creeping.
 *
 * Needs three. With two selected there is exactly one gap, which is already equal to
 * itself -- so the action would mark the document dirty and change nothing, which reads as
 * broken. The caller greys it with that reason rather than letting it no-op.
 *
 * Equal gaps can come out negative, when the cards between the two ends do not fit in the
 * span. That is left as it is: it spreads the overlap evenly instead of refusing, and an
 * evenly-overlapping row is a legible signal to widen the run, which a refusal is not.
 */
export function distributeNodes(nodes, ids, axis) {
  const members = selectedAny(nodes, ids)
  if (members.length < 3 || !DISTRIBUTIONS.includes(axis)) return nodes ?? []

  const horizontal = axis === 'horizontal'
  const positions = absolutePositions(nodes)
  const start = (box) => (horizontal ? box.x : box.y)
  const extent = (box) => (horizontal ? box.width : box.height)

  const boxes = members
    .map((node) => ({ node, box: boxOf(node, positions) }))
    .sort((a, b) => start(a.box) - start(b.box))

  const first = boxes[0].box
  const last = boxes[boxes.length - 1].box
  const span = start(last) + extent(last) - start(first)
  const occupied = boxes.reduce((total, entry) => total + extent(entry.box), 0)
  const gap = (span - occupied) / (boxes.length - 1)

  /* Walked as a running cursor rather than computed per index, because the cards have
     different sizes -- an nth-position formula would only be right for a row of identical
     boxes and would silently drift on any real diagram. */
  const targets = new Map()
  let cursor = start(first)
  for (const entry of boxes) {
    targets.set(entry.node.id, cursor)
    cursor += extent(entry.box) + gap
  }

  return (nodes ?? []).map((node) => {
    const target = targets.get(node.id)
    if (target === undefined) return node
    const box = boxOf(node, positions)
    /* A delta on the stored position, for the same reason `alignNodes` uses one: the
       stored coordinate is relative to whatever this node is a child of. */
    const delta = Math.round(target - start(box))
    if (delta === 0) return node
    return {
      ...node,
      position: {
        x: (node.position?.x ?? 0) + (horizontal ? delta : 0),
        y: (node.position?.y ?? 0) + (horizontal ? 0 : delta),
      },
    }
  })
}

/* --- stacking order -------------------------------------------------------- */

/*
 * Which nodes a stacking change is decided among: this one's siblings of the same
 * category.
 *
 * Siblings, because array order is only paint order between nodes React Flow resolves at
 * the same depth -- "bring this card in Unify in front of that zone in Engage" is not a
 * question array order can answer, and pretending to answer it would move a node in the
 * list without changing what the canvas draws.
 *
 * Same category, because zones and components are on two different z bands (ZONE_Z and
 * COMPONENT_Z) and no amount of reordering puts a zone's backdrop over a card. Mixing them
 * into one pool would let "send to back" spend its whole travel getting past components it
 * was already behind.
 */
function arrangePool(nodes, node) {
  const zone = node.type === 'zone'
  const parent = node.parentId ?? null
  return (nodes ?? []).filter(
    (other) => (other.type === 'zone') === zone && (other.parentId ?? null) === parent,
  )
}

/**
 * A pool in the order it is painted, back to front.
 *
 * Must agree exactly with `orderForFlow`, which is why both read `arrangeOf` and
 * `nodeArea` from layout.js. If the two ever disagreed, "bring forward" would move a node
 * past a neighbour in this list and the canvas would draw it somewhere else.
 */
function paintOrder(members) {
  return (members ?? [])
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        arrangeOf(a.node) - arrangeOf(b.node) ||
        nodeArea(b.node) - nodeArea(a.node) ||
        a.index - b.index,
    )
    .map((entry) => entry.node)
}

/*
 * One step, for every moving node at once, without them swapping past each other.
 *
 * Walked from the far end -- highest index first when moving forward -- so each swap only
 * touches positions the loop has already passed. Computing the positions once is safe
 * because of that, and re-deriving them mid-loop would be the obvious way to write this
 * wrongly: a swap changes the indices of exactly the two slots involved.
 *
 * A moving node blocked by another moving node stays put. Otherwise a contiguous run of
 * three would shuffle within itself and arrive in a different internal order than it
 * started, which is not what "move these forward" says.
 */
function stepBy(ordered, moving, direction) {
  const out = [...ordered]
  const positions = out
    .map((node, index) => index)
    .filter((index) => moving.has(out[index].id))
  for (const index of direction > 0 ? positions.reverse() : positions) {
    const to = index + direction
    if (to < 0 || to >= out.length) continue
    if (moving.has(out[to].id)) continue
    ;[out[index], out[to]] = [out[to], out[index]]
  }
  return out
}

/**
 * Restack the selection: bring to front, forward one, backward one, send to back.
 *
 * Writes `data.arrange` as a dense index over the whole pool rather than as an offset on
 * the moved node alone. An offset cannot express "one level": `arrange + 1` may still tie
 * with the neighbour it was supposed to pass, and a tie falls through to the size rule --
 * so the menu item would appear to do nothing on exactly the pair of same-sized cards a
 * user is most likely to be trying to separate. Dense indices have no ties, so every press
 * moves the node exactly one place.
 *
 * The cost is that the first restack in a pool writes `arrange` onto all of its siblings,
 * which pins the whole pool's order. That is the right trade: the alternative leaves the
 * size rule still shuffling nodes the user has explicitly ordered, and the size rule is a
 * default for diagrams nobody has arranged.
 *
 * A selection spanning two pools is arranged within each of them separately, because that
 * is the only thing the ordering can mean -- and a multi-select of a zone and a card
 * genuinely is two independent questions.
 */
export function arrangeNodes(nodes, ids, move) {
  const list = nodes ?? []
  const targets = selectedAny(list, ids)
  if (!targets.length || !ARRANGE_MOVES.includes(move)) return list

  const pools = new Map()
  for (const node of targets) {
    const key = `${node.type === 'zone' ? 'zone' : 'component'}@${node.parentId ?? ''}`
    if (!pools.has(key)) pools.set(key, { members: arrangePool(list, node), moving: new Set() })
    pools.get(key).moving.add(node.id)
  }

  const arranged = new Map()
  for (const { members, moving } of pools.values()) {
    const ordered = paintOrder(members)
    /* Relative order preserved within the moved set, so a run sent to the back arrives
       there in the order it was in. */
    const picked = ordered.filter((node) => moving.has(node.id))
    const rest = ordered.filter((node) => !moving.has(node.id))

    let next
    if (move === 'front') next = [...rest, ...picked]
    else if (move === 'back') next = [...picked, ...rest]
    else next = stepBy(ordered, moving, move === 'forward' ? 1 : -1)

    /* Nothing moved -- already at the front, or already at the back. Skipped rather than
       written, or "bring to front" on the frontmost node would densify the whole pool's
       `arrange` and mark the document dirty for a press that changed no paint order. */
    if (next.every((node, index) => node === ordered[index])) continue

    next.forEach((node, index) => arranged.set(node.id, index))
  }

  /* Same array back when the order did not change -- pressing "bring to front" on
     something already at the front should not mark the document dirty. */
  let changed = false
  const out = list.map((node) => {
    if (!arranged.has(node.id)) return node
    const value = arranged.get(node.id)
    if (arrangeOf(node) === value) return node
    changed = true
    return { ...node, data: { ...node.data, arrange: value } }
  })
  return changed ? out : list
}

/* --- locking --------------------------------------------------------------- */

/**
 * Pin the selection in place, or release it. Zones included.
 *
 * `data.locked` is about *placement* only -- moving and resizing -- and deliberately not
 * about deletion or editing. A lock that also blocked delete would be a second, quieter
 * spelling of "read-only", and the thing being asked for is the one that stops a stray
 * drag from nudging a region after the diagram is arranged. Delete is loud, undoable, and
 * already guarded for a populated zone.
 *
 * Removed rather than written as `false` when unlocking, so an unlocked node is byte-identical
 * to one that was never locked and does not carry a key into every saved document.
 */
export function setLocked(nodes, ids, locked) {
  const wanted = new Set(ids ?? [])
  if (!wanted.size) return nodes ?? []

  let changed = false
  const out = (nodes ?? []).map((node) => {
    if (!wanted.has(node.id)) return node
    if (Boolean(node.data?.locked) === Boolean(locked)) return node
    changed = true
    const data = { ...node.data }
    if (locked) data.locked = true
    else delete data.locked
    return { ...node, data }
  })
  return changed ? out : (nodes ?? [])
}

/** Is anything in the selection pinned? What the menu reads to choose Lock or Unlock. */
export function anyLocked(nodes, ids) {
  return selectedAny(nodes, ids).some((node) => node.data?.locked)
}

/**
 * Give every selected component the model's box.
 *
 * Written to `data.size`, which is where a resize handle writes and what survives a save;
 * see `componentSize`. The model's *occupied* box rather than its chosen one, so matching
 * against a card that has never been resized still does something -- and what it does is
 * what the user can see, which is the only reading of "make same size" they can check.
 */
export function matchSize(nodes, ids, modelId) {
  const members = selectedComponents(nodes, ids)
  const model = members.find((node) => node.id === modelId)
  if (!model || members.length < 2) return nodes ?? []

  const box = boxOf(model, absolutePositions(nodes))
  const size = { width: Math.round(box.width), height: Math.round(box.height) }

  return (nodes ?? []).map((node) =>
    node.id !== modelId && members.some((member) => member.id === node.id)
      ? { ...node, data: { ...node.data, size } }
      : node,
  )
}

/**
 * Give every selected component the model's style override.
 *
 * The whole override, replaced rather than merged -- and cleared when the model has none.
 * "Apply the same style" has to be able to make a card look like a plain one, and a merge
 * could not: a red card in the selection would keep its red through every subsequent
 * attempt to match it to an unstyled model, and the toolbar would read as broken.
 *
 * Size is deliberately not part of this. `data.size` lives outside `data.style` precisely
 * because the request asked for "make same size" and "apply same style" as two separate
 * actions, and one of them quietly doing the other is the failure that would follow.
 */
/**
 * One node with a patch applied, merging `style` and overwriting everything else.
 *
 * Pure and exported so the multi-select style write can be tested without a DOM -- `updateNodes` in
 * AppShell.jsx is a `useCallback` around this, and the interesting behaviour is all here.
 *
 * The asymmetry is the whole of it. A reader who selects four cards and picks one border colour means
 * "give all four this border", not "make all four identical" -- so each keeps its own background, and
 * `style` merges. Everything else in a patch is a plain field and overwrites, as it does for one node.
 *
 * Deliberately *not* what `matchStyle` does: that one replaces the whole override, because "make these
 * look like that one" can only mean it, and a merge would leave the receivers carrying keys the model
 * does not have.
 */
export function patched(node, patch) {
  const data = { ...node.data, ...patch }
  if (patch?.style) data.style = { ...(node.data?.style ?? {}), ...patch.style }
  return { ...node, data }
}

export function matchStyle(nodes, ids, modelId) {
  const members = selectedComponents(nodes, ids)
  const model = members.find((node) => node.id === modelId)
  if (!model || members.length < 2) return nodes ?? []

  const style = model.data?.style

  return (nodes ?? []).map((node) => {
    if (node.id === modelId || !members.some((member) => member.id === node.id)) return node
    const data = { ...node.data }
    if (style) data.style = { ...style }
    else delete data.style
    return { ...node, data }
  })
}

/**
 * Tie the selected components together under one group id.
 *
 * `data.group` rather than a container node, because a container is a zone and zones
 * already mean something here -- "this region is Unify". A group is not a region: its
 * members can be in different zones, which is most of why anyone would want one.
 *
 * The id is passed in rather than minted here so this stays pure and testable; the caller
 * mints it. Re-grouping a selection that already carries mixed group ids overwrites all of
 * them, which is what "group these" says, and is why ungrouping is offered beside it.
 */
export function groupNodes(nodes, ids, groupId) {
  const members = selectedComponents(nodes, ids)
  if (members.length < 2 || !groupId) return nodes ?? []
  const wanted = new Set(members.map((node) => node.id))

  return (nodes ?? []).map((node) =>
    wanted.has(node.id) ? { ...node, data: { ...node.data, group: groupId } } : node,
  )
}

/**
 * Break the groups any of the selected components belong to.
 *
 * Every member of those groups, not just the selected ones. Releasing half a group leaves
 * the rest still moving as one, which from the canvas is indistinguishable from the
 * ungroup having failed -- and there is no way to select the other half, because selecting
 * one of them selects the group.
 */
export function ungroupNodes(nodes, ids) {
  const members = selectedComponents(nodes, ids)
  const groups = new Set(members.map((node) => node.data?.group).filter(Boolean))
  if (!groups.size) return nodes ?? []

  return (nodes ?? []).map((node) => {
    if (!groups.has(node.data?.group)) return node
    const data = { ...node.data }
    delete data.group
    return { ...node, data }
  })
}

/**
 * Every id that has to be selected along with `ids`, groups included.
 *
 * What makes a group a group: clicking one member selects all of them, so dragging one
 * drags all of them -- React Flow already moves a multi-selection together, so the whole
 * behaviour falls out of the selection rather than needing a second drag path.
 *
 * Returns the input when nothing is grouped, so the caller can skip the update entirely.
 * That matters: this runs on every selection change, and returning a fresh array each time
 * would re-render every node on the canvas for a click that changed nothing.
 */
export function withGroupMates(nodes, ids) {
  const wanted = new Set(ids ?? [])
  const groups = new Set(
    (nodes ?? [])
      .filter((node) => wanted.has(node.id) && node.data?.group)
      .map((node) => node.data.group),
  )
  if (!groups.size) return ids ?? []

  const out = new Set(wanted)
  for (const node of nodes ?? []) {
    if (node.data?.group && groups.has(node.data.group)) out.add(node.id)
  }
  return out.size === wanted.size ? (ids ?? []) : [...out]
}

/**
 * The extra select changes that keep a group selected or released as one whole.
 *
 * React Flow knows nothing about groups, so a change stream that selects one member has to
 * be extended to its mates -- and, the half that was missing, a stream that *deselects* one
 * member has to release them too. Without the second half, shift-clicking a group member off
 * left every other member selected and invisible to the user: the ring was gone from the card
 * they clicked, the count in the toolbar still said four, and the next drag moved three cards
 * they thought they had let go of.
 *
 * Returned as changes to append rather than applied here, because appending is what makes them
 * survive: a plain click arrives as deselect-everything followed by select-one, so anything
 * merged into the existing changes would be overwritten by the deselects it arrived with.
 *
 * Order within the result matters for the same reason. Deselects first, selects last, so the
 * click above ends with the clicked node's group selected rather than released -- the two
 * halves genuinely disagree about the same ids in that one stream, and the select is the half
 * that describes what the user just did.
 *
 * Returns an empty array when nothing is grouped, so the caller can forward the original
 * changes untouched -- this runs on every selection change, and a fresh array each time is a
 * new prop identity for every node on the canvas.
 */
export function groupSelectionChanges(nodes, changes) {
  const selecting = []
  const deselecting = []
  for (const change of changes ?? []) {
    if (change?.type !== 'select') continue
    ;(change.selected ? selecting : deselecting).push(change.id)
  }
  if (!selecting.length && !deselecting.length) return []

  /* Each half filters against *its own* ids only, and that asymmetry is the whole of the
     click case: the mates of the node being selected are usually also in the deselect list,
     because the click deselected everything on its way in. Filtering the selects against
     the deselects too would drop exactly the ids that have to be re-selected, which is how
     clicking a group member came to select only that member. */
  const chosen = new Set(selecting)
  const selectMates = withGroupMates(nodes, selecting).filter((id) => !chosen.has(id))

  const released = new Set(deselecting)
  const keep = new Set([...selectMates, ...selecting])
  const deselectMates = withGroupMates(nodes, deselecting).filter(
    (id) => !released.has(id) && !keep.has(id),
  )

  return [
    ...deselectMates.map((id) => ({ id, type: 'select', selected: false })),
    ...selectMates.map((id) => ({ id, type: 'select', selected: true })),
  ]
}
