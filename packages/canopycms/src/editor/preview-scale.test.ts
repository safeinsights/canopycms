import { describe, expect, it } from 'vitest'

import { computePreviewViewport, formatPreviewWidthReadout } from './preview-scale'

describe('computePreviewViewport', () => {
  it('renders "fit" at the pane size, unscaled', () => {
    expect(computePreviewViewport('fit', 900, 600)).toEqual({
      frameWidth: 900,
      frameHeight: 600,
      scale: 1,
      offsetX: 0,
    })
  })

  it('renders a fixed width unscaled and centred in a wider pane', () => {
    expect(computePreviewViewport('tablet', 1000, 600)).toEqual({
      frameWidth: 768,
      frameHeight: 600,
      scale: 1,
      offsetX: 116,
    })
  })

  it('renders a fixed width at exactly the pane width without scaling', () => {
    expect(computePreviewViewport('mobile', 390, 700)).toEqual({
      frameWidth: 390,
      frameHeight: 700,
      scale: 1,
      offsetX: 0,
    })
  })

  it('scales a fixed width down to a narrower pane and stretches its height to fill it', () => {
    const viewport = computePreviewViewport('desktop', 640, 500)
    expect(viewport.frameWidth).toBe(1280)
    expect(viewport.scale).toBe(0.5)
    expect(viewport.frameHeight).toBe(1000)
    expect(viewport.offsetX).toBe(0)
    expect(viewport.frameWidth * viewport.scale).toBe(640)
    expect(viewport.frameHeight * viewport.scale).toBe(500)
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'renders unscaled at the fixed width before the pane is measured (%s)',
    (paneWidth) => {
      expect(computePreviewViewport('desktop', paneWidth, 400)).toEqual({
        frameWidth: 1280,
        frameHeight: 400,
        scale: 1,
        offsetX: 0,
      })
    },
  )

  it('gives "fit" a zero size before the pane is measured', () => {
    expect(computePreviewViewport('fit', Number.NaN, -1)).toEqual({
      frameWidth: 0,
      frameHeight: 0,
      scale: 1,
      offsetX: 0,
    })
  })
})

describe('formatPreviewWidthReadout', () => {
  it('shows only the CSS width when unscaled', () => {
    expect(formatPreviewWidthReadout(computePreviewViewport('fit', 1023.6, 600))).toBe('1024 px')
    expect(formatPreviewWidthReadout(computePreviewViewport('tablet', 1000, 600))).toBe('768 px')
  })

  it('leaves out a scale that rounds to 100%', () => {
    expect(formatPreviewWidthReadout(computePreviewViewport('desktop', 1278, 600))).toBe('1280 px')
  })

  it('adds the rounded scale when scaled down', () => {
    expect(formatPreviewWidthReadout(computePreviewViewport('desktop', 800, 600))).toBe(
      '1280 px at 63%',
    )
  })
})
