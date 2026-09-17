/*
 * The formatting bar, for whatever label is being edited.
 *
 * Appears in the same place and on the same terms as `SelectionToolbar`: above the canvas,
 * centred, only while it has something to act on. The two are mutually exclusive -- text is being
 * edited, or several things are selected -- so they share one `Panel` and this one wins, because
 * a caret in a label is a narrower and more recent statement of intent than a selection.
 *
 * ## Two kinds of control, two mechanisms
 *
 * **Marks** (bold, italic, underline, strikethrough, lists) apply to *the selection*, so they are
 * handed to the editing session, which owns the element and the caret -- see `transform` in
 * nodes/RichEditor.jsx, which is also where the reason this is not `document.execCommand` is
 * written down. Nothing here writes to the document: a mark lands in the editor and reaches the
 * document when the edit is committed.
 *
 * **Everything else** -- size, colour, alignment -- is a property of the whole label, and goes
 * straight into the node's `data.style` where the Style tab's fields already live. So the two
 * panels cannot disagree about a label's colour, and neither has a private copy of it.
 *
 * ## Why every button suppresses mousedown
 *
 * Pressing a button in a toolbar moves focus to the button, which blurs the editable, which
 * commits the edit -- so the first click on Bold would close the editor and the mark would land
 * on nothing. `preventDefault` on mousedown keeps the selection where it is. It is the reason
 * there is no `<select>` and no `<input type="color">` here: both need focus to work, and a
 * control that has to steal the caret cannot be in this bar.
 *
 * ## What is on it
 *
 * The intersection of what Lucid, Figma and Google Docs put in the same position, minus anything
 * this canvas cannot honour. Bold/italic/underline/strikethrough and the two lists are common to
 * all three. Size as a stepper rather than a dropdown, for the focus reason above. Horizontal
 * *and* vertical alignment, because a label sits inside a shape rather than in a page of text and
 * "middle of the box" is the setting people actually want. Colour as a small fixed row: the full
 * palette lives in the inspector, and a 34-row list in a floating bar is a menu nobody reads.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useNodesData } from '@xyflow/react'
import {
  AlignCenter,
  AlignEndHorizontal,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  Bold,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from 'lucide-react'

import { useChrome } from './chrome.js'
import { ZONE_SWATCHES } from './kinds.js'

/* The sizes the stepper walks. Not a free number field -- see the header on focus -- and not a
   continuous range either: these are the sizes a diagram is legible at, and the two ends are
   "smaller than the default" and "a heading on a poster". */
export const FONT_SIZES = [9, 10, 11, 13, 16, 20, 24, 32, 48]
const DEFAULT_FONT_SIZE = 13

/* Navy and white either side of the six zone colours, which is the palette the rest of the canvas
   already uses -- so a label recoloured here matches the region it sits in rather than
   introducing a seventh blue. */
const TEXT_COLOURS = ['#121c2d', ...ZONE_SWATCHES, '#ffffff']

const H_ALIGN = [
  { id: 'left', label: 'Align text left', Icon: AlignLeft },
  { id: 'center', label: 'Centre text', Icon: AlignCenter },
  { id: 'right', label: 'Align text right', Icon: AlignRight },
]

const V_ALIGN = [
  { id: 'top', label: 'Text to the top', Icon: AlignStartHorizontal },
  { id: 'middle', label: 'Text to the middle', Icon: AlignCenterHorizontal },
  { id: 'bottom', label: 'Text to the bottom', Icon: AlignEndHorizontal },
]

/* Keyed by the model's own mark names, not by an `execCommand` command name -- see the header. */
const MARK_BUTTONS = [
  { mark: 'b', label: 'Bold', shortcut: '⌘B', Icon: Bold },
  { mark: 'i', label: 'Italic', shortcut: '⌘I', Icon: Italic },
  { mark: 'u', label: 'Underline', shortcut: '⌘U', Icon: Underline },
  { mark: 's', label: 'Strikethrough', Icon: Strikethrough },
]

const LIST_BUTTONS = [
  { style: 'bullet', label: 'Bulleted list', Icon: List },
  { style: 'number', label: 'Numbered list', Icon: ListOrdered },
]

export default function TextToolbar() {
  const { textEditing, updateData } = useChrome()
  const session = useSyncExternalStore(textEditing.subscribe, textEditing.current)

  /*
   * Re-read whenever the selection moves, so Bold looks pressed when the caret is inside a bold
   * word. The answer comes from the session (`state`, which reads the runs), but *when to ask* can
   * only come from the browser: the edit in progress lives in the DOM, and nothing in React changes
   * when the user drags across three characters.
   *
   * Subscribed only while the bar is mounted, which is only while something is being edited.
   */
  const [, bumpSelection] = useState(0)
  useEffect(() => {
    if (!session) return undefined
    const onChange = () => bumpSelection((count) => count + 1)
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [session])

  /* The live node, so the alignment and colour buttons show what the label is actually set to.
     Called unconditionally -- hooks cannot be skipped -- with a null id when nothing is being
     edited, which the hook tolerates. */
  const data = useNodesData(session?.nodeId ?? null)?.data
  const style = data?.style ?? {}

  if (!session) return null

  const setStyle = (patch) => updateData?.(session.nodeId, { style: { ...style, ...patch } })

  const size = Number(style.fontSize) || DEFAULT_FONT_SIZE
  const step = (direction) => {
    /* Walked over the list rather than added to, so the sizes stay the ones above: the nearest
       entry, then one along. Nearest rather than exact, because a size set from the inspector's
       number field may not be on this list at all. */
    const nearest = FONT_SIZES.reduce((best, entry) =>
      Math.abs(entry - size) < Math.abs(best - size) ? entry : best,
    )
    const at = FONT_SIZES.indexOf(nearest)
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + direction))]
    setStyle({ fontSize: next })
  }

  return (
    <div className="nopan flex items-center gap-1 rounded-md border border-twilio-gray-20 bg-white px-1.5 py-1 shadow-md">
      <ToolButton label="Smaller text" onClick={() => step(-1)}>
        <Minus size={13} aria-hidden="true" />
      </ToolButton>
      <span className="w-6 text-center text-[11px] tabular-nums text-twilio-gray-60" title="Text size">
        {size}
      </span>
      <ToolButton label="Larger text" onClick={() => step(1)}>
        <Plus size={13} aria-hidden="true" />
      </ToolButton>

      <Divider />
      {MARK_BUTTONS.map(({ mark, label, shortcut, Icon }) => (
        <ToolButton
          key={mark}
          label={shortcut ? `${label} (${shortcut})` : label}
          /* `all` and not `some`: a selection that is partly bold shows the button *unpressed* and
             pressing it bolds the rest, which is what every editor does and what nobody can
             describe until they meet one that gets it wrong. See `markState`. */
          active={session.state?.(mark) === 'all'}
          onClick={() => session.mark?.(mark)}
        >
          <Icon size={14} aria-hidden="true" />
        </ToolButton>
      ))}

      <Divider />
      {LIST_BUTTONS.map(({ style: listStyle, label, Icon }) => (
        <ToolButton
          key={listStyle}
          label={label}
          active={session.listState?.() === listStyle}
          onClick={() => session.list?.(listStyle)}
        >
          <Icon size={14} aria-hidden="true" />
        </ToolButton>
      ))}
      <ToolButton label="Clear formatting" onClick={() => session.clearFormatting?.()}>
        <RemoveFormatting size={14} aria-hidden="true" />
      </ToolButton>

      <Divider />
      {H_ALIGN.map(({ id, label, Icon }) => (
        <ToolButton
          key={id}
          label={label}
          active={(style.textAlign ?? 'left') === id}
          onClick={() => setStyle({ textAlign: id })}
        >
          <Icon size={14} aria-hidden="true" />
        </ToolButton>
      ))}

      <Divider />
      {V_ALIGN.map(({ id, label, Icon }) => (
        <ToolButton
          key={id}
          label={label}
          active={(style.textVAlign ?? 'middle') === id}
          onClick={() => setStyle({ textVAlign: id })}
        >
          <Icon size={14} aria-hidden="true" />
        </ToolButton>
      ))}

      <Divider />
      {/* Swatches rather than a colour input: an `<input type="color">` opens the operating
          system's picker, which takes focus and therefore ends the edit. The inspector's Style
          tab has the full picker and the 34 palettes for anyone who wants one. */}
      <div className="flex items-center gap-0.5">
        {TEXT_COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setStyle({ text: colour })}
            title={`Text colour ${colour}`}
            aria-label={`Text colour ${colour}`}
            aria-pressed={style.text === colour}
            className={`h-4 w-4 rounded-sm border transition-transform hover:scale-110 ${
              style.text === colour ? 'border-twilio-blue ring-1 ring-twilio-blue' : 'border-twilio-gray-20'
            }`}
            style={{ background: colour }}
          />
        ))}
      </div>
    </div>
  )
}

function ToolButton({ label, onClick, active = false, children }) {
  return (
    <button
      type="button"
      /* The whole reason this bar can exist above the canvas rather than inside the node: keeps
         the caret where it is, so the command has something to apply to. */
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded p-1.5 transition-colors ${
        active
          ? 'bg-twilio-blue-light text-twilio-blue-dark'
          : 'text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy'
      }`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-twilio-gray-20" aria-hidden="true" />
}
