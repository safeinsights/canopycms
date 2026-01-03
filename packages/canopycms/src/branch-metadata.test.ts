import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchMetadata, getBranchMetadata } from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchmeta-'))

describe('BranchMetadata', () => {
  describe('loadOnly', () => {
    it('loads metadata from disk', async () => {
      const root = await tmpDir()
      const now = new Date().toISOString()

      // Manually write file to test loadOnly
      const metaDir = path.join(root, '.canopycms')
      await fs.mkdir(metaDir, { recursive: true })
      await fs.writeFile(
        path.join(metaDir, 'branch.json'),
        JSON.stringify({
          schemaVersion: 1,
          branch: {
            name: 'feature/x',
            status: 'editing',
            access: { allowedUsers: ['u1'], allowedGroups: ['g1'] },
            createdBy: 'u1',
            createdAt: now,
            updatedAt: now,
          },
        })
      )

      const loaded = await BranchMetadata.loadOnly(root)
      expect(loaded?.branch.name).toBe('feature/x')
      expect(loaded?.branch.access.allowedGroups).toContain('g1')
    })

    it('returns null for missing metadata', async () => {
      const root = await tmpDir()
      const loaded = await BranchMetadata.loadOnly(root)
      expect(loaded).toBeNull()
    })
  })

  describe('update', () => {
    it('creates metadata when none exists', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadata(root, registryDir)

      const created = await meta.save({
        branch: {
          name: 'feature/x',
          status: 'editing',
          access: { allowedUsers: ['u1'], allowedGroups: ['g1'] },
          createdBy: 'u1',
        },
      })

      expect(created.branch.name).toBe('feature/x')
      expect(created.branch.access.allowedGroups).toContain('g1')

      const loaded = await BranchMetadata.loadOnly(root)
      expect(loaded?.branch.name).toBe('feature/x')
    })

    it('updates existing metadata and stamps updatedAt', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadata(root, registryDir)

      // First create
      const created = await meta.save({
        branch: {
          name: 'feature/y',
          status: 'editing',
          createdBy: 'u1',
        },
      })

      // Then update
      const updated = await meta.save({
        branch: {
          name: 'feature/y',
          status: 'submitted',
          access: { managerOrAdminAllowed: true },
        },
        pullRequestNumber: 10,
        pullRequestUrl: 'https://example.com/pr/10',
      })

      expect(updated.branch.status).toBe('submitted')
      expect(updated.pullRequestNumber).toBe(10)
      expect(updated.branch.access.managerOrAdminAllowed).toBe(true)
      expect(updated.branch.createdAt).toBe(created.branch.createdAt) // createdAt unchanged
      expect(new Date(updated.branch.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.branch.createdAt).getTime()
      )
    })
  })

  describe('registry invalidation', () => {
    it('update() invalidates registry cache', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      // Create initial cache file
      const cacheFile = path.join(registryDir, '.canopycms', 'branches.json')
      await fs.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ version: 1, branches: [] }))

      // Create metadata with registryDir
      const meta = getBranchMetadata(branchRoot, registryDir)

      // First update creates the metadata and invalidates cache
      await meta.save({
        branch: {
          name: 'feature/z',
          status: 'editing',
          createdBy: 'u1',
        },
      })

      // Recreate cache file to test invalidation on second update
      await fs.writeFile(cacheFile, JSON.stringify({ version: 1, branches: [] }))

      // Second update should also invalidate registry
      await meta.save({
        branch: { status: 'submitted' },
      })

      // Cache should be gone, stale file should exist
      const cacheExists = await fs
        .stat(cacheFile)
        .then(() => true)
        .catch(() => false)
      const staleFile = path.join(registryDir, '.canopycms', 'branches.stale.json')
      const staleExists = await fs
        .stat(staleFile)
        .then(() => true)
        .catch(() => false)

      expect(cacheExists).toBe(false)
      expect(staleExists).toBe(true)
    })

    it('getBranchMetadata factory creates metadata with registryDir', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      const meta = getBranchMetadata(branchRoot, registryDir)

      // Create metadata via update
      await meta.save({
        branch: {
          name: 'feature/factory',
          status: 'editing',
          createdBy: 'u1',
        },
      })

      const loaded = await BranchMetadata.loadOnly(branchRoot)
      expect(loaded?.branch.name).toBe('feature/factory')
    })
  })
})
