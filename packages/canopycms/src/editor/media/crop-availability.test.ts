import { describe, expect, it } from 'vitest'

import { cropBlockedReason } from './crop-availability'

const HASH = 'a'.repeat(32)

describe('cropBlockedReason', () => {
  it('allows a raster in the asset store', () => {
    expect(cropBlockedReason(`/assets/t/orig/${HASH}/cat.png`)).toBeUndefined()
    expect(cropBlockedReason(`/assets/t/c=0.1:0.1:0.5:0.5,w=320/${HASH}/cat.png`)).toBeUndefined()
  })

  it('refuses an svg wherever it lives, whatever its case or query', () => {
    for (const src of [
      `/assets/${HASH}/logo.svg`,
      '/logos/mark.svg',
      '/logos/MARK.SVG?v=2',
      '/logos/mark.svg#top',
    ]) {
      expect(cropBlockedReason(src)).toMatch(/^SVG images can't be cropped\./)
    }
  })

  it('names the media library for a raster outside the asset store', () => {
    expect(cropBlockedReason('/people/portrait.png')).toMatch(
      /^Crop works on media-library images\./,
    )
    expect(cropBlockedReason('https://cdn.example.com/x.png')).toMatch(/media-library images/)
  })

  it('refuses a static file in the asset store that is not a raster, such as a pdf', () => {
    expect(cropBlockedReason(`/assets/${HASH}/brochure.pdf`)).toMatch(
      /^This file type can't be cropped\./,
    )
  })

  it('does not treat a similarly named path as the asset store', () => {
    expect(cropBlockedReason('/assets-extra/t/orig/x.png')).toMatch(/media-library images/)
  })
})
