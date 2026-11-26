/*
 * The zoom the whole app is drawn at.
 *
 * Defaults to 80%, which is how this app is used on every screen it runs on; browser zoom would do
 * it but has to be set per site on every machine, and resets in a fresh profile. Stored as a
 * preference so it is one line to change (`localStorage['segment-builder:pref:ui-scale']`, e.g.
 * `1` for 100%) until there is a setting for it.
 *
 * Applied through a CSS variable read by `#root` in tokens.css. Held to a sane range so a bad stored
 * value cannot make the app unreadable or unusably large.
 */

import { preference } from './preferences.js'

export const DEFAULT_UI_SCALE = 0.8
export const MIN_UI_SCALE = 0.5
export const MAX_UI_SCALE = 1.5

export const UI_SCALE = preference('ui-scale', DEFAULT_UI_SCALE)

export function clampScale(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_UI_SCALE
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, number))
}

export function applyUiScale(root = globalThis.document?.documentElement) {
  root?.style.setProperty('--ui-scale', String(clampScale(UI_SCALE.get())))
}
