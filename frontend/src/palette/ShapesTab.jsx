/*
 * The Shapes tab: geometry and icons that are not Segment components.
 *
 * A diagram of a customer's architecture is never only Segment. It has their app, their warehouse,
 * an arrow saying "nightly", a callout explaining why a filter exists, and — because these get
 * screen-shared in front of the customer — their own product's logo. None of that is a `kind` in
 * topology.py and none of it should be: `topology.py` is the rules for what a *Segment* architecture
 * may look like, and putting a five-pointed star in it would mean the backend having an opinion about
 * where a star may be placed.
 *
 * So everything here drops as `kind: 'shape'`, which the server tolerates by design (an unknown kind
 * carries no rules it could be enforcing — see `validate_architecture`) and which the canvas draws
 * from `data.shape` or `data.lucid`.
 *
 * ## Two sources, one tab
 *
 * `geometry.js` holds the plain shapes, built as paths so one corner-rounding control works on all of
 * them. `lucid.json` is generated from Twilio's own shared Lucid libraries by
 * `scripts/convert_lucid_shapes.py` — 225 icons and illustrations that a solutions engineer already
 * uses in Lucid and would otherwise have to redraw here.
 *
 * The Lucid set is grouped by its source library rather than merged, because "Twilio Product Icons"
 * and "Third Party / Developer" are how the person looking for one thinks about where it is.
 */

import { useMemo, useState } from 'react'

import { DRAG_MIME } from '../canvas/Canvas.jsx'
import { SHAPES, shapePath } from '../canvas/shapes/geometry.js'
import LUCID from '../canvas/shapes/lucid.json'
import { LucidArt } from '../canvas/shapes/LucidArt.jsx'

/* Default drop size. A shape has no text to size itself around, so unlike a component it needs one --
   and it comes from the shape's own `aspect` so a swimlane arrives wide and a cylinder does not. */
const BASE = 120

export default function ShapesTab({ search }) {
  const [library, setLibrary] = useState('geometry')

  const libraries = useMemo(() => {
    const found = new Map()
    for (const shape of LUCID) {
      if (!found.has(shape.library)) found.set(shape.library, [])
      found.get(shape.library).push(shape)
    }
    return [...found.entries()]
  }, [])

  const term = search?.trim().toLowerCase() ?? ''

  /*
   * A search looks across *every* library, not only the one selected.
   *
   * Someone typing "sms" does not know which of five libraries the SMS icon is in -- that is the
   * question they are asking. Restricting the search to the open library would answer it with
   * "nothing found" while the icon sat one tab over.
   */
  if (term) {
    const geometry = SHAPES.filter((shape) => shape.name.toLowerCase().includes(term))
    const icons = LUCID.filter(
      (shape) =>
        shape.name.toLowerCase().includes(term) || shape.library.toLowerCase().includes(term),
    )
    if (!geometry.length && !icons.length) {
      return <p className="px-1 py-6 text-center text-xs text-twilio-gray-40">No shapes match “{search}”.</p>
    }
    return (
      <div className="space-y-3">
        {geometry.length > 0 && <Grid title="Shapes">{geometry.map(geometryTile)}</Grid>}
        {icons.length > 0 && (
          <Grid title={`Icons · ${icons.length}`}>{icons.slice(0, 120).map(lucidTile)}</Grid>
        )}
      </div>
    )
  }

  return (
    <div>
      {/* One row of library chips. A `<select>` would hide which libraries exist, and the count is
          the useful part -- it says whether a library is worth opening. */}
      <div className="mb-3 flex flex-wrap gap-1">
        <Chip active={library === 'geometry'} onClick={() => setLibrary('geometry')}>
          Shapes · {SHAPES.length}
        </Chip>
        {libraries.map(([name, shapes]) => (
          <Chip key={name} active={library === name} onClick={() => setLibrary(name)}>
            {name} · {shapes.length}
          </Chip>
        ))}
      </div>

      {library === 'geometry' ? (
        <Grid>{SHAPES.map(geometryTile)}</Grid>
      ) : (
        <Grid>{(libraries.find(([name]) => name === library)?.[1] ?? []).map(lucidTile)}</Grid>
      )}
    </div>
  )
}

function geometryTile(shape) {
  return (
    <Tile
      key={shape.id}
      label={shape.name}
      payload={{
        kind: 'shape',
        name: shape.name,
        data: {
          shape: shape.id,
          /* Zero, and stored explicitly rather than left absent: the corner handle reads it, and a
             shape that arrives with no radius at all would make the handle's first drag jump from
             wherever it defaulted to. */
          radius: 0,
          size: { width: Math.round(BASE * shape.aspect), height: BASE },
        },
      }}
      preview={
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-7 w-7">
          <path
            d={shapePath(shape.id, 0)}
            fill="none"
            stroke="currentColor"
            strokeWidth={5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      }
    />
  )
}

function lucidTile(shape) {
  return (
    <Tile
      key={shape.id}
      label={shape.name}
      payload={{
        kind: 'shape',
        name: shape.name,
        data: {
          lucid: shape.id,
          /* The icon's own aspect ratio, so a wide illustration is not dropped into a square and
             squeezed. */
          size: {
            width: Math.round(BASE * (shape.width / shape.height || 1)),
            height: BASE,
          },
        },
      }}
      preview={<LucidArt id={shape.id} className="h-7 w-7" />}
    />
  )
}

/* --- presentation ---------------------------------------------------------- */

function Grid({ title, children }) {
  return (
    <section>
      {title && (
        <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-twilio-gray-40">
          {title}
        </h4>
      )}
      {/* A grid, not the list the other tabs use. These are picked by *appearance* -- nobody scans a
          column of labels looking for a cylinder -- so the preview has to be the thing you see and
          the label the thing you confirm with. */}
      <div className="grid grid-cols-4 gap-1">{children}</div>
    </section>
  )
}

function Tile({ label, payload, preview }) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      title={label}
      className="flex cursor-grab flex-col items-center gap-1 rounded border border-twilio-gray-20 p-1.5 text-twilio-gray-60 transition-colors hover:border-twilio-blue hover:text-twilio-navy active:cursor-grabbing"
    >
      {preview}
      <span className="w-full truncate text-center text-[9px] leading-tight">{label}</span>
    </div>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 text-[10px] transition-colors ${
        active
          ? 'bg-twilio-blue text-white'
          : 'bg-twilio-gray-10 text-twilio-gray-60 hover:text-twilio-navy'
      }`}
    >
      {children}
    </button>
  )
}
