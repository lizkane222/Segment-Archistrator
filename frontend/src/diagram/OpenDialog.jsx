/*
 * The Open dialog: seeded reference architectures on the left, this workspace's
 * saved diagrams on the right.
 *
 * Both live in one dialog because from the user's point of view they answer the
 * same question -- "what am I starting from?" -- even though one is a global
 * read-only fixture and the other is workspace-scoped and editable. The difference
 * that matters is stated where it applies: opening a template creates an unsaved
 * document, so the first Save makes a copy rather than editing the template.
 *
 * Delete asks for confirmation inline rather than via `confirm()`: a native dialog
 * blocks the whole tab and looks like a browser error next to this UI.
 */

import { useEffect, useState } from 'react'
import {
  FilePlus2,
  LayoutTemplate,
  Loader2,
  Save,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'

export default function OpenDialog({
  templates,
  saved,
  loading,
  error,
  busy,
  currentId,
  onOpenTemplate,
  onOpenDiagram,
  onStartBlank,
  onDelete,
  onClose,
}) {
  const [confirming, setConfirming] = useState(null)

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      /* Click-through-to-close on the backdrop only, never on the card. */
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-center justify-between border-b border-twilio-gray-20 px-4 py-3">
          <h2 className="text-sm font-semibold text-twilio-navy">Open an architecture</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-twilio-gray-40 transition-colors hover:text-twilio-navy"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {error && (
          <p className="flex items-start gap-2 border-b border-twilio-gray-20 bg-twilio-red-light px-4 py-2 text-xs text-twilio-navy">
            <TriangleAlert size={13} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
            {error}
          </p>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto sm:grid-cols-2">
          <section className="border-b border-twilio-gray-20 sm:border-b-0 sm:border-r">
            <Heading
              icon={LayoutTemplate}
              title="Reference architectures"
              note="Seeded templates. Opening one makes a copy — the template itself is never edited."
            />
            <div className="p-2">
              {loading && <Loading />}
              {!loading && !templates.length && (
                <Empty>
                  No templates are seeded. Run <code className="font-mono">seed_templates</code> on
                  the server.
                </Empty>
              )}
              {templates.map((template) => (
                <Entry
                  key={template.key}
                  title={template.name}
                  description={template.description}
                  meta={[
                    template.category,
                    template.placeholder_count
                      ? `${template.placeholder_count} to bind`
                      : null,
                  ]}
                  disabled={Boolean(busy)}
                  onOpen={() => onOpenTemplate(template.key)}
                />
              ))}
            </div>
          </section>

          <section>
            <Heading
              icon={Save}
              title="Saved in this workspace"
              note="Only visible to someone holding a token for this workspace."
            />
            <div className="p-2">
              {loading && <Loading />}
              {!loading && !saved.length && (
                <Empty>Nothing saved yet. Open a template or load the workspace, then Save.</Empty>
              )}
              {saved.map((diagram) => (
                <Entry
                  key={diagram.id}
                  title={diagram.name}
                  description={diagram.description}
                  active={diagram.id === currentId}
                  meta={[
                    `${diagram.node_count ?? 0} components`,
                    diagram.placeholder_count
                      ? `${diagram.placeholder_count} unbound`
                      : null,
                    formatWhen(diagram.updated_at),
                  ]}
                  disabled={Boolean(busy)}
                  onOpen={() => onOpenDiagram(diagram.id)}
                  onDelete={() => setConfirming(diagram.id)}
                  confirming={confirming === diagram.id}
                  onConfirmDelete={async () => {
                    await onDelete(diagram.id)
                    setConfirming(null)
                  }}
                  onCancelDelete={() => setConfirming(null)}
                />
              ))}
            </div>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-twilio-gray-20 bg-twilio-gray-10 px-4 py-2.5">
          <p className="text-[11px] text-twilio-gray-60">
            Opening replaces what is on the canvas.
          </p>
          <button
            type="button"
            onClick={onStartBlank}
            disabled={Boolean(busy)}
            className="flex items-center gap-1.5 rounded-md border border-twilio-gray-20 bg-white px-3 py-1.5 text-xs text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy disabled:opacity-50"
          >
            <FilePlus2 size={13} aria-hidden="true" />
            Start from an empty canvas
          </button>
        </footer>
      </div>
    </div>
  )
}

function Heading({ icon: Icon, title, note }) {
  return (
    <div className="border-b border-twilio-gray-20 px-4 py-2.5">
      <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-twilio-gray-60">
        <Icon size={12} aria-hidden="true" />
        {title}
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-twilio-gray-60">{note}</p>
    </div>
  )
}

function Entry({
  title,
  description,
  meta = [],
  active,
  disabled,
  onOpen,
  onDelete,
  confirming,
  onConfirmDelete,
  onCancelDelete,
}) {
  if (confirming) {
    return (
      <div className="mb-1 rounded-md border border-twilio-error bg-twilio-red-light p-2.5 text-xs">
        <p className="text-twilio-navy">
          Delete <span className="font-semibold">{title}</span>? This cannot be undone.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onConfirmDelete}
            className="rounded border border-twilio-error px-2 py-1 text-[11px] font-medium text-twilio-error transition-colors hover:bg-twilio-error hover:text-white"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            className="rounded border border-twilio-gray-20 bg-white px-2 py-1 text-[11px] text-twilio-gray-60 hover:text-twilio-navy"
          >
            Keep it
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group mb-1 flex items-start gap-2 rounded-md border p-2.5 transition-colors ${
        active
          ? 'border-twilio-blue bg-twilio-blue-light/40'
          : 'border-transparent hover:border-twilio-gray-20 hover:bg-twilio-gray-10'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="min-w-0 flex-1 text-left disabled:opacity-50"
      >
        <span className="block truncate text-xs font-semibold text-twilio-navy">
          {title}
          {active && <span className="ml-2 text-[10px] font-normal text-twilio-blue">open</span>}
        </span>
        {description && (
          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-twilio-gray-60">
            {description}
          </span>
        )}
        <span className="mt-1 block text-[10px] text-twilio-gray-40">
          {meta.filter(Boolean).join(' · ')}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          title={`Delete ${title}`}
          className="shrink-0 text-twilio-gray-40 opacity-0 transition-opacity hover:text-twilio-error group-hover:opacity-100 disabled:opacity-30"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function Loading() {
  return (
    <p className="flex items-center gap-2 px-2 py-3 text-xs text-twilio-gray-60">
      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      Loading…
    </p>
  )
}

function Empty({ children }) {
  return <p className="px-2 py-3 text-xs italic leading-relaxed text-twilio-gray-60">{children}</p>
}

/* Relative for anything recent, absolute once "3 days ago" stops being useful.
   Deliberately not a dependency: this is the only place the app formats a date. */
export function formatWhen(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null

  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`
  return then.toLocaleDateString()
}
