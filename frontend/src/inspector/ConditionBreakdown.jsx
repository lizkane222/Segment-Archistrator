/*
 * A condition as rows, shown beside the FQL it was read from.
 *
 * Item 8's "both UI and FQL": the block above this one is what the API returns, and this
 * is the shape the customer built the rule in. Neither is redundant -- an engineer reads
 * the FQL, and the person who wrote the filter recognises the rows.
 *
 * All of the reading is conditionTree.js's, including the group headings. This file only
 * decides how a nested group indents.
 */

import { TriangleAlert } from 'lucide-react'

import { describeCondition, groupLabel } from './conditionTree.js'
import { EmptyNote } from './primitives.jsx'

export default function ConditionBreakdown({
  label = 'Condition (rows)',
  condition,
  emptyNote = 'No condition is recorded, so this matches every event.',
}) {
  const result = describeCondition(condition)

  if (result.empty) return <EmptyNote>{emptyNote}</EmptyNote>

  /* No partial rows on a parse failure. A breakdown that stopped mid-rule would show the
     condition selecting fewer events than it does, and the FQL above is still readable. */
  if (!result.parsed) {
    return (
      <p className="flex items-start gap-1.5 py-1 text-[11px] leading-relaxed text-twilio-warning">
        <TriangleAlert size={12} className="mt-px shrink-0" aria-hidden="true" />
        <span>
          This condition is outside the subset this tool reads ({result.error}), so only the
          text above is shown rather than a breakdown that might disagree with it.
        </span>
      </p>
    )
  }

  return (
    <div className="py-1">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11px] text-twilio-gray-60">{label}</span>
        <span className="text-[10px] text-twilio-gray-40">
          {result.clauseCount} {result.clauseCount === 1 ? 'condition' : 'conditions'}
        </span>
      </div>
      <TreeNode node={result.tree} />
    </div>
  )
}

function TreeNode({ node }) {
  if (node.kind === 'group') {
    return (
      <div className="overflow-hidden rounded-md border border-twilio-gray-20">
        <div className="border-b border-twilio-gray-20 bg-twilio-gray-10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-twilio-gray-60">
          {groupLabel(node)}
        </div>
        <div className="flex flex-col gap-1 p-1.5">
          {node.children.map((child, index) => (
            <TreeNode key={index} node={child} />
          ))}
        </div>
      </div>
    )
  }

  if (node.kind === 'unsupported') {
    return (
      <div className="rounded border border-twilio-warning/40 px-1.5 py-1">
        <p className="text-[10px] leading-relaxed text-twilio-warning">{node.reason}</p>
        <p className="mt-0.5 break-words font-mono text-[10px] text-twilio-gray-60">{node.raw}</p>
      </div>
    )
  }

  return (
    <div className="rounded border border-twilio-gray-20 px-1.5 py-1">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="break-all font-mono text-[11px] text-twilio-navy">{node.field}</span>
        <span className="text-[11px] text-twilio-gray-60">{node.operator}</span>
        {node.values.length > 0 && (
          <span className="break-all font-mono text-[11px] text-twilio-blue">
            {node.values.join(', ')}
          </span>
        )}
      </div>
      {node.note && <p className="mt-0.5 text-[10px] text-twilio-warning">{node.note}</p>}
    </div>
  )
}
