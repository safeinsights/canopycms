import { describe, expect, it } from 'vitest'

import { cropAreaPercentToRect, cropRectToAreaPercent, parseAspectRatio } from './crop-math'

describe('cropAreaPercentToRect', () => {
  it('converts a simple percentage area to a normalized 0..1 rect', () => {
    expect(cropAreaPercentToRect({ x: 25, y: 10, width: 50, height: 60 })).toEqual({
      x: 0.25,
      y: 0.1,
      w: 0.5,
      h: 0.6,
    })
  })

  it('rounds to 4 decimal places (matching transform-directives.ts CROP_PRECISION)', () => {
    const rect = cropAreaPercentToRect({ x: 33.33333, y: 0, width: 33.33333, height: 100 })
    expect(rect).not.toBeNull()
    expect(rect!.x).toBe(0.3333)
    expect(rect!.w).toBe(0.3333)
    // 4 decimal places, not more
    expect(rect!.x.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4)
  })

  it('shrinks width when rounding pushes x+w a hair over 1', () => {
    // 66.66667 + 33.33334 = 100.00001% -> rounds to x=0.6667, w=0.3333 individually
    // but 0.6667 + 0.3334 (if w rounded up independently) would exceed 1 -
    // the clamp step must shrink w to fit exactly.
    const rect = cropAreaPercentToRect({ x: 66.66667, y: 0, width: 33.33334, height: 100 })
    expect(rect).not.toBeNull()
    expect(rect!.x + rect!.w).toBeLessThanOrEqual(1)
  })

  it('shrinks height when rounding pushes y+h a hair over 1', () => {
    const rect = cropAreaPercentToRect({ x: 0, y: 66.66667, width: 100, height: 33.33334 })
    expect(rect).not.toBeNull()
    expect(rect!.y + rect!.h).toBeLessThanOrEqual(1)
  })

  it('clamps out-of-range percentages into [0, 100] before converting', () => {
    const rect = cropAreaPercentToRect({ x: -10, y: 0, width: 50, height: 50 })
    expect(rect).not.toBeNull()
    expect(rect!.x).toBe(0)
  })

  it('returns null for a zero-area selection', () => {
    expect(cropAreaPercentToRect({ x: 10, y: 10, width: 0, height: 50 })).toBeNull()
    expect(cropAreaPercentToRect({ x: 10, y: 10, width: 50, height: 0 })).toBeNull()
  })

  it('returns the full frame for a full-frame selection', () => {
    expect(cropAreaPercentToRect({ x: 0, y: 0, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })
  })

  it('shrinks a grossly overflowing selection to fit rather than rejecting it', () => {
    // x=50%, width=100% overflows the frame by a lot, not just a rounding
    // hair - the implementation always shrinks to the remaining space
    // (0.5) rather than distinguishing "rounding artifact" from "genuinely
    // oversized", so a full-width-from-the-midpoint selection becomes the
    // right half of the frame.
    expect(cropAreaPercentToRect({ x: 50, y: 0, width: 100, height: 50 })).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 0.5,
    })
  })

  it('returns null when the starting point leaves no room at all (fully clamped away)', () => {
    // x clamps to 1 (the far edge) - there is zero remaining width, so the
    // shrink-to-fit step drives w to 0, which isValidCropRect rejects.
    expect(cropAreaPercentToRect({ x: 150, y: 0, width: 50, height: 50 })).toBeNull()
  })
})

describe('cropRectToAreaPercent', () => {
  it('is the inverse of cropAreaPercentToRect for exact values', () => {
    const rect = { x: 0.25, y: 0.1, w: 0.5, h: 0.6 }
    expect(cropRectToAreaPercent(rect)).toEqual({ x: 25, y: 10, width: 50, height: 60 })
  })
})

describe('parseAspectRatio', () => {
  it('parses "W:H" into a numeric ratio', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9)
    expect(parseAspectRatio('1:1')).toBe(1)
    expect(parseAspectRatio('4:3')).toBeCloseTo(4 / 3)
  })

  it('returns undefined for no aspect configured', () => {
    expect(parseAspectRatio(undefined)).toBeUndefined()
  })

  it('returns undefined for malformed input', () => {
    expect(parseAspectRatio('')).toBeUndefined()
    expect(parseAspectRatio('16-9')).toBeUndefined()
    expect(parseAspectRatio('0:9')).toBeUndefined()
    expect(parseAspectRatio('16:0')).toBeUndefined()
    expect(parseAspectRatio('16:9:1')).toBeUndefined()
  })
})
