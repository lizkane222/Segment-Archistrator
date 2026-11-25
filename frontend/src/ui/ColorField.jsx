/*
 * A colour control: the current colour, and a short list of the colours this app already uses.
 *
 * The browser's own `<input type="color">` opens the operating system's picker, which knows nothing
 * about the product palette -- someone recolouring a connector to match the Unify zone had to find
 * #6f42c1 by eye. So the swatches come first, named, and the system picker is one click further for
 * anything else.
 */

import { useEffect, useRef, useState } from 'react'

import { COLOR_PRESETS } from '../canvas/kinds.js'

export default function ColorField({ value, onChange, label = 'Color', align = 'left' }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef(null)
  const native = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!wrapper.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = String(value ?? '').toLowerCase()

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${label}: ${value}`}
        title={label}
        className="nodrag h-6 w-10 shrink-0 cursor-pointer rounded border border-twilio-gray-20"
        style={{ background: value }}
      />
      {open && (
        <div
          role="menu"
          className={`nodrag absolute z-30 mt-1 w-44 rounded-md border border-twilio-gray-20 bg-white p-2 shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <ul className="grid grid-cols-3 gap-1.5">
            {COLOR_PRESETS.map((preset) => {
              const selected = current === preset.value.toLowerCase()
              return (
                <li key={preset.name}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      onChange(preset.value)
                      setOpen(false)
                    }}
                    title={`${preset.name} ${preset.value}`}
                    className="nodrag flex w-full flex-col items-center gap-0.5 rounded p-1 text-[9px] text-twilio-gray-60 hover:bg-twilio-gray-10"
                  >
                    <span
                      className={`h-5 w-5 rounded border-2 ${
                        selected ? 'border-twilio-navy' : 'border-twilio-gray-20'
                      }`}
                      style={{ background: preset.value }}
                    />
                    {preset.name}
                  </button>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            onClick={() => native.current?.click()}
            className="nodrag mt-2 w-full rounded border border-twilio-gray-20 px-2 py-1 text-[10px] text-twilio-gray-60 hover:border-twilio-blue hover:text-twilio-blue"
          >
            Custom color…
          </button>
          {/* The system picker, kept for anything the presets do not cover. Visually hidden rather
              than unmounted: `click()` has to reach a mounted input. */}
          <input
            ref={native}
            type="color"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="sr-only"
            tabIndex={-1}
            aria-label="Custom color"
          />
        </div>
      )}
    </div>
  )
}
