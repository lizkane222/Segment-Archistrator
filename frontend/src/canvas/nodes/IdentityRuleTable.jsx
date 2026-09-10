/*
 * An identity resolution rule, drawn as the table it is in the Segment UI.
 *
 * Every other component on this canvas is a labelled box, and that is right for them:
 * a source is a thing with a name, and what matters about it is what it connects to.
 * An identity resolution rule is not that. It *is* its rows -- an ordered list of
 * identifiers with a match limit each -- and a box saying "Identity Resolution Rule"
 * communicates none of the thing a reader opened the diagram to check. Segment
 * publishes no API for these, so they are transcribed by hand from the workspace, and
 * a diagram that cannot show the transcription is a diagram that cannot be checked
 * against it.
 *
 * Three columns, matching the settings screen:
 *
 *  - Priority: the order identifiers are resolved in, and it is an ordered list rather
 *    than a number the user types. The position in the array *is* the priority, so
 *    there is no way for the two to disagree -- a stored `priority: 3` on the first row
 *    would be a second answer to the same question.
 *  - External_id: the identifier's name, free text. Not a fixed list: a workspace can
 *    define its own, and offering a closed dropdown of Segment's built-ins would make
 *    the commonest real case unrepresentable.
 *  - Limit: how many distinct values of this identifier one profile may hold, and over
 *    what window -- "5 Ever" in the UI's own wording. Two fields, rendered as one cell,
 *    because they are one sentence and splitting them into two columns would leave a
 *    column of bare numbers whose unit is elsewhere.
 *
 * Read-only here. The canvas draws the rule; editing it belongs in the inspector, where
 * there is room for a real form and where every other component's fields are edited.
 * Putting inputs on a 240px card would mean a table nobody can type into accurately and
 * two places that both claim to own the same data.
 */

import { memo } from 'react'

/* The UI's own vocabulary, in its own order. `ever` first because it is the default in
   Segment and the commonest thing to see written down. */
export const LIMIT_FREQUENCIES = ['Ever', 'Day', 'Week', 'Month', 'Quarter', 'Year']

/*
 * What a rule with nothing filled in shows.
 *
 * Three rows rather than none, and that is deliberate: an empty table is
 * indistinguishable from a component that has no table, and the reader cannot tell
 * whether the rule is blank or the feature is missing. Three is also what the settings
 * screen opens with, and these three identifiers in this order are Segment's own
 * default priority -- so a diagram nobody has edited is already saying something true.
 */
export const DEFAULT_IDENTITY_RULES = [
  { externalId: 'user_id', limit: 1, frequency: 'Ever' },
  { externalId: 'email', limit: 5, frequency: 'Ever' },
  { externalId: 'anonymous_id', limit: 5, frequency: 'Ever' },
]

/**
 * The rows to draw for a node, normalised.
 *
 * Tolerant of a half-written row on purpose. These are transcribed by hand, and a
 * workspace's rule may legitimately have no limit set on an identifier -- which reads
 * as "no limit", not as a broken row to be hidden. Falling back to the defaults only
 * when there is no `rules` key at all: an explicitly empty array means the author
 * deleted every row, and replacing it with three would undo their edit on every reload.
 */
export function identityRules(data) {
  const rules = data?.rules
  if (!Array.isArray(rules)) return DEFAULT_IDENTITY_RULES
  return rules.map((rule) => ({
    externalId: rule?.externalId ?? '',
    limit: rule?.limit ?? null,
    frequency: rule?.frequency ?? 'Ever',
  }))
}

/** "5 Ever", or an em dash when no limit is recorded -- which is a real answer. */
export function formatLimit(rule) {
  if (rule.limit === null || rule.limit === undefined || rule.limit === '') return '—'
  return `${rule.limit} ${rule.frequency ?? 'Ever'}`.trim()
}

function IdentityRuleTable({ data }) {
  const rules = identityRules(data)

  return (
    /* `nodrag` on the table, not on the card: the header strip and the padding around it
       stay a drag target, so the component can still be moved by grabbing its name --
       but a drag started on a row selects text instead of hauling the node across the
       canvas, which is what a table invites the pointer to do. */
    <table className="nodrag mt-1.5 w-full border-collapse text-[9px] leading-tight">
      <thead>
        <tr className="text-twilio-gray-60">
          {/* `w-0` plus `whitespace-nowrap`: the two narrow columns take exactly the
              width of their content and External_id gets the rest, which is the column
              whose values are long enough to need it. */}
          <th className="w-0 border border-black/10 px-1 py-0.5 text-left font-semibold uppercase tracking-wide">
            #
          </th>
          <th className="border border-black/10 px-1 py-0.5 text-left font-semibold uppercase tracking-wide">
            External_id
          </th>
          <th className="w-0 whitespace-nowrap border border-black/10 px-1 py-0.5 text-left font-semibold uppercase tracking-wide">
            Limit
          </th>
        </tr>
      </thead>
      <tbody>
        {rules.length === 0 ? (
          <tr>
            {/* Said rather than shown blank. An author who deleted every row gets told
                that is what the diagram now claims. */}
            <td colSpan={3} className="border border-black/10 px-1 py-0.5 italic opacity-60">
              No identifiers — every event would resolve to its own profile.
            </td>
          </tr>
        ) : (
          rules.map((rule, index) => (
            /* Index as the key, uniquely justified here: the row's identity *is* its
               position, since position is what priority means. Two rows naming the same
               identifier is a real (if wrong) thing to transcribe, so keying on the name
               would collapse exactly the mistake the reader is looking for. */
            <tr key={index}>
              <td className="border border-black/10 px-1 py-0.5 text-right tabular-nums opacity-60">
                {index + 1}
              </td>
              <td
                className="max-w-0 truncate border border-black/10 px-1 py-0.5 font-mono"
                title={rule.externalId}
              >
                {rule.externalId || <span className="italic opacity-60">unnamed</span>}
              </td>
              <td className="whitespace-nowrap border border-black/10 px-1 py-0.5 tabular-nums">
                {formatLimit(rule)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

export default memo(IdentityRuleTable)
