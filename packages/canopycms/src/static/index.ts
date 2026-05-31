import type { CanopyBuildContext } from '../context'

/**
 * Framework-agnostic helpers for static-site generation. These produce neutral data structures
 * (no Next.js types) so that any framework adapter — e.g. canopycms-next — can map them to its own
 * static-generation shapes (generateStaticParams, sitemap, metadata).
 *
 * Sitemap (`collectPublishedEntries`) and SEO metadata (`extractSeoFields`) helpers are tracked as
 * follow-up work; see .claude/future-tasks/static-export-sitemap.md and
 * .claude/future-tasks/static-export-seo-metadata.md.
 */

/** A routable content entry, reduced to what static path generation needs. */
export interface StaticPathEntry {
  /**
   * URL-ready path with index entries collapsed, e.g. '/posts/hello-world', or '/' for a root index.
   * Round-trips with readByUrlPath.
   */
  urlPath: string
  /**
   * URL segments with index collapsed, e.g. ['posts', 'hello-world']. Empty for a root index ('/').
   * Use these for a catch-all `[...slug]` route.
   */
  segments: string[]
  /** Entry slug within its collection — use for a single-segment `[slug]` route scoped to a collection. */
  slug: string
  /** Entry type name (e.g. 'post', 'doc'). */
  entryType: string
}

export interface CollectStaticPathsOptions {
  /**
   * Scope to a collection logical path (e.g. 'content/posts'). Defaults to the whole content root.
   * Skips loading entries outside this scope.
   */
  rootPath?: string
  /** Keep only entries matching this predicate (e.g. drop the root index, or filter by entryType). */
  filter?: (entry: StaticPathEntry) => boolean
}

/**
 * Enumerate routable content entries as neutral path descriptors for static generation.
 *
 * Reads filesystem-direct via the build context's `listEntries` (admin, no ACLs — build-time only).
 * The returned entries carry both a collapsed `segments` array (for catch-all routes) and the entry
 * `slug` (for collection-scoped single-segment routes), so a framework adapter can build either shape.
 *
 * @example
 * // Catch-all [...slug] across all content:
 * const paths = await collectStaticPaths(await getCanopyForBuild())
 * // Single [slug] scoped to one collection:
 * const posts = await collectStaticPaths(await getCanopyForBuild(), { rootPath: 'content/posts' })
 */
export async function collectStaticPaths(
  ctx: Pick<CanopyBuildContext, 'listEntries'>,
  options: CollectStaticPathsOptions = {},
): Promise<StaticPathEntry[]> {
  const entries = await ctx.listEntries({ rootPath: options.rootPath })
  const mapped: StaticPathEntry[] = entries.map((entry) => ({
    urlPath: entry.urlPath,
    segments: entry.urlPath === '/' ? [] : entry.urlPath.replace(/^\//, '').split('/'),
    slug: entry.slug,
    entryType: entry.entryType,
  }))
  return options.filter ? mapped.filter(options.filter) : mapped
}
