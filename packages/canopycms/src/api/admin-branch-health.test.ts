import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ADMIN_ROUTES } from './admin'
import type { ApiContext, ApiRequest } from './types'
import type { CanopyConfig } from '../config'
import { createMockApiContext, createMockUser, initTestRepo } from '../test-utils'
import { BranchRegistry } from '../branch-registry'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { acquireProvisioningLock } from '../utils/provisioning-lock'

// Extract composed (guard + handler) functions for testing, matching admin.test.ts's pattern.
const branchHealthHandler = ADMIN_ROUTES.branchHealth.handler
const purgeHandler = ADMIN_ROUTES.purgeBranchDir.handler
const repairHandler = ADMIN_ROUTES.repairBranchDir.handler

describe('admin branch-health api', () => {
  let tmpDir: string
  let branchesRoot: string
  const originalWorkspaceRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
  let ctx: ApiContext
  let req: ApiRequest
  let registry: BranchRegistry

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-admin-branch-health-test-'))
    // getDefaultBranchBase({mode:'prod'}) resolves to {CANOPYCMS_WORKSPACE_ROOT}/content-branches
    // -- the same derivation services.ts uses to construct the real BranchRegistry.
    process.env.CANOPYCMS_WORKSPACE_ROOT = tmpDir
    branchesRoot = path.join(tmpDir, 'content-branches')
    await fs.mkdir(branchesRoot, { recursive: true })

    registry = new BranchRegistry(branchesRoot)
    ctx = createMockApiContext({
      services: {
        config: { mode: 'prod', defaultBaseBranch: 'main' } as CanopyConfig,
        registry,
      },
    })
    req = { user: createMockUser('admin'), body: {} }
  })

  afterEach(async () => {
    process.env.CANOPYCMS_WORKSPACE_ROOT = originalWorkspaceRoot
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const createHealthyBranch = async (dirName: string) => {
    const branchDir = path.join(branchesRoot, dirName)
    await fs.mkdir(branchDir, { recursive: true })
    const manager = getBranchMetadataFileManager(branchDir, branchesRoot, { settleMs: 0 })
    await manager.save({ branch: { name: dirName, status: 'editing', createdBy: 'user-1' } })
  }

  const createCorruptBranch = async (dirName: string) => {
    const metaDir = path.join(branchesRoot, dirName, '.canopy-meta')
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(metaDir, 'branch.json'), 'not json {{{', 'utf-8')
  }

  const createOrphanBranch = async (dirName: string) => {
    await fs.mkdir(path.join(branchesRoot, dirName), { recursive: true })
  }

  /**
   * A branch directory with a REAL git clone checked out on `branchName`
   * (which may differ from `dirName`, e.g. a slash-named branch living in a
   * sanitized dir) plus corrupt metadata -- for MEDIUM-3's
   * resolveRepairedBranchName coverage.
   */
  const createCorruptBranchWithGit = async (dirName: string, branchName: string) => {
    const branchDir = path.join(branchesRoot, dirName)
    await fs.mkdir(branchDir, { recursive: true })
    const git = await initTestRepo(branchDir)
    await git.checkoutLocalBranch(branchName)
    await fs.writeFile(path.join(branchDir, '.gitkeep'), '')
    await git.add(['.'])
    await git.commit('initial commit')

    const metaDir = path.join(branchDir, '.canopy-meta')
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(metaDir, 'branch.json'), 'not json {{{', 'utf-8')
  }

  const ageDir = async (dirPath: string, ageMs: number) => {
    const old = new Date(Date.now() - ageMs)
    await fs.utimes(dirPath, old, old)
  }

  const initLockPath = (dirName: string) => path.join(branchesRoot, `.${dirName}.init.lock`)

  describe('GET /admin/branch-health', () => {
    it('returns healthy/corrupt/orphan entries', async () => {
      await createHealthyBranch('main')
      await createCorruptBranch('broken')
      await createOrphanBranch('orphan-dir')

      const result = await branchHealthHandler(ctx, req)

      expect(result.ok).toBe(true)
      expect(result.data?.entries).toHaveLength(3)
      expect(result.data?.generatedAt).toBeTruthy()
      const kinds = result.data?.entries.map((e) => e.kind).sort()
      expect(kinds).toEqual(['corrupt-metadata', 'healthy', 'orphan'])
    })

    it('never leaks the absolute workspace path in the response', async () => {
      // [MEDIUM-2] A healthy-only fixture never exercises the parseError
      // path this test exists to guard, making the original version
      // vacuous. Add a corrupt-JSON dir AND an EISDIR-style dir (branch.json
      // is itself a directory) -- both previously surfaced their raw error
      // message, which embeds the absolute path.
      await createHealthyBranch('main')
      await createCorruptBranch('broken')
      const eisdirMetaDir = path.join(branchesRoot, 'weird-branch', '.canopy-meta')
      await fs.mkdir(path.join(eisdirMetaDir, 'branch.json'), { recursive: true })

      const result = await branchHealthHandler(ctx, req)

      expect(result.data?.entries).toHaveLength(3)
      const broken = result.data?.entries.find((e) => e.dirName === 'broken')
      const weird = result.data?.entries.find((e) => e.dirName === 'weird-branch')
      expect(broken?.parseError).toBeTruthy()
      expect(weird?.parseError).toBeTruthy()
      expect(JSON.stringify(result)).not.toContain(tmpDir)
    })
  })

  describe('POST /admin/branch-dirs/:dirName/purge', () => {
    it('purges a corrupt-metadata directory, invalidating the registry', async () => {
      await createCorruptBranch('broken')
      const invalidateSpy = vi.spyOn(registry, 'invalidate')

      const result = await purgeHandler(ctx, req, { dirName: 'broken' })

      expect(result.ok).toBe(true)
      expect(result.data?.trashedAs).toMatch(/^\.trash-broken-\d{8}T\d{6}Z$/)
      await expect(fs.stat(path.join(branchesRoot, 'broken'))).rejects.toThrow()
      await expect(fs.stat(path.join(branchesRoot, result.data!.trashedAs))).resolves.toBeTruthy()
      expect(invalidateSpy).toHaveBeenCalled()

      // Scan no longer lists the purged dir under its old name.
      const scan = await branchHealthHandler(ctx, req)
      expect(scan.data?.entries.find((e) => e.dirName === 'broken')).toBeUndefined()
    })

    it('purges an old orphan directory', async () => {
      await createOrphanBranch('old-orphan')
      await ageDir(path.join(branchesRoot, 'old-orphan'), 20 * 60_000)

      const result = await purgeHandler(ctx, req, { dirName: 'old-orphan' })
      expect(result.ok).toBe(true)
      expect(result.data?.trashedAs).toMatch(/^\.trash-old-orphan-\d{8}T\d{6}Z$/)
    })

    it('returns 409 for a live branch', async () => {
      await createHealthyBranch('live-branch')
      const result = await purgeHandler(ctx, req, { dirName: 'live-branch' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('returns 400 for the base branch', async () => {
      await createHealthyBranch('main')
      const result = await purgeHandler(ctx, req, { dirName: 'main' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })

    it('returns 409 when the init lock is fresh (H1)', async () => {
      await createOrphanBranch('mid-clone')
      await ageDir(path.join(branchesRoot, 'mid-clone'), 20 * 60_000)
      await fs.mkdir(initLockPath('mid-clone'), { recursive: true })

      const result = await purgeHandler(ctx, req, { dirName: 'mid-clone' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('succeeds when the init lock is stale (H1 regression)', async () => {
      await createOrphanBranch('stale-lock-orphan')
      await ageDir(path.join(branchesRoot, 'stale-lock-orphan'), 20 * 60_000)
      await fs.mkdir(initLockPath('stale-lock-orphan'), { recursive: true })
      await ageDir(initLockPath('stale-lock-orphan'), 10 * 60_000)

      const result = await purgeHandler(ctx, req, { dirName: 'stale-lock-orphan' })
      expect(result.ok).toBe(true)
    })

    it('returns 409 for a young orphan directory', async () => {
      await createOrphanBranch('young-orphan')
      const result = await purgeHandler(ctx, req, { dirName: 'young-orphan' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('purges a fresh corrupt-metadata dir (exempt from the youth rail)', async () => {
      await createCorruptBranch('fresh-corrupt')
      // No aging -- dir mtime is "now", which would fail the youth rail if
      // applied, but corrupt-metadata dirs are exempt from it.
      const result = await purgeHandler(ctx, req, { dirName: 'fresh-corrupt' })
      expect(result.ok).toBe(true)
    })

    it('rejects a traversal dirName at the validation layer', () => {
      const validationResult = ADMIN_ROUTES.purgeBranchDir.validate({
        params: { dirName: '../../etc' },
      })
      expect(validationResult.ok).toBe(false)
    })

    it('rejects a dot-prefixed dirName at the validation layer', () => {
      const validationResult = ADMIN_ROUTES.purgeBranchDir.validate({
        params: { dirName: '.trash-something-20240101T000000Z' },
      })
      expect(validationResult.ok).toBe(false)
    })

    it('returns 409 on provisioning lock contention against a real held lock', async () => {
      await createOrphanBranch('contended')
      await ageDir(path.join(branchesRoot, 'contended'), 20 * 60_000)

      const release = await acquireProvisioningLock(branchesRoot, '.contended.init.lock')
      try {
        const result = await purgeHandler(ctx, req, { dirName: 'contended' })
        expect(result.ok).toBe(false)
        expect(result.status).toBe(409)
      } finally {
        await release()
      }
    })

    it('returns 404 for a nonexistent directory and creates no trash entry (MEDIUM-1 rider)', async () => {
      const result = await purgeHandler(ctx, req, { dirName: 'never-existed' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)

      const entries = await fs.readdir(branchesRoot)
      expect(entries.some((e) => e.startsWith('.trash-'))).toBe(false)
    })
  })

  describe('POST /admin/branch-dirs/:dirName/repair-metadata', () => {
    it('repairs a corrupt branch.json, archiving the original and recreating defaults', async () => {
      await createCorruptBranch('repair-me')

      const result = await repairHandler(ctx, req, { dirName: 'repair-me' })

      expect(result.ok).toBe(true)
      expect(result.data?.archivedAs).toMatch(/^branch\.json\.corrupt-\d{8}T\d{6}Z$/)
      expect(result.data?.branch.status).toBe('editing')
      expect(result.data?.branch.createdBy).toBe(req.user.userId)
      // (MEDIUM-3) No .git dir in this fixture -- falls back to dirName.
      expect(result.data?.branch.name).toBe('repair-me')

      const archivedPath = path.join(
        branchesRoot,
        'repair-me',
        '.canopy-meta',
        result.data!.archivedAs,
      )
      const archivedContent = await fs.readFile(archivedPath, 'utf-8')
      expect(archivedContent).toBe('not json {{{')

      const newContent = await fs.readFile(
        path.join(branchesRoot, 'repair-me', '.canopy-meta', 'branch.json'),
        'utf-8',
      )
      expect(() => JSON.parse(newContent)).not.toThrow()
    })

    it('allows repairing the base branch (H3 regression)', async () => {
      await createCorruptBranch('main')
      const result = await repairHandler(ctx, req, { dirName: 'main' })
      expect(result.ok).toBe(true)
      expect(result.data?.branch.name).toBe('main')
    })

    it('returns 409 when metadata is already healthy', async () => {
      await createHealthyBranch('healthy-branch')
      const result = await repairHandler(ctx, req, { dirName: 'healthy-branch' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('returns 409 when there is no metadata file at all', async () => {
      await createOrphanBranch('no-meta')
      const result = await repairHandler(ctx, req, { dirName: 'no-meta' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('rejects a traversal dirName at the validation layer', () => {
      const validationResult = ADMIN_ROUTES.repairBranchDir.validate({
        params: { dirName: '..' },
      })
      expect(validationResult.ok).toBe(false)
    })

    it("uses the clone's actual checked-out branch name, not the sanitized dir name (MEDIUM-3)", async () => {
      // 'feature/foo' sanitizes to the dir name 'feature-foo' (paths/branch.ts).
      await createCorruptBranchWithGit('feature-foo', 'feature/foo')

      const result = await repairHandler(ctx, req, { dirName: 'feature-foo' })

      expect(result.ok).toBe(true)
      expect(result.data?.branch.name).toBe('feature/foo')
    })

    it('returns 404 for a nonexistent directory (MEDIUM-1 rider)', async () => {
      const result = await repairHandler(ctx, req, { dirName: 'never-existed' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('returns 409 on provisioning lock contention against a real held lock (MEDIUM-1)', async () => {
      await createCorruptBranch('repair-contended')

      const release = await acquireProvisioningLock(branchesRoot, '.repair-contended.init.lock')
      try {
        const result = await repairHandler(ctx, req, { dirName: 'repair-contended' })
        expect(result.ok).toBe(false)
        expect(result.status).toBe(409)
        expect(result.error).toMatch(/Provisioning lock contention/)
      } finally {
        await release()
      }

      // The lock contention must have blocked BEFORE any mutation -- the
      // corrupt file is untouched, not archived.
      const stillCorrupt = await fs.readFile(
        path.join(branchesRoot, 'repair-contended', '.canopy-meta', 'branch.json'),
        'utf-8',
      )
      expect(stillCorrupt).toBe('not json {{{')
    })
  })

  // Guard coverage (every ADMIN_ROUTES entry, including these three, 403s
  // for a non-admin user) is asserted generically in admin.test.ts's
  // "guard coverage" describe block, which loops Object.values(ADMIN_ROUTES).
})
