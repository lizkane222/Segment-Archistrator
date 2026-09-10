/*
 * PNG / PDF export of the canvas.
 *
 * Three things here are deliberate and each cost a wrong first attempt elsewhere:
 *
 *  1. `html-to-image`, not `html2canvas`. Tailwind 4's default palette emits
 *     `oklch()` colours, and html2canvas has its own CSS colour parser that does
 *     not understand them -- it throws. html-to-image inlines the DOM into an SVG
 *     `foreignObject` and lets the browser do the painting, so any CSS the browser
 *     supports works by construction. This is also React Flow's own recipe.
 *
 *  2. The whole diagram, not the visible part. `.react-flow__viewport` is captured
 *     with our own transform substituted for React Flow's, computed from the
 *     bounds of every node. Exporting what happens to be on screen would make the
 *     output depend on where the user last scrolled.
 *
 *  3. Bounds are computed here rather than taken from React Flow's
 *     `getNodesBounds`. Zone group nodes carry explicit dimensions, children are
 *     positioned relative to their zone, and React Flow's helper needs a
 *     `nodeLookup` to resolve that -- which only exists inside the hook. The
 *     layout invariants are known (see canvas/layout.js), so unioning them here is
 *     both simpler and testable without a DOM.
 *
 * The caller is responsible for one thing this module cannot do: the canvas runs
 * with `onlyRenderVisibleElements`, so offscreen nodes are not in the DOM at all.
 * Culling has to be off *before* the capture, or the export silently omits
 * whatever was scrolled out of frame. See `waitForRender` and AppShell's
 * `exporting` flag.
 */

import { NODE_HEIGHT, NODE_WIDTH, zoneSize } from '../canvas/layout.js'

const PAD = 48 // diagram units of whitespace around the drawing
const SCALE = 2 // 2x for legible text in a deck or a PDF
const MAX_DIM = 8000 // browsers refuse to rasterise canvases much past this

/**
 * A node's absolute position, by summing every ancestor's offset.
 *
 * React Flow positions are parent-relative at *every* level, so a component in
 * Profiles, inside Unify, inside Segment is offset three times. Resolving one level
 * -- which was the whole story while zones were flat -- places it short of where the
 * DOM actually draws it.
 *
 * Short, and therefore always further inside the outer zone, which is why this hid:
 * whenever everything sits within its ancestors the crop rectangle comes out the same
 * either way. It bites on the one case this module already exists to handle -- a node
 * outside its zone's extent -- where the rectangle is then computed too small and the
 * export loses that node off the edge.
 *
 * Cycle-guarded for the same reason `topology.zone_chain` and `rules.zoneChain` are:
 * the walk follows links from a document that may have been written by an older or
 * a broken client, and a hang is a worse failure than a wrong offset.
 */
function absolutePosition(node, zones) {
  let x = node.position?.x ?? 0
  let y = node.position?.y ?? 0

  const seen = new Set([node.id])
  let parent = node.parentId ? zones.get(node.parentId) : null
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    x += parent.position?.x ?? 0
    y += parent.position?.y ?? 0
    parent = parent.parentId ? zones.get(parent.parentId) : null
  }

  return { x, y }
}

/**
 * The rectangle enclosing every node, in flow coordinates.
 *
 * Zones nest and components are zone-local, so every position is resolved through
 * `absolutePosition`. A component outside its zone's edge is still included, and there
 * are two ways to get there: a restored position in a zone the column layout sized
 * smaller, and -- now that nothing clamps a drag to its parent -- a component simply
 * dragged out. Cropping either out of the export would hide real content.
 */
export function diagramBounds(nodes) {
  const zones = new Map()
  for (const node of nodes ?? []) {
    if (node.type === 'zone') zones.set(node.id, node)
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const include = (x, y, w, h) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }

  for (const node of nodes ?? []) {
    const { x, y } = absolutePosition(node, zones)

    if (node.type === 'zone') {
      /* Through `zoneSize`, so a resized zone exports at the size it renders at --
         NodeResizer writes top-level width/height and never touches `style`. */
      const size = zoneSize(node)
      include(x, y, size.width || NODE_WIDTH, size.height || NODE_HEIGHT)
    } else {
      include(
        x,
        y,
        node.measured?.width ?? node.width ?? NODE_WIDTH,
        node.measured?.height ?? node.height ?? NODE_HEIGHT,
      )
    }
  }

  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The transform and image size that fit `bounds` onto a bitmap.
 *
 * Pure, and simpler than React Flow's `getViewportForBounds` because the image is
 * sized to the diagram rather than the diagram fitted into a fixed frame: there is
 * no centering and no zoom clamp, only a downscale when the result would exceed
 * what a browser will rasterise.
 */
export function exportViewport(bounds, { pad = PAD, scale = SCALE, maxDim = MAX_DIM } = {}) {
  const contentWidth = bounds.width + pad * 2
  const contentHeight = bounds.height + pad * 2
  const fitted = Math.min(scale, maxDim / contentWidth, maxDim / contentHeight)

  return {
    scale: fitted,
    width: Math.max(1, Math.round(contentWidth * fitted)),
    height: Math.max(1, Math.round(contentHeight * fitted)),
    /* A content point p lands at (p - bounds.min + pad) * scale. With
       `translate(t) scale(s)` the translation is in unscaled parent pixels and is
       applied after the scale, so t = (pad - min) * s. */
    transform: `translate(${(pad - bounds.x) * fitted}px, ${(pad - bounds.y) * fitted}px) scale(${fitted})`,
    /* True when the diagram was too large to render at full scale. Worth telling
       the user, because the symptom is unreadably small text. */
    downscaled: fitted < scale,
  }
}

/** Two frames: one for React to commit the pending render, one for the browser to paint it. */
export function waitForRender() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

export function fileNameFor(name, extension) {
  const slug =
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'architecture'
  const stamp = new Date().toISOString().slice(0, 10)
  return `${slug}-${stamp}.${extension}`
}

/**
 * Render the canvas to a PNG data URL.
 *
 * @param nodes       React Flow nodes, zone backdrops included
 * @param background  page colour; the dotted Background sits outside the viewport
 *                    element and is not captured, so without this the PNG is
 *                    transparent and unreadable on a dark slide
 */
export async function renderPng(nodes, { background = '#ffffff', ...options } = {}) {
  const element = document.querySelector('.react-flow__viewport')
  if (!element) throw new Error('The canvas is not on screen, so there is nothing to export.')

  const bounds = diagramBounds(nodes)
  if (!bounds) throw new Error('There is nothing on the canvas to export yet.')

  const view = exportViewport(bounds, options)
  const { toPng } = await import('html-to-image')

  const dataUrl = await toPng(element, {
    backgroundColor: background,
    width: view.width,
    height: view.height,
    /* pixelRatio 1 because `scale` is already baked into the transform. Leaving it
       at the device default would multiply the two and blow past MAX_DIM. */
    pixelRatio: 1,
    style: {
      width: `${view.width}px`,
      height: `${view.height}px`,
      transform: view.transform,
      transformOrigin: '0 0',
    },
  })

  return { dataUrl, ...view }
}

export async function exportPng(nodes, { name, ...options } = {}) {
  const result = await renderPng(nodes, options)
  download(result.dataUrl, fileNameFor(name, 'png'))
  return result
}

export async function exportPdf(nodes, { name, ...options } = {}) {
  const result = await renderPng(nodes, options)
  const { jsPDF } = await import('jspdf')

  /* One page, sized to the drawing. A fixed A4 landscape page would letterbox a
     wide architecture down to illegibility, and these are read on screen far more
     often than they are printed. */
  const doc = new jsPDF({
    orientation: result.width >= result.height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [result.width, result.height],
  })
  doc.addImage(result.dataUrl, 'PNG', 0, 0, result.width, result.height)
  doc.save(fileNameFor(name, 'pdf'))
  return result
}

function download(dataUrl, fileName) {
  const link = document.createElement('a')
  link.download = fileName
  link.href = dataUrl
  link.click()
}
