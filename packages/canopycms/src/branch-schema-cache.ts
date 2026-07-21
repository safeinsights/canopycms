import fs from 'node:fs/promises'
import path from 'node:path'

import type { RootCollectionConfig } from './config'
import type { FlatSchemaItem } from './config/types'
import type { OperatingMode } from './operating-mode'
import type { EntrySchemaRegistry, SchemaResolutionResult } from './schema/types'
import { resolveSchema, isValidSchema } from './schema/resolver'
import { flattenSchema } from './config/flatten'
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

/**
 * Schema cache structure stored in {branchRoot}/.canopy-meta/schema-cache.json
 */
export interface BranchSchemaCacheEntry {
  version: number
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  cachedAt: string // ISO timestamp
  /**
   * The resource-generation.ts marker token this snapshot was resolved
   * against, or null if it was built before any bump ever occurred on this
   * root. Compared against the live marker (via isGenerationCurrent) to
   * decide freshness. See the class doc comment.
   */
  generation: string | null
}

/**
 * In dev mode, check whether any .collection.json file under dir has been
 * modified more recently than cachedAt. Returns true if stale.
 *
 * Uses a single recursive readdir to find all .collection.json files,
 * then stats only those files.
 *
 * This is a dev-only convenience for out-of-band hand edits made directly to
 * .collection.json files outside the CMS (which don't go through SchemaOps
 * and therefore never bump the generation marker below). It is not needed for
 * prod correctness: every mutation path that matters in prod bumps the marker.
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
 * Manages per-branch schema caching with lazy loading and automatic
 * invalidation.
 *
 * ## Cross-process freshness (resource-generation.ts marker protocol)
 *
 * Several warm Lambda containers plus the EC2 worker can share one
 * branch-clone root over EFS, each with its own copy of
 * `schema-cache.json`. There is no shared memory and no cross-host file
 * watching, so freshness is coordinated via the generic on-disk generation
 * marker in resource-generation.ts: every cached snapshot embeds the marker
 * token it was resolved against, and every read cheaply re-checks the live
 * marker before trusting the cache. See that module's doc comment for the
 * full protocol and residual staleness windows (A/B/C/E).
 *
 * BranchSchemaCache is the "durable snapshot consumer" case called out there:
 * a resolve whose scan is served from stale NFS dentry/attribute caches can
 * record a FRESH token over STALE data (window E), and because the result is
 * written to `schema-cache.json`, that staleness becomes durable and shared
 * with every other host that reads the marker - not just one process's
 * memory. `loadFromCacheOrResolve` mitigates this the same way
 * BranchRegistry does:
 *
 * - The marker is captured strictly BEFORE `resolveFresh()` runs, and the
 *   captured token (not one read after resolving) is what gets embedded in
 *   the persisted snapshot. A bump landing mid-resolve therefore leaves the
 *   embedded token older than the live marker, forcing a re-resolve on the
 *   next read instead of silently resurrecting stale schema.
 * - A snapshot is only persisted when the marker read itself succeeded
 *   (`{ ok: true }`). If the read fails for a reason other than "never
 *   bumped", we cannot attribute a token to this resolve, and stamping the
 *   snapshot with an unattributable token would make it indistinguishable
 *   from a correctly-attributed one to every future reader. The fresh result
 *   is still served to this caller; it just isn't written durably.
 * - invalidate() bumps the marker with `mustSucceed: true`: an explicit
 *   invalidation (e.g. after a schema mutation) must not silently fail and
 *   leave every reader confidently stale with no bounding backstop.
 *   invalidate() itself does NOT eager-regenerate - it isn't given the
 *   entrySchemaRegistry/contentRootName that resolveSchema needs. The
 *   eager re-resolve (window-E mitigation, mirroring BranchRegistry's
 *   eager regen) lives one level up in SchemaOps.invalidateSchemaCache()
 *   (schema/schema-store.ts), which has those arguments and calls
 *   getSchema() right after invalidating - so every SchemaOps mutation
 *   re-resolves on the mutating host, whose scan is necessarily coherent
 *   with the mutation it just made. (The editor's follow-up schema GET is
 *   a separate Lambda invocation with no container affinity, so it could
 *   not serve this purpose.) Callers of invalidate() that bypass SchemaOps
 *   (api/schema.ts's explicit invalidate endpoint; the bulk-mutation bump
 *   in invalidateBranchContentCaches) accept the lazy next-read regen.
 *
 * This is also why prod needs no mtime walk: the dev-only mtime check below
 * exists solely to catch hand edits to .collection.json made outside the CMS
 * (which bypass SchemaOps and therefore never bump the marker). Every
 * mutation path that matters in prod - SchemaOps writes, git working-tree
 * rewrites (checkout/merge/rebase/sync/migrate) - bumps the marker via
 * SchemaOps.invalidateSchemaCache() or the combined
 * invalidateBranchContentCaches() helper in content-index-generation.ts, so
 * the marker alone is a sufficient prod backstop.
 *
 * Caching Strategy:
 * - File-based cache at {branchRoot}/.canopy-meta/schema-cache.json (no
 *   in-memory layer - intentional: matches prod behavior and keeps cache
 *   coherent across Lambda invocations)
 * - Invalidation: invalidate() bumps the cross-process generation marker;
 *   every reader sharing this branchRoot re-resolves at its next access.
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
   * branchRoot equals the project root (process.cwd()) only in the synthetic
   * contexts used by static deployments and build phases — real branch roots are
   * always nested under the workspace (.canopy-dev/content-branches/<name> in dev,
   * <workspaceRoot>/content-branches/<name> in prod). Never write .canopy-meta/ at
   * the project root, regardless of which entrypoint produced the cwd branchRoot.
   */
  private skipDiskCache(branchRoot: string): boolean {
    return isBuildMode() || path.resolve(branchRoot) === path.resolve(process.cwd())
  }

  /**
   * Get schema for a branch (loads from cache or resolves fresh).
   *
   * @param branchRoot - Root directory of the branch (e.g., .canopy-dev/content-branches/main)
   * @param entrySchemaRegistry - Map of schema names to field definitions
   * @param contentRootName - Name of content directory (e.g., "content") from config
   * @returns Resolved schema tree and flattened schema
   */
  async getSchema(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string = 'content',
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    return this.loadFromCacheOrResolve(branchRoot, entrySchemaRegistry, contentRootName)
  }

  /**
   * Resolve the schema from disk. Wrapped in a protected method (rather than
   * calling the imported resolveSchema directly) so tests can subclass and
   * override with a deferred/blocking implementation to simulate cross-process
   * interleavings — mirrors BranchRegistry's scanBranchDirectories() hook.
   */
  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
  ): Promise<SchemaResolutionResult> {
    return resolveSchema(contentRoot, entrySchemaRegistry)
  }

  /**
   * Load schema from cache or resolve fresh if cache is missing or stale.
   */
  private async loadFromCacheOrResolve(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const contentRoot = path.join(branchRoot, contentRootName)

    // In static/build mode, branchRoot is process.cwd() (the project root).
    // Skip disk cache to avoid creating .canopy-meta/ at the project root.
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

      // Strict version check: a truthy-only check would accept a persisted
      // pre-marker snapshot (no `generation` field) left on EFS after a
      // rolling deploy, and `cacheData.generation` would then be `undefined`
      // rather than a real token or explicit `null`, breaking the freshness
      // comparison below.
      if (cacheData && cacheData.version === SCHEMA_CACHE_VERSION) {
        const read = await readResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE)
        if (isGenerationCurrent(cacheData.generation, read)) {
          // In dev mode, also check file mtimes so direct schema edits (outside the CMS) are picked up.
          // Debounce: skip the walk if we checked this contentRoot within the last second.
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

    // Cache miss, stale, or build mode - resolve fresh.
    //
    // Capture the marker strictly BEFORE resolving: a bump landing mid-resolve
    // then differs from the token recorded below, forcing a re-resolve on the
    // next read instead of silently persisting a snapshot that embeds a fresh
    // token over pre-mutation data.
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

    // Use configured contentRoot name as base path for logical paths
    const flatSchema = flattenSchema(result.schema, contentRootName)

    if (!skipDiskCache) {
      const cacheDir = path.join(branchRoot, '.canopy-meta')
      const cachePath = path.join(cacheDir, 'schema-cache.json')

      // Opportunistic cleanup of the legacy .stale marker file from the old
      // rename-based invalidation scheme (e.g. a process upgraded mid-flight
      // may find one left over from before the deploy). Not load-bearing.
      await fs.unlink(path.join(cacheDir, 'schema-cache.stale')).catch(() => {})

      if (read && read.ok) {
        const newCache: BranchSchemaCacheEntry = {
          version: SCHEMA_CACHE_VERSION,
          schema: result.schema,
          flatSchema,
          cachedAt: new Date().toISOString(),
          generation: read.token,
        }

        // Atomic write: write to temp file, then rename
        await fs.mkdir(cacheDir, { recursive: true })
        const tmpPath = path.join(cacheDir, `schema-cache.tmp.${Date.now()}.${Math.random()}.json`)
        await fs.writeFile(tmpPath, JSON.stringify(newCache, null, 2), 'utf-8')
        await fs.rename(tmpPath, cachePath)
      }
      // else: the marker couldn't be read for a reason other than "never
      // bumped" - we cannot attribute a token to this resolve, and stamping
      // the snapshot with an unattributable token would make it
      // indistinguishable from a correctly-attributed one to every future
      // reader. Serve the fresh result without persisting it; the next read
      // retries the marker read and, on success, resolves and persists
      // normally.
    }

    return { schema: result.schema, flatSchema }
  }

  /**
   * Invalidate cache for a branch by bumping the cross-process generation
   * marker (resource-generation.ts). Every process sharing this branchRoot
   * will re-resolve at its next read.
   *
   * The bump must succeed: a swallowed failure here would leave the schema
   * cache stale indefinitely with no bounding backstop (unlike
   * BranchRegistry, there is no get-miss backstop for a resolved schema).
   *
   * No eager regeneration here (unlike BranchRegistry.invalidate()): this
   * method isn't given the entrySchemaRegistry/contentRootName resolveSchema
   * needs. See the class doc comment for why the mutating request's own
   * follow-up schema read closes the same window-E gap instead.
   *
   * @param branchRoot - Root directory of the branch
   */
  async invalidate(branchRoot: string): Promise<void> {
    if (this.skipDiskCache(branchRoot)) return

    await bumpResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE, { mustSucceed: true })
  }
}
