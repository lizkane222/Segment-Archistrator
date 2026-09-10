/*
 * One converted Lucid shape, drawn.
 *
 * Its own file because two very different callers need it and must agree: the palette tile and the
 * node on the canvas. If they drew it differently, the thing you dragged would not be the thing you
 * dropped.
 *
 * `viewBox="0 0 1 1"` with `preserveAspectRatio="none"`: the converter leaves path coordinates
 * normalised to 0..1, so the SVG stretches to whatever box it is given and the node's size is the
 * only thing deciding how big the shape is. That is the single most useful property of the source
 * format and the reason no scaling arithmetic appears anywhere here.
 *
 * A path whose fill the export left as "prop" -- inherit from the block -- comes through as `null`,
 * and is drawn in `currentColor`. So an icon with no colours of its own takes the component's, and a
 * Twilio red one keeps its red. That is the behaviour worth having: the branded icons should look
 * branded, and the line-art ones should follow the card they are on.
 */

import { memo } from 'react'

import LUCID from './lucid.json'

const BY_ID = new Map(LUCID.map((shape) => [shape.id, shape]))

export function lucidShape(id) {
  return BY_ID.get(id) ?? null
}

export const LucidArt = memo(function LucidArt({ id, className, style }) {
  const shape = BY_ID.get(id)
  /* Null rather than a placeholder box. A node naming a shape this build does not have is a document
     from a newer export, and drawing a stand-in would misrepresent it -- the node's own card is what
     shows instead, which is honest about not knowing. */
  if (!shape) return null

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className={className}
      style={style}
      aria-label={shape.name}
      role="img"
    >
      {shape.paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill={path.fill ?? 'currentColor'}
          stroke={path.stroke ?? 'none'}
          /* Non-scaling, because the viewBox is 1x1 and a stroke width in those units would be
             hundreds of pixels wide once stretched to a card. */
          vectorEffect="non-scaling-stroke"
          strokeWidth={path.strokeWidth ?? undefined}
        />
      ))}
    </svg>
  )
})
