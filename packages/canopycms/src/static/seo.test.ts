import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEO_FIELD_NAMES,
  extractSeoFields,
  isAbsoluteUrl,
  isNoindexEntry,
  resolveSeoUrl,
  withTrailingSlash,
} from './seo'
import { defineSeoFieldGroup } from '../entry-schema'

describe('extractSeoFields', () => {
  it('reads the flat group and normalizes values', () => {
    const seo = extractSeoFields({
      metaTitle: '  Meta title  ',
      metaDescription: 'Meta description',
      ogImage: '/og.png',
      ogType: 'article',
      canonical: '/canonical',
      noindex: true,
      twitterCard: 'summary',
    })

    expect(seo).toEqual({
      title: 'Meta title',
      description: 'Meta description',
      ogImage: '/og.png',
      ogType: 'article',
      canonical: '/canonical',
      noindex: true,
      twitterCard: 'summary',
    })
  })

  // Load-bearing: CanopyCMS writes optional fields present-but-empty, so an untouched SEO group
  // is `metaTitle: ''` on disk. If empty won, every such entry would lose its fallback title.
  it('treats empty/blank CMS fields as unset so fallbacks win', () => {
    const seo = extractSeoFields(
      { metaTitle: '', metaDescription: '   ' },
      { fallbackTitle: 'Entry title', fallbackDescription: 'Entry description' },
    )

    expect(seo.title).toBe('Entry title')
    expect(seo.description).toBe('Entry description')
  })

  it('prefers the entry meta fields over the fallbacks', () => {
    expect(extractSeoFields({ metaTitle: 'Meta' }, { fallbackTitle: 'Entry title' }).title).toBe(
      'Meta',
    )
  })

  it('supports a nested group and per-field name overrides', () => {
    expect(extractSeoFields({ seo: { metaTitle: 'Nested' } }, { group: 'seo' }).title).toBe(
      'Nested',
    )
    expect(extractSeoFields({ seoTitle: 'Renamed' }, { fields: { title: 'seoTitle' } }).title).toBe(
      'Renamed',
    )
  })

  it('reads a nested group only from the group, not from flat fields', () => {
    expect(extractSeoFields({ metaTitle: 'Flat' }, { group: 'seo' }).title).toBeUndefined()
  })

  it('ignores non-string / non-boolean junk and unknown enum values', () => {
    const seo = extractSeoFields({
      metaTitle: 42,
      noindex: 'yes',
      ogType: 'banana',
      twitterCard: 'nope',
    })

    expect(seo.title).toBeUndefined()
    expect(seo.noindex).toBeUndefined()
    expect(seo.ogType).toBeUndefined()
    expect(seo.twitterCard).toBeUndefined()
  })

  it('accepts an image-field object for ogImage as well as a plain string', () => {
    expect(extractSeoFields({ ogImage: { src: '/og.png', alt: 'OG' } }).ogImage).toBe('/og.png')
    expect(extractSeoFields({ ogImage: { alt: 'no src' } }).ogImage).toBeUndefined()
  })

  it('is safe on null / non-object entry data', () => {
    expect(extractSeoFields(null)).toEqual({
      title: undefined,
      description: undefined,
      ogImage: undefined,
      ogType: undefined,
      canonical: undefined,
      noindex: undefined,
      twitterCard: undefined,
    })
    expect(extractSeoFields(['not', 'an', 'entry']).title).toBeUndefined()
  })
})

describe('isNoindexEntry', () => {
  it('is true only for an explicit boolean true', () => {
    expect(isNoindexEntry({ noindex: true })).toBe(true)
    expect(isNoindexEntry({ noindex: false })).toBe(false)
    expect(isNoindexEntry({ noindex: 'true' })).toBe(false)
    expect(isNoindexEntry({})).toBe(false)
    expect(isNoindexEntry(null)).toBe(false)
  })

  it('honors the field location options', () => {
    expect(isNoindexEntry({ seo: { noindex: true } }, { group: 'seo' })).toBe(true)
    expect(isNoindexEntry({ hidden: true }, { fields: { noindex: 'hidden' } })).toBe(true)
  })
})

describe('defineSeoFieldGroup', () => {
  // Drift guard: the schema this emits and the fields extractSeoFields looks for are the same
  // seven names. If someone renames one end, this fails instead of silently reading nothing.
  it('emits exactly the field names extractSeoFields reads by default', () => {
    const group = defineSeoFieldGroup()

    expect(group.fields.map((f) => f.name)).toEqual(Object.values(DEFAULT_SEO_FIELD_NAMES))
  })

  it('is an inline (flat) group by default', () => {
    const group = defineSeoFieldGroup()

    expect(group.type).toBe('group')
    expect(group.label).toBe('SEO')
  })

  it('nests under the given key when `group` is passed, matching extractSeoFields({ group })', () => {
    const group = defineSeoFieldGroup({ group: 'seo' })

    expect(group.type).toBe('object')
    expect(group.name).toBe('seo')
  })

  it('marks every SEO field optional — unset metadata must fall back, never fail validation', () => {
    expect(defineSeoFieldGroup().fields.every((f) => f.required === false)).toBe(true)
  })

  it('offers exactly the enum values the extractor accepts', () => {
    const byName = new Map(defineSeoFieldGroup().fields.map((f) => [f.name, f]))
    const ogType = byName.get(DEFAULT_SEO_FIELD_NAMES.ogType)
    const twitterCard = byName.get(DEFAULT_SEO_FIELD_NAMES.twitterCard)

    expect(ogType && 'options' in ogType ? ogType.options : undefined).toEqual([
      'website',
      'article',
      'profile',
    ])
    expect(twitterCard && 'options' in twitterCard ? twitterCard.options : undefined).toEqual([
      'summary',
      'summary_large_image',
    ])
  })
})

describe('URL shaping — off-origin regression guards', () => {
  // A WHATWG pathname can itself start with '//': '/\\evil.com//a' parses to host evil.com with
  // pathname '//a'. Emitting that dropped siteUrl entirely and produced a protocol-relative URL
  // pointing at a host named 'a' — an off-site canonical/og:url from a plain content field, and a
  // non-absolute <loc> that invalidates the whole sitemap.
  it('never drops siteUrl for a backslash-spelled off-origin value whose pathname starts with //', () => {
    expect(resolveSeoUrl('/\\evil.com//a', { siteUrl: 'https://example.com' })).toBe(
      'https://example.com/a',
    )
    expect(
      resolveSeoUrl('/\\evil.com//a.png', { siteUrl: 'https://example.com', trailingSlash: true }),
    ).toBe('https://example.com/a.png')
    expect(resolveSeoUrl('\\\\evil.com//a', { siteUrl: 'https://example.com' })).toBe(
      'https://example.com/a',
    )
  })

  // The gap that let a scheme pass-through leak in from the shared join and go unnoticed: nothing
  // pinned what resolveSeoUrl does with a colon-first value. It must ROOT it onto the origin, not
  // hand it back verbatim -- a non-absolute sitemap <loc> invalidates the entire sitemap, and a
  // canonical/og:url that silently drops the origin points off-site.
  it('roots a scheme-bearing value onto siteUrl instead of returning it verbatim', () => {
    const site = { siteUrl: 'https://example.com' }
    expect(resolveSeoUrl('mailto:a@b.c', site)).toBe('https://example.com/mailto:a@b.c')
    expect(resolveSeoUrl('javascript:alert(1)', site)).toBe(
      'https://example.com/javascript:alert(1)',
    )
    expect(resolveSeoUrl('data:text/html,x', site)).toBe('https://example.com/data:text/html,x')
    expect(resolveSeoUrl('about:blank', site)).toBe('https://example.com/about:blank')
    expect(resolveSeoUrl('example.com:8080/page', site)).toBe(
      'https://example.com/example.com:8080/page',
    )
  })

  // trailingSlash is a routing flag; it must not decide whether a value is treated as an off-site
  // pointer or a path segment. While the pass-through leaked in, these two disagreed.
  it('gives the same class of answer with and without trailingSlash', () => {
    const site = { siteUrl: 'https://example.com' }
    expect(resolveSeoUrl('mailto:a@b.c', site)).toBe(
      resolveSeoUrl('mailto:a@b.c', { ...site, trailingSlash: true }),
    )
  })

  it('emits a same-origin path, not a protocol-relative one, when no siteUrl is given', () => {
    expect(resolveSeoUrl('/\\evil.com//a')).toBe('/a')
  })

  it('still passes a genuinely off-site pointer through untouched', () => {
    expect(resolveSeoUrl('https://other.org/page', { siteUrl: 'https://example.com' })).toBe(
      'https://other.org/page',
    )
    expect(resolveSeoUrl('//cdn.example.com/a.png', { siteUrl: 'https://example.com' })).toBe(
      '//cdn.example.com/a.png',
    )
  })
})

describe('URL shaping', () => {
  it('recognizes scheme-qualified and protocol-relative URLs as absolute', () => {
    expect(isAbsoluteUrl('https://other.org/page')).toBe(true)
    expect(isAbsoluteUrl('http://other.org/page')).toBe(true)
    expect(isAbsoluteUrl('//cdn.example.com/a.png')).toBe(true)
    expect(isAbsoluteUrl('/page')).toBe(false)
    expect(isAbsoluteUrl('page')).toBe(false)
  })

  it('withTrailingSlash leaves the root, existing slashes and file-like paths alone', () => {
    expect(withTrailingSlash('/contact')).toBe('/contact/')
    expect(withTrailingSlash('contact')).toBe('/contact/')
    expect(withTrailingSlash('/')).toBe('/')
    expect(withTrailingSlash('/contact/')).toBe('/contact/')
    expect(withTrailingSlash('/blog/rss.xml')).toBe('/blog/rss.xml')
  })

  // Regression: the slash was appended after the raw string, so a query string or fragment ended
  // up with a slash INSIDE it ('/blog?page=2' -> '/blog?page=2/') instead of before it.
  it('withTrailingSlash places the slash before a query string or fragment, not after it', () => {
    expect(withTrailingSlash('/blog?page=2')).toBe('/blog/?page=2')
    expect(withTrailingSlash('/blog#section')).toBe('/blog/#section')
    expect(withTrailingSlash('/blog?page=2#section')).toBe('/blog/?page=2#section')
    // File-like paths still take no slash — the query/fragment split must not change that check.
    expect(withTrailingSlash('/blog/rss.xml?utm=1')).toBe('/blog/rss.xml?utm=1')
    // Already-slashed / root cases carry the suffix through unchanged.
    expect(withTrailingSlash('/blog/?page=2')).toBe('/blog/?page=2')
    expect(withTrailingSlash('/?ref=home')).toBe('/?ref=home')
  })

  it('prefixes site-relative paths with the origin, stripping its trailing slashes', () => {
    expect(resolveSeoUrl('/contact', { siteUrl: 'https://example.com/' })).toBe(
      'https://example.com/contact',
    )
    expect(resolveSeoUrl('/contact', { siteUrl: 'https://example.com', trailingSlash: true })).toBe(
      'https://example.com/contact/',
    )
  })

  // Regression: normalizing before the absolute check turned an off-site canonical into
  // `<siteUrl>/https://other.org/page/`.
  it('passes absolute and protocol-relative URLs through verbatim', () => {
    const opts = { siteUrl: 'https://example.com', trailingSlash: true }

    expect(resolveSeoUrl('https://other.org/page', opts)).toBe('https://other.org/page')
    expect(resolveSeoUrl('http://other.org/page', opts)).toBe('http://other.org/page')
    expect(resolveSeoUrl('//cdn.example.com/a.png', opts)).toBe('//cdn.example.com/a.png')
  })

  it('stays relative when no siteUrl is given (framework resolves via metadataBase)', () => {
    expect(resolveSeoUrl('/contact', { trailingSlash: true })).toBe('/contact/')
    expect(resolveSeoUrl('contact')).toBe('/contact')
  })

  // Regression: isAbsoluteUrl's own `startsWith('//')` check is the exact predicate
  // `utils/sanitize-href.ts` documents removing from `sanitizeHref` two weeks earlier, because
  // WHATWG URL treats backslash as equivalent to forward slash for special schemes, so
  // `/\evil.com`, `\\evil.com` and `\/evil.com` are all protocol-relative in effect despite
  // declaring no scheme and not starting with a literal `//`.
  it('does not call a WHATWG-backslash-equivalent spelling "absolute"', () => {
    expect(isAbsoluteUrl('/\\evil.com')).toBe(false)
    expect(isAbsoluteUrl('\\\\evil.com')).toBe(false)
    expect(isAbsoluteUrl('\\/evil.com')).toBe(false)
  })

  describe('resolveSeoUrl never resolves a backslash-equivalent spelling off-site', () => {
    // With no siteUrl, `canonical`/`ogImage` are documented to stay relative and let the
    // framework's metadataBase resolve them -- exactly the path where a value that merely
    // "looks" root-relative but is actually protocol-relative in a browser would otherwise reach
    // `<link rel="canonical">` / `og:image` pointing at an attacker-controlled origin.
    it.each([
      ['backslash after slash', '/\\evil.com'],
      ['double backslash', '\\\\evil.com'],
      ['backslash then slash', '\\/evil.com'],
      ['tab inside', '/\t/evil.com'],
      ['mixed slashes with path', '/\\evil.com/path?a=1'],
    ])('%s stays on the current origin with no siteUrl', (_label, input) => {
      const result = resolveSeoUrl(input)
      expect(result).not.toMatch(/^https?:\/\//)
      // Resolved the way a browser resolves a relative href: must land on the PAGE's own
      // origin, never on evil.com.
      expect(new URL(result, 'https://mysite.example/page').origin).toBe('https://mysite.example')
    })

    it.each([
      ['backslash after slash', '/\\evil.com'],
      ['double backslash', '\\\\evil.com'],
      ['backslash then slash', '\\/evil.com'],
    ])("%s stays on siteUrl's origin when siteUrl is given", (_label, input) => {
      const result = resolveSeoUrl(input, { siteUrl: 'https://example.com' })
      expect(new URL(result).origin).toBe('https://example.com')
    })

    it('does not touch a genuine site-relative path', () => {
      expect(resolveSeoUrl('/contact', { siteUrl: 'https://example.com' })).toBe(
        'https://example.com/contact',
      )
    })

    it('still passes a literal protocol-relative URL through verbatim (unaffected)', () => {
      expect(resolveSeoUrl('//cdn.example.com/a.png', { siteUrl: 'https://example.com' })).toBe(
        '//cdn.example.com/a.png',
      )
    })
  })
})

describe('siteUrl trailing-slash stripping is linear (js/polynomial-redos)', () => {
  it('strips trailing slashes identically to the regex it replaced', () => {
    expect(resolveSeoUrl('/a', { siteUrl: 'https://x.com' })).toBe('https://x.com/a')
    expect(resolveSeoUrl('/a', { siteUrl: 'https://x.com/' })).toBe('https://x.com/a')
    expect(resolveSeoUrl('/a', { siteUrl: 'https://x.com///' })).toBe('https://x.com/a')
    // interior slashes are untouched -- only the tail is trimmed
    expect(resolveSeoUrl('/a', { siteUrl: 'https://x.com/base//' })).toBe('https://x.com/base/a')
  })

  it('does not degrade on a slash-heavy siteUrl that does not end in a slash', () => {
    // The replaced `/\/+$/` was quadratic here: the engine retried the quantifier from every
    // position before failing the end anchor. Measured at ~2.4s for this input; the character
    // scan is ~0.01ms. A generous ceiling still fails loudly if a regex is reintroduced.
    const adversarial = `https://x.com${'/'.repeat(40000)}a`
    const started = performance.now()
    expect(resolveSeoUrl('/p', { siteUrl: adversarial })).toBe(`${adversarial}/p`)
    expect(performance.now() - started).toBeLessThan(250)
  })
})
