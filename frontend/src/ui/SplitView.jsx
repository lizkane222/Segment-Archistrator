/*
 * Two panes and a divider you can drag, either way up.
 *
 * Deliberately unaware of what is in the panes. It takes children and a fraction, and its only job
 * is to give the first child that much of the axis and the second the rest. That matters here more
 * than it sounds: the things being split are React Flow canvases, which measure themselves from
 * their container, so anything this component knew about them would end up as a second opinion
 * about their size.
 *
 * ## Why the drag is pointer-capture and not a window listener
 *
 * The pointer stays with the divider even once it has left it, which is what makes a fast drag not
 * fall off -- and the capture is released for us if the gesture is interrupted, so there is no
 * listener to leak. The same reasoning as the connector's waypoint handles.
 *
 * ## Why the fraction is clamped rather than the pixels
 *
 * A fraction survives the window being resized, which a pixel width does not: a divider stored as
 * "620px from the left" ends up off-screen the moment the window narrows, with no way to get it
 * back. Clamped to leave each pane at least `MIN_FRACTION` so neither can be dragged shut -- a pane
 * of zero width is indistinguishable from the split being broken.
 */

import { useCallback, useRef, useState } from 'react'

/* Each pane keeps at least this much. 15% of a 1400px window is 210px, which is narrow but is still
   a diagram rather than a sliver -- and it is recoverable, which zero is not. */
const MIN_FRACTION = 0.15

/*
 * The pane wrappers' classes, named rather than inline, so the one rule they all have to obey can be
 * asserted in a test: **none of them may be a flex container.**
 *
 * That is not stylistic. A pane's own root is a full-height flex column with no `flex-grow`; as a
 * direct flex *item* it shrink-wraps to its content, and the entire workbench renders as a narrow
 * strip with most of the window empty beside it. As a block child it is full width for free. That
 * bug shipped once, so `min-h-0`/`min-w-0` (which let a flex item shrink below its content, and
 * without which a React Flow canvas refuses to) and the absence of `flex` are pinned in
 * SplitView.test.js.
 */
export const SOLO_PANE = 'min-h-0 min-w-0 flex-1'
export const FIRST_PANE = 'min-h-0 min-w-0 overflow-hidden'
export const SECOND_PANE = 'min-h-0 min-w-0 flex-1 overflow-hidden'

export const SPLIT_VERTICAL = 'vertical'
export const SPLIT_HORIZONTAL = 'horizontal'

/**
 * @param orientation  `vertical` puts the panes side by side with a vertical divider between them;
 *   `horizontal` stacks them. Named for the divider, which is how every editor labels this and is
 *   the thing the user is actually pointing at.
 * @param children     exactly two. One child renders alone, filling the frame, so a caller does not
 *   have to special-case the unsplit state.
 */
export default function SplitView({ orientation = SPLIT_VERTICAL, children }) {
  const panes = Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean)
  const [fraction, setFraction] = useState(0.5)
  const frame = useRef(null)

  const vertical = orientation === SPLIT_VERTICAL

  const startDrag = useCallback(
    (event) => {
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture?.(event.pointerId)

      const at = (moveEvent) => {
        const box = frame.current?.getBoundingClientRect()
        if (!box) return null
        const along = vertical
          ? (moveEvent.clientX - box.left) / box.width
          : (moveEvent.clientY - box.top) / box.height
        return Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, along))
      }

      const onMove = (moveEvent) => {
        const next = at(moveEvent)
        if (next !== null) setFraction(next)
      }
      const onUp = () => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerup', onUp)
        element.removeEventListener('pointercancel', onUp)
      }
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerup', onUp)
      element.addEventListener('pointercancel', onUp)
    },
    [vertical],
  )

  /*
   * One pane fills the frame.
   *
   * A *block* wrapper, deliberately, and not `flex` -- which is what this was and is what broke the
   * whole window's layout. The pane's own root is a full-height flex column; as a direct flex *item*
   * of a row it has no `flex-grow`, so it shrink-wrapped to its content and the workbench rendered as
   * a narrow column with most of the window empty beside it. As a block child it is full width for
   * free, which is also exactly how the two panes below get their width.
   *
   * No `overflow-hidden` either, unlike the split panes below. There the clip is what keeps one
   * pane's contents out of the other; here there is nothing to clip against, and adding one would
   * silently change what a single workbench is allowed to overflow -- which it did not have to worry
   * about before this component existed.
   */
  if (panes.length < 2) {
    return (
      <div ref={frame} className={SOLO_PANE}>
        {panes[0] ?? null}
      </div>
    )
  }

  return (
    <div
      ref={frame}
      className={`flex min-h-0 min-w-0 flex-1 ${vertical ? 'flex-row' : 'flex-col'}`}
    >
      {/* `flexBasis` with `flexGrow: 0`, not a width: the panes are flex children, and a width on a
          flex child is a suggestion that `flex-1` on its sibling overrides. `minWidth: 0` is the
          other half -- without it a flex child refuses to shrink below its content, and a React Flow
          canvas reports a very wide content. */}
      <div className={FIRST_PANE} style={{ flex: `0 0 ${fraction * 100}%` }}>
        {panes[0]}
      </div>

      <div
        role="separator"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-label="Resize the split"
        onPointerDown={startDrag}
        /* `nodrag nopan` even though this is outside the canvas: in a split the divider sits between
           two React Flow instances, and a pointerdown that reached either of them would start a
           pan while the divider was being dragged. */
        className={`nodrag nopan shrink-0 bg-twilio-gray-20 transition-colors hover:bg-twilio-blue ${
          vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        }`}
      />

      <div className={SECOND_PANE}>{panes[1]}</div>
    </div>
  )
}
