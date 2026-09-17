/*
 * The event itself: one glowing token per place the event is, moving continuously.
 *
 * ## Why this is a layer and not part of the edge
 *
 * The event used to be a circle inside `FlowEdge`, mounted while that connector's beat was the
 * current one. So it existed for the travelling beats and not for the arriving ones -- on every
 * arrival there was no event anywhere on screen for a full second, and a component simply lit up on
 * its own. Half of every run had no event in it, which is why it read as the diagram stepping rather
 * than as something flowing through it.
 *
 * An event is not a property of a connector. It is one thing that moves through the whole diagram,
 * so it is drawn by one thing that spans the whole diagram, and it exists from the first millisecond
 * of a run to the last.
 *
 * ## Why it moves imperatively
 *
 * Position changes every frame. Holding it in React state would re-render `AppShell` -- the entire
 * application -- sixty times a second to move a dot. So the tokens are mounted once per run (React,
 * a couple of renders per playthrough) and then *moved* by writing `transform` straight onto the
 * elements inside this component's own animation frame, reading the clock out of a ref. Nothing
 * renders from the clock, so nothing has to re-render when it advances.
 *
 * The pool is sized to `maxConcurrency` -- the most places the event is at once over the whole run,
 * usually one and two at a fork. Live legs are assigned to slots in trace order, which is stable, so
 * a token keeps following the same branch for as long as that branch exists. This works out
 * continuously at a fork because every leg of a wave starts at the same point: slot 1 appears at the
 * component the fork leaves from rather than out of nowhere.
 *
 * ## Geometry
 *
 * Read from the routes the edges publish (`edgeRoutes` in canvas/chrome.js), which is the line as
 * *drawn* -- chosen line style, hand-dragged bends and all -- extended to both components' centres.
 * Re-deriving it here would be a second implementation of the router, and the two disagreeing means
 * an event travelling somewhere the line does not go.
 *
 * `ViewportPortal` puts all of this in flow coordinates, so panning and zooming carry the event with
 * the diagram for free and an export captures it where it appears.
 */

import { useEffect, useMemo, useRef } from 'react'
import { ViewportPortal, useReactFlow } from '@xyflow/react'

import { pointAlong } from '../canvas/edges/routing.js'
import { NODE_HEIGHT, NODE_WIDTH } from '../canvas/layout.js'
import { useChrome } from '../canvas/chrome.js'
import { legsAt, maxConcurrency } from './choreography.js'

/* How many trailing dots follow each token, and how far behind in milliseconds the last one is.
   The tail is what makes direction readable on a long connector at the zoom a whole architecture is
   viewed at, where the head alone is a few pixels crossing a wide gap. */
const TAIL = 5
const TAIL_MS = 150

/* Radius of the token, in flow units. Deliberately close to a component's corner radius rather than
   as small as a dot can be: this is the thing the reader is following. */
const HEAD_R = 7

/*
 * Above everything on the canvas, and this is load-bearing rather than tidy.
 *
 * The token's route runs centre to centre, so it spends part of every hop *inside* the two cards -- and
 * on a tightly packed diagram, where consecutive components sit tens of pixels apart, that is most of
 * every hop. `ViewportPortal` puts this in the same stacking context as `.react-flow__nodes`, so with
 * no z-index of its own the token loses to any positioned node: `walkthrough-here` sets `z-index: 4` on
 * the component the event is arriving at, and React Flow elevates a selected node further still.
 *
 * The symptom was the event flowing across open space and then apparently stopping for several
 * components in a dense part of the diagram, while the glow carried on -- it had not stopped, it was
 * behind the cards. Comfortably clear of both so a card cannot get in front of the playhead.
 */
const TOKEN_Z = 2000

export default function EventLayer({ plans, clock, active }) {
  const { getInternalNode } = useReactFlow()
  const { routes } = useChrome()

  /* One entry per token the canvas has to mount, flattened across runs so the render below is a flat
     list and the animation frame can walk it with one index. */
  const slots = useMemo(() => {
    const out = []
    for (const plan of plans ?? []) {
      const count = maxConcurrency(plan.legs)
      for (let slot = 0; slot < count; slot += 1) out.push({ plan, slot })
    }
    return out
  }, [plans])

  /* The DOM nodes, in the same order as `slots`. Written to by the loop below and never read during
     a render, which is what keeps the movement out of React's hands. */
  const heads = useRef([])
  const tails = useRef([])

  /*
   * The itineraries, in a ref the loop reads rather than in its dependency list.
   *
   * Same reasoning as `offsetsRef` in simulation/usePlayback.js. `plans` is derived, several layers up,
   * from things that get a new identity while a walkthrough plays -- so depending on it would tear the
   * animation frame down and restart it repeatedly mid-run for a value whose *contents* had not changed.
   * The loop wants the latest legs, not a reason to restart.
   */
  const planRef = useRef(plans)
  planRef.current = plans

  useEffect(() => {
    if (!active || slots.length === 0) return undefined

    let frame = 0
    const draw = () => {
      const at = clock?.current ?? 0

      /* Grouped by run so each run's live legs are matched to that run's own slots. Recomputed each
         frame rather than cached: it is a filter over a few dozen legs, and a cache keyed on time is
         a cache that is wrong for exactly the frame it matters. */
      let cursor = 0
      for (const plan of planRef.current ?? []) {
        const live = legsAt(plan.legs, at)
        const count = maxConcurrency(plan.legs)

        for (let slot = 0; slot < count; slot += 1) {
          const head = heads.current[cursor]
          const tail = tails.current[cursor]
          cursor += 1
          if (!head) continue

          const leg = live[slot]
          if (!leg) {
            /* Hidden rather than moved off-screen: an element parked at 0,0 is an event sitting in
               the top-left corner of the diagram, which is a claim about the run. */
            head.style.opacity = '0'
            if (tail) tail.style.opacity = '0'
            continue
          }

          const point = positionOf(leg, plan, routes, getInternalNode)
          if (!point) {
            head.style.opacity = '0'
            if (tail) tail.style.opacity = '0'
            continue
          }

          head.style.opacity = '1'
          /*
           * A settle on arrival, so a beat spent at a component reads as the event landing rather
           * than as the animation stopping for a second. The token is stationary through a dwell --
           * correctly, it is *there* -- and without this the only cue that anything happened is a
           * halo appearing under it.
           */
          head.style.transform =
            `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%) scale(${settle(leg)})`

          /* The tail is the same token sampled a moment earlier, so it lies along the route rather
             than along the straight line between two frames -- which is what would happen if it
             simply remembered where the head was. It vanishes during a dwell: the event is not
             moving, and a comet tail on something stationary reads as it still travelling. */
          if (tail) {
            const trailing = leg.kind === 'travel' && leg.progress < 1
            tail.style.opacity = trailing ? '1' : '0'
            if (trailing) {
              for (let step = 0; step < TAIL; step += 1) {
                const dot = tail.children[step]
                if (!dot) continue
                const behind = positionOf(leg, plan, routes, getInternalNode, {
                  at: at - ((step + 1) * TAIL_MS) / TAIL,
                })
                if (!behind) {
                  dot.style.opacity = '0'
                  continue
                }
                dot.style.opacity = String(0.4 * (1 - step / TAIL))
                dot.style.transform = `translate3d(${behind.x}px, ${behind.y}px, 0) translate(-50%, -50%)`
              }
            }
          }
        }
      }

      frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
    /*
     * Only the things that change *what exists* restart the loop: whether a run is on screen, and how
     * many tokens are mounted. Everything the loop reads per frame -- the clock, the itineraries, the
     * published routes -- is behind a ref, deliberately, so a value that gets a new identity twice a
     * second while a walkthrough plays cannot keep cancelling the animation frame and starting again.
     *
     * `slots.length` rather than `slots` for the same reason: its contents are rebuilt whenever the
     * plans are, but the only thing this loop needs from it is how many slots to walk.
     */
  }, [active, slots.length, clock, routes, getInternalNode])

  if (!active || slots.length === 0) return null

  return (
    <ViewportPortal>
      {slots.map(({ plan, slot }, index) => (
        <div
          key={`${plan.scenarioId}:${slot}`}
          aria-hidden="true"
          /* Absolute and zero-size at the viewport's origin, matching `AnchorGutter`: a block-level
             child inside the portal would take part in its layout, and everything in here is
             positioned by transform. `pointer-events: none` throughout -- the event is something to
             watch, and a dot that swallowed a click on the component underneath it would make the
             canvas feel broken wherever the playhead happened to be. */
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: TOKEN_Z }}
        >
          {/* Behind the head, so the head is never drawn over by its own tail. */}
          <div
            ref={(element) => {
              tails.current[index] = element
            }}
            style={{ opacity: 0 }}
          >
            {Array.from({ length: TAIL }, (_, step) => (
              <div
                key={step}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: HEAD_R * 2 * (1 - step / (TAIL + 2)),
                  height: HEAD_R * 2 * (1 - step / (TAIL + 2)),
                  borderRadius: '50%',
                  background: plan.color,
                  pointerEvents: 'none',
                  willChange: 'transform',
                }}
              />
            ))}
          </div>

          <div
            ref={(element) => {
              heads.current[index] = element
            }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: HEAD_R * 2,
              height: HEAD_R * 2,
              borderRadius: '50%',
              background: '#fff',
              border: `3px solid ${plan.color}`,
              /* The glow travels *with* the event now, rather than being switched on under a whole
                 connector and off again. It is the brightest thing on the canvas because it is the
                 one thing the reader is meant to follow. */
              boxShadow: `0 0 0 3px ${plan.color}55, 0 0 18px 6px ${plan.color}88`,
              opacity: 0,
              pointerEvents: 'none',
              willChange: 'transform',
            }}
          />
        </div>
      ))}
    </ViewportPortal>
  )
}

/**
 * Where one leg puts the event, in flow coordinates.
 *
 * A dwell is the component's own centre, read live from React Flow rather than from the published
 * route: a component being dragged while a walkthrough is paused has to carry the event with it, and
 * a route is only republished when the edge re-renders.
 *
 * A travel is a fraction along the connector's route, by arc length -- so the event crosses a bent
 * connector without slowing at the corners. Falls back to a straight line between the two centres
 * for a connector that has not published one yet, which is the frame after a node mounts and any
 * connector hidden inside a collapsed group.
 */
function positionOf(leg, plan, routes, getInternalNode, { at = null } = {}) {
  if (leg.kind === 'dwell') return centreOfNode(getInternalNode(leg.nodeId))

  /* Re-derived rather than taken from `leg.progress` when the caller wants an earlier instant, which
     is how the tail is sampled: asking the leg where it was 30ms ago is the only way to get a tail
     that lies along the route rather than along a chord between two frames. */
  const progress =
    at === null ? leg.progress : Math.min(1, Math.max(0, (at - leg.start) / (leg.end - leg.start || 1)))

  const route = routes?.get(leg.edgeId)
  if (route) return pointAlong(route, progress)

  const from = centreOfNode(getInternalNode(leg.from))
  const to = centreOfNode(getInternalNode(leg.to))
  if (!from || !to) return null
  return pointAlong([from, to], progress)
}

/*
 * How big the token is right now, as a multiple of its resting size.
 *
 * Arriving overshoots and settles: the event swells as it lands and eases back over the first third
 * of the beat, which is what a second spent at one component needs in order to read as a stop rather
 * than as a stall. Travelling is always resting size -- a token that changed size while crossing a
 * line would look as though it were speeding up, undoing the constant speed the beat lengths exist to
 * produce.
 */
function settle(leg) {
  if (leg.kind !== 'dwell') return 1
  const into = Math.min(1, leg.progress / 0.35)
  return 1 + 0.45 * (1 - into) ** 2
}

/**
 * A node's centre in flow coordinates, or null if there is genuinely no position for it.
 *
 * Measured size where there is one, and the card's own chosen or default size where there is not.
 * That fallback matters: the canvas runs with `onlyRenderVisibleElements`, so a component that has
 * never been inside the viewport has never mounted and therefore has no `measured` -- and a token
 * that hid itself for those hops would look exactly like the event stopping partway through. A centre
 * that is a few pixels out because the card turned out to be a different height is a far better
 * answer than no event at all.
 *
 * Still null when there is no position, which is the one case where guessing would be a lie: the
 * alternative is a transform full of `NaN`, which silently puts the element nowhere.
 */
function centreOfNode(node) {
  const at = node?.internals?.positionAbsolute ?? node?.position
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null
  const width = node?.measured?.width ?? node?.width ?? NODE_WIDTH
  const height = node?.measured?.height ?? node?.height ?? NODE_HEIGHT
  return { x: at.x + width / 2, y: at.y + height / 2 }
}
