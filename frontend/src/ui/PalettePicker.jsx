/*
 * The palette list, in the two scopes the request asks for.
 *
 * One component rather than two, because the list is 34 rows long and the difference
 * between the scopes is only what a click means:
 *
 *   - `onApply` -- the whole row is the target. Applies the scheme across the canvas,
 *     a colour per component family. The swatches are decoration here.
 *   - `onPick` -- each swatch is the target, and the row is a heading. This is the
 *     "specific components" scope: one colour, on whatever is selected.
 *
 * Both are offered when both handlers are passed, which is why the swatches are
 * siblings of the row rather than inside it -- a button inside a button is invalid and
 * renders unpredictably.
 *
 * The rows are the palettes' own names and colours, in the source order, so someone who
 * picked a scheme off the reference page can find it by name. Sorting them by hue would
 * look tidier and make that lookup impossible.
 */

import { PALETTES, readableText } from '../canvas/palettes.js'

export default function PalettePicker({ onApply, onPick, height = 'max-h-72' }) {
  return (
    <div className={`${height} overflow-y-auto`}>
      {PALETTES.map((palette) => (
        <div
          key={palette.key}
          className="flex items-center gap-2 border-b border-twilio-gray-10 px-2 py-1.5 last:border-b-0 hover:bg-twilio-gray-10"
        >
          {onApply ? (
            <button
              type="button"
              onClick={() => onApply(palette.key)}
              title={`Apply ${palette.name} to every component on the canvas`}
              className="nodrag min-w-0 flex-1 truncate text-left text-[11px] text-twilio-navy transition-colors hover:text-twilio-blue"
            >
              {palette.name}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[11px] text-twilio-gray-60">
              {palette.name}
            </span>
          )}

          <div className="flex shrink-0 overflow-hidden rounded border border-twilio-gray-20">
            {palette.colors.map((color) =>
              onPick ? (
                <button
                  key={color}
                  type="button"
                  onClick={() => onPick(color)}
                  title={`${color} — use this colour`}
                  style={{ background: color, color: readableText(color) }}
                  className="nodrag h-5 w-6 text-[9px] leading-none transition-transform hover:scale-110"
                >
                  {/* A hover target with nothing in it is invisible to a screen reader,
                      and the title alone is not read reliably. */}
                  <span className="sr-only">{`${palette.name} ${color}`}</span>
                </button>
              ) : (
                <span
                  key={color}
                  style={{ background: color }}
                  className="h-5 w-6"
                  aria-hidden="true"
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
