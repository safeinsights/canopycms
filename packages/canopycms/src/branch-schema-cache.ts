import fs from 'node:fs/promises'
import path from 'node:path'

import type { RootCollectionConfig } from './config'
import type { FlatSchemaItem } from './config/types'
import type { OperatingMode } from './operating-mode'
import type { EntrySchemaRegistry } from './schema/types'
import { resolveSchema, isValidSchema } from './schema/resolver'
import { flattenSchema } from './config/flatten'

/** Bump when BranchSchemaCacheEntry shape changes to auto-invalidate stale caches */
const SCHEMA_CACHE_VERSION = 2

/** Minimum interval between mtime staleness checks (ms) */
const MTIME_CHECK_DEBOUNCE_MS = 1000

/**
 * Schema cache structure stored in {branchRoot}/.canopy-meta/schema-cache.json
 */
export interface BranchSchemaCacheEntry {
  version: number
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  cachedAt: string // ISO timestamp
}

/**
 * In dev mode, check whether any .collection.json file under dir has been
 * modified more recently than cachedAt. Returns true if stale.
 *
 * Uses a single recursive readdir to find all .collection.json files,
 * then stats only those files.
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
 * Manages per-branch schema caching with lazy loading and automatic invalidation.
 *
 * Caching Strategy:
 * - File-based cache at {branchRoot}/.canopy-meta/schema-cache.json (no in-memory layer
 *   — intentional: matches prod behavior and keeps cache coherent across Lambda invocations)
 * - Invalidation: Writers create .stale marker, causing cache regeneration on next access
 *
 * Multi-User Support:
 * - User A modifies schema via SchemaOps → writes .stale marker
 * - User B loads schema later → sees .stale marker → regenerates cache
 * - Atomic file operations prevent corruption during concurrent access
 */
export class BranchSchemaCache {
  /** Tracks when we last checked mtimes per contentRoot, to debounce rapid requests */
  private lastMtimeCheck = new Map<string, number>()

  private readonly devMode: boolean

  constructor(mode: OperatingMode = 'prod') {
    this.devMode = mode === 'dev'
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
   * Load schema from cache or resolve fresh if cache is missing or stale.
   */
  private async loadFromCacheOrResolve(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const contentRoot = path.join(branchRoot, contentRootName)
    const cacheDir = path.join(branchRoot, '.canopy-meta')
    const cachePath = path.join(cacheDir, 'schema-cache.json')
    const stalePath = path.join(cacheDir, 'schema-cache.stale')

    // Check if cache exists and is not marked stale
    let cacheData: BranchSchemaCacheEntry | null = null
    try {
      const staleExists = await fs
        .access(stalePath)
        .then(() => true)
        .catch(() => false)
      if (!staleExists) {
        const cacheContent = await fs.readFile(cachePath, 'utf-8')
        cacheData = JSON.parse(cacheContent) as BranchSchemaCacheEntry
      }
    } catch {
      // Cache doesn't exist or can't be read
      cacheData = null
    }

    if (cacheData && cacheData.version === SCHEMA_CACHE_VERSION) {
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
    }

    // Cache miss or stale - regenerate
    const result = await resolveSchema(contentRoot, entrySchemaRegistry)

    // Validate schema has content
    if (!isValidSchema(result.schema)) {
      throw new Error(
        `No schema found in ${contentRoot}. Create .collection.json files ` +
          'with references to field schemas defined in your entry schema registry.',
      )
    }

    // Use configured contentRoot name as base path for logical paths
    const flatSchema = flattenSchema(result.schema, contentRootName)

    // Save to cache
    await fs.mkdir(cacheDir, { recursive: true })
    const newCache: BranchSchemaCacheEntry = {
      version: SCHEMA_CACHE_VERSION,
      schema: result.schema,
      flatSchema,
      cachedAt: new Date().toISOString(),
    }

    // Atomic write: write to temp file, then rename
    const tmpPath = path.join(cacheDir, `schema-cache.tmp.${Date.now()}.${Math.random()}.json`)
    await fs.writeFile(tmpPath, JSON.stringify(newCache, null, 2), 'utf-8')
    await fs.rename(tmpPath, cachePath)

    // Remove stale marker if exists
    try {
      await fs.unlink(stalePath)
    } catch {
      // Stale marker may not exist - that's fine
    }

    return { schema: result.schema, flatSchema }
  }

  /**
   * Invalidate cache for a branch (creates .stale marker).
   *
   * @param branchRoot - Root directory of the branch
   */
  async invalidate(branchRoot: string): Promise<void> {
    const cacheDir = path.join(branchRoot, '.canopy-meta')
    const stalePath = path.join(cacheDir, 'schema-cache.stale')

    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(stalePath, '', 'utf-8')
  }
}
