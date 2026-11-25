/*
 * Admin mode's half of the Open dialog: choose what is in everyone's Reference architectures.
 *
 * Lists *every* built-in -- the withdrawn ones too, which nobody else can see -- with a switch for
 * whether each is offered, and two ways to add one: upload a diagram file, or publish the diagram that
 * is open. Shipped templates (from the fixture) can be withdrawn and restored but not edited or
 * deleted, because the next deploy would put them back; the ones published here can be removed.
 */

import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Loader2, ShieldCheck, Trash2, TriangleAlert, Upload } from 'lucide-react'

import { admin as adminApi, diagrams as diagramsApi, templates as templatesApi } from '../services/api.js'
import { DRAG_TYPE } from './openDrag.js'
import { parseDiagramFile } from './diagramFile.js'

export default function AdminTemplates({ currentName, getCurrentGraph, onChanged }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)
  const [over, setOver] = useState(false)

  const load = async () => {
    try {
      const result = await adminApi.templates.list()
      setItems(result?.items ?? [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  /* Every change re-reads both lists: this one, and the dialog's own, which is what everyone else sees. */
  const run = async (key, action) => {
    setBusy(key)
    setError(null)
    try {
      await action()
      await load()
      await onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const upload = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await run('upload', async () => {
      const parsed = parseDiagramFile(await file.text())
      await adminApi.templates.publish({
        name: parsed.name || file.name.replace(/\.[^.]+$/, ''),
        description: parsed.description ?? '',
        graph: parsed.graph,
      })
    })
  }

  /* A saved diagram or a template dragged in from the lists beside this: published as it stands.
     Something already offered to everyone says so rather than publishing a duplicate. */
  const drop = async (event) => {
    event.preventDefault()
    setOver(false)
    let dragged = null
    try {
      dragged = JSON.parse(event.dataTransfer.getData(DRAG_TYPE))
    } catch {
      return
    }
    if (!dragged?.id) return
    if (dragged.kind === 'template' && dragged.builtin) {
      setError(`“${dragged.name}” is already a reference architecture everyone sees.`)
      return
    }
    await run('drop', async () => {
      const source =
        dragged.kind === 'diagram'
          ? await diagramsApi.get(dragged.id)
          : await templatesApi.get(dragged.id)
      await adminApi.templates.publish({
        name: source.name || dragged.name || 'Untitled architecture',
        description: source.description ?? '',
        graph: source.graph,
      })
    })
  }

  const publishOpen = () =>
    run('publish', () =>
      adminApi.templates.publish({ name: currentName || 'Untitled architecture', description: '', graph: getCurrentGraph() }),
    )

  return (
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget) && setOver(false)}
      onDrop={drop}
      className={`m-2 rounded-md border p-2.5 transition-colors ${
        over
          ? 'border-twilio-blue bg-twilio-blue-light/70 ring-2 ring-twilio-blue/40'
          : 'border-twilio-blue/40 bg-twilio-blue-light/30'
      }`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-twilio-blue-dark">
        <ShieldCheck size={12} aria-hidden="true" />
        Admin mode — what everyone sees here
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy === 'upload'}
          className="flex items-center gap-1.5 rounded-md bg-twilio-blue px-2.5 py-1 text-[11px] font-medium text-white hover:bg-twilio-blue-dark disabled:opacity-50"
          title="Upload a diagram file exported from this app and publish it as a Reference architecture"
        >
          <Upload size={12} aria-hidden="true" />
          Upload diagram file
        </button>
        <button
          type="button"
          onClick={publishOpen}
          disabled={busy === 'publish'}
          className="rounded-md border border-twilio-gray-20 bg-white px-2.5 py-1 text-[11px] text-twilio-gray-60 hover:border-twilio-gray-40 hover:text-twilio-navy disabled:opacity-50"
          title="Publish the diagram in the tab you were in"
        >
          Publish open diagram
        </button>
        <span className="self-center text-[11px] text-twilio-gray-60">
          {busy === 'drop' ? 'Publishing…' : 'or drag a diagram or template here'}
        </span>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={upload} />
      </div>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-twilio-navy">
          <TriangleAlert size={12} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-twilio-gray-60">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-twilio-gray-10 rounded border border-twilio-gray-20 bg-white">
          {items.map((item) => (
            <li key={item.key} className={`flex items-center gap-2 px-2 py-1.5 text-[11px] ${item.published ? '' : 'opacity-60'}`}>
              <span className="min-w-0 flex-1 truncate text-twilio-navy" title={item.description}>
                {item.name}
                <span className="ml-1.5 text-twilio-gray-40">{item.shipped ? 'shipped' : 'published here'}</span>
                {!item.published && <span className="ml-1.5 text-twilio-warning">hidden from everyone</span>}
              </span>
              <button
                type="button"
                disabled={busy === item.key}
                onClick={() => run(item.key, () => adminApi.templates.update(item.key, { published: !item.published }))}
                title={item.published ? 'Hide from everyone’s Reference architectures' : 'Show to everyone'}
                className="rounded p-1 text-twilio-gray-40 hover:text-twilio-navy disabled:opacity-40"
              >
                {item.published ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
              </button>
              {!item.shipped && (
                <button
                  type="button"
                  disabled={busy === item.key}
                  onClick={() => run(item.key, () => adminApi.templates.remove(item.key))}
                  title="Delete this published template"
                  className="rounded p-1 text-twilio-gray-40 hover:text-twilio-error disabled:opacity-40"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
