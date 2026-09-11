/**
 * The one-URL-per-entry invariant, as a reusable probe + report.
 *
 * `listEntries` assigns every entry exactly one `urlPath` and documents the round trip through
 * `readByUrlPath` as safe. The reverse direction has repeatedly been the looser of the two: it
 * has answered at URLs no forward surface emits, and those extra URLs were found one at a time,
 * a release apart, by adopters (see
 * `.claude/future-tasks/resolved/url-resolver-index-entry-extra-url.md`, then
 * `resolved/readbyurlpath-entry-type-candidate-phantom-url.md`). This module exists so the whole
 * invariant is asserted at once instead: enumerate, then probe every ADJACENT URL the resolver
 * would try and require it to be a miss.
 *
 * Deliberately free of `vitest` -- this is a plain `src` module in the shape of
 * `operating-mode/deployment-name-fixtures.ts`, so more than one test file can import it without
 * dragging that file's `vi.mock` calls and `describe` blocks along. It therefore ASSERTS NOTHING:
 * it returns a report and the caller does the expecting, which also puts the offending URLs in
 * the assertion message rather than behind a boolean.
 *
 * Scope of the invariant it checks: entries written in the `{type}.{slug}.{id}.{ext}` grammar
 * with a type their collection declares -- i.e. exactly the set `listEntries` can see. A legacy
 * untyped file (`overview.json`) is invisible to enumeration and is deliberately NOT probed here;
 * see `.claude/future-tasks/legacy-untyped-files-url-addressable.md`.
 */

import { flattenSchema, type RootCollectionConfig } from './config'
import type { ListEntriesItem } from './content-listing'
import type { CanopyContext } from './context'
import { findDuplicateUrlPaths, type DuplicateUrlPath } from './static'
import { computeEntryUrl } from './utils/entry-url'

/** Append raw segments to a URL base, without normalizing their case (see buildProbeUrls). */
const joinUrl = (base: string, ...segments: string[]): string =>
  (base === '/' ? '' : base) + segments.map((s) => `/${s}`).join('')

/**
 * Every URL adjacent to the published set that the resolver would actually attempt.
 *
 * Three families, each one a shape that HAS resolved at some point in this package's history:
 *
 * 1. `/<collection>/<entryTypeName>` -- `resolveUrlPathCandidates`' index-fallback candidate lands
 *    on a registered entry-TYPE schema item, which `ContentStore.buildPaths` delegates to the
 *    parent collection with slug `index`, resolving that collection's index entry.
 * 2. `/<collection>/<entryTypeName>/<slug>` -- the same delegation reached through the
 *    DIRECT-entry candidate instead, resolving the collection's entry `<slug>`. Wider than family
 *    1: it needs no index entry at all, so it applies to every listed entry.
 * 3. `/<publishedUrl>/index`, and its case variants -- an index entry answering at the literal
 *    spelling its collapsed URL replaced.
 *
 * Entry-type names are appended VERBATIM, after `computeEntryUrl` has lowercased the collection
 * part. That asymmetry is real, not sloppiness: `flattenSchema` puts `entryType.name` into the
 * logical path unchanged and `normalizeFilesystemPath` does not lowercase, so only the declared
 * spelling can reach the entry-type schema item at all. A lowercased probe would miss the schema
 * item, return null for the wrong reason, and pass vacuously.
 */
export const buildProbeUrls = (
  schema: RootCollectionConfig,
  items: readonly ListEntriesItem[],
  contentRoot = 'content',
): string[] => {
  const collections = flattenSchema(schema, contentRoot).filter((i) => i.type === 'collection')
  const probes = new Set<string>()

  for (const collection of collections) {
    const base = computeEntryUrl(collection.logicalPath, '', contentRoot)
    for (const entryType of collection.entries ?? []) {
      // Family 1.
      probes.add(joinUrl(base, entryType.name))
      // Family 2 -- every listed entry of this collection, under every type name the collection
      // declares (not just the entry's OWN type: the directory scan `buildPaths` runs matches on
      // slug alone, so any declared name reaches any entry).
      for (const item of items) {
        if (String(item.collectionPath) !== String(collection.logicalPath)) continue
        probes.add(joinUrl(base, entryType.name, item.slug))
      }
    }
  }

  // Family 3.
  for (const item of items) {
    for (const spelling of ['index', 'Index', 'INDEX']) {
      probes.add(joinUrl(item.urlPath, spelling))
    }
  }

  return [...probes]
}

export interface UrlExclusivityReport {
  /** Every `urlPath` the listing published, sorted. */
  published: string[]
  /** URLs claimed by more than one entry. A precondition failure, not a resolver finding. */
  duplicates: DuplicateUrlPath[]
  /** Published URLs `readByUrlPath` did NOT resolve -- the round trip broken going forward. */
  unresolved: string[]
  /** Published URLs that resolved to some OTHER entry than the one that published them. */
  mismatched: Array<{ urlPath: string; expectedEntryId?: string; actualEntryId?: string }>
  /** Every adjacent URL probed, sorted. */
  probes: string[]
  /** Probes that resolved despite not being published -- the phantom URLs. Must be empty. */
  phantoms: string[]
}

/**
 * Enumerate, round-trip, then probe. See `UrlExclusivityReport` for what each field means and
 * `buildProbeUrls` for which URLs are probed.
 *
 * A probe whose LOWERCASED form is published is skipped rather than asserted on: a collection
 * literally named `index` publishes `/docs/index`, which family 3 also generates, and whether
 * `/docs/Index` should resolve is a separate, pre-existing question about collection-path case
 * sensitivity that this invariant does not speak to.
 */
export const collectUrlExclusivityReport = async (
  ctx: Pick<CanopyContext, 'listEntries' | 'readByUrlPath'>,
  schema: RootCollectionConfig,
  contentRoot = 'content',
): Promise<UrlExclusivityReport> => {
  const items = await ctx.listEntries()

  const unresolved: string[] = []
  const mismatched: UrlExclusivityReport['mismatched'] = []
  for (const item of items) {
    const result = await ctx.readByUrlPath(item.urlPath)
    if (!result) {
      unresolved.push(item.urlPath)
      continue
    }
    if (result.meta.entryId !== item.entryId) {
      mismatched.push({
        urlPath: item.urlPath,
        expectedEntryId: item.entryId,
        actualEntryId: result.meta.entryId,
      })
    }
  }

  const publishedLower = new Set(items.map((i) => i.urlPath.toLowerCase()))
  const probes = buildProbeUrls(schema, items, contentRoot)
  const phantoms: string[] = []
  for (const probe of probes) {
    if (publishedLower.has(probe.toLowerCase())) continue
    if (await ctx.readByUrlPath(probe)) phantoms.push(probe)
  }

  return {
    published: items.map((i) => i.urlPath).sort(),
    duplicates: findDuplicateUrlPaths(items),
    unresolved: unresolved.sort(),
    mismatched,
    probes: [...probes].sort(),
    phantoms: phantoms.sort(),
  }
}
