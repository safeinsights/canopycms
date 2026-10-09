import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BranchSchemaCache } from './branch-schema-cache'
import type { FieldConfig } from './config'
import type { OperatingMode } from './operating-mode'
import type {
  EntrySchemaRegistry,
  SchemaResolutionResult,
  UnknownSchemaPolicy,
} from './schema/types'
import { invalidateBranchContentCaches } from './content-index-generation'
import { resourceGenerationPath, readResourceGeneration } from './resource-generation'
import { initTestRepo } from './test-utils'
import { registryFingerprint } from './schema/registry-fingerprint'
import { resetCanopyLogger, setCanopyLogger } from './utils/logger'

/** Test subclass exposing a resolve counter, for asserting cache-hit/miss behavior. */
class CountingBranchSchemaCache extends BranchSchemaCache {
  public resolveCount = 0

  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    unknownSchema: UnknownSchemaPolicy,
  ): Promise<SchemaResolutionResult> {
    this.resolveCount++
    return super.resolveFresh(contentRoot, entrySchemaRegistry, unknownSchema)
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
    unknownSchema: UnknownSchemaPolicy,
  ): Promise<SchemaResolutionResult> {
    const result = await super.resolveFresh(contentRoot, entrySchemaRegistry, unknownSchema)
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

    it('falls back to .canopy-meta/schema-cache.json when branchRoot is not a git clone', async () => {
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
      expect(cache.version).toBe(4)
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

  describe('cache location in a git clone', () => {
    const exists = (p: string) =>
      fs.access(p).then(
        () => true,
        () => false,
      )

    it('stores the cache under .git/canopycms/ and serves it from there', async () => {
      await initTestRepo(branchRoot)
      const registry = new CountingBranchSchemaCache()

      await registry.getSchema(branchRoot, entrySchemaRegistry)
      await registry.getSchema(branchRoot, entrySchemaRegistry)

      expect(registry.resolveCount).toBe(1)
      await expect(
        exists(path.join(branchRoot, '.git', 'canopycms', 'schema-cache.json')),
      ).resolves.toBe(true)
      await expect(exists(cachePath)).resolves.toBe(false)
    })

    it('keeps a committed .canopy-meta/schema-cache.json unmodified across a resolve', async () => {
      const git = await initTestRepo(branchRoot)
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, '{"committed":true}', 'utf-8')
      await git.add(['.'])
      await git.commit('adopter commits canopycms state')

      await new BranchSchemaCache().getSchema(branchRoot, entrySchemaRegistry)

      expect(await git.raw(['status', '--porcelain', '--untracked-files=no'])).toBe('')
    })

    it('still removes the retired .stale marker from .canopy-meta/', async () => {
      await initTestRepo(branchRoot)
      const staleMarkerPath = path.join(branchRoot, '.canopy-meta', 'schema-cache.stale')
      await fs.mkdir(path.dirname(staleMarkerPath), { recursive: true })
      await fs.writeFile(staleMarkerPath, '', 'utf-8')

      await new BranchSchemaCache().getSchema(branchRoot, entrySchemaRegistry)

      await expect(exists(staleMarkerPath)).resolves.toBe(false)
    })

    it('falls back to .canopy-meta/ when .git is a file (a linked worktree)', async () => {
      await fs.writeFile(path.join(branchRoot, '.git'), 'gitdir: /elsewhere\n', 'utf-8')

      await new BranchSchemaCache().getSchema(branchRoot, entrySchemaRegistry)

      await expect(exists(cachePath)).resolves.toBe(true)
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
      expect(cache.version).toBe(4)
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

    it('cleans up the temp file when the atomic rename fails (item 7 fix)', async () => {
      const registry = new BranchSchemaCache('prod')
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EIO: simulated'))

      await expect(registry.getSchema(branchRoot, entrySchemaRegistry)).rejects.toThrow(
        'EIO: simulated',
      )
      renameSpy.mockRestore()

      const metaDir = path.join(branchRoot, '.canopy-meta')
      const entries = await fs.readdir(metaDir).catch(() => [] as string[])
      const leakedTempFiles = entries.filter((entry) => entry.includes('.tmp'))
      expect(leakedTempFiles).toEqual([])
    })
  })

  describe('resolveAndPersist (item 8 fix)', () => {
    it('is not short-circuited by a foreign fresh-token/stale-scan snapshot, unlike getSchema()', async () => {
      const registry = new BranchSchemaCache('prod')

      // invalidate() bumps the marker to a fresh token T1.
      await registry.invalidate(branchRoot)
      const t1Read = await readResourceGeneration(branchRoot, 'schema')
      if (!t1Read.ok) throw new Error('expected marker read to succeed')

      // Change the real on-disk schema AFTER invalidating (simulating the
      // mutation invalidateSchemaCache() is reacting to).
      await writeCollectionMeta('Real current schema')

      // Hand-write a cache file simulating a FOREIGN host's window-E
      // snapshot: it embeds the CURRENT (fresh) token T1, but its `schema`
      // is stale data that predates the mutation above -- exactly what a
      // concurrent host's own eager re-resolve would produce if ITS scan
      // was served from stale NFS caches. This is what "another host's
      // bump" looks like on disk (see docs/concurrency.md's testing
      // patterns: "overwrite the marker file directly").
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          version: 4,
          schema: { label: 'Foreign stale snapshot', entries: [] },
          flatSchema: [],
          cachedAt: new Date().toISOString(),
          generation: t1Read.token,
          registryFingerprint: registryFingerprint(entrySchemaRegistry),
          issues: [],
        }),
      )

      // getSchema()'s cache-read fast path would accept this foreign
      // snapshot as current (token matches) and wrongly serve/re-persist
      // the stale data -- demonstrating why invalidateSchemaCache() must
      // not use it for the eager re-resolve.
      const viaGetSchema = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(viaGetSchema.schema.label).toBe('Foreign stale snapshot')

      // resolveAndPersist() never reads the cache file, so it always
      // re-scans and overwrites the foreign snapshot with the real result.
      const result = await registry.resolveAndPersist(branchRoot, entrySchemaRegistry)
      expect(result.schema.label).toBe('Real current schema')

      const onDisk = JSON.parse(await fs.readFile(cachePath, 'utf-8'))
      expect(onDisk.schema.label).toBe('Real current schema')
    })

    it('honors skipDiskCache (build mode / project-root branchRoot) like loadFromCacheOrResolve does', async () => {
      const registry = new BranchSchemaCache()

      // Static deployments resolve branchRoot to process.cwd() -- simulate
      // that the same way the "project root" suite above does.
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(branchRoot)
      try {
        const result = await registry.resolveAndPersist(branchRoot, entrySchemaRegistry)
        expect(result.schema.entries?.[0].name).toBe('page')

        const metaExists = await fs
          .access(path.join(branchRoot, '.canopy-meta'))
          .then(() => true)
          .catch(() => false)
        expect(metaExists).toBe(false)
      } finally {
        cwdSpy.mockRestore()
      }
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
        version: 4,
        schema: { label: 'Pre-existing', entries: [] },
        flatSchema: [],
        cachedAt: new Date().toISOString(),
        generation: null,
        registryFingerprint: registryFingerprint(entrySchemaRegistry),
        issues: [],
      }
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(cache))

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(registry.resolveCount).toBe(1) // forced to re-resolve, not served the pre-existing blob
      expect(result.schema.label).toBe('Root')
    })
  })

  /** Run `fn` with process.cwd() at branchRoot: the checkout, as a build or static deploy reads it. */
  const atCheckout = async <T>(fn: () => Promise<T>): Promise<T> => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(branchRoot)
    try {
      return await fn()
    } finally {
      cwdSpy.mockRestore()
    }
  }

  describe('reference entryTypes validation', () => {
    // Degraded resolves log their issues; captured here so tests that do not assert on them stay quiet.
    beforeEach(() => setCanopyLogger({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
    afterEach(() => resetCanopyLogger())

    const registryWithReference: Record<string, readonly FieldConfig[]> = {
      pageSchema: [
        { name: 'title', type: 'string', label: 'Title' },
        { name: 'related', type: 'reference', entryTypes: ['pge'] } as FieldConfig,
      ],
    }

    it('rejects, at the checkout, a schema whose reference field names an unknown entry type', async () => {
      const registry = new BranchSchemaCache()

      await atCheckout(() =>
        expect(registry.getSchema(branchRoot, registryWithReference)).rejects.toThrow(
          /entryType.*"pge"/s,
        ),
      )
    })

    it('names the field and suggests the closest real entry type', async () => {
      const registry = new BranchSchemaCache()

      await atCheckout(() =>
        expect(registry.getSchema(branchRoot, registryWithReference)).rejects.toThrow(
          /Did you mean "page"\?/,
        ),
      )
    })

    it('reports it as an issue in a branch workspace instead of failing the schema', async () => {
      const registry = new BranchSchemaCache()

      const result = await registry.getSchema(branchRoot, registryWithReference)

      expect(result.schema.entries?.[0].name).toBe('page')
      expect(result.issues).toEqual([
        { kind: 'reference-entry-type', message: expect.stringMatching(/entryType "pge"/) },
      ])
    })

    it('still resolves when the entryType exists', async () => {
      const registry = new BranchSchemaCache()

      const result = await registry.getSchema(branchRoot, {
        pageSchema: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'related', type: 'reference', entryTypes: ['page'] } as FieldConfig,
        ],
      })
      expect(result.schema.label).toBe('Root')
      expect(result.issues).toEqual([])
    })
  })

  // A merge can sync content naming a schema into a workspace before the image defining it is
  // live; that must cost one entry type, not the branch's whole schema.
  describe('unknown entry schema', () => {
    // Degraded resolves log their issues; captured here so tests that do not assert on them stay quiet.
    beforeEach(() => setCanopyLogger({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
    afterEach(() => resetCanopyLogger())

    const writeMetaNaming = (schema: string) =>
      fs.writeFile(
        collectionPath,
        JSON.stringify({
          label: 'Root',
          entries: [
            { name: 'page', format: 'md', schema: 'pageSchema' },
            { name: 'widget', format: 'json', schema },
          ],
          order: [],
        }),
        'utf-8',
      )

    it('marks only the entry type naming it unavailable, in a branch workspace', async () => {
      await writeMetaNaming('widgetSchemaA')
      const registry = new BranchSchemaCache('prod')

      const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

      const [page, widget] = result.schema.entries ?? []
      expect(page.schema).toBe(entrySchemaRegistry.pageSchema)
      expect(page.unavailable).toBeUndefined()
      expect(widget).toMatchObject({
        name: 'widget',
        schema: [],
        schemaRef: 'widgetSchemaA',
        unavailable: {
          reason: 'unknown-schema',
          schemaRef: 'widgetSchemaA',
          metaFile: '.collection.json',
        },
      })
      const flatWidget = result.flatSchema.find((item) => item.name === 'widget')
      expect(flatWidget?.type === 'entry-type' && flatWidget.unavailable?.schemaRef).toBe(
        'widgetSchemaA',
      )
      expect(result.issues).toEqual([
        expect.objectContaining({
          kind: 'unknown-schema',
          collectionPath: '',
          entryType: 'widget',
          schemaRef: 'widgetSchemaA',
          metaFile: '.collection.json',
        }),
      ])
    })

    it('throws at the checkout, where code and content share a commit', async () => {
      await writeMetaNaming('widgetSchemaB')
      const registry = new BranchSchemaCache('prod')

      await atCheckout(() =>
        expect(registry.getSchema(branchRoot, entrySchemaRegistry)).rejects.toThrow(
          /Schema reference "widgetSchemaB".*not found in registry/,
        ),
      )
    })

    it('logs each missing schema once per process, cached or not', async () => {
      await writeMetaNaming('widgetSchemaC')
      const warn = vi.fn()
      setCanopyLogger({ log: vi.fn(), warn, error: vi.fn() })
      try {
        const registry = new CountingBranchSchemaCache('prod')
        await registry.getSchema(branchRoot, entrySchemaRegistry)
        await registry.getSchema(branchRoot, entrySchemaRegistry)
        await new BranchSchemaCache('prod').resolveAndPersist(branchRoot, entrySchemaRegistry)

        expect(registry.resolveCount).toBe(1) // the second read was the cached snapshot
        const lines = warn.mock.calls.map((call) => String(call[0]))
        expect(lines.filter((line) => line.includes('"widgetSchemaC"'))).toHaveLength(1)
      } finally {
        resetCanopyLogger()
      }
    })

    it('logs the issues of a snapshot another process resolved', async () => {
      const issue = {
        kind: 'unknown-schema' as const,
        collectionPath: '',
        entryType: 'widget',
        schemaRef: 'widgetSchemaE',
        metaFile: '.collection.json',
        message: 'not found in registry',
      }
      const snapshot: import('./branch-schema-cache').BranchSchemaCacheEntry = {
        version: 4,
        schema: { label: 'Resolved elsewhere', entries: [] },
        flatSchema: [],
        cachedAt: new Date().toISOString(),
        generation: null,
        registryFingerprint: registryFingerprint(entrySchemaRegistry),
        issues: [issue],
      }
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(snapshot))
      const warn = vi.fn()
      setCanopyLogger({ log: vi.fn(), warn, error: vi.fn() })
      try {
        const registry = new CountingBranchSchemaCache('prod')
        const result = await registry.getSchema(branchRoot, entrySchemaRegistry)

        expect(registry.resolveCount).toBe(0)
        expect(result.issues).toEqual([issue])
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"widgetSchemaE"'))
      } finally {
        resetCanopyLogger()
      }
    })

    it('recovers on the first read under an image whose registry defines it, with no marker bump', async () => {
      await writeMetaNaming('widgetSchemaD')
      const registry = new CountingBranchSchemaCache('prod')
      const degraded = await registry.getSchema(branchRoot, entrySchemaRegistry)
      expect(degraded.issues).toHaveLength(1)

      const deployed = {
        ...entrySchemaRegistry,
        widgetSchemaD: [{ name: 'size', type: 'number', label: 'Size' }] as FieldConfig[],
      }
      const result = await registry.getSchema(branchRoot, deployed)

      expect(registry.resolveCount).toBe(2)
      expect(result.issues).toEqual([])
      expect(result.schema.entries?.[1]).toMatchObject({
        name: 'widget',
        schema: deployed.widgetSchemaD,
      })
      expect(result.schema.entries?.[1].unavailable).toBeUndefined()
    })
  })

  describe('registry fingerprint', () => {
    // A deploy bumps no generation marker, so a snapshot must name the registry it was resolved
    // against; otherwise a new image keeps validating saves against the old image's fields.
    it('re-resolves when the registry changes with no marker bump', async () => {
      const registry = new CountingBranchSchemaCache('prod')
      await registry.getSchema(branchRoot, entrySchemaRegistry)

      const changedFields = {
        pageSchema: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'summary', type: 'string', label: 'Summary' },
        ] as FieldConfig[],
      }
      const result = await registry.getSchema(branchRoot, changedFields)

      expect(registry.resolveCount).toBe(2)
      const page = result.flatSchema.find((item) => item.type === 'entry-type')
      expect(page?.type === 'entry-type' && page.schema.map((field) => field.name)).toEqual([
        'title',
        'summary',
      ])
    })

    it('serves the snapshot to an equal registry built separately, as on another cold start', async () => {
      const registry = new CountingBranchSchemaCache('prod')
      await registry.getSchema(branchRoot, entrySchemaRegistry)

      const coldStart = JSON.parse(JSON.stringify(entrySchemaRegistry)) as EntrySchemaRegistry
      await registry.getSchema(branchRoot, coldStart)

      expect(registry.resolveCount).toBe(1)
    })
  })
})
