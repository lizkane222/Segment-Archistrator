/*
 * Copy, paste and duplicate, over document fragments rather than canvas nodes.
 *
 * A clip is `{nodes, edges}` in exactly the shape `serializeGraph` produces, for two
 * reasons. It is JSON, so it goes into sessionStorage and comes back out unchanged --
 * which is the whole of cross-canvas paste, item 5's last clause, with no extra
 * machinery. And it means paste is `toFlowNode` over a document fragment, the same
 * path a template takes, so a pasted node cannot end up in a shape the rest of the
 * app has never seen.
 *
 * Everything here is pure. The storage read/write is two lines at the bottom and the
 * only part that touches the browser.
 */

import { serializeEdge, serializeNode } from '../diagram/serialize.js'
import { explainMisplacement, isValidPlacement } from '../canvas/rules.js'
import { isGroupStackId } from '../canvas/grouping.js'

export const CLIPBOARD_KEY = 'segment-builder:clipboard'

/* Far enough to be visibly a second node, near enough to still read as related.
   Without it, `cmd-c cmd-v` with the mouse untouched lands the copy exactly on the
   original and looks like nothing happened. */
export const PASTE_OFFSET = 24

/*
 * Fields that identify one real component in one real workspace, dropped from a copy.
 *
 * A copy is a *different* component -- that is what copying means -- so carrying these
 * would leave two nodes claiming to be the same Segment resource. The Bind tab already
 * treats that as a conflict, and Stage 7's build mode would compose two writes for one
 * destination. So a copy comes back unbound, which is also the honest rendering: it is
 * a component you are planning, not one that exists.
 *
 * `slug`, `categories` and `catalogMetadataId` deliberately survive: they say *what
 * kind of thing* it is, which a copy still is.
 */
const INSTANCE_KEYS = [
  'segmentId',
  'workspaceUrl',
  'linkVerified',
  'writeKeyMasked',
  'writeKeyLast4',
]

/**
 * The nodes named by `ids`, plus every edge with both ends inside that set.
 *
 * Edges with one end outside are dropped rather than kept dangling: the node they
 * pointed at is not in the clip, and after paste re-mints ids there would be nothing
 * for them to reach. Returns null when there is nothing copyable, so a caller can
 * leave the previous clip alone rather than replacing it with an empty one.
 */
export function copyNodes(nodes, edges, ids) {
  const wanted = new Set(ids ?? [])
  const picked = (nodes ?? []).filter(
    (node) => wanted.has(node.id) && node.type !== 'zone' && !isGroupStackId(node.id),
  )
  if (!picked.length) return null

  const inside = new Set(picked.map((node) => node.id))
  return {
    nodes: picked.map(serializeNode),
    edges: (edges ?? [])
      .filter((edge) => inside.has(edge.source) && inside.has(edge.target))
      .map(serializeEdge),
  }
}

/**
 * "Braze" -> "Braze copy" -> "Braze copy 2".
 *
 * Strips an existing suffix before appending, so duplicating a duplicate gives
 * "Braze copy 2" and not "Braze copy copy" -- the second is what a naive version
 * produces and it degrades fast when someone makes five.
 */
export function dedupeName(name, existing) {
  const taken = new Set(existing ?? [])
  const base = String(name ?? 'Component').replace(/ copy(?: \d+)?$/i, '')

  const first = `${base} copy`
  if (!taken.has(first)) return first
  for (let n = 2; ; n += 1) {
    const candidate = `${base} copy ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Place a clip on the canvas.
 *
 * Returns `{nodes, edges}` as *document* nodes -- the caller runs them through
 * `toFlowNode`, because that is where zone membership becomes a `parentId` and
 * zone-local coordinates, and this module has no business knowing about either.
 *
 * Two placements, and the reason there are two is that a clip need not come from one
 * zone. A `cmd-a` over the whole canvas spans all of them, and there is no single zone
 * that could hold the result:
 *
 *   - Single-zone clip: aimed. Everything goes into `zone`, keeping its relative
 *     arrangement, with the group's top-left at `position`. `zone` may be null and that
 *     is still aimed: the pointer was over bare canvas, which is a working area you can
 *     paste into, and `position` is then a flow coordinate rather than a zone-local one.
 *   - Multi-zone clip: in place. Each node returns to the zone it was copied from,
 *     nudged by PASTE_OFFSET, and `position`/`zone` are ignored -- there is nothing
 *     sensible for them to mean.
 *
 * Never refuses over placement, and this is a reversal worth stating. Both paths below
 * used to return an `error` when a kind was unconventional for the zone it landed in,
 * which made Duplicate fail outright on a component the user had *already* been allowed
 * to put there -- the canvas advises on a drop and blocks nothing, so refusing the copy
 * of an accepted node was the app disagreeing with itself, and the only visible symptom
 * was that nothing appeared. Placement is advice everywhere now: `advisories` comes back
 * beside the nodes and the caller logs it.
 *
 * @param position  the paste anchor, in the target zone's local coordinates
 * @param zone      the zone descriptor under the cursor (`node.data` of a zone node)
 */
export function pasteNodes(clip, { nodes = [], topology, zone, position } = {}) {
  const incoming = clip?.nodes ?? []
  if (!incoming.length) return { error: 'There is nothing to paste.' }

  const zones = new Set(incoming.map((node) => node.zone))
  /* A point, not a zone: duplicate passes neither and pastes in place, the menu and the
     keyboard both pass where the user is looking. Keying on `zone` instead left a paste
     aimed at bare canvas landing back on top of the original. */
  const aimed = zones.size === 1 && Boolean(position)
  const advisories = []

  /* Which zone each node is actually going into, resolved before anything is minted
     because the answer decides both the advisory and the position.

     A zone the clip names but this canvas does not have becomes bare canvas rather than
     a refusal. The hazard the refusal guarded is real -- `parentId: 'zone-engage'` with
     no such node resolves to no parent at all, and React Flow then reads a zone-local
     position as absolute -- so the fallback is explicit: no parent, and say so. That is
     also the common case for a cross-canvas paste, which is the one thing the clipboard
     living in sessionStorage was for. */
  const present = new Map(
    nodes.filter((node) => node.type === 'zone').map((node) => [node.data?.id, node.data]),
  )
  const targets = new Map(
    incoming.map((node) => [node.id, aimed ? (zone ?? null) : (present.get(node.zone) ?? null)]),
  )

  for (const node of incoming) {
    const target = targets.get(node.id)
    if (!target) {
      /* Only when a zone was asked for and could not be had. Aiming at bare canvas is a
         choice, not a fallback, and has nothing to report. */
      if (node.zone && !aimed) {
        advisories.push(
          `This canvas has no ${node.zone} zone, so ${node.name ?? node.kind} was placed outside every zone.`,
        )
      }
      continue
    }
    if (isValidPlacement(topology, node.kind, target)) continue
    advisories.push(explainMisplacement({ topology, kind: node.kind, attemptedZone: target }))
  }

  const originX = Math.min(...incoming.map((node) => node.position?.x ?? 0))
  const originY = Math.min(...incoming.map((node) => node.position?.y ?? 0))
  const shiftX = aimed ? (position?.x ?? 0) - originX : PASTE_OFFSET
  const shiftY = aimed ? (position?.y ?? 0) - originY : PASTE_OFFSET

  const taken = new Set((nodes ?? []).map((node) => node.data?.name ?? node.name))
  const idMap = new Map()

  const pasted = incoming.map((node) => {
    const copy = clone(node)
    for (const key of INSTANCE_KEYS) delete copy[key]

    const id = mintId(node.kind)
    idMap.set(node.id, id)

    /* Added to `taken` as we go, so pasting three copies of one node gives three
       distinct names rather than three of "Braze copy". */
    const name = dedupeName(node.name, taken)
    taken.add(name)

    return {
      ...copy,
      id,
      name,
      bound: false,
      /* The resolved target, not the clip's claim: a node whose zone is missing here has
         to be written as belonging to none, or the save that follows records it in a zone
         the document does not contain. */
      zone: targets.get(node.id)?.id ?? null,
      position: {
        x: Math.round((node.position?.x ?? 0) + shiftX),
        y: Math.round((node.position?.y ?? 0) + shiftY),
      },
    }
  })

  const edges = (clip?.edges ?? [])
    .map((edge) => {
      const source = idMap.get(edge.source)
      const target = idMap.get(edge.target)
      if (!source || !target) return null
      return {
        ...edge,
        id: `${source}->${target}`,
        source,
        target,
        /* Never `discovered`. These were facts about the customer's workspace; a copy
           of one is a connection the user drew, and `toFlowEdge` reads this to decide
           whether it may be deleted again. */
        discovered: false,
      }
    })
    .filter(Boolean)

  return { nodes: pasted, edges, advisories }
}

/**
 * Duplicate, which is copy-and-paste-in-place with no clipboard involved.
 *
 * Expressed through `pasteNodes` rather than beside it, so "a copy is unbound", "a copy
 * is renamed" and "a copy's internal edges come with it" have one implementation. The
 * clipboard is deliberately untouched: duplicating a node should not throw away
 * whatever the user copied five minutes ago.
 */
export function duplicateNodes(nodes, edges, ids, { topology } = {}) {
  const clip = copyNodes(nodes, edges, ids)
  if (!clip) return { error: 'Select a component to duplicate.' }
  return pasteNodes(clip, { nodes, topology, zone: null, position: null })
}

function mintId(kind) {
  /* `manual:` for the same reason Canvas's palette drop uses it: it can never collide
     with a Segment id, and it is how anyone reading the document later can tell which
     nodes came from the API. */
  return `manual:${kind ?? 'component'}:${suffix()}`
}

/*
 * Eight hex characters, matching the shape Canvas's palette drop mints.
 *
 * Falls back off WebCrypto rather than calling `crypto.randomUUID()` outright, which
 * every other id in this app does, because those all live in browser-only files and
 * this one is unit-tested: Vitest's node environment exposes no `crypto` global at all
 * on Node 18. Not a weakening -- an id here has to be unique within one document, not
 * unguessable, and nothing downstream treats it as a secret.
 */
function suffix() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.slice(0, 8)
  return Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, '0')
}

/* JSON rather than structuredClone. The clip is a document fragment either way, so a
   value JSON cannot carry is a value that was never going to be saved -- and
   structuredClone throws on a function where this drops it, which turns a stray
   callback left on node data into a failed paste. */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * sessionStorage, not localStorage: a clip is the tail end of a gesture, and one still
 * sitting there next week would paste a component out of a customer engagement someone
 * has since finished. Per-tab is also what makes "the other tab" mean the other diagram
 * rather than another window's.
 */
export function readClipboard(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(CLIPBOARD_KEY)
    if (!raw) return null
    const clip = JSON.parse(raw)
    return Array.isArray(clip?.nodes) && clip.nodes.length ? clip : null
  } catch {
    return null
  }
}

export function writeClipboard(clip, storage = safeStorage()) {
  try {
    storage?.setItem(CLIPBOARD_KEY, JSON.stringify(clip))
    return true
  } catch {
    /* Storage can be full or blocked outright by the browser's privacy settings. The
       copy is still in memory and this session can still paste it; only the other tab
       loses out, so this is not worth a toast. */
    return false
  }
}

function safeStorage() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}
