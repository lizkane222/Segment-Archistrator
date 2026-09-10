/*
 * The collapsible field tree -- the brief's "nested data" view.
 *
 * Expansion state is held by path in a Set owned by the caller, not per-row, for
 * one reason: searching has to be able to expand everything on the way to a match
 * (see `pathsToExpand`), and that is impossible if each row privately owns its own
 * open/closed flag.
 *
 * Collapsed by default at every level. A real customer schema is hundreds of
 * paths deep in places, and rendering it fully expanded gives you a wall.
 */

import { ChevronDown, ChevronRight } from 'lucide-react'

import CopyButton from '../ui/CopyButton.jsx'
import { formatSample } from './fieldTree.js'

export default function FieldTree({ nodes, expanded, onToggle, depth = 0 }) {
  if (!nodes?.length) return null

  return (
    <ul className={depth === 0 ? '' : 'ml-3 border-l border-twilio-gray-20 pl-2'}>
      {nodes.map((node) => (
        <FieldRow
          key={node.path}
          node={node}
          expanded={expanded}
          onToggle={onToggle}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function FieldRow({ node, expanded, onToggle, depth }) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.path)

  return (
    <li className="py-px">
      <div className="group flex items-start gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="nodrag mt-px shrink-0 text-twilio-gray-40 hover:text-twilio-blue"
            title={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className={`break-all font-mono text-[11px] ${
                /* A synthetic container was never listed by the API -- it exists
                   only because a child path implies it. Dimmer, so it does not
                   read as a field with missing metadata. */
                node.synthetic ? 'text-twilio-gray-60' : 'text-twilio-navy'
              } ${node.isArrayItem ? 'italic' : ''}`}
            >
              {node.label}
            </span>

            {node.type && (
              <span className="shrink-0 rounded bg-twilio-gray-10 px-1 text-[9px] uppercase tracking-wide text-twilio-gray-60">
                {node.type}
              </span>
            )}
            {hasChildren && (
              <span className="shrink-0 text-[9px] text-twilio-gray-40">
                {node.children.length}
              </span>
            )}
            {node.count !== null && node.count !== undefined && (
              <span
                className="shrink-0 text-[9px] tabular-nums text-twilio-gray-40"
                title="Occurrences observed in the schema"
              >
                ×{node.count.toLocaleString?.() ?? node.count}
              </span>
            )}
            {/* The dotted path, not the label -- that is what you paste into a
                destination filter or an audience query. */}
            <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={node.path} label="Copy field path" size={11} />
            </span>
          </div>

          {node.samples.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {node.samples.slice(0, 3).map((sample, index) => (
                <span
                  key={index}
                  /* Real customer data. Truncated by formatSample, and marked as a
                     sample so it is never mistaken for the field's definition. */
                  className="rounded bg-twilio-blue-light px-1 font-mono text-[9px] text-twilio-blue-dark"
                  title="Sample value from the customer's data"
                >
                  {formatSample(sample)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {hasChildren && isOpen && (
        <FieldTree
          nodes={node.children}
          expanded={expanded}
          onToggle={onToggle}
          depth={depth + 1}
        />
      )}
    </li>
  )
}
