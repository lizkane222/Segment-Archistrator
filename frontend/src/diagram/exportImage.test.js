import { describe, expect, it } from 'vitest'

import { buildLayout } from '../canvas/layout.js'
import { diagramBounds, exportViewport, fileNameFor } from './exportImage.js'

const ZONES = [
  { id: 'connections', label: 'Connections', order: 0 },
  { id: 'unify', label: 'Unify', order: 1 },
]

describe('diagramBounds', () => {
  it('covers every zone', () => {
    const { nodes } = buildLayout({
      zones: ZONES,
      nodes: [
        { id: 'a', kind: 'source', zone: 'connections', name: 'A' },
        { id: 'b', kind: 'space', zone: 'unify', name: 'B' },
      ],
      edges: [],
    })

    const bounds = diagramBounds(nodes)
    const zones = nodes.filter((node) => node.type === 'zone')
    const lowest = Math.max(...zones.map((z) => z.position.y + z.height))

    expect(bounds.x).toBe(0)
    expect(bounds.y).toBe(0)
    expect(bounds.height).toBe(lowest)
    expect(bounds.width).toBe(Math.max(...zones.map((z) => z.width)))
  })

  it('covers a zone at the size it was resized to', () => {
    /* NodeResizer writes top-level width/height and never touches `style`, so a
       bounds calculation reading only `style` would export a resized zone at its
       original size and clip whatever was dragged into the new space. */
    const bounds = diagramBounds([
      { id: 'zone-connections', type: 'zone', position: { x: 0, y: 0 }, width: 900, height: 700 },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 900, height: 700 })
  })

  it('resolves child positions through their zone, which are relative', () => {
    /* A node at zone-local y: 40 inside a zone at y: 300 is at absolute y: 340.
       Treating the child position as absolute would crop the lower zones. */
    const bounds = diagramBounds([
      { id: 'zone-unify', type: 'zone', position: { x: 0, y: 300 }, style: { width: 400, height: 200 } },
      { id: 'n', parentId: 'zone-unify', position: { x: 40, y: 40 } },
    ])
    expect(bounds).toEqual({ x: 0, y: 300, width: 400, height: 200 })
  })

  it('sums every ancestor, not just the immediate parent', () => {
    /* Segment > Unify > Profiles > a node that pokes 10px out of all three. Resolving
       one level puts it at (40, 40) rather than (60, 60), which is inside Segment --
       so the rectangle stops at 60 and the export loses the node entirely.

       The node has to overhang for this to be visible at all: under-resolving can only
       place a node further up-left, and a node still inside its ancestors changes no
       bound. That is exactly why one level of resolution survived here unnoticed. */
    const bounds = diagramBounds([
      { id: 'zone-segment', type: 'zone', position: { x: 0, y: 0 }, style: { width: 60, height: 60 } },
      {
        id: 'zone-unify',
        type: 'zone',
        parentId: 'zone-segment',
        position: { x: 20, y: 20 },
        style: { width: 40, height: 40 },
      },
      {
        id: 'zone-profiles',
        type: 'zone',
        parentId: 'zone-unify',
        position: { x: 20, y: 20 },
        style: { width: 20, height: 20 },
      },
      {
        id: 'n',
        parentId: 'zone-profiles',
        position: { x: 20, y: 20 },
        measured: { width: 10, height: 10 },
      },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 70, height: 70 })
  })

  it('does not hang on a parent cycle', () => {
    /* The links come from a stored document, so a broken or older client can write a
       pair that point at each other. A wrong rectangle is recoverable; a spin here
       takes the export and the tab with it. */
    const bounds = diagramBounds([
      {
        id: 'zone-a',
        type: 'zone',
        parentId: 'zone-b',
        position: { x: 10, y: 0 },
        style: { width: 10, height: 10 },
      },
      {
        id: 'zone-b',
        type: 'zone',
        parentId: 'zone-a',
        position: { x: 0, y: 10 },
        style: { width: 10, height: 10 },
      },
    ])
    expect(bounds).toEqual({ x: 10, y: 10, width: 10, height: 10 })
  })

  it('grows past a zone when a node was dragged outside it', () => {
    /* `extent: parent` clamps a live drag, but a position restored from a saved
       diagram can sit outside a zone the column layout sized smaller. Cropping it
       out of the export would silently drop real content. */
    const bounds = diagramBounds([
      { id: 'zone-connections', type: 'zone', position: { x: 0, y: 0 }, style: { width: 300, height: 200 } },
      { id: 'n', parentId: 'zone-connections', position: { x: 400, y: 0 } },
    ])
    expect(bounds.width).toBe(600) // 400 + the node's own 200
  })

  it('is null for an empty canvas, so callers can refuse rather than divide by zero', () => {
    expect(diagramBounds([])).toBe(null)
    expect(diagramBounds(undefined)).toBe(null)
  })

  it('prefers the measured size of a node over the layout default', () => {
    const bounds = diagramBounds([
      { id: 'n', position: { x: 0, y: 0 }, measured: { width: 320, height: 90 } },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 320, height: 90 })
  })
})

describe('exportViewport', () => {
  const bounds = { x: 100, y: 50, width: 800, height: 400 }

  it('sizes the image to the diagram plus padding', () => {
    const view = exportViewport(bounds, { pad: 10, scale: 2 })
    expect(view.width).toBe((800 + 20) * 2)
    expect(view.height).toBe((400 + 20) * 2)
  })

  it('places the top-left of the diagram at the padding offset', () => {
    const view = exportViewport(bounds, { pad: 10, scale: 2 })
    expect(view.transform).toBe('translate(-180px, -80px) scale(2)')
    /* Check the arithmetic the transform encodes: bounds.x maps to pad * scale. */
    expect(bounds.x * 2 + -180).toBe(10 * 2)
    expect(bounds.y * 2 + -80).toBe(10 * 2)
  })

  it('scales down rather than exceeding what a browser will rasterise', () => {
    const view = exportViewport({ x: 0, y: 0, width: 10000, height: 1000 }, { pad: 0, maxDim: 4000 })
    expect(view.scale).toBeCloseTo(0.4)
    expect(view.width).toBe(4000)
    expect(view.downscaled).toBe(true)
  })

  it('does not flag a diagram that fit', () => {
    expect(exportViewport(bounds).downscaled).toBe(false)
  })

  it('never produces a zero-pixel image', () => {
    const view = exportViewport({ x: 0, y: 0, width: 0, height: 0 }, { pad: 0 })
    expect(view.width).toBeGreaterThan(0)
    expect(view.height).toBeGreaterThan(0)
  })
})

describe('fileNameFor', () => {
  it('slugifies the diagram name and stamps the date', () => {
    expect(fileNameFor('Acme Corp — Web + Mobile', 'png')).toMatch(
      /^acme-corp-web-mobile-\d{4}-\d{2}-\d{2}\.png$/,
    )
  })

  it('falls back for an unnamed diagram', () => {
    expect(fileNameFor('', 'pdf')).toMatch(/^architecture-/)
    expect(fileNameFor(null, 'pdf')).toMatch(/^architecture-/)
  })

  it('does not produce a name that is all separators', () => {
    expect(fileNameFor('•••', 'png')).toMatch(/^architecture-/)
  })
})
