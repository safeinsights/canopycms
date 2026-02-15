import fs from 'node:fs/promises'
import path from 'node:path'

import type { RootCollectionConfig } from './config'
import type { FlatSchemaItem, FieldConfig } from './config/types'
import type { OperatingMode } from './operating-mode'
import { resolveSchema } from './schema/resolver'
import { flattenSchema } from './config/flatten'

/**
 * Schema cache structure stored in {branchRoot}/.canopy-meta/schema-cache.json
 */
export interface BranchSchemaCache {
  version: number
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  cachedAt: string // ISO timestamp
}

/**
 * Manages per-branch schema caching with lazy loading and automatic invalidation.
 *
 * Caching Strategy:
 * - Prod/Prod-sim: File-based cache at {branchRoot}/.canopy-meta/schema-cache.json
 * - Dev mode: In-memory singleton (no file I/O)
 * - Invalidation: Writers create .stale marker, causing cache regeneration on next access
 *
 * Multi-User Support:
 * - User A modifies schema via SchemaStore → writes .stale marker
 * - User B loads schema later → sees .stale marker → regenerates cache
 * - Atomic file operations prevent corruption during concurrent access
 */
export class SchemaCacheRegistry {
  private devModeCache?: { schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }

  constructor(private readonly mode: OperatingMode) {}

  /**
   * Get schema for a branch (loads from cache or resolves fresh).
   *
   * @param branchRoot - Root directory of the branch (e.g., .canopy-prod-sim/content-branches/main)
   * @param schemaRegistry - Map of schema names to field definitions
   * @returns Resolved schema tree and flattened schema
   */
  async getSchema(
    branchRoot: string,
    schemaRegistry: Record<string, readonly FieldConfig[]>
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    // Dev mode: use in-memory singleton
    if (this.mode === 'dev') {
      if (!this.devModeCache) {
        const contentRoot = path.join(branchRoot, 'content')
        const result = await resolveSchema(contentRoot, schemaRegistry)
        this.devModeCache = {
          schema: result.schema,
          flatSchema: flattenSchema(result.schema, contentRoot),
        }
      }
      return this.devModeCache
    }

    // Prod/prod-sim: use file-based cache with stale marker invalidation
    return this.loadFromCacheOrResolve(branchRoot, schemaRegistry)
  }

  /**
   * Load schema from cache or resolve fresh if cache is missing or stale.
   */
  private async loadFromCacheOrResolve(
    branchRoot: string,
    schemaRegistry: Record<string, readonly FieldConfig[]>
  ): Promise<{ schema: RootCollectionConfig; flatSchema: FlatSchemaItem[] }> {
    const contentRoot = path.join(branchRoot, 'content')
    const cacheDir = path.join(branchRoot, '.canopy-meta')
    const cachePath = path.join(cacheDir, 'schema-cache.json')
    const stalePath = path.join(cacheDir, 'schema-cache.stale')

    // Check if cache exists and is not marked stale
    let cacheData: BranchSchemaCache | null = null
    try {
      const staleExists = await fs
        .access(stalePath)
        .then(() => true)
        .catch(() => false)
      if (!staleExists) {
        const cacheContent = await fs.readFile(cachePath, 'utf-8')
        cacheData = JSON.parse(cacheContent)
      }
    } catch {
      // Cache doesn't exist or can't be read
      cacheData = null
    }

    if (cacheData) {
      return { schema: cacheData.schema, flatSchema: cacheData.flatSchema }
    }

    // Cache miss or stale - regenerate
    const result = await resolveSchema(contentRoot, schemaRegistry)
    const flatSchema = flattenSchema(result.schema, contentRoot)

    // Save to cache
    await fs.mkdir(cacheDir, { recursive: true })
    const newCache: BranchSchemaCache = {
      version: 1,
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
    if (this.mode === 'dev') {
      // Clear in-memory cache
      this.devModeCache = undefined
      return
    }

    // Prod/prod-sim: create stale marker (empty file)
    const cacheDir = path.join(branchRoot, '.canopy-meta')
    const stalePath = path.join(cacheDir, 'schema-cache.stale')

    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(stalePath, '', 'utf-8')
  }

  /**
   * Clear all caches (for testing).
   * In dev mode, clears in-memory cache.
   * In prod/prod-sim modes, this would need to traverse all branch directories.
   */
  async clearAll(): Promise<void> {
    if (this.mode === 'dev') {
      this.devModeCache = undefined
    }
    // For prod/prod-sim, clearing all caches would require knowing all branch roots
    // For now, just clear dev mode cache. Tests can invalidate specific branches.
  }
}
