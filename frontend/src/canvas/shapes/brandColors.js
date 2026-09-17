/*
 * Known colors for converted Lucid icons whose own fill was lost in the export.
 *
 * `scripts/convert_lucid_shapes.py` can only draw what the .lcsl file gives it a vector path
 * for. A handful of "Third Party / Developer" icons carried their glyph as a `UserImage2Block`
 * bitmap rather than an `SVGPathBlock2`, which the converter cannot draw and drops -- see its
 * docstring. Of those, only `python` still has real vector geometry to color (the rest are left
 * with nothing, or a plain placeholder rectangle, which no color turns into a logo). So this map
 * has exactly one entry until a fresh export brings real artwork for the others.
 *
 * Keyed by path index within the shape's own `paths` array; index 0 is always the card's
 * background square and is never listed here.
 */
export const BRAND_COLORS = {
  'third-party-developer/python': { 1: '#3776AB', 2: '#FFD43B' },
}
