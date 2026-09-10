/*
 * A SQL Table's rows, on the card.
 *
 * Same shape of decision as `IdentityRuleTable`: a component whose *content is a table* has to draw the
 * table, because a labelled box saying "SQL Table" communicates none of what the reader opened the
 * diagram to check. Which columns a warehouse table has, and a few rows of what is in them, is the
 * whole reason to put one on a diagram at all.
 *
 * Read-only here and edited in the inspector, for the same reason the identity rules are: the CSV is
 * pasted, the query is typed, and both need room. A textarea on a 320px card would be a field nobody
 * can use and a second place claiming to own the same data.
 *
 * The query is run here rather than its result being stored. Two reasons, and the second is the one
 * that settles it: a stored result would be a copy of the CSV that goes stale the moment the query
 * changes, and it would double the size of every saved diagram holding a table. `runQuery` is pure and
 * memoised on (query, csv), so re-running it costs nothing on a render that was happening anyway.
 */

import { memo, useMemo } from 'react'

import { parseCsv, runQuery } from '../../inspector/sqlTable.js'

/* How many rows a card shows before it says "and N more". A card is a thing on a diagram, not a data
   browser: past about six rows it stops being glanceable and starts being something to scroll, and the
   inspector is where the whole result belongs. */
const PEEK = 6

function SqlTableRows({ data }) {
  const result = useMemo(() => {
    const parsed = parseCsv(data.csv)
    if (!parsed.columns.length) return null
    return runQuery(data.query, parsed)
  }, [data.csv, data.query])

  if (!result) {
    return (
      <p className="mt-1.5 text-[9px] italic leading-snug opacity-60">
        No data yet — paste a CSV in the inspector to show this table&rsquo;s columns.
      </p>
    )
  }

  if (result.error) {
    /* Said on the card, not swallowed. A table showing nothing because its query is broken is
       indistinguishable from a table that is genuinely empty, and the second is a fact about the
       warehouse while the first is a typo. */
    return (
      <p className="mt-1.5 text-[9px] leading-snug text-twilio-red-dark" title={result.error}>
        {result.error}
      </p>
    )
  }

  const shown = result.rows.slice(0, PEEK)
  const hidden = result.rows.length - shown.length

  return (
    <div className="mt-1.5">
      {/* `nodrag` on the table, not on the card: the header strip stays a drag target, so the component
          can still be moved by grabbing its name -- but a drag starting on a row selects text instead of
          hauling the node across the canvas, which is what a table invites the pointer to do. */}
      <table className="nodrag w-full border-collapse text-[9px] leading-tight">
        <thead>
          <tr className="text-twilio-gray-60">
            {result.columns.map((column) => (
              <th
                key={column}
                className="max-w-0 truncate border border-black/10 px-1 py-0.5 text-left font-semibold"
                title={column}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td
                colSpan={Math.max(1, result.columns.length)}
                className="border border-black/10 px-1 py-0.5 italic opacity-60"
              >
                No rows match.
              </td>
            </tr>
          ) : (
            shown.map((row, index) => (
              /* Index as the key: a warehouse row has no id this component can rely on -- the CSV may
                 not have one, and the query may not have selected it -- and the rows are a read-only
                 projection that is rebuilt whenever either input changes. */
              <tr key={index}>
                {result.columns.map((column) => (
                  <td
                    key={column}
                    className="max-w-0 truncate border border-black/10 px-1 py-0.5 font-mono"
                    title={String(row[column] ?? '')}
                  >
                    {row[column] === '' || row[column] === undefined ? (
                      <span className="italic opacity-40">null</span>
                    ) : (
                      String(row[column])
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {(hidden > 0 || result.note) && (
        <p className="mt-0.5 text-[9px] italic opacity-60">
          {hidden > 0 ? `and ${hidden} more row${hidden === 1 ? '' : 's'}` : result.note}
        </p>
      )}
    </div>
  )
}

export default memo(SqlTableRows)
