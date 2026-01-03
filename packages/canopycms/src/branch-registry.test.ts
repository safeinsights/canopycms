import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchRegistry } from './branch-registry'
import { getBranchMetadataFileManager } from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-registry-'))

/**
 * Create a branch directory with a valid branch.json metadata file
 */
const createBranchWithMetadata = async (
  root: string,
  branchName: string,
  status: 'editing' | 'submitted' = 'editing'
) => {
  const branchDir = path.join(root, branchName)
  const metaDir = path.join(branchDir, '.canopycms')
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
      await fs.mkdir(path.join(root, '.canopycms'), { recursive: true })

      const registry = new BranchRegistry(root)
      const branches = await registry.list()

      expect(branches).toHaveLength(1)
    })

    it('creates cache file after first list()', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      await registry.list()

      // Cache file should exist
      const cacheFile = path.join(root, '.canopycms', 'branches.json')
      const exists = await fs
        .stat(cacheFile)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    it('uses cached result on subsequent calls', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)

      // First call regenerates
      const first = await registry.list()
      expect(first).toHaveLength(1)

      // Add another branch directly by writing file (bypassing invalidation)
      const branchDir = path.join(root, 'feature-b')
      const metaDir = path.join(branchDir, '.canopycms')
      await fs.mkdir(metaDir, { recursive: true })
      await fs.writeFile(
        path.join(metaDir, 'branch.json'),
        JSON.stringify({
          schemaVersion: 1,
          branch: {
            name: 'feature-b',
            status: 'editing',
            access: {},
            createdBy: 'user-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        })
      )

      // Second call should return cached result (still 1 branch)
      const second = await registry.list()
      expect(second).toHaveLength(1)
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

    it('renames cache file to stale file', async () => {
      const root = await tmpDir()
      await createBranchWithMetadata(root, 'feature-a')

      const registry = new BranchRegistry(root)
      await registry.list() // Create cache

      const cacheFile = path.join(root, '.canopycms', 'branches.json')
      const staleFile = path.join(root, '.canopycms', 'branches.stale.json')

      // Cache exists, stale doesn't
      expect(
        await fs
          .stat(cacheFile)
          .then(() => true)
          .catch(() => false)
      ).toBe(true)
      expect(
        await fs
          .stat(staleFile)
          .then(() => true)
          .catch(() => false)
      ).toBe(false)

      await registry.invalidate()

      // Now stale exists, cache doesn't
      expect(
        await fs
          .stat(cacheFile)
          .then(() => true)
          .catch(() => false)
      ).toBe(false)
      expect(
        await fs
          .stat(staleFile)
          .then(() => true)
          .catch(() => false)
      ).toBe(true)
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
