/**
 * Schema Store - handles reading and writing .collection.json files.
 * All mutations are branch-specific (like content edits).
 *
 * ## Concurrency
 *
 * `.collection.json` is read-modify-written by every mutator below and
 * mutated cross-host — two warm Lambdas, or a Lambda + the EC2 worker, on
 * EFS can both read the same pre-mutation file and clobber each other's
 * write. This deviates from the standard 3-layer recipe in
 * docs/concurrency.md: no OCC `version`/`writeId` field goes into
 * `.collection.json` itself, and no lockfile lives in the content tree —
 * both are adopter-visible, git-committed files, so a rebase would make a
 * version counter meaningless and a crash-leftover lockfile would land in a
 * commit an adopter reviews.
 *
 * Protection is instead layer 1 ({@link withLock}) + layer 3
 * ({@link withOccFileLock}) on one COARSE per-branch SURROGATE lock path
 * OUTSIDE the content tree (`{branchRoot}/.canopy-meta/schema`, see
 * `withSchemaLock`), covering every schema mutation on the branch including
 * multi-file ones. Layer 2 (OCC read-back) is skipped, since there's no
 * version field to check; layer 4 (generation marker) guards the schema
 * CACHE separately, not this write path.
 *
 * Accepted residual: `deleteBranch` does not take this lock before its
 * recursive `rm`, so an in-flight write can race a concurrent branch
 * deletion (mirrors the residual on `BranchMetadataFileManager.save()` in
 * branch-metadata.ts) — see `withSchemaLock`'s doc for the phantom-guard
 * covering the common ordering instead.
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
import { findIndexEntryIn, findEntryBySlugIn } from '../url-collision'
import { isIndexSlug } from '../utils/entry-url'
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

/** Max length for names and slugs (filesystem path safety) */
const MAX_NAME_LENGTH = 64
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

  /**
   * Serialize an entire read-modify-write schema mutation behind the coarse
   * per-branch surrogate lock described in the module doc comment: layer 1
   * ({@link withLock}, in-process FIFO mutex) wraps layer 3
   * ({@link withOccFileLock}, cross-process/cross-host mkdir-based mutual
   * exclusion, immune to NFS attribute caching), same structure as
   * `BranchMetadataFileManager.save()` in branch-metadata.ts.
   *
   * NOT re-entrant — callers must never invoke this from inside a callback
   * already running under it, or `withLock` deadlocks waiting on itself;
   * that's why `updateOrderInner` calls `updateCollectionInner` directly
   * instead of the public `updateCollection`.
   *
   * Phantom-resurrection guard: `branchRoot` can be removed by a concurrent
   * `deleteBranch` between the caller resolving its BranchContext and this
   * call's own lock acquisition, which would otherwise let
   * `withOccFileLock`'s `mkdir({recursive:true})` silently recreate
   * `.canopy-meta/` in an otherwise-deleted tree. Checking BEFORE the lock
   * fails fast instead. Residual (accepted, same shape as
   * branch-metadata.ts's): a call that passes this check can still race a
   * `deleteBranch` `rm` starting moments later — not closed here either,
   * since `deleteBranch` never takes this lock (see the module doc comment).
   *
   * Translation happens ONLY at this boundary: inner code always sees the
   * raw {@link OccWriteConflictError} bubble up here untranslated.
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

  /**
   * The single normalisation boundary for logical collection paths entering
   * this class. Every public method that accepts one calls this exactly
   * once, before touching the path: `flattenSchema` (branch-schema-cache.ts)
   * produces content-root-prefixed logical paths (e.g. "content/posts") that
   * the editor round-trips straight back into every mutator, but
   * `resolveCollectionPath` treats its path argument as already relative to
   * `this.contentRoot` — without stripping, a prefixed path resolves one
   * level too deep and is reported as not found.
   *
   * Strips ONE leading `"{contentRootName}/"` if present — exact string
   * match against the full, possibly multi-segment, `contentRootName`, never
   * `path.basename()` (which would break a root like "cms/content") —
   * otherwise returns the path unchanged, so both prefixed and unprefixed
   * callers work. Leaves the bare root-collection sentinel
   * (`collectionPath === this.contentRootName`) untouched: it has no
   * trailing "/" to strip, so the `=== this.contentRootName` checks in
   * `updateCollectionInner`/`updateOrderInner` keep working.
   *
   * NOT idempotent — a sub-collection literally named after the content
   * root can re-normalise to the ROOT collection on a second call, mutating
   * the wrong one instead of reporting not-found. Every entry point calls
   * this exactly once today, so the ambiguity is unreachable; see
   * .claude/future-tasks/collection-path-content-root-ambiguity.md. A future
   * method that accepts a logical collection path must do the same.
   */
  private normalizeCollectionPath(collectionPath: LogicalPath): LogicalPath {
    return createLogicalPath(stripContentRootPrefix(collectionPath, this.contentRootName))
  }

  validateSchemaReference(schemaKey: string): boolean {
    return schemaKey in this.entrySchemaRegistry
  }

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

  async readCollectionMeta(collectionPath: LogicalPath): Promise<CollectionMetaFile | null> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
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
        if (entry.isFile() && entry.name !== '.collection.json') {
          return false
        }
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

  // These are plain atomic writes with NO locking of their own: every caller
  // reaches them from inside a public mutator's `withSchemaLock` critical
  // section (see the module doc comment), which is what actually protects
  // against concurrent writers. Locking here too would be redundant and
  // would mislead a reader into thinking THIS is where the safety comes
  // from.

  private async writeCollectionMeta(physicalPath: string, meta: CollectionMetaFile): Promise<void> {
    const metaPath = path.join(physicalPath, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await atomicWriteFile(metaPath, content)
  }

  private async writeRootCollectionMeta(meta: RootCollectionMetaFile): Promise<void> {
    const metaPath = path.join(this.contentRoot, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await atomicWriteFile(metaPath, content)
  }

  async createCollection(
    input: CreateCollectionInput,
  ): Promise<{ collectionPath: LogicalPath; contentId: ContentId }> {
    const parseResult = createCollectionInputSchema.safeParse(input)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

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

    const contentId = generateId()
    const dirName = `${input.name}.${contentId}`
    const physicalPath = path.join(parentPhysicalPath, dirName)

    // Defense-in-depth: the name pattern above already prevents
    // traversal, but independently assert the resolved path stays within the
    // content root before any filesystem write.
    const containment = this.validatePath(physicalPath)
    if (!containment.valid) {
      throw new Error(`Invalid collection path: ${containment.error}`)
    }

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
      order: [],
    }

    await this.writeCollectionMeta(physicalPath, meta)

    // For root-level collections (empty parentPath), we don't update parent order
    const parentLogicalPath = input.parentPath
      ? createLogicalPath(input.parentPath)
      : createLogicalPath('')
    const parentMeta = input.parentPath ? await this.readCollectionMeta(parentLogicalPath) : null
    if (parentMeta) {
      const existingOrder = parentMeta.order ?? []
      parentMeta.order = [...existingOrder, contentId]
      await this.writeCollectionMeta(parentPhysicalPath, parentMeta)
    }

    const logicalPath = input.parentPath
      ? createLogicalPath(`${input.parentPath}/${input.name}`)
      : createLogicalPath(input.name)

    return { collectionPath: logicalPath, contentId }
  }

  async updateCollection(
    collectionPath: LogicalPath,
    updates: UpdateCollectionInput,
  ): Promise<void> {
    const parseResult = updateCollectionInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.updateCollectionInner(normalizedPath, updates))
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
    if (collectionPath === this.contentRootName) {
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

    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    let finalPhysicalPath = physicalPath
    if (updates.slug !== undefined) {
      // Format: /path/to/{slug}.{12-char-id}
      const dirName = path.basename(physicalPath)
      const parts = dirName.split('.')

      if (parts.length !== 2 || !isValidId(parts[1])) {
        throw new Error(`Invalid collection directory format: ${dirName}`)
      }

      const currentSlug = parts[0]
      const contentId = parts[1]

      if (updates.slug !== currentSlug) {
        if (!SAFE_NAME_PATTERN.test(updates.slug)) {
          throw new Error(`Slug ${SAFE_NAME_MESSAGE}`)
        }

        const parentDir = path.dirname(physicalPath)
        const newDirName = `${updates.slug}.${contentId}`
        const newPhysicalPath = path.join(parentDir, newDirName)

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
          if ((err as Error).message.includes('already exists')) {
            throw err
          }
          // Ignore other errors (e.g., ENOENT if parent dir doesn't exist somehow)
        }

        // Contested-URL guard: renaming re-paths every entry beneath this collection, so its own
        // index entry can end up sharing a URL with a same-slugged entry already in the parent
        // (see url-collision.ts). Only the index entry is at risk — the sibling-name check above
        // already rules out a `{slug}.{id}` directory at the destination — but that check is
        // case-SENSITIVE and lets an ID-less `docs/`-style directory through, so a case or
        // ID-less collision can still slip past it for entries deeper than the index; see
        // .claude/future-tasks/collection-sibling-name-uniqueness.md.
        if (await findIndexEntryIn(physicalPath)) {
          // Renaming TO "index" collapses this collection onto its OWN new path, not the
          // parent's — see url-collision.ts's findUrlPathClaimant for the equivalent create-time
          // check, which skips this same false positive the same way.
          const conflicting = isIndexSlug(updates.slug)
            ? null
            : await findEntryBySlugIn(parentDir, updates.slug)
          if (conflicting) {
            throw new Error(
              `Renaming this collection to "${updates.slug}" would make its landing page share a ` +
                `URL with the "${updates.slug}" entry already in the parent collection, and only ` +
                `one of them could be served there. Rename or remove that entry first.`,
            )
          }
        }

        // Atomically rename the directory — this re-paths every entry beneath
        // it, so already-loaded ID indexes (here and in other processes) must
        // be told to rebuild.
        await fs.rename(physicalPath, newPhysicalPath)
        finalPhysicalPath = newPhysicalPath
        await this.invalidateContentIdIndexes()
      }
    }

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
    await this.invalidateSchemaCache()
  }

  private async deleteCollectionInner(collectionPath: LogicalPath): Promise<void> {
    // Check if empty — moved inside the lock so a concurrent write landing
    // between this check and the rm below can't slip past it (TOCTOU).
    const isEmpty = await this.isCollectionEmpty(collectionPath)
    if (!isEmpty) {
      throw new Error('Collection must be empty before deletion. Delete all entries first.')
    }

    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    await fs.rm(physicalPath, { recursive: true })
    await this.invalidateContentIdIndexes()
  }

  async addEntryType(collectionPath: LogicalPath, entryType: CreateEntryTypeInput): Promise<void> {
    const parseResult = entryTypeInputSchema.safeParse(entryType)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    if (!this.validateSchemaReference(entryType.schema)) {
      const available = Object.keys(this.entrySchemaRegistry).join(', ')
      throw new Error(`Schema reference "${entryType.schema}" not found. Available: ${available}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.addEntryTypeInner(normalizedPath, entryType))
    await this.invalidateSchemaCache()
  }

  private async addEntryTypeInner(
    collectionPath: LogicalPath,
    entryType: CreateEntryTypeInput,
  ): Promise<void> {
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    if (meta.entries?.some((et) => et.name === entryType.name)) {
      throw new Error(`Entry type "${entryType.name}" already exists in this collection`)
    }

    meta.entries = meta.entries || []
    meta.entries.push({
      name: entryType.name,
      label: entryType.label,
      format: entryType.format,
      schema: entryType.schema,
      default: entryType.default,
      maxItems: entryType.maxItems,
    })

    await this.writeCollectionMeta(physicalPath, meta)
  }

  async updateEntryType(
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ): Promise<void> {
    const parseResult = updateEntryTypeInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    if (updates.schema && !this.validateSchemaReference(updates.schema)) {
      const available = Object.keys(this.entrySchemaRegistry).join(', ')
      throw new Error(`Schema reference "${updates.schema}" not found. Available: ${available}`)
    }

    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() =>
      this.updateEntryTypeInner(normalizedPath, entryTypeName, updates),
    )
    await this.invalidateSchemaCache()
  }

  private async updateEntryTypeInner(
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ): Promise<void> {
    // Breaking-change usage guard: the usage count runs under the same lock
    // as the write; counted outside it, a concurrent write could land an
    // entry between the count and this write (TOCTOU). Error message
    // preserved exactly — the handler's catch surfaces it verbatim as a 400.
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

    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    const entryType = meta.entries?.find((et) => et.name === entryTypeName)
    if (!entryType) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

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

    await this.writeCollectionMeta(physicalPath, meta)
  }

  async removeEntryType(collectionPath: LogicalPath, entryTypeName: string): Promise<void> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.removeEntryTypeInner(normalizedPath, entryTypeName))
    await this.invalidateSchemaCache()
  }

  private async removeEntryTypeInner(
    collectionPath: LogicalPath,
    entryTypeName: string,
  ): Promise<void> {
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    const index = meta.entries?.findIndex((et) => et.name === entryTypeName) ?? -1
    if (index === -1) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

    if (meta.entries!.length === 1) {
      throw new Error(
        'Cannot remove last entry type. Collection must have at least one entry type.',
      )
    }

    const usageCount = await this.countEntriesUsingType(collectionPath, entryTypeName)
    if (usageCount > 0) {
      throw new Error(
        `Cannot remove entry type "${entryTypeName}": ${usageCount} ${usageCount === 1 ? 'entry still uses' : 'entries still use'} it. ` +
          'Delete or migrate those entries first.',
      )
    }

    meta.entries!.splice(index, 1)

    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Count the number of entries using a specific entry type in a collection.
   * Prevents breaking changes to entry types that have existing content.
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
    const physicalPath = await resolveCollectionPath(this.contentRoot, normalizedPath)
    if (!physicalPath) {
      return 0
    }

    try {
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })

      // Count files matching pattern: {entryTypeName}.{slug}.{id}.{ext}
      let count = 0
      for (const entry of entries) {
        if (entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const parts = entry.name.split('.')

        if (parts.length < 4) {
          continue
        }

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

  async updateOrder(collectionPath: LogicalPath, order: string[]): Promise<void> {
    const normalizedPath = this.normalizeCollectionPath(collectionPath)
    await this.withSchemaLock(() => this.updateOrderInner(normalizedPath, order))
    await this.invalidateSchemaCache()
  }

  private async updateOrderInner(collectionPath: LogicalPath, order: string[]): Promise<void> {
    if (collectionPath === this.contentRootName) {
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      meta.order = order
      await this.writeRootCollectionMeta(meta)
      return
    }

    // Inner, not updateCollection: withSchemaLock is not re-entrant (see its doc).
    await this.updateCollectionInner(collectionPath, { order })
  }
}

export {
  createCollectionInputSchema,
  updateCollectionInputSchema,
  entryTypeInputSchema,
  updateEntryTypeInputSchema,
}
