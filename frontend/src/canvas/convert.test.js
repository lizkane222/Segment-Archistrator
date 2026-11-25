import { describe, expect, it } from 'vitest'

import { canConvertTo, convertNode } from './convert.js'

const custom = {
  id: 'manual:custom:1',
  type: 'segmentNode',
  position: { x: 10, y: 20 },
  parentId: 'zone:sources',
  data: { id: 'manual:custom:1', kind: 'custom', zone: 'sources', name: 'Web app', description: 'mine', bound: true, details: [] },
}

describe('convertNode', () => {
  it('keeps identity, place, name and description and takes the new kind', () => {
    const next = convertNode(custom, { kind: 'destination', name: 'Destination' })
    expect(next.id).toBe(custom.id)
    expect(next.position).toEqual(custom.position)
    expect(next.parentId).toBe('zone:sources')
    expect(next.data).toMatchObject({ kind: 'destination', name: 'Web app', description: 'mine', bound: false })
    expect(next.data.details).toBeUndefined()
  })

  it('becomes a shape with the shape renderer and its size', () => {
    const next = convertNode(custom, {
      kind: 'shape',
      name: 'Star',
      data: { bound: true, shape: 'star', size: { width: 100, height: 100 } },
    })
    expect(next.type).not.toBe('segmentNode')
    expect(next.data.shape).toBe('star')
    expect(next.data.name).toBe('Web app')
  })

  it('refuses zones', () => {
    expect(canConvertTo({ kind: 'zone' })).toBe(false)
    expect(canConvertTo({ kind: 'warehouse' })).toBe(true)
  })
})
