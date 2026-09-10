/*
 * Colour palettes, and the arithmetic that turns one colour into a node's style.
 *
 * The 34 schemes are the ones listed at gridfiti.com/google-calendar-color-schemes,
 * transcribed verbatim -- five hexes each, in the order the page gives them. They are
 * data and nothing here reads meaning into them, so adding one is a new entry in
 * PALETTES and nothing else.
 *
 * A palette is five colours and the canvas has twenty component kinds, so applying one
 * cannot mean "a colour per kind". It means a colour per *family* -- the groups the
 * default colours in kinds.js already collapse those kinds into -- which is the same
 * distinction a reader is using when they say "the blue things are sources".
 *
 * Two things a palette deliberately does not touch:
 *
 *   - Shape. It is the axis that survives recolouring, and it is the only thing left
 *     distinguishing a source function from a source once both are the same family
 *     colour. A palette that flattened shapes too would make a themed canvas
 *     unreadable rather than just differently coloured.
 *   - A custom component. It stands for something the customer runs themselves and its
 *     grey says "not Segment"; giving it one of Segment's five family colours would
 *     say the opposite. It can still be recoloured one node at a time.
 *
 * Nothing here is stored as a document field. Applying a palette writes each node's
 * own `data.style`, which already round-trips, and a `graph.palette` alongside that
 * would be a second source of truth that goes stale the first time anyone recolours
 * one node by hand. So a palette is an action, not a setting, and the UI offers no
 * "current theme" -- because after any per-node edit there would not honestly be one.
 */

/* Label text is one of these, never a palette colour. The dark one is the canvas's own
   navy rather than black, so a themed node's text still matches the unthemed UI around
   it -- and BLACK is the last resort for the handful of mid-luminance fills where
   neither navy nor white clears AA. See `readableText`. */
const INK = '#121c2d'
const PAPER = '#ffffff'
const BLACK = '#000000'

/* WCAG AA for body text. A node label is 13px semibold, which is not "large text" by
   the standard's definition, so the large-text 3:1 allowance does not apply. */
const MIN_TEXT_CONTRAST = 4.5

/* How far a border is pushed away from its fill, and the luminance below which it is
   pushed towards white instead of towards navy.
 *
 * Both were picked by measuring the worst case across all 170 colours rather than by
 * eye: this pair is what maximises the weakest border-against-fill contrast, which
 * lands at 1.9:1 on the mid-saturation fills. Without the flip, Black and Ocean get
 * borders darker than an already near-black fill -- which is to say no border at all --
 * and with the flip set any higher, saturated oranges and pinks lighten when they
 * should darken and come out weaker still. */
const BORDER_SHIFT = 0.45
const DARK_FILL = 0.18

export const PALETTES = [
  { key: 'pastel', name: 'Pastel', colors: ['#BEDAE3', '#C4E9DA', '#FED5CF', '#F1B598', '#D3C7E6'] },
  { key: 'cotton-candy', name: 'Cotton Candy', colors: ['#E8ADB6', '#CBADCC', '#F9D9E1', '#C9D6E5', '#A0ACC6'] },
  { key: 'tropical-pastel', name: 'Tropical Pastel', colors: ['#F75A3B', '#3F4EB5', '#F9D3D2', '#8AC7AD', '#FFD370'] },
  { key: 'lofi', name: 'Lofi', colors: ['#674AB3', '#A348A6', '#9F63C4', '#9075D8', '#CEA2D7'] },
  { key: 'fairy-tale', name: 'Fairy Tale', colors: ['#FFFBF2', '#FFE7E7', '#DDD7E5', '#B9CBE1', '#ADB8D6'] },
  { key: 'peach', name: 'Peach', colors: ['#E3826F', '#E4A9A4', '#EFBA97', '#F1CCBB', '#E7D5C7'] },
  { key: 'bright', name: 'Bright', colors: ['#D9E0F3', '#F6E4D7', '#F9E3A7', '#F4B882', '#EE825A'] },
  { key: 'bubblegum-mint', name: 'Bubblegum & Mint', colors: ['#F2A2BD', '#FED3DD', '#F0F9F8', '#C6E6E3', '#82BFB7'] },
  { key: 'purple-pastel', name: 'Purple Pastel', colors: ['#CFC1D8', '#DED1DB', '#C3D3E0', '#F1EEFF', '#FFF6ED'] },
  { key: 'ocean', name: 'Ocean', colors: ['#18363E', '#5F97AA', '#2D5F6E', '#3E88A5', '#93C4D1'] },
  { key: 'kawaii-pastel', name: 'Kawaii Pastel', colors: ['#BEFCFF', '#DEFFFA', '#FFDAF5', '#B0E1FF', '#E6C6FF'] },
  { key: 'sunset-cloud', name: 'Sunset Cloud', colors: ['#F08D7E', '#EFA18A', '#E2BAB1', '#DDA6B9', '#ACAEC5'] },
  { key: 'cottagecore', name: 'Cottagecore', colors: ['#596854', '#7F803E', '#CC9A52', '#AD794B', '#FCE4B4'] },
  { key: 'muted-pastel', name: 'Muted Pastel', colors: ['#DCAEB1', '#E3BEAB', '#F8EDD1', '#CED5B3', '#A0BAB9'] },
  { key: 'y2k-iridescent', name: 'Y2K Iridescent', colors: ['#E1ECF0', '#BADDE3', '#C5CFE8', '#ECD2D1', '#D0E7CA'] },
  { key: '90s', name: '90s', colors: ['#842D78', '#174DB1', '#297EA1', '#E5A836', '#B2336C'] },
  { key: '80s', name: '80s', colors: ['#FF68A8', '#64CFF7', '#F7E752', '#CA7CD8', '#3968CB'] },
  { key: 'retro-beach', name: 'Retro Beach', colors: ['#E86F44', '#EEAB43', '#F8ECBC', '#A2D1B1', '#5CB7A5'] },
  { key: 'summer', name: 'Summer', colors: ['#C6808C', '#6D5B87', '#44364B', '#EC745C', '#F5AD8C'] },
  { key: 'fall', name: 'Fall', colors: ['#98261E', '#E8720B', '#E45932', '#F3A93E', '#895739'] },
  { key: 'nude', name: 'Nude', colors: ['#EDEAE3', '#E7D7C8', '#D4B2A8', '#CEC6C3', '#A38F86'] },
  { key: 'tie-dye', name: 'Tie Dye', colors: ['#DD6DA8', '#B6D8DE', '#EAE67D', '#E4B1C8', '#B8D08C'] },
  { key: 'pastel-beach', name: 'Pastel Beach', colors: ['#D4CFCC', '#BCD6EF', '#D1E3F7', '#F3F8FE', '#ECEDE9'] },
  { key: 'cherry-blossom', name: 'Cherry Blossom', colors: ['#FCEDF2', '#FED8F1', '#F6C6DE', '#F2B5D4', '#C5CCF6'] },
  { key: 'beige-neutral', name: 'Beige & Neutral', colors: ['#AA9D94', '#BBADA1', '#D2C1B3', '#E7D7CB', '#F7EDE2'] },
  { key: 'white', name: 'White', colors: ['#D1D1D1', '#E1DBD6', '#E2E2E2', '#F9F6F2', '#FFFFFF'] },
  { key: 'black', name: 'Black', colors: ['#0F0E11', '#23252D', '#2B2D35', '#3A3C44', '#46484F'] },
  { key: 'green', name: 'Green', colors: ['#28662B', '#2A8636', '#43AA47', '#81C953', '#97E589'] },
  { key: 'pink', name: 'Pink', colors: ['#D84F74', '#EA79A3', '#EE8EA5', '#F7BAD3', '#F7DAE8'] },
  { key: 'purple', name: 'Purple', colors: ['#5A2555', '#5D2A7B', '#7948A2', '#A063C8', '#BE8CE5'] },
  { key: 'red', name: 'Red', colors: ['#4B1517', '#7C1715', '#9E1C29', '#AB2838', '#B84656'] },
  { key: 'blue', name: 'Blue', colors: ['#20498A', '#3D6FAD', '#4A88C5', '#88AEDB', '#BBDAF2'] },
  { key: 'yellow', name: 'Yellow', colors: ['#C56A1D', '#D18623', '#D3982F', '#E8C539', '#F4D44E'] },
  { key: 'brown', name: 'Brown', colors: ['#66422D', '#966045', '#B26E4B', '#C7976F', '#EBD2BC'] },
]

/*
 * The five families a palette's five colours land on, in the order they get them.
 *
 * These are the buckets kinds.js's defaults already use -- blue for what feeds
 * Segment, orange for what processes on the way out, purple for Unify, red for Engage
 * -- so a themed canvas groups the same way an unthemed one does. `processing` covers
 * both ends of the pipeline because a function is a function: the shape says
 * "transform" and the column it sits in says which side of Segment it is on.
 *
 * A kind absent from this table takes no palette colour and keeps its default. That
 * is how `custom` stays neutral (see the header) and it is also what a kind added
 * later does by default, which is the safe direction -- an unthemed node looks
 * unfinished, a wrongly-themed one looks wrong.
 */
export const FAMILIES = ['input', 'processing', 'output', 'unify', 'engage']

const FAMILY_OF = {
  source: 'input',
  profile_source: 'input',
  /* Protocols in the input family rather than in a sixth one of its own. A sixth
     family would wrap onto the first colour anyway -- there are five colours in every
     palette here -- so the choice is between an accidental collision and a deliberate
     one, and these three do belong with the source: all four say what may enter. */
  tracking_plan: 'input',
  event_library: 'input',
  property_library: 'input',

  source_function: 'processing',
  source_insert_function: 'processing',
  /* Both can drop an event, which is what puts them here rather than with the thing
     they are configured on. */
  source_schema_control: 'processing',
  destination_filter: 'processing',
  destination_insert_function: 'processing',
  destination_mapping: 'processing',
  destination_function: 'processing',
  identity_resolution: 'processing',

  destination: 'output',
  warehouse: 'output',
  reverse_etl_model: 'output',

  space: 'unify',
  computed_trait: 'unify',
  profile_api: 'unify',
  profile: 'unify',
  profile_sync: 'unify',
  identity_setting: 'unify',

  audience: 'engage',
  journey: 'engage',
}

export const familyOf = (kind) => FAMILY_OF[kind] ?? null

/** `#aabbcc` or `#abc` -> `{r, g, b}`, and null for anything else. */
export function parseHex(value) {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(value ?? '').trim())
  if (!match) return null

  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((d) => d + d)
          .join('')
      : match[1]
  const int = parseInt(digits, 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

const hex = ({ r, g, b }) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

/** `amount` of `to` mixed into `from`, in sRGB. */
export function mix(from, to, amount) {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return from
  const t = Math.min(1, Math.max(0, amount))
  return hex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

/*
 * WCAG relative luminance. Gamma-corrected, not the (r+g+b)/3 average a first attempt
 * reaches for: yellow and blue at the same average are nowhere near the same
 * brightness, and getting that wrong is exactly what puts white text on #F4D44E.
 */
export function luminance(value) {
  const rgb = parseHex(value)
  if (!rgb) return 0
  const channel = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/**
 * A label colour that stays legible on `background`.
 *
 * Navy or white by preference, because those are what the rest of the UI uses. Neither
 * reaches AA on a mid-luminance fill though -- Cottagecore's olive tops out at 4.15:1
 * against white -- and the two candidates cannot be improved on from inside the pair,
 * so pure black is the fallback. It always clears AA exactly where the pair does not:
 * white holds up to a luminance of 0.183 and black from 0.175, and the ranges overlap.
 *
 * Legibility wins over matching the UI, rather than the other way round, because an
 * unreadable component name is a broken diagram and a slightly-too-black one is not.
 */
export function readableText(background) {
  const preferred = contrast(INK, background) >= contrast(PAPER, background) ? INK : PAPER
  if (contrast(preferred, background) >= MIN_TEXT_CONTRAST) return preferred
  return BLACK
}

/**
 * One colour -> a node style.
 *
 * The colour is the fill rather than the border, which is the opposite of the
 * defaults in kinds.js. Deliberate: the defaults are mostly white cards with a
 * coloured edge, and a palette applied that way would be five shades of white. What
 * someone picking "Cottagecore" wants is to see Cottagecore.
 *
 * Returns null for a colour it cannot parse, so a caller can leave the node alone
 * rather than writing `undefined` into its style and blanking it.
 */
export function styleForColor(color) {
  if (!parseHex(color)) return null
  const bg = hex(parseHex(color))
  return {
    bg,
    border: mix(bg, luminance(bg) < DARK_FILL ? PAPER : INK, BORDER_SHIFT),
    text: readableText(bg),
  }
}

export const paletteByKey = (key) => PALETTES.find((palette) => palette.key === key) ?? null

/**
 * A palette -> `{kind: style}` for every kind it has an opinion about.
 *
 * Colours are sorted light to dark before being handed out, so the assignment does
 * not depend on the order the source page happened to list them in and two palettes
 * with the same five colours theme identically. Family order then means the canvas
 * darkens roughly left to right, which is a reading of the pipeline rather than an
 * accident of transcription.
 *
 * Takes a palette or its key. A palette with fewer than five colours wraps rather
 * than leaving a family unstyled -- a half-themed canvas is worse than a repeated
 * colour, and every palette here has five.
 */
export function paletteStyles(palette) {
  const found = typeof palette === 'string' ? paletteByKey(palette) : palette
  const colors = (found?.colors ?? []).filter((color) => parseHex(color))
  if (!colors.length) return {}

  const ordered = [...colors].sort((a, b) => luminance(b) - luminance(a))
  const byFamily = new Map(
    FAMILIES.map((family, index) => [family, styleForColor(ordered[index % ordered.length])]),
  )

  const styles = {}
  for (const [kind, family] of Object.entries(FAMILY_OF)) {
    const style = byFamily.get(family)
    if (style) styles[kind] = style
  }
  return styles
}

/* The three keys a palette owns. Named rather than "everything except shape", so a
   style field added later is not silently wiped by Reset colours. */
const COLOUR_KEYS = ['bg', 'border', 'text']

/**
 * Every component on the canvas, recoloured. The "all components" half of the request.
 *
 * Merged into each node's existing override rather than replacing it, for the same
 * reason `updateKindStyle` merges: a node given a bespoke shape keeps it. Zones are
 * skipped -- their tints say which Segment product a region is, which is structure
 * rather than decoration, and a themed canvas still has to be readable as Connections,
 * Unify and Engage.
 *
 * Returns the same array when nothing changes, matching the identity contract
 * `growZones` and `collapseGraph` keep: React Flow re-renders what it is handed.
 */
export function applyPaletteToNodes(nodes, palette) {
  const styles = paletteStyles(palette)
  if (!Object.keys(styles).length) return nodes ?? []

  let changed = false
  const next = (nodes ?? []).map((node) => {
    const style = styles[node.data?.kind]
    if (!style || node.type === 'zone') return node
    changed = true
    return { ...node, data: { ...node.data, style: { ...node.data.style, ...style } } }
  })
  return changed ? next : (nodes ?? [])
}

/**
 * Undo a theme: drop the colours, keep the shapes.
 *
 * A delete rather than a write-back of the defaults, so a node goes back to *tracking*
 * its kind's default and picks up a later change to it -- the same reason StyleTab's
 * per-node Reset deletes. A style left holding nothing becomes `undefined` outright,
 * because an empty object still reads as "this node has an override" everywhere the
 * inspector counts keys.
 */
export function clearPaletteFromNodes(nodes) {
  let changed = false
  const next = (nodes ?? []).map((node) => {
    const style = node.data?.style
    if (!style || !COLOUR_KEYS.some((key) => key in style)) return node
    changed = true

    const kept = { ...style }
    for (const key of COLOUR_KEYS) delete kept[key]
    return {
      ...node,
      data: { ...node.data, style: Object.keys(kept).length ? kept : undefined },
    }
  })
  return changed ? next : (nodes ?? [])
}
