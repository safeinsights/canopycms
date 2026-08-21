import { describe, expect, it, vi } from 'vitest'
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

  it('single shape: skips index entries, whose URL a [slug] route cannot represent', async () => {
    // An index entry's urlPath is the COLLECTION's path (/posts), so a [slug] route has no param
    // that addresses it — emitting `slug: 'index'` reconstructs /posts/index, which
    // readByUrlPath deliberately does not resolve, prerendering a guaranteed notFound.
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/posts', slug: 'index', entryType: 'postIndex' },
      { urlPath: '/posts/b', slug: 'b', entryType: 'post' },
    ])

    expect(await collectStaticParams(ctx, { shape: 'single' })).toEqual([
      { slug: 'a' },
      { slug: 'b' },
    ])
  })

  it('catch-all shape still emits index entries, using their collapsed segments', async () => {
    // The counterpart to the skip above: catch-all CAN represent a collection URL, so dropping
    // index entries there would lose the page entirely.
    const ctx = fakeBuildCtx([{ urlPath: '/posts', slug: 'index', entryType: 'postIndex' }])

    expect(await collectStaticParams(ctx)).toEqual([{ slug: ['posts'] }])
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

  it("basePath has no effect with shape: 'single', matching its own doc (regression)", async () => {
    // Before the fix, basePath's prefix FILTER ran regardless of shape, so a stale/wrong basePath
    // silently dropped every entry outside the prefix even for 'single' — which only ever reads
    // `entry.slug`, never `segments`. That contradicted this option's doc ("no effect with
    // shape: 'single'") and meant unbuilt pages. Scope 'single' with rootPath instead.
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/docs/b', slug: 'b', entryType: 'doc' },
    ])

    const params = await collectStaticParams(ctx, { shape: 'single', basePath: '/docs' })

    // Both entries are still emitted — basePath did not filter out '/posts/a'.
    expect(params).toEqual([{ slug: 'a' }, { slug: 'b' }])
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

  it('honors a nested SEO group when reading noindex — and forgetting it is a real hazard', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/hidden', slug: 'hidden', entryType: 'page', data: { seo: { noindex: true } } },
    ])

    expect(await generateContentSitemap(ctx, { siteUrl: SITE, seo: { group: 'seo' } })).toEqual([])
    // Without the `seo` option, the noindex flag is invisible to THIS call — a hidden entry ships
    // in the sitemap. `generateContentSitemap` and `entryToMetadata` each take their own `seo`/
    // `fields`/`group` per call, so an adopter who sets it on one and forgets the other gets a page
    // that says noindex while the sitemap still advertises its URL. That's what
    // `createNextCanopyContext({ seo })` + its bound helpers (see context-wrapper.ts) exist to
    // prevent — see context-wrapper-seo.test.ts for the two surfaces sharing one default.
    expect(await generateContentSitemap(ctx, { siteUrl: SITE })).toHaveLength(1)
  })

  it('throws when siteUrl is not absolute (a non-absolute <loc> invalidates the whole sitemap)', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/a', slug: 'a', entryType: 'page' }])

    await expect(generateContentSitemap(ctx, { siteUrl: 'example.com' })).rejects.toThrow(
      /absolute siteUrl.*"example\.com"/s,
    )
    await expect(generateContentSitemap(ctx, { siteUrl: '' })).rejects.toThrow(/absolute siteUrl/)
  })

  it('dedupes a colliding URL, keeping the first entry and warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // An index entry ('/guides/index' -> '/guides') collides with a sibling entry whose slug is
      // literally 'guides' in the parent collection — both resolve to the same urlPath.
      const ctx = fakeBuildCtx([
        { urlPath: '/guides', slug: 'index', entryType: 'doc' },
        { urlPath: '/guides', slug: 'guides', entryType: 'page' },
      ])

      const sitemap = await generateContentSitemap(ctx, { siteUrl: SITE })

      expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/guides`])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${SITE}/guides`))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// pathFor: reroute a real entry WITHOUT leaving the entry pipeline
// ---------------------------------------------------------------------------
//
// The capability `extraUrls` could not provide. Re-advertising a real entry through `extraUrls`
// drops it out of the walk, and with it the noindex gate, the `updatedAt` default and `priority`
// — three things the adopter then re-derives by hand, and gets wrong independently. The pair of
// tests at the end of this block assert that difference directly, in both directions.
describe('pathFor', () => {
  const noindexed = { metaTitle: 'Hidden', noindex: true }

  it('advertises the entry at the returned path instead of its structural urlPath', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/articles/a', slug: 'a', entryType: 'article' }])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      pathFor: (entry) => entry.urlPath.replace(/^\/articles\//, '/blog/'),
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/blog/a`])
  })

  // THE semantic choice. `null` means "no opinion", not "drop it" — so the shape every adopter
  // reaches for first (handle the one type you care about, `null` for the rest) rewrites that one
  // and leaves the others at their own URLs. Had `null` meant "skip", this exact callback would
  // have shipped a one-URL sitemap and nothing would have warned.
  it('treats a null return as "keep the structural path", not "drop the entry"', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/home', slug: 'home', entryType: 'home' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/posts/b', slug: 'b', entryType: 'post' },
    ])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      pathFor: (entry) => (entry.entryType === 'home' ? '/' : null),
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/`, `${SITE}/posts/a`, `${SITE}/posts/b`])
  })

  // Same meaning as null, because an adopter writing `if (…) return '/x'` with no else produces
  // undefined and TypeScript would otherwise reject the callback for no reason a user can act on.
  it('treats an undefined return the same as null', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/posts/a', slug: 'a', entryType: 'post' }])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      pathFor: () => undefined,
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/posts/a`])
  })

  // An empty string is neither an override nor an abstention: resolveSeoUrl('') is the site root,
  // so honouring it would silently advertise this entry at '/'. Red build instead.
  it('throws on an empty override rather than silently advertising the site root', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/posts/a', slug: 'a', entryType: 'post' }])

    await expect(
      generateContentSitemap(ctx, { siteUrl: SITE, pathFor: () => '   ' }),
    ).rejects.toThrow(/pathFor returned an empty path/)
  })

  it('keeps the entry inside the walk: updatedAt default and priority still apply', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/articles/a', slug: 'a', entryType: 'article', updatedAt: '2024-03-01' },
    ])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      pathFor: () => '/blog/a',
      priority: () => 0.7,
    })

    expect(sitemap).toEqual([{ url: `${SITE}/blog/a`, lastModified: '2024-03-01', priority: 0.7 }])
  })

  // Documented ordering: the override decides the URL, never whether the entry is advertised.
  it('runs after exclude, so an excluded entry is not advertised at the override either', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/articles/a', slug: 'a', entryType: 'article' },
      { urlPath: '/articles/b', slug: 'b', entryType: 'article' },
    ])

    const sitemap = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      exclude: (entry) => entry.slug === 'a',
      pathFor: (entry) => `/blog/${entry.slug}`,
    })

    expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/blog/b`])
  })

  // The other half of that ordering, and the thing most likely to surprise: sibling callbacks see
  // the entry as ENUMERATED. Branch on the entry, not on a urlPath that pathFor has not applied.
  it('passes the structural urlPath to exclude, lastModified and priority — not the override', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/articles/a', slug: 'a', entryType: 'article' }])
    const seenByExclude: string[] = []
    const seenByLastModified: string[] = []
    const seenByPriority: string[] = []

    await generateContentSitemap(ctx, {
      siteUrl: SITE,
      pathFor: () => '/blog/a',
      exclude: (entry) => {
        seenByExclude.push(entry.urlPath)
        return false
      },
      lastModified: (entry) => {
        seenByLastModified.push(entry.urlPath)
        return undefined
      },
      priority: (entry) => {
        seenByPriority.push(entry.urlPath)
        return undefined
      },
    })

    expect(seenByExclude).toEqual(['/articles/a'])
    expect(seenByLastModified).toEqual(['/articles/a'])
    expect(seenByPriority).toEqual(['/articles/a'])
  })

  it('warns and keeps the first when pathFor rewrites two entries onto one URL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = fakeBuildCtx([
        { urlPath: '/articles/a', slug: 'a', entryType: 'article' },
        { urlPath: '/articles/b', slug: 'b', entryType: 'article' },
      ])

      const sitemap = await generateContentSitemap(ctx, { siteUrl: SITE, pathFor: () => '/blog' })

      expect(sitemap.map((u) => u.url)).toEqual([`${SITE}/blog`])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pathFor'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  // The reason this option exists, asserted as a contrast rather than described in a comment.
  it('applies the noindex gate to a rerouted entry — which extraUrls cannot', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/home', slug: 'home', entryType: 'home', data: noindexed },
    ])

    // Rerouted via pathFor: still inside the walk, so noindex still suppresses it.
    expect(await generateContentSitemap(ctx, { siteUrl: SITE, pathFor: () => '/' })).toEqual([])

    // The pre-pathFor workaround, for contrast: exclude the entry and re-add its URL by hand. The
    // entry is marked noindex and the URL is advertised anyway, because nothing gates an extra URL.
    const viaExtraUrls = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      exclude: (entry) => entry.entryType === 'home',
      extraUrls: [{ path: '/' }],
    })
    expect(viaExtraUrls.map((u) => u.url)).toEqual([`${SITE}/`])
  })

  it('carries lastModified onto a rerouted entry — which extraUrls also cannot', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/home', slug: 'home', entryType: 'home', updatedAt: '2024-05-05' },
    ])

    const viaPathFor = await generateContentSitemap(ctx, { siteUrl: SITE, pathFor: () => '/' })
    expect(viaPathFor).toEqual([{ url: `${SITE}/`, lastModified: '2024-05-05' }])

    const viaExtraUrls = await generateContentSitemap(ctx, {
      siteUrl: SITE,
      exclude: (entry) => entry.entryType === 'home',
      extraUrls: [{ path: '/' }],
    })
    expect(viaExtraUrls).toEqual([{ url: `${SITE}/` }])
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
