import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  BranchMetadataFileManager,
  BranchMetadataConflictError,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchmeta-'))

// This file exercises many save() calls; settleMs: 0 skips the (default 50ms)
// post-rename settle wait, which matters nothing for correctness here since
// everything runs single-host/single-process against a real tmp filesystem.
const createMeta = (branchRoot: string, baseRoot: string) =>
  getBranchMetadataFileManager(branchRoot, baseRoot, { settleMs: 0 })

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
      const meta = createMeta(root, registryDir)

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

    it('uses atomic temp-file + link when creating a new branch.json', async () => {
      // Verify the new-file path goes through temp-write + link() rather than writeFile({wx}).
      // writeFile({wx}) is not atomic: a crash mid-write leaves a partial file that
      // makes JSON.parse fail on next startup, permanently breaking the branch.
      // link() is atomic and EEXIST-safe: it either creates the target or fails cleanly.
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)

      const linkSpy = vi.spyOn(fs, 'link')

      await meta.save({
        branch: { name: 'atomicity-test', status: 'editing', createdBy: 'u1' },
      })

      expect(linkSpy).toHaveBeenCalled()

      // The final file should be valid JSON — no temp fragments left behind
      const metaPath = path.join(root, '.canopy-meta', 'branch.json')
      const raw = await fs.readFile(metaPath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.branch.name).toBe('atomicity-test')

      // No .tmp files should remain
      const metaDir = path.join(root, '.canopy-meta')
      const entries = await fs.readdir(metaDir)
      expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)

      linkSpy.mockRestore()
    })

    it('updates existing metadata and stamps updatedAt', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)

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
    it('update() invalidates registry cache and eagerly rewrites it', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      // Create metadata with registryDir
      const meta = createMeta(branchRoot, registryDir)

      // First update creates the metadata and invalidates cache. invalidate()
      // bumps the resource-generation marker and eager-regenerates, so
      // branches.json exists immediately. Note branchRoot here is NOT nested
      // under registryDir (unlike real usage), so the eager scan itself finds
      // no branch subdirectories - this test only exercises the bump +
      // eager-rewrite mechanism, not branch discovery (see branch-registry.test.ts
      // for that).
      await meta.save({
        branch: {
          name: 'feature/z',
          status: 'editing',
          createdBy: 'u1',
        },
      })

      const cacheFile = path.join(registryDir, 'branches.json')
      const firstSnapshot = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as {
        version: number
        branches: unknown[]
        generation: string | null
      }
      expect(firstSnapshot.branches).toHaveLength(0)
      const firstGeneration = firstSnapshot.generation
      expect(firstGeneration).not.toBeNull()

      // Second update should also invalidate and eager-regenerate, bumping
      // the embedded generation token again.
      await meta.save({
        branch: { status: 'submitted' },
      })

      const secondSnapshot = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as {
        version: number
        branches: unknown[]
        generation: string | null
      }
      expect(secondSnapshot.branches).toHaveLength(0)
      expect(secondSnapshot.generation).not.toBe(firstGeneration)

      // The legacy rename-based stale artifact is never produced.
      const staleFile = path.join(registryDir, 'branches.stale.json')
      const staleExists = await fs
        .stat(staleFile)
        .then(() => true)
        .catch(() => false)
      expect(staleExists).toBe(false)
    })

    it('getBranchMetadataFileManager factory creates metadata with registryDir', async () => {
      const branchRoot = await tmpDir()
      const registryDir = await tmpDir()

      const meta = createMeta(branchRoot, registryDir)

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
      const meta = createMeta(root, registryDir)

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
      const meta = createMeta(root, registryDir)

      await meta.save({
        branch: { name: 'feature/inc', status: 'editing', createdBy: 'u1' },
      })
      const v1 = await BranchMetadataFileManager.loadOnly(root)
      expect(v1?.version).toBe(1)

      await meta.save({ branch: { status: 'submitted' } })
      const v2 = await BranchMetadataFileManager.loadOnly(root)
      expect(v2?.version).toBe(2)
    })

    it('handles concurrent save() calls from two manager instances deterministically', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()

      // Create initial metadata
      const meta0 = createMeta(root, registryDir)
      await meta0.save({
        branch: { name: 'feature/race', status: 'editing', createdBy: 'u1' },
      })

      // Concurrently update from two separate instances. Serialized end-to-end
      // by the withLock -> withOccFileLock -> withOccRetry stack (see class doc
      // comment on BranchMetadataFileManager), so this is deterministic rather
      // than a race that happens to resolve without loss in this process.
      const meta1 = createMeta(root, registryDir)
      const meta2 = createMeta(root, registryDir)

      await Promise.all([
        meta1.save({ branch: { title: 'Title A' } }),
        meta2.save({ branch: { description: 'Desc B' } }),
      ])

      // Both should succeed (merged sequentially, no lost update) and produce valid JSON
      const final = await BranchMetadataFileManager.loadOnly(root)
      expect(final).not.toBeNull()
      expect(final?.branch.name).toBe('feature/race')
      // The second save sees the first save's result, so both updates are present
      expect(final?.branch.title).toBe('Title A')
      expect(final?.branch.description).toBe('Desc B')
      expect(final?.version).toBe(3) // initial=1, +2 concurrent saves
    })

    it('does not leak branch.json.lock artifacts after a save cycle', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)

      await meta.save({
        branch: { name: 'feature/lockfile', status: 'editing', createdBy: 'u1' },
      })
      await meta.save({ branch: { status: 'submitted' } })

      const metaDir = path.join(root, '.canopy-meta')
      const entries = await fs.readdir(metaDir)
      const lockArtifacts = entries.filter((name) => name.includes('.lock'))
      expect(lockArtifacts).toEqual([])
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
      const meta = createMeta(root, registryDir)
      const updated = await meta.save({ branch: { status: 'submitted' } })
      expect(updated.branch.status).toBe('submitted')

      const reloaded = await BranchMetadataFileManager.loadOnly(root)
      expect(reloaded?.version).toBe(1) // upgraded from missing (treated as 0) to 1
      expect(reloaded?.writeId).toBeDefined()
    })

    it('produces valid JSON after save', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)

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

  describe('phantom-save guard (item 4b)', () => {
    it('throws BranchMetadataConflictError when branchRoot has been removed before save()', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)

      // Simulate deleteBranchHandler having already removed the entire
      // branch directory (rm -rf) by the time this save() call -- whose
      // branchContext was resolved earlier, before the delete -- reaches
      // its own critical section.
      await fs.rm(root, { recursive: true, force: true })

      await expect(meta.save({ branch: { status: 'submitted' } })).rejects.toThrow(
        BranchMetadataConflictError,
      )
      await expect(meta.save({ branch: { status: 'submitted' } })).rejects.toThrow(
        'Branch no longer exists',
      )

      // The directory must not have been resurrected by the failed save.
      const exists = await fs
        .stat(root)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    })

    it('does not resurrect the directory tree as a side effect of the failed save', async () => {
      const root = await tmpDir()
      const registryDir = await tmpDir()
      const meta = createMeta(root, registryDir)
      await fs.rm(root, { recursive: true, force: true })

      await meta.save({ branch: { status: 'submitted' } }).catch(() => {})

      const metaDirExists = await fs
        .stat(path.join(root, '.canopy-meta'))
        .then(() => true)
        .catch(() => false)
      expect(metaDirExists).toBe(false)
    })

    it('creation flow still works: branch-workspace provisions the clone directory before save() runs', async () => {
      // ensureBranchRoot() (branch-workspace.ts) does fs.mkdir(branchRoot,
      // {recursive: true}) before ever calling metadata.save() -- mirror
      // that ordering directly against the manager to confirm the new
      // pre-check doesn't break brand-new branch creation.
      const root = path.join(await tmpDir(), 'not-yet-created-branch')
      const registryDir = await tmpDir()
      await fs.mkdir(root, { recursive: true })

      const meta = createMeta(root, registryDir)
      const created = await meta.save({
        branch: { name: 'feature/new', status: 'editing', createdBy: 'u1' },
      })
      expect(created.branch.name).toBe('feature/new')
    })
  })
})
