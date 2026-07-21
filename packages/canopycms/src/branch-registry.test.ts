import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchRegistry, type BranchRegistrySnapshot } from './branch-registry'
import { getBranchMetadataFileManager } from './branch-metadata'
import { resourceGenerationPath } from './resource-generation'
import type { BranchContext } from './types'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-registry-'))

/**
 * Create a branch directory with a valid branch.json metadata file
 */
const createBranchWithMetadata = async (
  root: string,
  branchName: string,
  status: 'editing' | 'submitted' = 'editing',
) => {
  const branchDir = path.join(root, branchName)
  const metaDir = path.join(branchDir, '.canopy-meta')
  await fs.mkdir(metaDir, { recursive: true })

  const metadata = getBranchMetadataFileManager(branchDir, root)
  await metadata.save({
    branch: {
      name: branchName,
      status,
      createdBy: 'user-1',
    },
  })
}

/**
 * Write a branch.json directly to disk, bypassing BranchMetadataFileManager.save()
 * (and therefore its automatic registry.invalidate() call). Use this to simulate a
 * branch appearing "behind the cache's back" - e.g. a mutation on another host that
 * hasn't yet been observed - as opposed to createBranchWithMetadata, which always
 * leaves the registry cache fresh as a side effect.
 */
const writeBranchMetadataDirectly = async (
  root: string,
  branchName: string,
  status: 'editing' | 'submitted' = 'editing',
) => {
  const branchDir = path.join(root, branchName)
  const metaDir = path.join(branchDir, '.canopy-meta')
  await fs.mkdir(metaDir, { recursive: true })
  await fs.writeFile(
    path.join(metaDir, 'branch.json'),
    JSON.stringify({
      schemaVersion: 1,
      branch: {
        name: branchName,
        status,
        access: {},
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
  )
}

const readRegistrySnapshot = async (root: string): Promise<BranchRegistrySnapshot> => {
  const raw = await fs.readFile(path.join(root, 'branches.json'), 'utf8')
  return JSON.parse(raw) as BranchRegistrySnapshot
}

const registryFileExists = async (root: string): Promise<boolean> =>
  fs
    .stat(path.join(root, 'branches.json'))
    .then(() => true)
    .catch(() => false)

/** Test subclass exposing a scan counter, for asserting dedup/caching behavior. */
class CountingRegistry extends BranchRegistry {
  public scanCount = 0

  protected async scanBranchDirectories(): Promise<BranchContext[]> {
    this.scanCount++
    return super.scanBranchDirectories()
  }
}

/**
 * Test subclass simulating a scan whose reads are already in flight (as if
 * served from stale NFS dentry/attribute caches) when it is asked to block:
 * the underlying scan runs immediately (so it captures whatever state exists
 * at call time), but the caller doesn't observe the result until manually
 * unblocked - modeling a regeneration that started before a mutation but
 * lands its rename after it.
 */
class BlockingRegistry extends BranchRegistry {
  private resolveGate!: () => void
  private gate: Promise<void>
  private resolveScanned!: () => void
  /** Resolves once the underlying (pre-mutation) scan has actually completed. */
  public scanned: Promise<void>

  constructor(root: string) {
    super(root)
    this.gate = new Promise<void>((resolve) => {
      this.resolveGate = resolve
    })
    this.scanned = new Promise<void>((resolve) => {
      this.resolveScanned = resolve
    })
  }

  unblock(): void {
    this.resolveGate()
  }

  protected async scanBranchDirectories(): Promise<BranchContext[]> {
    const snapshot = await super.scanBranchDirectories()
    this.resolveScanned()
    await this.gate
    return snapshot
  }
}

describe('BranchRegistry', () => {
  describe('list()', () => {
    it('returns empty array when no branches exist', async () => {
      const root = await tmpDir()
      const registry = new BranchRegistry(root)

      const branches = await registry.list()
      expect(branches).toEqual([])
    })

    it('scans branch directories and returns branches', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')
      await createBranchWithMetadata(root, 'feature-b')

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches).toHaveLength(2)
      expect(branches.map((b) => b.branch.name).sort()).toEqual(['feature-a', 'feature-b'])
    })

    it('skips directories without branch.json', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')
      // Create a directory without metadata
      await fs.mkdir(path.join(root, 'empty-dir'), { recursive: true })

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches).toHaveLength(1)
      expect(branches[0].branch.name).toBe('feature-a')
    })

    it('skips hidden directories like .canopycms', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')
      // Create .canopycms directory at root (registry storage)
      await fs.mkdir(path.join(root, '.canopy-meta'), { recursive: true })

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches).toHaveLength(1)
    })

    it('creates cache file after first list()', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      await registry.list()

      expect(await registryFileExists(root)).toBe(true)
    })

    it('uses cached result on subsequent calls (no invalidation)', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)

      // First call regenerates
      const first = await registry.list()
      expect(first).toHaveLength(1)

      // Add another branch directly by writing file (bypassing invalidation)
      await writeBranchMetadataDirectly(root, 'feature-b')

      // Second call should return cached result (still 1 branch) since the
      // marker was never bumped
      const second = await registry.list()
      expect(second).toHaveLength(1)
    })

    it('embeds the current marker token and serves cache without rescanning when tokens match', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      // createBranchWithMetadata's own save() already invalidated+eager-regenerated
      // the cache, so this registry's list() is a pure cache hit: no scan needed.
      const registry = new CountingRegistry(root)
      const first = await registry.list()
      expect(first).toHaveLength(1)
      expect(registry.scanCount).toBe(0)

      // Delete the branch dir behind the cache's back - no invalidate() called,
      // so the marker (unchanged since creation) still matches the cached snapshot.
      await fs.rm(path.join(root, 'feature-a'), { recursive: true, force: true })

      const second = await registry.list()
      expect(second).toHaveLength(1) // stale data served, no rescan
      expect(registry.scanCount).toBe(0)
    })

    it('regenerates when a foreign host bumps the marker', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new CountingRegistry(root)
      await registry.list()
      expect(registry.scanCount).toBe(0) // cache already fresh from creation

      await createBranchWithMetadata(root, 'feature-b')
      // Simulate another host's bump by overwriting the marker file directly
      // (the directory already exists - createBranchWithMetadata's invalidate()
      // created it when it first bumped the marker)
      await fs.writeFile(resourceGenerationPath(root, 'branch-registry'), 'foreign-token-123')

      const branches = await registry.list()
      expect(branches).toHaveLength(2)
      expect(registry.scanCount).toBe(1) // one regeneration forced by the mismatch
    })

    it('regenerates when the on-disk snapshot is an old (v1) version', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      await fs.writeFile(
        path.join(root, 'branches.json'),
        JSON.stringify({ version: 1, branches: [] }),
      )

      const registry = new BranchRegistry(root)
      const branches = await registry.list()
      expect(branches).toHaveLength(1)
      expect(branches[0].branch.name).toBe('feature-a')

      // Regeneration also rewrites the snapshot at the current version
      const snapshot = await readRegistrySnapshot(root)
      expect(snapshot.version).toBe(2)
    })

    it('regenerates and does not persist when the marker is unreadable', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')
      // Snapshot already exists and is fresh, thanks to createBranchWithMetadata's
      // own invalidate()+eager-regen. Capture it so we can assert it is untouched.
      const before = await fs.readFile(path.join(root, 'branches.json'), 'utf8')

      const markerPath = resourceGenerationPath(root, 'branch-registry')
      // Replace the marker file with a directory so reading it fails for a
      // reason other than ENOENT (createBranchWithMetadata's invalidate()
      // already created it as a file, so remove that first)
      await fs.rm(markerPath, { force: true })
      await fs.mkdir(markerPath, { recursive: true })

      // Add a branch behind the cache's back so a rescan (if it persisted)
      // would be observably different from the untouched snapshot.
      await writeBranchMetadataDirectly(root, 'feature-b')

      const registry = new BranchRegistry(root)
      const branches = await registry.list()
      expect(branches).toHaveLength(2) // fresh scan result is served to the caller

      // But nothing was persisted - we can't attribute a token to this scan -
      // so the on-disk snapshot is exactly as it was before.
      const after = await fs.readFile(path.join(root, 'branches.json'), 'utf8')
      expect(after).toBe(before)
    })

    it('shares one scan across concurrent list() calls', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      // Force staleness (bypassing the auto-fresh cache from creation) so both
      // concurrent calls below actually need to regenerate.
      await fs.writeFile(resourceGenerationPath(root, 'branch-registry'), 'forced-stale-token')

      const registry = new CountingRegistry(root)
      const [a, b] = await Promise.all([registry.list(), registry.list()])

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
      expect(registry.scanCount).toBe(1)
    })
  })

  describe('get()', () => {
    it('returns branch by name', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      const branch = await registry.get('feature-a')

      expect(branch?.branch.name).toBe('feature-a')
    })

    it('returns undefined for non-existent branch', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      const branch = await registry.get('does-not-exist')

      expect(branch).toBeUndefined()
    })

    it('forces a fresh regeneration on a suspicious miss, then throttles', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new CountingRegistry(root)
      await registry.list()
      expect(registry.scanCount).toBe(0) // cache already fresh from creation

      // Created behind the cache - bypasses invalidate(), so the cached
      // snapshot has no idea this branch exists.
      await writeBranchMetadataDirectly(root, 'feature-x')

      const found = await registry.get('feature-x')
      expect(found?.branch.name).toBe('feature-x')
      expect(registry.scanCount).toBe(1) // forced refresh happened

      // Immediate second miss within the throttle window must not rescan
      const missed = await registry.get('feature-y')
      expect(missed).toBeUndefined()
      expect(registry.scanCount).toBe(1)
    })
  })

  describe('invalidate()', () => {
    it('causes next list() to regenerate cache', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)

      // First call populates cache
      const first = await registry.list()
      expect(first).toHaveLength(1)

      // Add another branch
      await createBranchWithMetadata(root, 'feature-b')

      // Without invalidation, cache would still show 1
      // But with invalidation, it should regenerate
      await registry.invalidate()

      const after = await registry.list()
      expect(after).toHaveLength(2)
    })

    it('is safe to call when no cache exists', async () => {
      const root = await tmpDir()
      const registry = new BranchRegistry(root)

      // Should not throw
      await registry.invalidate()
    })

    it('bumps the marker token and eagerly rewrites branches.json with no list() call', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      // createBranchWithMetadata's own save() already invalidated once, so the
      // snapshot already embeds a real (non-null) token from that bump.
      const before = await readRegistrySnapshot(root)
      expect(before.generation).not.toBeNull()

      const registry = new BranchRegistry(root)
      await registry.invalidate()

      const markerPath = resourceGenerationPath(root, 'branch-registry')
      const token = await fs.readFile(markerPath, 'utf8')
      expect(token.length).toBeGreaterThan(0)
      expect(token).not.toBe(before.generation)

      // Eagerly rewritten without any list() call in between
      const after = await readRegistrySnapshot(root)
      expect(after.generation).toBe(token)
      expect(after.branches).toHaveLength(1)
    })

    it('self-heals the GIT-M1 regen-after-invalidate race', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')
      // createBranchWithMetadata's own save() already invalidated once, leaving a
      // fresh cache in place. Delete it so hostA's list() below actually has to
      // regenerate (rather than short-circuiting on a cache hit), simulating a
      // process whose regeneration was already underway before the mutation.
      await fs.rm(path.join(root, 'branches.json'))

      // "Host A": began scanning before the mutation below (captures token T0),
      // and blocks before landing its (now stale) snapshot.
      const hostA = new BlockingRegistry(root)
      const staleListPromise = hostA.list() // captures token T0, scans [feature-a], then blocks

      // Wait for host A's actual scan to complete (capturing pre-mutation
      // state) before mutating - not just a microtask tick, since the scan
      // involves real fs I/O.
      await hostA.scanned

      // "Host B": mutates a branch.json. BranchMetadataFileManager.save()
      // itself calls registry.invalidate() (see branch-metadata.ts) - bumping
      // the marker to T1 and eagerly regenerating a correct snapshot
      // reflecting both branches, exactly as the real save() call path does.
      await createBranchWithMetadata(root, 'feature-b')

      const correctSnapshot = await readRegistrySnapshot(root)
      expect(correctSnapshot.branches).toHaveLength(2)
      const t1 = correctSnapshot.generation
      expect(t1).not.toBeNull()

      // Now let host A's stale rename land LAST, over the correct snapshot.
      hostA.unblock()
      const staleBranches = await staleListPromise
      expect(staleBranches).toHaveLength(1) // host A's own (stale) view

      const landedSnapshot = await readRegistrySnapshot(root)
      expect(landedSnapshot.branches).toHaveLength(1) // stale snapshot resurrected
      expect(landedSnapshot.generation).not.toBe(t1) // but embeds the OLD token, T0 != T1

      // A subsequent list() (any host) detects the mismatch and self-heals
      const thirdHost = new BranchRegistry(root)
      const healed = await thirdHost.list()
      expect(healed).toHaveLength(2)

      const healedSnapshot = await readRegistrySnapshot(root)
      expect(healedSnapshot.generation).toBe(t1)
    })

    it('no longer produces a branches.stale.json artifact (legacy rename scheme retired)', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      await registry.list() // Create cache

      const cacheFile = path.join(root, 'branches.json')
      const staleFile = path.join(root, 'branches.stale.json')

      expect(
        await fs
          .stat(cacheFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(
        await fs
          .stat(staleFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)

      await registry.invalidate()

      // The marker-based scheme eager-regenerates in place: branches.json
      // still exists (freshly rewritten), and no branches.stale.json is
      // ever created.
      expect(
        await fs
          .stat(cacheFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(
        await fs
          .stat(staleFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    })
  })

  describe('cache integrity', () => {
    it('includes workspace paths in branch state', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches[0].branchRoot).toBe(path.join(root, 'feature-a'))
      expect(branches[0].baseRoot).toBe(root)
    })

    it('reflects status from branch.json', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a', 'submitted')

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches[0].branch.status).toBe('submitted')
    })
  })
})
