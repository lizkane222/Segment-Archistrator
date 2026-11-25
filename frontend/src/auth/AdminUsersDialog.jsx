/*
 * Everyone who has signed in, and who may administer the app.
 *
 * An administrator can publish diagrams to everyone's Reference architectures and make other people
 * administrators. Owners (set in the server's ADMIN_EMAILS) are always administrators and cannot be
 * changed here, and nobody can remove their own access -- both enforced by the server, and mirrored
 * here only so the button is not offered.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react'

import { admin as adminApi } from '../services/api.js'

const when = (value) => (value ? new Date(value).toLocaleDateString() : 'never')

export default function AdminUsersDialog({ selfEmail, onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    adminApi.users
      .list()
      .then((result) => !cancelled && setUsers(result?.items ?? []))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async (user) => {
    setSaving(user.id)
    setError(null)
    try {
      const updated = await adminApi.users.setAdmin(user.id, !user.isAdmin)
      setUsers((current) => current.map((entry) => (entry.id === user.id ? { ...entry, ...updated } : entry)))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(null)
    }
  }

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return needle
      ? users.filter((user) => `${user.email} ${user.name}`.toLowerCase().includes(needle))
      : users
  }, [users, search])

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-twilio-navy/30 p-6"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-twilio-gray-20 bg-white shadow-lg">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-twilio-gray-20 px-4 py-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-twilio-navy">
              <ShieldCheck size={14} aria-hidden="true" />
              Users
            </h2>
            <p className="text-[11px] text-twilio-gray-60">
              Administrators can publish to everyone’s Reference architectures and make other
              administrators.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-twilio-gray-40 hover:text-twilio-navy" title="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="shrink-0 border-b border-twilio-gray-20 px-4 py-2">
          <label className="flex items-center gap-2 rounded border border-twilio-gray-20 px-2 py-1 text-xs text-twilio-gray-60">
            <Search size={12} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or email"
              className="min-w-0 flex-1 bg-transparent text-twilio-navy outline-none placeholder:text-twilio-gray-40"
            />
          </label>
        </div>

        {error && (
          <p className="flex shrink-0 items-start gap-2 bg-twilio-red-light px-4 py-2 text-xs text-twilio-navy">
            <TriangleAlert size={13} className="mt-px shrink-0 text-twilio-error" aria-hidden="true" />
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <p className="flex items-center gap-2 px-4 py-6 text-xs text-twilio-gray-60">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              Loading users…
            </p>
          )}
          {!loading && !shown.length && (
            <p className="px-4 py-6 text-xs text-twilio-gray-60">No one matches.</p>
          )}
          <ul className="divide-y divide-twilio-gray-10">
            {shown.map((user) => {
              const self = user.email === selfEmail
              const locked = user.isOwner || self
              return (
                <li key={user.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-twilio-navy">
                      {user.name || user.email}
                      {self && <span className="ml-1 font-normal text-twilio-gray-40">(you)</span>}
                    </p>
                    {user.name && <p className="truncate text-[11px] text-twilio-gray-60">{user.email}</p>}
                    <p className="text-[10px] text-twilio-gray-40">
                      Last signed in {when(user.lastLoginAt)} · {user.diagrams ?? 0} diagram
                      {user.diagrams === 1 ? '' : 's'}
                    </p>
                  </div>
                  {user.isOwner ? (
                    <span className="rounded bg-twilio-blue-light px-1.5 py-0.5 text-[10px] font-semibold uppercase text-twilio-blue-dark">
                      Owner
                    </span>
                  ) : (
                    user.isAdmin && (
                      <span className="rounded bg-twilio-blue-light px-1.5 py-0.5 text-[10px] font-semibold uppercase text-twilio-blue-dark">
                        Admin
                      </span>
                    )
                  )}
                  <button
                    type="button"
                    onClick={() => toggle(user)}
                    disabled={saving === user.id || (user.isAdmin && locked)}
                    title={
                      user.isOwner
                        ? 'Owners are set on the server and cannot be changed here.'
                        : user.isAdmin && self
                          ? 'You cannot remove your own access.'
                          : undefined
                    }
                    className="w-28 shrink-0 rounded-md border border-twilio-gray-20 px-2.5 py-1 text-[11px] text-twilio-gray-60 transition-colors hover:border-twilio-gray-40 hover:text-twilio-navy disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving === user.id ? 'Saving…' : user.isAdmin ? 'Remove admin' : 'Make admin'}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
