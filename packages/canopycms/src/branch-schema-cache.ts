import fs from 'node:fs/promises'
import path from 'node:path'

import type { RootCollectionConfig } from './config'
import type { FlatSchemaItem } from './config/types'
import type { OperatingMode } from './operating-mode'
import type { EntrySchemaRegistry, SchemaResolutionResult } from './schema/types'
import { resolveSchema, isValidSchema } from './schema/resolver'
import { flattenSchema } from './config/flatten'
import { validateReferenceEntryTypes } from './validation/entry-type-reference-validator'
import { isBuildMode } from './build-mode'
import {
  bumpResourceGeneration,
  readResourceGeneration,
  isGenerationCurrent,
  type GenerationReadResult,
} from './resource-generation'

/** Bump when BranchSchemaCacheEntry shape changes to auto-invalidate stale caches */
const SCHEMA_CACHE_VERSION = 3

/** Minimum interval between mtime staleness checks (ms) */
const MTIME_CHECK_DEBOUNCE_MS = 1000

/** resource-generation.ts resource key for the schema cache's marker. */
export const SCHEMA_GENERATION_RESOURCE = 'schema'

export interface BranchSchemaCacheEntry {
  version: number
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  cachedAt: string // ISO timestamp
  /**
   * The marker token this snapshot was resolved against, or null when it was
   * built before any bump on this root. Compared against the live marker (via
   * isGenerationCurrent) to decide freshness.
   */
  generation: string | null
}

/**
 * True when a .collection.json under `dir` is newer than `cachedAt`.
 *
 * Dev-only, and dev-only on purpose: it catches hand edits made outside the
 * CMS, which bypass SchemaOps and so never bump the marker. Every prod mutation
 * path does bump it, so the marker alone is sufficient there.
 */
async function isStaleByMtime(dir: string, cachedAt: Date): Promise<boolean> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir, { recursive: true, encoding: 'utf-8' })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!entry.endsWith('.collection.json')) continue
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.mtimeMs > cachedAt.getTime()) return true
    } catch {
      // File may have been deleted between readdir and stat
      return true
    }
  }
  return false
}

/**
 * Per-branch schema cache: a file at {branchRoot}/.canopy-meta/schema-cache.json
 * with no in-memory layer, so it stays coherent across Lambda invocations.
 *
 * Freshness follows the generation-marker protocol owned by
 * resource-generation.ts, and this is one of that protocol's durable-snapshot
 * consumers. Its eager re-resolve lives one level up, in
 * `SchemaOps.invalidateSchemaCache()` (schema/schema-store.ts), because that is
 * where the entrySchemaRegistry/contentRootName arguments {@link invalidate}
 * lacks are available; it calls {@link resolveAndPersist}, never getSchema().
 * Callers that bypass SchemaOps (api/schema.ts's invalidate endpoint, and the
 * bulk git-op bump in invalidateBranchContentCaches) accept the lazy
 * next-read regen instead.
 */
export class BranchSchemaCache {
  /** Tracks when we last checked mtimes per contentRoot, to debounce rapid requests */
  private lastMtimeCheck = new Map<string, number>()

  private readonly devMode: boolean

  constructor(mode: OperatingMode = 'prod') {
    this.devMode = mode === 'dev'
  }

  /**
   * Whether to skip the on-disk cache for this branchRoot.
   *
   * Never write `.canopy-meta/` at the project root, whichever entrypoint
   * produced the cwd branchRoot. branchRoot equals process.cwd() only in the
   * synthetic contexts static deployments and build phases use; a real branch
   * root is always nested under the workspace.
   */
  private skipDiskCache(branchRoot: string): boolean {
    return isBuildMode() || path.resolve(branchRoot) === path.resolve(process.cwd())
  }

  /** Get schema for a branch, from the cache when fresh, else resolved fresh. */
  async getSchema(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string = 'content',
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    return this.loadFromCacheOrResolve(branchRoot, entrySchemaRegistry, contentRootName)
  }

  /**
   * Resolve the schema from disk. Protected rather than a direct resolveSchema
   * call so tests can subclass and block it to simulate cross-process
   * interleavings — mirrors BranchRegistry's scanBranchDirectories() hook.
   */
  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
  ): Promise<SchemaResolutionResult> {
    return resolveSchema(contentRoot, entrySchemaRegistry)
  }

  private async loadFromCacheOrResolve(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const contentRoot = path.join(branchRoot, contentRootName)

    const skipDiskCache = this.skipDiskCache(branchRoot)

    if (!skipDiskCache) {
      const cacheDir = path.join(branchRoot, '.canopy-meta')
      const cachePath = path.join(cacheDir, 'schema-cache.json')

      let cacheData: BranchSchemaCacheEntry | null = null
      try {
        const cacheContent = await fs.readFile(cachePath, 'utf-8')
        cacheData = JSON.parse(cacheContent) as BranchSchemaCacheEntry
      } catch {
        // Cache doesn't exist or can't be read
        cacheData = null
      }

      // Strict version check, not truthiness: a snapshot from an older version
      // left on EFS by a rolling deploy has no `generation` field, and an
      // `undefined` token breaks the freshness comparison below.
      if (cacheData && cacheData.version === SCHEMA_CACHE_VERSION) {
        const read = await readResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE)
        if (isGenerationCurrent(cacheData.generation, read)) {
          // Dev also walks mtimes, debounced, to catch edits made outside the CMS.
          const now = Date.now()
          const lastCheck = this.lastMtimeCheck.get(contentRoot) ?? 0
          if (
            this.devMode &&
            now - lastCheck >= MTIME_CHECK_DEBOUNCE_MS &&
            (await isStaleByMtime(contentRoot, new Date(cacheData.cachedAt)))
          ) {
            this.lastMtimeCheck.set(contentRoot, now)
            cacheData = null
          } else {
            if (this.devMode) this.lastMtimeCheck.set(contentRoot, now)
            return { schema: cacheData.schema, flatSchema: cacheData.flatSchema }
          }
        } else {
          // Marker mismatch (or unreadable) — treat as a cache miss.
          cacheData = null
        }
      } else {
        cacheData = null
      }
    }

    return this.resolveFreshAndPersist(branchRoot, entrySchemaRegistry, contentRootName, {
      skipDiskCache,
    })
  }

  /**
   * Resolve the schema fresh from disk and persist it (subject to the
   * skip-persist rule below), UNCONDITIONALLY -- never through the cache-read
   * fast path in {@link loadFromCacheOrResolve}. Shared by that method's
   * cache-miss fallback and by {@link resolveAndPersist}.
   */
  private async resolveFreshAndPersist(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
    options: { skipDiskCache: boolean },
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const { skipDiskCache } = options
    const contentRoot = path.join(branchRoot, contentRootName)

    // Capture the marker strictly BEFORE resolving, so a bump landing
    // mid-resolve differs from the token persisted below and forces a
    // re-resolve on the next read.
    const read: GenerationReadResult | null = skipDiskCache
      ? null
      : await readResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE)

    const result = await this.resolveFresh(contentRoot, entrySchemaRegistry)

    // Validate schema has content
    if (!isValidSchema(result.schema)) {
      throw new Error(
        `No schema found in ${contentRoot}. Create .collection.json files ` +
          'with references to field schemas defined in your entry schema registry.',
      )
    }

    // Reference fields may only scope themselves to entry types that exist.
    // Checked here, before anything is cached, so a typo fails loudly and
    // consistently instead of silently resolving to zero reference options.
    const entryTypeIssues = validateReferenceEntryTypes(result.schema)
    if (entryTypeIssues.length > 0) {
      throw new Error(
        `Invalid reference field entryTypes in ${contentRoot}:\n` +
          entryTypeIssues.map((issue) => `  - ${issue}`).join('\n'),
      )
    }

    // Use configured contentRoot name as base path for logical paths
    const flatSchema = flattenSchema(result.schema, contentRootName)

    if (!skipDiskCache) {
      const cacheDir = path.join(branchRoot, '.canopy-meta')
      const cachePath = path.join(cacheDir, 'schema-cache.json')

      // Opportunistic cleanup of the retired .stale marker file, which a
      // mid-flight deploy can leave behind. Not load-bearing.
      await fs.unlink(path.join(cacheDir, 'schema-cache.stale')).catch(() => {})

      if (read && read.ok) {
        const newCache: BranchSchemaCacheEntry = {
          version: SCHEMA_CACHE_VERSION,
          schema: result.schema,
          flatSchema,
          cachedAt: new Date().toISOString(),
          generation: read.token,
        }

        // Temp file then rename, with the temp file unlinked on a failed
        // rename so a transient error leaves no stray `.tmp` in `.canopy-meta/`.
        await fs.mkdir(cacheDir, { recursive: true })
        const tmpPath = path.join(cacheDir, `schema-cache.tmp.${Date.now()}.${Math.random()}.json`)
        await fs.writeFile(tmpPath, JSON.stringify(newCache, null, 2), 'utf-8')
        try {
          await fs.rename(tmpPath, cachePath)
        } catch (err) {
          await fs.unlink(tmpPath).catch(() => {})
          throw err
        }
      }
      // else: the marker read failed for a reason other than "never bumped",
      // so no token can be attributed to this resolve, and a snapshot stamped
      // with an unattributable one would look correctly attributed to every
      // future reader. Serve the fresh result without persisting it.
    }

    return { schema: result.schema, flatSchema }
  }

  /**
   * Resolve fresh from disk and persist, SKIPPING the cache read entirely.
   * That is what makes it, and not {@link getSchema}, the right call for the
   * eager re-resolve in `SchemaOps.invalidateSchemaCache()` (its sole intended
   * caller): an eager re-resolve exists to guarantee ONE scan coherent with the
   * mutation this host just made, and getSchema()'s cache-read fast path can
   * instead return a snapshot a concurrent host wrote — possibly one embedding
   * the now-current token over ITS own stale-NFS scan — skipping that scan.
   */
  async resolveAndPersist(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string = 'content',
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const skipDiskCache = this.skipDiskCache(branchRoot)
    return this.resolveFreshAndPersist(branchRoot, entrySchemaRegistry, contentRootName, {
      skipDiskCache,
    })
  }

  /**
   * Invalidate a branch's cache by bumping the marker; every process sharing
   * this branchRoot re-resolves at its next read. The bump must succeed —
   * swallowing that failure leaves the schema cache stale indefinitely, and
   * unlike BranchRegistry there is no get-miss backstop for a resolved schema.
   *
   * No eager re-resolve here; it lives in SchemaOps (see the class doc).
   */
  async invalidate(branchRoot: string): Promise<void> {
    if (this.skipDiskCache(branchRoot)) return

    await bumpResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE, { mustSucceed: true })
  }
}
