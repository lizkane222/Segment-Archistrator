/*
 * What to do with more than one component at once.
 *
 * Appears only with two or more selected, because every action here is about the relation
 * between them: with one card selected "align left" and "make same size" are both no-ops
 * that would still mark the document dirty, and a toolbar full of buttons that do nothing
 * is worse than no toolbar.
 *
 * Naming the model on its face is not decoration. "Make same size" and "apply same style"
 * both have to copy *from* somewhere, and every rule for picking that source is arbitrary
 * from outside the code -- largest, first in the document, last clicked. So the rule is the
 * plainest one a user can predict (the last component they clicked) and the toolbar says
 * whose size and style are about to be handed out. The logic is in canvas/selection.js.
 */

import { useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Group,
  Paintbrush,
  Scaling,
  Ungroup,
} from 'lucide-react'

/* Ordered by axis rather than by the request's own ordering ("top/middle/right/left/
   bottom/center"), because the icons are read as two groups of three and a horizontal
   control sitting between two vertical ones is picked up wrong. */
const ALIGN_BUTTONS = [
  { id: 'left', label: 'Align left edges', Icon: AlignStartVertical },
  { id: 'centerX', label: 'Align centres vertically', Icon: AlignCenterVertical },
  { id: 'right', label: 'Align right edges', Icon: AlignEndVertical },
  { id: 'top', label: 'Align top edges', Icon: AlignStartHorizontal },
  { id: 'middleY', label: 'Align middles horizontally', Icon: AlignCenterHorizontal },
  { id: 'bottom', label: 'Align bottom edges', Icon: AlignEndHorizontal },
]

export default function SelectionToolbar({
  count,
  modelName,
  grouped,
  onAlign,
  onMatchSize,
  onMatchStyle,
  onGroup,
  onUngroup,
}) {
  if (count < 2) return null

  return (
    <div className="nopan flex items-center gap-1 rounded-md border border-twilio-gray-20 bg-white px-1.5 py-1 shadow-md">
      <span className="px-1 text-xs font-medium text-twilio-gray-60">{count} selected</span>

      <Divider />
      {ALIGN_BUTTONS.map(({ id, label, Icon }) => (
        <ToolButton key={id} label={label} onClick={() => onAlign(id)}>
          <Icon size={14} aria-hidden="true" />
        </ToolButton>
      ))}

      <Divider />
      <MatchSizeMenu modelName={modelName} onMatchSize={onMatchSize} />
      <ToolButton
        label={modelName ? `Match style to ${modelName}` : 'Match style'}
        onClick={onMatchStyle}
      >
        <Paintbrush size={14} aria-hidden="true" />
      </ToolButton>

      <Divider />
      {/* Both shown, and Ungroup disabled rather than hidden when nothing in the selection
          is grouped: a control that appears and disappears as the selection changes is one
          the user has to hunt for, and its absence reads as "grouping is unavailable"
          rather than "nothing here is grouped". */}
      <ToolButton label="Group — select and move these together" onClick={onGroup}>
        <Group size={14} aria-hidden="true" />
      </ToolButton>
      <ToolButton
        label={grouped ? 'Ungroup' : 'Nothing selected is grouped'}
        onClick={onUngroup}
        disabled={!grouped}
      >
        <Ungroup size={14} aria-hidden="true" />
      </ToolButton>
    </div>
  )
}

/* Match Size, with its three options. A small popover rather than three more buttons in a bar that is
   already long: width, height, or both, all taken from the model named on the button. */
function MatchSizeMenu({ modelName, onMatchSize }) {
  const [open, setOpen] = useState(false)
  const pick = (dimension) => {
    setOpen(false)
    onMatchSize(dimension)
  }
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <ToolButton
        label={modelName ? `Match size to ${modelName}` : 'Match size'}
        onClick={() => setOpen((value) => !value)}
      >
        <Scaling size={14} aria-hidden="true" />
      </ToolButton>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-md border border-twilio-gray-20 bg-white py-1 shadow-md"
        >
          {[
            ['width', 'Match width'],
            ['height', 'Match height'],
            ['both', 'Match width & height'],
          ].map(([dimension, label]) => (
            <button
              key={dimension}
              type="button"
              role="menuitem"
              onClick={() => pick(dimension)}
              className="block w-full px-3 py-1.5 text-left text-xs text-twilio-navy hover:bg-twilio-gray-10"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolButton({ label, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-twilio-gray-60"
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-twilio-gray-20" aria-hidden="true" />
}
