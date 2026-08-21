import type { Metadata, MetadataRoute } from 'next'
import {
  collectRoutableEntries,
  collectStaticPaths,
  extractSeoFields,
  isAbsoluteUrl,
  isIndexSlug,
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
   *
   * Note that `shape: 'single'` also SKIPS collection index entries, whose URL is the
   * collection's own path rather than a single slug segment. Render those from the collection's
   * route (e.g. `app/posts/page.tsx`), not from `[slug]`.
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

  // basePath only means something for the catch-all shape: it rewrites `segments` relative to the
  // route's URL prefix, and 'single' shape never reads `segments` (it emits `entry.slug`). Applying
  // the prefix FILTER unconditionally — as this once did — silently dropped every entry outside the
  // prefix for 'single' too, contradicting this option's own doc above ("no effect with shape:
  // 'single'") and meaning unbuilt pages for anyone who set basePath alongside 'single'. Scope with
  // `rootPath` for 'single' instead.
  if (basePath && shape !== 'single') {
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

  if (shape === 'single') {
    // Drop index entries. Their URL is the COLLECTION's path (`/posts`, not `/posts/index`), a
    // shape a single-segment `[slug]` route cannot represent — that page belongs to the
    // collection's own route. Emitting one produced a param whose URL `readByUrlPath` refuses to
    // resolve, so Next prerendered a guaranteed notFound (and an `output: export` build can fail
    // outright). Catch-all is unaffected: it reads the already-collapsed `segments`, which for an
    // index entry are the collection's.
    return entries
      .filter((entry) => !isIndexSlug(entry.slug))
      .map((entry) => ({ [paramName]: entry.slug }))
  }

  return entries.map((entry) => ({ [paramName]: entry.segments }))
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

type SitemapItem = MetadataRoute.Sitemap[number]

/**
 * A URL with no CanopyCMS entry behind it (a hand-written app route, a feed).
 *
 * **An extra URL is entirely hand-managed — it inherits nothing from the entry pipeline.**
 * `generateContentSitemap` applies `isNoindexEntry` and a default `lastModified` only while
 * walking real entries; this list is appended afterwards and passes through both:
 *
 * - **No `noindex` gate.** Nothing checks the SEO flag for an extra URL, because there is no
 *   entry data to check. If you are using `extraUrls` to re-advertise a real entry under a
 *   different path (the usual reason — an entry whose structural `urlPath` no route serves),
 *   you are responsible for not listing it when that entry is marked `noindex`. Marking the
 *   entry does not remove the extra URL.
 * - **No `lastModified` fallback.** The per-entry branch defaults to `entry.updatedAt`; here,
 *   omitting `lastModified` means the URL simply ships without a date.
 *
 * Both are easy to get wrong in exactly the same direction, and both used to be unavoidable:
 * `extraUrls` was once the only way to advertise a real entry at a different URL, so every such
 * use re-derived `noindex` and `lastModified` by hand — this repo's own reference app among them,
 * and it got `lastModified` wrong.
 *
 * It is no longer the only way, so it should no longer be that way:
 *
 * 1. **Model the entry so its natural `urlPath` IS the URL you serve.** An `index` entry collapses
 *    onto its collection's path, and a root `index` entry onto `/`. Nothing to keep in sync. This
 *    is what the reference app does now, which is why its sitemap passes neither option.
 * 2. **Failing that, use `pathFor`** (see `GenerateContentSitemapOptions`), which overrides the
 *    URL while keeping the entry inside the walk — so the `noindex` gate, the `lastModified`
 *    default and `priority` all still apply.
 * 3. **Keep `extraUrls` for what its name says:** URLs with no entry behind them at all.
 */
export interface SitemapExtraUrl {
  /** Site-relative path ('/blog') or an absolute URL. Trailing-slash rules apply to the former. */
  path: string
  /** No fallback: omit this and the URL ships with no date at all (entries default to `updatedAt`). */
  lastModified?: Date | string
  changeFrequency?: SitemapItem['changeFrequency']
  priority?: number
}

export interface GenerateContentSitemapOptions {
  /**
   * Site origin, e.g. `https://example.com`. Required: a sitemap must carry absolute URLs, or
   * search engines reject the whole file. Enforced — `generateContentSitemap` throws if this
   * isn't an absolute URL (no scheme, or empty).
   */
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
  /**
   * Override the URL an entry is advertised at, keeping it INSIDE the entry walk.
   *
   * Return a path to advertise the entry at instead of its structural `urlPath`; return `null`
   * (or `undefined`) to leave it alone.
   *
   * **`null` means "no opinion", not "drop it".** So the obvious shape — handle the one entry
   * type you care about, return `null` for the rest — advertises every other entry at its own
   * path rather than silently emitting a one-URL sitemap. Dropping an entry stays `exclude`'s
   * job, and keeping the two separate is the whole reason for this choice: a `pathFor` whose
   * natural-looking callback silently omitted everything else would re-introduce exactly the
   * quietly-short sitemap this module exists to prevent.
   *
   * This is the principled alternative to reaching for `extraUrls` to reroute a REAL entry.
   * Because the entry stays in the walk, it keeps the `isNoindexEntry` gate, the `updatedAt`
   * `lastModified` default and its `priority` automatically — all three of which an `extraUrls`
   * entry makes you re-derive by hand, and get wrong independently (see {@link SitemapExtraUrl}).
   *
   * **It changes what is ADVERTISED, not what is BUILT.** `generateContentStaticParams` still
   * enumerates the entry at its structural path, so the URL returned here must be one your app
   * actually routes — otherwise you have advertised a 404, the same hazard `extraUrls` carries.
   *
   * Reach for it only when the URL is fixed by something OUTSIDE the content tree: published URLs
   * you cannot change, or a route prefix that deliberately differs from the content layout. When
   * you control the modelling, model the entry so its natural `urlPath` is already the URL you
   * serve — an `index` entry collapses onto its collection's path, and a root `index` entry onto
   * `/` — which needs no option at all. That ordering is not advice we only give: it is what the
   * reference app in this repo does, which is why its sitemap passes neither this nor `extraUrls`.
   *
   * Runs AFTER the `noindex` and `exclude` gates (a dropped entry needs no URL). `exclude`,
   * `lastModified` and `priority` receive the entry as ENUMERATED, so `entry.urlPath` there is
   * always the structural path and never your override — branch on the entry, not on the URL.
   *
   * Two entries rewritten onto one URL are NOT caught by the build's `assertNoDuplicateUrlPaths`
   * guard, which runs on the raw listing and never sees these rewrites; `dedupeSitemapItems`
   * warns and keeps the first.
   *
   * @example
   * // Content lives under content/articles/*, but this site has always published /blog/*.
   * pathFor: (entry) =>
   *   entry.entryType === 'article' ? entry.urlPath.replace(/^\/articles\//, '/blog/') : null,
   */
  pathFor?: (entry: RoutableEntry) => string | null | undefined
  /**
   * URLs with NO entry behind them — hand-written app routes, feeds — appended to the result.
   *
   * Appended after the entry walk, so these bypass BOTH the `isNoindexEntry` gate and the
   * `lastModified` default. To point a REAL entry at a different URL, use `pathFor` above, which
   * keeps both. See {@link SitemapExtraUrl}.
   */
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
  const { siteUrl, trailingSlash, rootPath, seo, exclude, lastModified, priority, pathFor } =
    options

  // A sitemap with a non-absolute <loc> is invalid — search engines reject the WHOLE file, not
  // just the bad entry, and the build stays green because nothing here threw. 'example.com' (no
  // scheme) and '' both pass through resolveSeoUrl unmodified today; catch them here instead.
  if (!isAbsoluteUrl(siteUrl)) {
    throw new Error(
      `CanopyCMS: generateContentSitemap requires an absolute siteUrl (e.g. "https://example.com"), ` +
        `got ${JSON.stringify(siteUrl)}. A sitemap whose <loc> values aren't absolute URLs is invalid ` +
        'and search engines silently reject the entire file.',
    )
  }

  const urlOpts = { siteUrl, trailingSlash }

  const entries = await collectRoutableEntries(buildCtx, { rootPath })

  const items: SitemapItem[] = []
  for (const entry of entries) {
    if (isNoindexEntry(entry.data, seo)) continue
    if (exclude?.(entry)) continue
    const modified = lastModified ? lastModified(entry) : entry.updatedAt
    const entryPriority = priority?.(entry)
    items.push({
      url: resolveSeoUrl(resolveEntrySitemapPath(entry, pathFor), urlOpts),
      ...(modified ? { lastModified: modified } : {}),
      ...(entryPriority === undefined ? {} : { priority: entryPriority }),
    })
  }

  // Deliberately outside the entry loop above, and therefore outside its `isNoindexEntry` gate
  // and its `entry.updatedAt` fallback — an extra URL has no entry to derive either from. This is
  // the behaviour documented on SitemapExtraUrl; if that ever changes, change the doc with it.
  for (const extra of options.extraUrls ?? []) {
    items.push({
      url: resolveSeoUrl(extra.path, urlOpts),
      ...(extra.lastModified ? { lastModified: extra.lastModified } : {}),
      ...(extra.changeFrequency ? { changeFrequency: extra.changeFrequency } : {}),
      ...(extra.priority === undefined ? {} : { priority: extra.priority }),
    })
  }

  const root = resolveSeoUrl('/', urlOpts)
  return dedupeSitemapItems(items).sort((a, b) =>
    a.url === root ? -1 : b.url === root ? 1 : a.url.localeCompare(b.url),
  )
}

/**
 * Resolve the path an entry is advertised at, applying the caller's `pathFor` override.
 *
 * `null`/`undefined` mean "no opinion" and keep the entry's own `urlPath` — see the `pathFor`
 * doc for why that is not "drop it".
 *
 * An empty (or whitespace-only) string THROWS rather than being treated as either. It cannot be
 * honoured: `resolveSeoUrl('')` resolves to the site root, so an empty return would quietly
 * advertise this entry at `/` and collide with whatever really lives there — a wrong sitemap
 * that ships green, which is the failure mode every other guard in this file exists to convert
 * into a red build.
 */
function resolveEntrySitemapPath(
  entry: RoutableEntry,
  pathFor: GenerateContentSitemapOptions['pathFor'],
): string {
  if (!pathFor) return entry.urlPath
  const override = pathFor(entry)
  if (override === null || override === undefined) return entry.urlPath
  if (override.trim() === '') {
    throw new Error(
      `CanopyCMS: generateContentSitemap's pathFor returned an empty path for the ` +
        `${JSON.stringify(entry.entryType)} entry at ${JSON.stringify(entry.urlPath)}. An empty ` +
        'path resolves to the site root, so honouring it would advertise this entry at "/" and ' +
        "collide with whatever really lives there. Return null to keep the entry's own urlPath.",
    )
  }
  return override
}

/**
 * Drop duplicate `<loc>` entries, keeping the first occurrence and warning about each collision.
 *
 * A duplicate URL isn't fatal to a crawler, but it usually means two URLs are unintentionally
 * sharing one `<loc>` — an index entry collapsing onto a sibling's path, two `urlPath`s that only
 * differ by case (`urlPath` is lowercased — see `content-listing.ts`), an `extraUrls` path
 * repeating an entry's URL, or a `pathFor` that rewrote two entries onto the same path. Warning
 * rather than silently deduping turns that into a build-time signal an adopter can act on instead
 * of a sitemap that just quietly has fewer URLs than expected.
 *
 * Still needed alongside `assertNoDuplicateUrlPaths` (canopycms `static/index.ts`), which fails a
 * production build on the entry-vs-entry case before generation ever reaches here. This covers the
 * three cases that guard cannot: a collision involving an `extraUrls` path, which is supplied here
 * and never appears in the content enumeration; a collision created by `pathFor`, which rewrites
 * URLs after that guard has already run on the raw listing; and any call outside build mode, where
 * that guard is deliberately silent.
 */
function dedupeSitemapItems(items: SitemapItem[]): SitemapItem[] {
  const seen = new Set<string>()
  const result: SitemapItem[] = []
  for (const item of items) {
    if (seen.has(item.url)) {
      console.warn(
        `CanopyCMS: generateContentSitemap found more than one entry resolving to the same sitemap ` +
          `URL ${JSON.stringify(item.url)}. Keeping the first and dropping the rest — this usually means ` +
          'two entries, an entry and an extraUrls path, or a pathFor override are unintentionally ' +
          'sharing one URL.',
      )
      continue
    }
    seen.add(item.url)
    result.push(item)
  }
  return result
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
