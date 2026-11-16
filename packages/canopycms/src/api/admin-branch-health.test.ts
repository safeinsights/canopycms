import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ADMIN_ROUTES } from './admin'
import { DUPLICATE_ID_SCAN_BUDGET_MS } from './admin-branch-health'
import { ContentIdIndex } from '../content-id-index'
import type { ApiContext, ApiRequest } from './types'
import type { CanopyConfig } from '../config'
import { createMockApiContext, createMockUser, initTestRepo } from '../test-utils'
import { createCheckBranchAccess } from '../authorization'
import type { CanopyUser } from '../user'
import { BranchRegistry } from '../branch-registry'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { acquireProvisioningLock } from '../utils/provisioning-lock'
import { mockConsole } from '../test-utils/console-spy'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { generateId } from '../id'

// Extract composed (guard + handler) functions for testing, matching admin.test.ts's pattern.
const branchHealthHandler = ADMIN_ROUTES.branchHealth.handler
const purgeHandler = ADMIN_ROUTES.purgeBranchDir.handler
const repairHandler = ADMIN_ROUTES.repairBranchDir.handler
const dismissHandler = ADMIN_ROUTES.dismissUnpublished.handler
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

  /** A git clone in `branchDir` with `branchName` checked out, the name repair records. */
  const cloneOn = async (branchDir: string, branchName: string) => {
    await fs.mkdir(branchDir, { recursive: true })
    const git = await initTestRepo(branchDir)
    await git.checkoutLocalBranch(branchName)
    await fs.writeFile(path.join(branchDir, '.gitkeep'), '')
    await git.add(['.'])
    await git.commit('initial commit')
    return git
  }

  /**
   * A branch directory with a real git clone checked out on `branchName` (which may differ from
   * `dirName`, e.g. a slash-named branch living in a sanitized dir) plus corrupt metadata.
   */
  const createCorruptBranchWithGit = async (dirName: string, branchName = dirName) => {
    const git = await cloneOn(path.join(branchesRoot, dirName), branchName)
    await createCorruptBranch(dirName)
    return git
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

      const result = await branchHealthHandler(ctx, req, {})

      expect(result.ok).toBe(true)
      expect(result.data?.entries).toHaveLength(3)
      expect(result.data?.generatedAt).toBeTruthy()
      const kinds = result.data?.entries.map((e) => e.kind).sort()
      expect(kinds).toEqual(['corrupt-metadata', 'healthy', 'orphan'])
    })

    it('never leaks the absolute workspace path in the response', async () => {
      // [REDACT] A healthy-only fixture never exercises the parseError
      // path this test exists to guard, making the original version
      // vacuous. Add a corrupt-JSON dir AND an EISDIR-style dir (branch.json
      // is itself a directory) -- both previously surfaced their raw error
      // message, which embeds the absolute path.
      await createHealthyBranch('main')
      await createCorruptBranch('broken')
      const eisdirMetaDir = path.join(branchesRoot, 'weird-branch', '.canopy-meta')
      await fs.mkdir(path.join(eisdirMetaDir, 'branch.json'), { recursive: true })

      const result = await branchHealthHandler(ctx, req, {})

      expect(result.data?.entries).toHaveLength(3)
      const broken = result.data?.entries.find((e) => e.dirName === 'broken')
      const weird = result.data?.entries.find((e) => e.dirName === 'weird-branch')
      expect(broken?.parseError).toBeTruthy()
      expect(weird?.parseError).toBeTruthy()
      expect(JSON.stringify(result)).not.toContain(tmpDir)
    })

    it('scans for duplicate IDs only when asked, and reports the budget and truncation', async () => {
      await createHealthyBranch('main')

      const plain = await branchHealthHandler(ctx, req, {})
      expect(plain.data?.duplicateIdScan).toBeUndefined()
      expect(plain.data?.entries[0].duplicateIdScan).toBeUndefined()

      const scanned = await branchHealthHandler(ctx, req, { duplicates: '1' })
      expect(scanned.data?.duplicateIdScan).toEqual({
        budgetMs: DUPLICATE_ID_SCAN_BUDGET_MS,
        truncated: false,
      })
      expect(scanned.data?.entries[0].duplicateIdScan).toEqual({ state: 'none' })
    })

    it('marks the scan truncated when a branch scan outlives the budget', async () => {
      await createHealthyBranch('main')
      vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames').mockImplementation(
        () => new Promise<void>(() => {}),
      )
      // Only the timer pair is faked: the handler's real fs I/O must still run.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const pending = branchHealthHandler(ctx, req, { duplicates: '1' })
        while (vi.getTimerCount() === 0) await new Promise((r) => setImmediate(r))
        vi.advanceTimersByTime(DUPLICATE_ID_SCAN_BUDGET_MS)
        const result = await pending

        expect(result.data?.duplicateIdScan?.truncated).toBe(true)
        expect(result.data?.entries[0].duplicateIdScan).toEqual({
          state: 'unknown',
          reason: 'out-of-time',
        })
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
      }
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
      const scan = await branchHealthHandler(ctx, req, {})
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

  describe('POST /admin/branch-dirs/:dirName/dismiss-unpublished', () => {
    const flagged = async (dirName: string) => {
      await createHealthyBranch(dirName)
      const branchDir = path.join(branchesRoot, dirName)
      await getBranchMetadataFileManager(branchDir, branchesRoot, { settleMs: 0 }).save({
        branch: { status: 'archived', unpublishedAtMerge: true },
      })
      return branchDir
    }

    it('clears the flag and nothing else, leaving the time editors read as an edit', async () => {
      const branchDir = await flagged('merged')
      const before = await BranchMetadataFileManager.loadOnly(branchDir)

      const result = await dismissHandler(ctx, req, { dirName: 'merged' })

      expect(result.ok).toBe(true)
      const after = await BranchMetadataFileManager.loadOnly(branchDir)
      expect(after?.branch.unpublishedAtMerge).toBeUndefined()
      expect(after?.branch.status).toBe('archived')
      expect(after?.branch.updatedAt).toBe(before?.branch.updatedAt)
    })

    it('answers a conflict for a warning already dismissed', async () => {
      await createHealthyBranch('clean')

      const result = await dismissHandler(ctx, req, { dirName: 'clean' })

      expect(result.status).toBe(409)
      expect(result.error).toContain('already dismissed')
    })

    it('creates no directory for a name that has none', async () => {
      const result = await dismissHandler(ctx, req, { dirName: 'absent' })

      expect(result.status).toBe(404)
      await expect(fs.stat(path.join(branchesRoot, 'absent'))).rejects.toThrow()
    })

    it('refuses a name that escapes the branches root', async () => {
      const result = await dismissHandler(ctx, req, { dirName: '../outside' })

      expect(result.status).toBe(400)
    })

    it('lets the health scan see the flag for System health', async () => {
      await flagged('merged')

      const scan = await branchHealthHandler(ctx, req, {})
      const entry = scan.data?.entries.find((e) => e.dirName === 'merged')

      expect(entry?.kind === 'healthy' && entry.branch?.unpublishedAtMerge).toBe(true)
    })
  })

  describe('POST /admin/branch-dirs/:dirName/repair-metadata', () => {
    it('repairs a corrupt branch.json, archiving the original and recreating defaults', async () => {
      await createCorruptBranchWithGit('repair-me')

      const result = await repairHandler(ctx, req, { dirName: 'repair-me' })

      expect(result.ok).toBe(true)
      expect(result.data?.archivedAs).toMatch(/^branch\.json\.corrupt-\d{8}T\d{6}Z$/)
      expect(result.data?.branch.status).toBe('editing')
      expect(result.data?.branch.createdBy).toBe(req.user.userId)
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

    it('repairs a branch.json that parses but fails the schema, end to end', async () => {
      const shapeBroken = JSON.stringify({ schemaVersion: 1, version: 4, branch: { name: 'x' } })
      await cloneOn(path.join(branchesRoot, 'shape-broken'), 'shape-broken')
      const metaDir = path.join(branchesRoot, 'shape-broken', '.canopy-meta')
      await fs.mkdir(metaDir, { recursive: true })
      await fs.writeFile(path.join(metaDir, 'branch.json'), shapeBroken, 'utf-8')

      const scanned = await branchHealthHandler(ctx, req, {})
      const entry = scanned.data?.entries.find((e) => e.dirName === 'shape-broken')
      expect(entry?.kind).toBe('corrupt-metadata')
      expect(entry?.parseError).toBe('Not branch metadata. Missing: branch.status, branch.access')

      const result = await repairHandler(ctx, req, { dirName: 'shape-broken' })

      expect(result.ok).toBe(true)
      expect(result.data?.branch.status).toBe('editing')
      expect(await fs.readFile(path.join(metaDir, result.data!.archivedAs), 'utf-8')).toBe(
        shapeBroken,
      )
      const repaired = await BranchMetadataFileManager.loadOnly(
        path.join(branchesRoot, 'shape-broken'),
      )
      expect(repaired?.branch).toMatchObject({ name: 'shape-broken', status: 'editing' })
      expect((await registry.list()).map((b) => b.branch.name)).toContain('shape-broken')
    })

    it('reports what it reset when the corrupt file is not JSON, so nothing reads as recovered', async () => {
      // A submitted branch with a list, created by someone other than the repairing admin.
      const branchDir = path.join(branchesRoot, 'was-submitted')
      await cloneOn(branchDir, 'was-submitted')
      const manager = getBranchMetadataFileManager(branchDir, branchesRoot, { settleMs: 0 })
      await manager.save({
        branch: {
          name: 'was-submitted',
          status: 'submitted',
          createdBy: 'original-author',
          access: { allowedUsers: ['alice'] },
        },
      })
      await fs.writeFile(
        path.join(branchDir, '.canopy-meta', 'branch.json'),
        'not json {{{',
        'utf-8',
      )

      const result = await repairHandler(ctx, req, { dirName: 'was-submitted' })

      expect(result.ok).toBe(true)
      const access = { restricted: true }
      expect(result.data?.branch).toMatchObject({
        status: 'editing',
        access,
        createdBy: req.user.userId,
      })
      expect(result.data?.reset).toEqual({ status: 'editing', access, createdBy: req.user.userId })
      expect(result.data?.kept).toEqual({})
    })

    it('refuses to merge over metadata another write laid down after the archive', async () => {
      await createCorruptBranchWithGit('raced')
      const metaFile = path.join(branchesRoot, 'raced', '.canopy-meta', 'branch.json')
      const theirs = {
        schemaVersion: 1,
        version: 1,
        branch: {
          name: 'raced',
          status: 'submitted',
          access: { allowedUsers: ['carol'] },
          createdBy: 'carol',
        },
      }
      const realSaveIf = BranchMetadataFileManager.prototype.saveIf
      const saveIf = vi
        .spyOn(BranchMetadataFileManager.prototype, 'saveIf')
        .mockImplementationOnce(async function (this: BranchMetadataFileManager, ...args) {
          await fs.writeFile(metaFile, JSON.stringify(theirs), 'utf-8')
          return realSaveIf.apply(this, args)
        })
      try {
        const result = await repairHandler(ctx, req, { dirName: 'raced' })

        expect(result.ok).toBe(false)
        expect(result.status).toBe(409)
        expect(result.error).toBe(
          "Another write recreated this branch's metadata during repair; open System health again",
        )
        expect(JSON.parse(await fs.readFile(metaFile, 'utf-8'))).toEqual(theirs)
      } finally {
        saveIf.mockRestore()
      }
    })

    it('allows repairing the base branch (H3 regression)', async () => {
      await createCorruptBranchWithGit('main')
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

    const expectUntouched = async (dirName: string) => {
      const metaDir = path.join(branchesRoot, dirName, '.canopy-meta')
      expect(await fs.readdir(metaDir)).toEqual(['branch.json'])
      expect(await fs.readFile(path.join(metaDir, 'branch.json'), 'utf-8')).toBe('not json {{{')
    }

    it('refuses a directory with no git clone, guessing no name and archiving nothing', async () => {
      await createCorruptBranch('canopycms-prod-spring')

      const result = await repairHandler(ctx, req, { dirName: 'canopycms-prod-spring' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe(
        'Cannot repair this branch: the directory holds no git clone, so the branch it belongs to ' +
          'is unknown. Check out its branch in the clone, then repair again, or purge the directory.',
      )
      await expectUntouched('canopycms-prod-spring')
    })

    it('refuses a clone with a detached HEAD, guessing no name and archiving nothing', async () => {
      const git = await createCorruptBranchWithGit('canopycms-prod-spring', 'canopycms/prod/spring')
      await git.raw(['checkout', '--detach'])

      const result = await repairHandler(ctx, req, { dirName: 'canopycms-prod-spring' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe(
        'Cannot repair this branch: its clone has no branch checked out (a detached HEAD), so the ' +
          'branch it belongs to is unknown. Check out its branch in the clone, then repair again, ' +
          'or purge the directory.',
      )
      await expectUntouched('canopycms-prod-spring')
    })

    it('refuses a clone on a branch whose key is not the directory, archiving nothing', async () => {
      await createCorruptBranchWithGit('canopycms-prod-spring', 'canopycms/prod/autumn')

      const result = await repairHandler(ctx, req, { dirName: 'canopycms-prod-spring' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe(
        'Cannot repair this branch: its clone has "canopycms/prod/autumn" checked out, which is ' +
          'not the branch this directory holds. Check out its branch in the clone, then repair ' +
          'again, or purge the directory.',
      )
      await expectUntouched('canopycms-prod-spring')
    })

    it('refuses an invalid .git inside another repository, reading nothing from that one', async () => {
      // The repository around the workspaces has the very branch the directory's key names.
      const outer = await initTestRepo(branchesRoot)
      await outer.checkoutLocalBranch('canopycms/prod/spring')
      await fs.writeFile(path.join(branchesRoot, '.gitkeep'), '')
      await outer.add(['.gitkeep'])
      await outer.commit('outer')
      await createCorruptBranch('canopycms-prod-spring')
      await fs.mkdir(path.join(branchesRoot, 'canopycms-prod-spring', '.git'))

      const result = await repairHandler(ctx, req, { dirName: 'canopycms-prod-spring' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toMatch(
        /^Cannot repair this branch: git could not read the clone's checked-out branch \(/,
      )
      await expectUntouched('canopycms-prod-spring')
    })

    it('returns 404 for a nonexistent directory (MEDIUM-1 rider)', async () => {
      const result = await repairHandler(ctx, req, { dirName: 'never-existed' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('returns 409 on provisioning lock contention against a real held lock (MEDIUM-1)', async () => {
      await createCorruptBranchWithGit('repair-contended')

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

  describe.each(['allow', 'deny'] as const)(
    'POST /admin/branch-dirs/:dirName/repair-metadata on a %s site: who can open the branch',
    (site) => {
      const alice = createMockUser('user', { userId: 'alice' })
      const bob = createMockUser('user', { userId: 'bob' })
      const carol = createMockUser('user', { userId: 'carol', groups: ['writers'] })
      const dave = createMockUser('user', { userId: 'dave' })
      const reviewer = createMockUser('reviewer')
      const removal = { by: 'alice', at: '2026-11-01T00:00:00.000Z', byAdmin: false }

      beforeEach(() => {
        ctx = createMockApiContext({
          services: {
            config: {
              mode: 'prod',
              defaultBaseBranch: 'main',
              defaultBranchAccess: site,
            } as CanopyConfig,
            registry,
          },
        })
      })

      /** A clone of `dirName` whose branch.json holds `raw` and fails its schema. */
      const createDamaged = async (dirName: string, raw: string) => {
        const branchDir = path.join(branchesRoot, dirName)
        await cloneOn(branchDir, dirName)
        await fs.mkdir(path.join(branchDir, '.canopy-meta'), { recursive: true })
        await fs.writeFile(path.join(branchDir, '.canopy-meta', 'branch.json'), raw, 'utf-8')
      }

      const damagedJson = (branch: Record<string, unknown>) =>
        JSON.stringify({ schemaVersion: 1, version: 3, branch: { status: 'bogus', ...branch } })

      /** The access check the guards run, over what the repair wrote to disk. */
      const canOpen = async (dirName: string, user: CanopyUser): Promise<boolean> => {
        const branchRoot = path.join(branchesRoot, dirName)
        const meta = await BranchMetadataFileManager.loadOnly(branchRoot)
        if (!meta) throw new Error(`no branch.json in ${dirName}`)
        const check = createCheckBranchAccess(site, ctx.services.config)
        return check({ branch: meta.branch, branchRoot, baseRoot: branchesRoot }, user).allowed
      }

      it('keeps a readable list, its removals and its creator from a file that fails the schema', async () => {
        const access = {
          restricted: true,
          allowedUsers: ['alice', 'bob'],
          allowedGroups: ['writers'],
          excluded: { carol: removal },
        }
        await createDamaged('private', damagedJson({ name: 'private', access, createdBy: 'alice' }))

        const result = await repairHandler(ctx, req, { dirName: 'private' })

        expect(result.ok).toBe(true)
        expect(result.data?.branch).toMatchObject({ status: 'editing', access, createdBy: 'alice' })
        expect(result.data?.reset).toEqual({ status: 'editing' })
        expect(result.data?.kept).toEqual({ access, createdBy: 'alice' })
        expect(result.data?.restricted).toBe(true)
        expect(result.data?.openToEveryone).toBe(false)
        expect(await canOpen('private', alice)).toBe(true)
        expect(await canOpen('private', bob)).toBe(true)
        expect(await canOpen('private', carol)).toBe(false)
        expect(await canOpen('private', dave)).toBe(false)
      })

      it('limits a branch whose file is not JSON to admins and reviewers, the admin its creator', async () => {
        await createDamaged('unreadable', '{"branch": {"access": {"restricted": tru')

        const result = await repairHandler(ctx, req, { dirName: 'unreadable' })

        const access = { restricted: true }
        expect(result.ok).toBe(true)
        expect(result.data?.branch).toMatchObject({ access, createdBy: 'admin' })
        expect(result.data?.reset).toEqual({ status: 'editing', access, createdBy: 'admin' })
        expect(result.data?.kept).toEqual({})
        expect(result.data?.restricted).toBe(true)
        expect(result.data?.openToEveryone).toBe(false)
        expect(await canOpen('unreadable', req.user)).toBe(true)
        expect(await canOpen('unreadable', reviewer)).toBe(true)
        expect(await canOpen('unreadable', dave)).toBe(false)
      })

      it('limits a branch whose access fails its schema to the creator the file still names', async () => {
        await createDamaged(
          'bad-access',
          damagedJson({
            name: 'bad-access',
            status: 'editing',
            access: { allowedUsers: 'x' },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'bad-access' })

        const access = { restricted: true, allowedUsers: ['alice'] }
        expect(result.ok).toBe(true)
        expect(result.data?.branch).toMatchObject({ access, createdBy: 'alice' })
        expect(result.data?.reset).toEqual({ status: 'editing', access })
        expect(result.data?.kept).toEqual({ createdBy: 'alice' })
        expect(result.data?.restricted).toBe(true)
        expect(await canOpen('bad-access', alice)).toBe(true)
        expect(await canOpen('bad-access', bob)).toBe(false)
        expect(await canOpen('bad-access', dave)).toBe(false)
      })

      it('takes an empty createdBy as unreadable, making the repairing admin the creator', async () => {
        await createDamaged(
          'no-creator',
          damagedJson({ name: 'no-creator', access: { allowedUsers: 'x' }, createdBy: '' }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'no-creator' })

        const access = { restricted: true, allowedUsers: ['admin'] }
        expect(result.data?.reset).toEqual({ status: 'editing', access, createdBy: 'admin' })
        expect(result.data?.kept).toEqual({})
      })

      it('keeps out a creator the damaged list excluded, carrying the removals that read', async () => {
        const adminRemoval = { by: 'admin', at: '2026-11-01T00:00:00.000Z', byAdmin: true }
        const excluded = { alice: adminRemoval }
        const excludedGroups = { writers: adminRemoval }
        await createDamaged(
          'creator-removed',
          damagedJson({
            name: 'creator-removed',
            status: 'editing',
            access: {
              restricted: true,
              allowedUsers: ['bob'],
              excluded,
              excludedGroups,
              entryMeta: 'damaged',
            },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'creator-removed' })

        const access = { restricted: true, excluded, excludedGroups }
        expect(result.data?.branch.access).toEqual(access)
        expect(result.data?.reset).toEqual({ status: 'editing', access })
        expect(await canOpen('creator-removed', alice)).toBe(false)
        expect(await canOpen('creator-removed', dave)).toBe(false)
        expect(await canOpen('creator-removed', req.user)).toBe(true)
      })

      it('keeps out a creator the damaged access excluded where no list names anyone', async () => {
        const excluded = { alice: removal }
        await createDamaged(
          'creator-excluded',
          damagedJson({
            name: 'creator-excluded',
            access: { excluded, entryMeta: 'damaged' },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'creator-excluded' })

        expect(result.data?.branch.access).toEqual({ restricted: true, excluded })
        expect(await canOpen('creator-excluded', alice)).toBe(false)
      })

      it('keeps out a creator a list that reads left off, though another field is damaged', async () => {
        await createDamaged(
          'creator-unlisted',
          damagedJson({
            name: 'creator-unlisted',
            access: { restricted: true, allowedUsers: ['bob'], entryMeta: 'damaged' },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'creator-unlisted' })

        expect(result.data?.branch.access).toEqual({ restricted: true })
        expect(await canOpen('creator-unlisted', alice)).toBe(false)
      })

      it.each([true, 'yes'])(
        'leaves a branch under lockdown (%j), then damaged, to admins and reviewers',
        async (managerOrAdminAllowed) => {
          await createDamaged(
            'locked',
            damagedJson({
              name: 'locked',
              access: { managerOrAdminAllowed, entryMeta: 'damaged' },
              createdBy: 'alice',
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'locked' })

          expect(result.data?.branch.access).toEqual({
            restricted: true,
            ...(managerOrAdminAllowed === true && { managerOrAdminAllowed: true }),
          })
          expect(await canOpen('locked', alice)).toBe(false)
          expect(await canOpen('locked', dave)).toBe(false)
          expect(await canOpen('locked', reviewer)).toBe(true)
        },
      )

      it('lists no one when the damaged access has removals that cannot be read', async () => {
        await createDamaged(
          'bad-removals',
          damagedJson({
            name: 'bad-removals',
            access: { restricted: true, allowedUsers: ['alice'], excluded: { carol: 'damaged' } },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'bad-removals' })

        expect(result.data?.branch.access).toEqual({ restricted: true })
        expect(await canOpen('bad-removals', alice)).toBe(false)
        expect(await canOpen('bad-removals', carol)).toBe(false)
      })

      it.each(['canopycms-system', 'unknown'])(
        'lists no one when the creator %s is not a person',
        async (createdBy) => {
          await createDamaged(
            'nobody',
            damagedJson({ name: 'nobody', access: { allowedUsers: 'x' }, createdBy }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'nobody' })

          expect(result.data?.branch).toMatchObject({ access: { restricted: true }, createdBy })
          expect(result.data?.branch.access).toEqual({ restricted: true })
          expect(result.data?.kept).toEqual({ createdBy })
          expect(await canOpen('nobody', dave)).toBe(false)
        },
      )

      it.each([{}, { restricted: false }])(
        'keeps an open branch (access %j) open as the site default leaves it',
        async (access) => {
          await createDamaged('open', damagedJson({ name: 'open', access, createdBy: 'alice' }))

          const result = await repairHandler(ctx, req, { dirName: 'open' })

          expect(result.ok).toBe(true)
          expect(result.data?.branch.access).toEqual(access)
          expect(result.data?.reset).toEqual({ status: 'editing' })
          expect(result.data?.kept).toEqual({ access, createdBy: 'alice' })
          expect(result.data?.restricted).toBe(false)
          expect(result.data?.openToEveryone).toBe(site === 'allow')
          expect(await canOpen('open', alice)).toBe(true)
          expect(await canOpen('open', dave)).toBe(site === 'allow')
        },
      )

      it('leaves the base branch without a list when its access cannot be read', async () => {
        await createDamaged('main', 'not json {{{')

        const result = await repairHandler(ctx, req, { dirName: 'main' })

        expect(result.ok).toBe(true)
        expect(result.data?.branch.access).toEqual({})
        expect(result.data?.reset).toEqual({ status: 'editing', access: {}, createdBy: 'admin' })
        expect(result.data?.restricted).toBe(false)
        expect(result.data?.openToEveryone).toBe(true)
        expect(await canOpen('main', dave)).toBe(true)
      })
    },
  )

  describe('POST /admin/branch-dirs/:dirName/repair-metadata in dev on a deny site', () => {
    const dave = createMockUser('user', { userId: 'dave' })
    let devRoot: string

    beforeEach(() => {
      // Dev keeps branches under {cwd}/.canopy-dev/content-branches.
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
      devRoot = path.join(tmpDir, '.canopy-dev', 'content-branches')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    const useConfig = (config: Partial<CanopyConfig>) => {
      ctx = createMockApiContext({
        services: {
          config: { mode: 'dev', defaultBranchAccess: 'deny', ...config } as CanopyConfig,
          registry,
        },
      })
    }

    const createDamaged = async (dirName: string, branch: Record<string, unknown>) => {
      const branchDir = path.join(devRoot, dirName)
      await cloneOn(branchDir, dirName)
      await fs.mkdir(path.join(branchDir, '.canopy-meta'), { recursive: true })
      await fs.writeFile(
        path.join(branchDir, '.canopy-meta', 'branch.json'),
        JSON.stringify({ branch: { name: dirName, status: 'bogus', ...branch } }),
        'utf-8',
      )
    }

    const canOpen = async (dirName: string, user: CanopyUser): Promise<boolean> => {
      const branchRoot = path.join(devRoot, dirName)
      const meta = await BranchMetadataFileManager.loadOnly(branchRoot)
      if (!meta) throw new Error(`no branch.json in ${dirName}`)
      const config = ctx.services.config
      const check = createCheckBranchAccess(config.defaultBranchAccess, config)
      return check({ branch: meta.branch, branchRoot, baseRoot: devRoot }, user).allowed
    }

    it('reports the dev active branch, kept open, as open to everyone, as the access check has it', async () => {
      useConfig({ defaultBaseBranch: 'main', defaultActiveBranch: 'work' })
      await createDamaged('work', { access: {}, createdBy: 'canopycms-system' })

      const result = await repairHandler(ctx, req, { dirName: 'work' })

      expect(result.data?.kept).toEqual({ access: {}, createdBy: 'canopycms-system' })
      expect(result.data?.openToEveryone).toBe(true)
      expect(await canOpen('work', dave)).toBe(true)
    })

    it('treats a base workspace as base by its recorded base branch after the default drifts', async () => {
      useConfig({ defaultBaseBranch: 'develop' })
      await createDamaged('main', {
        baseBranch: 'main',
        access: { allowedUsers: 'x' },
        createdBy: 'canopycms-system',
      })

      const result = await repairHandler(ctx, req, { dirName: 'main' })

      expect(result.data?.branch).toMatchObject({ access: {}, baseBranch: 'main' })
      expect(result.data?.kept).toEqual({ createdBy: 'canopycms-system', baseBranch: 'main' })
      expect(result.data?.openToEveryone).toBe(true)
      expect(await canOpen('main', dave)).toBe(true)
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
      // The archived files leave the branch at its next submit, so the admin is credited.
      expect(ctx.services.recordBranchEditor).toHaveBeenCalledWith(
        { branchRoot: path.join(branchesRoot, 'dup-branch'), baseRoot: branchesRoot },
        req.user,
      )
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
        scan = await branchHealthHandler(ctx, req, { duplicates: '1' })
      } finally {
        rescanSpy.restore()
      }
      const entry = scan.data?.entries.find((e) => e.dirName === 'dup-branch')
      expect(entry?.duplicateIdScan).toEqual({ state: 'none' })
    })

    it('returns 409 when there are no duplicate content IDs to repair', async () => {
      await createHealthyBranch('clean-branch')
      const result = await repairContentDuplicatesHandler(ctx, req, { dirName: 'clean-branch' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(ctx.services.recordBranchEditor).not.toHaveBeenCalled()
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

    it('credits the admin for a partial repair, whose archived files still leave the branch', async () => {
      const { postsDir } = await createDuplicateContentIds('partial-branch')
      const secondId = generateId()
      await fs.writeFile(path.join(postsDir, `page.a.${secondId}.json`), '{}', 'utf-8')
      await fs.writeFile(path.join(postsDir, `page.b.${secondId}.json`), '{}', 'utf-8')
      const realRename = fs.rename.bind(fs)
      let renames = 0
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        renames += 1
        if (renames === 2) throw new Error('disk full')
        return realRename(from, to)
      })

      const consoleSpy = mockConsole()
      let result: Awaited<ReturnType<typeof repairContentDuplicatesHandler>>
      try {
        result = await repairContentDuplicatesHandler(ctx, req, { dirName: 'partial-branch' })
      } finally {
        consoleSpy.restore()
        rename.mockRestore()
      }

      expect(result.status).toBe(500)
      expect(result.error).toContain('partially repaired first')
      expect(ctx.services.recordBranchEditor).toHaveBeenCalledWith(
        { branchRoot: path.join(branchesRoot, 'partial-branch'), baseRoot: branchesRoot },
        req.user,
      )
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
