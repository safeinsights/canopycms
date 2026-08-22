import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assetSrcSet, assetUrl } from './asset-url'

const HASH32 = 'a'.repeat(32)
const identitySrc = `/assets/t/orig/${HASH32}/photo.png`
const staticSvgSrc = `/assets/${HASH32}/logo.svg`

describe('module purity', () => {
  // The whitelist admits ../utils/url-prefix deliberately: sharing ONE join with
  // static/seo.ts is what stopped assetUrl carrying a weaker copy of the absolute-URL and
  // prefix-shape rules (see utils/url-prefix.ts's header). url-prefix.ts imports only
  // utils/sanitize-href.ts, whose sole dependency is the global URL, so nothing node: becomes
  // reachable. `pnpm lint:bundle` is the real enforcement — this guard just fails faster.
  it('imports nothing beyond asset-prefixes, transform-directives and utils/url-prefix (no node:/sharp reachable from here)', () => {
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asset-url.ts')
    const source = readFileSync(filePath, 'utf-8')
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toMatch(
        /^(\.\/(asset-prefixes|transform-directives)|\.\.\/utils\/url-prefix)$/,
      )
    }
  })

  it('the shared join module is itself pure (its only import is sanitize-href)', () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'utils',
      'url-prefix.ts',
    )
    const source = readFileSync(filePath, 'utf-8')
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toBe('./sanitize-href')
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
  it('joins an absolute baseUrl without double slashes, with or without a trailing slash', () => {
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

// The basePath case this whole option had to be made safe for: a site deployed under a Next
// `basePath` serves everything at `/{prefix}/…`, and Next auto-prefixes only its own
// Image/Link/Script - never a raw string URL - so the prefix has to be applied here.
describe('assetUrl - baseUrl as a same-origin path prefix (basePath deployments)', () => {
  it('prefixes a bare path onto a transform src', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: '/preview-123' })).toBe(
      `/preview-123${identitySrc}`,
    )
  })

  it('prefixes a bare path onto a static (svg) src too', () => {
    expect(assetUrl({ src: staticSvgSrc }, { baseUrl: '/preview-123' })).toBe(
      `/preview-123${staticSvgSrc}`,
    )
  })

  it('applies the prefix alongside directive merging, not instead of it', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: '/preview-123', width: 320 })).toBe(
      `/preview-123/assets/t/w=320/${HASH32}/photo.png`,
    )
  })

  it('strips a trailing slash, and any run of them, from the prefix', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: '/preview-123/' })).toBe(
      `/preview-123${identitySrc}`,
    )
    expect(assetUrl({ src: identitySrc }, { baseUrl: '/preview-123///' })).toBe(
      `/preview-123${identitySrc}`,
    )
  })

  it('supplies a missing leading slash rather than emitting a document-relative URL', () => {
    // 'preview-123' is the shape an env var often carries. Without normalization this produced
    // `preview-123/assets/…`, which resolves against the CURRENT page - so it happened to work
    // on `/about` and silently fetched the wrong URL on `/blog/post`.
    expect(assetUrl({ src: identitySrc }, { baseUrl: 'preview-123' })).toBe(
      `/preview-123${identitySrc}`,
    )
  })

  it('treats a slash-only or empty prefix as no prefix at all', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: '/' })).toBe(identitySrc)
    expect(assetUrl({ src: identitySrc }, { baseUrl: '' })).toBe(identitySrc)
    // '//' would otherwise concatenate to `//assets/…`, which a browser reads as
    // protocol-relative - a request to a host literally named `assets`.
    expect(assetUrl({ src: identitySrc }, { baseUrl: '//' })).toBe(identitySrc)
  })

  it('preserves a literal protocol-relative prefix (an intentional off-site CDN pointer)', () => {
    expect(assetUrl({ src: identitySrc }, { baseUrl: '//cdn.example.com' })).toBe(
      `//cdn.example.com${identitySrc}`,
    )
  })

  it('applies the prefix to every srcset entry', () => {
    expect(assetSrcSet({ src: identitySrc }, [320, 640], { baseUrl: '/preview-123' })).toBe(
      `/preview-123/assets/t/w=320/${HASH32}/photo.png 320w, ` +
        `/preview-123/assets/t/w=640/${HASH32}/photo.png 640w`,
    )
  })
})

describe('assetUrl - an already-absolute src is never prefixed', () => {
  // Regression: the old join checked only whether the PATH started with '/', so an off-site src
  // was concatenated onto the base as if it were a path - producing
  // `/preview-123/https://cdn.example.com/x.png`. Reachable because the MDX image dialog's
  // "By URL" tab stores arbitrary author-typed srcs.
  it('returns a scheme-qualified src unchanged even with a baseUrl', () => {
    const offSite = 'https://cdn.example.com/x.png'
    expect(assetUrl({ src: offSite }, { baseUrl: '/preview-123' })).toBe(offSite)
    expect(assetUrl({ src: offSite }, { baseUrl: 'https://cms.example.com' })).toBe(offSite)
  })

  it('returns a protocol-relative src unchanged even with a baseUrl', () => {
    const offSite = '//cdn.example.com/x.png'
    expect(assetUrl({ src: offSite }, { baseUrl: '/preview-123' })).toBe(offSite)
  })

  // A src we don't own must come back EXACTLY as it went in when there is no mount point to
  // apply. The README routes every markdown/MDX body image through assetUrl so a basePath
  // deployment can prefix them, and bodies carry srcs canopycms never wrote.
  it('returns a data: URI unchanged rather than rooting it into a broken src', () => {
    const dataUri = 'data:image/png;base64,AAA'
    expect(assetUrl({ src: dataUri })).toBe(dataUri)
    expect(assetUrl({ src: dataUri }, { baseUrl: '/preview-123' })).toBe(dataUri)
  })

  it('treats every spelling of "no mount point" the same', () => {
    // '' and '/' disagreed: '' took the byte-identical path while '/' went through the join and
    // rooted the src. joinUrlPrefix's own contract says '', '/', '///' and '//' all mean root.
    for (const baseUrl of ['', '/', '///', '//']) {
      expect(assetUrl({ src: 'images/x.png' }, { baseUrl })).toBe('images/x.png')
    }
  })

  it('leaves a page-relative src alone when no baseUrl is given', () => {
    // Rooting it would change which URL it resolves to.
    expect(assetUrl({ src: 'images/x.png' })).toBe('images/x.png')
    expect(assetUrl({ src: '' })).toBe('')
  })

  it('collapses a // pathname produced by neutralizing, rather than emitting protocol-relative', () => {
    expect(assetUrl({ src: '/\\evil.com//x.png' })).toBe('/x.png')
    expect(assetUrl({ src: '/\\evil.com//x.png' }, { baseUrl: '/preview-123' })).toBe(
      '/preview-123/x.png',
    )
  })

  it('neutralizes a backslash-spelled off-origin src instead of prefixing it', () => {
    // `/\evil.com/x` parses to origin https://evil.com in a browser despite looking
    // site-relative. It must not survive into an <img src>.
    expect(assetUrl({ src: '/\\evil.com/x.png' }, { baseUrl: '/preview-123' })).toBe(
      '/preview-123/x.png',
    )
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
