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
})
