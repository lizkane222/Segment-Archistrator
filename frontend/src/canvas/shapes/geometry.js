/*
 * The plain shapes: a square, a cylinder, a database, a chevron, and so on.
 *
 * Every one is a function from a box to an SVG path, in a `0 0 100 100` viewBox with
 * `preserveAspectRatio="none"` -- so a shape stretches with the node it is drawn in and there is no
 * second opinion anywhere about how big it is. The node's size is the node's size.
 *
 * ## Why paths and not CSS
 *
 * A rounded rectangle is a `border-radius` and this could have been a table of class names. A
 * cylinder, a document with a torn edge, a hexagon and a five-pointed star are not, and having two
 * mechanisms -- some shapes as CSS, some as SVG -- means every feature after this one (fill, stroke,
 * the corner-rounding drag, hit testing) has to be written twice and kept in agreement. One
 * mechanism, and the rounded rectangle is a path with arcs in it.
 *
 * ## Corner rounding is a parameter, not a variant
 *
 * The request asked for "a drag-corner-dot control to round any shape's corners", so `radius` is an
 * argument to every builder rather than a separate `rounded-square` entry beside `square`. Shapes
 * with no corners ignore it; shapes with corners interpolate. That is what lets one drag handle work
 * on everything instead of only on the four shapes somebody remembered to make variants of.
 *
 * `radius` is 0..1 -- a *fraction* of the shape's smaller half-dimension, not a pixel count. A pixel
 * radius looks completely different on a 90px chip and a 340px card, and would have to be re-dragged
 * every time the node was resized.
 */

/* The coordinate space every builder works in. Chosen as 100 rather than 1 so the paths are readable
   when debugging -- `M 0 50` rather than `M 0 0.5` -- and rounded to two places on output, which at
   this scale is well below a pixel on screen. */
export const VIEW = 100

/* How much of the shape a fully-dragged corner rounds. Not 50 (a full semicircle), because at that
   value a square becomes a circle and the user has lost the shape they picked -- the handle would
   change *which shape it is* rather than round its corners. 30 is visibly very round and still
   recognisably the shape it started as. */
const MAX_RADIUS = 30

const n = (value) => Math.round(value * 100) / 100

/** `radius` (0..1) as a coordinate in the viewBox, clamped so two corners cannot overlap. */
function corner(radius, limit = MAX_RADIUS) {
  const wanted = Math.min(1, Math.max(0, Number(radius) || 0)) * MAX_RADIUS
  return n(Math.min(wanted, limit))
}

/**
 * A closed polygon through `points`, with each vertex rounded by `radius`.
 *
 * The workhorse: most of the shapes below are a point list, and rounding is the same problem at every
 * vertex regardless of how many there are or what angle they meet at. Written once here rather than
 * per shape, so "round the corners" means the same thing on a triangle and on an octagon.
 *
 * The arc is a quadratic with the vertex as its control point, which is a true circular fillet for a
 * right angle and degrades gracefully for any other -- the same approach `roundedPolyline` takes for
 * an orthogonal connector, and for the same reason.
 */
export function polygon(points, radius = 0) {
  if (points.length < 3) return ''
  const r = corner(radius)
  if (r < 0.5) {
    return `M ${points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L ')} Z`
  }

  const towards = (from, to, distance) => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const length = Math.hypot(dx, dy) || 1
    /* Never more than half the leg, or two adjacent fillets eat each other and the path visibly
       loops -- the same clamp, for the same reason, as the connector's corners. */
    const step = Math.min(distance, length / 2)
    return [from[0] + (dx / length) * step, from[1] + (dy / length) * step]
  }

  let path = ''
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const vertex = points[index]
    const next = points[(index + 1) % points.length]
    const start = towards(vertex, previous, r)
    const end = towards(vertex, next, r)
    path += index === 0 ? `M ${n(start[0])} ${n(start[1])}` : ` L ${n(start[0])} ${n(start[1])}`
    path += ` Q ${n(vertex[0])} ${n(vertex[1])} ${n(end[0])} ${n(end[1])}`
  }
  return `${path} Z`
}

/* An ellipse filling the box, as two arcs. Ignores `radius`: it has no corners, and pretending
   otherwise would make the drag handle do nothing on a circle with no explanation. */
function ellipse() {
  const r = VIEW / 2
  return `M 0 ${r} A ${r} ${r} 0 0 1 ${VIEW} ${r} A ${r} ${r} 0 0 1 0 ${r} Z`
}

/*
 * The catalogue.
 *
 * `build(radius)` returns the path. `rounds` says whether the corner handle does anything, so the UI
 * can hide a control that would be inert rather than offering one that silently does nothing.
 * `aspect` is a hint for the palette's preview and the default drop size -- a swimlane wants to
 * arrive wide, a cylinder tall-ish.
 */
export const SHAPES = [
  { id: 'rectangle', name: 'Rectangle', rounds: true, aspect: 1.6, build: (r) => polygon([[0, 0], [VIEW, 0], [VIEW, VIEW], [0, VIEW]], r) },
  { id: 'square', name: 'Square', rounds: true, aspect: 1, build: (r) => polygon([[0, 0], [VIEW, 0], [VIEW, VIEW], [0, VIEW]], r) },
  { id: 'circle', name: 'Circle', rounds: false, aspect: 1, build: ellipse },
  { id: 'ellipse', name: 'Ellipse', rounds: false, aspect: 1.6, build: ellipse },

  {
    id: 'triangle',
    name: 'Triangle',
    rounds: true,
    aspect: 1,
    build: (r) => polygon([[VIEW / 2, 0], [VIEW, VIEW], [0, VIEW]], r),
  },
  {
    id: 'right-triangle',
    name: 'Right triangle',
    rounds: true,
    aspect: 1,
    build: (r) => polygon([[0, 0], [0, VIEW], [VIEW, VIEW]], r),
  },
  {
    id: 'diamond',
    name: 'Diamond',
    rounds: true,
    aspect: 1,
    /* A decision, not a diamond: this is what a flowchart uses for a branch, and it is the shape a
       reader of a Segment diagram will read as "a filter chose here". */
    build: (r) => polygon([[VIEW / 2, 0], [VIEW, VIEW / 2], [VIEW / 2, VIEW], [0, VIEW / 2]], r),
  },
  {
    id: 'pentagon',
    name: 'Pentagon',
    rounds: true,
    aspect: 1,
    build: (r) => polygon(regular(5, -90), r),
  },
  { id: 'hexagon', name: 'Hexagon', rounds: true, aspect: 1, build: (r) => polygon(regular(6, 0), r) },
  { id: 'octagon', name: 'Octagon', rounds: true, aspect: 1, build: (r) => polygon(regular(8, 22.5), r) },
  {
    id: 'star',
    name: 'Star',
    rounds: true,
    aspect: 1,
    build: (r) => polygon(star(5, 0.45), r),
  },

  {
    id: 'chevron',
    name: 'Chevron',
    rounds: true,
    aspect: 1.8,
    /* Points right, because these diagrams are read left to right and a chevron is how a stage in a
       sequence is drawn. */
    build: (r) =>
      polygon(
        [[0, 0], [72, 0], [VIEW, VIEW / 2], [72, VIEW], [0, VIEW], [28, VIEW / 2]],
        r,
      ),
  },
  {
    id: 'arrow',
    name: 'Arrow',
    rounds: true,
    aspect: 1.8,
    build: (r) =>
      polygon(
        [[0, 30], [65, 30], [65, 0], [VIEW, VIEW / 2], [65, VIEW], [65, 70], [0, 70]],
        r,
      ),
  },

  {
    id: 'cylinder',
    name: 'Cylinder',
    rounds: false,
    aspect: 0.85,
    /* The classic "a store of something" shape. Its curvature is fixed rather than driven by
       `radius`: the ellipse depth is what makes it read as a cylinder rather than a rectangle, so it
       is the shape's identity and not a parameter. */
    build: () => cylinder(18),
  },
  {
    id: 'database',
    name: 'Database',
    rounds: false,
    aspect: 0.85,
    /* A cylinder with its internal division lines, which is how a database is drawn as distinct from
       a generic store. Three bands, because two reads as a mistake and four is a stack. */
    build: () => `${cylinder(14)} ${bands(14, 2)}`,
  },
  {
    id: 'document',
    name: 'Document',
    rounds: false,
    aspect: 0.8,
    /* The torn bottom edge, as one wave. Two waves is a "documents" plural and is its own entry. */
    build: () =>
      `M 0 0 L ${VIEW} 0 L ${VIEW} 86 C 75 100 60 72 50 86 C 40 100 25 72 0 86 Z`,
  },
  {
    id: 'documents',
    name: 'Documents',
    rounds: false,
    aspect: 0.8,
    /* Offset copies behind the front one. Drawn back to front so the front sheet's fill covers the
       ones behind it rather than the reverse. */
    build: () =>
      `M 12 0 L ${VIEW} 0 L ${VIEW} 76 L 88 76 L 88 12 L 12 12 Z ` +
      `M 6 6 L 94 6 L 94 82 L 82 82 L 82 18 L 6 18 Z ` +
      `M 0 12 L 88 12 L 88 86 C 66 100 52 74 44 86 C 35 100 22 74 0 86 Z`,
  },
  {
    id: 'cloud',
    name: 'Cloud',
    rounds: false,
    aspect: 1.5,
    build: () =>
      'M 25 82 C 10 82 0 70 0 58 C 0 46 9 36 21 34 C 24 18 38 6 55 6 ' +
      'C 73 6 88 19 90 36 C 96 40 100 48 100 56 C 100 70 89 82 75 82 Z',
  },
  {
    id: 'flag',
    name: 'Flag',
    rounds: false,
    aspect: 1.2,
    build: () => 'M 0 0 L 0 100 M 0 0 L 78 0 L 62 22 L 78 44 L 0 44',
  },
  {
    id: 'callout',
    name: 'Callout',
    rounds: true,
    aspect: 1.4,
    /* A speech bubble, for annotating a diagram. The tail is part of the outline rather than a
       separate triangle, so a fill covers both and there is no seam where they meet. */
    build: (r) => {
      const c = corner(r, 24)
      return (
        `M ${c} 0 L ${VIEW - c} 0 Q ${VIEW} 0 ${VIEW} ${c} ` +
        `L ${VIEW} ${72 - c} Q ${VIEW} 72 ${VIEW - c} 72 ` +
        `L 42 72 L 26 100 L 24 72 L ${c} 72 Q 0 72 0 ${72 - c} ` +
        `L 0 ${c} Q 0 0 ${c} 0 Z`
      )
    },
  },
  {
    id: 'swimlane',
    name: 'Swimlane',
    rounds: true,
    aspect: 3.2,
    /* A header band and a body. Wide by default, because a lane that arrives square has to be
       resized before it is a lane. */
    build: (r) =>
      `${polygon([[0, 0], [VIEW, 0], [VIEW, VIEW], [0, VIEW]], r)} M 0 22 L ${VIEW} 22`,
  },
  {
    id: 'table',
    name: 'Table',
    rounds: true,
    aspect: 1.4,
    /* A header row and three body rows, as a grid. Not the SQL Table component -- that one holds real
       data from a CSV; this is a drawing of a table. */
    build: (r) =>
      `${polygon([[0, 0], [VIEW, 0], [VIEW, VIEW], [0, VIEW]], r)} ` +
      `M 0 25 L ${VIEW} 25 M 0 50 L ${VIEW} 50 M 0 75 L ${VIEW} 75 M 50 0 L 50 ${VIEW}`,
  },

  /* The small marks. Strokes rather than fills, so they read as annotations over a diagram rather
     than as components in it -- and so the node's border colour is what draws them. */
  { id: 'check', name: 'Checkmark', rounds: false, aspect: 1, build: () => 'M 12 55 L 38 80 L 88 20' },
  { id: 'cross', name: 'Cross', rounds: false, aspect: 1, build: () => 'M 18 18 L 82 82 M 82 18 L 18 82' },
  { id: 'plus', name: 'Plus', rounds: false, aspect: 1, build: () => 'M 50 14 L 50 86 M 14 50 L 86 50' },
  {
    id: 'hazard',
    name: 'Hazard',
    rounds: true,
    aspect: 1,
    build: (r) => `${polygon([[50, 4], [96, 92], [4, 92]], r)} M 50 36 L 50 64 M 50 76 L 50 80`,
  },
  {
    id: 'prohibited',
    name: 'Prohibited',
    rounds: false,
    aspect: 1,
    build: () => `${ellipse()} M 22 78 L 78 22`,
  },
  {
    id: 'link',
    name: 'Link',
    rounds: false,
    aspect: 1.4,
    build: () =>
      'M 42 30 L 30 30 A 22 22 0 0 0 30 74 L 42 74 M 58 30 L 70 30 A 22 22 0 0 1 70 74 L 58 74 M 34 52 L 66 52',
  },
  {
    id: 'envelope',
    name: 'Envelope',
    rounds: true,
    aspect: 1.5,
    build: (r) =>
      `${polygon([[0, 12], [VIEW, 12], [VIEW, 88], [0, 88]], r)} M 0 12 L 50 55 L ${VIEW} 12`,
  },
  {
    id: 'envelope-open',
    name: 'Envelope, open',
    rounds: true,
    aspect: 1.5,
    build: (r) =>
      `${polygon([[0, 40], [50, 6], [VIEW, 40], [VIEW, 92], [0, 92]], r)} M 0 40 L 50 74 L ${VIEW} 40`,
  },
]

const BY_ID = new Map(SHAPES.map((shape) => [shape.id, shape]))

export function shapeById(id) {
  return BY_ID.get(id) ?? null
}

/**
 * The path for one shape at one corner radius, or `null` for a shape that does not exist.
 *
 * Null rather than a fallback square: a node naming a shape this build does not have is a document
 * from a newer version, and drawing a square would silently misrepresent it. The renderer draws the
 * node's plain card instead, which is honest about not knowing.
 */
export function shapePath(id, radius = 0) {
  const shape = BY_ID.get(id)
  if (!shape) return null
  return shape.build(shape.rounds ? radius : 0)
}

/* --- point helpers ---------------------------------------------------------- */

/* A regular n-gon inscribed in the box. `rotation` in degrees, so each shape can be turned to the
   orientation a reader expects -- a hexagon flat-topped, a pentagon point-up. */
function regular(sides, rotation) {
  const r = VIEW / 2
  const points = []
  for (let index = 0; index < sides; index += 1) {
    const angle = ((index / sides) * 360 + rotation) * (Math.PI / 180)
    points.push([n(r + r * Math.cos(angle)), n(r + r * Math.sin(angle))])
  }
  return points
}

/* An n-pointed star. `inner` is the valley radius as a fraction of the outer -- 0.45 is the
   proportion a five-pointed star is conventionally drawn at; much lower reads as a starburst. */
function star(points, inner) {
  const r = VIEW / 2
  const out = []
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? r : r * inner
    const angle = ((index / (points * 2)) * 360 - 90) * (Math.PI / 180)
    out.push([n(r + radius * Math.cos(angle)), n(r + radius * Math.sin(angle))])
  }
  return out
}

/* A cylinder's outline: an ellipse on top, straight sides, and the front half of an ellipse at the
   bottom. `depth` is the ellipse's vertical radius. */
function cylinder(depth) {
  const bottom = VIEW - depth
  return (
    `M 0 ${depth} A 50 ${depth} 0 0 1 ${VIEW} ${depth} ` +
    `L ${VIEW} ${bottom} A 50 ${depth} 0 0 1 0 ${bottom} Z ` +
    `M 0 ${depth} A 50 ${depth} 0 0 0 ${VIEW} ${depth}`
  )
}

/* The internal division arcs that make a cylinder read as a database. */
function bands(depth, count) {
  const span = VIEW - depth * 2
  let path = ''
  for (let index = 1; index <= count; index += 1) {
    const y = depth + (span / (count + 1)) * index
    path += ` M 0 ${n(y)} A 50 ${depth} 0 0 0 ${VIEW} ${n(y)}`
  }
  return path.trim()
}
