/*
 * Profiles kept in the sidebar: a person, as the identifiers and traits that make an event theirs.
 *
 * The Events tab builds a payload from a skeleton, and every skeleton says `user_1234`. Anyone telling a
 * story about *one* customer -- the same person arriving anonymously, identifying, ordering -- has been
 * retyping their ids into each. A saved profile is those ids and traits, kept once; choosing one pours
 * them into whichever payload is being edited, and the events saved while it is chosen are filed under it
 * and wear its colour, so "what happened to Avery" is a click rather than a search.
 *
 * In the browser, like the saved events: a fixture reached for across diagrams, not a fact about one.
 * Profile *components* on a diagram carry a pasted snapshot of a real Unify profile; those can be copied
 * in here with `profileFromSnapshot`.
 */

import { preference } from '../ui/preferences.js'

/* Distinct at a glance, and none of them the red or green the canvas uses for dropped and delivered. */
export const PROFILE_COLOURS = ['#0263e0', '#8b46c1', '#e67e22', '#0d9488', '#d6336c', '#5f6b7a', '#7c5e10', '#1c7ed6']

/** `[{id, name, color, identifiers: [{type, id}], traits: {}}]` */
export const SAVED_PROFILES = preference('saved-profiles', [])
/** The profile whose ids are being poured into payloads, or null. */
export const ACTIVE_PROFILE = preference('active-profile', null)

export const profilesIn = (stored) => (Array.isArray(stored) ? stored.filter((entry) => entry?.id) : [])

/** The first colour not yet worn by a saved profile, cycling once they are all taken. */
export function nextColour(list) {
  const used = new Set(profilesIn(list).map((entry) => entry.color))
  return PROFILE_COLOURS.find((colour) => !used.has(colour)) ?? PROFILE_COLOURS[profilesIn(list).length % PROFILE_COLOURS.length]
}

export function newProfile({ name, identifiers = [], traits = {} }, list = []) {
  return {
    id: `profile:${Math.random().toString(36).slice(2, 10)}`,
    name: String(name ?? '').trim() || 'Profile',
    color: nextColour(list),
    identifiers: identifiers.filter((entry) => entry?.type && String(entry.id ?? '').trim()),
    traits: traits && typeof traits === 'object' && !Array.isArray(traits) ? traits : {},
  }
}

/** A saved profile from a Profile component's pasted snapshot (see inspector/profileSnapshot.js). */
export function profileFromSnapshot(snapshot, name, list = []) {
  const identifiers = (snapshot?.identifiers ?? []).map((entry) => ({ type: entry.type, id: entry.id }))
  return newProfile({ name, identifiers, traits: snapshot?.traits ?? {} }, list)
}

const idOf = (profile, ...types) =>
  profile?.identifiers?.find((entry) => types.includes(entry.type))?.id

/**
 * A payload with the profile's ids and traits in it.
 *
 * `user_id` and `anonymous_id` become `userId` and `anonymousId` -- left out entirely when the profile has
 * none, rather than keeping the skeleton's `user_1234`, which would silently put somebody else in the
 * event. Every other identifier (an email, a phone) rides in the traits, which is where an identify call
 * carries them. Traits go to `traits` on an identify or group and to `context.traits` on anything else,
 * which is where the Spec allows them.
 */
export function applyProfile(payload, profile) {
  if (!profile || !payload || typeof payload !== 'object') return payload
  const next = { ...payload }

  const userId = idOf(profile, 'user_id', 'userId')
  const anonymousId = idOf(profile, 'anonymous_id', 'anonymousId')
  if (userId) next.userId = userId
  else delete next.userId
  if (anonymousId) next.anonymousId = anonymousId
  else delete next.anonymousId

  const extra = {}
  for (const entry of profile.identifiers ?? []) {
    if (['user_id', 'userId', 'anonymous_id', 'anonymousId'].includes(entry.type)) continue
    extra[entry.type] = entry.id
  }
  const traits = { ...extra, ...(profile.traits ?? {}) }

  if (Object.keys(traits).length) {
    if (next.type === 'identify' || next.type === 'group') next.traits = { ...(next.traits ?? {}), ...traits }
    else if (next.type !== 'alias') next.context = { ...(next.context ?? {}), traits: { ...(next.context?.traits ?? {}), ...traits } }
  }
  return next
}

/** One line for a card: the first couple of identifiers. */
export function summary(profile) {
  const ids = (profile.identifiers ?? []).slice(0, 2).map((entry) => `${entry.type}: ${entry.id}`)
  const more = (profile.identifiers?.length ?? 0) - ids.length
  return ids.join(' · ') + (more > 0 ? ` +${more}` : '') || 'no identifiers'
}
