/*
 * Presenter view: just the diagram, and the walkthrough's paths along the bottom.
 *
 * Not persisted -- reloading into a half-hidden app would look broken -- but shared, for the same reason
 * the preferences are: every pane and the strip above them have to agree on whether it is on. Entering
 * folds both sidebars away and leaving puts them back as they were, so presenting never costs anyone
 * their layout. While it is on, the sidebars' own edge toggles keep working, which is how either one is
 * brought back mid-talk.
 */

import { INSPECTOR_OPEN, PALETTE_OPEN } from './preferences.js'

let on = false
let before = null
const listeners = new Set()

const emit = () => listeners.forEach((listener) => listener())

export const PRESENTER = {
  get: () => on,
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  set(next) {
    if (Boolean(next) === on) return
    on = Boolean(next)
    if (on) {
      before = { palette: PALETTE_OPEN.get(), inspector: INSPECTOR_OPEN.get() }
      PALETTE_OPEN.set(false)
      INSPECTOR_OPEN.set(false)
    } else {
      if (before) {
        PALETTE_OPEN.set(before.palette)
        INSPECTOR_OPEN.set(before.inspector)
      }
      before = null
      if (globalThis.document?.fullscreenElement) globalThis.document.exitFullscreen?.().catch(() => {})
    }
    emit()
  },
}
