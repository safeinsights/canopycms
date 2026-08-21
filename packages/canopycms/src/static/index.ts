import type { CanopyBuildContext } from '../context'
import { isBuildMode } from '../build-mode'
import type { ListEntriesItem } from '../content-listing'
import {
  findUnknownKeys,
  validateEntryData,
  type EntryFieldError,
} from '../validation/entry-validator'
import { findBodyFieldName } from '../utils/body-field'
import { isDataOnlyFormat } from '../utils/format'

/**
 * Framework-agnostic helpers for static-site generation. These produce neutral data structures
 * (no Next.js types) so that any framework adapter — e.g. canopycms-next — can map them to its own
 * static-generation shapes (generateStaticParams, sitemap, metadata).
 *
 * - `collectStaticPaths` — routable paths only, for `generateStaticParams`.
 * - `collectRoutableEntries` — the same enumeration with each entry's `data` and `updatedAt`
 *   carried through, for surfaces that must inspect content (sitemap, feeds, search index).
 * - `./seo` — `extractSeoFields` / `isNoindexEntry` / URL shaping, re-exported below.
 */

export {
  DEFAULT_SEO_FIELD_NAMES,
  extractSeoFields,
  isNoindexEntry,
  isAbsoluteUrl,
  withTrailingSlash,
  resolveSeoUrl,
  stripTrailingSlashes,
  type SeoFields,
  type SeoFieldNames,
  type SeoFieldLocation,
  type SeoOgType,
  type SeoTwitterCard,
  type ExtractSeoFieldsOptions,
  type ResolveSeoUrlOptions,
} from './seo'

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

/**
 * A routable content entry with its content attached — everything `StaticPathEntry` carries,
 * plus the entry `data` and its `updatedAt`.
 *
 * This is what surfaces that must look INSIDE an entry need (sitemap, feeds, index grids),
 * as opposed to `generateStaticParams`, which only needs the path.
 */
export interface RoutableEntry<T = Record<string, unknown>> extends StaticPathEntry {
  /** Raw entry data (frontmatter merged with the body field for md/mdx), as `listEntries` returns it. */
  data: T
  /**
   * Filesystem mtime (ISO 8601) of the entry file.
   *
   * Caveat, and read it before wiring this to a sitemap `<lastmod>`: this is a checkout-time
   * timestamp, not an editorial one. A fresh CI clone (or a fresh branch-clone checkout) resets
   * every file's mtime, so there it says "when this tree was checked out", not "when this content
   * was last edited". Treat it as "changed since the last build" at best.
   */
  updatedAt?: string
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

export interface CollectRoutableEntriesOptions<T = Record<string, unknown>> {
  /**
   * Scope to a collection logical path (e.g. 'content/posts'). Defaults to the whole content root.
   * Skips loading entries outside this scope.
   */
  rootPath?: string
  /** Keep only entries matching this predicate. Runs after `data` is attached, so it can read content. */
  filter?: (entry: RoutableEntry<T>) => boolean
  /**
   * Resolve `reference` fields in each entry's `data`, the way `read()`/`readByUrlPath()` do.
   * Defaults to `false`; see `ListEntriesOptions.resolveReferences` in content-listing.ts for
   * the full rationale, cost and caveats.
   *
   * Turn this on for a surface that reads INSIDE an entry and must see referenced content —
   * a search index over pages built from shared/referenced blocks is the case this exists
   * for, since those blocks are otherwise indexed as an id string with no text in them.
   * A sitemap needs `urlPath`/`updatedAt`/`noindex` only, so leave it off there.
   *
   * Not offered on `collectStaticPaths`, which discards `data` entirely — resolving
   * references only to throw them away would be pure cost.
   */
  resolveReferences?: boolean
}

/**
 * Shared enumeration behind `collectStaticPaths` and `collectRoutableEntries`.
 *
 * `phaseLabel` only names the phase in the build-guard error, but it is threaded through rather
 * than fixed so the message points at the surface that actually failed.
 */
async function enumerateRoutableEntries<T>(
  ctx: Pick<CanopyBuildContext, 'listEntries'>,
  rootPath: string | undefined,
  phaseLabel: string,
  resolveReferences?: boolean,
): Promise<RoutableEntry<T>[]> {
  const entries = await ctx.listEntries<T>({ rootPath, resolveReferences })
  // Build-time only: `next dev` runs generateStaticParams against the live working tree, where
  // fresh create-scaffolds legitimately exist mid-edit. Only fail the actual production build —
  // an abandoned schema-invalid scaffold shipping into a static build silently drops that page's
  // route (or worse, renders broken), which is worse than a red build.
  //
  // The unknown-key warning runs BEFORE both throwing guards, so a build about to go red still
  // prints everything it found rather than dying on the first problem.
  //
  // All three run on the RAW listing, before the caller's `filter` — a filtered-out entry still
  // occupies its URL as far as every other route is concerned. `rootPath` scoping does narrow
  // them, since that happens inside `listEntries`; that is the intended escape hatch, `filter`
  // is not.
  //
  // Schema validity is asserted before duplicate URLs deliberately: a schema-invalid entry is
  // the more fundamental problem, and an adopter fixing it may remove the duplicate on the way.
  if (isBuildMode()) {
    warnUnknownEntryKeys(entries, phaseLabel)
    assertBuildEntriesValid(entries, phaseLabel)
    assertNoDuplicateUrlPaths(entries, phaseLabel)
  }
  return entries.map((entry) => ({
    urlPath: entry.urlPath,
    segments: entry.urlPath === '/' ? [] : entry.urlPath.replace(/^\//, '').split('/'),
    slug: entry.slug,
    entryType: entry.entryType,
    data: entry.data,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  }))
}

/**
 * Enumerate routable content entries WITH their data — the input to any surface that must read
 * inside an entry to decide what to publish (sitemap, RSS, search index, index grids).
 *
 * Identical enumeration to `collectStaticPaths` (same single `listEntries` pass, same build-time
 * schema-validity guard); it simply keeps `data` and `updatedAt` instead of discarding them, and
 * can additionally opt into `reference` resolution, which a path-only enumeration has no use for.
 *
 * **Enumerates every entry type by default.** There is no allow-list of "publishable" types, and
 * that is deliberate: a sitemap built from a hand-maintained list of entry types silently omits
 * whichever type nobody remembered to add, and nothing fails. Narrow the result with `filter`
 * when you actually mean to — omission should be a decision, not an oversight.
 *
 * `noindex` is NOT applied here: an entry that must not be advertised must still be built. Apply
 * `isNoindexEntry` at the advertising surface (as `generateContentSitemap` does).
 *
 * @example
 * const entries = await collectRoutableEntries(await getCanopyForBuild())
 * const published = entries.filter((e) => !isNoindexEntry(e.data))
 */
export async function collectRoutableEntries<T = Record<string, unknown>>(
  ctx: Pick<CanopyBuildContext, 'listEntries'>,
  options: CollectRoutableEntriesOptions<T> = {},
): Promise<RoutableEntry<T>[]> {
  const entries = await enumerateRoutableEntries<T>(
    ctx,
    options.rootPath,
    'routable entry enumeration',
    options.resolveReferences,
  )
  return options.filter ? entries.filter(options.filter) : entries
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
  const entries = await enumerateRoutableEntries(ctx, options.rootPath, 'static path enumeration')
  // Drop data/updatedAt: generateStaticParams needs paths only, and returning entry content from
  // a path-enumeration helper invites page code to read content from the admin build context.
  const mapped: StaticPathEntry[] = entries.map(({ urlPath, segments, slug, entryType }) => ({
    urlPath,
    segments,
    slug,
    entryType,
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
 * What the build-time validity scan needs off a listing item. `data` is `unknown` rather than
 * `ListEntriesItem['data']` so a caller that listed with an entry-shape generic (e.g.
 * `collectRoutableEntries<PostContent>`) can still be scanned — the scan re-guards the value
 * anyway, since on-disk data is never trusted.
 */
type BuildScanItem = Pick<ListEntriesItem, 'entryPath' | 'schema'> & {
  data: unknown
  /**
   * Only the unknown-key scan reads this, to recognise the md/mdx body key that `listEntries`
   * merges into `data`. Optional so a caller assembling items by hand still typechecks; an
   * absent format is treated as markdown-shaped, which errs toward under-reporting.
   */
  format?: ListEntriesItem['format']
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
export function findInvalidEntries(items: readonly BuildScanItem[]): InvalidBuildEntry[] {
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
 * How many offending entries `warnUnknownEntryKeys` lists before summarising the rest. Bounds CI
 * output for a schema-wide rename across a large content tree; the reported COUNT is never capped.
 */
const UNKNOWN_KEY_REPORT_LIMIT = 20

/** An entry carrying data keys the schema no longer defines. */
export interface EntryWithUnknownKeys {
  entryPath: string
  /** Canonical field paths, e.g. `author.nickname` or `blocks[2].headline`. */
  fieldPaths: string[]
}

/**
 * Scan listEntries-shaped items for data keys with no schema counterpart.
 *
 * The inverse of `findInvalidEntries`, and non-fatal by design: an unknown key is stale data,
 * not broken data. A build must not go red for it — the page still renders, it is just quietly
 * missing whatever the renamed field used to supply. `warnUnknownEntryKeys` is the reporting
 * half. Both sit at module scope alongside `findInvalidEntries`/`assertBuildEntriesValid` and
 * are deliberately NOT on `canopycms/server`, matching those two — the build wires them itself.
 *
 * Skips items with no resolved schema, and items whose schema is empty — "no schema" is not
 * "every key is unknown". Same `normalizeDatesDeep` pass as the validity scan, so a hand-authored
 * `date: 2024-01-15` is a plain value here too.
 */
export function findEntriesWithUnknownKeys(
  items: readonly BuildScanItem[],
): EntryWithUnknownKeys[] {
  const found: EntryWithUnknownKeys[] = []
  for (const item of items) {
    if (!item.schema || item.schema.length === 0) continue
    const data = normalizeDatesDeep(item.data) as Record<string, unknown>
    // For md/mdx, `listEntries` merges the file's body into `data` under
    // `findBodyFieldName(schema)` (readEntryData in content-listing.ts). When the schema declares
    // an `isBody` field that name IS a schema field and this is a no-op -- but declaring one is
    // optional, and with none the merge key falls back to the literal 'body', which the schema
    // legitimately does not define. Without this the scan told every adopter whose md entry types
    // omit `isBody` that their prose was a stale key to delete.
    const bodyKey = isDataOnlyFormat(item.format ?? 'md')
      ? undefined
      : findBodyFieldName(item.schema)
    const fieldPaths = findUnknownKeys(item.schema, data).filter((path) => path !== bodyKey)
    if (fieldPaths.length > 0) {
      found.push({ entryPath: item.entryPath, fieldPaths })
    }
  }
  return found
}

/**
 * Warn — never throw — about entries carrying keys the schema no longer defines.
 *
 * A production build is the one place that sees every entry at once, which makes it the only
 * place a schema reshape's leftovers show up as a list rather than one mysteriously undefined
 * value at a time.
 */
export function warnUnknownEntryKeys(items: readonly BuildScanItem[], phaseLabel: string): void {
  const found = findEntriesWithUnknownKeys(items)
  if (found.length === 0) return

  // Capped, unlike the sibling assert. That one throws, so it prints once and the build stops;
  // this one returns, and a Next build runs the enumeration several times (every catch-all route
  // plus the sitemap). A schema-wide rename across a large tree would otherwise bury CI output
  // under the same thousands of lines two or three times over. The count is always exact.
  const shown = found.slice(0, UNKNOWN_KEY_REPORT_LIMIT)
  const lines = shown.map(
    ({ entryPath, fieldPaths }) => `  - ${entryPath} — ${fieldPaths.join(', ')}`,
  )
  if (found.length > shown.length) {
    lines.push(`  …and ${found.length - shown.length} more`)
  }

  console.warn(
    `CanopyCMS static build: ${found.length} ${found.length === 1 ? 'entry has' : 'entries have'} content keys not defined in their schema during ${phaseLabel}:\n${lines.join('\n')}\n` +
      `These are usually left over from a renamed or reshaped field. Nothing reads them, and they are kept in the file on every save. ` +
      `Add them to the schema or remove them from the content.`,
  )
}

/**
 * Throw a single, descriptive Error if any item is schema-invalid.
 *
 * Fails the build rather than silently skipping the offending entry: a page that silently
 * disappears from a static build is a worse failure mode than a red build. Lists every
 * offending entry so one build catches every abandoned scaffold, not just the first.
 */
export function assertBuildEntriesValid(items: readonly BuildScanItem[], phaseLabel: string): void {
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

// ---------------------------------------------------------------------------
// Build-time duplicate-URL guard
// ---------------------------------------------------------------------------

/**
 * One URL claimed by more than one entry.
 */
export interface DuplicateUrlPath {
  /** The contested URL path, exactly as `listEntries` computed it. */
  urlPath: string
  /** Logical paths of every entry claiming it, sorted. Always length >= 2. */
  entryPaths: string[]
}

/** What the duplicate-URL scan needs off a listing item. */
type UrlScanItem = Pick<ListEntriesItem, 'entryPath' | 'urlPath'>

/**
 * Find every `urlPath` claimed by two or more entries.
 *
 * `listEntries` assigns each entry exactly one `urlPath` and documents it as round-trip safe with
 * `readByUrlPath`. That guarantee is per-entry, not per-URL: nothing stops two DIFFERENT entries
 * computing the same one, and when they do exactly one of them is reachable while the other
 * silently has no route at all. The known ways to get there:
 *
 * - An entry whose slug matches a sibling collection that also has an `index` entry — the index
 *   collapses onto the collection's path, which is the entry's path too. (An entry beside a
 *   sibling collection with NO index entry is a different, legitimate shape: a landing page plus
 *   a folder of children, nothing contested.)
 * - Two entries whose slugs differ only by case, since `urlPath` is lowercased.
 * - Two entries with the same slug in one collection. The write boundary already refuses this
 *   (`ContentStore.buildPaths` resolves by slug across entry types, and the create-intent guard
 *   turns a hit into a conflict), but content also arrives by merge, by PR, and by adopters
 *   retrofitting an existing repo — none of which pass through that boundary.
 *
 * Exported so adopters can assert on it directly instead of hand-rolling a content-integrity
 * test; `assertNoDuplicateUrlPaths` is what the build itself uses.
 *
 * Pure. Results are sorted by `urlPath`, with each `entryPaths` sorted too, so messages are
 * stable across runs (`listEntries` resolves collections in parallel, so its own order is not).
 */
export function findDuplicateUrlPaths(items: readonly UrlScanItem[]): DuplicateUrlPath[] {
  const byUrl = new Map<string, string[]>()
  for (const item of items) {
    const existing = byUrl.get(item.urlPath)
    if (existing) existing.push(item.entryPath)
    else byUrl.set(item.urlPath, [item.entryPath])
  }

  const duplicates: DuplicateUrlPath[] = []
  for (const [urlPath, entryPaths] of byUrl) {
    if (entryPaths.length > 1) {
      duplicates.push({ urlPath, entryPaths: [...entryPaths].sort() })
    }
  }
  return duplicates.sort((a, b) => a.urlPath.localeCompare(b.urlPath))
}

/**
 * Throw a single, descriptive Error if any URL is claimed by more than one entry.
 *
 * Fails the build for the same reason its sibling `assertBuildEntriesValid` does: a page that
 * silently disappears from a static build is a worse failure mode than a red build, and that is
 * precisely what a contested URL produces — `generateStaticParams` emits the path once, one entry
 * renders, and the other never appears anywhere with no error to notice.
 *
 * Related but not redundant: `canopycms-next`'s `dedupeSitemapItems` warns on the same collision
 * at the sitemap. It stays, because it also covers entry-vs-`extraUrls` collisions (adopter-supplied
 * paths this content enumeration never sees) and non-build-mode calls, where this guard is silent.
 */
export function assertNoDuplicateUrlPaths(items: readonly UrlScanItem[], phaseLabel: string): void {
  const duplicates = findDuplicateUrlPaths(items)
  if (duplicates.length === 0) return

  const lines = duplicates.map(
    ({ urlPath, entryPaths }) => `  - ${urlPath} — claimed by ${entryPaths.join(', ')}`,
  )

  throw new Error(
    `CanopyCMS static build: found ${duplicates.length} ${duplicates.length === 1 ? 'URL' : 'URLs'} claimed by more than one entry during ${phaseLabel}:\n${lines.join('\n')}\n` +
      'Only one entry can be served at each URL, so the rest have no route at all. This usually means ' +
      "an entry whose slug matches a sibling collection that also has an 'index' entry (the index " +
      "collapses onto the collection's path), or two slugs differing only by case (URL paths are " +
      'lowercased). Rename or remove one of the colliding entries, then rebuild.',
  )
}
