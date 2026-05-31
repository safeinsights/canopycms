import {
  collectStaticPaths,
  type CanopyBuildContext,
  type CollectStaticPathsOptions,
} from 'canopycms/server'

/**
 * Next.js static-export helpers built on the framework-agnostic core in `canopycms/server`.
 *
 * Today this ships `generateContentStaticParams`. Sitemap and SEO-metadata helpers are tracked as
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
}

/**
 * Build the array Next's `generateStaticParams` expects from CanopyCMS content.
 *
 * Reads filesystem-direct via the build context (admin, build-time only). For a catch-all route it
 * emits `{ [paramName]: segments }`; for a single-segment route it emits `{ [paramName]: slug }`.
 *
 * Note: a root index ('/') yields empty `segments` — keep it only for an optional catch-all
 * `[[...slug]]`, otherwise exclude it via `options.filter` (e.g. `(e) => e.segments.length > 0`).
 *
 * @example
 * // app/[...slug]/page.tsx
 * export const generateStaticParams = () => generateContentStaticParams(getCanopyForBuild)
 *
 * // app/posts/[slug]/page.tsx
 * export const generateStaticParams = () =>
 *   generateContentStaticParams(getCanopyForBuild, { rootPath: 'content/posts', shape: 'single' })
 */
export async function generateContentStaticParams(
  getCanopyForBuild: () => Promise<CanopyBuildContext>,
  options: GenerateContentStaticParamsOptions = {},
): Promise<Array<Record<string, string | string[]>>> {
  const { paramName = 'slug', shape = 'catch-all', ...collectOptions } = options
  const ctx = await getCanopyForBuild()
  const entries = await collectStaticPaths(ctx, collectOptions)
  return entries.map((entry) =>
    shape === 'single' ? { [paramName]: entry.slug } : { [paramName]: entry.segments },
  )
}
