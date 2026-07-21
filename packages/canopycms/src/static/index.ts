import type { CanopyBuildContext } from '../context'
import { isBuildMode } from '../build-mode'
import type { ListEntriesItem } from '../content-listing'
import { validateEntryData, type EntryFieldError } from '../validation/entry-validator'

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
  // Build-time only: `next dev` runs generateStaticParams against the live working tree, where
  // fresh create-scaffolds legitimately exist mid-edit. Only fail the actual production build —
  // an abandoned schema-invalid scaffold shipping into a static build silently drops that page's
  // route (or worse, renders broken), which is worse than a red build.
  if (isBuildMode()) assertBuildEntriesValid(entries, 'static path enumeration')
  const mapped: StaticPathEntry[] = entries.map((entry) => ({
    urlPath: entry.urlPath,
    segments: entry.urlPath === '/' ? [] : entry.urlPath.replace(/^\//, '').split('/'),
    slug: entry.slug,
    entryType: entry.entryType,
  }))
  return options.filter ? mapped.filter(options.filter) : mapped
}

// ---------------------------------------------------------------------------
// Build-time schema validity guard
// ---------------------------------------------------------------------------

/**
 * One schema-invalid entry found during a build-time content scan.
 */
export interface InvalidBuildEntry {
  entryPath: string
  errors: EntryFieldError[]
}

/**
 * Deep-walk a plain data value (objects and arrays only — the shapes YAML/JSON parsing can
 * produce), converting every `Date` instance to its ISO string.
 *
 * gray-matter parses unquoted YAML dates in hand-authored frontmatter (`date: 2024-01-15`) into
 * JS `Date` objects rather than strings. The shared validator's datetime check requires a string
 * (see `validateScalar` in entry-validator.ts), so a legitimate hand-authored or migrated entry
 * would otherwise fail this build guard. CMS-authored entries round-trip as quoted strings, so
 * this only affects pre-existing content — which is the primary path for adopters retrofitting
 * CanopyCMS onto an existing repo.
 *
 * Normalization lives here, in the guard, rather than in the shared validator: the editor/server
 * save boundary always receives JSON-shaped payloads over HTTP and can never see a `Date` there —
 * only this build-time read of on-disk YAML/frontmatter can produce one. The shared validator
 * stays strict.
 *
 * No cycle guard: this only ever walks data parsed fresh from YAML/JSON/frontmatter on disk,
 * which cannot contain circular references.
 */
function normalizeDatesDeep(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeDatesDeep)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeDatesDeep(v)
    }
    return result
  }
  return value
}

/**
 * Scan listEntries-shaped items for schema-invalid entries.
 *
 * Runs `validateEntryData` — the same pure validation used at the server write boundary
 * (api/content.ts) for on-disk-shaped data — against each item's raw data. listEntries already
 * merges an md/mdx body into `data` under the schema's `isBody` field name (see `readEntryData`
 * in content-listing.ts), so no FormValue-style remapping is needed or correct here. This is how
 * an abandoned create-scaffold — an empty entry the editor's create flow writes before the user
 * fills it in (skipped from validation there via `isCreateScaffold`) — gets caught before it
 * ships in a static build, since nothing else re-validates it once it's on disk.
 *
 * Items whose `schema` couldn't be resolved (unknown entry type) are skipped here — that's a
 * different failure class, handled elsewhere.
 */
export function findInvalidEntries(
  items: readonly Pick<ListEntriesItem, 'entryPath' | 'schema' | 'data'>[],
): InvalidBuildEntry[] {
  const invalid: InvalidBuildEntry[] = []
  for (const item of items) {
    if (!item.schema) continue
    const data = normalizeDatesDeep(item.data) as Record<string, unknown>
    const errors = validateEntryData(item.schema, data)
    if (errors.length > 0) {
      invalid.push({ entryPath: item.entryPath, errors })
    }
  }
  return invalid
}

/**
 * Throw a single, descriptive Error if any item is schema-invalid.
 *
 * Fails the build rather than silently skipping the offending entry: a page that silently
 * disappears from a static build is a worse failure mode than a red build. Lists every
 * offending entry so one build catches every abandoned scaffold, not just the first.
 */
export function assertBuildEntriesValid(
  items: readonly Pick<ListEntriesItem, 'entryPath' | 'schema' | 'data'>[],
  phaseLabel: string,
): void {
  const invalid = findInvalidEntries(items)
  if (invalid.length === 0) return

  const lines = invalid.map(({ entryPath, errors }) => {
    const [first, ...rest] = errors
    const summary =
      rest.length > 0
        ? `${first.fieldPath}: ${first.message} (+${rest.length} more)`
        : `${first.fieldPath}: ${first.message}`
    return `  - ${entryPath} — ${summary}`
  })

  throw new Error(
    `CanopyCMS static build: found ${invalid.length} schema-invalid ${invalid.length === 1 ? 'entry' : 'entries'} during ${phaseLabel}:\n${lines.join('\n')}\n` +
      `These are likely abandoned create-scaffolds (empty entries left behind when a create was started but never finished). ` +
      `Finish editing the entry (fill in its required fields) or delete the abandoned draft, then rebuild.`,
  )
}
