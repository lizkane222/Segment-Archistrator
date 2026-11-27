import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OUTCOME, runFunction } from './runtime.js'
import {
  POLICY,
  isCodeTrusted,
  resetCodeTrust,
  setCodeTrustPolicy,
  trustCode,
  trustGraphCode,
  untrustedCode,
} from './trust.js'

const CODE = 'async function onTrack(event, settings) { return event }'
const EVIL = "async function onTrack(event) { (function(){}).constructor('return window')().__pwned = 1; return event }"
const EVENT = { type: 'track', event: 'x', properties: {} }

const memory = new Map()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
  })
  resetCodeTrust()
  setCodeTrustPolicy(POLICY.enforce)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCodeTrustPolicy(POLICY.allowAll)
})

describe('code trust', () => {
  it('does not trust code nobody has approved', () => {
    expect(isCodeTrusted(CODE)).toBe(false)
  })

  it('trusts empty code, which runs nothing', () => {
    expect(isCodeTrusted('')).toBe(true)
    expect(isCodeTrusted('   ')).toBe(true)
  })

  it('trusts exactly the text that was approved', () => {
    trustCode(CODE)
    expect(isCodeTrusted(CODE)).toBe(true)
    expect(isCodeTrusted(`${CODE}\n// edited after approval`)).toBe(false)
  })

  it('trusts the code in a graph it is told to', () => {
    const graph = { nodes: [{ id: 'a', data: { code: CODE } }, { id: 'b', data: {} }] }
    expect(untrustedCode(graph)).toEqual([CODE])
    trustGraphCode(graph)
    expect(untrustedCode(graph)).toEqual([])
  })

  it('keeps trust across a reload', () => {
    trustCode(CODE)
    const stored = memory.get('archistrator.trustedCode.v1')
    expect(stored).toContain('onTrack')
  })
})

describe('runFunction under the trust gate', () => {
  it('does not compile or run code that is not trusted', () => {
    globalThis.__pwned = undefined
    const result = runFunction({ code: EVIL, kind: 'destination_insert_function', event: EVENT })
    expect(result.outcome).toBe(OUTCOME.untrusted)
    expect(result.error.name).toBe('UntrustedCode')
    expect(globalThis.__pwned).toBeUndefined()
  })

  it('runs it once it has been approved', () => {
    trustCode(CODE)
    const result = runFunction({ code: CODE, kind: 'destination_insert_function', event: EVENT })
    expect(result.outcome).toBe(OUTCOME.returned)
  })
})
