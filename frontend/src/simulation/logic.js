/*
 * Three-valued logic for simulation verdicts.
 *
 * The invariant this module exists to protect:
 *
 *   TRUE and FALSE mean "definitely, under EVERY profile history consistent with
 *   the simulated event". UNKNOWN means "this one event does not settle it".
 *
 * That is a stronger claim than it looks, and it is the whole reason the
 * simulator can be trusted. A single `track` call cannot tell you whether a
 * profile is in an audience defined as `event('X').count() >= 3` -- the profile
 * may already hold two. Reporting FALSE there would be a lie the user would
 * reasonably act on ("why isn't this audience matching?"), so it reports UNKNOWN.
 *
 * Kleene's strong three-valued tables preserve the invariant through AND/OR/NOT
 * without any extra care at the call sites: if every leaf is definite-under-all-
 * histories, so is every composition of them. The monotonicity reasoning that
 * decides which leaves get to be definite lives in audienceQuery.js, not here.
 *
 * UNKNOWN carries its reasons because "not evaluated" with no explanation is the
 * failure mode the plan's risk table calls out -- a user seeing a blank verdict
 * assumes the tool is broken, not that their query is outside the subset.
 */

export const TRUE = 'true'
export const FALSE = 'false'
export const UNKNOWN = 'unknown'

/* Why a verdict is UNKNOWN. Both behave identically in the logic tables and are
   reported differently: `history` is an honest limit of simulating one event,
   `unsupported` is a limit of this interpreter. Users can act on the second by
   reading the query themselves; the first is inherent. */
export const HISTORY = 'history'
export const UNSUPPORTED = 'unsupported'

export function definite(value) {
  return { value: value ? TRUE : FALSE, reasons: [] }
}

export const yes = () => definite(true)
export const no = () => definite(false)

export function unknown(cause, note) {
  return { value: UNKNOWN, reasons: [{ cause, note }] }
}

export const dependsOnHistory = (note) => unknown(HISTORY, note)
export const notSupported = (note) => unknown(UNSUPPORTED, note)

export function isUnknown(verdict) {
  return verdict?.value === UNKNOWN
}

/* Reasons are collected only from the operands that are actually load-bearing.
   In `FALSE AND UNKNOWN` the result is FALSE regardless of the unknown, so
   carrying its reason forward would explain a decision it did not influence. */
export function and(operands) {
  if (operands.some((operand) => operand.value === FALSE)) return no()
  const unknowns = operands.filter(isUnknown)
  if (unknowns.length > 0) return mergeUnknown(unknowns)
  return yes()
}

export function or(operands) {
  if (operands.some((operand) => operand.value === TRUE)) return yes()
  const unknowns = operands.filter(isUnknown)
  if (unknowns.length > 0) return mergeUnknown(unknowns)
  return no()
}

export function not(verdict) {
  if (verdict.value === TRUE) return no()
  if (verdict.value === FALSE) return yes()
  return { value: UNKNOWN, reasons: verdict.reasons }
}

function mergeUnknown(unknowns) {
  const reasons = []
  const seen = new Set()
  for (const operand of unknowns) {
    for (const reason of operand.reasons) {
      const key = `${reason.cause}:${reason.note}`
      if (seen.has(key)) continue
      seen.add(key)
      reasons.push(reason)
    }
  }
  return { value: UNKNOWN, reasons }
}

/**
 * The dominant cause across an UNKNOWN verdict's reasons.
 *
 * `unsupported` wins ties: if any part of a query could not be parsed, saying
 * "depends on profile history" would imply the tool understood the query and
 * merely lacked data, which is the more flattering and less useful of the two.
 */
export function dominantCause(verdict) {
  if (!isUnknown(verdict)) return null
  return verdict.reasons.some((reason) => reason.cause === UNSUPPORTED) ? UNSUPPORTED : HISTORY
}

export function explain(verdict) {
  return (verdict?.reasons ?? []).map((reason) => reason.note).filter(Boolean)
}
