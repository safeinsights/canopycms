import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import matter from 'gray-matter'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { atomicWriteFile } from './utils/atomic-write'
import { withLock } from './utils/async-mutex'
import { findBodyFieldName } from './utils/body-field'
import type {
  BlockFieldConfig,
  ContentFormat,
  EntrySchema,
  FlatSchemaItem,
  EntryTypeConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
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
import { filePathExists } from './utils/fs'
import { asRecord, getFormatExtension } from './utils/format'
import {
  normalizeFilesystemPath,
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

export type WriteInput =
  | { format: 'md' | 'mdx'; data?: Record<string, unknown>; body: string; expectedVersion?: number }
  | { format: 'json'; data: Record<string, unknown>; expectedVersion?: number }
  | { format: 'yaml'; data: Record<string, unknown>; expectedVersion?: number }

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
  constructor() {
    super('Content was modified by another editor')
    this.name = 'ContentConflictError'
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
}

const DEFAULT_INDEX_FRESHNESS_INTERVAL_MS = 1000
/**
 * At most one suspicious-lookup forced rescan per store per this window, so
 * genuinely dangling IDs cannot trigger a full tree scan on every lookup.
 */
const FORCED_REFRESH_MIN_INTERVAL_MS = 5000

/** Internal sentinel: a lookup result that suggests this store's index is stale. */
const STALE_LOOKUP = Symbol('stale-index-lookup')

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
  /** In-flight index build, shared by concurrent idIndex() callers so scans never interleave. */
  private indexBuild: Promise<unknown> | null = null

  constructor(root: string, flatSchema: FlatSchemaItem[], options: ContentStoreOptions = {}) {
    this.root = path.resolve(root)
    this.contentRootName = options.contentRootName || 'content'
    this.indexFreshnessIntervalMs =
      options.indexFreshnessIntervalMs ?? DEFAULT_INDEX_FRESHNESS_INTERVAL_MS
    this.schemaIndex = new Map(flatSchema.map((item) => [item.logicalPath, item]))
    this._idIndex = new ContentIdIndex(this.root)
    registerContentIndexForInvalidation(this.root, this)
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
   * Find the file in `dir` whose filename embeds `id`.
   * Returns its root-relative path, or null if no such file (or no such dir).
   */
  private async findEntryPathById(dir: string, id: string): Promise<string | null> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null
      throw err
    }
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (extractIdFromFilename(entry.name) === id) {
        return path.relative(this.root, path.join(dir, entry.name))
      }
    }
    return null
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
    entryTypeName?: string
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
    // NOTE: The API layer always resolves paths via resolvePath(), which returns
    // the parent collection directly, so this branch may only fire on direct
    // ContentStore usage (e.g., store.read('content/home', '')).
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

        await fs.mkdir(path.dirname(absolutePath), { recursive: true })

        // OCC: if caller supplied a version token, reject stale writes
        if (input.expectedVersion !== undefined) {
          try {
            const existing = await fs.stat(absolutePath)
            if (existing.mtimeMs !== input.expectedVersion) {
              throw new ContentConflictError()
            }
          } catch (err) {
            if (err instanceof ContentConflictError) throw err
            if (isNodeError(err) && err.code === 'ENOENT') {
              // File doesn't exist yet — first write, skip version check
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
          const actualRelPath = await this.findEntryPathById(path.dirname(absolutePath), existingId)
          const indexedRelPath = this._idIndex.findById(existingId)?.relativePath ?? null
          if (actualRelPath !== null && actualRelPath !== indexedRelPath) {
            throw new ContentConflictError()
          }
        }

        // Serialize content string
        let content: string
        if (input.format === 'json') {
          content = `${JSON.stringify(input.data ?? {}, null, 2)}\n`
        } else if (input.format === 'yaml') {
          content = yamlStringify(input.data ?? {})
        } else {
          content = matter.stringify(input.body, input.data ?? {})
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
              // Slug changed — remember the orphaned old path to delete below
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

    // Validate new slug format (Slug branded type guarantees lowercase alphanumeric+hyphens via parseSlug)
    validateSlug(newSlug)
    const safeNewSlug = newSlug.replace(/^\/+/, '')
    if (!safeNewSlug) {
      throw new ContentStoreError('New slug cannot be empty', 'VALIDATION')
    }

    // If slugs are the same, no-op
    if (currentSlug === safeNewSlug) {
      return { newPath: `${collectionPath}/${currentSlug}` as LogicalPath }
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
   * Recursively resolve reference fields in data.
   * This traverses objects, arrays, and blocks to find and resolve all reference fields.
   */
  private async resolveReferencesInData(
    data: Record<string, unknown>,
    fields: EntrySchema,
  ): Promise<Record<string, unknown>> {
    const resolved = { ...data }
    const idIndex = await this.idIndex()

    for (const field of fields) {
      // Inline groups are transparent — recurse into their children at the same data level
      if (field.type === 'group') {
        const groupResolved = await this.resolveReferencesInData(
          resolved,
          (field as InlineGroupFieldConfig).fields,
        )
        Object.assign(resolved, groupResolved)
        continue
      }

      const value = data[field.name]

      if (field.type === 'reference') {
        // Single reference
        if (typeof value === 'string' && value) {
          resolved[field.name] = await this.resolveSingleReference(value, idIndex)
        }
        // Array of references (list: true)
        else if (field.list && Array.isArray(value)) {
          resolved[field.name] = await Promise.all(
            value.map((id) =>
              typeof id === 'string' ? this.resolveSingleReference(id, idIndex) : null,
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
                ? this.resolveReferencesInData(item as Record<string, unknown>, objectField.fields)
                : item,
            ),
          )
        } else if (typeof value === 'object') {
          resolved[field.name] = await this.resolveReferencesInData(
            value as Record<string, unknown>,
            objectField.fields,
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
              ),
            }
          }),
        )
      }
    }

    return resolved
  }

  /**
   * Resolve a single reference ID to full entry data.
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
   */
  private async resolveSingleReference(
    id: string,
    idIndex: ContentIdIndex,
  ): Promise<Record<string, unknown> | null> {
    const first = await this.resolveSingleReferenceOnce(id, idIndex)
    if (first !== STALE_LOOKUP) return first
    // Force a rebuild (throttled). Even when this caller loses the throttle,
    // retry against the live index: a sibling lookup in the same batch may have
    // won it and invalidated/rebuilt (idIndex() dedupes in-flight builds), so
    // every miss in a Promise.all batch heals, not just the first.
    await this.refreshIndexForSuspiciousLookup()
    const second = await this.resolveSingleReferenceOnce(id, await this.idIndex())
    return second === STALE_LOOKUP ? null : second
  }

  private async resolveSingleReferenceOnce(
    id: string,
    idIndex: ContentIdIndex,
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

      return {
        id,
        slug: location.slug,
        collection: location.collection,
        ...doc.data,
      }
    } catch (error) {
      // Index hit but the file is gone — the typical symptom of an external
      // rename/delete this store hasn't observed yet.
      if (isNodeError(error) && error.code === 'ENOENT') return STALE_LOOKUP
      console.error(`Failed to resolve reference ${id}:`, error)
      return null
    }
  }
}
