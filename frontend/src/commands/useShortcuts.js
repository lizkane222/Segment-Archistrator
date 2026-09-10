/*
 * The keyboard half of the command layer.
 *
 * One window listener, one lookup in the same table the right-click menu reads. A
 * refused command reports the reason the menu would have shown greyed, so pressing
 * cmd-v with an empty clipboard says so rather than doing nothing.
 */

import { useEffect, useRef } from 'react'

import { commandForEvent, runCommand } from './registry.js'

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Is the keystroke meant for a text field?
 *
 * Without this, cmd-a in the inspector's name field selects every node on the canvas
 * instead of the text in the field, and cmd-c copies the selected components instead of
 * the words the user highlighted -- which is worse than a missing feature, because the
 * clipboard then holds something they did not ask for.
 */
function isTyping(target) {
  return Boolean(target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable))
}

/* The one exception. A browser's own cmd-s opens Save Page As, which is a modal file
   dialog over the app and looks like a crash -- so it is intercepted wherever it is
   pressed, including from a field. Every other shortcut belongs to the field, where the
   browser's native behaviour is the correct one. */
const ALWAYS = new Set(['save'])

/**
 * @param context  the command context, rebuilt each render; read through a ref so the
 *                 listener is bound once rather than on every canvas change
 * @param onRefuse called with the reason a command could not run
 * @param enabled  false while a dialog owns the keyboard
 */
export function useShortcuts({ context, onRefuse, enabled = true }) {
  const latest = useRef({ context, onRefuse })
  latest.current = { context, onRefuse }

  useEffect(() => {
    if (!enabled) return undefined

    const onKeyDown = (event) => {
      const command = commandForEvent(event)
      if (!command) return
      if (isTyping(event.target) && !ALWAYS.has(command.id)) return

      /* Before the enablement check, not after: the browser's cmd-s and cmd-a are
         exactly what we are replacing, and letting one through because our version is
         momentarily unavailable is the surprising outcome. */
      event.preventDefault()

      const result = runCommand(command.id, latest.current.context)
      if (!result.ran && result.reason) latest.current.onRefuse?.(result.reason)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
