/*
 * The palettes are data, so most of what is worth testing is the arithmetic that
 * derives a style from one of them -- and one property that has to hold across all 170
 * colours at once: every fill gets a label colour a customer can actually read.
 */

import { describe, expect, it } from 'vitest'

import { KIND_STYLES } from './kinds.js'
import {
  FAMILIES,
  PALETTES,
  applyPaletteToNodes,
  clearPaletteFromNodes,
  contrast,
  familyOf,
  luminance,
  mix,
  paletteByKey,
  paletteStyles,
  parseHex,
  readableText,
  styleForColor,
} from './palettes.js'

describe('PALETTES', () => {
  it('holds all 34 schemes, each with five parseable colours', () => {
    expect(PALETTES).toHaveLength(34)
    for (const palette of PALETTES) {
      expect(palette.colors, palette.name).toHaveLength(5)
      for (const color of palette.colors) expect(parseHex(color), `${palette.name} ${color}`).toBeTruthy()
    }
  })

  it('has a unique key per palette', () => {
    /* The key is what the UI passes back and what `paletteByKey` resolves, so a
       duplicate would silently theme the canvas with the wrong one of the pair. */
    expect(new Set(PALETTES.map((p) => p.key)).size).toBe(PALETTES.length)
  })
})

describe('parseHex', () => {
  it('reads six digits, three digits, and a missing hash', () => {
    expect(parseHex('#BEDAE3')).toEqual({ r: 190, g: 218, b: 227 })
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseHex('ffffff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('refuses anything else rather than guessing', () => {
    for (const value of ['', null, undefined, 'red', '#12345', 'rgb(1,2,3)', '#gggggg']) {
      expect(parseHex(value), String(value)).toBeNull()
    }
  })
})

describe('mix', () => {
  it('interpolates in sRGB', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('clamps out-of-range amounts to the two endpoints', () => {
    expect(mix('#112233', '#ffffff', -1)).toBe('#112233')
    expect(mix('#112233', '#ffffff', 5)).toBe('#ffffff')
  })

  it('returns the original when either end is unparseable', () => {
    expect(mix('#112233', 'nonsense', 0.5)).toBe('#112233')
  })
})

describe('luminance', () => {
  it('weights the channels, so yellow is bright and blue is not', () => {
    /* Half the point of the correction. Yellow and blue have the same naive average and
       nothing like the same brightness, and treating them alike is what puts white text
       on a yellow node. */
    expect(luminance('#ffff00')).toBeGreaterThan(0.9)
    expect(luminance('#0000ff')).toBeLessThan(0.1)
  })

  it('is gamma-corrected, not linear in the sRGB value', () => {
    /* The other half, and the one the channel weights do not cover: mid-grey is 50% of
       the way up the sRGB scale and about 22% of the way up in light. A version that
       skipped the transfer function would answer 0.5 here and still pass every
       yellow-versus-blue check, so this is the assertion that pins it. */
    expect(luminance('#808080')).toBeLessThan(0.25)
    expect(luminance('#808080')).toBeGreaterThan(0.18)
  })

  it('is 0 for black and 1 for white', () => {
    expect(luminance('#000000')).toBeCloseTo(0, 5)
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('contrast', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#7F803E', '#7F803E')).toBeCloseTo(1, 5)
  })

  it('does not depend on the order of its arguments', () => {
    expect(contrast('#18363E', '#93C4D1')).toBeCloseTo(contrast('#93C4D1', '#18363E'), 10)
  })
})

describe('readableText', () => {
  it('picks the darker ink on a light fill and the lighter one on a dark fill', () => {
    expect(readableText('#FFFBF2')).toBe('#121c2d')
    expect(readableText('#0F0E11')).toBe('#ffffff')
  })

  it('falls back to black where neither navy nor white reaches AA', () => {
    /* Cottagecore's olive is the case that forced the third candidate: 4.15:1 against
       white and less against navy, so the preferred pair cannot carry it. */
    expect(readableText('#7F803E')).toBe('#000000')
    expect(contrast(readableText('#7F803E'), '#7F803E')).toBeGreaterThanOrEqual(4.5)
  })

  it('reaches AA on every colour in every palette', () => {
    /* The property the whole module exists to guarantee. 170 fills, and a diagram gets
       exported to a PDF that a customer reads -- one unreadable label is a real defect,
       and it would only ever be noticed on the palette nobody demoed. */
    for (const palette of PALETTES) {
      for (const color of palette.colors) {
        const { bg, text } = styleForColor(color)
        expect(contrast(text, bg), `${palette.name} ${color}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('styleForColor', () => {
  it('makes the colour the fill, not the border', () => {
    /* The opposite of kinds.js's defaults, which are white cards with a coloured edge.
       Applied that way a palette would be five shades of white. */
    expect(styleForColor('#BEDAE3').bg).toBe('#bedae3')
  })

  it('darkens the border on a light fill and lightens it on a dark one', () => {
    const light = styleForColor('#FFFBF2')
    expect(luminance(light.border)).toBeLessThan(luminance(light.bg))

    /* Ocean and Black are the reason for the flip: a border darker than an
       already-near-black fill is no border at all. */
    const dark = styleForColor('#18363E')
    expect(luminance(dark.border)).toBeGreaterThan(luminance(dark.bg))
  })

  it('keeps every border visibly distinct from its own fill', () => {
    for (const palette of PALETTES) {
      for (const color of palette.colors) {
        const { bg, border } = styleForColor(color)
        expect(contrast(border, bg), `${palette.name} ${color}`).toBeGreaterThanOrEqual(1.8)
      }
    }
  })

  it('says nothing about shape', () => {
    /* Shape is the axis that survives recolouring, and once a source and a source
       function share a family colour it is the only thing left telling them apart. */
    expect(styleForColor('#BEDAE3')).not.toHaveProperty('shape')
  })

  it('returns null for a colour it cannot parse', () => {
    /* Rather than a style full of undefined, which a caller would write into
       `data.style` and blank the node out with. */
    expect(styleForColor('nonsense')).toBeNull()
    expect(styleForColor(undefined)).toBeNull()
  })
})

describe('paletteStyles', () => {
  it('takes a palette or its key', () => {
    expect(paletteStyles('ocean')).toEqual(paletteStyles(paletteByKey('ocean')))
  })

  it('styles every kind that has a family, and no others', () => {
    const styles = paletteStyles('pastel')
    for (const kind of Object.keys(KIND_STYLES)) {
      if (familyOf(kind)) expect(styles, kind).toHaveProperty(kind)
      else expect(styles, kind).not.toHaveProperty(kind)
    }
  })

  it('leaves a custom component alone', () => {
    /* Its grey says "the customer runs this, not Segment". One of Segment's five
       family colours would say the opposite. */
    expect(familyOf('custom')).toBeNull()
    expect(paletteStyles('ocean')).not.toHaveProperty('custom')
  })

  it('gives kinds in one family the same colour and different families different ones', () => {
    const styles = paletteStyles('ocean')
    expect(styles.source).toEqual(styles.profile_source)
    expect(styles.source_function).toEqual(styles.destination_filter)
    expect(styles.source.bg).not.toBe(styles.audience.bg)
    expect(new Set(FAMILIES.map((f) => f)).size).toBe(5)
    expect(new Set(Object.values(styles).map((s) => s.bg)).size).toBe(5)
  })

  it('assigns colours light to dark, whatever order the palette lists them in', () => {
    /* Sorted rather than taken in order, so the assignment does not depend on how the
       source page happened to write the palette down -- Ocean lists its darkest colour
       first and its lightest last, and reading them positionally would put near-black
       on the sources. */
    const styles = paletteStyles('ocean')
    const byFamily = { input: styles.source, processing: styles.source_function, output: styles.destination, unify: styles.space, engage: styles.audience }
    const brightness = FAMILIES.map((family) => luminance(byFamily[family].bg))
    expect(brightness).toEqual([...brightness].sort((a, b) => b - a))
  })

  it('themes identically for two palettes holding the same colours in a different order', () => {
    const forward = paletteStyles({ key: 'a', name: 'A', colors: ['#111111', '#444444', '#777777', '#aaaaaa', '#dddddd'] })
    const reversed = paletteStyles({ key: 'b', name: 'B', colors: ['#dddddd', '#aaaaaa', '#777777', '#444444', '#111111'] })
    expect(forward).toEqual(reversed)
  })

  it('wraps rather than leaving a family unstyled when a palette is short', () => {
    /* No palette here is short, but a half-themed canvas is a worse failure than a
       repeated colour, so the wrap is what a hand-authored one gets. */
    const styles = paletteStyles({ key: 'two', name: 'Two', colors: ['#ffffff', '#000000'] })
    for (const kind of Object.keys(KIND_STYLES)) {
      if (familyOf(kind)) expect(styles[kind], kind).toBeTruthy()
    }
  })

  it('is empty for an unknown key or a palette with no usable colours', () => {
    expect(paletteStyles('not-a-palette')).toEqual({})
    expect(paletteStyles({ key: 'x', name: 'X', colors: ['nope'] })).toEqual({})
  })
})

describe('applyPaletteToNodes', () => {
  const node = (id, kind, extra = {}) => ({ id, type: 'segmentNode', data: { id, kind, name: id, ...extra } })

  it('recolours every component of a themed kind', () => {
    const [source] = applyPaletteToNodes([node('s', 'source')], 'ocean')
    expect(source.data.style).toEqual(paletteStyles('ocean').source)
  })

  it('keeps a shape the user chose', () => {
    /* Merged, not replaced. Someone who made their warehouses square did not ask for a
       palette to undo that. */
    const [warehouse] = applyPaletteToNodes([node('w', 'warehouse', { style: { shape: 'pill' } })], 'ocean')
    expect(warehouse.data.style.shape).toBe('pill')
    expect(warehouse.data.style.bg).toBe(paletteStyles('ocean').warehouse.bg)
  })

  it('leaves an unthemed kind untouched', () => {
    const nodes = [node('c', 'custom'), node('s', 'source')]
    const out = applyPaletteToNodes(nodes, 'ocean')
    expect(out[0]).toBe(nodes[0])
    expect(out[1]).not.toBe(nodes[1])
  })

  it('never recolours a zone, whatever its data says', () => {
    /* The type is what decides, not the absence of a `kind` on the descriptor -- a zone
       node's `data` is the zone descriptor spread wholesale, so a field named `kind`
       appearing there later would otherwise start tinting the backdrops. Zone colours
       say which Segment product a region is, which is structure, and a themed canvas
       still has to read as Connections, Unify and Engage. */
    const zone = { id: 'zone-unify', type: 'zone', data: { id: 'unify', kind: 'source' } }
    expect(applyPaletteToNodes([zone], 'ocean')[0]).toBe(zone)
  })

  it('returns the same array when there is nothing to recolour', () => {
    const nodes = [node('c', 'custom')]
    expect(applyPaletteToNodes(nodes, 'ocean')).toBe(nodes)
    expect(applyPaletteToNodes(nodes, 'not-a-palette')).toBe(nodes)
  })
})

describe('clearPaletteFromNodes', () => {
  const styled = (id, style) => ({ id, type: 'segmentNode', data: { id, kind: 'source', style } })

  it('drops the colours and keeps the shape', () => {
    const [out] = clearPaletteFromNodes([styled('s', { bg: '#111111', border: '#222222', text: '#ffffff', shape: 'pill' })])
    expect(out.data.style).toEqual({ shape: 'pill' })
  })

  it('deletes an override that held only colours', () => {
    /* `undefined`, not `{}`: an empty object still counts as an override everywhere the
       inspector counts keys, so Reset would leave the node claiming to be customised
       and its own Reset button showing. */
    const [out] = clearPaletteFromNodes([styled('s', { bg: '#111111', text: '#ffffff' })])
    expect(out.data.style).toBeUndefined()
  })

  it('returns the same array when no node carries a colour override', () => {
    const nodes = [styled('a', { shape: 'pill' }), styled('b', undefined)]
    expect(clearPaletteFromNodes(nodes)).toBe(nodes)
  })

  it('round-trips: apply then clear leaves the styles as they started', () => {
    const nodes = [
      { id: 's', type: 'segmentNode', data: { id: 's', kind: 'source' } },
      { id: 'w', type: 'segmentNode', data: { id: 'w', kind: 'warehouse', style: { shape: 'pill' } } },
    ]
    const cleared = clearPaletteFromNodes(applyPaletteToNodes(nodes, 'fall'))
    expect(cleared.map((n) => n.data.style)).toEqual([undefined, { shape: 'pill' }])
  })
})

describe('every styled kind is a kind the canvas draws', () => {
  it.each(FAMILIES)('family %s is reachable from at least one kind', (family) => {
    /* A family with no kinds would silently absorb one of the five palette colours and
       leave the canvas looking like a four-colour theme. */
    expect(Object.keys(KIND_STYLES).some((kind) => familyOf(kind) === family)).toBe(true)
  })

  it('does not name a kind kinds.js has never heard of', () => {
    /* The two tables are edited separately, so a kind renamed in one and not the other
       would just quietly stop being themed. */
    for (const kind of Object.keys(paletteStyles('pastel'))) {
      expect(KIND_STYLES, kind).toHaveProperty(kind)
    }
  })
})
