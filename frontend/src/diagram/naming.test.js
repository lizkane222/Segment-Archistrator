import { describe, expect, it } from 'vitest'

import { dateTag, openedAgainName, templateInstanceName, versioned } from './naming.js'

const day = new Date(2026, 10, 16)

describe('naming', () => {
  it('tags the date as MM-DD-YY', () => {
    expect(dateTag(day)).toBe('11-16-26')
  })

  it('leaves the first template of the day unnumbered, then counts V2, V3', () => {
    const first = templateInstanceName('End-to-end', [], day)
    expect(first).toBe('End-to-end 11-16-26')
    const second = templateInstanceName('End-to-end', [first], day)
    expect(second).toBe('End-to-end 11-16-26 (V2)')
    expect(templateInstanceName('End-to-end', [first, second], day)).toBe('End-to-end 11-16-26 (V3)')
  })

  it('does not count another day or another template', () => {
    expect(templateInstanceName('A', ['A 11-15-26', 'B 11-16-26'], day)).toBe('A 11-16-26')
  })

  it('does not reuse a version number after an earlier one is gone', () => {
    expect(versioned('X', ['X', 'X (V3)'])).toBe('X (V4)')
  })

  it('treats regex characters in a name literally', () => {
    expect(versioned('A (b) & c+', ['A (b) & c+'])).toBe('A (b) & c+ (V2)')
  })

  it('names a diagram opened again without stacking versions', () => {
    expect(openedAgainName('Plan', ['Plan'])).toBe('Plan (V2)')
    expect(openedAgainName('Plan (V2)', ['Plan', 'Plan (V2)'])).toBe('Plan (V3)')
  })
})
