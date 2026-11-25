/*
 * Turning one component into another, in place.
 *
 * The node keeps everything that is about *where it is and what it is called* -- id (so every
 * connector stays attached), position, zone, name, description, lock -- and takes everything that is
 * about *what it is* from the palette tile that was picked: kind, look, shape, code seed. Nothing of the
 * old kind's own data is carried across, which is the point: a Destination converted to a Warehouse
 * must not keep a destination's mapping fields or its workspace binding.
 *
 * Pure, so it is the same function for the live preview and the confirmed result.
 */

import { codeSeed } from '../functions/defaults.js'
import { DROPPED_STYLE } from './dropDefaults.js'
import { toFlowNode } from './layout.js'

const DRAWING_KINDS = new Set(['shape', 'table', 'event'])

/** Whether a palette payload can replace a component. A zone is a region, not a component. */
export function canConvertTo(payload) {
  return Boolean(payload?.kind) && payload.kind !== 'zone'
}

/** `node` (a React Flow node) rebuilt as the thing `payload` describes. */
export function convertNode(node, payload) {
  const old = node.data ?? {}
  const kind = payload.kind
  const data = {
    id: node.id,
    kind,
    zone: old.zone ?? null,
    name: kind === 'table' ? (payload.name ?? 'Table') : (old.name ?? payload.name ?? kind),
    description: old.description ?? '',
    bound: payload.bound ?? false,
    ...(DRAWING_KINDS.has(kind) ? {} : { style: DROPPED_STYLE }),
    ...(codeSeed(kind, { bound: false }) ?? {}),
    ...payload.data,
    ...(old.locked ? { locked: true } : {}),
  }
  const fresh = toFlowNode(data, data.zone, node.position)
  const { width, height, measured, ...rest } = node // eslint-disable-line no-unused-vars
  return {
    ...rest,
    type: fresh.type,
    data: fresh.data,
    ...(fresh.width ? { width: fresh.width } : {}),
    ...(fresh.height ? { height: fresh.height } : {}),
  }
}
