/*
 * Extra documentation links per component kind, shown in the Links tab beneath the primary one.
 *
 * The primary link (`node.data.docsUrl`) still comes from the server's deeplinks.py. This is the
 * "and also read these" list, kept on the client so adding a link is a one-line edit here and needs
 * no deploy of the API.
 *
 * Seeded only with pages that deeplinks.py already records as verified (200, no redirect). Add the
 * rest as you review each component -- one `{ label, url }` per link. A link nobody has opened is
 * worse than none, so check it before adding it.
 *
 * A single diagram can also carry its own: `node.data.docsLinks = [{ label, url }]`, which is shown
 * after these.
 */

import { safeHttpUrl } from '../ui/safeUrl.js'

const DOCS = 'https://www.twilio.com/docs/segment'

export const KIND_DOCS_LINKS = {
  source: [{ label: 'How cloud sources work', url: `${DOCS}/connections/sources/about-cloud-sources` }],
  destination: [{ label: 'Actions destinations and mappings', url: `${DOCS}/connections/destinations/actions` }],
  destination_mapping: [{ label: 'Destinations catalog', url: `${DOCS}/connections/destinations/catalog` }],
  reverse_etl_model: [{ label: 'Reverse ETL catalog', url: `${DOCS}/connections/reverse-etl/reverse-etl-catalog` }],
  identity_resolution: [
    { label: 'Identity resolution settings', url: `${DOCS}/unify/identity-resolution/identity-resolution-settings` },
    { label: 'External IDs', url: `${DOCS}/unify/identity-resolution/externalids` },
  ],
  identity_setting: [{ label: 'Identity resolution overview', url: `${DOCS}/unify/identity-resolution` }],
  profile: [{ label: 'Profile API', url: `${DOCS}/unify/profile-api` }],
  profile_source: [{ label: 'Identity resolution overview', url: `${DOCS}/unify/identity-resolution` }],
  linked_event: [{ label: 'Data Graph', url: `${DOCS}/unify/data-graph` }],
  linked_audience: [{ label: 'Audiences', url: `${DOCS}/engage/audiences` }],
  data_graph: [{ label: 'Linked Events', url: `${DOCS}/unify/data-graph/linked-events` }],
  event_library: [{ label: 'Tracking plans', url: `${DOCS}/protocols/tracking-plan/create` }],
  property_library: [{ label: 'Tracking plans', url: `${DOCS}/protocols/tracking-plan/create` }],
  tracking_plan: [{ label: 'Libraries', url: `${DOCS}/protocols/tracking-plan/libraries` }],
  source_schema_control: [{ label: 'Protocols overview', url: `${DOCS}/protocols` }],
  profile_sync: [{ label: 'Unify overview', url: `${DOCS}/unify` }],
}

/**
 * Every extra link for a node: the kind's, then the diagram's own. Unsafe URLs and duplicates
 * (including the primary link, passed as `primary`) are dropped.
 */
export function extraDocsLinks(data, primary = null) {
  const own = Array.isArray(data?.docsLinks) ? data.docsLinks : []
  const seen = new Set(primary ? [primary] : [])
  const links = []
  for (const entry of [...(KIND_DOCS_LINKS[data?.kind] ?? []), ...own]) {
    const url = safeHttpUrl(entry?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    links.push({ label: String(entry.label || url), url })
  }
  return links
}
