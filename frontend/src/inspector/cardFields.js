/*
 * Which of a component's fields are printed on its card.
 *
 * The inspector shows everything a component carries. The card cannot -- it is a 200px box on a
 * diagram that may hold forty of them -- so which fields make it onto the drawing is a choice, and
 * this is where that choice lives. The eye toggle beside each inspector row writes here; the node
 * renderer reads here. One table, so the two cannot disagree about what "Cadence" means or which
 * order the rows come in.
 *
 * ## Only the overrides are stored
 *
 * `data.showFields` holds *explicit* decisions and nothing else, exactly as `arrange` and `locked`
 * do: a diagram nobody has fiddled with carries no key at all, so opening one written before this
 * existed does not mark it dirty. `fieldShown` resolves an absent entry against the table's own
 * default.
 *
 * ## Why almost everything defaults to on
 *
 * Asked for directly -- "auto-enable all fields to be visible by default excluding Zone". The reason
 * it is a sensible default and not just an instruction: these fields are the answer to "what is this
 * component", and a reader looking at someone else's diagram has no sidebar open. Zone is the
 * exception because the card is already *drawn inside* its zone, so printing the zone's name on it
 * repeats what the position already says.
 *
 * Description is a second, later exception: also asked for directly, on the grounds that a
 * description is usually prose written for the inspector's sidebar, not for a card shared with
 * forty others on a diagram -- so it now starts hidden and an author turns it on per-component
 * where it earns its space.
 *
 * ## What is deliberately not here
 *
 * `name`, because it is the card's title and always drawn -- a card with no label is not a component,
 * it is a rectangle. And the write key: `WriteKeyRow` reveals a real credential on a timer and has
 * its own audit trail, so a checkbox that could print it onto a diagram that gets exported to PDF is
 * not a feature. The masked form stays on the card as it always has.
 */

/*
 * Every toggleable field, in the order a card prints them.
 *
 * `read` takes the node's `data` and returns a display string, or null when the component has no
 * such field -- which is most of them for most kinds, and is why the card iterates this list rather
 * than the stored overrides. A field a component does not have is not hidden, it is absent, and
 * those are different things: turning the eye on for "Cadence" on a source must not print an empty
 * row.
 *
 * `defaultOn: false` appears twice, on `description` and `zone`. Anything added here later should
 * think twice before joining them -- the point of the default is that a diagram says what it knows
 * without being asked.
 */
export const CARD_FIELDS = [
  {
    id: 'description',
    label: 'Description',
    /* Off by default -- see the module comment above. A component's description tends to be prose
       written for the inspector, and printing it on every card by default crowds a diagram that has
       more than a couple of components on it. */
    defaultOn: false,
    read: (data) => text(data?.description),
  },
  {
    id: 'type',
    label: 'Type',
    defaultOn: true,
    /* The kind's human label, which is what the card's second line has always shown. Falls back
       through the same chain the renderer used before this table existed, so switching the eye off
       and on again gives back exactly what was there. */
    read: (data) => text(data?.kindLabel) ?? text(data?.kind),
  },
  {
    id: 'zone',
    label: 'Zone',
    /* The one field off by default. The card is drawn inside its zone, so its name is already on
       screen a few pixels away. */
    defaultOn: false,
    read: (data) => text(data?.zone),
  },
  { id: 'sourceType', label: 'Source type', defaultOn: true, read: (data) => text(data?.sourceType) },
  {
    id: 'warehouseType',
    label: 'Warehouse',
    defaultOn: true,
    read: (data) => text(data?.warehouseType),
  },
  {
    id: 'categories',
    label: 'Categories',
    defaultOn: true,
    read: (data) => (data?.categories?.length ? data.categories.join(', ') : null),
  },
  {
    id: 'segmentName',
    label: 'Name in Segment',
    defaultOn: true,
    /* Only when it differs from the name on the card. Printing "Name in Segment: Website (JS)" under
       a card already titled "Website (JS)" is a row that says nothing. */
    read: (data) =>
      data?.segmentName && data.segmentName !== data.name ? text(data.segmentName) : null,
  },
  {
    id: 'enabled',
    label: 'Enabled',
    defaultOn: true,
    /* Only the interesting half. Every enabled component in the workspace is enabled, so a card
       saying so on all forty of them is noise -- whereas one disabled destination is exactly the
       thing a reader is hunting for. */
    read: (data) => (data?.enabled === false ? 'Disabled in Segment' : null),
  },
  { id: 'status', label: 'State', defaultOn: true, read: (data) => text(data?.status) },
  {
    id: 'computeCadence',
    label: 'Cadence',
    defaultOn: true,
    read: (data) => text(data?.computeCadence),
  },
  { id: 'deployedAt', label: 'Deployed', defaultOn: true, read: (data) => text(data?.deployedAt) },
  { id: 'slug', label: 'Slug', defaultOn: true, read: (data) => text(data?.slug) },
  {
    id: 'traitKey',
    label: 'Trait key',
    defaultOn: true,
    read: (data) => text(data?.traitKey),
  },
  {
    id: 'audienceKey',
    label: 'Audience key',
    defaultOn: true,
    read: (data) => text(data?.audienceKey),
  },
]

/* Trimmed, and null for anything that is not a usable string. `0` and `false` are not fields this
   table reads, so coercing them is not a concern -- but an empty string is very much a real value in
   a hand-edited document, and printing an empty row for it is the bug this prevents. */
function text(value) {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed || null
}

const BY_ID = new Map(CARD_FIELDS.map((field) => [field.id, field]))

export function cardField(id) {
  return BY_ID.get(id) ?? null
}

/**
 * Is this field printed on the card?
 *
 * Answered from the stored override first, then the table's default. Note it says nothing about
 * whether the component *has* the field -- `visibleCardFields` handles that, because "off" and
 * "absent" need to look different in the inspector (a greyed eye) and identical on the card
 * (nothing drawn).
 */
export function fieldShown(data, id) {
  const stored = data?.showFields?.[id]
  if (typeof stored === 'boolean') return stored
  return cardField(id)?.defaultOn ?? false
}

/**
 * `data.showFields` with one field flipped.
 *
 * An override equal to the default is *deleted* rather than written, and the whole key is dropped
 * once it is empty. So switching a field off and on again leaves the document byte-identical to how
 * it started -- otherwise every diagram anyone had ever poked at would differ from its saved copy by
 * a `showFields: {}` nobody could account for.
 */
export function toggleField(data, id, shown) {
  const field = cardField(id)
  if (!field) return data?.showFields
  const next = { ...(data?.showFields ?? {}) }
  if (shown === field.defaultOn) delete next[id]
  else next[id] = shown
  return Object.keys(next).length ? next : undefined
}

/**
 * The fields to print on one card: `[{id, label, value}]`, in table order.
 *
 * Both conditions, and they are different questions -- the eye is on, *and* the component actually
 * has a value for it. A card is a drawing, and a row reading "Cadence: not set" is worse than no row
 * at all; the inspector is where "not set" is worth saying, because there it is next to the field
 * that would set it.
 */
export function visibleCardFields(data) {
  const out = []
  for (const field of CARD_FIELDS) {
    if (!fieldShown(data, field.id)) continue
    const value = field.read(data)
    if (value === null) continue
    out.push({ id: field.id, label: field.label, value })
  }
  return out
}
