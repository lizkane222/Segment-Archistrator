/*
 * Visual vocabulary: what each component kind looks like on the canvas.
 *
 * This is the one part of the rule set that is deliberately client-only. The
 * server owns what is *legal* (zones, adjacency) because both sides must agree
 * on that; nothing on the server cares what colour a warehouse is.
 *
 * The brief asks for distinct shapes and colours that are "easily updated" --
 * hence one flat table, and per-node overrides in `data.style` that the
 * inspector writes and the renderer prefers over these defaults.
 */

import {
  ArrowRightLeft,
  Box,
  Boxes,
  Braces,
  ClipboardList,
  Database,
  Filter,
  Fingerprint,
  Globe,
  Layers,
  ListChecks,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Sigma,
  Split,
  Tags,
  Target,
  User,
  Users,
  Warehouse,
  Workflow,
} from 'lucide-react'

/* Shapes are CSS, not SVG: a node is a div, so the shape is a border-radius or a
   clip-path. Cheaper to render at scale than an SVG per node, and text inside
   stays selectable. */
export const SHAPES = {
  rounded: 'rounded-lg',
  pill: 'rounded-full',
  sharp: 'rounded-none',
  /* A diamond would rotate its text with it, so processing steps get a notched
     rectangle instead -- visually distinct, still readable. */
  notched: 'rounded-lg [clip-path:polygon(8px_0,100%_0,100%_calc(100%-8px),calc(100%-8px)_100%,0_100%,0_8px)]',
}

const DEFAULT = {
  icon: Boxes,
  shape: 'rounded',
  bg: '#ffffff',
  border: '#aebbc1',
  text: '#121c2d',
  /* The outline, overridable like anything else here. No kind sets these -- a hairline
     solid border is right for all of them -- but they are in the table rather than
     hard-coded in the renderer so that the inspector has a default to show and to reset
     back to, which is the whole shape of every other property on this table. */
  borderStyle: 'solid',
  borderWidth: 1,
}

export const KIND_STYLES = {
  /* --- Connections --------------------------------------------------------- */
  source: { icon: Globe, shape: 'rounded', bg: '#ffffff', border: '#0263e0', text: '#121c2d' },
  source_function: { icon: Braces, shape: 'notched', bg: '#e4f7ff', border: '#0263e0', text: '#043cb5' },
  source_insert_function: { icon: Braces, shape: 'notched', bg: '#e4f7ff', border: '#0263e0', text: '#043cb5' },
  /* Notched like the other processing steps, and in the source's blue rather than
     Protocols' teal: the gate is a setting on the source, and what it enforces is
     the teal thing pointing at it. */
  source_schema_control: { icon: ShieldCheck, shape: 'notched', bg: '#e4f7ff', border: '#0263e0', text: '#043cb5' },

  destination_filter: { icon: Filter, shape: 'notched', bg: '#fff8e1', border: '#e67e22', text: '#7a4a12' },
  destination_insert_function: { icon: Braces, shape: 'notched', bg: '#fff8e1', border: '#e67e22', text: '#7a4a12' },
  destination_function: { icon: Braces, shape: 'notched', bg: '#fff8e1', border: '#e67e22', text: '#7a4a12' },
  destination_mapping: { icon: ArrowRightLeft, shape: 'notched', bg: '#fff8e1', border: '#e67e22', text: '#7a4a12' },
  destination: { icon: Send, shape: 'rounded', bg: '#ffffff', border: '#0e7c3a', text: '#121c2d' },

  warehouse: { icon: Warehouse, shape: 'sharp', bg: '#ffffff', border: '#354052', text: '#121c2d' },
  reverse_etl_model: { icon: Database, shape: 'sharp', bg: '#f4f4f6', border: '#354052', text: '#354052' },

  /* --- Protocols ----------------------------------------------------------- */
  /* Teal, matching the Protocols zone border: these three describe what the data
     should be, and none of them is a stage an event passes through. */
  tracking_plan: { icon: ClipboardList, shape: 'rounded', bg: '#ffffff', border: '#0f7c8a', text: '#121c2d' },
  event_library: { icon: ListChecks, shape: 'sharp', bg: '#e8f6f7', border: '#0f7c8a', text: '#0b5b66' },
  property_library: { icon: Tags, shape: 'sharp', bg: '#e8f6f7', border: '#0f7c8a', text: '#0b5b66' },

  /* --- Unify --------------------------------------------------------------- */
  space: { icon: Layers, shape: 'rounded', bg: '#ffffff', border: '#6f42c1', text: '#121c2d' },
  identity_resolution: { icon: Fingerprint, shape: 'notched', bg: '#f3ecff', border: '#6f42c1', text: '#4c2a91' },
  computed_trait: { icon: Sigma, shape: 'rounded', bg: '#f3ecff', border: '#6f42c1', text: '#4c2a91' },
  profile_api: { icon: Split, shape: 'pill', bg: '#ffffff', border: '#6f42c1', text: '#4c2a91' },
  /* A source's icon in Unify's colours, because that is what it is: the source
     from Connections, seen as something that feeds profiles. */
  profile_source: { icon: Globe, shape: 'rounded', bg: '#f3ecff', border: '#6f42c1', text: '#4c2a91' },
  profile: { icon: User, shape: 'rounded', bg: '#ffffff', border: '#6f42c1', text: '#121c2d' },
  /* Unify's purple even though what it carries out is partly Engage's, because the
     sync is configured in Unify and a component should be the colour of the product
     you go to when it stops working. */
  profile_sync: { icon: RefreshCw, shape: 'notched', bg: '#f3ecff', border: '#6f42c1', text: '#4c2a91' },
  /* Purple although it lives in an Engage sub-zone: identity resolution is a Unify
     concept, and the colour should say which product's settings these are. */
  identity_setting: {
    icon: Fingerprint,
    shape: 'sharp',
    bg: '#ffffff',
    border: '#6f42c1',
    text: '#4c2a91',
    /* Wider than the 200px default because this one draws a three-column table rather
       than a label -- see nodes/IdentityRuleTable.jsx. A default, not a floor: the user
       can still resize it, and a size they chose wins (`componentSize`). */
    defaultWidth: 280,
  },

  /* --- Engage -------------------------------------------------------------- */
  audience: { icon: Users, shape: 'rounded', bg: '#ffffff', border: '#db131a', text: '#121c2d' },
  /* Journeys are never API-discovered, so they are always hand-drawn. */
  journey: { icon: Route, shape: 'rounded', bg: '#fdeced', border: '#db131a', text: '#8f0d12' },

  /* --- Outside Segment ----------------------------------------------------- */
  /* Deliberately not a topology kind. It stands for something the customer runs
     themselves -- their app, a warehouse they own, an integration partner's
     workspace -- so there is no zone it belongs in and no adjacency table for it,
     which is exactly what the server's tolerance of unknown kinds already
     provides. Neutral grey and square, so it does not read as any Segment
     product. */
  custom: { icon: Box, shape: 'sharp', bg: '#f4f4f6', border: '#606b85', text: '#354052' },
}

/* Labels for kinds the topology has never heard of, so nothing on the server can
   supply one. */
const LOCAL_KIND_LABELS = {
  custom: 'Custom component',
}

/** A kind's display label, from the topology if it knows it. */
export function labelForKind(topology, kind) {
  return topology?.kinds?.[kind]?.label ?? LOCAL_KIND_LABELS[kind] ?? kind
}

/* Palette-only entries: the five event types the brief lists. They are not
   topology kinds -- an event is what flows *through* the graph, not a node in
   it -- so they live here rather than in the server's KINDS table. */
export const EVENT_KINDS = {
  track: { icon: Target, label: 'Track', hint: 'A user did something.' },
  identify: { icon: Fingerprint, label: 'Identify', hint: 'Who the user is.' },
  page: { icon: Globe, label: 'Page', hint: 'A page was viewed.' },
  group: { icon: Users, label: 'Group', hint: 'The account a user belongs to.' },
  alias: { icon: Workflow, label: 'Alias', hint: 'Two identities are the same person.' },
}

export function styleFor(kind, overrides) {
  return { ...DEFAULT, ...(KIND_STYLES[kind] ?? {}), ...(overrides ?? {}) }
}

export function iconFor(kind) {
  return (KIND_STYLES[kind] ?? DEFAULT).icon
}

/**
 * The outline a card actually draws.
 *
 * The dashed 2px border on an unbound template placeholder is a *default*, not a rule:
 * it is the "planned, not built yet" annotation, and someone laying out a proposal is
 * entitled to make a placeholder look like anything. So an explicit override wins, and
 * the dash is only what an unstyled placeholder gets.
 *
 * Here rather than in the renderer because the inspector has to resolve the same thing
 * to know which button to highlight, and a rule applied in two places is a rule applied
 * differently the next time either place changes -- which would show as a panel
 * disagreeing with the canvas it is describing.
 */
export function outlineFor(data) {
  const style = styleFor(data?.kind, data?.style)
  const placeholder = data?.bound === false
  return {
    borderStyle: data?.style?.borderStyle ?? (placeholder ? 'dashed' : style.borderStyle),
    borderWidth: data?.style?.borderWidth ?? (placeholder ? 2 : style.borderWidth),
  }
}

/* A sub-zone sits on top of its parent's tint, so tinting it again would darken by
   accumulation -- Profiles would end up a deeper purple than Unify and read as a
   fourth product. It borrows the parent's border colour instead, which is what says
   which product it is part of. */
const subZoneOf = (product) => ({
  bg: 'transparent',
  border: `var(--color-zone-${product}-border)`,
})

export const ZONE_STYLES = {
  segment: { bg: 'var(--color-zone-segment)', border: 'var(--color-zone-segment-border)' },
  connections: { bg: 'var(--color-zone-connections)', border: 'var(--color-zone-connections-border)' },
  /* The one sub-zone that does not borrow its parent's border: Protocols is a
     product of its own, not a region of Connections. */
  protocols: { bg: 'transparent', border: 'var(--color-zone-protocols-border)' },
  sources: subZoneOf('connections'),
  destinations: subZoneOf('connections'),
  warehouses: subZoneOf('connections'),
  unify: { bg: 'var(--color-zone-unify)', border: 'var(--color-zone-unify-border)' },
  profile_sources: subZoneOf('unify'),
  profiles: subZoneOf('unify'),
  identity_settings: subZoneOf('unify'),
  engage: { bg: 'var(--color-zone-engage)', border: 'var(--color-zone-engage-border)' },
  computations: subZoneOf('engage'),
  debugger: subZoneOf('engage'),
}

/* A custom zone gets the same grey as a custom component, so a region the
   customer drew and the components inside it read as one thing. */
const CUSTOM_ZONE = { bg: 'rgba(96, 107, 133, 0.06)', border: '#606b85' }

export const ZONE_SWATCHES = ['#606b85', '#0263e0', '#6f42c1', '#0e7c3a', '#e67e22', '#db131a']

/**
 * A zone's tint and border.
 *
 * A stored hex wins, then the product defaults from their CSS variables. That
 * order round the way it is because a custom zone has no
 * `--color-zone-<id>-border` to read -- and because recolouring Connections has to
 * actually recolour it, which checking the id first would silently prevent. The
 * tint is derived from the one hex rather than stored beside it, so the two cannot
 * be saved out of step.
 */
export function zoneStyleFor({ id, color } = {}) {
  if (color) return { bg: tint(color, 0.06), border: color }
  return ZONE_STYLES[id] ?? CUSTOM_ZONE
}

function tint(hex, alpha) {
  const value = /^#([\da-f]{6})$/i.exec(hex.trim())
  if (!value) return CUSTOM_ZONE.bg
  const int = parseInt(value[1], 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}
