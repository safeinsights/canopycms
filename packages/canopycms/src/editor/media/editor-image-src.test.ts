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

  it('applies width and crop to a transform src behind the authenticated route', () => {
    expect(
      editorImageSrc(`/assets/t/orig/${HASH}/photo.png`, BASE, {
        width: 320,
        crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
      }),
    ).toBe(`${BASE}/assets/t/c=0.1000:0.2000:0.5000:0.2500,w=320/${HASH}/photo.png`)
  })

  it.each([
    ['a site-relative raster', '/people/x.png'],
    ['a site-relative svg', '/logos/x.svg'],
  ])('shows %s as written even with width and crop asked for', (_label, src) => {
    expect(editorImageSrc(src, BASE, { width: 320, crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(src)
  })

  it.each([
    ['a protocol-relative URL', '//cdn.example.com/x.png'],
    ['a blob: URL', 'blob:https://example.com/1234'],
  ])('shows %s as written', (_label, src) => {
    expect(editorImageSrc(src, BASE)).toBe(src)
  })

  it.each([
    ['a backslash spelling', '/\\evil.example/x.png'],
    ['a mixed-slash spelling', '\\/evil.example/x.png'],
    ['a tab-split spelling', '/\t/evil.example/x.png'],
  ])('keeps %s on this origin', (_label, src) => {
    const out = editorImageSrc(src, BASE)
    expect(out).toBe('/x.png')
    expect(new URL(out, 'https://editor.example').origin).toBe('https://editor.example')
  })
})
