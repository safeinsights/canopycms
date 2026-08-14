import { describe, expect, it } from 'vitest'
import type { CanopyBuildContext } from 'canopycms/server'
import { collectStaticParams, entryToMetadata, generateContentSitemap } from './static'

interface FakeEntry {
  urlPath: string
  slug: string
  entryType: string
  data?: Record<string, unknown>
  updatedAt?: string
}

/** Build a fake build context exposing only listEntries (all the helper touches). */
function fakeBuildCtx(items: FakeEntry[]) {
  const withData = items.map((item) => ({ data: {}, ...item }))
  return { listEntries: async () => withData } as unknown as Pick<CanopyBuildContext, 'listEntries'>
}

const SITE = 'https://example.com'

describe('collectStaticParams', () => {
  it('catch-all (default): emits segments arrays under "slug"', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/docs/guides', slug: 'index', entryType: 'doc' },
    ])

    const params = await collectStaticParams(ctx)

    expect(params).toEqual([{ slug: ['posts', 'a'] }, { slug: ['docs', 'guides'] }])
  })

  it('single shape: emits the entry slug as a string', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/posts/b', slug: 'b', entryType: 'post' },
    ])

    const params = await collectStaticParams(ctx, { shape: 'single' })

    expect(params).toEqual([{ slug: 'a' }, { slug: 'b' }])
  })

  it('honors a custom paramName and filter', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/', slug: 'index', entryType: 'home' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
    ])

    const params = await collectStaticParams(ctx, {
      paramName: 'path',
      filter: (e) => e.segments.length > 0,
    })

    expect(params).toEqual([{ path: ['posts', 'a'] }])
  })

  it('basePath: scopes to the prefix and makes segments relative to it (nested catch-all)', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/docs', slug: 'index', entryType: 'doc' },
      { urlPath: '/docs/guides/intro', slug: 'intro', entryType: 'doc' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' }, // outside /docs → excluded
    ])

    const params = await collectStaticParams(ctx, { rootPath: 'content/docs', basePath: '/docs' })

    // /docs index → empty segments; /docs/guides/intro → ['guides','intro']; /posts/a excluded
    expect(params).toEqual([{ slug: [] }, { slug: ['guides', 'intro'] }])
  })

  it('basePath matches case-insensitively (urlPath is always lowercased)', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/docs/guides', slug: 'guides', entryType: 'doc' }])

    const params = await collectStaticParams(ctx, { basePath: '/Docs' })

    expect(params).toEqual([{ slug: ['guides'] }])
  })
})

describe('generateContentSitemap', () => {
  // THE regression guard. A hand-rolled sitemap that enumerated a remembered list of entry
  // types shipped in production carrying only the site's "page" URLs — every article and case
  // study was built as HTML and advertised nowhere. Nothing failed and nothing warned.
  it('includes every routable entry type by default', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/', slug: 'index', entryType: 'home' },
      { urlPath: '/about', slug: 'about', entryType: 'page' },
      { urlPath: '/blog/a', slug: 'a', entryType: 'article' },
      { urlPath: '/case-studies/b', slug: 'b', entryType: 'caseStudy' },
      { urlPath: '/people/c', slug: 'c', entryType: 'person' },
    ])

    const sitemap = await generateContentSitemap(ctx, { siteUrl: SITE })

    expect(sitemap.map((u) => u.url)).toEqual([
      `${SITE}/`,
      `${SITE}/about`,
      `${SITE}/blog/a`,
      `${SITE}/case-studies/b`,
      `${SITE}/people/c`,
    ])
  })

  it('emits trailing-slash URLs only when told to — Canopy cannot read next.config', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/contact', slug: 'contact', entryType: 'page' }])

    expect((await generateContentSitemap(ctx, { siteUrl: SITE }))[0].url).toBe(`${SITE}/contact`)
    expect((await generateContentSitemap(ctx, { siteUrl: SITE, trailingSlash: true }))[0].url).toBe(
      `${SITE}/contact/`,
    )
  })

  it('defaults lastModified to updatedAt and omits it when absent', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/a', slug: 'a', entryType: 'page', updatedAt: '2026-01-02T00:00:00.000Z' },
      { urlPath: '/b', slug: 'b', entryType: 'page' },
    ])

    const [a, b] = await generateContentSitemap(ctx, { siteUrl: SITE })

    expect(a.lastModified).toBe('2026-01-02T00:00:00.000Z')
    expect('lastModified' in b).toBe(false)
  })

  it('lets a callback replace lastModified, including omitting it entirely', async () => {
    const ctx = fakeBuildCtx([
      {
        urlPath: '/a',
        slug: 'a',
        entryType: 'page',
        data: { publishedAt: '2020-05-05' },
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      { urlPath: '/b', slug: 'b', entryType: 'page', updatedAt: '2026-01-02T00:00:00.000Z' },
    ])

    const [a, b] = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      lastModified: (entry) =>
        typeof entry.data.publishedAt === 'string' ? entry.data.publishedAt : undefined,
    })

    expect(a.lastModified).toBe('2020-05-05')
    expect('lastModified' in b).toBe(false)
  })

  it('applies exclude on top of the noindex filter, and priority per entry', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/', slug: 'index', entryType: 'home' },
      { urlPath: '/internal', slug: 'internal', entryType: 'page' },
    ])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      exclude: (entry) => entry.urlPath === '/internal',
      priority: (entry) => (entry.urlPath === '/' ? 1 : undefined),
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/`])
    expect(sitemap[0].priority).toBe(1)
  })

  it('appends extraUrls and sorts stably with the root first', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/zebra', slug: 'zebra', entryType: 'page' },
      { urlPath: '/', slug: 'index', entryType: 'home' },
    ])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      extraUrls: [{ path: '/blog', changeFrequency: 'daily', priority: 0.8 }],
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/`, `${SITE}/blog`, `${SITE}/zebra`])
    expect(sitemap[1]).toMatchObject({ changeFrequency: 'daily', priority: 0.8 })
  })

  it('honors a nested SEO group when reading noindex', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/hidden', slug: 'hidden', entryType: 'page', data: { seo: { noindex: true } } },
    ])

    expect(await generateContentSitemap(ctx, { siteUrl: SITE, seo: { group: 'seo' } })).toEqual([])
    // Without the group option the flag is invisible — proof the option is doing the work.
    expect(await generateContentSitemap(ctx, { siteUrl: SITE })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// noindex: ONE predicate, BOTH surfaces
// ---------------------------------------------------------------------------
//
// Splitting these is the failure this pairing exists to prevent: derived separately, a noindex
// entry stayed advertised in one surface while correctly suppressed in the other, and nothing
// warned. Both directions are asserted from the same entry data.
describe('noindex feeds both surfaces from one predicate', () => {
  const draft = { metaTitle: 'Unfinished', noindex: true }
  const live = { metaTitle: 'Live', noindex: false }

  it('suppresses a noindex entry in the sitemap AND in the page robots', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/draft', slug: 'draft', entryType: 'page', data: draft },
      { urlPath: '/live', slug: 'live', entryType: 'page', data: live },
    ])

    const sitemap = await generateContentSitemap(ctx, { siteUrl: SITE })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/live`])
    expect(entryToMetadata(draft, { path: '/draft' }).robots).toEqual({
      index: false,
      follow: false,
    })
  })

  it('advertises a non-noindex entry in the sitemap AND leaves robots unset', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/live', slug: 'live', entryType: 'page', data: live }])

    const sitemap = await generateContentSitemap(ctx, { siteUrl: SITE })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/live`])
    expect(entryToMetadata(live, { path: '/live' }).robots).toBeUndefined()
  })

  it('still ENUMERATES a noindex entry for generateStaticParams — noindex is not unbuilt', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/draft', slug: 'draft', entryType: 'page', data: draft }])

    expect(await collectStaticParams(ctx, { shape: 'single' })).toEqual([{ slug: 'draft' }])
  })
})

describe('entryToMetadata', () => {
  it('emits title, description, canonical, OG and Twitter cards', () => {
    const metadata = entryToMetadata(
      { metaTitle: 'Contact', metaDescription: 'Talk to us' },
      { path: '/contact', siteUrl: SITE, trailingSlash: true },
    )

    expect(metadata.title).toBe('Contact')
    expect(metadata.description).toBe('Talk to us')
    expect(metadata.alternates?.canonical).toBe(`${SITE}/contact/`)
    expect(metadata.openGraph).toMatchObject({ type: 'website', url: `${SITE}/contact/` })
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image', title: 'Contact' })
  })

  it('lets an entry canonical override the route path', () => {
    const metadata = entryToMetadata({ canonical: '/other' }, { path: '/contact', siteUrl: SITE })

    expect(metadata.alternates?.canonical).toBe(`${SITE}/other`)
  })

  // An absolute canonical points at a copy of the page hosted elsewhere (syndication, a partner
  // site) and must survive verbatim. Regression: normalizing before the absolute check produced
  // `<siteUrl>/https://other.org/page/`.
  it('passes an absolute canonical through untouched, in openGraph.url too', () => {
    const metadata = entryToMetadata(
      { canonical: 'https://other.org/page' },
      { path: '/contact', siteUrl: SITE, trailingSlash: true },
    )

    expect(metadata.alternates?.canonical).toBe('https://other.org/page')
    expect(metadata.openGraph).toMatchObject({ url: 'https://other.org/page' })
  })

  it('omits alternates entirely when nothing resolves a canonical', () => {
    expect(entryToMetadata({}, { siteName: 'Example' }).alternates).toBeUndefined()
  })

  it('omits the title when nothing resolves, so the layout default applies', () => {
    expect(entryToMetadata({}, { path: '/x', siteUrl: SITE }).title).toBeUndefined()
  })

  it('falls back to the site name for the social title', () => {
    const metadata = entryToMetadata({}, { path: '/x', siteUrl: SITE, siteName: 'Example' })

    expect(metadata.openGraph?.title).toBe('Example')
    expect(metadata.openGraph).toMatchObject({ siteName: 'Example' })
  })

  it('supports the root-layout title template', () => {
    const metadata = entryToMetadata(
      { metaTitle: 'Example' },
      { titleTemplate: '%s | Example', siteName: 'Example' },
    )

    expect(metadata.title).toEqual({ template: '%s | Example', default: 'Example' })
  })

  it('honours the article og:type and resolves a relative og image absolutely', () => {
    const metadata = entryToMetadata(
      { ogImage: '/covers/a.jpg' },
      { path: '/blog/post', siteUrl: SITE, trailingSlash: true, defaultOgType: 'article' },
    )

    expect(metadata.openGraph).toMatchObject({ type: 'article' })
    // No trailing slash on an image, even with trailingSlash on: it is a file, not a route.
    expect(metadata.openGraph?.images).toEqual([{ url: `${SITE}/covers/a.jpg` }])
    expect(metadata.twitter?.images).toEqual([`${SITE}/covers/a.jpg`])
  })

  it('leaves an absolute og image untouched', () => {
    const metadata = entryToMetadata({ ogImage: 'https://cdn.example.com/a.png' }, { path: '/x' })

    expect(metadata.openGraph?.images).toEqual([{ url: 'https://cdn.example.com/a.png' }])
  })

  it('leaves URLs relative when no siteUrl is given (Next resolves via metadataBase)', () => {
    const metadata = entryToMetadata({}, { path: '/contact', trailingSlash: true })

    expect(metadata.alternates?.canonical).toBe('/contact/')
  })

  it('emits only the documented Metadata keys', () => {
    const metadata = entryToMetadata(
      { metaTitle: 'T', metaDescription: 'D', ogImage: '/a.png', noindex: true },
      { path: '/x', siteUrl: SITE, siteName: 'S' },
    )

    expect(Object.keys(metadata).sort()).toEqual(
      ['alternates', 'description', 'openGraph', 'robots', 'title', 'twitter'].sort(),
    )
  })
})
