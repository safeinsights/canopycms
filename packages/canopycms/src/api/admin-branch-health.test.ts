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
import { mockConsole } from '../test-utils/console-spy'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { generateId } from '../id'

// Extract composed (guard + handler) functions for testing, matching admin.test.ts's pattern.
const branchHealthHandler = ADMIN_ROUTES.branchHealth.handler
const purgeHandler = ADMIN_ROUTES.purgeBranchDir.handler
const repairHandler = ADMIN_ROUTES.repairBranchDir.handler
const repairContentDuplicatesHandler = ADMIN_ROUTES.repairContentDuplicates.handler

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

    it('reports the reset status/access/createdBy so the admin knows they were not recovered (August 2026 baseline review)', async () => {
      // A submitted (write-locked) branch with real ACLs, created by someone
      // other than the repairing admin -- exactly the state save()'s
      // defaults-merge silently drops once branch.json is archived away.
      const branchDir = path.join(branchesRoot, 'was-submitted')
      await fs.mkdir(branchDir, { recursive: true })
      const manager = getBranchMetadataFileManager(branchDir, branchesRoot, { settleMs: 0 })
      await manager.save({
        branch: {
          name: 'was-submitted',
          status: 'submitted',
          createdBy: 'original-author',
          access: { allowedUsers: ['alice'] },
        },
      })
      // Corrupt it in place, as an external crash/tampering would.
      await fs.writeFile(
        path.join(branchDir, '.canopy-meta', 'branch.json'),
        'not json {{{',
        'utf-8',
      )

      const result = await repairHandler(ctx, req, { dirName: 'was-submitted' })

      expect(result.ok).toBe(true)
      // The bug: the real prior status/ACLs/creator do not survive repair --
      // status comes back unlocked, ACLs are dropped, and the repairing
      // admin becomes the recorded creator.
      expect(result.data?.branch.status).toBe('editing')
      expect(result.data?.branch.access).toEqual({})
      expect(result.data?.branch.createdBy).toBe(req.user.userId)
      // The fix: the response says so explicitly instead of a silent 200 --
      // an admin reading this knows to re-apply the ACL and re-submit.
      expect(result.data?.reset).toEqual({
        status: 'editing',
        access: {},
        createdBy: req.user.userId,
      })
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

  describe('POST /admin/branch-dirs/:dirName/repair-content-duplicates', () => {
    /**
     * Two filenames sharing one embedded content ID, matching
     * renameEntry()'s documented (previously unhandled) crash window:
     * fs.link() succeeded, the crash landed before fs.unlink() removed the
     * old name.
     */
    const createDuplicateContentIds = async (dirName: string, contentRootName = 'content') => {
      await createHealthyBranch(dirName)
      const postsDir = path.join(branchesRoot, dirName, contentRootName, 'posts')
      await fs.mkdir(postsDir, { recursive: true })
      const dupId = generateId()
      await fs.writeFile(path.join(postsDir, `post.old-slug.${dupId}.json`), '{}', 'utf-8')
      await fs.writeFile(path.join(postsDir, `post.new-slug.${dupId}.json`), '{}', 'utf-8')
      return { postsDir, dupId }
    }

    it('archives the quarantined (losing) duplicate, keeping the winner untouched', async () => {
      const { postsDir, dupId } = await createDuplicateContentIds('dup-branch')

      // The repair rebuilds the index, which warns on quarantine -- deliberate,
      // since an operator has to learn the duplicate exists. Swallow and assert
      // it rather than let it leak: vitest.config.ts's onConsoleLog fails the
      // run on unswallowed console output, but ONLY when process.env.CI is set,
      // so a green local run does not prove this. Reproduce with CI=1.
      const consoleSpy = mockConsole()
      let result: Awaited<ReturnType<typeof repairContentDuplicatesHandler>>
      try {
        result = await repairContentDuplicatesHandler(ctx, req, { dirName: 'dup-branch' })
        expect(consoleSpy).toHaveWarned(dupId)
      } finally {
        consoleSpy.restore()
      }

      expect(result.ok).toBe(true)
      expect(result.data?.resolved).toHaveLength(1)
      const [resolved] = result.data!.resolved
      expect(resolved.id).toBe(dupId)
      expect(resolved.keptPath).toBe(`content/posts/post.new-slug.${dupId}.json`)
      expect(resolved.archivedAs).toHaveLength(1)
      // Repo-relative, not a bare basename: with duplicates in several
      // collections the operator otherwise cannot tell which file went where.
      expect(resolved.archivedAs[0]).toMatch(
        /^content\/posts\/\.duplicate-content-id\.\d{8}T\d{6}Z\./,
      )

      // The winner is untouched, still at its original name.
      await expect(
        fs.stat(path.join(postsDir, `post.new-slug.${dupId}.json`)),
      ).resolves.toBeTruthy()
      // The loser was renamed (archived), never deleted -- nothing evaporates.
      await expect(fs.stat(path.join(postsDir, `post.old-slug.${dupId}.json`))).rejects.toThrow()
      // Resolved against the BRANCH ROOT, not the collection dir: the reported
      // path is repo-relative, so it is directly usable to find the archived
      // file (which is the whole point of reporting more than a basename).
      await expect(
        fs.stat(path.join(branchesRoot, 'dup-branch', resolved.archivedAs[0])),
      ).resolves.toBeTruthy()

      // A rescan no longer reports the duplicate -- the dot-prefixed archive
      // name is skipped by every future ContentIdIndex scan.
      // The rescan must be SILENT as well as clean: a dot-prefixed archive that
      // still warned would mean the operator keeps being told about a duplicate
      // they already resolved.
      const rescanSpy = mockConsole()
      let scan: Awaited<ReturnType<typeof branchHealthHandler>>
      try {
        scan = await branchHealthHandler(ctx, req)
      } finally {
        rescanSpy.restore()
      }
      const entry = scan.data?.entries.find((e) => e.dirName === 'dup-branch')
      expect(entry?.duplicateContentIds).toBeUndefined()
    })

    it('returns 409 when there are no duplicate content IDs to repair', async () => {
      await createHealthyBranch('clean-branch')
      const result = await repairContentDuplicatesHandler(ctx, req, { dirName: 'clean-branch' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('returns 404 for a nonexistent directory', async () => {
      const result = await repairContentDuplicatesHandler(ctx, req, { dirName: 'never-existed' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('respects a non-default contentRootName', async () => {
      const { dupId } = await createDuplicateContentIds('custom-root-branch', 'my-content')
      ctx = createMockApiContext({
        services: {
          config: {
            mode: 'prod',
            defaultBaseBranch: 'main',
            contentRoot: 'my-content',
          } as CanopyConfig,
          registry,
        },
      })

      // The repair rebuilds the index, which warns on quarantine -- deliberate,
      // since an operator has to learn the duplicate exists. Swallow and assert
      // it rather than let it leak: vitest.config.ts's onConsoleLog fails the
      // run on unswallowed console output, but ONLY when process.env.CI is set,
      // so a green local run does not prove this. Reproduce with CI=1.
      const consoleSpy = mockConsole()
      let result: Awaited<ReturnType<typeof repairContentDuplicatesHandler>>
      try {
        result = await repairContentDuplicatesHandler(ctx, req, {
          dirName: 'custom-root-branch',
        })
        expect(consoleSpy).toHaveWarned(dupId)
      } finally {
        consoleSpy.restore()
      }
      expect(result.ok).toBe(true)
      expect(result.data?.resolved[0].id).toBe(dupId)
    })

    it('returns 409 on content-write-lock contention against a real held lock', async () => {
      await createDuplicateContentIds('contended-branch')
      const release = await tryAcquireContentWriteLock(path.join(branchesRoot, 'contended-branch'))
      try {
        const result = await repairContentDuplicatesHandler(ctx, req, {
          dirName: 'contended-branch',
        })
        expect(result.ok).toBe(false)
        expect(result.status).toBe(409)
      } finally {
        await release()
      }
    })

    it('rejects a traversal dirName at the validation layer', () => {
      const validationResult = ADMIN_ROUTES.repairContentDuplicates.validate({
        params: { dirName: '../../etc' },
      })
      expect(validationResult.ok).toBe(false)
    })
  })

  // Guard coverage (every ADMIN_ROUTES entry, including these four, 403s
  // for a non-admin user) is asserted generically in admin.test.ts's
  // "guard coverage" describe block, which loops Object.values(ADMIN_ROUTES).
})
