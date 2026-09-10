/*
 * Where an anchor note sits when all of them are showing at once.
 *
 * A note used to be drawn as a tooltip directly above its component (NodeToolbar,
 * Position.Top). That is right for one at a time and wrong for all of them: the card is
 * wider than the component and taller than the row gap, so with the mode switched on
 * every note covers the components above and either side of the one it describes. The
 * mode meant for reading the architecture as a document was the mode that hid it.
 *
 * So the notes leave the drawing entirely. They stack in a gutter outside the outermost
 * zone -- one column each side, so a wide architecture does not get one column twice its
 * own height -- and a leader line drawn only while one end is hovered says which note
 * belongs to which component. That is a LucidChart callout, which is the thing these
 * diagrams are replacing.
 *
 * This module is geometry and nothing else: node array in, rectangles out. It never reads
 * the note text, and a note has a fixed size, which is what lets the stacking be decided
 * without measuring the DOM -- and therefore what lets it be tested, since this project
 * has no jsdom. The renderer pays for that with a clamp: a note shows two lines of each
 * paragraph and expands over its neighbours while hovered.
 */

import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import { absolutePositions } from './rules.js'
import { diagramBounds } from '../diagram/exportImage.js'

export const NOTE_WIDTH = 260
export const NOTE_HEIGHT = 128

/* Enough that two notes read as two, at the zoom a whole architecture is read at. */
export const NOTE_GAP = 12

/* How far outside the drawing the column sits. Wide enough that the leader line is
   visibly a leader line rather than a border, and that a component dragged just outside
   its zone does not land on top of its own note. */
export const GUTTER_OFFSET = 80

const SIDES = ['left', 'right']

/**
 * One note rectangle per component on the canvas.
 *
 * Returns `[{id, side, x, y, width, height, line}]` in flow coordinates, where `line` is
 * the leader from the note's inner edge to the component's near edge. Empty when there is
 * nothing to annotate.
 *
 * Which side a note goes to is decided by the component's own centre against the
 * diagram's midline, so a note is on the same side as the thing it describes and the
 * leader never crosses the drawing.
 *
 * Within a column a note wants to be vertically centred on its component, and gives that
 * up in one direction only: it is pushed *down* past a note already placed, never up.
 * Both directions would need a second pass and would move notes that were already right;
 * pushing one way keeps the column in the same order as the components it describes,
 * which is the property that makes the stack readable when the leader lines are not
 * showing.
 */
export function layoutAnchorNotes(nodes, options = {}) {
  const {
    width = NOTE_WIDTH,
    height = NOTE_HEIGHT,
    gap = NOTE_GAP,
    offset = GUTTER_OFFSET,
  } = options

  const all = nodes ?? []
  /* The union of every node, zones included, so "outside the drawing" means outside the
     Segment container and not merely outside the right-most component. Borrowed from the
     export rather than reimplemented: cropping an export and placing a gutter are the
     same question asked twice, and the two answers drifting apart would put notes over
     the diagram in exactly the case the fourth copy of this walk got wrong. */
  const bounds = diagramBounds(all)
  if (!bounds) return []

  const positions = absolutePositions(all)
  const midX = bounds.x + bounds.width / 2

  /* Components only. A zone is annotated by the notes of what is in it, and a groupStack
     stands for many components whose notes are not being shown at all -- collapsing a
     group is a request for less on screen, so producing forty notes for it would undo
     the thing the user just asked for. */
  const boxes = all
    .filter((node) => node.type === 'segmentNode')
    .map((node) => {
      const { x, y } = positions.get(node.id) ?? { x: 0, y: 0 }
      const w = node.measured?.width ?? node.width ?? NODE_WIDTH
      const h = node.measured?.height ?? node.height ?? NODE_HEIGHT
      return { id: node.id, x, y, right: x + w, centreX: x + w / 2, centreY: y + h / 2 }
    })

  const notes = []
  for (const side of SIDES) {
    const column = boxes
      .filter((box) => (box.centreX < midX ? 'left' : 'right') === side)
      /* Ties broken by id, so the column does not reorder itself between renders on two
         components that happen to sit level with each other. */
      .sort((a, b) => a.centreY - b.centreY || (a.id < b.id ? -1 : 1))

    const x = Math.round(
      side === 'left' ? bounds.x - offset - width : bounds.x + bounds.width + offset,
    )

    let floor = -Infinity
    for (const box of column) {
      const y = Math.round(Math.max(box.centreY - height / 2, floor))
      floor = y + height + gap

      notes.push({
        id: box.id,
        side,
        x,
        y,
        width,
        height,
        line: {
          x1: side === 'left' ? x + width : x,
          y1: y + Math.round(height / 2),
          x2: Math.round(side === 'left' ? box.x : box.right),
          y2: Math.round(box.centreY),
        },
      })
    }
  }

  return notes
}

/**
 * The drawing plus its notes, as one rectangle.
 *
 * Switching the notes on is otherwise a control that appears to do nothing: the gutter sits
 * a note's width outside the diagram, so at any zoom that fitted the diagram the notes are
 * off both edges of the screen. This is what the viewport is fitted to instead.
 *
 * Null when there is nothing on the canvas at all, and the diagram's own bounds when there
 * is nothing to annotate -- so the caller has one thing to check rather than three.
 */
export function annotatedBounds(nodes, options = {}) {
  const bounds = diagramBounds(nodes ?? [])
  if (!bounds) return null

  const notes = layoutAnchorNotes(nodes, options)
  if (!notes.length) return bounds

  let minX = bounds.x
  let minY = bounds.y
  let maxX = bounds.x + bounds.width
  let maxY = bounds.y + bounds.height

  for (const note of notes) {
    minX = Math.min(minX, note.x)
    minY = Math.min(minY, note.y)
    maxX = Math.max(maxX, note.x + note.width)
    maxY = Math.max(maxY, note.y + note.height)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
