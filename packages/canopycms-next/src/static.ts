import {
  collectStaticPaths,
  type CanopyBuildContext,
  type CollectStaticPathsOptions,
} from 'canopycms/server'

/**
 * Next.js static-export helpers built on the framework-agnostic core in `canopycms/server`.
 *
 * Today this ships static-params generation. Sitemap and SEO-metadata helpers are tracked as
 * follow-up work (see .claude/future-tasks/static-export-sitemap.md and
 * .claude/future-tasks/static-export-seo-metadata.md).
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
