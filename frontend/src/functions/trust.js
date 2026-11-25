/*
 * Whose code may run in this tab.
 *
 * ../functions/runtime.js compiles a function node's `code` with `new Function`, and says
 * plainly that this is not a sandbox: `(function(){}).constructor('return window')()` gets
 * out of the parameter shadowing. That was acceptable while a diagram was only ever one
 * person's own work. It is not now that a diagram can be shared with a workspace
 * (`Diagram.shared_with_workspace`) or arrive as an exported file: opening one and selecting
 * a path would run a stranger's code with this origin's cookies and CSRF token.
 *
 * So code runs only once it is *trusted*, and trust is something this module hands out in
 * exactly three ways:
 *
 *   - the person typed or reset it in the Code tab (`trustCode`, from CodeTab);
 *   - it came out of a diagram the server says is theirs, or a built-in template
 *     (`trustGraphCode`, from useDiagrams);
 *   - they read it and pressed "Allow this code to run" (`trustCode`, from the banner).
 *
 * Trust is keyed on the code *text*, not on the node or the diagram. A diagram someone shared
 * and then edited after being approved is new text, so it is untrusted again -- an approval
 * cannot be turned into a standing licence by changing what it approved.
 *
 * Kept in localStorage (capped) so a reload does not make a person re-approve their own work:
 * a clean saved tab is refetched and re-trusted, but an unsaved one is restored from storage
 * and has no owner to ask.
 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'archistrator.trustedCode.v1'
/* Newest kept, oldest dropped. Entries are whole function bodies, so this bounds the storage
   rather than the number of functions a person can have: a dropped one is simply asked about
   again. */
const MAX_ENTRIES = 200
const MAX_CODE_CHARS = 60_000

export const POLICY = Object.freeze({ enforce: 'enforce', allowAll: 'allow-all' })

let policy = POLICY.enforce
let trusted = null
let version = 0
const listeners = new Set()

function storage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function load() {
  if (trusted) return trusted
  trusted = []
  try {
    const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(raw)) trusted = raw.filter((entry) => typeof entry === 'string')
  } catch {
    trusted = []
  }
  return trusted
}

function persist() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(trusted))
  } catch {
    /* Private mode or a full quota: trust still holds for this page load, which is the part
       that is a security property. Persisting it is a convenience. */
  }
}

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

/** Tests that execute code opt out; nothing in the app calls this. */
export function setCodeTrustPolicy(next) {
  policy = next === POLICY.allowAll ? POLICY.allowAll : POLICY.enforce
  changed()
}

export function resetCodeTrust() {
  trusted = []
  persist()
  changed()
}

export function isCodeTrusted(code) {
  if (policy === POLICY.allowAll) return true
  const text = String(code ?? '')
  if (!text.trim()) return true
  return load().includes(text)
}

export function trustCode(code) {
  const text = String(code ?? '')
  if (!text.trim() || text.length > MAX_CODE_CHARS) return
  const list = load()
  if (list.includes(text)) return
  trusted = [...list.slice(-(MAX_ENTRIES - 1)), text]
  persist()
  changed()
}

/** Trust every function body in a graph this person owns. */
export function trustGraphCode(graph) {
  for (const node of graph?.nodes ?? []) {
    const code = node?.data?.code ?? node?.code
    if (typeof code === 'string') trustCode(code)
  }
}

/** The function bodies in a graph that have not been trusted. */
export function untrustedCode(graph) {
  const out = []
  for (const node of graph?.nodes ?? []) {
    const code = node?.data?.code ?? node?.code
    if (typeof code === 'string' && code.trim() && !isCodeTrusted(code)) out.push(code)
  }
  return out
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A number that changes whenever trust does, for anything memoised over a simulation. */
export function useCodeTrustVersion() {
  return useSyncExternalStore(subscribe, () => version)
}
