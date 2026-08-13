/**
 * Schema Store - handles reading and writing .collection.json files.
 *
 * This module provides CRUD operations for collection schema metadata:
 * - Create/update/delete collections
 * - Add/update/remove entry types
 * - Update ordering of items within collections
 *
 * All mutations are branch-specific (like content edits).
 *
 * ## Concurrency
 *
 * `.collection.json` is read-modify-written by every mutator below, and is
 * mutated cross-host: two warm Lambda containers (or a Lambda + the EC2
 * worker) on EFS can both read the same pre-mutation file and have the
 * second write silently clobber the first. This deviates from the standard
 * 3-layer recipe in docs/concurrency.md in one deliberate way: NO OCC
 * `version`/`writeId` fields go into `.collection.json` itself, and no
 * lockfile lives in the content tree. Two reasons:
 *
 * - `.collection.json` is an adopter-visible, git-committed content file.
 *   Rebases rewrite it wholesale from upstream, so a `version` counter would
 *   be meaningless (and actively misleading) the moment a rebase lands.
 * - A lockfile crash-leftover inside the content tree would be swept into
 *   `git add .` at publish time — a `.lock` or `.tmp` file has no business
 *   ending up in a commit an adopter reviews.
 *
 * Protection is instead: layer 1 ({@link withLock}) + layer 3
 * ({@link withOccFileLock}) on a single COARSE per-branch SURROGATE lock
 * path OUTSIDE the content tree — `{branchRoot}/.canopy-meta/schema` (see
 * `withSchemaLock`). One lock covers every schema mutation on the branch,
 * including multi-file mutations (`createCollection` writes the new child's
 * meta AND the parent's). Layer 2 (OCC read-back) is skipped entirely since
 * there is no version field to check; layer 4 (generation marker) is used
 * separately, for the schema CACHE, not for this write path.
 *
 * Accepted residual: `deleteBranch` does NOT take this lock before its
 * recursive `rm` — an in-flight schema write can race a concurrent branch
 * deletion (the write's `rm`/rename can hit ENOTEMPTY or land in a
 * half-deleted tree). This mirrors the same residual documented on
 * `BranchMetadataFileManager.save()` in branch-metadata.ts and is not closed
 * here either; see `withSchemaLock`'s doc comment for the phantom-guard that
 * IS in place for the common ordering (branch already gone before this call
 * ever starts).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../utils/atomic-write'
import { withLock } from '../utils/async-mutex'
import { createDebugLogger } from '../utils/debug'
import { getErrorMessage, isNotFoundError } from '../utils/error'
import { withOccFileLock, OccWriteConflictError } from '../utils/occ-json-write'

import type { ContentFormat } from '../config'
import type { EntrySchemaRegistry } from './types'
import { resolveCollectionPath } from '../content-id-index'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { generateId, isValidId } from '../id'
import {
  createLogicalPath,
  normalizeCollectionPath as stripContentRootPrefix,
  validateAndNormalizePath,
} from '../paths'
import type { LogicalPath, ContentId } from '../paths/types'
import type { CanopyServices } from '../services'

// Re-export types from client-safe module
export type {
  CreateCollectionInput,
  CreateEntryTypeInput,
  UpdateCollectionInput,
  UpdateEntryTypeInput,
} from './schema-store-types'

// Import types for internal use
import type {
  CreateCollectionInput,
  CreateEntryTypeInput,
  UpdateCollectionInput,
  UpdateEntryTypeInput,
} from './schema-store-types'

/**
 * Raw collection meta as stored in .collection.json
 */
interface CollectionMetaFile {
  name: string
  label?: string
  entries?: Array<{
    name: string
    label?: string
    format: ContentFormat
    schema: string
    default?: boolean
    maxItems?: number
  }>
  order?: string[]
}

/**
 * Raw root collection meta as stored in content/.collection.json
 */
interface RootCollectionMetaFile {
  label?: string
  entries?: Array<{
    name: string
    label?: string
    format: ContentFormat
    schema: string
    default?: boolean
    maxItems?: number
  }>
  order?: string[]
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

/** Max length for names and slugs (filesystem path safety) */
const MAX_NAME_LENGTH = 64
/** Max length for labels */
const MAX_LABEL_LENGTH = 128

/**
 * Safe pattern for names and slugs that become filesystem path segments.
 * Blocks path traversal (".."), separators, dots, and other unsafe characters.
 * Keep in sync with the client-side validation in the schema editor components.
 */
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const SAFE_NAME_MESSAGE =
  'must start with a letter and contain only lowercase letters, numbers, and hyphens'

const entryTypeInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .regex(SAFE_NAME_PATTERN, `Entry type name ${SAFE_NAME_MESSAGE}`),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  format: z.enum(['md', 'mdx', 'json', 'yaml']),
  schema: z.string().min(1),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

const createCollectionInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .regex(SAFE_NAME_PATTERN, `Collection name ${SAFE_NAME_MESSAGE}`),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  parentPath: z.string().optional(),
  entries: z.array(entryTypeInputSchema).min(1, 'Collection must have at least one entry type'),
})

const updateCollectionInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .regex(SAFE_NAME_PATTERN, `Collection name ${SAFE_NAME_MESSAGE}`)
    .optional(),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  // Directory name (e.g., "posts" in "posts.{id}/")
  slug: z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .regex(SAFE_NAME_PATTERN, `Slug ${SAFE_NAME_MESSAGE}`)
    .optional(),
  order: z.array(z.string()).optional(),
})

const updateEntryTypeInputSchema = z.object({
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  format: z.enum(['md', 'mdx', 'json', 'yaml']).optional(),
  schema: z.string().min(1).optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

// ============================================================================
// SchemaOps Class
// ============================================================================

const log = createDebugLogger({ prefix: 'SchemaOps' })

/**
 * Thrown when a schema mutation cannot proceed because the per-branch
 * surrogate schema lock (see the module doc comment and `withSchemaLock`) is
 * held by another in-flight mutation, or because the branch has been deleted
 * out from under an in-flight call. Callers (api/schema.ts) translate this
 * into a 409 so the editor can retry rather than surfacing a raw 400.
 */
export class SchemaStoreBusyError extends Error {
  constructor(message = 'Schema is being modified by another operation, try again') {
    super(message)
    this.name = 'SchemaStoreBusyError'
  }
}

export class SchemaOps {
  /** Branch root. Resolved once so the lock path is stable. */
  private readonly branchRoot: string
  /**
   * The content root's path relative to `branchRoot` — "content" normally, but
   * "cms/content" for a multi-segment `config.contentRoot`. `flattenSchema` uses
   * the configured contentRoot as the base of every logical path, so
   * root-collection detection must compare against this, NOT
   * `path.basename(contentRoot)` (which would yield "content" for "cms/content"
   * and never match the root collection's logical path).
   */
  private readonly contentRootName: string
  /** Coarse per-branch surrogate lock path — see the module doc comment. */
  private readonly schemaLockPath: string

  constructor(
    private readonly contentRoot: string,
    private readonly entrySchemaRegistry: EntrySchemaRegistry,
    private readonly services?: CanopyServices,
    branchRoot?: string,
  ) {
    // Prefer an explicitly supplied branchRoot. Deriving it as dirname(contentRoot)
    // is only correct when config.contentRoot is a single segment, and
    // `contentRoot: 'content/posts'` is documented as valid (config/helpers.ts) —
    // for that, dirname() lands one level too deep and would put the schema lock
    // and .canopy-meta in the wrong directory. Callers that know the branch root
    // (api/schema.ts, api/entries.ts) pass it; the fallback keeps the derivation
    // identical to before for callers that don't.
    const resolvedContentRoot = path.resolve(contentRoot)
    this.branchRoot = branchRoot ? path.resolve(branchRoot) : path.dirname(resolvedContentRoot)
    this.contentRootName = path
      .relative(this.branchRoot, resolvedContentRoot)
      .split(path.sep)
      .join('/')
    this.schemaLockPath = path.join(this.branchRoot, '.canopy-meta', 'schema')
  }

  // --------------------------------------------------------------------------
  // Schema Lock
  // --------------------------------------------------------------------------

  /**
   * Serialize an entire read-modify-write schema mutation behind the coarse
   * per-branch surrogate lock described in the module doc comment. Layers,
   * outermost to innermost (same structure as
   * `BranchMetadataFileManager.save()` — see branch-metadata.ts):
   *
   * 1. {@link withLock} — in-process FIFO mutex, deterministic same-process
   *    serialization.
   * 2. {@link withOccFileLock} — server-enforced, cross-process/cross-host
   *    mutual exclusion (proper-lockfile, mkdir-based), immune to NFS client
   *    dentry/attribute caching.
   *
   * NOT re-entrant: callers must never invoke this (directly or via a public
   * mutator) from inside a callback already running under it — `withLock`
   * would deadlock waiting on itself. This is why `updateOrderInner` calls
   * `updateCollectionInner` directly instead of the public `updateCollection`.
   *
   * Phantom-resurrection guard: `branchRoot` can be removed by a concurrent
   * `deleteBranch` between the caller resolving its BranchContext and this
   * call reaching its own lock acquisition. `withOccFileLock`'s own
   * `mkdir({recursive:true})` on the lock directory would otherwise silently
   * recreate `.canopy-meta/` inside a directory tree that no longer exists
   * anywhere else. Checking BEFORE the lock (not after) fails fast without
   * paying for an acquisition on a doomed mutation.
   *
   * Residual window (accepted, same shape as branch-metadata.ts's): a call
   * that passes this check can still race a `deleteBranch` `rm` that starts
   * moments later and is still mid-flight when this call's write lands,
   * resurrecting the tree. `deleteBranch` does not take this lock at all
   * (see the module doc comment), so that race is not closed here either.
   *
   * Translation happens ONLY at this boundary: inner code always sees the
   * raw {@link OccWriteConflictError} bubble up to here (never catches or
   * re-translates it itself).
   */
  private async withSchemaLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await fs.stat(this.branchRoot)
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new SchemaStoreBusyError('Branch no longer exists')
      }
      throw err
    }

    try {
      return await withLock(this.schemaLockPath, () => withOccFileLock(this.schemaLockPath, fn))
    } catch (err) {
      if (err instanceof OccWriteConflictError) {
        throw new SchemaStoreBusyError()
      }
      throw err
    }
  }

  // --------------------------------------------------------------------------
  // Cache Invalidation
  // --------------------------------------------------------------------------

  /**
   * Invalidate schema cache for this branch after mutations, then eagerly
   * re-resolve on THIS host.
   *
   * The eager re-resolve is the durable-snapshot window-E mitigation (see
   * BranchSchemaCache's class docs): the mutating host's own scan is
   * necessarily coherent with the mutation it just made, whereas the
   * editor's follow-up schema read is a separate Lambda invocation with no
   * container affinity — exactly the lazy foreign-host pull whose scan can
   * be served from stale NFS caches and durably persist a fresh-token
   * snapshot of pre-mutation schema. Regen failures are logged and
   * swallowed (mirroring BranchRegistry.invalidate()): the bump alone
   * already restored correctness for every future reader, and a mutation
   * that leaves no valid schema behind (e.g. deleting the last collection)
   * must not fail the request over an uncacheable resolve.
   *
   * Uses `resolveAndPersist()`, NOT `getSchema()`: getSchema()'s cache-read
   * fast path can return a snapshot a DIFFERENT, concurrent host just wrote
   * (its own eager re-resolve, raced against this one, embedding the
   * now-current marker token over ITS OWN stale-NFS-cache scan) — silently
   * skipping the one scan this call exists to guarantee. resolveAndPersist()
   * never reads the cache file, so it cannot be short-circuited that way.
   * See BranchSchemaCache.resolveAndPersist()'s doc comment for the full race.
   */
  private async invalidateSchemaCache(): Promise<void> {
    if (!this.services) return
    await this.services.branchSchemaCache.invalidate(this.branchRoot)
    try {
      await this.services.branchSchemaCache.resolveAndPersist(
        this.branchRoot,
        this.entrySchemaRegistry,
        this.contentRootName,
      )
    } catch (err) {
      log.warn('schema-cache', `Eager schema re-resolve after invalidation failed`, {
        branchRoot: this.branchRoot,
        error: getErrorMessage(err),
      })
    }
  }

  /**
   * Collection directory mutations (create/rename/delete) change paths the
   * ContentId index tracks — collection dirs are indexed as {slug}.{id}/, and
   * a dir rename re-paths every entry beneath it. Invalidate ContentStore ID
   * indexes for this branch: in-process via the registry and cross-process via
   * the on-disk generation marker. ContentStores (and the marker) are rooted
   * at the branch root, the contentRoot's parent.
   *
   * Uses the combined invalidateBranchContentCaches() helper rather than the
   * content-index-only invalidateContentIndexesDurable(): every call site here
   * is already followed by its own invalidateSchemaCache() call below, so this
   * double-bumps the schema generation marker. That's harmless (bumps are
   * idempotent hints, not counters) and keeps this call uniform with the other
   * bulk-mutation call sites that use the combined helper.
   */
  private async invalidateContentIdIndexes(): Promise<void> {
    await invalidateBranchContentCaches(this.branchRoot)
  }

  // --------------------------------------------------------------------------
  // Path Normalization
  // --------------------------------------------------------------------------

  /**
   * The single normalisation boundary for logical collection paths entering
   * this class. Every public method that accepts a logical collection path
   * (or, for `createCollection`, `input.parentPath`) calls this exactly once
   * before doing anything else with the path — that is the whole fix for the
   * "Collection not found" bug: `flattenSchema` (branch-schema-cache.ts)
   * produces content-root-prefixed logical paths (e.g. "content/posts", or
   * "cms/content/posts" for a multi-segment `contentRoot: 'cms/content'`),
   * the editor round-trips those straight back into every mutator
   * (`CollectionEditor.tsx` passes `editingCollection.logicalPath` as-is),
   * but `resolveCollectionPath(this.contentRoot, ...)` treats its second
   * argument as relative to `this.contentRoot` — which already embeds the
   * content-root segment(s). A prefixed path therefore resolved one level
   * too deep and was reported as not found. `updateCollectionInner` used to
   * strip the prefix itself (the only mutator that did); that bespoke strip
   * is gone now that every entry point normalises here instead.
   *
   * Idempotent and prefix-only: strips one leading `"{contentRootName}/"` if
   * present (exact string match against the full, possibly multi-segment,
   * `contentRootName` — never `path.basename()`, which would break a
   * multi-segment root like "cms/content"), otherwise returns the path
   * unchanged. So both prefixed (production/editor) and unprefixed
   * (existing store tests, adopters calling SchemaOps directly) input work,
   * and normalising an already-normalised path is a no-op — safe to call
   * from a method that receives a path some other method already
   * normalised. Deliberately does NOT touch the bare root-collection
   * sentinel (`collectionPath === this.contentRootName`, no trailing
   * segment): that has no trailing "/" to match, so it passes through
   * unchanged and the `=== this.contentRootName` checks in
   * `updateCollectionInner`/`updateOrderInner` keep working.
   *
   * A future public method that accepts a logical collection path must call
   * this first, the same way every existing one does — that is the
   * "safe by construction" contract this boundary is meant to provide.
   */
  private normalizeCollectionPath(collectionPath: LogicalPath): LogicalPath {
    return createLogicalPath(stripContentRootPrefix(collectionPath, this.contentRootName))
  }

  // --------------------------------------------------------------------------
  // Validation Helpers
  // --------------------------------------------------------------------------

  /**
   * Validate that a schema reference exists in the registry
   */
  validateSchemaReference(schemaKey: string): boolean {
    return schemaKey in this.entrySchemaRegistry
  }

  /**
   * Validate all schema references in entry types
   */
  private validateEntryTypeSchemas(entryTypes: CreateEntryTypeInput[]): {
    valid: boolean
    error?: string
  } {
    for (const entryType of entryTypes) {
      if (!this.validateSchemaReference(entryType.schema)) {
        const available = Object.keys(this.entrySchemaRegistry).join(', ')
        return {
          valid: false,
          error: `Schema reference "${entryType.schema}" not found. Available: ${available}`,
        }
      }
    }
    return { valid: true }
  }

  /**
   * Validate path to prevent traversal attacks
   */
  private validatePath(targetPath: string): {
    valid: boolean
    normalizedPath?: string
    error?: string
  } {
    const result = validateAndNormalizePath(this.contentRoot, targetPath)
    if (!result.valid) {
      return { valid: false, error: result.error || 'Invalid path' }
    }
    return { valid: true, normalizedPath: result.normalizedPath }
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------

  /**
   * Read a collection's .collection.json file
   */
  async readCollectionMeta(collectionPath: LogicalPath): Promise<CollectionMetaFile | null> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    // Resolve logical path to physical path with embedded IDs
    const physicalPath = await resolveCollectionPath(this.contentRoot, normalizedPath)
    if (!physicalPath) {
      return null
    }

    const metaPath = path.join(physicalPath, '.collection.json')
    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      return JSON.parse(content) as CollectionMetaFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Read root collection meta (content/.collection.json)
   */
  async readRootCollectionMeta(): Promise<RootCollectionMetaFile | null> {
    const metaPath = path.join(this.contentRoot, '.collection.json')
    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      return JSON.parse(content) as RootCollectionMetaFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Check if a collection is empty (has no content files or child collections)
   */
  async isCollectionEmpty(collectionPath: LogicalPath): Promise<boolean> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    const physicalPath = await resolveCollectionPath(this.contentRoot, normalizedPath)
    if (!physicalPath) {
      // Collection doesn't exist, consider it empty
      return true
    }

    try {
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })
      for (const entry of entries) {
        // Content files mean not empty
        if (entry.isFile() && entry.name !== '.collection.json') {
          return false
        }
        // Child collection directories mean not empty
        if (entry.isDirectory()) {
          try {
            await fs.access(path.join(physicalPath, entry.name, '.collection.json'))
            return false
          } catch {
            // Not a collection directory, ignore
          }
        }
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true
      }
      throw err
    }
  }

  // --------------------------------------------------------------------------
  // Write Operations
  //
  // These are plain atomic writes with NO locking of their own: every caller
  // reaches them from inside a public mutator's `withSchemaLock` critical
  // section (see the module doc comment), which is what actually protects
  // against concurrent writers. Locking here too would be redundant and
  // would mislead a reader into thinking THIS is where the safety comes
  // from.
  // --------------------------------------------------------------------------

  /**
   * Write a collection's .collection.json file
   */
  private async writeCollectionMeta(physicalPath: string, meta: CollectionMetaFile): Promise<void> {
    const metaPath = path.join(physicalPath, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await atomicWriteFile(metaPath, content)
  }

  /**
   * Write root collection meta
   */
  private async writeRootCollectionMeta(meta: RootCollectionMetaFile): Promise<void> {
    const metaPath = path.join(this.contentRoot, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await atomicWriteFile(metaPath, content)
  }

  // --------------------------------------------------------------------------
  // Collection Operations
  // --------------------------------------------------------------------------

  /**
   * Create a new collection
   */
  async createCollection(
    input: CreateCollectionInput,
  ): Promise<{ collectionPath: LogicalPath; contentId: ContentId }> {
    // Validate input
    const parseResult = createCollectionInputSchema.safeParse(input)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema references
    const schemaValidation = this.validateEntryTypeSchemas(input.entries)
    if (!schemaValidation.valid) {
      throw new Error(schemaValidation.error)
    }

    // Normalize parentPath (may be content-root-prefixed, e.g. "content/docs",
    // exactly like every other logical collection path the editor sends) —
    // see normalizeCollectionPath's doc comment for why this must happen
    // exactly once, here at the public entry point, before createCollectionInner
    // ever resolves it.
    const normalizedInput: CreateCollectionInput = input.parentPath
      ? { ...input, parentPath: this.normalizeCollectionPath(input.parentPath) }
      : input

    const result = await this.withSchemaLock(() => this.createCollectionInner(normalizedInput))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
    return result
  }

  private async createCollectionInner(
    input: CreateCollectionInput,
  ): Promise<{ collectionPath: LogicalPath; contentId: ContentId }> {
    // Determine parent directory
    let parentPhysicalPath: string
    if (input.parentPath) {
      const resolved = await resolveCollectionPath(this.contentRoot, input.parentPath)
      if (!resolved) {
        throw new Error(`Parent collection not found: ${input.parentPath}`)
      }
      parentPhysicalPath = resolved
    } else {
      parentPhysicalPath = this.contentRoot
    }

    // Generate embedded ID for new collection
    const contentId = generateId()
    const dirName = `${input.name}.${contentId}`
    const physicalPath = path.join(parentPhysicalPath, dirName)

    // Defense-in-depth (SCH-C1): the name pattern above already prevents
    // traversal, but independently assert the resolved path stays within the
    // content root before any filesystem write.
    const containment = this.validatePath(physicalPath)
    if (!containment.valid) {
      throw new Error(`Invalid collection path: ${containment.error}`)
    }

    // Create directory
    await fs.mkdir(physicalPath, { recursive: true })
    await this.invalidateContentIdIndexes()

    // Build collection meta with empty order array (required for ordering support)
    const meta: CollectionMetaFile = {
      name: input.name,
      label: input.label,
      entries: input.entries.map((et) => ({
        name: et.name,
        label: et.label,
        format: et.format,
        schema: et.schema,
        default: et.default,
        maxItems: et.maxItems,
      })),
      order: [], // Initialize with empty order array
    }

    // Write .collection.json
    await this.writeCollectionMeta(physicalPath, meta)

    // Add new collection's contentId to parent's order array
    // For root-level collections (empty parentPath), we don't update parent order
    const parentLogicalPath = input.parentPath
      ? createLogicalPath(input.parentPath)
      : createLogicalPath('')
    const parentMeta = input.parentPath ? await this.readCollectionMeta(parentLogicalPath) : null
    if (parentMeta) {
      // Initialize parent's order array if it doesn't exist
      const existingOrder = parentMeta.order ?? []
      parentMeta.order = [...existingOrder, contentId]
      await this.writeCollectionMeta(parentPhysicalPath, parentMeta)
    }

    // Build logical path
    const logicalPath = input.parentPath
      ? createLogicalPath(`${input.parentPath}/${input.name}`)
      : createLogicalPath(input.name)

    return { collectionPath: logicalPath, contentId }
  }

  /**
   * Update a collection's metadata
   */
  async updateCollection(
    collectionPath: LogicalPath,
    updates: UpdateCollectionInput,
  ): Promise<void> {
    // Validate input
    const parseResult = updateCollectionInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.updateCollectionInner(normalizedPath, updates))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  /**
   * Body of updateCollection, holding the schema lock for its full
   * read-modify-write. Called directly (not via the public `updateCollection`)
   * by `updateOrderInner` for non-root collections — `withSchemaLock` is NOT
   * re-entrant, so going through the public method there would deadlock.
   *
   * `collectionPath` here is always already normalized (content-root prefix
   * stripped, if it had one) by whichever public method reached this — either
   * `updateCollection` above or `updateOrder` via `updateOrderInner` — so this
   * no longer re-strips the prefix itself; see normalizeCollectionPath's doc
   * comment for the single boundary that owns that now.
   */
  private async updateCollectionInner(
    collectionPath: LogicalPath,
    updates: UpdateCollectionInput,
  ): Promise<void> {
    // Check if this is the root collection (path equals the configured content
    // root, e.g. "content" or "cms/content")
    if (collectionPath === this.contentRootName) {
      // Update root collection meta
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      // Root only supports label and order updates (no name)
      if (updates.label !== undefined) {
        meta.label = updates.label
      }
      if (updates.order !== undefined) {
        meta.order = updates.order
      }
      await this.writeRootCollectionMeta(meta)
      return
    }

    // Resolve path for regular collection. collectionPath is already
    // normalized (no content-root prefix) by the caller — see this method's
    // doc comment.
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Handle slug change (directory rename) if provided
    let finalPhysicalPath = physicalPath
    if (updates.slug !== undefined) {
      // Extract current slug and ID from physical path
      // Format: /path/to/{slug}.{12-char-id}
      const dirName = path.basename(physicalPath)
      const parts = dirName.split('.')

      if (parts.length !== 2 || !isValidId(parts[1])) {
        throw new Error(`Invalid collection directory format: ${dirName}`)
      }

      const currentSlug = parts[0]
      const contentId = parts[1]

      // Only rename if slug is actually different
      if (updates.slug !== currentSlug) {
        // Validate new slug (alphanumeric + hyphens, lowercase)
        if (!SAFE_NAME_PATTERN.test(updates.slug)) {
          throw new Error(`Slug ${SAFE_NAME_MESSAGE}`)
        }

        // Build new path with new slug + same ID
        const parentDir = path.dirname(physicalPath)
        const newDirName = `${updates.slug}.${contentId}`
        const newPhysicalPath = path.join(parentDir, newDirName)

        // Check if any collection with this slug already exists
        // Need to check for any directory matching {slug}.{any-id}
        try {
          const entries = await fs.readdir(parentDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith(`${updates.slug}.`)) {
              const parts = entry.name.split('.')
              if (parts.length === 2 && isValidId(parts[1])) {
                throw new Error(`Collection with slug "${updates.slug}" already exists`)
              }
            }
          }
        } catch (err) {
          // Re-throw "already exists" errors
          if ((err as Error).message.includes('already exists')) {
            throw err
          }
          // Ignore other errors (e.g., ENOENT if parent dir doesn't exist somehow)
        }

        // Atomically rename the directory — this re-paths every entry beneath
        // it, so already-loaded ID indexes (here and in other processes) must
        // be told to rebuild.
        await fs.rename(physicalPath, newPhysicalPath)
        finalPhysicalPath = newPhysicalPath
        await this.invalidateContentIdIndexes()
      }
    }

    // Apply metadata updates
    if (updates.name !== undefined) {
      meta.name = updates.name
    }
    if (updates.label !== undefined) {
      meta.label = updates.label
    }
    if (updates.order !== undefined) {
      meta.order = updates.order
    }

    // Write back to the (potentially renamed) path
    await this.writeCollectionMeta(finalPhysicalPath, meta)
  }

  /**
   * Delete a collection (must be empty)
   */
  async deleteCollection(collectionPath: LogicalPath): Promise<void> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.deleteCollectionInner(normalizedPath))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  private async deleteCollectionInner(collectionPath: LogicalPath): Promise<void> {
    // Check if empty — moved inside the lock so a concurrent write landing
    // between this check and the rm below can't slip past it (TOCTOU).
    const isEmpty = await this.isCollectionEmpty(collectionPath)
    if (!isEmpty) {
      throw new Error('Collection must be empty before deletion. Delete all entries first.')
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Delete the directory (including .collection.json)
    await fs.rm(physicalPath, { recursive: true })
    await this.invalidateContentIdIndexes()
  }

  // --------------------------------------------------------------------------
  // Entry Type Operations
  // --------------------------------------------------------------------------

  /**
   * Add an entry type to a collection
   */
  async addEntryType(collectionPath: LogicalPath, entryType: CreateEntryTypeInput): Promise<void> {
    // Validate input
    const parseResult = entryTypeInputSchema.safeParse(entryType)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema reference
    if (!this.validateSchemaReference(entryType.schema)) {
      const available = Object.keys(this.entrySchemaRegistry).join(', ')
      throw new Error(`Schema reference "${entryType.schema}" not found. Available: ${available}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.addEntryTypeInner(normalizedPath, entryType))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  private async addEntryTypeInner(
    collectionPath: LogicalPath,
    entryType: CreateEntryTypeInput,
  ): Promise<void> {
    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Check for duplicate name
    if (meta.entries?.some((et) => et.name === entryType.name)) {
      throw new Error(`Entry type "${entryType.name}" already exists in this collection`)
    }

    // Add entry type
    meta.entries = meta.entries || []
    meta.entries.push({
      name: entryType.name,
      label: entryType.label,
      format: entryType.format,
      schema: entryType.schema,
      default: entryType.default,
      maxItems: entryType.maxItems,
    })

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Update an entry type in a collection
   */
  async updateEntryType(
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ): Promise<void> {
    // Validate input
    const parseResult = updateEntryTypeInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema reference if provided
    if (updates.schema && !this.validateSchemaReference(updates.schema)) {
      const available = Object.keys(this.entrySchemaRegistry).join(', ')
      throw new Error(`Schema reference "${updates.schema}" not found. Available: ${available}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() =>
      this.updateEntryTypeInner(normalizedPath, entryTypeName, updates),
    )
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  private async updateEntryTypeInner(
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ): Promise<void> {
    // Breaking-change usage guard — moved here from api/schema.ts's
    // updateEntryTypeHandler, which used to count usages BEFORE calling this
    // method: a concurrent write could land an entry between that count and
    // this write (TOCTOU). Running the count under the same lock that guards
    // the write closes that window. Error message preserved exactly — the
    // handler's catch surfaces it verbatim as a 400.
    const isBreakingChange = updates.format !== undefined || updates.schema !== undefined
    if (isBreakingChange) {
      const usageCount = await this.countEntriesUsingType(collectionPath, entryTypeName)
      if (usageCount > 0) {
        const entryWord = usageCount === 1 ? 'entry' : 'entries'
        throw new Error(
          `Cannot modify schema or format for entry type with existing ${entryWord}. ${usageCount} ${entryWord} currently use this type.`,
        )
      }
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Find entry type
    const entryType = meta.entries?.find((et) => et.name === entryTypeName)
    if (!entryType) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

    // Apply updates
    if (updates.label !== undefined) {
      entryType.label = updates.label
    }
    if (updates.format !== undefined) {
      entryType.format = updates.format
    }
    if (updates.schema !== undefined) {
      entryType.schema = updates.schema
    }
    if (updates.default !== undefined) {
      entryType.default = updates.default
    }
    if (updates.maxItems !== undefined) {
      entryType.maxItems = updates.maxItems
    }

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Remove an entry type from a collection
   */
  async removeEntryType(collectionPath: LogicalPath, entryTypeName: string): Promise<void> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.removeEntryTypeInner(normalizedPath, entryTypeName))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  private async removeEntryTypeInner(
    collectionPath: LogicalPath,
    entryTypeName: string,
  ): Promise<void> {
    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Check entry type exists
    const index = meta.entries?.findIndex((et) => et.name === entryTypeName) ?? -1
    if (index === -1) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

    // Ensure at least one entry type remains
    if (meta.entries!.length === 1) {
      throw new Error(
        'Cannot remove last entry type. Collection must have at least one entry type.',
      )
    }

    // Check for entries still using this type
    const usageCount = await this.countEntriesUsingType(collectionPath, entryTypeName)
    if (usageCount > 0) {
      throw new Error(
        `Cannot remove entry type "${entryTypeName}": ${usageCount} ${usageCount === 1 ? 'entry still uses' : 'entries still use'} it. ` +
          'Delete or migrate those entries first.',
      )
    }

    // Remove entry type
    meta.entries!.splice(index, 1)

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  // --------------------------------------------------------------------------
  // Usage Counting
  // --------------------------------------------------------------------------

  /**
   * Count the number of entries using a specific entry type in a collection.
   * This is used to prevent breaking changes to entry types that have existing content.
   *
   * @param collectionPath - Logical path to the collection (e.g., "content/posts")
   * @param entryTypeName - Name of the entry type to count
   * @returns Number of entries using this entry type
   *
   * @example
   * ```ts
   * const count = await store.countEntriesUsingType('content/posts', 'post')
   * if (count > 0) {
   *   // Cannot modify schema/format
   * }
   * ```
   */
  async countEntriesUsingType(collectionPath: LogicalPath, entryTypeName: string): Promise<number> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    // Resolve collection physical path
    const physicalPath = await resolveCollectionPath(this.contentRoot, normalizedPath)
    if (!physicalPath) {
      // Collection doesn't exist yet - return 0
      return 0
    }

    try {
      // Read directory entries
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })

      // Count files matching pattern: {entryTypeName}.{slug}.{id}.{ext}
      let count = 0
      for (const entry of entries) {
        // Skip directories and hidden files
        if (entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        // Parse filename: type.slug.id.ext
        const parts = entry.name.split('.')

        // Need at least 4 parts: type, slug, id, ext
        if (parts.length < 4) {
          continue
        }

        // Check if first part matches entry type name
        if (parts[0] !== entryTypeName) {
          continue
        }

        // Check if second-to-last part is a valid 12-char ID
        const candidateId = parts[parts.length - 2]
        if (isValidId(candidateId)) {
          count++
        }
      }

      return count
    } catch (err) {
      // Directory might not exist yet
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0
      }
      throw err
    }
  }

  // --------------------------------------------------------------------------
  // Order Operations
  // --------------------------------------------------------------------------

  /**
   * Update the order of items in a collection
   */
  async updateOrder(collectionPath: LogicalPath, order: string[]): Promise<void> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.updateOrderInner(normalizedPath, order))
    // Invalidate schema cache after mutation (outside the lock — see withSchemaLock's doc comment)
    await this.invalidateSchemaCache()
  }

  private async updateOrderInner(collectionPath: LogicalPath, order: string[]): Promise<void> {
    // Check if this is the root collection (path equals the configured content
    // root, e.g. "content" or "cms/content")
    if (collectionPath === this.contentRootName) {
      // Update root collection meta
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      meta.order = order
      await this.writeRootCollectionMeta(meta)
      return
    }

    // Update regular collection. collectionPath is already normalized (no
    // content-root prefix) by the public updateOrder above. Calls
    // updateCollectionInner DIRECTLY, never the public updateCollection:
    // we're already inside withSchemaLock's critical section here, and
    // withLock is not re-entrant — going through updateCollection would call
    // withSchemaLock again and deadlock waiting on the lock it itself holds.
    await this.updateCollectionInner(collectionPath, { order })
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  createCollectionInputSchema,
  updateCollectionInputSchema,
  entryTypeInputSchema,
  updateEntryTypeInputSchema,
}
