/*
 * Dividers: one canvas holding several diagrams, told apart.
 *
 * The request behind this is "let a single canvas have a larger divider so the same zone can be
 * dropped into each divided section" -- someone comparing two architectures, or the same one before
 * and after, on one page. Two things had to change for that:
 *
 *   1. Something has to draw the division. That is a `frame` node: vertical, horizontal, or the
 *      cross that makes four sections at once.
 *   2. A zone could only be on the canvas once, because two zones sharing an id collide on save.
 *      See `instanceZoneId` below -- the copy gets its own id and remembers which product it is.
 *
 * ## Sections carry their contents
 *
 * A frame is not a set of guide lines. Moving or resizing one moves what is inside each section
 * with it, which is what makes it a *division of the canvas* rather than a drawing on top of one.
 * Two mechanisms, and neither of them is new:
 *
 *   - Whole-frame moves come free from React Flow parenting. A node dropped inside a frame becomes
 *     its child (`parentId`), exactly as a component becomes a zone's child, so dragging the frame
 *     drags everything. Nothing here implements that.
 *   - A divider drag, or a resize of the frame's outer edge, moves the contents of *each section* by
 *     the amount that section's own origin moved. That is `shiftSections` below, and it is the whole
 *     of the behaviour: one rule, applied per section.
 *
 * ## The splits are fractions
 *
 * `splitX`/`splitY` are 0..1 across the frame's own box rather than pixel offsets, so a frame
 * resized keeps its proportions and a section cannot end up outside the frame that owns it. The
 * *drag* is in pixels and the value stored is the fraction, which is the same trade `data.radius`
 * makes for a shape's corners.
 */

/* The three shapes a divider comes in. `cross` is both axes at once -- four sections -- which the
   request asked for by name ("a divider in the shape of a t"). */
export const FRAME_AXES = ['vertical', 'horizontal', 'cross']

/* How close to an edge a split may be dragged, as a fraction. A section narrower than this has no
   room for anything that would be put in it, and a split at 0 or 1 is a frame that looks broken. */
const MIN_SPLIT = 0.08

export const DEFAULT_SPLIT = 0.5

/** Does this axis divide across, down, or both? */
export const dividesX = (axis) => axis === 'vertical' || axis === 'cross'
export const dividesY = (axis) => axis === 'horizontal' || axis === 'cross'

/**
 * A frame's settings, with every default filled in.
 *
 * Tolerant like `normalizeTable` and for the same reason: a frame arrives out of a saved document
 * that another build may have written, and half of this file divides by these numbers.
 */
export function normalizeFrame(frame) {
  const axis = FRAME_AXES.includes(frame?.axis) ? frame.axis : 'vertical'
  return {
    axis,
    splitX: clampSplit(frame?.splitX),
    splitY: clampSplit(frame?.splitY),
    /* One per section, in section order, and sparse: a frame nobody has titled stores nothing. */
    labels: Array.isArray(frame?.labels) ? frame.labels.slice(0, 4) : [],
  }
}

function clampSplit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_SPLIT
  /* Rounded to three places: the drag produces a float per frame, and an unrounded one makes the
     stored document differ on every save. Three places is a quarter of a pixel on a 1000px frame. */
  return Math.round(Math.min(1 - MIN_SPLIT, Math.max(MIN_SPLIT, number)) * 1000) / 1000
}

/**
 * The boxes a frame is divided into, in reading order, relative to the frame's own top-left.
 *
 * One for a frame that divides on neither axis is impossible -- every axis divides on at least one
 * -- so this returns two or four. Reading order matters: it is the order labels are stored in, so
 * inserting a section type later would renumber every existing frame's titles.
 */
export function sectionsOf(frame, { width, height }) {
  const { axis, splitX, splitY } = normalizeFrame(frame)
  const left = dividesX(axis) ? Math.round(width * splitX) : width
  const top = dividesY(axis) ? Math.round(height * splitY) : height

  if (axis === 'vertical') {
    return [
      { x: 0, y: 0, width: left, height },
      { x: left, y: 0, width: width - left, height },
    ]
  }
  if (axis === 'horizontal') {
    return [
      { x: 0, y: 0, width, height: top },
      { x: 0, y: top, width, height: height - top },
    ]
  }
  return [
    { x: 0, y: 0, width: left, height: top },
    { x: left, y: 0, width: width - left, height: top },
    { x: 0, y: top, width: left, height: height - top },
    { x: left, y: top, width: width - left, height: height - top },
  ]
}

/**
 * Which section a point falls in, as an index into `sectionsOf`.
 *
 * A point exactly on a divider belongs to the section *after* it, which is the same rule a pixel
 * grid uses everywhere else -- and the reason it matters is that a node dropped precisely on the
 * line has to end up in one section rather than in neither.
 */
export function sectionAt(frame, box, point) {
  const sections = sectionsOf(frame, box)
  for (const [index, section] of sections.entries()) {
    const withinX = point.x >= section.x && point.x < section.x + section.width
    const withinY = point.y >= section.y && point.y < section.y + section.height
    if (withinX && withinY) return index
  }
  /* The far edges: a point on the frame's own right or bottom border is in the last section rather
     than nowhere, which is what a `<` on the upper bound would otherwise say. */
  const inside = point.x >= 0 && point.x <= box.width && point.y >= 0 && point.y <= box.height
  return inside ? sections.length - 1 : -1
}

/**
 * Every child of a frame, moved by the amount its own section's origin moved.
 *
 * This is "sections are frames" in one function, and it is called from the two gestures that change
 * where a section starts: dragging a divider, and resizing the frame's outer edge. Dragging the
 * frame *itself* is not here -- React Flow moves a parent's children for free.
 *
 * The rule is per section rather than per frame, and that is the whole of the design: dragging the
 * vertical divider 40px right moves the right-hand section's contents 40px right and leaves the
 * left-hand section's alone, because the left section's origin did not move. Resizing the frame's
 * right edge by 40px with a split at 50% moves them 20px, because that is where the section now
 * starts. Both fall out of the same subtraction.
 *
 * Positions are the children's own -- relative to the frame, since they are its children -- so this
 * needs no coordinate conversion and no knowledge of where the frame is.
 *
 * Returns the same array when nothing moves, matching the identity contract `growZones` and
 * `collapseGraph` keep: React Flow re-renders what it is handed.
 */
export function shiftSections(nodes, frameId, before, after) {
  const from = sectionsOf(before?.frame, before ?? {})
  const to = sectionsOf(after?.frame, after ?? {})
  if (from.length !== to.length) return nodes ?? []

  const deltas = from.map((section, index) => ({
    x: to[index].x - section.x,
    y: to[index].y - section.y,
  }))
  if (deltas.every((delta) => delta.x === 0 && delta.y === 0)) return nodes ?? []

  let changed = false
  const out = (nodes ?? []).map((node) => {
    if (node.parentId !== frameId) return node
    /* Which section it was in is decided by where it *was*, against the frame's old geometry --
       not where it will be. Deciding against the new geometry would move a node that the divider
       has just crossed by the wrong section's delta, so a node near the line would jump. */
    const index = sectionAt(before?.frame, before ?? {}, node.position ?? { x: 0, y: 0 })
    const delta = deltas[index]
    if (!delta || (delta.x === 0 && delta.y === 0)) return node
    changed = true
    return {
      ...node,
      position: {
        x: Math.round((node.position?.x ?? 0) + delta.x),
        y: Math.round((node.position?.y ?? 0) + delta.y),
      },
    }
  })
  return changed ? out : (nodes ?? [])
}

/**
 * Where a divider drag should put a split, as a fraction.
 *
 * The pointer's offset within the frame over the frame's size, clamped. Separate from the component
 * that does the dragging so the arithmetic is testable, and because getting the clamp wrong is
 * invisible until someone drags a divider off the end of its own frame.
 */
export function splitFromPointer(offset, size) {
  if (!(size > 0)) return DEFAULT_SPLIT
  return clampSplit(offset / size)
}

/* --- the same zone, more than once -------------------------------------------- */

/*
 * A zone appearing twice.
 *
 * Two zones with one id collide on save -- `zones` is keyed by id in the document and a component
 * stores one `zone` string -- which is why dropping Connections a second time used to be refused
 * outright. So the second copy gets an id of its own, and remembers which product it is a copy of.
 *
 * The suffix is `~2`, and the tilde is chosen for what it is *not*: `:` is already the separator in
 * `manual:source:ab12` and `custom:zone:ab12`, and `-` appears inside `zone-` node ids and in
 * product ids like `profile_sources`. A character used nowhere else means `zoneOfParent` and every
 * id comparison keep working unchanged.
 */
const INSTANCE = '~'

/** `('connections', 2)` -> `'connections~2'`. The first instance keeps the bare id. */
export function instanceZoneId(product, instance) {
  return instance <= 1 ? product : `${product}${INSTANCE}${instance}`
}

/** `'connections~2'` -> `'connections'`, and `'connections'` -> `'connections'`. */
export function zoneProductOf(zoneId) {
  const at = String(zoneId ?? '').lastIndexOf(INSTANCE)
  return at > 0 ? String(zoneId).slice(0, at) : (zoneId ?? null)
}

/** Which copy this is: 1 for the original, 2 for the first duplicate. */
export function zoneInstanceOf(zoneId) {
  const at = String(zoneId ?? '').lastIndexOf(INSTANCE)
  if (at <= 0) return 1
  const number = Number(String(zoneId).slice(at + INSTANCE.length))
  return Number.isInteger(number) && number > 1 ? number : 1
}

/**
 * A free id for another copy of `product`, given the ids already on the canvas.
 *
 * Counts upward from the highest instance in use rather than from the number of copies, so deleting
 * the second of three and adding another does not produce a duplicate id.
 */
export function nextZoneInstance(product, existingIds) {
  let highest = 0
  for (const id of existingIds ?? []) {
    if (zoneProductOf(id) !== product) continue
    highest = Math.max(highest, zoneInstanceOf(id))
  }
  return instanceZoneId(product, highest + 1)
}

/**
 * What to call a copy, given the original's label.
 *
 * Numbered rather than "copy of", because these are peers: someone comparing two Connections
 * pipelines has two of them, not an original and a duplicate.
 */
export function instanceLabel(label, zoneId) {
  const instance = zoneInstanceOf(zoneId)
  if (instance <= 1) return label
  return `${label} (${instance})`
}
