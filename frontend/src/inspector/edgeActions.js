/*
 * The connector's right-click menu, as the sidebar shows it.
 *
 * Read from the command table rather than written out again, so the sidebar and the menu cannot
 * disagree: a command added to the connector menu appears here with no second place to update, is
 * refused here for the same reason with the same sentence, and runs through the same `runCommand`.
 * The menu is still where a right-click goes; this is where a reader who never right-clicks finds
 * the same things.
 *
 * Pure -- a list of rows from a context -- so the parity is testable without a DOM.
 */

import { EDGE_MENU, commandsFor } from '../commands/registry.js'

/**
 * One row per top-level connector command, each either a button or a group of buttons.
 *
 * @returns `[{id, label, enabled, reason, group, preview, children}]` -- `children` is null for a
 *   plain button and a list of the same shape for a submenu, which the sidebar lays out as a row of
 *   options rather than a flyout.
 */
export function edgeActionRows(ctx) {
  if (!ctx?.edge) return []
  return commandsFor(EDGE_MENU, ctx)
}

/** Every runnable command id the rows offer, submenus flattened -- what the parity test compares. */
export function edgeActionIds(rows) {
  const ids = []
  for (const row of rows ?? []) {
    if (row.children?.length) ids.push(...edgeActionIds(row.children))
    else ids.push(row.id)
  }
  return ids
}
