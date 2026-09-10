/*
 * "This component is the one the message is about."
 *
 * A placement note names a kind and a name -- "Destination 'Destination' is in Engage"
 * -- and on a diagram with three destinations that is very nearly no information at
 * all. The reader has to find it themselves, which on a large architecture means
 * reading every box. So the note points: the component's border pulses for a couple of
 * seconds, and the answer to "which one?" costs nothing.
 *
 * Built as an external store read through `useSyncExternalStore`, for exactly the
 * reason canvas/anchors.js is -- see the long note at the top of that file. React Flow
 * re-renders every node on any store change, so holding this in React state would put
 * a whole-canvas render on a toast. Each subscriber's snapshot is a boolean about
 * *itself*, so flashing one node in a 300-node diagram re-renders one node.
 *
 * Deliberately not in each node's `data`: it is transient, and `serializeNode` spreads
 * all of `data` into the saved document. A flag in there would either be persisted --
 * a diagram remembering that it was once complained about -- or would need a third
 * entry in RUNTIME_NODE_KEYS to strip it, which is a worse place to have to remember
 * something than here.
 *
 * The timer is per-id rather than one shared timeout. Two notes arriving a second
 * apart should each get a full pulse: a shared timer would cut the second one short,
 * and cutting short the *later* message is backwards.
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

/* Long enough to notice on a diagram you have to look across, short enough that it is
   over before it becomes the thing you are looking at. Matches the `flash-border`
   keyframes in styles/tokens.css: three pulses at 600ms. */
export const FLASH_MS = 1800

export function createFlash({ duration = FLASH_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  /* id -> timer handle. The map is the state: membership is "is flashing", and the
     handle is what makes re-flashing an already-flashing node restart it rather than
     leave the original timer to stop it early. */
  const timers = new Map()
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const stop = (id) => {
    const timer = timers.get(id)
    if (timer === undefined) return false
    cancel(timer)
    timers.delete(id)
    return true
  }

  return {
    flashing: (id) => id != null && timers.has(id),
    /**
     * Start (or restart) the pulse on every id given.
     *
     * Nulls are dropped rather than rejected: the caller is zipping a list of messages
     * against a list of ids, and the truncation line -- "...and 4 more." -- has no id
     * on purpose, because it stands for several components and pointing at one of them
     * would be worse than pointing at none.
     */
    flash: (ids) => {
      const wanted = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null)
      if (wanted.length === 0) return
      for (const id of wanted) {
        stop(id)
        timers.set(
          id,
          schedule(() => {
            timers.delete(id)
            emit()
          }, duration),
        )
      }
      emit()
    },
    /* Used when the canvas is replaced under us: a pulse pointing at a component from
       the previous document is worse than no pulse. */
    clear: () => {
      if (timers.size === 0) return
      for (const id of [...timers.keys()]) stop(id)
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/* A real store, not null, so a node renderer used outside a provider still has
   something to call -- the same reasoning as anchors.js's NO_FOCUS. */
const NO_FLASH = createFlash()

export const FlashContext = createContext(NO_FLASH)

export function useFlash() {
  return useContext(FlashContext)
}

/** Whether this component is pulsing -- a boolean, so the rest do not re-render. */
export function useFlashing(id) {
  const flash = useFlash()
  return useSyncExternalStore(flash.subscribe, () => flash.flashing(id))
}
