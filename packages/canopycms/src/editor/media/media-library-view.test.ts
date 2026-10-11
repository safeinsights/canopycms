import { describe, expect, it } from 'vitest'

import type { AssetRecord } from '../../api'
import { assetCountLabel, matchesKind, matchesText, sortAssets } from './media-library-view'

const asset = (filename: string, uploadedAt: string, overrides: Partial<AssetRecord> = {}) =>
  ({
    hash32: filename,
    filename,
    slug: filename.replace(/\.\w+$/, ''),
    ext: 'png',
    mime: 'image/png',
    size: 1,
    kind: 'raster',
    uploadedAt,
    src: `/${filename}`,
    ...overrides,
  }) satisfies AssetRecord

describe('sortAssets', () => {
  const old = asset('b.png', '2024-01-01T00:00:00.000Z')
  const recent = asset('a.png', '2024-01-03T00:00:00.000Z')
  const sameTime = asset('c.png', '2024-01-03T00:00:00.000Z')

  it('puts the newest first and breaks ties by filename', () => {
    expect(sortAssets([old, sameTime, recent], 'newest').map((a) => a.filename)).toEqual([
      'a.png',
      'c.png',
      'b.png',
    ])
  })

  it('sorts by name ignoring case and reading digit runs as numbers', () => {
    const files = ['img10.png', 'Img2.png', 'img1.png'].map((name) =>
      asset(name, '2024-01-01T00:00:00.000Z'),
    )
    expect(sortAssets(files, 'name').map((a) => a.filename)).toEqual([
      'img1.png',
      'Img2.png',
      'img10.png',
    ])
  })

  it('breaks name ties by newest first, and does not reorder its input', () => {
    const first = asset('x.png', '2024-01-01T00:00:00.000Z', { hash32: 'older' })
    const second = asset('X.png', '2024-01-02T00:00:00.000Z', { hash32: 'newer' })
    const input = [first, second]

    expect(sortAssets(input, 'name').map((a) => a.hash32)).toEqual(['newer', 'older'])
    expect(input).toEqual([first, second])
  })

  it('treats an unparseable date as oldest instead of throwing', () => {
    const broken = asset('z.png', 'not a date')
    expect(sortAssets([broken, old], 'newest')[0]).toBe(old)
  })
})

describe('matchesKind', () => {
  const pdf = asset('a.pdf', '2024-01-01T00:00:00.000Z', { kind: 'pdf' })
  const svg = asset('a.svg', '2024-01-01T00:00:00.000Z', { kind: 'svg' })
  const raster = asset('a.png', '2024-01-01T00:00:00.000Z')

  it('counts raster and svg as images', () => {
    expect([raster, svg, pdf].map((a) => matchesKind(a, 'images'))).toEqual([true, true, false])
    expect([raster, svg, pdf].map((a) => matchesKind(a, 'pdfs'))).toEqual([false, false, true])
    expect([raster, svg, pdf].map((a) => matchesKind(a, 'all'))).toEqual([true, true, true])
  })
})

describe('matchesText', () => {
  const a = asset('Summer Trip.png', '2024-01-01T00:00:00.000Z', { slug: 'summer-trip' })

  it('matches filename and slug case-insensitively against a lower-cased needle', () => {
    expect(matchesText(a, 'summer trip')).toBe(true)
    expect(matchesText(a, 'summer-')).toBe(true)
    expect(matchesText(a, 'winter')).toBe(false)
    expect(matchesText(a, '')).toBe(true)
  })
})

describe('assetCountLabel', () => {
  it('agrees the noun with the count', () => {
    expect(assetCountLabel(1)).toBe('1 asset')
    expect(assetCountLabel(0)).toBe('0 assets')
    expect(assetCountLabel(2)).toBe('2 assets')
  })
})
