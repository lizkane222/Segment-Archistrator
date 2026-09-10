/*
 * The single fetch wrapper. Everything that talks to Django goes through here.
 *
 * Three responsibilities, all of which are easy to get subtly wrong per-call:
 *   - send the session cookie (`credentials: 'same-origin'`)
 *   - send X-CSRFToken on mutations, read from the csrftoken cookie
 *   - unwrap the server's `{error: {code, message}}` envelope into a thrown
 *     ApiError, so callers can `catch` rather than inspect response.ok
 */

export class ApiError extends Error {
  constructor(message, { status, code, retryAfter, fields } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    /* DRF serializer errors, keyed by field. A rejected save lands here, and the
       messages are the specific ones -- "edge source:a -> space:s is not a legal
       connection" beats the envelope's generic "Request failed." */
    this.fields = fields ?? null
  }

  /** True when the caller should send the visitor back to the token screen. */
  get isUnauthenticated() {
    return (
      this.status === 401 ||
      this.code === 'not_authenticated' ||
      this.code === 'invalid_token'
    )
  }

  /* Deliberately not `isUnauthenticated`. A tokenless session is a real session
     holding real unsaved work, so this must not trigger the re-bootstrap that
     one does -- the answer is "connect a workspace", not "start over". */
  get needsWorkspace() {
    return (
      this.code === 'workspace_not_connected' ||
      /* A workspace *is* connected, with an app session auth_token -- which identifies it but
         cannot read its components yet. Grouped here rather than with `isUnauthenticated`
         for the same reason: the session is real and holds real work, and the answer is
         "connect the other kind of credential", not "start over". */
      this.code === 'credential_cannot_read_workspace'
    )
  }
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[2]) : null
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  if (UNSAFE.has(method)) {
    const csrftoken = readCookie('csrftoken')
    // Missing means the CSRF cookie was never planted. GET /api/session sets it,
    // which is why the app calls that on boot before anything else.
    if (csrftoken) headers['X-CSRFToken'] = csrftoken
  }

  const response = await fetch(path, {
    method,
    headers,
    signal,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 204) return null

  let payload = null
  try {
    payload = await response.json()
  } catch {
    // A non-JSON body from Django means something upstream answered -- a proxy
    // error page, or the SPA fallback catching a mistyped path.
    if (!response.ok) {
      throw new ApiError(`${method} ${path} failed (${response.status}).`, {
        status: response.status,
      })
    }
    return null
  }

  if (!response.ok) {
    const error = payload?.error ?? {}
    throw new ApiError(errorMessage(error) ?? `${method} ${path} failed.`, {
      status: response.status,
      code: error.code,
      retryAfter: error.retryAfter,
      fields: error.fields,
    })
  }

  return payload
}

/* Prefer the field-level messages when there are any: DRF's envelope carries a
   generic "Request failed." alongside `fields`, and the specific reason a save was
   rejected is the only thing the user can act on. Capped, because a 40-node
   architecture can produce 12 validation errors and a toast is not a report. */
function errorMessage(error) {
  const detail = Object.values(error.fields ?? {})
    .flat()
    .filter((value) => typeof value === 'string')
  if (!detail.length) return error.message
  const shown = detail.slice(0, 3).join(' ')
  return detail.length > 3 ? `${shown} (+${detail.length - 3} more)` : shown
}

/* --- Session ------------------------------------------------------------- */

export const session = {
  /** Who am I. Also plants the csrftoken cookie -- call this first, on boot. */
  current: () => request('/api/session'),
  /**
   * The whole login flow. The credential goes up once and never comes back down.
   *
   * `credential` names which of the two ways in this is -- a scoped Public API token, or the
   * `auth_token` of somebody's app session. The app expresses no preference between them; the
   * caller says which it has.
   *
   * `workspaceId` is only meaningful for the GraphQL option, and only after the server has
   * answered `needsChoice`: a Public API token belongs to exactly one workspace, but an
   * auth_token is a person, and a person is often in dozens. Omitting it the first time is
   * correct -- that is how the list comes back to choose from.
   *
   * Two shapes of success come out of here, and the caller has to tell them apart:
   * `{workspace, claimed}` means connected, and `{needsChoice: true, workspaces}` means the
   * credential works but the question has not been answered yet.
   */
  start: (token, region = 'us', { credential = 'public_api', workspaceId } = {}) =>
    request('/api/session', {
      method: 'POST',
      body: {
        token,
        region,
        credential,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      },
    }),
  /* A scope to save into with no token yet. Idempotent server-side, which is
     what makes it safe to call from an effect that may run twice. */
  startAnonymous: () => request('/api/session/anonymous', { method: 'POST' }),
  end: () => request('/api/session', { method: 'DELETE' }),
}

/* --- Static rules -------------------------------------------------------- */

export const meta = {
  /* Zones and legal connections, defined server-side so the canvas and the
     backend cannot disagree about what a valid architecture is. */
  topology: () => request('/api/meta/topology'),
}

/* --- Global catalog (from Postgres; costs no Segment rate budget) --------- */

export const catalog = {
  sources: (params) => request(`/api/catalog/sources${query(params)}`),
  destinations: (params) => request(`/api/catalog/destinations${query(params)}`),
  warehouses: (params) => request(`/api/catalog/warehouses${query(params)}`),
}

/* --- The customer's live workspace --------------------------------------- */

export const workspace = {
  graph: ({ refresh } = {}) => request(`/api/workspace/graph${query({ refresh })}`),
  sources: (p) => request(`/api/workspace/sources${query(p)}`),
  destinations: (p) => request(`/api/workspace/destinations${query(p)}`),
  warehouses: (p) => request(`/api/workspace/warehouses${query(p)}`),
  functions: (p) => request(`/api/workspace/functions${query(p)}`),
  reverseEtlModels: (p) => request(`/api/workspace/reverse-etl-models${query(p)}`),
  spaces: (p) => request(`/api/workspace/spaces${query(p)}`),
  audiences: (spaceId, p) =>
    request(`/api/workspace/spaces/${spaceId}/audiences${query(p)}`),
  computedTraits: (spaceId, p) =>
    request(`/api/workspace/spaces/${spaceId}/computed-traits${query(p)}`),
  destinationFilters: (destinationId, p) =>
    request(`/api/workspace/destinations/${destinationId}/filters${query(p)}`),

  /* Space Schema. 25 req/min upstream -- load these lazily, per inspected node,
     and never in a loop over every node on the canvas. */
  spaceEvents: (spaceId, p) => request(`/api/workspace/spaces/${spaceId}/events${query(p)}`),
  spaceEventProperties: (spaceId, eventName, p) =>
    request(
      `/api/workspace/spaces/${spaceId}/events/${encodeURIComponent(eventName)}/properties${query(p)}`,
    ),
  spaceTraits: (spaceId, p) => request(`/api/workspace/spaces/${spaceId}/traits${query(p)}`),

  /* Deliberately POST: a write key must not be reachable by a link, a prefetch,
     or an <img> tag. Every call is audited server-side. */
  revealWriteKey: (sourceId) =>
    request(`/api/workspace/sources/${sourceId}/reveal-write-key`, { method: 'POST' }),
}

/* --- Diagrams and templates ---------------------------------------------- */

export const templates = {
  list: () => request('/api/templates'),
  get: (key) => request(`/api/templates/${key}`),
}

export const diagrams = {
  list: () => request('/api/diagrams'),
  get: (id) => request(`/api/diagrams/${id}`),
  create: (data) => request('/api/diagrams', { method: 'POST', body: data }),
  update: (id, data) => request(`/api/diagrams/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/api/diagrams/${id}`, { method: 'DELETE' }),
}

/* --- Nuances ------------------------------------------------------------- */

/* Per component *kind*, never per node: a nuance about destination filters is true
   of every destination. Reads need no session because a nuance is a fact about
   Segment rather than about a workspace -- see apps/nuances/models.py for what the
   table deliberately does not record. */
export const nuances = {
  list: (kind, slug) => request(`/api/nuances${query({ kind, slug })}`),
  submit: (data) => request('/api/nuances/submit', { method: 'POST', body: data }),
}

function query(params) {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v))
    else search.append(key, value === true ? '1' : value)
  }
  const string = search.toString()
  return string ? `?${string}` : ''
}
