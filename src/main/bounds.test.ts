import { describe, expect, it } from 'vitest'
import { DEFAULT_SIZE, MIN_SIZE, resolveBounds } from './bounds'

const screen = { x: 0, y: 0, width: 1440, height: 900 }

describe('resolveBounds', () => {
  it('uses the default size on first launch', () => {
    expect(resolveBounds(null, [screen])).toEqual(DEFAULT_SIZE)
  })

  it('restores saved bounds that are on screen', () => {
    const saved = { x: 100, y: 80, width: 500, height: 700 }
    expect(resolveBounds(saved, [screen])).toEqual(saved)
  })

  it('clamps a saved size below the minimum', () => {
    expect(resolveBounds({ width: 100, height: 100 }, [screen])).toEqual(MIN_SIZE)
  })

  it('drops a position that is off every display', () => {
    const saved = { x: 3000, y: 100, width: 440, height: 680 }
    expect(resolveBounds(saved, [screen])).toEqual({ width: 440, height: 680 })
  })

  it('ignores garbage values', () => {
    const saved = { x: 'a', width: NaN } as unknown as Parameters<typeof resolveBounds>[0]
    expect(resolveBounds(saved, [screen])).toEqual(DEFAULT_SIZE)
  })
})
