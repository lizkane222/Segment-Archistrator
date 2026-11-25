import { describe, expect, it } from 'vitest'

import { ownerMayRead, readSession, writeSession } from './session.js'
import { groupForSaved, groupSaved } from './tabs.js'

function memory() {
  const data = new Map()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  }
}

describe('groupSaved', () => {
  it('lists named groups first and ungrouped diagrams after them', () => {
    const saved = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b', group_name: 'Acme' },
      { id: '3', name: 'c', group_name: 'Acme' },
      { id: '4', name: 'd', group_name: 'Globex' },
    ]
    const { groups, loose } = groupSaved(saved)
    expect(groups.map((g) => [g.name, g.diagrams.map((d) => d.id)])).toEqual([
      ['Acme', ['2', '3']],
      ['Globex', ['4']],
    ])
    expect(loose.map((d) => d.id)).toEqual(['1'])
  })
})

describe('groupForSaved', () => {
  const connections = [{ id: 'w1', name: 'Acme' }]
  it('brings the label back as a custom group', () => {
    expect(groupForSaved({ group_name: 'Q4' }, connections, true)).toEqual({ workspaceId: null, groupName: 'Q4' })
  })
  it('joins the connected workspace whose name it is', () => {
    expect(groupForSaved({ group_name: 'Acme', workspace_id: 'w1' }, connections, true)).toEqual({ workspaceId: 'w1' })
  })
  it('says nothing for an ungrouped diagram', () => {
    expect(groupForSaved({ group_name: '' }, connections, true)).toEqual({})
  })
})

describe('the workbench across sign-in', () => {
  const tab = { id: 't1', doc: { id: null, name: 'x' }, graph: { nodes: [{ id: 'n' }], edges: [] }, groupName: 'Q4' }
  it('is adopted by whoever signs in after it was drawn anonymously', () => {
    const storage = memory()
    writeSession({ tabs: [tab], owner: '' }, new Set(['t1']), storage)
    const read = readSession(storage, { owner: 'liz@twilio.com' })
    expect(read.tabs[0].groupName).toBe('Q4')
    expect(read.tabs[0].graph.nodes).toHaveLength(1)
  })
  it('is left alone while signed out, and kept from a different account', () => {
    const storage = memory()
    writeSession({ tabs: [tab], owner: 'liz@twilio.com' }, new Set(['t1']), storage)
    expect(readSession(storage, { owner: undefined })).not.toBeNull()
    expect(readSession(storage, { owner: 'other@twilio.com' })).toBeNull()
    expect(readSession(storage, { owner: 'liz@twilio.com' })).toBeNull() // cleared by the line above
  })
  it('ownerMayRead', () => {
    expect(ownerMayRead('', 'a@b')).toBe(true)
    expect(ownerMayRead('a@b', 'a@b')).toBe(true)
    expect(ownerMayRead('a@b', 'c@d')).toBe(false)
    expect(ownerMayRead('a@b', '')).toBe(false)
  })
})
