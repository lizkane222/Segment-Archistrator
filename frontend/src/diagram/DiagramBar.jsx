/*
 * The document strip: what is open, whether it is saved, and what to do about it.
 *
 * It sits below the workspace header rather than inside it because the two answer
 * different questions -- the header is about the *workspace* (which customer, and
 * signing out of them), this row is about the *document* (this diagram, saved or
 * not). Merging them produced a row where "Refresh" and "Save" sat side by side,
 * one of which discards work and the other preserves it.
 *
 * The unsaved marker is a dot rather than the word "unsaved": it has to be legible
 * at a glance during a customer call, and it sits directly against the name it
 * describes.
 */

import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Link2Off,
  Loader2,
  Palette,
  RotateCcw,
  Save,
  Upload,
} from 'lucide-react'

import PalettePicker from '../ui/PalettePicker.jsx'
import { CHANNELS } from '../canvas/palettes.js'
import { UNTITLED } from './useDiagrams.js'

export default function DiagramBar({
  /* The open-diagrams strip, when there is one. Rendered *instead of* the name field and the unsaved
     dot, not beside them: a tab chip is a diagram's name plus its unsaved dot, so showing both would
     be saying the same thing twice a few pixels apart -- and would give the name two editors that
     disagree the moment a tab is switched mid-edit. */
  tabStrip = null,
  doc,
  dirty,
  busy,
  placeholders,
  exporting,
  themeable,
  onOpen,
  onSave,
  onSaveAs,
  onRename,
  onExport,
  onExportFile,
  onImportFile,
  onFocusPlaceholder,
  onApplyPalette,
  onResetPalette,
}) {
  const [forking, setForking] = useState(false)
  const [forkName, setForkName] = useState('')
  const [theming, setTheming] = useState(false)
  /* What a theme is allowed to touch. All three colours and no shapes, which is what applying a
     palette has always done -- see the note beside the toggles. Component state rather than a
     document field: it is a mode for the next click, not a property of the diagram. */
  const [channels, setChannels] = useState(() => CHANNELS.map((channel) => channel.key))
  const [includeShapes, setIncludeShapes] = useState(false)
  const forkInput = useRef(null)

  useEffect(() => {
    if (forking) forkInput.current?.select()
  }, [forking])

  const startFork = () => {
    setForkName(`${doc.name || UNTITLED} copy`)
    setForking(true)
  }

  const submitFork = async (event) => {
    event.preventDefault()
    await onSaveAs(forkName.trim() || UNTITLED)
    setForking(false)
  }

  const saving = busy === 'save'

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-twilio-gray-20 bg-white px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {tabStrip ?? (
          <>
            <input
              value={doc.name}
              onChange={(event) => onRename(event.target.value)}
              placeholder={UNTITLED}
              aria-label="Diagram name"
              className="min-w-0 max-w-xs flex-1 truncate rounded border border-transparent bg-transparent px-1.5 py-1 text-xs font-semibold text-twilio-navy transition-colors hover:border-twilio-gray-20 focus:border-twilio-blue focus:bg-white focus:outline-none"
            />

            {dirty && (
              <span
                title="Unsaved changes"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-twilio-warning"
              />
            )}
          </>
        )}

        {!doc.id && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-twilio-gray-40">
            not saved
          </span>
        )}

        {doc.sourceTemplate && (
          <span
            title={`Started from the ${doc.sourceTemplate} template`}
            className="shrink-0 rounded bg-twilio-gray-10 px-1.5 py-0.5 font-mono text-[10px] text-twilio-gray-60"
          >
            {doc.sourceTemplate}
          </span>
        )}

        {placeholders > 0 && (
          <button
            type="button"
            onClick={onFocusPlaceholder}
            title="Select the next component still waiting to be bound"
            className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-twilio-warning px-2 py-0.5 text-[10px] font-medium text-twilio-warning transition-colors hover:bg-twilio-warning hover:text-white"
          >
            <Link2Off size={10} aria-hidden="true" />
            {placeholders} to bind
          </button>
        )}
      </div>

      {forking ? (
        <form onSubmit={submitFork} className="flex items-center gap-1.5">
          <input
            ref={forkInput}
            value={forkName}
            onChange={(event) => setForkName(event.target.value)}
            aria-label="Name for the copy"
            className="w-56 rounded border border-twilio-blue px-2 py-1 text-xs text-twilio-navy focus:outline-none"
          />
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Create copy'}
          </button>
          <button
            type="button"
            onClick={() => setForking(false)}
            className="rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 hover:text-twilio-navy"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-1.5">
          <Secondary onClick={onOpen} disabled={Boolean(busy)} icon={FolderOpen}>
            Open
          </Secondary>

          <Secondary
            onClick={onImportFile}
            disabled={Boolean(busy)}
            icon={Upload}
            title="Rebuild a diagram from a previously exported file"
          >
            Import
          </Secondary>

          <button
            type="button"
            onClick={() => onSave()}
            /* Enabled even when clean: on an unsaved document there is nothing to
               compare against, and re-saving a clean one is harmless. Disabling it
               invites a hunt for why the button is dead. */
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-twilio-blue-dark disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Save size={13} aria-hidden="true" />
            )}
            {doc.id ? 'Save' : 'Save diagram'}
          </button>

          {doc.id && (
            <Secondary onClick={startFork} disabled={Boolean(busy)}>
              Save as…
            </Secondary>
          )}

          {/* Document-scoped rather than in the inspector, because a theme is a
              statement about the whole diagram and the inspector only exists while one
              node is selected. The per-component scope lives there instead. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setTheming((open) => !open)}
              disabled={!themeable}
              aria-expanded={theming}
              title={
                themeable
                  ? 'Recolour every component from a palette'
                  : 'There is nothing on the canvas to recolour yet'
              }
              className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy disabled:opacity-50"
            >
              <Palette size={13} aria-hidden="true" />
              Theme
              {theming ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            </button>

            {theming && (
              /* `right-0`, not `left-0`: this sits at the right-hand end of the bar, and
                 anchoring left puts a 288px panel off the edge of the window. */
              <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-twilio-gray-20 bg-white shadow-lg">
                <p className="border-b border-twilio-gray-20 px-2.5 py-2 text-[11px] leading-relaxed text-twilio-gray-60">
                  A colour per component family — sources, processing, outputs, Unify,
                  Engage. Zone colours are left as they are.
                </p>
                {/*
                  Which of the three channels a theme writes, and whether it reaches shapes.

                  All three and no shapes is what this always did, so the panel opens on the
                  behaviour anyone already using it expects. The toggles are the request's own case:
                  recolouring every border on the canvas and leaving the fills alone is a thing
                  people do to a diagram they have already coloured by hand.

                  Shapes are opt-in rather than included, because a palette is a colour per
                  *component family* and a shape has no family -- so it takes a stated rule (the
                  lightest colour fills, the darkest outlines) rather than an arbitrary one, and the
                  user asks for it.
                */}
                <div className="flex flex-wrap items-center gap-1 border-b border-twilio-gray-20 px-2.5 py-2">
                  <span className="mr-1 text-[10px] uppercase tracking-wide text-twilio-gray-60">
                    Apply to
                  </span>
                  {CHANNELS.map(({ key, label }) => (
                    <Toggle
                      key={key}
                      on={channels.includes(key)}
                      onClick={() => setChannels(toggleChannel(channels, key))}
                    >
                      {label}
                    </Toggle>
                  ))}
                  <Toggle on={includeShapes} onClick={() => setIncludeShapes((on) => !on)}>
                    Shapes
                  </Toggle>
                </div>
                <PalettePicker
                  onApply={(key) => {
                    onApplyPalette(key, { channels, includeShapes })
                    setTheming(false)
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    onResetPalette()
                    setTheming(false)
                  }}
                  className="flex w-full items-center gap-1.5 border-t border-twilio-gray-20 px-2.5 py-2 text-[11px] text-twilio-gray-60 transition-colors hover:text-twilio-blue"
                >
                  <RotateCcw size={11} aria-hidden="true" />
                  Back to the default colours
                </button>
              </div>
            )}
          </div>

          {/* Buttons rather than a menu: there are only a few formats, and a dropdown
              would cost a click to reach any of them. */}
          <div className="ml-1 flex items-center overflow-hidden rounded-md border border-twilio-gray-20">
            <span className="flex items-center gap-1 border-r border-twilio-gray-20 bg-twilio-gray-10 px-2 py-1.5 text-[10px] uppercase tracking-wider text-twilio-gray-60">
              {exporting ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Download size={11} aria-hidden="true" />
              )}
              Export
            </span>
            <button
              type="button"
              onClick={() => onExport('png')}
              disabled={exporting}
              className="px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy disabled:opacity-50"
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => onExport('pdf')}
              disabled={exporting}
              className="border-l border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy disabled:opacity-50"
            >
              PDF
            </button>
            <button
              type="button"
              onClick={onExportFile}
              disabled={exporting}
              title="Save a file that can rebuild this diagram, including its name, by importing it later"
              className="border-l border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:bg-twilio-gray-10 hover:text-twilio-navy disabled:opacity-50"
            >
              JSON
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Secondary({ onClick, disabled, icon: Icon, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 px-2.5 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy disabled:opacity-50"
    >
      {Icon && <Icon size={13} aria-hidden="true" />}
      {children}
    </button>
  )
}

/* A chip that is on or off. Its own component because there are four of them in a row and the
   pressed styling has to be identical -- two of them differing by a shade is the sort of thing that
   reads as one being unavailable. */
function Toggle({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
        on
          ? 'border-twilio-blue bg-twilio-blue-light text-twilio-blue-dark'
          : 'border-twilio-gray-20 text-twilio-gray-60 hover:border-twilio-gray-40'
      }`}
    >
      {children}
    </button>
  )
}

/* One channel on or off, never emptying the set: "apply to none" is a theme that does nothing, and a
   picker whose rows silently stop working is worse than one that keeps a channel selected. */
function toggleChannel(channels, key) {
  if (!channels.includes(key)) {
    return CHANNELS.map((channel) => channel.key).filter(
      (channel) => channels.includes(channel) || channel === key,
    )
  }
  const next = channels.filter((channel) => channel !== key)
  return next.length ? next : channels
}
