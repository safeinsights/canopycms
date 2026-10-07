import { describe, expect, it } from 'vitest'

import { editorImageSrc } from './editor-image-src'

const BASE = '/p/api/canopycms/assets/raw'
const HASH = 'a'.repeat(32)

describe('editorImageSrc', () => {
  it('puts a transform src behind the authenticated route', () => {
    expect(editorImageSrc(`/assets/t/orig/${HASH}/photo.png`, BASE)).toBe(
      `${BASE}/assets/t/orig/${HASH}/photo.png`,
    )
  })

  it('puts a static asset src (svg/pdf) behind the authenticated route', () => {
    expect(editorImageSrc(`/assets/${HASH}/logo.svg`, BASE)).toBe(`${BASE}/assets/${HASH}/logo.svg`)
  })

  it.each([
    ['a site-relative path outside /assets', '/images/hero.png'],
    ['an off-site URL', 'https://cdn.example.com/x.png'],
    ['a data: URI', 'data:image/png;base64,AAAA'],
    ['a path that only starts like the asset space', '/assetsx/y.png'],
  ])('shows %s as written', (_label, src) => {
    expect(editorImageSrc(src, BASE)).toBe(src)
  })
})
