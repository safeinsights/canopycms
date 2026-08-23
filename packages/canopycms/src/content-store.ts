import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import matter from 'gray-matter'
import { parse as yamlParse } from 'yaml'
import { atomicWriteFile } from './utils/atomic-write'
import { serializeFrontmatter, serializeYaml } from './utils/content-serialize'
import { withLock } from './utils/async-mutex'
import {
  ContentWriteLockBusyError,
  DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS,
  withContentWriteLock,
} from './utils/content-write-lock'
import { findBodyFieldName } from './utils/body-field'
import { buildResolvedReference } from './entry-schema'
import { computeEntryUrl } from './utils/entry-url'
import { findUrlPathClaimant } from './url-collision'
import type {
  BlockFieldConfig,
  ContentFormat,
  EntrySchema,
  FlatSchemaItem,
  EntryTypeConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
  ReferenceFieldConfig,
} from './config'
import {
  ContentIdIndex,
  extractIdFromFilename,
  extractSlugFromFilename,
  extractEntryTypeFromFilename,
  resolveCollectionPath,
} from './content-id-index'
import { registerContentIndexForInvalidation } from './content-index-registry'
import { bumpContentIndexGeneration, readContentIndexGeneration } from './content-index-generation'
import { generateId } from './id'
import { isNodeError } from './utils/error'
import { filePathExists, readFileIfExists } from './utils/fs'
import { asRecord, getFormatExtension } from './utils/format'
import {
  normalizeFilesystemPath,
  parseSlug,
  type LogicalPath,
  type PhysicalPath,
  type Slug,
  type ContentId,
} from './paths'

/**
 * Acquire multiple lock keys (via withLock) in a canonical (sorted) order
 * before running `fn`, to rule out AB-BA deadlocks between callers that need
 * overlapping key sets.
 *
 * Only renameEntry() needs two keys today (the source entry's ID lock, plus
 * the destination slug's create-lock -- see ContentStore.createLockKey()).
 * The `id:` and `create:` keyspaces never share a literal string (disjoint
 * prefixes), so two renameEntry() calls can never contend for the exact same
 * pair of keys in reversed roles -- but sorting costs nothing and is cheap
 * insurance against that changing later.
 */
async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = Array.from(new Set(keys)).sort()
  const acquireFrom = (index: number): Promise<T> =>
    index === sorted.length ? fn() : withLock(sorted[index], () => acquireFrom(index + 1))
  return acquireFrom(0)
}

export type MarkdownDocument = {
  format: 'md' | 'mdx'
  data: Record<string, unknown>
  body: string
  /** The schema field name that this body maps to (from `isBody: true`, defaults to `'body'`). */
  bodyFieldName: string
}

export type JsonDocument = {
  format: 'json'
  data: Record<string, unknown>
}

export type YamlDocument = {
  format: 'yaml'
  data: Record<string, unknown>
}

export type ContentDocument = (MarkdownDocument | JsonDocument | YamlDocument) & {
  collection: LogicalPath
  collectionName: string
  relativePath: PhysicalPath
  absolutePath: string
  /** File mtime in ms at the time of read/write. Used as an OCC version token. */
  version?: number
}

// expectedVersion: undefined = no opinion (blind write, back-compat default);
// a number = OCC — must match the file's current mtime; null = create-only —
// the file must NOT exist yet. Mirrors the same three-way convention already
// used by writeOccJsonFile's WriteOccJsonFileOptions.expectedVersion.
export type WriteInput =
  | {
      format: 'md' | 'mdx'
      data?: Record<string, unknown>
      body: string
      expectedVersion?: number | null
    }
  | { format: 'json'; data: Record<string, unknown>; expectedVersion?: number | null }
  | { format: 'yaml'; data: Record<string, unknown>; expectedVersion?: number | null }

export type ContentStoreErrorCode = 'NOT_FOUND' | 'NO_SCHEMA_ITEM' | 'FORBIDDEN' | 'VALIDATION'

export class ContentStoreError extends Error {
  code: ContentStoreErrorCode
  constructor(message: string, code: ContentStoreErrorCode) {
    super(message)
    this.code = code
  }
}

/**
 * Thrown when `expectedVersion` on a write doesn't match the file's current mtime.
 * Indicates a cross-process concurrent write — the caller should reload and retry.
 */
export class ContentConflictError extends Error {
  constructor(message = 'Content was modified by another editor') {
    super(message)
    this.name = 'ContentConflictError'
  }
}

/**
 * [SYNC-C1] Thrown when a mutation could not take the branch's cross-host
 * content-write lock within its bounded wait -- in practice, the worker is
 * mid-rebase on this branch's working tree (utils/content-write-lock.ts).
 *
 * A `ContentConflictError` subclass so every existing 409 mapping keeps
 * working unchanged; the distinct type exists so the API can surface THIS
 * message ("the branch is busy, retry") instead of the generic "modified by
 * another editor", which would be actively misleading. The default wording
 * covers writer-vs-writer contention too, which this lock also produces --
 * see ContentWriteLockBusyError.
 */
export class BranchSyncingError extends ContentConflictError {
  constructor(message: string) {
    super(message)
    this.name = 'BranchSyncingError'
  }
}

/**
 * [F1] Thrown when a save's content ID is carried by MORE THAN ONE file in
 * the branch's content tree -- the duplicate-ID state `ContentIdIndex`
 * quarantines (see its "Duplicate-ID quarantine" section).
 *
 * Why refuse rather than write: with two files sharing one ID, "this entry"
 * is ambiguous, and every way of proceeding is worse than stopping.
 * Following the index would mutate (and, via the slug-change cleanup, DELETE)
 * a file the caller never addressed -- the data-loss bug this class exists to
 * prevent. Writing only the addressed file would succeed silently into a file
 * that is invisible to every ID-based lookup (reads-by-id, references,
 * listings all resolve to the OTHER copy) and that the repair action later
 * archives away, so the editor's work would appear to evaporate with no error
 * anywhere. Refusing mutates nothing under any interleaving, and says what is
 * wrong and who can fix it.
 *
 * A `ContentConflictError` subclass so every existing 409 mapping keeps
 * working; the distinct type exists so the API can surface THIS message
 * rather than the generic "modified by another editor", which would send the
 * editor into a reload-and-retry loop that cannot succeed.
 */
export class DuplicateContentIdError extends ContentConflictError {
  readonly contentId: string
  /** Every path known to carry `contentId`, repo-relative, sorted. */
  readonly paths: readonly string[]

  constructor(contentId: string, paths: readonly string[]) {
    const sorted = Array.from(new Set(paths)).sort()
    super(
      // Names the STATE, not an action. The repair-content-duplicates
      // endpoint exists but nothing in the editor renders it, so telling an
      // editor "an admin can run X" sent them to an admin who could neither
      // run X nor see that the branch was affected. Say what is true; the
      // admin panel's read-only duplicate list (SystemHealthPanel) is the
      // diagnosis half, and the repair UI is tracked in
      // .claude/future-tasks/duplicate-content-id-repair-ui.md.
      `Content ID ${contentId} is on more than one file (${sorted
        .map((p) => `"${p}"`)
        .join(' and ')}), so this save was refused rather than risk overwriting or ` +
        `deleting the wrong one. An administrator needs to resolve the duplicate on the ` +
        `server before this entry can be saved.`,
    )
    this.name = 'DuplicateContentIdError'
    this.contentId = contentId
    this.paths = sorted
  }
}

/**
 * Thrown when a create or rename would give a SECOND entry a `urlPath` another entry already
 * holds -- the write-boundary half of the invariant `assertNoDuplicateUrlPaths` enforces at build
 * time (see url-collision.ts for which shapes count and, just as importantly, which do not).
 *
 * Why refuse rather than write: only one of the two entries can be served at that URL, so the
 * other silently has no route anywhere. Allowing the write trades a clear error now for a page
 * that quietly does not exist later -- and, because the loser is picked by resolver precedence
 * rather than by the author, not necessarily the page they were editing.
 *
 * A `ContentConflictError` subclass so every existing 409 mapping keeps working; the distinct
 * type exists so the API can surface THIS message rather than the generic "modified by another
 * editor", which would send the editor into a reload-and-retry loop that cannot succeed.
 */
export class UrlPathConflictError extends ContentConflictError {
  /** Absolute path of the entry already holding the contested URL. */
  readonly conflictingPath: string

  constructor(message: string, conflictingPath: string) {
    super(message)
    this.name = 'UrlPathConflictError'
    this.conflictingPath = conflictingPath
  }
}

/**
 * Get the default entry type from a collection's entries array.
 * Returns the entry marked as default, or the first one, or undefined if no entries.
 */
export function getDefaultEntryType(
  entries: readonly EntryTypeConfig[] | undefined,
): EntryTypeConfig | undefined {
  if (!entries || entries.length === 0) return undefined
  return entries.find((e) => e.default) || entries[0]
}

/**
 * Validates that a slug doesn't contain slashes or backslashes.
 * Slugs must be simple filenames (last path segment only).
 *
 * Deliberately WEAKER than `parseSlug`, and deliberately not merged with it: this runs on every
 * resolution, reads included (`buildPaths`), so it can only enforce what must be true of content
 * that already exists on disk -- i.e. path safety. Content whose slug predates CanopyCMS, or was
 * hand-authored, or came in over git, has to stay readable. `parseSlug`'s stricter URL-addressable
 * rule is enforced only where a NEW filename is minted (see the [SLUG] guards in `write()` and
 * `renameEntry()`); applying it here would convert a build-time failure into unreachable data.
 */
function validateSlug(slug: string): void {
  if (slug.includes('/')) {
    throw new ContentStoreError(
      'Slugs cannot contain forward slashes. Use nested collections instead.',
      'VALIDATION',
    )
  }
  if (slug.includes('\\')) {
    throw new ContentStoreError(
      'Slugs cannot contain backslashes. Use nested collections instead.',
      'VALIDATION',
    )
  }
}

export interface ContentStoreOptions {
  /**
   * Minimum ms between on-disk generation-marker probes when the in-memory
   * index is otherwise fresh (see content-index-generation.ts). The probe is
   * one small readFile; the 1s default matches the schema-cache mtime
   * debounce. Tests pass 0 for deterministic cross-process scenarios.
   */
  indexFreshnessIntervalMs?: number
  /**
   * Directory name (relative to `root`) holding the content tree — i.e.
   * `config.contentRoot`. The ID index scans from here, so an adopter with a
   * non-default content root would otherwise get an index built from a
   * directory that does not exist: empty, so every ID-based lookup (reference
   * resolution, entry links, order cleanup, rename) silently misses while
   * path-based reads keep working. Defaults to 'content'.
   */
  contentRootName?: string
  /**
   * [SYNC-C1] Bounded wait (ms) for the branch's cross-host content-write lock
   * before a mutation gives up with {@link BranchSyncingError}. See
   * `utils/content-write-lock.ts` for why the default is short. Tests pass a
   * small value to keep contention cases fast.
   */
  contentWriteLockWaitMs?: number
}

const DEFAULT_INDEX_FRESHNESS_INTERVAL_MS = 1000
/**
 * At most one suspicious-lookup forced rescan per store per this window, so
 * genuinely dangling IDs cannot trigger a full tree scan on every lookup.
 */
const FORCED_REFRESH_MIN_INTERVAL_MS = 5000

/** Internal sentinel: a lookup result that suggests this store's index is stale. */
const STALE_LOOKUP = Symbol('stale-index-lookup')

/**
 * Per-batch memo for reference resolution, keyed by content ID.
 *
 * Exists because a batch surface resolves the SAME reference over and over: a shared
 * block ("call to action", "promo card") referenced by 40 pages costs 40 separate
 * `read()`s of one small file in a single `listEntries()` pass, and a search-index build
 * over thousands of entries multiplies that. Pass one cache through a whole batch and
 * each distinct target is read once.
 *
 * Values are the in-flight **promise**, not the settled value, so concurrent lookups
 * inside a `Promise.all` collapse onto one read rather than each starting their own —
 * the same in-flight dedup `ContentStore.indexBuild` uses for index rebuilds.
 *
 * What is cached is the READ, not the object handed out: every occurrence receives its own
 * deep copy, so a caller mutating one resolved reference cannot rewrite it for the other 39
 * entries pointing at the same target. See `resolveSingleReference` for why that matters and
 * why it does not undo the saving.
 *
 * ## Lifetime and invalidation
 *
 * There is no invalidation, and that is the design: a cache lives inside a single
 * `listEntries()` / `buildContentTree()` call and is dropped when it returns. That is
 * strictly shorter than the lifetime of the `ContentStore` whose memoized `idIndex()` it
 * sits on top of, so it introduces no staleness window that store did not already have,
 * and it is out of scope for the generation-marker protocol in
 * `docs/concurrency.md` (which governs caches rebuilt by scanning that OUTLIVE the
 * mutations they can miss). Never make one module-global, never persist one, and never
 * reuse one across requests.
 *
 * Misses are memoized alongside hits, deliberately: one batch should be internally
 * coherent, and a shared block resolving to data on page 1 and to `null` on page 40 of
 * the same sitemap is worse than either consistent answer. The accepted cost is that a
 * later occurrence in the same batch can no longer get incidentally lucky after a
 * sibling lookup wins the stale-index refresh throttle. Each DISTINCT id still gets its
 * full self-healing retry, because that retry happens inside the memoized promise (see
 * `resolveSingleReference`).
 */
export type ReferenceResolveCache = Map<string, Promise<Record<string, unknown> | null>>

/** Create a cache for one batch of reference resolution. See {@link ReferenceResolveCache}. */
export const createReferenceResolveCache = (): ReferenceResolveCache => new Map()

export class ContentStore {
  private readonly root: string
  /** See ContentStoreOptions.contentRootName — the ID index scan root. */
  private readonly contentRootName: string
  private readonly schemaIndex: Map<string, FlatSchemaItem>
  /** Swapped wholesale on rebuild — in-flight callers keep their (older) snapshot. */
  private _idIndex: ContentIdIndex
  /** Bumped by invalidateIndex(); when it differs from loadedIndexGeneration the index is stale. */
  private indexGeneration = 0
  private loadedIndexGeneration = -1
  /**
   * On-disk generation token (content-index-generation.ts) the current index
   * was built against. undefined = never captured; null = marker absent at
   * build time. Assigned only by the rebuild path and by guarded self-adoption
   * after this store's own mutations.
   */
  private loadedDiskGeneration: string | null | undefined = undefined
  private lastDiskProbeMs = 0
  private lastForcedRefreshMs = 0
  private readonly indexFreshnessIntervalMs: number
  /** See ContentStoreOptions.contentWriteLockWaitMs. */
  private readonly contentWriteLockWaitMs: number
  /** In-flight index build, shared by concurrent idIndex() callers so scans never interleave. */
  private indexBuild: Promise<unknown> | null = null

  constructor(root: string, flatSchema: FlatSchemaItem[], options: ContentStoreOptions = {}) {
    this.root = path.resolve(root)
    this.contentRootName = options.contentRootName || 'content'
    this.indexFreshnessIntervalMs =
      options.indexFreshnessIntervalMs ?? DEFAULT_INDEX_FRESHNESS_INTERVAL_MS
    this.contentWriteLockWaitMs =
      options.contentWriteLockWaitMs ?? DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS
    this.schemaIndex = new Map(flatSchema.map((item) => [item.logicalPath, item]))
    this._idIndex = new ContentIdIndex(this.root)
    registerContentIndexForInvalidation(this.root, this)
  }

  /**
   * [SYNC-C1] Run a working-tree mutation under the branch's cross-host
   * content-write lock (utils/content-write-lock.ts), on top of the
   * in-process locks the callee takes for itself.
   *
   * The in-process mutex serializes writers inside ONE process; it says
   * nothing about the EC2 worker rebasing this same tree on shared EFS, which
   * destroys an in-flight save (`checkout --theirs` overwrites it and the
   * rebase then reports success; `rebase --abort` hard-resets it). This is the
   * layer that actually excludes the two.
   *
   * Reads deliberately do NOT take it -- an extra EFS round-trip per read is
   * not an acceptable cost, and reads cannot be destroyed by a rebase.
   *
   * Acquisition order is always content lock -> `withLock`, never the reverse,
   * so the two cannot deadlock.
   */
  private async withContentWriteExclusion<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withContentWriteLock(this.root, fn, this.contentWriteLockWaitMs)
    } catch (err: unknown) {
      // Translate at the boundary, after the bounded wait -- never inside the
      // acquire loop, which would disable its ELOCKED retry predicate.
      if (err instanceof ContentWriteLockBusyError) throw new BranchSyncingError(err.message)
      throw err
    }
  }

  /**
   * Mark the ID index stale so the next idIndex() access rebuilds it from disk.
   *
   * Called (via content-index-registry) after in-process operations that change the
   * working tree underneath this store — git checkout/merge/rebase, the worker's
   * rebase loop, and sync-core's content replacement. Without this, ID→path lookups
   * keep resolving to pre-mutation paths and saves can target moved/deleted files.
   *
   * Cheap: only bumps a generation counter; the rebuild happens lazily.
   */
  public invalidateIndex(): void {
    this.indexGeneration++
  }

  /**
   * Get the ID index, ensuring it's loaded and current first.
   * Loads lazily on first access and rebuilds after invalidateIndex(); repeated
   * accesses with no intervening invalidation reuse the already-built index,
   * except for a throttled probe of the on-disk generation marker that detects
   * mutations made by OTHER processes sharing this root (e.g. on EFS).
   */
  public async idIndex(): Promise<ContentIdIndex> {
    // Cross-process freshness probe: when the in-memory generations already
    // match, cheaply check whether another process bumped the on-disk marker
    // since this index was built. Skipped while a rebuild is due anyway — the
    // rebuild below captures the marker itself.
    if (this.loadedIndexGeneration === this.indexGeneration && this.shouldProbeDiskGeneration()) {
      const diskToken = await readContentIndexGeneration(this.root)
      if (diskToken !== this.loadedDiskGeneration) {
        this.indexGeneration++
      }
    }

    while (this.loadedIndexGeneration !== this.indexGeneration) {
      if (this.indexBuild) {
        // Another caller is already rebuilding — wait, then re-check freshness.
        await this.indexBuild
        continue
      }
      const generation = this.indexGeneration
      const build = (async () => {
        // Capture the marker BEFORE scanning: a bump landing mid-scan then
        // differs from the token recorded below, forcing a rebuild on the
        // next probe instead of being silently missed.
        const diskToken = await readContentIndexGeneration(this.root)
        // Build into a fresh instance and swap, instead of clearing in place:
        // in-flight callers hold the previous reference across awaits and must
        // keep seeing a consistent (if outdated) snapshot, never a half-built one.
        const fresh = new ContentIdIndex(this.root)
        await fresh.buildFromFilenames(this.contentRootName)
        return { diskToken, fresh }
      })()
      this.indexBuild = build
      let result: { diskToken: string | null; fresh: ContentIdIndex }
      try {
        result = await build
      } finally {
        this.indexBuild = null
      }
      // Swap and record in one synchronous continuation (only the rebuild path
      // assigns these; waiters above never do), so callers resuming after us
      // observe a consistent index/generation/token triple. If invalidateIndex()
      // ran mid-build the generations won't match and we rebuild.
      this._idIndex = result.fresh
      this.loadedIndexGeneration = generation
      this.loadedDiskGeneration = result.diskToken
      // The build just captured a fresh token — it counts as a probe.
      this.lastDiskProbeMs = Date.now()
    }
    return this._idIndex
  }

  /**
   * Throttle for the on-disk marker probe. Stamps the clock synchronously
   * before the caller's readFile so concurrent idIndex() callers don't
   * double-probe (and double-rebuild) on the same token change.
   */
  private shouldProbeDiskGeneration(): boolean {
    const now = Date.now()
    if (now - this.lastDiskProbeMs < this.indexFreshnessIntervalMs) return false
    this.lastDiskProbeMs = now
    return true
  }

  /**
   * After one of this store's own successful mutations: publish the change to
   * other processes (bump the on-disk marker) and adopt the written token,
   * since the in-memory index was already updated incrementally — avoiding a
   * pointless self-rescan on the next probe. Adoption is skipped unless the
   * index is quiescent and `updatedIndex` is still the live instance: if a
   * rebuild raced with the mutation, its scan may predate our file change, so
   * we leave the recorded token older and let the next probe observe our bump
   * and trigger the healing rebuild.
   */
  private async recordOwnMutation(updatedIndex: ContentIdIndex): Promise<void> {
    const token = await bumpContentIndexGeneration(this.root)
    if (
      token !== null &&
      this.indexBuild === null &&
      this.loadedIndexGeneration === this.indexGeneration &&
      this._idIndex === updatedIndex
    ) {
      this.loadedDiskGeneration = token
    }
  }

  /**
   * Backstop for the residual staleness windows of the cross-process marker
   * (NFS attribute caching, probe throttle, self-adoption — see
   * content-index-generation.ts): force one rebuild in response to a
   * suspicious lookup (an ID miss, or an index hit whose file is gone), but
   * throttle how often a caller can force one. Time-boxed so genuinely
   * dangling IDs cost at most one rescan per window. Returns true if a
   * refresh was performed by THIS call; callers that lose the throttle race
   * still benefit — idIndex() dedupes concurrent builds, so a caller that won
   * the race rebuilds the index for everyone, and callers should still retry
   * their lookup against the live index regardless of this return value.
   */
  private async refreshIndexForSuspiciousLookup(): Promise<boolean> {
    const now = Date.now()
    if (now - this.lastForcedRefreshMs < FORCED_REFRESH_MIN_INTERVAL_MS) return false
    this.lastForcedRefreshMs = now
    this.invalidateIndex()
    await this.idIndex()
    return true
  }

  /**
   * Every file in `dir` whose filename embeds `id`, as root-relative paths
   * (empty when there is no such file, or no such dir).
   *
   * [F1] Returns ALL matches, not the first: more than one match is a
   * duplicate-ID pair, and callers must be able to tell that apart from a
   * clean single hit rather than silently picking whichever one `readdir()`
   * happened to yield first.
   */
  private async findEntryPathsById(dir: string, id: string): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return []
      throw err
    }
    const matches: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (extractIdFromFilename(entry.name) === id) {
        matches.push(path.relative(this.root, path.join(dir, entry.name)))
      }
    }
    return matches.sort()
  }

  /**
   * Get all schema items for iteration.
   * Used internally by ReferenceResolver for path matching.
   */
  public getSchemaItems(): IterableIterator<FlatSchemaItem> {
    return this.schemaIndex.values()
  }

  private assertSchemaItem(path: LogicalPath): FlatSchemaItem {
    const normalized = normalizeFilesystemPath(path)
    const item = this.schemaIndex.get(normalized)
    if (!item) {
      throw new ContentStoreError(`Unknown schema item: ${path}`, 'NO_SCHEMA_ITEM')
    }
    return item
  }

  /**
   * Is this path a COLLECTION schema item?
   *
   * The non-throwing form of `assertCollection`, reading the same `schemaIndex` -- which is the
   * point. A caller that gates on this cannot disagree with what `buildPaths` will then do: the
   * Map is last-wins, so where a subcollection's path collides with a parent's entry-type name
   * both this and `buildPaths` see the collection. A `find` over the flat schema LIST is
   * first-wins and would not.
   *
   * Type-only, deliberately -- `resolvePath` additionally requires `entries`, but a collection
   * with subcollections and no entries of its own is legal, and mirroring that stricter test here
   * would reject something `buildPaths` accepts.
   *
   * Exists for `readByUrlPath`'s URL-addressability gate; see `ReadContentInput`'s
   * `urlAddressableOnly` and the note on `buildPaths`' entry-type branch below.
   */
  public isCollectionPath(collectionPath: LogicalPath): boolean {
    return this.schemaIndex.get(normalizeFilesystemPath(collectionPath))?.type === 'collection'
  }

  /**
   * Does this collection declare `entryTypeName` in its `entries` config?
   *
   * Mirrors `parseTypedFilename(filename, collection.entries)`, which is how `listEntries` decides
   * whether a file on disk is one of the collection's entries at all. `buildPaths`' own directory
   * scan deliberately does NOT check this -- it matches on slug alone, so that an entry whose type
   * was renamed out of the schema stays findable and therefore still editable, renameable and
   * deletable. Only URL resolution consults this, so what enumeration hides is not served.
   *
   * Returns true when the collection declares no `entries` at all: that is "no type list to check
   * against", exactly like `parseTypedFilename`'s own `if (entryTypes && ...)` guard, and not
   * "reject everything".
   */
  public declaresEntryType(collectionPath: LogicalPath, entryTypeName: string): boolean {
    const item = this.schemaIndex.get(normalizeFilesystemPath(collectionPath))
    if (item?.type !== 'collection' || !item.entries) return true
    return item.entries.some((e) => e.name === entryTypeName)
  }

  private assertCollection(collectionPath: LogicalPath): FlatSchemaItem & { type: 'collection' } {
    const item = this.assertSchemaItem(collectionPath)
    if (item.type !== 'collection') {
      throw new ContentStoreError(`Path is not a collection: ${collectionPath}`, 'NO_SCHEMA_ITEM')
    }
    return item
  }

  /**
   * Lock key for an existing entry, addressed by its permanent content ID
   * (stable across renames -- the whole point of this locking scheme; see
   * .claude/future-tasks/resolved/content-store-lock-key.md). Namespaced by store
   * root: the same content ID exists in every clone of a branch, and one
   * process can hold ContentStore instances on several clones (dev
   * workspace roots, prod branch clones) at once, so the root prefix keeps
   * the keyspace scoped per-store. It also keeps this ID keyspace disjoint
   * from other modules' raw-path-keyed locks sharing the same withLock()
   * map (comment-store, branch-metadata, etc).
   */
  private idLockKey(id: string): string {
    return `${this.root}:id:${id}`
  }

  /**
   * Stable collection+slug identifier for lock-key namespacing. Mirrors the
   * schemaItem resolution buildPaths() performs for entry-type delegation:
   * an entry-type item delegates to its parent collection with the slug
   * defaulting to the entry type's own name (see buildPaths()'s
   * `schemaItem.type === 'entry-type'` branch).
   */
  private collectionSlugKey(schemaItem: FlatSchemaItem, slug: string): string {
    if (schemaItem.type === 'entry-type') {
      return `${schemaItem.parentPath}/${slug || schemaItem.name}`
    }
    return `${schemaItem.logicalPath}/${slug}`
  }

  /**
   * Lock key for a not-yet-existing entry (a create). Serializes concurrent
   * same-slug creates WITHIN this process: the second call's in-lock
   * buildPaths() re-resolution will find the first call's just-written file
   * and fold in as an edit (see write()). A concurrent create racing from a
   * DIFFERENT process is NOT covered by this in-process mutex -- accepted
   * per the epic's design review: each writer mints its own fresh ID and
   * writes its own distinct filename, so both writes succeed and the result
   * is two same-slug files with different IDs (a slug-uniqueness violation
   * surfaced on the next listing/lookup), never a duplicate-ID collision
   * that would poison index rebuilds.
   */
  private createLockKey(schemaItem: FlatSchemaItem, slug: string): string {
    return `${this.root}:create:${this.collectionSlugKey(schemaItem, slug)}`
  }

  /**
   * Lock key for a write()/delete() pre-pass classification. Existing
   * entries lock on their content ID (idLockKey()). Legacy entries with no
   * embedded ID (pre-ID-era filenames -- renameEntry() already refuses to
   * touch these, via its four-part filename check, so there is no rename
   * race to guard against for them) fall back to the physical path, matching
   * this store's original locking behavior for that narrow case. Not-yet-
   * existing entries lock on a per-slug create-key (createLockKey()).
   */
  private entryLockKey(
    schemaItem: FlatSchemaItem,
    slug: string,
    prePass: { existed: boolean; id?: string; absolutePath: string },
  ): string {
    if (!prePass.existed) return this.createLockKey(schemaItem, slug)
    return prePass.id ? this.idLockKey(prePass.id) : prePass.absolutePath
  }

  /**
   * Refuse a create/rename that would give a second entry a `urlPath` another entry already
   * holds. See url-collision.ts for the two shapes that count, and the legitimate
   * landing-page-beside-a-collection shape that deliberately does not.
   *
   * @param collectionDir Absolute physical directory the entry will live in.
   * @param slug The entry's slug, as it will be written.
   */
  private async assertUrlPathAvailable(collectionDir: string, slug: string): Promise<void> {
    const claimant = await findUrlPathClaimant({
      collectionDir,
      slug,
      contentRoot: path.resolve(this.root, this.contentRootName),
    })
    if (!claimant) return

    const relative = path.relative(this.root, claimant.physicalPath)
    const message =
      claimant.kind === 'sibling-collection-index'
        ? `An entry with slug "${slug}" would share a URL with the index entry of the ` +
          `"${claimant.name}" collection beside it ("${relative}"), and only one of them could ` +
          `be served there. Rename this entry, or remove that collection's index entry.`
        : `An index entry here would share a URL with the "${claimant.name}" entry in the parent ` +
          `collection ("${relative}"), and only one of them could be served there. Rename that ` +
          `entry, or give this collection's landing page a different slug.`

    throw new UrlPathConflictError(message, claimant.physicalPath)
  }

  /**
   * Build absolute and relative paths with security validation.
   * All entries use the unified filename pattern: {type}.{slug}.{id}.{ext}
   *
   * SECURITY BOUNDARY: This method prevents path traversal attacks by:
   * 1. Validating that resolved paths stay within the content root
   * 2. Checking slugs for malicious patterns (via validateSlug)
   * 3. Using path.resolve to normalize paths before validation
   *
   * This validation is performed BEFORE file I/O in resolveDocumentPath(),
   * ensuring permission checks happen before any file system access.
   *
   * @param options.existingId - Optional ID to use (for edits). If not provided, generates new ID.
   * @param options.entryTypeName - For collections with multiple entry types, specify which one to use. Defaults to the default entry type.
   */
  private async buildPaths(
    schemaItem: FlatSchemaItem,
    slug: string,
    options: { existingId?: string; entryTypeName?: string } = {},
  ): Promise<{
    absolutePath: string
    relativePath: PhysicalPath
    id?: string
    /**
     * Always populated for a valid schema item: the collection branch below
     * always resolves a name (falling back to `'entry'` when the collection
     * has no matching/default entry type config), and the entry-type branch
     * delegates to it with its own name set explicitly. Only non-collection,
     * non-entry-type schema items (impossible via the public API, which only
     * ever resolves to one of those two) skip both branches, hitting the
     * throw below instead of returning at all.
     */
    entryTypeName: string
    /**
     * True if this slug already had a file on disk (a directory-scan finding,
     * or `options.existingId` asserting one) -- i.e. this resolution is an
     * edit, not a create. Used by write()/delete()/renameEntry() to pick a
     * stable lock key (see entryLockKey()); NOT the same as `id` being set,
     * since a brand-new entry also gets an `id` (freshly generated below).
     */
    existed: boolean
  }> {
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`

    // Entry-type items: delegate to their parent collection.
    // Uses the same {type}.{slug}.{id}.{ext} pattern as all entries.
    //
    // This branch is for DIRECT ContentStore usage -- store.read('content/home', ''), and the
    // read({ entryPath: 'content/home' }) API built on it, where the slug defaults to the entry
    // type's own name. The API layer resolves paths via resolvePath(), which returns the parent
    // collection directly and so never lands here.
    //
    // That used to be an observation, and it was WRONG: readByUrlPath reached this branch too,
    // because `resolveUrlPathCandidates` happily produces `content/<typeName>` for the URL
    // `/<typeName>` and the delegation below then answered it with the parent collection's index
    // entry -- a URL no forward surface publishes. It is now enforced rather than assumed:
    // readByUrlPath requires every candidate's entryPath to be a collection (see
    // `isCollectionPath` and `ReadContentInput.urlAddressableOnly`). Narrowing the delegation
    // ITSELF was the wrong fix -- write()/renameEntry()/delete() resolve through here as well,
    // and the by-URL rule has no business constraining them.
    if (schemaItem.type === 'entry-type') {
      const parentPath = schemaItem.parentPath || ''
      const parentCollection = this.schemaIndex.get(parentPath)
      if (!parentCollection || parentCollection.type !== 'collection') {
        throw new ContentStoreError(
          `Parent collection not found for entry type: ${schemaItem.name}`,
          'NO_SCHEMA_ITEM',
        )
      }
      // Use provided slug, falling back to entry type name
      const effectiveSlug = slug || schemaItem.name
      return this.buildPaths(parentCollection, effectiveSlug, {
        ...options,
        entryTypeName: schemaItem.name,
      })
    }

    // Collection entries: {type}.{slug}.{id}.{ext}
    if (schemaItem.type === 'collection') {
      const safeSlug = slug.replace(/^\/+/, '').toLowerCase()
      if (!safeSlug) {
        throw new ContentStoreError('Slug is required for collection entries', 'VALIDATION')
      }
      // Security: Validate slug format (prevents ../../../etc/passwd)
      validateSlug(safeSlug)

      // Determine which entry type to use
      let entryTypeConfig: EntryTypeConfig | undefined
      if (options.entryTypeName) {
        // Use specified entry type
        entryTypeConfig = schemaItem.entries?.find((e) => e.name === options.entryTypeName)
        if (!entryTypeConfig) {
          throw new ContentStoreError(
            `Entry type '${options.entryTypeName}' not found in collection`,
            'NO_SCHEMA_ITEM',
          )
        }
      } else {
        // Use default entry type
        entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      }

      const format = entryTypeConfig?.format || 'json'
      const ext = getFormatExtension(format)
      const entryTypeName = entryTypeConfig?.name || 'entry'

      // Resolve the full collection path with embedded IDs
      // e.g., "content/docs/api" → "content/docs.bChqT78gcaLd/api.meiuwxTSo7UN"
      let collectionRoot = await resolveCollectionPath(this.root, schemaItem.logicalPath)

      if (!collectionRoot) {
        // Collection directory doesn't exist yet - use logical path
        // (Directory will be created on write if needed)
        collectionRoot = path.resolve(this.root, schemaItem.logicalPath)
      }

      // Security: Prevent path traversal at collection level
      if (!collectionRoot.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected', 'VALIDATION')
      }

      // Check if file already exists (editing case)
      let id = options.existingId
      let existingFilename: string | undefined
      let existingEntryType: string | undefined
      let foundExisting = false

      if (!id) {
        // Try to find existing file with this slug
        const entries = await fs.readdir(collectionRoot, { withFileTypes: true }).catch(() => [])
        const existingFile = entries.find((entry) => {
          if (entry.isDirectory()) return false
          // Extract entry type from filename to check slug properly
          const fileEntryType = extractEntryTypeFromFilename(entry.name)
          const existingSlug = extractSlugFromFilename(entry.name, fileEntryType || undefined)
          return existingSlug === safeSlug
        })

        if (existingFile) {
          id = extractIdFromFilename(existingFile.name) || undefined
          // Remember original filename for legacy files without IDs
          existingFilename = existingFile.name
          // Extract and preserve entry type from existing file (immutable after creation)
          existingEntryType = extractEntryTypeFromFilename(existingFile.name) || undefined
          foundExisting = true
        }
      }

      // An entry "existed" if the directory scan above found it, OR the
      // caller asserted an existingId (a presumed edit -- see buildPaths()'s
      // doc comment on options.existingId). Not the same as `id` being
      // truthy: a brand-new entry gets a freshly generated id below too.
      const existed = foundExisting || Boolean(options.existingId)

      // For existing entries, preserve the entry type (immutable after creation)
      // For new entries, use the specified entry type
      const finalEntryTypeName = existingEntryType || entryTypeName

      // Build filename: use existing filename if found, or generate new one with ID
      let filename: string
      if (existingFilename) {
        // Existing file found - use its original filename to preserve on-disk casing
        filename = existingFilename
      } else {
        // Generate new ID if needed
        if (!id) {
          id = generateId()
        }
        // Build filename with embedded ID: type.slug.id.ext
        // Use finalEntryTypeName to preserve entry type for existing entries
        filename = `${finalEntryTypeName}.${safeSlug}.${id}${ext}`
      }
      const resolved = path.resolve(collectionRoot, filename)
      const collectionRootWithSep = collectionRoot.endsWith(path.sep)
        ? collectionRoot
        : `${collectionRoot}${path.sep}`

      // Security: Prevent path traversal at entry level
      if (!resolved.startsWith(collectionRootWithSep)) {
        throw new ContentStoreError('Path traversal detected', 'VALIDATION')
      }

      return {
        absolutePath: resolved,
        relativePath: path.relative(this.root, resolved) as PhysicalPath,
        id,
        entryTypeName: finalEntryTypeName,
        existed,
      }
    }

    throw new ContentStoreError('Invalid schema item type', 'VALIDATION')
  }

  /**
   * Path resolution: resolves a URL path to a schema item
   * - Try as collection + slug (last segment = slug)
   */
  resolvePath(pathSegments: string[]): {
    schemaItem: FlatSchemaItem
    slug: Slug
  } {
    if (pathSegments.length === 0) {
      throw new ContentStoreError('Empty path', 'VALIDATION')
    }

    const logicalPath = pathSegments.join('/')

    // Try as collection + slug
    // Last segment of an API-validated LogicalPath; normalize to lowercase
    const slug = pathSegments[pathSegments.length - 1].toLowerCase() as Slug
    const collectionPath = pathSegments.slice(0, -1).join('/')
    const normalizedCollection = normalizeFilesystemPath(collectionPath)
    const collection = this.schemaIndex.get(normalizedCollection)

    if (collection?.type === 'collection' && collection.entries) {
      return {
        schemaItem: collection,
        slug,
      }
    }

    throw new ContentStoreError(`No schema item found for path: ${logicalPath}`, 'NO_SCHEMA_ITEM')
  }

  async resolveDocumentPath(schemaPath: LogicalPath, slug = '') {
    const schemaItem = this.assertSchemaItem(schemaPath)
    return await this.buildPaths(schemaItem, slug)
  }

  async read(
    collectionPath: LogicalPath,
    slug: Slug | '' = '',
    options: { resolveReferences?: boolean } = {},
  ): Promise<ContentDocument> {
    const schemaItem = this.assertSchemaItem(collectionPath)
    const {
      absolutePath,
      relativePath,
      entryTypeName: resolvedEntryTypeName,
    } = await this.buildPaths(schemaItem, slug)
    // stat BEFORE readFile: conservative version token that can only produce false-positive
    // conflicts, never false-negatives. If a write lands between stat and readFile the client
    // receives newer content but an older token → their next save triggers a 409 (safe).
    // stat-after or parallel stat+read risks the opposite: old content + new token → silent
    // overwrite of a concurrent write (data loss).
    const stat = await fs.stat(absolutePath)
    const raw = await fs.readFile(absolutePath, 'utf8')

    let doc: ContentDocument
    let format: ContentFormat
    let fields: EntrySchema

    if (schemaItem.type === 'entry-type') {
      // Entry type from unified model
      format = schemaItem.format
      fields = schemaItem.schema
    } else {
      // Collection entry — use actual entry type from filename, fall back to default
      let entryTypeConfig: EntryTypeConfig | undefined
      if (resolvedEntryTypeName && schemaItem.entries) {
        entryTypeConfig = (schemaItem.entries as readonly EntryTypeConfig[]).find(
          (e) => e.name === resolvedEntryTypeName,
        )
      }
      if (!entryTypeConfig) {
        entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      }
      format = entryTypeConfig?.format || 'json'
      fields = entryTypeConfig?.schema || []
    }

    if (format === 'json') {
      const data = asRecord(JSON.parse(raw))
      doc = {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: 'json',
        data,
        relativePath,
        absolutePath,
      }
    } else if (format === 'yaml') {
      const data = asRecord(yamlParse(raw))
      doc = {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: 'yaml',
        data,
        relativePath,
        absolutePath,
      }
    } else {
      const parsed = matter(raw)
      doc = {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: format,
        data: (parsed.data as Record<string, unknown>) ?? {},
        body: parsed.content,
        bodyFieldName: findBodyFieldName(fields),
        relativePath,
        absolutePath,
      }
    }

    // Automatic reference resolution (defaults to true)
    if (options.resolveReferences !== false) {
      doc.data = await this.resolveReferencesInData(doc.data, fields)
    }

    doc.version = stat.mtimeMs
    return doc
  }

  async write(
    collectionPath: LogicalPath,
    slug: Slug | '' = '',
    input: WriteInput,
    entryTypeName?: string,
    existingId?: ContentId,
  ): Promise<ContentDocument> {
    // Warm the index outside the lock (a full scan must not hold the entry lock)
    await this.idIndex()
    const schemaItem = this.assertSchemaItem(collectionPath)

    // Determine expected format and fields (validation — outside lock so errors are immediate)
    let expectedFormat: ContentFormat
    let fields: EntrySchema = []
    if (schemaItem.type === 'entry-type') {
      expectedFormat = schemaItem.format
      fields = schemaItem.schema
    } else {
      // For collections, determine format from specified or default entry type
      let entryTypeConfig: EntryTypeConfig | undefined
      if (entryTypeName) {
        entryTypeConfig = schemaItem.entries?.find((e) => e.name === entryTypeName)
        if (!entryTypeConfig) {
          throw new ContentStoreError(
            `Entry type '${entryTypeName}' not found in collection`,
            'NO_SCHEMA_ITEM',
          )
        }
      } else {
        entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      }
      expectedFormat = entryTypeConfig?.format || 'json'
      fields = entryTypeConfig?.schema || []
    }

    if (expectedFormat !== input.format) {
      throw new ContentStoreError(
        `Format mismatch: expects ${expectedFormat}, got ${input.format}`,
        'VALIDATION',
      )
    }

    // Pre-pass: resolve paths OUTSIDE the lock, but ONLY to classify
    // existing-vs-new and pick a stable lock key -- never used for the
    // actual write. This trades away the old "validation errors surface
    // before the lock" property for buildPaths() specifically (the format
    // check above still runs unlocked): buildPaths() resolves the physical
    // path by directory-scanning for the slug, and that resolution can go
    // stale the instant a concurrent renameEntry() completes, so it must be
    // re-resolved (ground truth) after the lock is held -- see
    // .claude/future-tasks/resolved/content-store-lock-key.md and entryLockKey().
    const prePass = await this.buildPaths(schemaItem, slug, { entryTypeName, existingId })
    let lockKey = this.entryLockKey(schemaItem, slug, prePass)

    // Reclassification loop: the pre-pass picked the lock key, but the world
    // can change between the pre-pass and lock acquisition (a concurrent
    // renameEntry() freeing this slug flips existing->new; a concurrent
    // create landing flips new->existing). Writing under the WRONG kind of
    // key would bypass serialization against the writers holding the right
    // one (e.g. a reclassified-to-create write under an id-key racing a
    // create-key holder on the same slug -> two same-slug files). So after
    // the in-lock re-resolution, re-derive the key; on mismatch, release and
    // re-acquire under the current key. Bounded: each flip requires another
    // mutator to have completed in the gap; the cap only guards pathological
    // scheduling.
    // [SYNC-C1] Cross-host exclusion against the worker's rebase loop wraps
    // the WHOLE reclassification loop: one acquisition per call, and no
    // window between attempts where a rebase could start.
    return this.withContentWriteExclusion(async () => {
      const RETRY_KEY = Symbol('retry-with-new-lock-key')
      for (let attempt = 0; attempt < 10; attempt++) {
        const outcome = await withLock(lockKey, async (): Promise<ContentDocument | symbol> => {
          // Re-resolve inside the lock: ground truth after acquisition. A
          // concurrent renameEntry() may have moved this entry between the
          // pre-pass above and acquiring this lock.
          const inLock = await this.buildPaths(schemaItem, slug, {
            entryTypeName,
            existingId,
          })
          const currentKey = this.entryLockKey(schemaItem, slug, inLock)
          if (currentKey !== lockKey) {
            lockKey = currentKey
            return RETRY_KEY
          }
          const { absolutePath, relativePath, id } = inLock

          // [F1] Duplicate-ID guard. INVARIANT: a write must never remove or
          // modify a file it did not address. The post-write index-repair
          // step below deletes the ID's previously-indexed path when it
          // differs from the one being written ("the slug changed"); that is
          // only sound while an ID identifies exactly one file. When a
          // duplicate-ID pair is on disk (ContentIdIndex's quarantine, from
          // rename-crash debris or a merge) the quarantined file is still
          // addressable by collection+slug -- buildPaths() resolves slugs by
          // directory scan and knows nothing about the quarantine -- so a
          // save to it used to resolve the index to the OTHER file and unlink
          // that one: a different document, silently deleted, with the write
          // reporting success. Refuse instead (see DuplicateContentIdError).
          //
          // Runs before any mutation, so a refusal leaves the tree exactly as
          // it was. Two independent detections, because neither alone covers
          // everything:
          //   1. the index's own quarantine record -- catches a duplicate
          //      whose other copy lives in a different directory, and the
          //      ID-addressed (existingId) shape where the target is a fresh
          //      third path; needs the index to have scanned the duplicate.
          //   2. disk-verified ambiguity -- both the file we are about to
          //      write AND the indexed location exist right now. This one
          //      does not depend on index freshness at all, which is what
          //      makes the common (slug-addressed) save safe even against an
          //      index built before the duplicate landed.
          // Neither fires for the ordinary slug-change save of a
          // non-duplicated entry: there the indexed path exists but the
          // target does not (it is about to be created), so the cleanup
          // below still removes exactly the file the caller relocated.
          if (id) {
            const guardIndex = this._idIndex
            const indexedPath = guardIndex.findById(id)?.relativePath ?? null
            if (indexedPath && indexedPath !== relativePath) {
              const quarantined = guardIndex.getDuplicateFor(id)
              const bothOnDisk =
                (await filePathExists(absolutePath)) &&
                (await filePathExists(path.join(this.root, indexedPath)))
              if (quarantined || bothOnDisk) {
                throw new DuplicateContentIdError(id, [
                  indexedPath,
                  relativePath,
                  ...(quarantined?.droppedPaths ?? []),
                  ...(quarantined ? [quarantined.keptPath] : []),
                ])
              }
            }
          }

          // [URL] Contested-URL guard, create only: an ordinary save cannot contest a URL it
          // already holds, and blocking it would trap the author in an entry they can no longer
          // edit.
          //
          // Keyed on whether the target file actually EXISTS, not on `inLock.existed`. That flag
          // is `foundExisting || Boolean(options.existingId)`, and the `existingId` half is a
          // caller ASSERTION rather than disk truth -- so an id-addressed write recreating an
          // entry that was deleted out from under it (git, another process) would skip the guard
          // while in fact creating one.
          //
          // The slug is read back off the filename `buildPaths` actually chose, never the
          // caller's raw argument: `buildPaths` strips leading slashes and lowercases, and for
          // the entry-type delegation shape substitutes the type name for an empty slug. Checking
          // the raw value let `write(collection, '/guides', ...)` sail past a `guides` claimant.
          //
          // Serialization comes from `withContentWriteExclusion` (the branch-wide, cross-host
          // content-write lock wrapping this whole reclassification loop), NOT from the per-entry
          // lock: the two halves of a contested pair live in DIFFERENT collections and so take
          // different entry-lock keys. The branch lock is what makes check-then-write atomic
          // against the other half landing concurrently.
          if (!(await filePathExists(absolutePath))) {
            const chosenSlug = extractSlugFromFilename(path.basename(absolutePath))

            // [SLUG] Routability guard, create only. `validateSlug` above (in buildPaths) is the
            // path-traversal check -- it only rejects `/` and `\`, and it has to stay that weak
            // because it also runs on every READ. So the filename grammar accepts slugs that
            // `parseSlug` does not (a dot, an underscore, a leading hyphen), and `readByUrlPath`
            // runs every URL candidate through `parseSlug` before trying a read -- meaning such
            // an entry writes fine, builds fine, gets a `generateStaticParams` entry and a
            // sitemap `<loc>`, and then 404s on every actual visit. `assertRoutableSlugs`
            // (static/index.ts) now fails the whole production build over it.
            //
            // Refuse at the moment the unroutable entry is CREATED, so the failure lands on the
            // caller that caused it rather than on whoever builds next. Create-only, keyed on the
            // target file not existing, for exactly the reason the [URL] guard below is: content
            // that already has a non-conforming slug (hand-authored, imported, or predating this
            // guard) must stay editable -- and must stay renameable, which is the only way out.
            // Tightening the read path instead would turn a red build into unreachable data.
            //
            // Checked against the slug `buildPaths` actually chose, not the caller's raw
            // argument: buildPaths lowercases, strips leading slashes, and substitutes the entry
            // type's name for an empty slug (the singleton shape, e.g. write('content/home', '')).
            const routable = parseSlug(chosenSlug)
            if (!routable.ok) {
              throw new ContentStoreError(
                `Cannot create entry "${chosenSlug}": ${routable.error}. An entry whose slug is ` +
                  'not addressable as a URL segment would build and then 404 on every visit.',
                'VALIDATION',
              )
            }

            await this.assertUrlPathAvailable(path.dirname(absolutePath), chosenSlug)
          }

          await fs.mkdir(path.dirname(absolutePath), { recursive: true })

          // OCC: undefined means no opinion (skip entirely, back-compat blind
          // write). A number means "must match this mtime" (stale-write
          // rejection). `null` means "must NOT exist yet" — the create-intent
          // guard: without this, a create request against a slug that already
          // has content falls through to an ordinary blind overwrite (August
          // 2026 baseline review, Critical finding). This is the authoritative
          // check — it runs inside the per-entry lock against a fresh stat, so
          // it holds even if a caller's own pre-write existence check (e.g. the
          // API layer's `documentExists`) went stale under concurrency.
          if (input.expectedVersion !== undefined) {
            try {
              const existing = await fs.stat(absolutePath)
              if (input.expectedVersion === null) {
                throw new ContentConflictError('An entry with this slug already exists')
              }
              if (existing.mtimeMs !== input.expectedVersion) {
                throw new ContentConflictError()
              }
            } catch (err) {
              if (err instanceof ContentConflictError) throw err
              if (isNodeError(err) && err.code === 'ENOENT') {
                // File doesn't exist yet: for a numeric expectedVersion this is
                // the existing "first write, skip version check" back-compat
                // behavior; for expectedVersion === null this is the success
                // case (create-only correctly finds no collision) — either way,
                // proceed with the write.
              } else {
                throw err
              }
            }
          }

          // Existence guard (cross-process): the caller asserts this entry already
          // exists (existingId), so if no file is at the path we are about to
          // write, this store's index may be stale — another process may have
          // renamed the entry. Recreating a renamed entry's old path would leave
          // two files with the same embedded ID and poison every subsequent index
          // rebuild (ID collision). The directory listing is authoritative on this
          // host: if the ID's actual on-disk location differs from what our index
          // believes, fail with a conflict so the caller reloads fresh state.
          // (An intentional slug-change save passes: the index and the directory
          // agree on the entry's current — old-slug — path. External deletes also
          // pass: the ID is nowhere on disk, so recreating is last-writer-wins.)
          //
          // indexedRelPath reads the LIVE index synchronously — NOT idIndex() —
          // because idIndex() would run a full rescan while holding the entry
          // lock if invalidateIndex() fired between the pre-lock warm-up above
          // and here. The live index may then be stale, but staleness only errs
          // toward throwing ContentConflictError: actualRelPath comes from the
          // fresh in-lock directory scan just below (ground truth), so a stale
          // indexedRelPath can only turn agree->disagree (spurious conflict,
          // which the caller already handles by reloading), never
          // disagree->agree. Fail-closed, never fail-open.
          if (existingId && !(await filePathExists(absolutePath))) {
            const actualRelPaths = await this.findEntryPathsById(
              path.dirname(absolutePath),
              existingId,
            )
            // [F1] Two files in the target directory carry this ID -- a
            // duplicate the index has not scanned yet (the guard above asks
            // the index; this asks the directory). Which one a single-match
            // scan returns is readdir-order-dependent, so it could 409 or
            // pass at random, and passing meant the cleanup below unlinked
            // one of two indistinguishable documents. Refuse deterministically.
            if (actualRelPaths.length > 1) {
              throw new DuplicateContentIdError(existingId, actualRelPaths)
            }
            const actualRelPath = actualRelPaths[0] ?? null
            const indexedRelPath = this._idIndex.findById(existingId)?.relativePath ?? null
            if (actualRelPath !== null && actualRelPath !== indexedRelPath) {
              throw new ContentConflictError()
            }
          }

          // Comment preservation: re-serialise onto the file's OWN parsed document rather than
          // a fresh one, so nodes the payload did not change -- and the comments attached to
          // them -- survive the write. Without this every editor save silently deleted every
          // comment in the file (JSON has no comment syntax, so it is unaffected and skips the
          // read). See utils/content-serialize.ts.
          //
          // This makes the write a genuine read-modify-write of the content file, so WHERE the
          // read happens matters: it is inside withLock(lockKey), inside
          // withContentWriteExclusion ([SYNC-C1]), and after the expectedVersion stat above --
          // so the bytes read here are the bytes that OCC check validated, and no rebase can be
          // running against this branch. Do not hoist it out of the critical section.
          //
          // INVARIANT, and the one case that does NOT preserve comments: this reads the path
          // being WRITTEN. A relocating write -- one where the ID resolves to a different
          // relativePath, so the block below unlinks `staleOldAbsPath` -- finds nothing at the
          // new path and falls back to a plain stringify, losing the old file's comments. Latent
          // today: the editor renames through renameEntry(), which link()s the bytes across
          // intact, and no caller passes `existingId`. If a relocating write ever becomes
          // reachable, read the ID's current path here instead of `absolutePath`.
          const existingRaw =
            input.format === 'json' ? undefined : await readFileIfExists(absolutePath)

          // Serialize content string
          let content: string
          if (input.format === 'json') {
            content = `${JSON.stringify(input.data ?? {}, null, 2)}\n`
          } else if (input.format === 'yaml') {
            content = serializeYaml(input.data ?? {}, existingRaw)
          } else {
            content = serializeFrontmatter(input.body, input.data ?? {}, existingRaw)
          }

          await atomicWriteFile(absolutePath, content)

          // Update the ID index after a successful write. Look up and mutate the
          // LIVE index in one synchronous window (no awaits in between): a
          // concurrent rebuild may have swapped in a fresh instance since the
          // pre-write snapshot, and updates must land where future lookups go.
          const liveIndex = this._idIndex
          let staleOldAbsPath: string | null = null
          if (id) {
            const existing = liveIndex.findById(id)
            if (existing) {
              if (existing.relativePath !== relativePath) {
                // Slug changed — remember the orphaned old path to delete
                // below. Safe ONLY because the [F1] guard above has already
                // established that this ID is not on two files: without it
                // this line deletes a document the caller never addressed
                // (see DuplicateContentIdError). Do not move, weaken or skip
                // that guard while this unlink exists.
                staleOldAbsPath = path.join(this.root, existing.relativePath)
                liveIndex.updatePath(existing.id, relativePath)
              }
            } else {
              liveIndex.add({
                type: 'entry',
                relativePath,
                collection: collectionPath,
                slug: slug || undefined,
              })
            }
          }
          if (staleOldAbsPath) {
            await fs.unlink(staleOldAbsPath).catch((err: unknown) => {
              if (!isNodeError(err) || err.code !== 'ENOENT') throw err
            })
          }
          await this.recordOwnMutation(liveIndex)

          const afterStat = await fs.stat(absolutePath)
          const base = {
            collection: schemaItem.logicalPath,
            collectionName: schemaItem.name,
            relativePath,
            absolutePath,
            version: afterStat.mtimeMs,
          }

          if (input.format === 'json') {
            return { ...base, format: 'json' as const, data: input.data ?? {} }
          }
          if (input.format === 'yaml') {
            return { ...base, format: 'yaml' as const, data: input.data ?? {} }
          }
          return {
            ...base,
            format: input.format,
            data: input.data ?? {},
            body: input.body,
            bodyFieldName: findBodyFieldName(fields),
          }
        })
        if (typeof outcome !== 'symbol') return outcome
      }
      // Ten completed foreign mutations landed in our acquisition gaps in a
      // row — treat as contention and let the caller reload + retry.
      throw new ContentConflictError()
    })
  }

  /**
   * Read an entry by its ID (UUID).
   * Returns null if the ID doesn't exist or points to a collection.
   *
   * Suspicious results (ID missing from the index, or an index hit whose file
   * is gone) trigger one forced index refresh and a retry — self-healing for
   * mutations by other processes inside the marker's residual windows.
   */
  async readById(id: ContentId): Promise<ContentDocument | null> {
    const first = await this.readByIdOnce(id)
    if (first !== STALE_LOOKUP) return first
    if (!(await this.refreshIndexForSuspiciousLookup())) return null
    const second = await this.readByIdOnce(id)
    return second === STALE_LOOKUP ? null : second
  }

  private async readByIdOnce(id: ContentId): Promise<ContentDocument | null | typeof STALE_LOOKUP> {
    const idIndex = await this.idIndex()
    const location = idIndex.findById(id)
    if (!location) return STALE_LOOKUP
    if (location.type !== 'entry') return null
    try {
      return await this.read(location.collection!, location.slug!)
    } catch (err) {
      // Index hit but the file is gone — the typical symptom of an external
      // rename/delete this store hasn't observed yet.
      if (isNodeError(err) && err.code === 'ENOENT') return STALE_LOOKUP
      throw err
    }
  }

  /**
   * Get the ID for an entry given its collection and slug.
   * Returns null if no ID exists yet.
   */
  async getIdForEntry(collectionPath: LogicalPath, slug: Slug): Promise<ContentId | null> {
    const idIndex = await this.idIndex()
    const { relativePath } = await this.buildPaths(this.assertCollection(collectionPath), slug)
    return idIndex.findByPath(relativePath)
  }

  /**
   * Check whether a document already exists on disk for this collection+slug.
   * Used by the write boundary to distinguish creates from edits (create
   * scaffolds and maxItems enforcement).
   */
  async documentExists(collectionPath: LogicalPath, slug: Slug | '' = ''): Promise<boolean> {
    const schemaItem = this.assertSchemaItem(collectionPath)
    const { absolutePath } = await this.buildPaths(schemaItem, slug)
    try {
      await fs.access(absolutePath)
      return true
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return false
      throw err
    }
  }

  /**
   * Resolve the actual on-disk entry type of an existing collection entry, by
   * inspecting its filename directly. Entry filenames embed their type
   * (`{type}.{slug}.{id}.{ext}`) and it is immutable after creation — see the
   * existing-file lookup in buildPaths(), which this mirrors. Returns
   * undefined if no entry exists yet at this slug.
   *
   * Used at the API write boundary (api/content.ts) to validate an existing
   * entry's payload against ITS real schema rather than a caller-supplied (or
   * omitted/spoofed) `entryType` param — ContentStore.write() preserves the
   * on-disk type regardless of what's requested, so validation must agree
   * with what will actually be written (post-review M2).
   *
   * Cheap: one buildPaths() resolution plus a stat, no file content is read —
   * same cost class as documentExists().
   */
  async getExistingEntryType(
    collectionPath: LogicalPath,
    slug: Slug | '' = '',
  ): Promise<string | undefined> {
    const schemaItem = this.assertCollection(collectionPath)
    const { absolutePath, entryTypeName } = await this.buildPaths(schemaItem, slug)
    return (await filePathExists(absolutePath)) ? entryTypeName : undefined
  }

  /**
   * Count existing entries of a given entry type in a collection, by filename
   * (entry filenames embed their type: `{type}.{slug}.{id}.{ext}`). Used to
   * enforce `EntryTypeConfig.maxItems` server-side at the create boundary.
   */
  async countEntriesOfType(collectionPath: LogicalPath, entryTypeName: string): Promise<number> {
    this.assertCollection(collectionPath)
    const collectionRoot = await resolveCollectionPath(this.root, collectionPath)
    if (!collectionRoot) return 0
    const entries = await fs
      .readdir(collectionRoot, { withFileTypes: true })
      .catch((): Dirent[] => [])
    return entries.filter(
      (entry) => !entry.isDirectory() && extractEntryTypeFromFilename(entry.name) === entryTypeName,
    ).length
  }

  /**
   * Test-only seam: awaited right after the pre-pass buildPaths() resolves
   * in delete() and renameEntry(), before the lock key is used to acquire
   * anything. No-op in production. A test subclass can override this to
   * inject a controlled pause in that exact window, letting a test
   * deterministically run OTHER mutations (which don't hold this call's
   * not-yet-acquired lock) to completion before this call proceeds to
   * acquire its (possibly now-stale) lock key -- see the "Deterministic
   * interleavings" testing pattern in docs/concurrency.md and
   * branch-registry.test.ts's `BlockingRegistry` for the same idiom.
   */
  protected async afterPrePassForTesting(): Promise<void> {}

  /**
   * Delete an entry and remove it from the index.
   */
  async delete(collectionPath: LogicalPath, slug: Slug): Promise<void> {
    // Warm the index outside the lock (a full scan must not hold the entry lock)
    await this.idIndex()
    const collection = this.assertCollection(collectionPath)

    // Pre-pass: classify existing-vs-already-gone via a directory scan
    // (local ground truth) -- not this._idIndex, which can be stale in
    // exactly the way this locking scheme guards against (a rename this
    // store hasn't observed yet).
    const prePass = await this.buildPaths(collection, slug)

    if (!prePass.existed) {
      // Nothing on disk for this slug -- no shared resource to lock on, and
      // this matches the store's original behavior (fs.unlink throwing
      // ENOENT on the pre-pass's freshly generated, necessarily-nonexistent
      // path).
      await fs.unlink(prePass.absolutePath)
      return
    }

    let lockKey = this.entryLockKey(collection, slug, prePass)
    await this.afterPrePassForTesting()

    // Reclassification loop, mirroring write()'s (see its doc comment): the
    // pre-pass's lock key can go stale between resolution and acquisition --
    // e.g. a concurrent renameEntry() moving this slug's entry away flips
    // the key this slug would resolve to. Re-derive the key from the in-lock
    // ground truth and retry under the corrected key on mismatch, bounded to
    // rule out only pathological scheduling.
    // [SYNC-C1] See write()'s call to withContentWriteExclusion.
    return this.withContentWriteExclusion(async () => {
      const RETRY_KEY = Symbol('retry-with-new-lock-key')
      for (let attempt = 0; attempt < 10; attempt++) {
        const outcome = await withLock(lockKey, async (): Promise<symbol | undefined> => {
          // Re-resolve inside the lock: ground truth after acquisition. If a
          // concurrent renameEntry() moved this slug away in the meantime,
          // buildPaths() no longer finds it here (inLock.existed is false) --
          // the entry genuinely isn't at this slug anymore, so we fall through
          // to the unlink below on a freshly generated (nonexistent) path,
          // preserving the original ENOENT-throwing behavior.
          const inLock = await this.buildPaths(collection, slug)
          const currentKey = this.entryLockKey(collection, slug, inLock)
          if (currentKey !== lockKey) {
            lockKey = currentKey
            return RETRY_KEY
          }
          const { absolutePath, relativePath } = inLock

          // Delete file
          await fs.unlink(absolutePath)

          // Remove from the LIVE index — lookup and mutation in one synchronous
          // window, since a concurrent rebuild may swap instances across awaits.
          const liveIndex = this._idIndex
          const id = liveIndex.findByPath(relativePath)
          if (id) {
            liveIndex.remove(id)
          }
          await this.recordOwnMutation(liveIndex)
          return undefined
        })
        if (outcome !== RETRY_KEY) return
      }
      // Ten completed foreign mutations landed in our acquisition gaps in a
      // row — treat as contention and let the caller reload + retry.
      throw new ContentConflictError()
    })
  }

  /**
   * Rename an entry by changing its slug (middle segment of filename).
   * Entry filename pattern: {entryTypeName}.{slug}.{id}.{ext}
   *
   * @param collectionPath - Logical path to the collection
   * @param currentSlug - Current slug of the entry
   * @param newSlug - New slug (must be unique within collection)
   * @returns Object with new logical path
   * @throws ContentStoreError if entry doesn't exist, new slug conflicts, or validation fails
   */
  async renameEntry(
    collectionPath: LogicalPath,
    currentSlug: Slug,
    newSlug: Slug,
  ): Promise<{ newPath: LogicalPath }> {
    // Warm the index outside the lock (a full scan must not hold the entry lock)
    await this.idIndex()
    const collection = this.assertCollection(collectionPath)

    // Path-traversal check (rejects separators only).
    validateSlug(newSlug)
    const safeNewSlug = newSlug.replace(/^\/+/, '')
    if (!safeNewSlug) {
      throw new ContentStoreError('New slug cannot be empty', 'VALIDATION')
    }

    // If slugs are the same, no-op
    if (currentSlug === safeNewSlug) {
      return { newPath: `${collectionPath}/${currentSlug}` as LogicalPath }
    }

    // [SLUG] Routability check, run here rather than trusted from the caller. The `Slug` branded
    // type does NOT guarantee it: `ContentStore.resolvePath` casts a raw path segment to `Slug`
    // with only `.toLowerCase()`, and tests/callers reach for `unsafeAsSlug`. The API's
    // `slugSchema` does run `parseSlug` on `newSlug`, but that is one caller of an exported
    // method -- and a rename mints a new filename, so it is a write that can create an
    // unroutable entry just as a create can. See write()'s [SLUG] guard for what goes wrong.
    //
    // Deliberately AFTER the no-op short-circuit above: a rename to the slug the entry already
    // has mints nothing, so refusing it would only take an existing non-conforming entry and
    // make one more operation on it fail, for no gain.
    const routable = parseSlug(safeNewSlug)
    if (!routable.ok) {
      throw new ContentStoreError(
        `Cannot rename to "${safeNewSlug}": ${routable.error}. An entry whose slug is not ` +
          'addressable as a URL segment would build and then 404 on every visit.',
        'VALIDATION',
      )
    }

    // Pre-pass: classify via a directory scan (local ground truth, not the
    // index) and pick the source entry's stable lock key.
    const prePass = await this.buildPaths(collection, currentSlug)
    if (!prePass.existed) {
      throw new ContentStoreError(`Entry not found: ${currentSlug}`, 'NOT_FOUND')
    }
    let sourceLockKey = this.entryLockKey(collection, currentSlug, prePass)
    let sourceId = prePass.id

    // Also lock the destination create-key. Content ID is rename-invariant,
    // so the SOURCE side only ever needs one lock -- but the DESTINATION
    // slug can simultaneously be the target of a concurrent write() creating
    // a brand-new entry there. Without this second lock, that write()'s
    // in-lock buildPaths() re-resolution could observe the just-linked
    // destination file and silently fold in as an "edit" of the renamed
    // entry -- using the create's caller-requested entry type/schema against
    // a file that's actually a different (renamed-in) entry. Acquiring both
    // keys in canonical (sorted) order rules out AB-BA deadlocks; in
    // practice the id: and create: keyspaces never share a literal key
    // string (disjoint prefixes), so two renameEntry() calls can never
    // contend for the exact same pair of keys in reversed roles, but sorting
    // costs nothing.
    let destLockKey = this.createLockKey(collection, safeNewSlug)
    await this.afterPrePassForTesting()

    // Reclassification loop, mirroring write()'s (see its doc comment): the
    // pre-pass's source key can go stale between resolution and acquisition
    // -- e.g. this entry was renamed away by another writer and a brand-new,
    // different-ID entry landed at this same slug in the gap. Re-derive the
    // source key from the in-lock ground truth AND verify the resolved
    // file's embedded ID still matches the pre-pass ID (a path-based
    // fallback key for legacy no-ID filenames can't otherwise distinguish
    // "same file" from "a different legacy file now occupies this slug").
    // On either mismatch, release and retry under the corrected keys rather
    // than renaming the wrong entry under the stale lock -- bounded to rule
    // out only pathological scheduling.
    // [SYNC-C1] See write()'s call to withContentWriteExclusion.
    return this.withContentWriteExclusion(async () => {
      const RETRY_KEY = Symbol('retry-with-new-lock-key')
      for (let attempt = 0; attempt < 10; attempt++) {
        const outcome = await withLocks(
          [sourceLockKey, destLockKey],
          async (): Promise<{ newPath: LogicalPath } | symbol> => {
            // Re-resolve inside the lock: ground truth after acquisition.
            const inLock = await this.buildPaths(collection, currentSlug)
            if (!inLock.existed) {
              // Entry genuinely isn't at this slug anymore (e.g. deleted) --
              // matches the original access()-based NOT_FOUND behavior.
              throw new ContentStoreError(`Entry not found: ${currentSlug}`, 'NOT_FOUND')
            }
            const currentSourceKey = this.entryLockKey(collection, currentSlug, inLock)
            // The dest create-key is purely slug-derived and can't actually
            // change across attempts, but recompute for uniformity with the
            // source side.
            const currentDestKey = this.createLockKey(collection, safeNewSlug)
            if (currentSourceKey !== sourceLockKey || inLock.id !== sourceId) {
              sourceLockKey = currentSourceKey
              destLockKey = currentDestKey
              sourceId = inLock.id
              return RETRY_KEY
            }
            destLockKey = currentDestKey

            const { absolutePath: currentPath, relativePath: currentRelPath } = inLock

            // Extract entry type name and extension from current filename
            const currentFilename = path.basename(currentPath)
            const parts = currentFilename.split('.')
            if (parts.length < 4) {
              throw new ContentStoreError(
                `Invalid entry filename format: ${currentFilename}`,
                'VALIDATION',
              )
            }

            const entryTypeName = parts[0]
            const contentId = parts[parts.length - 2]
            const ext = `.${parts[parts.length - 1]}`

            // Build new filename with new slug
            const newFilename = `${entryTypeName}.${safeNewSlug}.${contentId}${ext}`
            const parentDir = path.dirname(currentPath)
            const newPath = path.join(parentDir, newFilename)

            // Check if any file with the new slug already exists (regardless of ID)
            // This catches same-slug-different-ID conflicts that link() alone cannot prevent
            try {
              const entries = await fs.readdir(parentDir, { withFileTypes: true })
              for (const entry of entries) {
                if (entry.isDirectory()) continue
                const existingSlug = extractSlugFromFilename(entry.name, entryTypeName)
                if (existingSlug === safeNewSlug) {
                  throw new ContentStoreError(
                    `Entry with slug "${safeNewSlug}" already exists in collection "${collectionPath}"`,
                    'VALIDATION',
                  )
                }
              }
            } catch (err) {
              if (err instanceof ContentStoreError) throw err
              // Ignore filesystem errors (e.g. ENOENT if parent dir doesn't exist)
            }

            // [URL] Contested-URL guard. A rename moves the entry to a NEW url, so the same
            // check a create gets applies here -- including the index direction, since renaming
            // an entry TO `index` is how an existing collection acquires a landing page.
            //
            // Runs AFTER the same-slug scan above, deliberately. In an already-contested tree
            // both refusals apply, and the same-slug one is the more immediate and more
            // actionable of the two -- reporting the URL conflict first sent the author to fix
            // the other claimant, only to hit the same-slug refusal on the retry. Still before
            // link(), so either refusal leaves the tree untouched.
            await this.assertUrlPathAvailable(parentDir, safeNewSlug)

            // Use link()+unlink() instead of rename() so a concurrent cross-process rename to the
            // exact same destination path fails with EEXIST rather than silently overwriting.
            //
            // Tradeoff: this is a two-step operation, not a single atomic syscall. If unlink()
            // fails after a successful link() (e.g. a transient EFS error), both the old and new
            // slug files will exist pointing at the same inode. The ID index will reflect the new
            // path, so subsequent reads work, but the orphaned source file will persist until the
            // next rename or deletion of that entry. This is an acceptable tradeoff: the EEXIST
            // protection on link() prevents silent data loss on concurrent renames, and the
            // partial-failure case is detectable and recoverable. Note: write()/delete()/
            // renameEntry() now lock on content ID (see idLockKey()), so a concurrent write() or
            // delete() targeting this same entry is fully serialized against this rename and
            // cannot observe this partial-failure window; only a genuinely separate process
            // acting directly on the filesystem without going through this store could.
            try {
              await fs.link(currentPath, newPath)
            } catch (err) {
              if (isNodeError(err) && err.code === 'EEXIST') {
                throw new ContentStoreError(
                  `Entry with slug "${safeNewSlug}" already exists in collection "${collectionPath}"`,
                  'VALIDATION',
                )
              }
              throw err
            }
            await fs.unlink(currentPath)

            // Update the LIVE index — lookup and mutation in one synchronous window,
            // since a concurrent rebuild may swap instances across awaits.
            const newRelativePath = path.relative(this.root, newPath) as PhysicalPath
            const liveIndex = this._idIndex
            const entryId = liveIndex.findByPath(currentRelPath)
            if (entryId) {
              liveIndex.updatePath(entryId, newRelativePath)
            }
            await this.recordOwnMutation(liveIndex)

            // Return new logical path
            return { newPath: `${collectionPath}/${safeNewSlug}` as LogicalPath }
          },
        )
        if (typeof outcome !== 'symbol') return outcome
      }
      // Ten completed foreign mutations landed in our acquisition gaps in a
      // row — treat as contention and let the caller reload + retry.
      throw new ContentConflictError()
    })
  }

  /**
   * List all entries in a collection tree (including subcollections).
   * For example, passing 'content/data-catalog' returns entries from
   * 'content/data-catalog', 'content/data-catalog/partner-a', etc.
   * Returns array of entry metadata (relativePath, collection, slug).
   * Returns empty array if the collection doesn't exist.
   */
  /**
   * Resolve a schema collection referenced by name or logical path.
   *
   * Accepts either a full logical path ("content/authors") or a bare
   * collection name ("authors") — the contract reference fields use for
   * `collections: [...]` (see README). This is the single normalization
   * point shared by reference-option loading and reference validation so
   * the dropdown and the write boundary can never disagree.
   *
   * CAVEAT: the bare-name fallback matches on the LAST path segment and
   * returns the first hit in schema order — with two collections sharing a
   * leaf name (e.g. content/blog/posts and content/news/posts), a bare
   * 'posts' is ambiguous. Use the full logical path in schemas that nest
   * same-named collections.
   */
  resolveCollectionItem(collectionPath: string): FlatSchemaItem | undefined {
    // The schema index uses normalized logical paths like "content/authors"
    const normalized = normalizeFilesystemPath(collectionPath as LogicalPath)
    let item = this.schemaIndex.get(normalized)

    // If not found by full path, try matching the last segment
    // (handles cases where caller passes "posts" instead of "content/posts")
    if (!item) {
      for (const schemaItem of this.schemaIndex.values()) {
        if (schemaItem.type === 'collection') {
          const lastSegment = schemaItem.logicalPath.split('/').pop()
          if (lastSegment === collectionPath) {
            item = schemaItem
            break
          }
        }
      }
    }

    return item && item.type === 'collection' ? item : undefined
  }

  async getCollectionEntryPaths(collectionPath: LogicalPath): Promise<
    Array<{
      relativePath: PhysicalPath
      collection: LogicalPath
      slug: Slug
    }>
  > {
    const idIndex = await this.idIndex()

    // Return empty array if collection doesn't exist or isn't a collection
    const collection = this.resolveCollectionItem(collectionPath)
    if (!collection) {
      return []
    }

    // Get entries from this collection and all subcollections via tree traversal
    const treeEntries = idIndex.getEntriesInCollectionTree(collection.logicalPath)

    // Filter and map to required format
    const entries: Array<{
      relativePath: PhysicalPath
      collection: LogicalPath
      slug: Slug
    }> = []

    for (const location of treeEntries) {
      if (location.type === 'entry' && location.slug && location.collection) {
        entries.push({
          relativePath: location.relativePath,
          collection: location.collection,
          slug: location.slug,
        })
      }
    }

    return entries
  }

  /**
   * Resolve every `reference` field in `data` against `fields`, returning a copy.
   *
   * This is what `read()` applies automatically (unless `resolveReferences: false`), exposed
   * so BATCH surfaces can opt into the same resolution without duplicating the walk: the
   * listing primitives in content-listing.ts and content-tree.ts read entry files straight
   * off disk and never touch this store, so before this existed a `reference` field reached
   * `listEntries()`/`buildContentTree()` callers as a bare id string or `null`.
   *
   * Pass one {@link ReferenceResolveCache} across a whole batch so a target referenced by
   * many entries is read once rather than once per referencing entry. Omit `cache` and the
   * behavior is exactly what `read()` has always done, unmemoized.
   *
   * **Path ACLs are not consulted for the targets.** Resolution goes through this store's
   * own `read()`, below the per-entry permission check in content-reader.ts — so a resolved
   * target may be an entry the caller could not `read()` directly. That is pre-existing
   * `read()` behavior, matched here on purpose so one rule covers both; see the
   * `resolveReferences` option in content-listing.ts for the note adopters see.
   */
  public async resolveReferences(
    data: Record<string, unknown>,
    fields: EntrySchema,
    cache?: ReferenceResolveCache,
  ): Promise<Record<string, unknown>> {
    return this.resolveReferencesInData(data, fields, cache)
  }

  /**
   * Recursively resolve reference fields in data.
   * This traverses objects, arrays, and blocks to find and resolve all reference fields.
   */
  private async resolveReferencesInData(
    data: Record<string, unknown>,
    fields: EntrySchema,
    cache?: ReferenceResolveCache,
  ): Promise<Record<string, unknown>> {
    const resolved = { ...data }
    const idIndex = await this.idIndex()

    for (const field of fields) {
      // Inline groups are transparent — recurse into their children at the same data level
      if (field.type === 'group') {
        const groupResolved = await this.resolveReferencesInData(
          resolved,
          (field as InlineGroupFieldConfig).fields,
          cache,
        )
        Object.assign(resolved, groupResolved)
        continue
      }

      const value = data[field.name]

      if (field.type === 'reference') {
        // Whether this reference EMBEDS its target (wants the target's body) or merely LINKS
        // to it is a property of the field, declared once in the schema -- not of the call,
        // which routinely contains both kinds at once. See ReferenceFieldConfig.includeBody.
        const includeBody = (field as ReferenceFieldConfig).includeBody === true
        // Single reference
        if (typeof value === 'string' && value) {
          resolved[field.name] = await this.resolveSingleReference(
            value,
            idIndex,
            includeBody,
            cache,
          )
        }
        // Array of references (list: true)
        else if (field.list && Array.isArray(value)) {
          resolved[field.name] = await Promise.all(
            value.map((id) =>
              typeof id === 'string'
                ? this.resolveSingleReference(id, idIndex, includeBody, cache)
                : null,
            ),
          )
        }
      }
      // Recursively handle nested objects
      else if (field.type === 'object' && value) {
        const objectField = field as ObjectFieldConfig
        if (!objectField.fields) continue
        if (objectField.list && Array.isArray(value)) {
          resolved[field.name] = await Promise.all(
            value.map((item) =>
              typeof item === 'object' && item !== null
                ? this.resolveReferencesInData(
                    item as Record<string, unknown>,
                    objectField.fields,
                    cache,
                  )
                : item,
            ),
          )
        } else if (typeof value === 'object') {
          resolved[field.name] = await this.resolveReferencesInData(
            value as Record<string, unknown>,
            objectField.fields,
            cache,
          )
        }
      }
      // Recursively handle blocks
      else if (field.type === 'block' && Array.isArray(value)) {
        const blockField = field as BlockFieldConfig
        resolved[field.name] = await Promise.all(
          (value as unknown[]).map(async (block) => {
            const b = block as Record<string, unknown>
            if (!b || typeof b.value !== 'object') return block
            const template = blockField.templates.find((t) => t.name === b.template)
            if (!template) return block

            return {
              ...b,
              value: await this.resolveReferencesInData(
                b.value as Record<string, unknown>,
                template.fields,
                cache,
              ),
            }
          }),
        )
      }
    }

    return resolved
  }

  /**
   * Resolve a single reference ID to full entry data, memoized when a batch cache is
   * supplied. Without a cache this is a straight pass-through to the uncached path, so
   * `read()` behaves exactly as it always has.
   *
   * Every occurrence gets its OWN deep copy, even on a cache hit. Without that, the memo
   * would hand one shared object to all 40 entries referencing the same block — a mutation
   * in one caller's `extract` (truncating a body for a search index, deleting a field) would
   * silently rewrite it for every sibling, and both `list: true` elements of `[id, id]` would
   * be the same instance. The copy is what keeps the cache a pure performance optimization
   * instead of a semantic change.
   *
   * Note the uncached path is NOT the clean baseline it looks like. For a json/yaml target it
   * genuinely reparses fresh per occurrence, but for md/mdx gray-matter serves `data` from a
   * process-global content-keyed cache, so `resolveSingleReferenceOnce`'s top-level spread
   * severs exactly one level and NESTED frontmatter objects alias across occurrences, calls and
   * requests. That is pre-existing `read()` behavior and out of scope here — deliberately, since
   * touching it would change `read()` — but it means the cached path is the safer of the two,
   * not a relaxation of a guarantee the uncached one provides. See
   * `.claude/future-tasks/graymatter-cache-shared-frontmatter.md`.
   *
   * What the copy costs, measured rather than assumed (2000 occurrences of one target, local
   * disk, so every read hits the page cache — the friendliest possible case for NOT caching):
   * a snippet-sized target is ~63x cheaper to clone than to re-read-and-parse, while a 265KB
   * JSON target is ~0.8x, i.e. cloning is marginally SLOWER than reparsing it. So the win is
   * large in the case this exists for and roughly a wash at the pathological end, never a
   * blow-up. Two things keep the bad end narrow: an md/mdx target resolves to its FRONTMATTER
   * only *unless the field sets `includeBody`* (`read()` puts the body on `doc.body`, which
   * `resolveSingleReferenceOnce` spreads in only for an embedding field), so by default body
   * size is irrelevant no matter how long the document and only a genuinely huge JSON/YAML
   * target reaches the wash. **`includeBody: true` is the case that CAN reach it on markdown**:
   * the body then sits inside the memoized object and is cloned once per referencing entry, so
   * a long document embedded by many pages pays that repeatedly — the reason `includeBody`
   * exists as an opt-in per field rather than as resolution's default. And in the deployment this
   * targets, content lives on EFS/NFS where the syscall the memo removes dominates parse and
   * clone alike, which the local-disk numbers above understate badly. Correctness is the
   * reason for the copy regardless; the numbers are here so nobody has to re-derive them
   * before touching this.
   */
  private resolveSingleReference(
    id: string,
    idIndex: ContentIdIndex,
    includeBody: boolean,
    cache?: ReferenceResolveCache,
  ): Promise<Record<string, unknown> | null> {
    if (!cache) return this.resolveSingleReferenceUncached(id, idIndex, includeBody)
    // The key carries `includeBody`, not just the id: two fields can reference the SAME target
    // with different settings, and sharing one entry between them would make the shape depend
    // on which field the walk reached first -- the traversal-order nondeterminism the
    // per-occurrence copy already exists to prevent.
    const key = includeBody ? `${id}:body` : id
    let pending = cache.get(key)
    if (!pending) {
      // Store the in-flight promise, and do it with no `await` in between: the whole point is
      // that concurrent lookups from one Promise.all batch find it and collapse onto a single
      // read. Memoizing the promise also keeps the self-healing retry below shared rather than
      // repeated — see ReferenceResolveCache for why misses are cached too.
      pending = this.resolveSingleReferenceUncached(id, idIndex, includeBody)
      cache.set(key, pending)
    }
    // The cached promise always has this handler attached, so it is never an unhandled
    // rejection; entry data is plain parsed JSON/YAML/frontmatter, so it is always cloneable
    // (verified against real parser output incl. `!!timestamp` Dates — the sole shape not
    // preserved exactly is a `!!binary` Buffer, which clones to a plain Uint8Array).
    return pending.then((resolved) => (resolved === null ? null : structuredClone(resolved)))
  }

  /**
   * Returns null if the reference is invalid or missing.
   * Includes id, slug, and collection fields for debugging.
   *
   * Suspicious results (ID missing from the index, or an index hit whose file
   * is gone) trigger one forced index refresh and a retry — self-healing for
   * mutations by other processes inside the marker's residual windows. The
   * forced refresh itself is throttled (see refreshIndexForSuspiciousLookup),
   * but the retry against the live index always runs regardless of whether
   * this call won the throttle race: when a `list: true` reference array is
   * resolved via Promise.all, every miss shares the same stale snapshot, and
   * idIndex() dedupes concurrent builds — so a sibling call that wins the
   * throttle and rebuilds heals every other miss in the same batch, not just
   * the first.
   *
   * A {@link ReferenceResolveCache} sits ABOVE this, never inside it, so every
   * distinct id still runs the full refresh-and-retry above. What a cache changes
   * is only that repeats of the SAME id in one batch share that one attempt's
   * outcome instead of each getting an independent throw of the dice.
   */
  private async resolveSingleReferenceUncached(
    id: string,
    idIndex: ContentIdIndex,
    includeBody: boolean,
  ): Promise<Record<string, unknown> | null> {
    const first = await this.resolveSingleReferenceOnce(id, idIndex, includeBody)
    if (first !== STALE_LOOKUP) return first
    // Force a rebuild (throttled). Even when this caller loses the throttle,
    // retry against the live index: a sibling lookup in the same batch may have
    // won it and invalidated/rebuilt (idIndex() dedupes in-flight builds), so
    // every miss in a Promise.all batch heals, not just the first.
    await this.refreshIndexForSuspiciousLookup()
    const second = await this.resolveSingleReferenceOnce(id, await this.idIndex(), includeBody)
    return second === STALE_LOOKUP ? null : second
  }

  private async resolveSingleReferenceOnce(
    id: string,
    idIndex: ContentIdIndex,
    includeBody: boolean,
  ): Promise<Record<string, unknown> | null | typeof STALE_LOOKUP> {
    try {
      const location = idIndex.findById(id)

      if (!location) return STALE_LOOKUP
      if (location.type !== 'entry' || !location.collection || !location.slug) {
        return null
      }

      // Read the referenced entry WITHOUT resolving its references (prevent infinite loops)
      const doc = await this.read(location.collection, location.slug, {
        resolveReferences: false,
      })

      // `urlPath` is what makes a resolved reference linkable. Without it, a page rendering
      // "see also: <Target>" as a real anchor had no way to get an href from the resolution
      // it had already paid for — one adopter ran a SECOND full listEntries pass over the
      // whole tree purely to build a contentId -> url table, and set `resolveReferences:
      // false` on pages where paying for both was worse than hand-rolling it.
      //
      // Deliberately `computeEntryUrl` (utils/entry-url.ts), the same forward
      // collection+slug -> url rule `listEntries` publishes as `item.urlPath` and
      // `entry-link-resolver.ts` already uses for `entry:ID` links — NOT the reverse
      // url -> entry resolver in url-path-resolver.ts. The two agree today (the reverse
      // resolver was taught to skip its direct-entry candidate for a literal `index` slug,
      // precisely so it stops answering at URLs this rule never emits — see
      // .claude/future-tasks/resolved/url-resolver-index-entry-extra-url.md), but the
      // direction still matters: this is the surface that DEFINES an entry's URL, and
      // sourcing it from the resolver that consumes that definition would invert the
      // dependency and let any future divergence propagate into every resolved reference.
      //
      // The assembly itself — data, then the embedded body, then the reserved metadata — is
      // `buildResolvedReference`'s job rather than this function's, because the editor's
      // live-preview endpoint (api/resolve-references.ts) builds the same object and the two
      // had already drifted. That doc comment carries the reasoning for the ordering.
      //
      // `'body' in doc` is what narrows the ContentDocument union to its markdown variant, so
      // `doc.body`/`doc.bodyFieldName` are reachable at all — a type guard, not a redundant
      // runtime check. Only a field that asked to EMBED its target passes a body at all.
      const bodyForEmbed =
        includeBody && 'body' in doc ? { fieldName: doc.bodyFieldName, value: doc.body } : undefined

      return buildResolvedReference(
        doc.data,
        {
          id,
          slug: location.slug,
          collection: location.collection,
          urlPath: computeEntryUrl(location.collection, location.slug, this.contentRootName),
        },
        bodyForEmbed,
      )
    } catch (error) {
      // Index hit but the file is gone — the typical symptom of an external
      // rename/delete this store hasn't observed yet.
      if (isNodeError(error) && error.code === 'ENOENT') return STALE_LOOKUP
      console.error(`Failed to resolve reference ${id}:`, error)
      return null
    }
  }
}
