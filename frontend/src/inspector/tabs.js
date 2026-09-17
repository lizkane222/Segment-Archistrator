/*
 * Which Edit-Stage tabs a given node gets, and how the Fields tab finds a space.
 *
 * Pure and separate from the components because "does a warehouse have rules?"
 * is a judgement about Segment, not about React, and because an always-visible
 * tab that is always empty is worse than no tab: it invites a click that teaches
 * nothing. So the Rules tab appears only when there is something to put in it.
 */

import { isFunctionKind } from '../functions/defaults.js'

export const BIND = 'bind'
export const OVERVIEW = 'overview'
export const FIELDS = 'fields'
export const RULES = 'rules'
export const STYLE = 'style'
export const LINKS = 'links'
export const ZONE = 'zone'
/* A connector's own tab: colour, dash pattern, which end (or ends) wears an arrow.
   Its own id rather than reusing STYLE, because an edge is never a `node` with a
   `kind` -- the two tabs would have to branch internally on what they were given,
   where two separate ones let `tabsFor` decide that once. */
export const EDGE_STYLE = 'edge_style'
/* The JavaScript a function runs, and a tester for it. Only the four function kinds have
   one, and for them it is the component: everything else a function carries -- its
   resource type, its preview webhook -- is metadata about a thing whose whole content is
   this code. See CodeTab.jsx. */
export const CODE = 'code'
/* Editing the data behind a component whose *content is a table or a config block*: a SQL Table's CSV
   and query, a Data Graph's entity model. Its own tab rather than more of Overview, because a textarea
   holding forty lines of CSV alongside a name field is a panel with two different jobs. */
export const DATA = 'data'

export const TAB_LABELS = {
  [BIND]: 'Bind',
  [OVERVIEW]: 'Overview',
  [FIELDS]: 'Fields',
  [RULES]: 'Rules',
  [STYLE]: 'Style',
  [LINKS]: 'Links',
  [ZONE]: 'Zone',
  [DATA]: 'Data',
  [CODE]: 'Code',
  [EDGE_STYLE]: 'Style',
}

/*
 * What each kind's Rules tab is actually about. The value is the heading; the
 * presence of a key is what makes the tab appear.
 *
 * Notably absent: source, warehouse, space, profile. Nothing about them is a rule
 * -- a source has settings, and a profile is a result rather than a policy.
 */
const RULES_SUBJECT = {
  destination: 'Destination filters',
  destination_filter: 'Filter condition',
  destination_mapping: 'Trigger and field mapping',
  destination_insert_function: 'Insert function',
  source_schema_control: 'Unplanned and blocked events',
  tracking_plan: 'Planned events and properties',
  event_library: 'Events in this library',
  property_library: 'Property groups in this library',
  profile_sync: 'What is synced, and how often',
  destination_function: 'Destination function',
  source_function: 'Source function',
  source_insert_function: 'Source insert function',
  computed_trait: 'Trait definition',
  audience: 'Audience definition',
  journey: 'Journey steps',
  reverse_etl_model: 'Model query',
  identity_resolution: 'Identity resolution rules',
  /* The whole content of the node: there is no API for these, so the rule someone
     typed here is the only record of it. */
  identity_setting: 'Identifier limits and precedence',
}

/*
 * Every kind promised a Rules tab.
 *
 * Exported for tabs.test.js, which checks each one against the branches in RulesTab.jsx.
 * A heading here with no branch there is not a blank tab -- it is a tab that opens and
 * says "nothing configured on this component", which is a claim about the customer's
 * workspace rather than about this tool. Six kinds sat in exactly that state between
 * being added here and their editors being written.
 */
export const RULES_KINDS = Object.freeze(Object.keys(RULES_SUBJECT))

/** The heading for a node's Rules tab, or null when it has no rules surface. */
export function rulesSubject(node) {
  return RULES_SUBJECT[node?.data?.kind] ?? null
}

/**
 * Kinds whose Fields tab is worth offering.
 *
 * Space Schema is space-scoped, so the fields shown are the space's events and
 * traits. That is directly relevant to anything that reads a profile, and to a
 * source (whose events are what populate the schema in the first place). It is
 * not relevant to a warehouse or a function, which do not have "available
 * fields" in any sense a reader would expect.
 */
const FIELD_KINDS = new Set([
  'source',
  /* A source's schema controls are about the source's own events and traits, which is
     what this tab lists. A tracking plan is not here for the opposite reason: its events
     are its own content, not the space's, and they belong in the Rules tab beside the
     enforcement they drive. */
  'source_schema_control',
  'profile_source',
  'space',
  'identity_resolution',
  'computed_trait',
  /* What Profiles Sync lands in the warehouse *is* the space's traits and identifiers,
     so the schema is the answer to "which columns will I get". */
  'profile_sync',
  'profile_api',
  /* The only kind whose own content *is* fields. Which of the space's traits and
     events a profile carries is the question the node exists to answer. */
  'profile',
  'audience',
  'journey',
])

/**
 * Does this node have a Bind tab, and should it open there?
 *
 * True for an unbound placeholder -- binding it is the only thing worth doing to
 * it, so it leads. Also true for a node that *was* bound from a placeholder (it
 * carries the stash), because that is the only route back to unbinding it. A node
 * discovered from the live workspace has neither: there is nothing to bind it to
 * that it is not already.
 *
 * `bound === false` explicitly, not falsy. This is the same test SegmentNode uses
 * to draw a node dashed, and the tab should appear on exactly the nodes that look
 * like placeholders. It deliberately differs from `isPlaceholder`, which counts an
 * absent `bound` as unbound -- that is the safe default when tallying a stored
 * graph, and the wrong one for offering an action.
 */
export function bindable(node) {
  const data = node?.data
  if (!data || data.bindable === false) return false
  return data.bound === false || Boolean(data.placeholder)
}

/* The kinds whose content is edited as free text rather than as fields. Both are hand-transcribed:
   Segment publishes no API for a Data Graph, and a SQL Table is this tool's own idea. */
export const DATA_KINDS = new Set(['sql_table', 'data_graph'])

export function tabsFor(node) {
  if (!node) return []

  /* A zone shares none of a component's tabs -- it has no kind, so no rules, no
     fields, and nothing to bind to -- so it gets its own single one rather than a
     row of tabs that all render empty. */
  if (node.type === 'zone') return [ZONE]

  /* A connector, same reasoning: no kind, no fields, no rules -- only the one thing
     worth setting on it. */
  if (node.type === 'flow') return [EDGE_STYLE]

  const kind = node.data?.kind
  const tabs = []
  /* First, and therefore the default tab for a placeholder: a dashed unbound node
     is a question, and this is where it gets answered. */
  if (bindable(node)) tabs.push(BIND)
  tabs.push(OVERVIEW)
  /*
   * Directly after Overview, ahead of Rules, and that ordering is the point.
   *
   * `DATA` sits later for the same underlying reason -- "for these kinds it *is* the
   * component" -- but a function has a Rules tab as well, and what that tab has to say
   * about a function is its resource type and its preview webhook URL. Putting metadata
   * in front of the code would bury the only thing on the component that decides what
   * happens to an event.
   */
  if (isFunctionKind(kind)) tabs.push(CODE)
  if (FIELD_KINDS.has(kind)) tabs.push(FIELDS)
  if (rulesSubject(node)) tabs.push(RULES)
  /* Before Style and Links, because for these two kinds it *is* the component -- a Data Graph with no
     config and a SQL Table with no CSV are both empty boxes, so this is the first thing anyone does
     after dropping one. */
  if (DATA_KINDS.has(kind)) tabs.push(DATA)
  tabs.push(STYLE, LINKS)
  return tabs
}

/**
 * Which space the Fields tab should query for this node.
 *
 * Returns `{spaceId, inferred}`. `inferred: true` means the node itself carries
 * no space and one was picked for it because the workspace only has one -- worth
 * saying out loud in the UI, since on a multi-space workspace the same node would
 * instead force a choice rather than quietly guessing.
 */
export function resolveSpace(node, spaces) {
  const available = (spaces ?? []).filter((space) => space?.segmentId)

  const own = node?.data?.spaceId
  if (own) return { spaceId: own, inferred: false }

  // A space node is its own answer.
  if (node?.data?.kind === 'space' && node.data.segmentId) {
    return { spaceId: node.data.segmentId, inferred: false }
  }

  if (available.length === 1) return { spaceId: available[0].segmentId, inferred: true }

  return { spaceId: null, inferred: false }
}

/** Space nodes from the loaded graph, for the Fields tab's picker. */
export function spacesFromGraph(graph) {
  return (graph?.nodes ?? []).filter((node) => node.kind === 'space')
}

/**
 * Keep the selected tab valid when the selection moves to a different node.
 *
 * Selecting a destination while on Fields, then clicking an audience, should land
 * on Fields rather than silently resetting to Overview -- but selecting a
 * warehouse, which has no Fields tab, has to fall back somewhere.
 */
export function reconcileTab(current, node) {
  const available = tabsFor(node)
  if (!available.length) return OVERVIEW
  return available.includes(current) ? current : available[0]
}
