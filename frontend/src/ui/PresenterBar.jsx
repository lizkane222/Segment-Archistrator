/* The controls floating over the diagram while presenting. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Maximize, Minimize, PanelLeft, PanelRight, X } from 'lucide-react'

import { PRESENTER } from './presenter.js'
import { INSPECTOR_OPEN, PALETTE_OPEN } from './preferences.js'

function Button({ label, pressed, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={`nodrag flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        pressed ? 'bg-twilio-blue-light text-twilio-blue-dark' : 'text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy'
      }`}
    >
      {children}
    </button>
  )
}

export default function PresenterBar() {
  const palette = useSyncExternalStore(PALETTE_OPEN.subscribe, PALETTE_OPEN.get)
  const inspector = useSyncExternalStore(INSPECTOR_OPEN.subscribe, INSPECTOR_OPEN.get)
  const [full, setFull] = useState(Boolean(globalThis.document?.fullscreenElement))

  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }

  return (
    <div className="absolute right-3 top-3 z-30 flex items-center gap-0.5 rounded-lg border border-twilio-gray-20 bg-white/95 p-1 shadow-sm">
      <Button label={palette ? 'Hide left panel' : 'Show left panel'} pressed={palette} onClick={() => PALETTE_OPEN.set(!palette)}>
        <PanelLeft size={15} aria-hidden="true" />
      </Button>
      <Button label={inspector ? 'Hide right panel' : 'Show right panel'} pressed={inspector} onClick={() => INSPECTOR_OPEN.set(!inspector)}>
        <PanelRight size={15} aria-hidden="true" />
      </Button>
      <Button label={full ? 'Leave full screen' : 'Full screen'} pressed={full} onClick={toggleFullscreen}>
        {full ? <Minimize size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}
      </Button>
      <span className="mx-0.5 h-4 w-px bg-twilio-gray-20" aria-hidden="true" />
      <button
        type="button"
        onClick={() => PRESENTER.set(false)}
        className="nodrag flex items-center gap-1 rounded-md px-2 py-1 text-xs text-twilio-gray-60 hover:bg-twilio-gray-10 hover:text-twilio-navy"
        title="Leave presenter view"
      >
        <X size={13} aria-hidden="true" />
        Exit
      </button>
    </div>
  )
}
