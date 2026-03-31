import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BranchSchemaCache } from './branch-schema-cache'
import type { FieldConfig } from './config'

describe('BranchSchemaCache', () => {
  let tempDir: string
  let branchRoot: string

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-cache-test-'))
    branchRoot = path.join(tempDir, 'branch-workspace')
    await fs.mkdir(branchRoot, { recursive: true })

    // Create content directory structure
    const contentRoot = path.join(branchRoot, 'content')
    await fs.mkdir(contentRoot, { recursive: true })

    // Create a simple .collection.json file
    await fs.writeFile(
      path.join(contentRoot, '.collection.json'),
      JSON.stringify({
        label: 'Root',
        entries: [
          {
            name: 'page',
            format: 'md',
            schema: 'pageSchema',
          },
        ],
        order: [],
      }),
      'utf-8',
    )
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('dev mode', () => {
    it('should load schema from .collection.json files on first access (cache miss)', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

      expect(result.schema).toBeDefined()
      expect(result.flatSchema).toBeDefined()
      expect(result.schema.entries).toBeDefined()
      expect(result.schema.entries?.length).toBe(1)
      expect(result.schema.entries?.[0].name).toBe('page')
    })

    it('should use cache on second access (cache hit)', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // First access - cache miss
      const result1 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Second access - should be faster (cache hit)
      const start2 = Date.now()
      const result2 = await registry.getSchema(branchRoot, entrySchemaRegistry)
      const duration2 = Date.now() - start2

      // Results should be the same
      expect(result2.schema).toEqual(result1.schema)
      expect(result2.flatSchema).toEqual(result1.flatSchema)

      // Second access (cache hit) should be very fast (no filesystem I/O)
      expect(duration2).toBeLessThan(10)
    })

    it('should write cache file to .canopy-meta/schema-cache.json', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      await registry.getSchema(branchRoot, entrySchemaRegistry)

      const cachePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.json')
      const cacheExists = await fs
        .access(cachePath)
        .then(() => true)
        .catch(() => false)

      expect(cacheExists).toBe(true)

      // Verify cache structure
      const cacheContent = await fs.readFile(cachePath, 'utf-8')
      const cache = JSON.parse(cacheContent)
      expect(cache.version).toBe(2)
      expect(cache.schema).toBeDefined()
      expect(cache.flatSchema).toBeDefined()
      expect(cache.cachedAt).toBeDefined()
    })

    it('should invalidate cache when invalidate() is called', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // Load schema (creates cache)
      await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Invalidate cache (creates .stale marker)
      await registry.invalidate(branchRoot)

      const stalePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.stale')
      const staleExists = await fs
        .access(stalePath)
        .then(() => true)
        .catch(() => false)

      expect(staleExists).toBe(true)
    })

    it('should regenerate cache when .stale marker exists', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // First load (creates cache)
      await registry.getSchema(branchRoot, entrySchemaRegistry)
      const cachePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.json')
      const cache1Stat = await fs.stat(cachePath)

      // Wait a bit to ensure modification time is different
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Invalidate cache
      await registry.invalidate(branchRoot)

      // Second load (should regenerate because of .stale marker)
      await registry.getSchema(branchRoot, entrySchemaRegistry)
      const cache2Stat = await fs.stat(cachePath)

      // Cache file should have been regenerated (newer modification time)
      expect(cache2Stat.mtimeMs).toBeGreaterThan(cache1Stat.mtimeMs)

      // Stale marker should be removed
      const stalePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.stale')
      const staleExists = await fs
        .access(stalePath)
        .then(() => true)
        .catch(() => false)
      expect(staleExists).toBe(false)
    })

    it('should handle missing cache file gracefully', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // First load without any cache
      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

      expect(result.schema).toBeDefined()
      expect(result.flatSchema).toBeDefined()
    })
  })

  describe('invalidate', () => {
    it('should force cache regeneration after invalidate()', async () => {
      const registry = new BranchSchemaCache()
      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // Load schema (populates cache)
      const result1 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Invalidate the specific branch
      await registry.invalidate(branchRoot)

      // Load again — should regenerate from disk, producing a new object
      const result2 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Should not be the same reference
      expect(result2).not.toBe(result1)
      // But should have the same content
      expect(result2.schema).toEqual(result1.schema)
    })
  })
})
