import type { Metadata, MetadataRoute } from 'next'
import {
  collectRoutableEntries,
  collectStaticPaths,
  extractSeoFields,
  isNoindexEntry,
  resolveSeoUrl,
  type CanopyBuildContext,
  type CollectStaticPathsOptions,
  type ExtractSeoFieldsOptions,
  type RoutableEntry,
  type SeoFieldLocation,
  type SeoOgType,
} from 'canopycms/server'

/**
 * Next.js static-export helpers built on the framework-agnostic core in `canopycms/server`:
 * static params (`collectStaticParams`), the content sitemap (`generateContentSitemap`), and
 * per-entry metadata (`entryToMetadata`).
 *
 * The last two ship together on purpose. `noindex` has to suppress a page in BOTH surfaces —
 * `robots: { index: false }` on the page and absence from the sitemap — and both read it through
 * the same core `isNoindexEntry` predicate, so they cannot disagree about which pages are
 * advertised.
 *
 * `robots.txt` is out of scope: it is a handful of static lines with no CanopyCMS content behind
 * it. Write `app/robots.ts` yourself, and point its `sitemap` at the route below.
 */

export interface GenerateContentStaticParamsOptions extends CollectStaticPathsOptions {
  /** Route param name. Default 'slug'. */
  paramName?: string
  /**
   * Route shape:
   * - 'catch-all' (default) → `[...slug]` / `[[...slug]]`: param value is the URL `segments` array.
   * - 'single' → `[slug]`: param value is the entry `slug` (pair with `rootPath` to scope a collection).
   */
  shape?: 'catch-all' | 'single'
  /**
   * For a catch-all route nested under a URL prefix (e.g. `app/docs/[[...slug]]`), set this to the
   * route's base (e.g. `'/docs'`). Entries are scoped to that prefix and `segments` are made relative
   * to it, so the params match the route. Without it, segments are the full URL path. Applies to
   * catch-all shapes (it rewrites `segments`); it has no effect with `shape: 'single'`.
   */
  basePath?: string
}

/**
 * Shape CanopyCMS content paths into the array Next's `generateStaticParams` expects.
 *
 * This is an **enumeration-only** capability: it reads only the set of routable paths (via the build
 * context's `listEntries`), never entry content, and `generateStaticParams` is build-only — so it
 * cannot serve a user request. It takes a build context directly; prefer the bound
 * `generateContentStaticParams` returned from `createNextCanopyContext`, which closes over the build
 * context so your page modules never import the admin context.
 *
 * Note: a root index ('/') yields empty `segments` — keep it only for an optional catch-all
 * `[[...slug]]`, otherwise exclude it via `options.filter` (e.g. `(e) => e.segments.length > 0`).
 */
export async function collectStaticParams(
  buildCtx: Pick<CanopyBuildContext, 'listEntries'>,
  options: GenerateContentStaticParamsOptions = {},
): Promise<Array<Record<string, string | string[]>>> {
  const { paramName = 'slug', shape = 'catch-all', basePath, ...collectOptions } = options
  let entries = await collectStaticPaths(buildCtx, collectOptions)

  if (basePath) {
    // Make segments relative to a nested route's base prefix (e.g. '/docs' for app/docs/[[...slug]]).
    // urlPath is always lowercased (see content-listing), so lowercase the prefix to match.
    const prefix = (basePath.endsWith('/') ? basePath.slice(0, -1) : basePath).toLowerCase()
    entries = entries
      .filter((entry) => entry.urlPath === prefix || entry.urlPath.startsWith(`${prefix}/`))
      .map((entry) => {
        const rel = entry.urlPath === prefix ? '' : entry.urlPath.slice(prefix.length + 1)
        return { ...entry, segments: rel ? rel.split('/') : [] }
      })
  }

  return entries.map((entry) =>
    shape === 'single' ? { [paramName]: entry.slug } : { [paramName]: entry.segments },
  )
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

type SitemapItem = MetadataRoute.Sitemap[number]

/** A URL with no CanopyCMS entry behind it (a hand-written app route, a feed). */
export interface SitemapExtraUrl {
  /** Site-relative path ('/blog') or an absolute URL. Trailing-slash rules apply to the former. */
  path: string
  lastModified?: Date | string
  changeFrequency?: SitemapItem['changeFrequency']
  priority?: number
}

export interface GenerateContentSitemapOptions {
  /** Site origin, e.g. `https://example.com`. Required: a sitemap must carry absolute URLs. */
  siteUrl: string
  /**
   * Emit site-relative URLs with a trailing slash (`/contact/` rather than `/contact`).
   *
   * **Explicit on purpose.** CanopyCMS cannot see your `next.config.ts`, so it cannot know
   * whether your site serves `trailingSlash: true`. Set this to match, or the sitemap advertises
   * URLs that redirect — a real adopter shipped exactly that mismatch.
   */
  trailingSlash?: boolean
  /** Scope to a collection logical path (e.g. 'content/posts'). Defaults to the whole content root. */
  rootPath?: string
  /** Where the SEO fields live, when they aren't the flat defaults. Drives the `noindex` read. */
  seo?: SeoFieldLocation
  /**
   * Drop entries from the sitemap. Applied ON TOP of the `noindex` exclusion, which is not
   * optional. Use for structural URLs that shouldn't be advertised (e.g. a bare collection index).
   */
  exclude?: (entry: RoutableEntry) => boolean
  /**
   * `<lastmod>` per entry. Defaults to the entry's `updatedAt`.
   *
   * **`updatedAt` is filesystem mtime, not an editorial timestamp.** A fresh CI clone resets every
   * file's mtime to checkout time, so on a clean build agent the default dates every URL to the
   * moment the tree was cloned. Treat the default as "changed since the last build" at best; if
   * you need a truthful `<lastmod>`, supply one here (a content date field, or git commit time)
   * or return `undefined` to omit the element entirely, which is better than asserting a date you
   * cannot stand behind.
   */
  lastModified?: (entry: RoutableEntry) => Date | string | undefined
  /** `<priority>` per entry. Omitted from the URL when this returns undefined (the default). */
  priority?: (entry: RoutableEntry) => number | undefined
  /** URLs with no entry behind them — hand-written app routes, feeds — appended to the result. */
  extraUrls?: SitemapExtraUrl[]
}

/**
 * Build Next's `MetadataRoute.Sitemap` from CanopyCMS content.
 *
 * **Every routable entry type is included by default.** There is no list of "sitemap-able" entry
 * types to keep in sync, and that is the whole design: a hand-rolled sitemap that enumerates a
 * remembered list of entry types omits whichever type nobody added, ships green, and takes the
 * missing pages out of search results silently. Omitting a URL here requires an explicit
 * `exclude` predicate or a `noindex` flag on the entry.
 *
 * `noindex` entries are excluded, via the same core `isNoindexEntry` predicate that drives
 * `robots: { index: false }` in `entryToMetadata`. They are still BUILT — enumeration
 * (`generateContentStaticParams`) does not filter them, so the page exists for anyone holding
 * the link; it just isn't advertised.
 *
 * `changeFrequency` is not emitted for entries: a blanket value asserted for every URL carries no
 * information, and search engines say they ignore it. Set it per-URL via `extraUrls` if you want it.
 *
 * Output is stably ordered ('/' first, then alphabetical) so a rebuild doesn't reshuffle the file.
 *
 * @example
 * // app/sitemap.ts
 * export const dynamic = 'force-static' // required for output: 'export'
 * export default () => contentSitemap({ siteUrl: 'https://example.com', trailingSlash: true })
 */
export async function generateContentSitemap(
  buildCtx: Pick<CanopyBuildContext, 'listEntries'>,
  options: GenerateContentSitemapOptions,
): Promise<MetadataRoute.Sitemap> {
  const { siteUrl, trailingSlash, rootPath, seo, exclude, lastModified, priority } = options
  const urlOpts = { siteUrl, trailingSlash }

  const entries = await collectRoutableEntries(buildCtx, { rootPath })

  const items: SitemapItem[] = []
  for (const entry of entries) {
    if (isNoindexEntry(entry.data, seo)) continue
    if (exclude?.(entry)) continue
    const modified = lastModified ? lastModified(entry) : entry.updatedAt
    const entryPriority = priority?.(entry)
    items.push({
      url: resolveSeoUrl(entry.urlPath, urlOpts),
      ...(modified ? { lastModified: modified } : {}),
      ...(entryPriority === undefined ? {} : { priority: entryPriority }),
    })
  }

  for (const extra of options.extraUrls ?? []) {
    items.push({
      url: resolveSeoUrl(extra.path, urlOpts),
      ...(extra.lastModified ? { lastModified: extra.lastModified } : {}),
      ...(extra.changeFrequency ? { changeFrequency: extra.changeFrequency } : {}),
      ...(extra.priority === undefined ? {} : { priority: extra.priority }),
    })
  }

  const root = resolveSeoUrl('/', urlOpts)
  return items.sort((a, b) =>
    a.url === root ? -1 : b.url === root ? 1 : a.url.localeCompare(b.url),
  )
}

// ---------------------------------------------------------------------------
// Per-entry metadata
// ---------------------------------------------------------------------------

export interface EntryToMetadataOptions extends ExtractSeoFieldsOptions {
  /** Route path for this entry — the canonical URL when the entry sets none. */
  path?: string
  /**
   * Site origin for resolving relative canonical / OG image URLs. Omit to leave them relative and
   * let Next's `metadataBase` resolve them.
   */
  siteUrl?: string
  /** Emit site-relative URLs with a trailing slash. Match your sitemap and your routing config. */
  trailingSlash?: boolean
  /** Site name (openGraph.siteName, and the social-card title fallback). */
  siteName?: string
  /** Root-layout mode: emit `title: { template, default }` (e.g. `'%s | Example'`). */
  titleTemplate?: string
  /** og:type when the entry sets none. Defaults to 'website'. */
  defaultOgType?: SeoOgType
}

/**
 * Map an entry's SEO fields onto a Next `Metadata` object.
 *
 * Title and description follow ONE convention everywhere: the entry's meta field, else the
 * fallback you pass, else unset (so the root layout's default applies). An empty CMS field counts
 * as unset — see `extractSeoFields`.
 *
 * `noindex` goes through the same core predicate the sitemap uses, so a page marked noindex is
 * suppressed in both surfaces or neither.
 *
 * @example
 * export async function generateMetadata({ params }): Promise<Metadata> {
 *   const { slug } = await params
 *   const result = await readByUrlPath(`/posts/${slug}`)
 *   return entryToMetadata(result?.data, { path: `/posts/${slug}`, fallbackTitle: result?.data.title })
 * }
 */
export function entryToMetadata(entryData: unknown, opts: EntryToMetadataOptions = {}): Metadata {
  const seo = extractSeoFields(entryData, opts)
  const urlOpts = { siteUrl: opts.siteUrl, trailingSlash: opts.trailingSlash }
  // The entry's own canonical wins over the route path; an absolute one passes through verbatim
  // (see resolveSeoUrl — the absolute check runs before any normalization, which is a fixed bug).
  const canonicalSource = seo.canonical ?? opts.path
  const canonical = canonicalSource ? resolveSeoUrl(canonicalSource, urlOpts) : undefined
  // Images are files, never directory-style URLs: never append a trailing slash to one.
  const ogImage = seo.ogImage ? resolveSeoUrl(seo.ogImage, { siteUrl: opts.siteUrl }) : undefined
  // og:title falls back to the site name so a page that inherits the layout title still emits a
  // usable card — Next REPLACES `openGraph` wholesale rather than deep-merging it.
  const socialTitle = seo.title ?? opts.siteName
  const ogType = seo.ogType ?? opts.defaultOgType ?? 'website'

  const openGraphBase = {
    ...(socialTitle ? { title: socialTitle } : {}),
    ...(seo.description ? { description: seo.description } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(opts.siteName ? { siteName: opts.siteName } : {}),
    ...(ogImage ? { images: [{ url: ogImage }] } : {}),
  }

  const metadata: Metadata = {
    ...(canonical ? { alternates: { canonical } } : {}),
    // Spelled out per branch rather than cast: Next's OpenGraph metadata is a discriminated
    // union on `type`.
    openGraph:
      ogType === 'article'
        ? { ...openGraphBase, type: 'article' }
        : ogType === 'profile'
          ? { ...openGraphBase, type: 'profile' }
          : { ...openGraphBase, type: 'website' },
    twitter: {
      card: seo.twitterCard ?? 'summary_large_image',
      ...(socialTitle ? { title: socialTitle } : {}),
      ...(seo.description ? { description: seo.description } : {}),
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  }

  if (opts.titleTemplate) {
    metadata.title = { template: opts.titleTemplate, default: seo.title ?? opts.siteName ?? '' }
  } else if (seo.title) {
    metadata.title = seo.title
  }
  if (seo.description) metadata.description = seo.description
  // Same predicate as the sitemap's exclusion — these two must never be derived separately.
  if (isNoindexEntry(entryData, opts)) metadata.robots = { index: false, follow: false }

  return metadata
}
