/*
 * Where a connector's text sits, and how it is set.
 *
 * Stored on the edge as plain fields so they travel with the document like every other connector fact:
 *   labelT       0..1, how far along the route the text is anchored (absent = halfway)
 *   labelOffset  {x, y} flow-space nudge from that point on the line -- what dragging off the line writes
 *   labelSide    'on' | 'above' | 'below' | 'left' | 'right' -- which side of the anchor the text box
 *                sits on (absent = 'on', centred over the line)
 *   labelWrap    true to wrap long text at LABEL_WRAP_WIDTH instead of keeping it on one line
 *   labelAlign   'left' | 'center' | 'right' (absent = center)
 *   labelColor   absent = the connector's own line colour
 *
 * Pure, so the geometry is tested rather than dragged around.
 */

import { pointAlong } from './routing.js'

export const LABEL_SIDES = ['on', 'above', 'below', 'left', 'right']
export const LABEL_ALIGNS = ['left', 'center', 'right']
export const DEFAULT_LABEL_T = 0.5
export const LABEL_WRAP_WIDTH = 160
/* How close to the line a dragged label snaps back onto it, in flow pixels. */
export const SNAP_ON_LINE = 8
/* Gap between the line and a label that sits beside it. */
export const SIDE_GAP = 6

/* The CSS translate that pins the right edge of the box to the anchor, by side. */
const ANCHOR = {
  on: { x: '-50%', y: '-50%', dx: 0, dy: 0 },
  above: { x: '-50%', y: '-100%', dx: 0, dy: -SIDE_GAP },
  below: { x: '-50%', y: '0%', dx: 0, dy: SIDE_GAP },
  left: { x: '-100%', y: '-50%', dx: -SIDE_GAP, dy: 0 },
  right: { x: '0%', y: '-50%', dx: SIDE_GAP, dy: 0 },
}

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : DEFAULT_LABEL_T))

/** Where the label's anchor is and how the box hangs from it. */
export function placeLabel(points, data = {}, override = null) {
  const t = clamp01(override?.t ?? data.labelT ?? DEFAULT_LABEL_T)
  const offset = override?.offset ?? data.labelOffset ?? { x: 0, y: 0 }
  const side = LABEL_SIDES.includes(override?.side ?? data.labelSide) ? (override?.side ?? data.labelSide) : 'on'
  const on = pointAlong(points, t)
  const anchor = ANCHOR[side]
  return {
    x: on.x + (offset.x ?? 0) + anchor.dx,
    y: on.y + (offset.y ?? 0) + anchor.dy,
    translate: `translate(${anchor.x}, ${anchor.y})`,
    t,
    side,
  }
}

/** The closest point on the route to `point`: `{t, point, distance}`, `t` being the share of its length. */
export function nearestOnRoute(points, point) {
  const list = points ?? []
  if (list.length < 2) return { t: DEFAULT_LABEL_T, point: list[0] ?? point, distance: 0 }
  let total = 0
  const lengths = []
  for (let i = 1; i < list.length; i += 1) {
    const length = Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y)
    lengths.push(length)
    total += length
  }
  if (total === 0) return { t: DEFAULT_LABEL_T, point: list[0], distance: Math.hypot(point.x - list[0].x, point.y - list[0].y) }

  let best = null
  let travelled = 0
  for (let i = 0; i < lengths.length; i += 1) {
    const a = list[i]
    const b = list[i + 1]
    const length = lengths[i]
    const along = length ? Math.min(1, Math.max(0, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length))) : 0
    const on = { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along }
    const distance = Math.hypot(point.x - on.x, point.y - on.y)
    if (!best || distance < best.distance) best = { t: (travelled + along * length) / total, point: on, distance }
    travelled += length
  }
  return best
}

/**
 * What dragging the label to `pointer` writes: the nearest spot on the line, plus however far the
 * pointer is from it -- or nothing off the line at all when it is within SNAP_ON_LINE, so a label
 * dragged "onto" its connector sits exactly on it.
 */
export function dragLabelTo(points, pointer) {
  const { t, point, distance } = nearestOnRoute(points, pointer)
  const offset =
    distance <= SNAP_ON_LINE
      ? { x: 0, y: 0 }
      : { x: Math.round(pointer.x - point.x), y: Math.round(pointer.y - point.y) }
  return { t: Math.round(t * 1000) / 1000, offset, side: 'on' }
}

/** The edge-data patch for a placement; defaults are written as `undefined` so nothing stray is stored. */
export function placementPatch({ t, offset, side }) {
  return {
    labelT: t === undefined || Math.abs(t - DEFAULT_LABEL_T) < 0.0005 ? undefined : t,
    labelOffset: offset && (offset.x || offset.y) ? offset : undefined,
    labelSide: side && side !== 'on' ? side : undefined,
  }
}
