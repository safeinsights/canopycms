import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assetSrcSet, assetUrl } from './asset-url'

const HASH32 = 'a'.repeat(32)
const identitySrc = `/assets/t/orig/${HASH32}/photo.png`
const staticSvgSrc = `/assets/${HASH32}/logo.svg`

describe('module purity', () => {
  it('imports nothing beyond asset-prefixes.ts and transform-directives.ts (no node:/sharp reachable from here)', () => {
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asset-url.ts')
    const source = readFileSync(filePath, 'utf-8')
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^\.\/(asset-prefixes|transform-directives)$/)
    }
  })
})

describe('assetUrl - static srcs (unchanged, opts ignored)', () => {
  it('returns an svg/pdf static src unchanged', () => {
    expect(assetUrl({ src: staticSvgSrc })).toBe(staticSvgSrc)
    expect(assetUrl({ src: staticSvgSrc }, { width: 320, format: 'webp' })).toBe(staticSvgSrc)
  })

  it('prefixes baseUrl even for a static src', () => {
    expect(assetUrl({ src: staticSvgSrc }, { baseUrl: 'https://cms.example.com' })).toBe(
      `https://cms.example.com${staticSvgSrc}`,
    )
  })
})

describe('assetUrl - transform srcs', () => {
  it('adds a width directive to an identity src', () => {
    const url = assetUrl({ src: identitySrc }, { width: 320 })
    expect(url).toBe(`/assets/t/w=320/${HASH32}/photo.png`)
  })

  it('adds a format directive, adjusting the ext accordingly', () => {
    const url = assetUrl({ src: identitySrc }, { format: 'webp' })
    expect(url).toBe(`/assets/t/f=webp/${HASH32}/photo.webp`)
  })

  it('combines width + format + quality + crop into canonical order', () => {
    const url = assetUrl(
      { src: identitySrc },
      { width: 320, format: 'webp', quality: 70, crop: { x: 0, y: 0, w: 1, h: 1 } },
    )
    expect(url).toBe(
      `/assets/t/c=0.0000:0.0000:1.0000:1.0000,f=webp,q=70,w=320/${HASH32}/photo.webp`,
    )
  })

  it('opts win over directives already present in the src', () => {
    const existing = `/assets/t/w=320/${HASH32}/photo.png`
    const url = assetUrl({ src: existing }, { width: 640 })
    expect(url).toBe(`/assets/t/w=640/${HASH32}/photo.png`)
  })

  it('preserves directives not overridden by opts', () => {
    const existing = `/assets/t/q=80,w=320/${HASH32}/photo.png`
    const url = assetUrl({ src: existing }, { width: 640 })
    expect(url).toBe(`/assets/t/q=80,w=640/${HASH32}/photo.png`)
  })

  it('returns the src unchanged when no opts are given (still re-canonicalized)', () => {
    const nonCanonical = `/assets/t/w=320,q=80/${HASH32}/photo.png`
    expect(assetUrl({ src: nonCanonical })).toBe(`/assets/t/q=80,w=320/${HASH32}/photo.png`)
  })

  it('returns a malformed transform-looking src unchanged rather than throwing', () => {
    const malformed = `/assets/t/nonsense/${HASH32}/photo.png`
    expect(assetUrl({ src: malformed }, { width: 320 })).toBe(malformed)
  })
})

describe('assetUrl - baseUrl joining', () => {
  it('joins baseUrl without double slashes regardless of trailing/leading slash', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: 'https://cms.example.com' })).toBe(
      `https://cms.example.com${identitySrc}`,
    )
    expect(assetUrl({ src: identitySrc }, { baseUrl: 'https://cms.example.com/' })).toBe(
      `https://cms.example.com${identitySrc}`,
    )
  })

  it('omits baseUrl entirely when not given (root-relative)', () => {
    expect(assetUrl({ src: identitySrc })).toBe(identitySrc)
  })
})

describe('assetSrcSet', () => {
  it('builds a comma-joined "url w" descriptor list', () => {
    const srcset = assetSrcSet({ src: identitySrc }, [320, 640])
    expect(srcset).toBe(
      `/assets/t/w=320/${HASH32}/photo.png 320w, /assets/t/w=640/${HASH32}/photo.png 640w`,
    )
  })

  it('forwards non-width opts (e.g. format) to every entry', () => {
    const srcset = assetSrcSet({ src: identitySrc }, [320, 640], { format: 'webp' })
    expect(srcset).toBe(
      `/assets/t/f=webp,w=320/${HASH32}/photo.webp 320w, /assets/t/f=webp,w=640/${HASH32}/photo.webp 640w`,
    )
  })

  it('applies baseUrl to every entry', () => {
    const srcset = assetSrcSet({ src: identitySrc }, [320], { baseUrl: 'https://cms.example.com' })
    expect(srcset).toBe(`https://cms.example.com/assets/t/w=320/${HASH32}/photo.png 320w`)
  })

  it('throws on a width not in the allowlist', () => {
    expect(() => assetSrcSet({ src: identitySrc }, [321])).toThrow()
    expect(() => assetSrcSet({ src: identitySrc }, [320, 4160])).toThrow()
  })
})
