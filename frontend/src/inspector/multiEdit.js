/*
 * Editing several selected things from the sidebar at once.
 *
 * Two questions, both pure so they can be tested rather than clicked through:
 *
 *   - which ids does an edit reach? (`editTargets`)
 *   - what should the panel show when those things disagree? (`shared`)
 *
 * ## Which ids
 *
 * The panel is headed with one thing -- the one last clicked, "the inspected one". When that thing
 * is *part of* a multi-selection the edit goes to the whole selection; when it is not (the panel
 * was opened another way, or the selection moved on) it goes to the inspected one alone. A panel
 * headed with one connector's name must not quietly restyle four others it is not about.
 *
 * ## What to show
 *
 * A control shows a value, and a group has several. If every item agrees, that is the value and the
 * control looks exactly as it does for one item. If they disagree there is no honest single value,
 * so `shared` says `mixed` and the control shows nothing as chosen -- pressing any option then
 * visibly makes them agree, which is the whole point of the control.
 */

/**
 * @param selectedIds ids of everything selected, of the kind being edited
 * @param inspectedId the id the panel is about
 * @returns the ids to write to; always at least `[inspectedId]` when there is one
 */
export function editTargets(selectedIds, inspectedId) {
  const selected = selectedIds ?? []
  if (!inspectedId) return selected
  return selected.includes(inspectedId) && selected.length > 1 ? selected : [inspectedId]
}

/**
 * The value every item agrees on, or `{mixed: true}`.
 *
 * Compared with `Object.is`-style strict equality on primitives, and by JSON for anything else
 * (an array of waypoints, say), so two equal-looking objects are not called different.
 */
export function shared(items, read) {
  const list = items ?? []
  if (!list.length) return { mixed: false, value: undefined }
  const key = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value)
  const first = read(list[0])
  const mixed = list.some((item) => key(read(item)) !== key(first))
  return mixed ? { mixed: true, value: undefined } : { mixed: false, value: first }
}
