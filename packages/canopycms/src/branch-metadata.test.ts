import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BranchMetadataFileManager,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchmeta-'))

describe('BranchMetadataFileManager', () => {
  describe('loadOnly', () => {
    it('loads metadata from disk', async () => {
      const root = await tmpDir()
      const now = new Date().toISOString()

      // Manually write file to test loadOnly
      const metaDir = path.join(root, '.canopy-meta')
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
        }),
      )

      const loaded = await BranchMetadataFileManager.loadOnly(root)
      expect(loaded?.branch.name).toBe('feature/x')
      expect(loaded?.branch.access.allowedGroups).toContain('g1')
    })

    it('returns null for missing metadata', async () => {
      const root = await tmpDir()
      const loaded = await BranchMetadataFileManager.loadOnly(root)
      expect(loaded).toBeNull()
    })
  })

  describe('update', () => {
    it('creates metadata when none exists', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadataFileManager(root, registryDir)

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

      const loaded = await BranchMetadataFileManager.loadOnly(root)
      expect(loaded?.branch.name).toBe('feature/x')
    })

    it('updates existing metadata and stamps updatedAt', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadataFileManager(root, registryDir)

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
          pullRequestNumber: 10,
          pullRequestUrl: 'https://example.com/pr/10',
        },
      })

      expect(updated.branch.status).toBe('submitted')
      expect(updated.branch.pullRequestNumber).toBe(10)
      expect(updated.branch.access.managerOrAdminAllowed).toBe(true)
      expect(updated.branch.createdAt).toBe(created.branch.createdAt) // createdAt unchanged
      expect(new Date(updated.branch.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.branch.createdAt).getTime(),
      )
    })
  })

  describe('registry invalidation', () => {
    it('update() invalidates registry cache', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      // Create initial cache file
      const cacheFile = path.join(registryDir, 'branches.json')
      await fs.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ version: 1, branches: [] }))

      // Create metadata with registryDir
      const meta = getBranchMetadataFileManager(branchRoot, registryDir)

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
      const staleFile = path.join(registryDir, 'branches.stale.json')
      const staleExists = await fs
        .stat(staleFile)
        .then(() => true)
        .catch(() => false)

      expect(cacheExists).toBe(false)
      expect(staleExists).toBe(true)
    })

    it('getBranchMetadataFileManager factory creates metadata with registryDir', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      const meta = getBranchMetadataFileManager(branchRoot, registryDir)

      // Create metadata via update
      await meta.save({
        branch: {
          name: 'feature/factory',
          status: 'editing',
          createdBy: 'u1',
        },
      })

      const loaded = await BranchMetadataFileManager.loadOnly(branchRoot)
      expect(loaded?.branch.name).toBe('feature/factory')
    })
  })

  describe('atomic writes and concurrency', () => {
    it('writes version and writeId fields', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadataFileManager(root, registryDir)

      await meta.save({
        branch: { name: 'feature/versioned', status: 'editing', createdBy: 'u1' },
      })

      const loaded = await BranchMetadataFileManager.loadOnly(root)
      expect(loaded?.version).toBe(1)
      expect(loaded?.writeId).toBeDefined()
    })

    it('increments version on each save', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadataFileManager(root, registryDir)

      await meta.save({
        branch: { name: 'feature/inc', status: 'editing', createdBy: 'u1' },
      })
      const v1 = await BranchMetadataFileManager.loadOnly(root)
      expect(v1?.version).toBe(1)

      await meta.save({ branch: { status: 'submitted' } })
      const v2 = await BranchMetadataFileManager.loadOnly(root)
      expect(v2?.version).toBe(2)
    })

    it('handles concurrent save() calls to the same file via in-memory lock', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()

      // Create initial metadata
      const meta0 = getBranchMetadataFileManager(root, registryDir)
      await meta0.save({
        branch: { name: 'feature/race', status: 'editing', createdBy: 'u1' },
      })

      // Concurrently update from two separate instances
      const meta1 = getBranchMetadataFileManager(root, registryDir)
      const meta2 = getBranchMetadataFileManager(root, registryDir)

      await Promise.all([
        meta1.save({ branch: { title: 'Title A' } }),
        meta2.save({ branch: { description: 'Desc B' } }),
      ])

      // Both should succeed (serialized by in-memory lock) and produce valid JSON
      const final = await BranchMetadataFileManager.loadOnly(root)
      expect(final).not.toBeNull()
      expect(final?.branch.name).toBe('feature/race')
      // The second save sees the first save's result, so both updates are present
      expect(final?.branch.title).toBe('Title A')
      expect(final?.branch.description).toBe('Desc B')
      expect(final?.version).toBe(3) // initial=1, +2 concurrent saves
    })

    it('reads legacy files without version/writeId gracefully', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const now = new Date().toISOString()

      // Write a legacy-format file (no version/writeId)
      const metaDir = path.join(root, '.canopy-meta')
      await fs.mkdir(metaDir, { recursive: true })
      const legacyContent: Omit<BranchMetadataFile, 'version'> = {
        schemaVersion: 1,
        branch: {
          name: 'feature/legacy',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: now,
          updatedAt: now,
        },
      }
      await fs.writeFile(path.join(metaDir, 'branch.json'), JSON.stringify(legacyContent, null, 2))

      // loadOnly should read it fine
      const loaded = await BranchMetadataFileManager.loadOnly(root)
      expect(loaded?.branch.name).toBe('feature/legacy')

      // save() should upgrade it with version/writeId
      const meta = getBranchMetadataFileManager(root, registryDir)
      const updated = await meta.save({ branch: { status: 'submitted' } })
      expect(updated.branch.status).toBe('submitted')

      const reloaded = await BranchMetadataFileManager.loadOnly(root)
      expect(reloaded?.version).toBe(1) // upgraded from missing (treated as 0) to 1
      expect(reloaded?.writeId).toBeDefined()
    })

    it('produces valid JSON after save', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = getBranchMetadataFileManager(root, registryDir)

      await meta.save({
        branch: { name: 'feature/valid-json', status: 'editing', createdBy: 'u1' },
      })

      // Read raw file and verify it parses cleanly
      const filePath = path.join(root, '.canopy-meta', 'branch.json')
      const raw = await fs.readFile(filePath, 'utf8')
      expect(() => JSON.parse(raw)).not.toThrow()
      expect(raw.endsWith('\n')).toBe(true)
    })
  })
})
