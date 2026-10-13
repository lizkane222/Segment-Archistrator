/*
 * The look a component starts with when it is drawn rather than discovered -- a palette drop, a paste,
 * a node typed into an imported Mermaid flowchart. Its own module so the pure import paths can share
 * it without pulling in Canvas.jsx and React Flow with it. See the note at its use in Canvas.jsx.
 */
export const DROPPED_STYLE = { borderStyle: 'solid', borderWidth: 1, shape: 'rounded' }
