import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BranchSchemaCache } from './branch-schema-cache'
import type { FieldConfig } from './config'
import type { OperatingMode } from './operating-mode'
import type { EntrySchemaRegistry, SchemaResolutionResult } from './schema/types'
import { invalidateBranchContentCaches } from './content-index-generation'
import { resourceGenerationPath, readResourceGeneration } from './resource-generation'

/** Test subclass exposing a resolve counter, for asserting cache-hit/miss behavior. */
class CountingBranchSchemaCache extends BranchSchemaCache {
  public resolveCount = 0

  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
  ): Promise<SchemaResolutionResult> {
    this.resolveCount++
    return super.resolveFresh(contentRoot, entrySchemaRegistry)
  }
}

/**
 * Test subclass simulating a resolve that started before a mutation but blocks
 * before returning, so its (now stale) result lands after a concurrent
 * invalidate() + schema change - modeling the regen-after-invalidate race
 * (GIT-M2). Mirrors BlockingRegistry in branch-registry.test.ts.
 */
class BlockingBranchSchemaCache extends BranchSchemaCache {
  private resolveGate!: () => void
  private gate: Promise<void>
  private resolveResolved!: () => void
  /** Resolves once the underlying (pre-mutation) resolveSchema call has actually completed. */
  public resolved: Promise<void>

  constructor(mode?: OperatingMode) {
    super(mode)
    this.gate = new Promise<void>((resolve) => {
      this.resolveGate = resolve
    })
    this.resolved = new Promise<void>((resolve) => {
      this.resolveResolved = resolve
    })
  }

  unblock(): void {
    this.resolveGate()
  }

  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
  ): Promise<SchemaResolutionResult> {
    const result = await super.resolveFresh(contentRoot, entrySchemaRegistry)
    this.resolveResolved()
    await this.gate
    return result
  }
}

describe('BranchSchemaCache', () => {
  let tempDir: string
  let branchRoot: string
  let collectionPath: string
  let cachePath: string
  const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
    pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
  }

  const writeCollectionMeta = async (label: string) =>
    fs.writeFile(
      collectionPath,
      JSON.stringify({
        label,
        entries: [{ name: 'page', format: 'md', schema: 'pageSchema' }],
        order: [],
      }),
      'utf-8',
    )

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-cache-test-'))
    branchRoot = path.join(tempDir, 'branch-workspace')
    await fs.mkdir(branchRoot, { recursive: true })

    // Create content directory structure
    const contentRoot = path.join(branchRoot, 'content')
    await fs.mkdir(contentRoot, { recursive: true })
    collectionPath = path.join(contentRoot, '.collection.json')
    cachePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.json')

    await writeCollectionMeta('Root')
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('dev mode', () => {
    it('should load schema from .collection.json files on first access (cache miss)', async () => {
      const registry = new BranchSchemaCache()

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

      expect(result.schema).toBeDefined()
      expect(result.flatSchema).toBeDefined()
      expect(result.schema.entries).toBeDefined()
      expect(result.schema.entries?.length).toBe(1)
      expect(result.schema.entries?.[0].name).toBe('page')
    })

    it('should use cache on second access (cache hit)', async () => {
      const registry = new BranchSchemaCache()

      // First access - cache miss
      const result1 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Second access - should be faster (cache hit)
      const start2 = Date.now()
      const result2 = await registry.getSchema(branchRoot, entrySchemaRegistry)
      const duration2 = Date.now() - start2

      // Results should be the same
      expect(result2.schema).toEqual(result1.schema)
      expect(result2.flatSchema).toEqual(result1.flatSchema)

      // Second access (cache hit via file read) should be fast
      expect(duration2).toBeLessThan(100)
    })

    it('should write cache file to .canopy-meta/schema-cache.json', async () => {
      const registry = new BranchSchemaCache()

      await registry.getSchema(branchRoot, entrySchemaRegistry)

      const cacheExists = await fs
        .access(cachePath)
        .then(() => true)
        .catch(() => false)

      expect(cacheExists).toBe(true)

      // Verify cache structure
      const cacheContent = await fs.readFile(cachePath, 'utf-8')
      const cache = JSON.parse(cacheContent)
      expect(cache.version).toBe(3)
      expect(cache.schema).toBeDefined()
      expect(cache.flatSchema).toBeDefined()
      expect(cache.cachedAt).toBeDefined()
      // Never bumped yet in this fresh temp dir - generation is explicitly null.
      expect(cache.generation).toBeNull()
    })

    it('should invalidate cache when .collection.json is modified (devMode=true)', async () => {
      const registry = new BranchSchemaCache('dev')

      // First access — populates the cache
      const result1 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Wait so mtime is clearly different
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Modify the .collection.json file (simulating a direct edit outside the CMS)
      await writeCollectionMeta('Updated Root')

      // Second access with devMode=true — should detect stale cache via mtime
      const result2 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // The schema should reflect the updated label
      expect(result2.schema.label).toBe('Updated Root')
      // Should be a new object (cache was regenerated)
      expect(result2).not.toBe(result1)
    })

    it('should NOT invalidate cache on mtime when devMode=false', async () => {
      const registry = new BranchSchemaCache('prod')

      // First access — populates the cache
      await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Wait so mtime is clearly different
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Modify the .collection.json (bypassing SchemaOps — no marker bump either)
      await writeCollectionMeta('Updated Root')

      // Second access with devMode=false — should use cached version (no mtime check,
      // and the marker was never bumped so the token still matches)
      const result2 = await registry.getSchema(branchRoot, entrySchemaRegistry)

      // Should still have the original label (cache was NOT invalidated)
      expect(result2.schema.label).toBe('Root')
    })

    it('should handle missing cache file gracefully', async () => {
      const registry = new BranchSchemaCache()

      // First load without any cache
      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

      expect(result.schema).toBeDefined()
      expect(result.flatSchema).toBeDefined()
    })

    it('opportunistically cleans up a legacy .stale marker left by the old rename-based scheme', async () => {
      const registry = new BranchSchemaCache()

      // Simulate a leftover marker from before the marker-based scheme (e.g. a
      // process upgraded mid-flight, or an old cache dir carried over).
      const cacheDir = path.join(branchRoot, '.canopy-meta')
      await fs.mkdir(cacheDir, { recursive: true })
      const staleMarkerPath = path.join(cacheDir, 'schema-cache.stale')
      await fs.writeFile(staleMarkerPath, '', 'utf-8')

      await registry.getSchema(branchRoot, entrySchemaRegistry)

      const staleExists = await fs
        .access(staleMarkerPath)
        .then(() => true)
        .catch(() => false)
      expect(staleExists).toBe(false)
    })
  })

  describe('project root (static/build synthetic context)', () => {
    it('should NOT create .canopy-meta when branchRoot is the project root', async () => {
      const registry = new BranchSchemaCache()

      // Static deployments resolve branchRoot to process.cwd(). Simulate that by
      // pointing process.cwd() at the temp branch root, then using it as branchRoot.
      // (process.chdir() is unavailable in vitest workers, so spy on cwd instead.)
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(branchRoot)
      try {
        const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

        // Schema still resolves fresh (no disk cache layer)
        expect(result.schema.entries?.[0].name).toBe('page')

        // ...but nothing was written to .canopy-meta at the project root
        const metaPath = path.join(branchRoot, '.canopy-meta')
        const metaExists = await fs
          .access(metaPath)
          .then(() => true)
          .catch(() => false)
        expect(metaExists).toBe(false)

        // invalidate() must also be a no-op at the project root
        await registry.invalidate(branchRoot)
        const metaExistsAfterInvalidate = await fs
          .access(metaPath)
          .then(() => true)
          .catch(() => false)
        expect(metaExistsAfterInvalidate).toBe(false)
      } finally {
        cwdSpy.mockRestore()
      }
    })
  })

  describe('marker-based freshness', () => {
    it('embeds the current marker token and serves the cache without re-resolving when tokens match', async () => {
      const registry = new CountingBranchSchemaCache()

      const first = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(1)

      const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(cache.generation).toBeNull() // never bumped in this fresh temp dir

      // No mutation, no invalidate() — marker unchanged, so the second call is
      // a pure cache hit with no re-resolve.
      const second = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(second.schema).toEqual(first.schema)
      expect(registry.resolveCount).toBe(1)
    })

    it('invalidate() bumps the marker so the next getSchema re-resolves (prod mode, no mtime walk)', async () => {
      const registry = new CountingBranchSchemaCache('prod')

      await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(1)

      await writeCollectionMeta('Updated via invalidate')
      await registry.invalidate(branchRoot)

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(2)
      expect(result.schema.label).toBe('Updated via invalidate')
    })

    it('regenerates when a foreign host bumps the marker directly (prod backstop)', async () => {
      const registry = new CountingBranchSchemaCache('prod')

      await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(1)

      // Simulate a foreign process's bump (e.g. a worker rebase or CLI sync
      // that doesn't call invalidate() but bumps the marker via the combined
      // helper) by overwriting the marker file directly, and mutate the
      // schema behind this instance's back.
      await writeCollectionMeta('Changed behind the cache')
      await fs.writeFile(resourceGenerationPath(branchRoot, 'schema'), 'foreign-token-123')

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(2) // forced re-resolve by the marker mismatch
      expect(result.schema.label).toBe('Changed behind the cache')

      const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(cache.generation).toBe('foreign-token-123')
    })

    it('regenerates when the on-disk cache is an old (v2, pre-marker) version', async () => {
      const registry = new BranchSchemaCache('prod')

      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          version: 2,
          schema: { label: 'Stale v2', entries: [] },
          flatSchema: [],
          cachedAt: new Date().toISOString(),
          // no `generation` field — matches what a pre-marker deploy left on EFS
        }),
      )

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(result.schema.label).toBe('Root') // re-resolved from disk, not the stale v2 blob

      const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(cache.version).toBe(3)
    })

    it('serves a fresh resolve but does not persist when the marker is unreadable', async () => {
      const registry = new BranchSchemaCache('prod')

      // Replace the marker file location with a directory so reading it fails
      // for a reason other than ENOENT.
      const markerPath = resourceGenerationPath(branchRoot, 'schema')
      await fs.mkdir(markerPath, { recursive: true })

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(result.schema.label).toBe('Root') // fresh scan result is served to the caller

      // But nothing was persisted — we can't attribute a token to this resolve.
      const cacheExists = await fs
        .access(cachePath)
        .then(() => true)
        .catch(() => false)
      expect(cacheExists).toBe(false)
    })

    it('self-heals the regen-after-invalidate race (GIT-M2): a resolve that started before invalidate() lands after it, but the next read re-resolves', async () => {
      const blocking = new BlockingBranchSchemaCache('prod')

      // "Host A": begins resolving before the mutation below (captures token
      // T0 = null, since never bumped), reads the ORIGINAL (pre-mutation)
      // .collection.json, then blocks before persisting.
      const staleResultPromise = blocking.getSchema(branchRoot, entrySchemaRegistry)

      // Wait for the actual resolveSchema call to complete (capturing
      // pre-mutation state) before mutating - not just a microtask tick,
      // since the resolve involves real fs I/O.
      await blocking.resolved

      // "Host B": invalidates (bumps the marker to T1) and changes the schema.
      const plain = new BranchSchemaCache('prod')
      await plain.invalidate(branchRoot)
      const t1Read = await readResourceGeneration(branchRoot, 'schema')
      if (!t1Read.ok) throw new Error('expected marker read to succeed')
      const t1 = t1Read.token
      expect(t1).not.toBeNull()

      await writeCollectionMeta('Changed during host A resolve')

      // Now let host A's stale write land LAST, over the (nonexistent yet)
      // correct snapshot.
      blocking.unblock()
      const staleResult = await staleResultPromise
      expect(staleResult.schema.label).toBe('Root') // host A's own (stale) view

      const landedCache = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(landedCache.schema.label).toBe('Root') // stale snapshot written to disk
      expect(landedCache.generation).not.toBe(t1) // but embeds the OLD token, T0 != T1

      // A subsequent getSchema() (any instance) detects the mismatch and self-heals.
      const healed = await plain.getSchema(branchRoot, entrySchemaRegistry)
      expect(healed.schema.label).toBe('Changed during host A resolve')

      const healedCache = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(healedCache.generation).toBe(t1)
    })
  })

  describe('invalidate', () => {
    it('bumps the generation marker (does not write a .stale file)', async () => {
      const registry = new BranchSchemaCache()

      await registry.getSchema(branchRoot, entrySchemaRegistry)
      await registry.invalidate(branchRoot)

      const markerPath = resourceGenerationPath(branchRoot, 'schema')
      const token = await fs.readFile(markerPath, 'utf-8')
      expect(token.length).toBeGreaterThan(0)

      const staleExists = await fs
        .access(path.join(branchRoot, '.canopy-meta', 'schema-cache.stale'))
        .then(() => true)
        .catch(() => false)
      expect(staleExists).toBe(false)
    })

    it('is safe to call when no cache exists yet', async () => {
      const registry = new BranchSchemaCache()
      await registry.invalidate(branchRoot)

      const markerPath = resourceGenerationPath(branchRoot, 'schema')
      const token = await fs.readFile(markerPath, 'utf-8')
      expect(token.length).toBeGreaterThan(0)
    })

    it('should force cache regeneration after invalidate()', async () => {
      const registry = new BranchSchemaCache()

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

  describe('invalidateBranchContentCaches (combined helper)', () => {
    it('bumps both the content-index and schema generation markers', async () => {
      const contentIndexMarkerPath = resourceGenerationPath(branchRoot, 'content-index')
      const schemaMarkerPath = resourceGenerationPath(branchRoot, 'schema')

      const beforeContentIndex = await readResourceGeneration(branchRoot, 'content-index')
      const beforeSchema = await readResourceGeneration(branchRoot, 'schema')
      expect(beforeContentIndex).toEqual({ ok: true, token: null })
      expect(beforeSchema).toEqual({ ok: true, token: null })

      await invalidateBranchContentCaches(branchRoot)

      const afterContentIndexToken = await fs.readFile(contentIndexMarkerPath, 'utf-8')
      const afterSchemaToken = await fs.readFile(schemaMarkerPath, 'utf-8')
      expect(afterContentIndexToken.length).toBeGreaterThan(0)
      expect(afterSchemaToken.length).toBeGreaterThan(0)
      expect(afterContentIndexToken).not.toBe(afterSchemaToken)

      // And a schema cache built before the call is now stale.
      const registry = new CountingBranchSchemaCache('prod')
      const cache: import('./branch-schema-cache').BranchSchemaCacheEntry = {
        version: 3,
        schema: { label: 'Pre-existing', entries: [] },
        flatSchema: [],
        cachedAt: new Date().toISOString(),
        generation: null,
      }
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(cache))

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(1) // forced to re-resolve, not served the pre-existing blob
      expect(result.schema.label).toBe('Root')
    })
  })
})
