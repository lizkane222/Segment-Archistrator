/*
 * Lazy Space Schema loading for the Fields tab.
 *
 * The upstream limit is 25 requests/minute across this whole surface, which is
 * the tightest budget in the API. Three consequences, all deliberate:
 *
 *   1. Nothing loads until the Fields tab is actually opened. Prefetching the
 *      schema for every node on the canvas would exhaust the minute's budget on
 *      a diagram nobody has looked at yet.
 *   2. An event's properties load only when that event is expanded.
 *   3. Results are memoized at module scope, not in component state. The
 *      inspector unmounts every time the selection changes, so component state
 *      would mean a fresh request each time someone clicks between two audiences
 *      in the same space. Django caches these for an hour, so the repeat would
 *      not reach Segment -- but it would still be a needless round trip per
 *      click, and the flash of a loading spinner on data we already have reads as
 *      slowness.
 *
 * The cache is intentionally not invalidated on a timer. It is dropped when the
 * page reloads, and `refresh` forces past both this and the server's cache.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { workspace as workspaceApi } from '../services/api.js'

const eventsCache = new Map() // spaceId -> events[]
const traitsCache = new Map() // spaceId -> traits[]
const propsCache = new Map() // `${spaceId}::${eventName}` -> properties[]

/** Drop everything. Called on sign-out so one visitor's schema is not the next's. */
export function clearSchemaCache() {
  eventsCache.clear()
  traitsCache.clear()
  propsCache.clear()
}

/**
 * Events and profile traits for one space.
 *
 * Both are fetched together because the Fields tab shows both, and paying two
 * round trips one after the other only to render them side by side would show
 * two separate spinners for one visual unit.
 */
export function useSpaceSchema(spaceId) {
  const [state, setState] = useState({ status: 'idle', events: [], traits: [], error: null })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async ({ refresh = false } = {}) => {
      if (!spaceId) return

      if (!refresh && eventsCache.has(spaceId) && traitsCache.has(spaceId)) {
        setState({
          status: 'ready',
          events: eventsCache.get(spaceId),
          traits: traitsCache.get(spaceId),
          error: null,
        })
        return
      }

      setState((current) => ({ ...current, status: 'loading', error: null }))
      try {
        /* Both are 25/min endpoints, so they go out together rather than
           sequentially -- two concurrent requests cost the same budget as two
           serial ones and halve the wait. */
        const [events, traits] = await Promise.all([
          workspaceApi.spaceEvents(spaceId, { refresh }),
          workspaceApi.spaceTraits(spaceId, { refresh }),
        ])
        eventsCache.set(spaceId, events.items ?? [])
        traitsCache.set(spaceId, traits.items ?? [])
        if (!mounted.current) return
        setState({
          status: 'ready',
          events: events.items ?? [],
          traits: traits.items ?? [],
          error: null,
        })
      } catch (err) {
        if (!mounted.current) return
        setState({ status: 'error', events: [], traits: [], error: err })
      }
    },
    [spaceId],
  )

  /* Reset when the space changes, so the previous space's events are never shown
     under a new space's heading while the fetch is in flight. */
  useEffect(() => {
    setState({ status: 'idle', events: [], traits: [], error: null })
  }, [spaceId])

  return { ...state, load }
}

/** One event's properties, fetched on expand. */
export function useEventProperties(spaceId) {
  const [byEvent, setByEvent] = useState({}) // eventName -> {status, items, error}

  const load = useCallback(
    async (eventName, { refresh = false } = {}) => {
      if (!spaceId || !eventName) return
      const cacheKey = `${spaceId}::${eventName}`

      if (!refresh && propsCache.has(cacheKey)) {
        setByEvent((current) => ({
          ...current,
          [eventName]: { status: 'ready', items: propsCache.get(cacheKey), error: null },
        }))
        return
      }

      setByEvent((current) => ({
        ...current,
        [eventName]: { status: 'loading', items: [], error: null },
      }))
      try {
        const result = await workspaceApi.spaceEventProperties(spaceId, eventName, { refresh })
        propsCache.set(cacheKey, result.items ?? [])
        setByEvent((current) => ({
          ...current,
          [eventName]: { status: 'ready', items: result.items ?? [], error: null },
        }))
      } catch (err) {
        setByEvent((current) => ({
          ...current,
          [eventName]: { status: 'error', items: [], error: err },
        }))
      }
    },
    [spaceId],
  )

  useEffect(() => setByEvent({}), [spaceId])

  return { byEvent, load }
}
