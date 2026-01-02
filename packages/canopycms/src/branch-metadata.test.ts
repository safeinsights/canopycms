import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchMetadata, createBranchMetadata } from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchmeta-'))

describe('BranchMetadata', () => {
  it('saves and loads metadata', async () => {
    const root = await tmpDir()
    const meta = new BranchMetadata(root)
    const now = new Date().toISOString()

    await meta.save({
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

    const loaded = await meta.load()
    expect(loaded?.branch.name).toBe('feature/x')
    expect(loaded?.branch.access.allowedGroups).toContain('g1')
  })

  it('updates existing metadata and stamps updatedAt', async () => {
    const root = await tmpDir()
    const meta = new BranchMetadata(root)
    const now = new Date().toISOString()
    await meta.save({
      schemaVersion: 1,
      branch: {
        name: 'feature/y',
        status: 'editing',
        access: {},
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    })

    const updated = await meta.update({
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
    expect(new Date(updated.branch.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(now).getTime(),
    )
  })

  describe('registry invalidation', () => {
    it('update() invalidates registry cache when registryDir provided', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      // Create initial cache file
      const cacheFile = path.join(registryDir, '.canopycms', 'branches.json')
      await fs.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ version: 1, branches: [] }))

      // Create metadata with registryDir
      const meta = createBranchMetadata(branchRoot, registryDir)
      const now = new Date().toISOString()
      await meta.save({
        schemaVersion: 1,
        branch: {
          name: 'feature/z',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: now,
          updatedAt: now,
        },
      })

      // Update should invalidate registry
      await meta.update({
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

    it('update() works without registryDir (backward compat)', async () => {
      const root = await tmpDir()
      const meta = new BranchMetadata(root) // No registryDir
      const now = new Date().toISOString()

      await meta.save({
        schemaVersion: 1,
        branch: {
          name: 'feature/compat',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: now,
          updatedAt: now,
        },
      })

      // Should not throw even without registryDir
      const updated = await meta.update({
        branch: { status: 'submitted' },
      })

      expect(updated.branch.status).toBe('submitted')
    })

    it('createBranchMetadata factory creates metadata with registryDir', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      const meta = createBranchMetadata(branchRoot, registryDir)

      // Should be able to save
      const now = new Date().toISOString()
      await meta.save({
        schemaVersion: 1,
        branch: {
          name: 'feature/factory',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: now,
          updatedAt: now,
        },
      })

      const loaded = await meta.load()
      expect(loaded?.branch.name).toBe('feature/factory')
    })

    it('createBranchMetadata factory works without registryDir', async () => {
      const branchRoot = await tmpDir()

      const meta = createBranchMetadata(branchRoot)

      const now = new Date().toISOString()
      await meta.save({
        schemaVersion: 1,
        branch: {
          name: 'feature/no-registry',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: now,
          updatedAt: now,
        },
      })

      const loaded = await meta.load()
      expect(loaded?.branch.name).toBe('feature/no-registry')
    })
  })
})
