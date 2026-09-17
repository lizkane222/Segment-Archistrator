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

  const solo = panes.length < 2

  /*
   * One shape for both cases, and this is load-bearing rather than tidy.
   *
   * These two states used to be separate `return`s: a lone `<div className={SOLO_PANE}>` holding the
   * pane, versus a flex row whose *first child was a wrapper div*. Going from two panes to one --
   * closing a tab in a split, or turning the split off -- therefore changed the element at child index
   * 0 from a `div` to the pane itself. React reconciles by position and type, so a type change there
   * unmounts the whole subtree and mounts a fresh one.
   *
   * That is not a cosmetic flicker. A Workbench captures its live graph and document in an unmount
   * cleanup and reloads them from the tab record on mount, and the capture lands in state *after* the
   * render that created the replacement -- so the remounted pane re-applied the graph as it was before
   * the edits, and reverted the diagram's name with it. Closing one pane silently discarded the work
   * in the other.
   *
   * So the pane always sits inside a wrapper div at child index 0, and only the wrapper's class and
   * its two siblings change. The panes are then reconciled in place and nothing unmounts.
   *
   * `false` in a children array still occupies a slot, which is why the two conditional siblings are
   * written as `{!solo && ...}` rather than being spread in or omitted.
   */
  return (
    <div
      ref={frame}
      className={`flex min-h-0 min-w-0 flex-1 ${vertical ? 'flex-row' : 'flex-col'}`}
    >
      {/* Split: `flexBasis` with `flexGrow: 0`, not a width -- the panes are flex children, and a
          width on a flex child is a suggestion that `flex-1` on its sibling overrides. `min-w-0` is
          the other half: without it a flex child refuses to shrink below its content, and a React
          Flow canvas reports a very wide content.
          Solo: `flex-1` and no inline basis, so it simply fills the frame. */}
      <div
        className={solo ? SOLO_PANE : FIRST_PANE}
        style={solo ? undefined : { flex: `0 0 ${fraction * 100}%` }}
      >
        {panes[0] ?? null}
      </div>

      {!solo && (
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
      )}

      {!solo && <div className={SECOND_PANE}>{panes[1]}</div>}
    </div>
  )
}
