import { describe, expect, it } from 'vitest'

import { canMoveToGroup, forkTab, groupTabs, hasBoundComponents, newTab, visibleTabs } from './tabs.js'
import { readSession, writeSession } from './session.js'

const tab = (id, workspaceId, graph = null) => newTab({ id, workspaceId, graph, doc: { id: `d-${id}`, name: id } })
const bound = { nodes: [{ id: 'n', data: { bound: true, segmentId: 'src_1' } }], edges: [] }
const unbound = { nodes: [{ id: 'n', data: { bound: false } }], edges: [] }

describe('tab groups', () => {
  it('groups tabs by workspace, in the order the groups first appeared', () => {
    const groups = groupTabs([tab('a', 'ws1'), tab('b', null), tab('c', 'ws1'), tab('d', 'ws2')])
    expect(groups.map((g) => [g.workspaceId, g.tabs.map((t) => t.id)])).toEqual([
      ['ws1', ['a', 'c']],
      [null, ['b']],
      ['ws2', ['d']],
    ])
  })

  it('a new tab with no workspace is about none', () => {
    expect(newTab().workspaceId).toBeNull()
  })

  it('a fork stays in its original group', () => {
    expect(forkTab(tab('a', 'ws1')).workspaceId).toBe('ws1')
  })
})

describe('the split view', () => {
  const tabs = [tab('a', 'ws1'), tab('b', 'ws2'), tab('c', 'ws1')]

  it('pairs a tab only with one from its own group', () => {
    expect(visibleTabs(tabs, 'a', { split: true }).map((t) => t.id)).toEqual(['a', 'c'])
    expect(visibleTabs(tabs, 'c', { split: true }).map((t) => t.id)).toEqual(['c', 'a'])
  })

  it('shows one pane when the group has no second tab', () => {
    expect(visibleTabs(tabs, 'b', { split: true }).map((t) => t.id)).toEqual(['b'])
  })
})

describe('moving a tab between groups', () => {
  it('allows a diagram with nothing bound to go anywhere', () => {
    expect(canMoveToGroup(tab('a', 'ws1'), unbound, 'ws2').ok).toBe(true)
    expect(canMoveToGroup(tab('a', 'ws1'), unbound, null).ok).toBe(true)
  })

  it('keeps a diagram with bound components in the workspace they came from', () => {
    const verdict = canMoveToGroup(tab('a', 'ws1'), bound, 'ws2')
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/bound/)
    expect(canMoveToGroup(tab('a', 'ws1'), bound, null).ok).toBe(false)
  })

  it('a move to the group it is already in is always fine', () => {
    expect(canMoveToGroup(tab('a', 'ws1'), bound, 'ws1').ok).toBe(true)
  })

  it('reads a bound component whether its fields are flat or under data', () => {
    expect(hasBoundComponents({ nodes: [{ bound: true, segmentId: 'x' }] })).toBe(true)
    expect(hasBoundComponents(bound)).toBe(true)
    expect(hasBoundComponents(unbound)).toBe(false)
    expect(hasBoundComponents(null)).toBe(false)
  })
})

describe('the stored workbench belongs to one account', () => {
  const store = () => {
    const map = new Map()
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    }
  }

  it('remembers which workspace group each tab was in', () => {
    const storage = store()
    writeSession({ tabs: [tab('a', 'ws1', unbound)], owner: 'liz@twilio.com' }, new Set(['a']), storage)
    expect(readSession(storage, { owner: 'liz@twilio.com' }).tabs[0].workspaceId).toBe('ws1')
  })

  it('hands nothing to a different account, and removes it from disk', () => {
    const storage = store()
    writeSession({ tabs: [tab('a', 'ws1', unbound)], owner: 'liz@twilio.com' }, new Set(['a']), storage)
    expect(readSession(storage, { owner: 'sol@twilio.com' })).toBeNull()
    expect(readSession(storage, { owner: 'liz@twilio.com' })).toBeNull()
  })
})
