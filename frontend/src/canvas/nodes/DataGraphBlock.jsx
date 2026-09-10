/*
 * A Data Graph's entity model, on the card.
 *
 * Segment publishes no API for a Data Graph, so whatever is here was transcribed by hand -- and a
 * config block is the form it is transcribed *in*, because that is how it is authored in Segment (a
 * YAML-ish definition of entities and their joins). Reformatting it into a table would mean parsing a
 * format this tool has no reason to understand, and getting it wrong silently.
 *
 * So: a code block, monospaced, scrollable, read-only. The one thing it does interpret is the *entity
 * names*, pulled out into a summary line -- because "which entities does this graph know about" is the
 * question a reader has about it, and counting indented blocks in twelve lines of YAML by eye is not
 * how anyone wants to answer it.
 */

import { memo, useMemo } from 'react'

/* Lines shown before the block scrolls. A real Data Graph config is dozens of lines; a card showing all
   of them would be taller than the zone it sits in. */
const PEEK_LINES = 8

function DataGraphBlock({ data }) {
  const config = typeof data.config === 'string' ? data.config : ''

  /*
   * The entity names, as a best-effort read of the config.
   *
   * Deliberately shallow: any line whose indentation puts it directly under an `entities:` key is
   * treated as an entity name. It is not a YAML parser and does not pretend to be -- which is why the
   * summary is phrased as a list of names and never as a count of "all" of them. Getting this wrong
   * shows one fewer chip; getting a real parser wrong would show a confidently incorrect model.
   */
  const entities = useMemo(() => {
    const lines = config.split('\n')
    const found = []
    let inEntities = false
    let depth = 0
    for (const line of lines) {
      const indent = line.length - line.trimStart().length
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      if (/^entities\s*:/.test(trimmed)) {
        inEntities = true
        depth = indent
        continue
      }
      if (!inEntities) continue
      /* Back out to the same level or shallower: the entities block has ended. */
      if (indent <= depth) {
        inEntities = false
        continue
      }
      const name = trimmed.match(/^-?\s*(?:name\s*:\s*)?([A-Za-z_][\w-]*)\s*:?\s*$/)
      if (name) found.push(name[1])
    }
    return [...new Set(found)]
  }, [config])

  if (!config.trim()) {
    return (
      <p className="mt-1.5 text-[9px] italic leading-snug opacity-60">
        No entity model yet — paste the Data Graph config in the inspector.
      </p>
    )
  }

  const lines = config.split('\n')
  const shown = lines.slice(0, PEEK_LINES)

  return (
    <div className="mt-1.5">
      {entities.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {entities.map((entity) => (
            <span
              key={entity}
              className="rounded bg-black/5 px-1 py-px font-mono text-[9px] leading-tight"
            >
              {entity}
            </span>
          ))}
        </div>
      )}

      {/* `nodrag nowheel`: a drag on the block selects text rather than moving the node, and a scroll
          over it scrolls the block rather than zooming the canvas out from under the cursor. */}
      <pre className="nodrag nowheel max-h-32 overflow-auto rounded bg-twilio-navy/95 px-1.5 py-1 font-mono text-[9px] leading-snug text-white">
        {shown.join('\n')}
        {lines.length > shown.length && `\n… ${lines.length - shown.length} more lines`}
      </pre>
    </div>
  )
}

export default memo(DataGraphBlock)
