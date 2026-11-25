/*
 * Guards for the four things that make shift-click multi-select reliable.
 *
 * There is no jsdom here, so the behaviour itself was verified in a real browser (see the notes in
 * canvas/Canvas.jsx beside each prop). What these pin is that none of them is quietly removed: each
 * looks like noise in a diff, and losing any one brings back selections that vanish on the next
 * click.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const canvas = read('./Canvas.jsx')

describe('multi-select reliability', () => {
  it('lets a click survive a little pointer movement', () => {
    expect(canvas).toMatch(/nodeClickDistance=\{3\}/)
    expect(canvas).toMatch(/nodeDragThreshold=\{3\}/)
  })

  it('does not hand React Flow a new key-code array on every render', () => {
    expect(canvas).toMatch(/multiSelectionKeyCode=\{MULTI_SELECT_KEYS\}/)
    expect(canvas).toMatch(/deleteKeyCode=\{DELETE_KEYS\}/)
    expect(canvas).not.toMatch(/multiSelectionKeyCode=\{\[/)
    expect(canvas).not.toMatch(/deleteKeyCode=\{\[/)
  })

  it('still treats Shift as a multi-select key', () => {
    expect(canvas).toMatch(/MULTI_SELECT_KEYS = \[[^\]]*'Shift'/)
  })

  it.each(['SegmentNode', 'ShapeNode', 'TableNode'])(
    '%s keeps its card out of the shift-lasso',
    (name) => {
      expect(read(`./nodes/${name}.jsx`)).toMatch(/className=\{`nokey group relative/)
    },
  )
})
