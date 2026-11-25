/*
 * Hand keyboard focus back to the selection after something that was not the canvas took it.
 *
 * React Flow moves the selected components on an arrow key only when one of the *nodes* has focus.
 * Pressing a toolbar button or a menu row moves focus onto that control, so after "Align left" the
 * selection was intact but the arrow keys did nothing until every component was selected again.
 * One frame later -- after the action's own render has landed -- the first selected node gets focus
 * back, without scrolling the page to it.
 */
export function refocusSelection(root = globalThis.document) {
  if (!root?.querySelector) return
  const focus = () => {
    const node = root.querySelector('.react-flow__node.selected')
    node?.focus?.({ preventScroll: true })
  }
  globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(focus))
}
