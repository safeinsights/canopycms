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
import {
  applyAccessChange,
  branchSharingRights,
  createCheckBranchAccess,
  getBranchWriteProtection,
  hasAccessList,
} from '../authorization'
import type { CanopyUser } from '../user'
import type { BranchMetadata } from '../types'
import { deleteBranchHandler } from './branch'
import { withdrawBranch } from './branch-withdraw'
import { DELETE_NEEDS_ADMIN_REASON } from '../editor/copy'
import { archivedCutoff, deletableByAge } from '../branch-archive'
import { refusesPushAsRewritten } from '../worker/github-commits'
import { unsafeAsBranchName } from '../paths/test-utils'
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
const withdrawHandler = withdrawBranch.handler

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
      expect(result.data?.branch.status).toBe('submitted')
      expect(result.data?.branch.createdBy).toBe('unknown')
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
      expect(result.data?.branch.status).toBe('submitted')
      expect(await fs.readFile(path.join(metaDir, result.data!.archivedAs), 'utf-8')).toBe(
        shapeBroken,
      )
      const repaired = await BranchMetadataFileManager.loadOnly(
        path.join(branchesRoot, 'shape-broken'),
      )
      expect(repaired?.branch).toMatchObject({ name: 'shape-broken', status: 'submitted' })
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
        status: 'submitted',
        access,
        createdBy: 'unknown',
      })
      expect(result.data?.reset).toEqual({ status: 'submitted', access, createdBy: 'unknown' })
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
        expect(result.error).toMatch(
          /^Another write created this branch's metadata during repair, so it holds that write's metadata and its access may be open\. The corrupt file is archived as branch\.json\.corrupt-\d{8}T\d{6}Z\. Check who can open it, in "Branches"\.$/,
        )
        expect(JSON.parse(await fs.readFile(metaFile, 'utf-8'))).toEqual(theirs)
      } finally {
        saveIf.mockRestore()
      }
    })

    describe('when the write throws after the archive', () => {
      const corruptText = 'not json {{{'
      const metaDir = () => path.join(branchesRoot, 'write-fails', '.canopy-meta')

      const repairWithFailingWrite = async (beforeThrow: () => Promise<void> = async () => {}) => {
        await createCorruptBranchWithGit('write-fails')
        const saveIf = vi
          .spyOn(BranchMetadataFileManager.prototype, 'saveIf')
          .mockImplementationOnce(async () => {
            await beforeThrow()
            throw new Error('disk full')
          })
        try {
          return await repairHandler(ctx, req, { dirName: 'write-fails' })
        } finally {
          saveIf.mockRestore()
        }
      }

      it('refuses, archiving nothing, when the corrupt file cannot be read', async () => {
        await createCorruptBranchWithGit('unreadable-file')
        const file = path.join(branchesRoot, 'unreadable-file', '.canopy-meta', 'branch.json')
        const realReadFile = fs.readFile
        let reads = 0
        const readFile = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
          // The prechecks read it twice; the third read is the text repair salvages.
          if (args[0] === file && ++reads === 3) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          }
          return realReadFile(...(args as Parameters<typeof realReadFile>))
        })
        try {
          const result = await repairHandler(ctx, req, { dirName: 'unreadable-file' })

          expect(result).toMatchObject({
            ok: false,
            status: 500,
            error:
              'Could not read the corrupt branch.json, so nothing was archived: permission denied',
          })
        } finally {
          readFile.mockRestore()
        }
        expect(await fs.readFile(file, 'utf-8')).toBe(corruptText)
        expect(
          (await fs.readdir(path.dirname(file))).filter((f) => f.includes('.corrupt-')),
        ).toEqual([])
      })

      it('puts the corrupt file back as branch.json, so the directory reads as corrupt again', async () => {
        const result = await repairWithFailingWrite()

        expect(result.ok).toBe(false)
        expect(result.status).toBe(500)
        expect(result.error).toBe(
          'Could not write the repaired metadata: disk full. The corrupt file is back as branch.json.',
        )
        expect(await fs.readFile(path.join(metaDir(), 'branch.json'), 'utf-8')).toBe(corruptText)
        expect((await fs.readdir(metaDir())).filter((f) => f.includes('.corrupt-'))).toEqual([])
        const scanned = await branchHealthHandler(ctx, req, {})
        expect(scanned.data?.entries.find((e) => e.dirName === 'write-fails')?.kind).toBe(
          'corrupt-metadata',
        )
      })

      it('leaves the archive alone when branch.json was written meanwhile', async () => {
        const theirs = '{"written": "meanwhile"}'
        const result = await repairWithFailingWrite(() =>
          fs.writeFile(path.join(metaDir(), 'branch.json'), theirs, 'utf-8'),
        )

        expect(result.error).toMatch(
          /^Could not write the repaired metadata: disk full\. The corrupt file stays archived as branch\.json\.corrupt-\d{8}T\d{6}Z: another write created this branch's metadata, so its access may be open\. Check who can open it, in "Branches"\.$/,
        )
        expect(await fs.readFile(path.join(metaDir(), 'branch.json'), 'utf-8')).toBe(theirs)
      })

      it('answers success with a warning when only the step after the write failed', async () => {
        await createCorruptBranchWithGit('refresh-fails')
        const invalidate = vi
          .spyOn(BranchRegistry.prototype, 'invalidate')
          .mockRejectedValueOnce(new Error('registry down'))
        try {
          const result = await repairHandler(ctx, req, { dirName: 'refresh-fails' })

          expect(result.ok).toBe(true)
          expect(result.data?.warning).toBe(
            'The repair was written, but refreshing the branch list failed (registry down), so the list may show the branch late.',
          )
          expect(result.data?.branch).toMatchObject({
            status: 'submitted',
            access: { restricted: true },
            createdBy: 'unknown',
          })
          const onDisk = await BranchMetadataFileManager.loadOnly(
            path.join(branchesRoot, 'refresh-fails'),
          )
          expect(onDisk?.branch.access).toEqual({ restricted: true })
        } finally {
          invalidate.mockRestore()
        }
      })

      it.each([
        ['access', { name: 'write-fails', access: {} }],
        ['name', { name: 'another-branch', access: { restricted: true } }],
      ])(
        'takes no success from metadata on disk that differs from the repair only in %s',
        async (_field, differs) => {
          // What the repair writes for text that isn't JSON, but for the one field.
          const theirs = {
            schemaVersion: 1,
            version: 1,
            branch: { status: 'submitted', createdBy: 'unknown', ...differs },
          }
          const result = await repairWithFailingWrite(() =>
            fs.writeFile(path.join(metaDir(), 'branch.json'), JSON.stringify(theirs), 'utf-8'),
          )

          expect(result.ok).toBe(false)
          expect(result.error).toMatch(
            /another write created this branch's metadata, so its access may be open/,
          )
        },
      )

      /** The real write, then `change` to branch.json, then a throw, as a failed refresh would. */
      const repairWhoseRefreshFails = async (change: (branch: Record<string, unknown>) => void) => {
        await createCorruptBranchWithGit('write-fails')
        // A readable createdAt, so repair keeps it and the read-back holds it to that value.
        await fs.writeFile(
          path.join(metaDir(), 'branch.json'),
          JSON.stringify({
            branch: {
              createdAt: '2026-01-01T00:00:00.000Z',
              lastGitHubTip: 'a'.repeat(40),
              status: 'bogus',
            },
          }),
          'utf-8',
        )
        const realSaveIf = BranchMetadataFileManager.prototype.saveIf
        const saveIf = vi
          .spyOn(BranchMetadataFileManager.prototype, 'saveIf')
          .mockImplementationOnce(async function (this: BranchMetadataFileManager, ...args) {
            await realSaveIf.apply(this, args)
            const file = path.join(metaDir(), 'branch.json')
            const json = JSON.parse(await fs.readFile(file, 'utf-8'))
            change(json.branch)
            await fs.writeFile(file, JSON.stringify(json), 'utf-8')
            throw new Error('registry down')
          })
        try {
          return await repairHandler(ctx, req, { dirName: 'write-fails' })
        } finally {
          saveIf.mockRestore()
        }
      }

      it('takes a bookkeeping write that landed in between as no reason to fail', async () => {
        // As recordGitHubTip would, between repair's write and its registry refresh.
        const result = await repairWhoseRefreshFails((branch) => {
          branch.lastGitHubTip = 'b'.repeat(40)
          branch.editors = ['carol']
        })

        expect(result.ok).toBe(true)
        expect(result.data?.warning).toMatch(/refreshing the branch list failed \(registry down\)/)
      })

      it.each([
        [
          'createdAt',
          (branch: Record<string, unknown>) => (branch.createdAt = '2001-01-01T00:00:00.000Z'),
        ],
        [
          'unpublishedAtMerge',
          (branch: Record<string, unknown>) => (branch.unpublishedAtMerge = true),
        ],
        [
          'rewrittenOnGitHub',
          (branch: Record<string, unknown>) => (branch.rewrittenOnGitHub = 'c'.repeat(40)),
        ],
        [
          'archivedAt',
          (branch: Record<string, unknown>) => (branch.archivedAt = '2001-01-01T00:00:00.000Z'),
        ],
      ])(
        'takes a change to %s, which repair decides, as the write not landing',
        async (_f, change) => {
          const result = await repairWhoseRefreshFails(change)

          expect(result.ok).toBe(false)
          expect(result.error).toMatch(
            /another write created this branch's metadata, so its access may be open/,
          )
        },
      )

      it('says so when the corrupt file cannot be put back', async () => {
        const result = await repairWithFailingWrite(async () => {
          for (const f of await fs.readdir(metaDir())) {
            if (f.includes('.corrupt-')) await fs.rm(path.join(metaDir(), f))
          }
        })

        expect(result.error).toMatch(
          /^Could not write the repaired metadata: disk full\. The corrupt file could not be put back, and stays archived as branch\.json\.corrupt-\d{8}T\d{6}Z: /,
        )
      })
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

      /** Fails the schema on a field that bears on nothing, unless `branch` damages more. */
      const damagedJson = (branch: Record<string, unknown>) =>
        JSON.stringify({
          schemaVersion: 1,
          version: 3,
          branch: { status: 'editing', pullRequestNumber: 'damaged', ...branch },
        })

      /** The access check the guards run, over what the repair wrote to disk. */
      const canOpen = async (dirName: string, user: CanopyUser): Promise<boolean> => {
        const branchRoot = path.join(branchesRoot, dirName)
        const meta = await BranchMetadataFileManager.loadOnly(branchRoot)
        if (!meta) throw new Error(`no branch.json in ${dirName}`)
        const check = createCheckBranchAccess(site, ctx.services.config)
        return check({ branch: meta.branch, branchRoot, baseRoot: branchesRoot }, user).allowed
      }

      /** Alice's Withdraw of the repaired branch, through the handler. */
      const withdrawAsCreator = (dirName: string, branch: BranchMetadata) => {
        const branchRoot = path.join(branchesRoot, dirName)
        const config = ctx.services.config
        return withdrawHandler(
          createMockApiContext({
            services: {
              config,
              registry,
              checkBranchAccess: createCheckBranchAccess(site, config),
            },
            branchContext: { branch, branchRoot, baseRoot: branchesRoot },
          }),
          { user: alice, body: {} },
          { branch: unsafeAsBranchName(dirName) },
        )
      }

      /** Alice's delete of the repaired branch, through the handler. */
      const deleteAsCreator = (dirName: string, branch: BranchMetadata) => {
        const branchRoot = path.join(branchesRoot, dirName)
        const config = ctx.services.config
        return deleteBranchHandler(
          createMockApiContext({
            services: {
              config,
              registry,
              checkBranchAccess: createCheckBranchAccess(site, config),
            },
            branchContext: { branch, branchRoot, baseRoot: branchesRoot },
          }),
          { user: alice, body: {} },
          { branch: unsafeAsBranchName(dirName) },
        )
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
        expect(result.data?.reset).toEqual({})
        expect(result.data?.kept).toEqual({ status: 'editing', access, createdBy: 'alice' })
        expect(result.data?.restricted).toBe(true)
        expect(result.data?.openToEveryone).toBe(false)
        expect(await canOpen('private', alice)).toBe(true)
        expect(await canOpen('private', bob)).toBe(true)
        expect(await canOpen('private', carol)).toBe(false)
        expect(await canOpen('private', dave)).toBe(false)
      })

      it('limits a branch whose file is not JSON to admins and reviewers, its creator unknown', async () => {
        await createDamaged('unreadable', '{"branch": {"access": {"restricted": tru')

        const result = await repairHandler(ctx, req, { dirName: 'unreadable' })

        const access = { restricted: true }
        expect(result.ok).toBe(true)
        expect(result.data?.branch).toMatchObject({ access, createdBy: 'unknown' })
        expect(result.data?.reset).toEqual({ status: 'submitted', access, createdBy: 'unknown' })
        expect(result.data?.kept).toEqual({})
        expect(result.data?.restricted).toBe(true)
        expect(result.data?.openToEveryone).toBe(false)
        expect(await canOpen('unreadable', req.user)).toBe(true)
        expect(await canOpen('unreadable', reviewer)).toBe(true)
        expect(await canOpen('unreadable', dave)).toBe(false)
      })

      it('lists no one, not even the creator, when access fails its schema', async () => {
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

        const access = { restricted: true }
        expect(result.ok).toBe(true)
        expect(result.data?.branch).toMatchObject({ access, createdBy: 'alice' })
        expect(result.data?.reset).toEqual({ access })
        expect(result.data?.kept).toEqual({ status: 'editing', createdBy: 'alice' })
        expect(result.data?.restricted).toBe(true)
        expect(await canOpen('bad-access', alice)).toBe(false)
        expect(await canOpen('bad-access', reviewer)).toBe(true)
        expect(await canOpen('bad-access', dave)).toBe(false)
      })

      it('takes an empty createdBy as unreadable, recording the creator as unknown', async () => {
        await createDamaged(
          'no-creator',
          damagedJson({ name: 'no-creator', access: { allowedUsers: 'x' }, createdBy: '' }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'no-creator' })

        const access = { restricted: true }
        expect(result.data?.reset).toEqual({ access, createdBy: 'unknown' })
        expect(result.data?.kept).toEqual({ status: 'editing' })
      })

      it('keeps an archived branch archived, so a listed member can neither write nor manage it', async () => {
        const access = { restricted: true, allowedUsers: ['alice', 'bob'] }
        await createDamaged(
          'archived',
          damagedJson({
            name: 'archived',
            status: 'archived',
            access,
            createdBy: 'alice',
            pullRequestNumber: 'damaged',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'archived' })

        expect(result.data?.branch).toMatchObject({ status: 'archived', access })
        expect(result.data?.kept).toEqual({ status: 'archived', access, createdBy: 'alice' })
        expect(result.data?.reset).toEqual({})
        const written = result.data!.branch
        const config = ctx.services.config
        expect(
          getBranchWriteProtection(config, written.name, written.baseBranch, written.status)
            .writeBlocked,
        ).toBe(true)
        for (const member of [alice, bob]) {
          expect(
            branchSharingRights(member, written, { isProtected: false, whoCanAdd: 'members' }),
          ).toMatchObject({ canAdd: false, canManage: false, canRemoveOwn: false })
        }
      })

      it.each(['submitted', 'approved'] as const)(
        'keeps a %s branch in review with its pull request, write-locked, and Withdraw still works',
        async (status) => {
          const access = { restricted: true, allowedUsers: ['alice', 'bob'] }
          await createDamaged(
            'in-review',
            damagedJson({
              name: 'in-review',
              status,
              access,
              createdBy: 'alice',
              pullRequestNumber: 42,
              pullRequestUrl: 'https://github.com/o/r/pull/42',
              syncStatus: 'damaged',
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'in-review' })

          const written = result.data!.branch
          expect(written).toMatchObject({ status, pullRequestNumber: 42 })
          expect(result.data?.kept).toMatchObject({ status })
          expect(result.data?.otherFields).toEqual({
            kept: expect.arrayContaining(['pullRequestNumber', 'pullRequestUrl']),
            dropped: ['syncStatus'],
          })
          const config = ctx.services.config
          expect(
            getBranchWriteProtection(config, written.name, written.baseBranch, written.status)
              .writeBlocked,
          ).toBe(true)

          const withdrawn = await withdrawAsCreator('in-review', written)
          expect(withdrawn.error).toBeUndefined()
          expect(withdrawn.data?.branch.status).toBe('editing')
        },
      )

      it('takes a status that cannot be read as submitted, which Withdraw undoes', async () => {
        await createDamaged(
          'bad-status',
          damagedJson({ name: 'bad-status', status: 'bogus', access: {}, createdBy: 'alice' }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'bad-status' })

        expect(result.data?.branch.status).toBe('submitted')
        expect(result.data?.reset).toEqual({ status: 'submitted' })
        const written = result.data!.branch
        expect(
          getBranchWriteProtection(
            ctx.services.config,
            written.name,
            written.baseBranch,
            written.status,
          ).writeBlocked,
        ).toBe(true)
        const withdrawn = await withdrawAsCreator('bad-status', written)
        expect(withdrawn.error).toBeUndefined()
        expect(withdrawn.data?.branch.status).toBe('editing')
      })

      it.each([
        ['unreadable', { status: 'bogus' }],
        ['missing', { status: undefined }],
      ])(
        'holds the delete of a rewritten branch whose status is %s, with no archive time, through Withdraw',
        async (_c, status) => {
          await createDamaged(
            'lost-status',
            damagedJson({
              name: 'lost-status',
              ...status,
              access: {},
              createdBy: 'alice',
              rewrittenOnGitHub: 'a'.repeat(40),
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'lost-status' })

          expect(result.data?.branch).toMatchObject({
            status: 'submitted',
            unpublishedAtMerge: true,
          })
          expect(result.data?.reset).toMatchObject({
            status: 'submitted',
            unpublishedAtMerge: true,
          })
          const withdrawn = await withdrawAsCreator('lost-status', result.data!.branch)
          expect(withdrawn.data?.branch.status).toBe('editing')
          const onDisk = await BranchMetadataFileManager.loadOnly(
            path.join(branchesRoot, 'lost-status'),
          )
          const deleted = await deleteAsCreator('lost-status', onDisk!.branch)
          expect(deleted).toMatchObject({
            ok: false,
            status: 409,
            error: DELETE_NEEDS_ADMIN_REASON,
          })
        },
      )

      it('holds the delete of a merged, rewritten branch whose status is lost, which stays archived', async () => {
        await createDamaged(
          'lost-merged',
          damagedJson({
            name: 'lost-merged',
            status: 'bogus',
            access: {},
            createdBy: 'alice',
            rewrittenOnGitHub: 'a'.repeat(40),
            unpublishedAtMerge: false,
            mergedAt: '2026-01-01T00:00:00.000Z',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'lost-merged' })

        expect(result.data?.branch).toMatchObject({ status: 'archived', unpublishedAtMerge: true })
        expect(result.data?.reset).toMatchObject({ status: 'archived', unpublishedAtMerge: true })
        const deleted = await deleteAsCreator('lost-merged', result.data!.branch)
        expect(deleted).toMatchObject({ ok: false, status: 409, error: DELETE_NEEDS_ADMIN_REASON })
      })

      it.each([
        ['unreadable', { status: 'bogus' }],
        ['missing', { status: undefined }],
      ])(
        'keeps a branch archived whose status is %s but whose file records an archive time',
        async (_c, status) => {
          await createDamaged(
            'was-archived',
            damagedJson({
              name: 'was-archived',
              ...status,
              access: { restricted: true, allowedUsers: ['alice', 'bob'] },
              createdBy: 'alice',
              archivedAt: '2026-01-01T00:00:00.000Z',
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'was-archived' })

          const written = result.data!.branch
          expect(written.status).toBe('archived')
          expect(result.data?.reset).toEqual({ status: 'archived' })
          expect(result.data?.addBy).toBe('admins')
          const withdrawn = await withdrawAsCreator('was-archived', written)
          expect(withdrawn).toMatchObject({ ok: false, status: 400 })
          const rights = branchSharingRights(alice, written, {
            isProtected: false,
            whoCanAdd: 'members',
          })
          const added = applyAccessChange(
            written.access,
            { add: { users: ['dave'] } },
            { actor: alice, rights, creator: 'alice', defaultAccess: site, now: 'now' },
          )
          expect(added).toHaveProperty('refusal')
        },
      )

      it("refuses an owner's re-add after repair left the list to admins, though an admin re-listed them", async () => {
        await createDamaged(
          'admins-only',
          damagedJson({
            name: 'admins-only',
            access: { excluded: 'bob', addBy: 'members' },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'admins-only' })
        expect(result.data?.addBy).toBe('admins')

        // An admin lists the owner again.
        const admin = req.user
        const relisted = applyAccessChange(
          result.data!.branch.access,
          { add: { users: ['alice'] } },
          {
            actor: admin,
            rights: branchSharingRights(admin, result.data!.branch, {
              isProtected: false,
              whoCanAdd: 'members',
            }),
            creator: 'alice',
            defaultAccess: site,
            now: 'now',
          },
        )
        if ('refusal' in relisted) throw new Error(relisted.refusal.message)
        const branch = { ...result.data!.branch, access: relisted.access }
        const ownersAdd = applyAccessChange(
          branch.access,
          { add: { users: ['bob'] } },
          {
            actor: alice,
            rights: branchSharingRights(alice, branch, {
              isProtected: false,
              whoCanAdd: 'members',
            }),
            creator: 'alice',
            defaultAccess: site,
            now: 'now',
          },
        )
        expect(ownersAdd).toHaveProperty('refusal')
      })

      it('takes an archive time it cannot read as the repair time, so age deletion does not come early', async () => {
        await createDamaged(
          'archived-late',
          damagedJson({
            name: 'archived-late',
            status: 'archived',
            access: {},
            createdBy: 'alice',
            mergedAt: '2020-01-01T00:00:00.000Z',
            archivedAt: 7,
          }),
        )
        const before = Date.now()

        const result = await repairHandler(ctx, req, { dirName: 'archived-late' })

        const written = result.data!.branch
        expect(Date.parse(written.archivedAt ?? '')).toBeGreaterThanOrEqual(before - 1000)
        expect(result.data?.reset).toEqual({ archivedAt: written.archivedAt })
        expect(deletableByAge(written, archivedCutoff(30, Date.now()))).toBe(false)
      })

      it('carries a field it does not know over verbatim', async () => {
        await createDamaged(
          'future',
          damagedJson({ name: 'future', access: {}, createdBy: 'alice', futureLock: { on: true } }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'future' })

        expect(result.data?.otherFields.kept).toContain('futureLock')
        const raw = JSON.parse(
          await fs.readFile(
            path.join(branchesRoot, 'future', '.canopy-meta', 'branch.json'),
            'utf-8',
          ),
        )
        expect(raw.branch.futureLock).toEqual({ on: true })
      })

      it('records now for a createdAt it cannot read', async () => {
        await createDamaged(
          'when',
          damagedJson({ name: 'when', access: {}, createdBy: 'alice', createdAt: 7 }),
        )
        const before = Date.now()

        const result = await repairHandler(ctx, req, { dirName: 'when' })

        expect(Date.parse(result.data!.branch.createdAt)).toBeGreaterThanOrEqual(before - 1000)
        expect(result.data?.otherFields.dropped).toContain('createdAt')
      })

      it.each([
        ['unpublishedAtMerge', { unpublishedAtMerge: true }],
        ['rewrittenOnGitHub', { rewrittenOnGitHub: 'a'.repeat(40) }],
      ])(
        'keeps an archived branch held for an admin to delete through %s',
        async (_field, hold) => {
          await createDamaged(
            'held',
            damagedJson({
              name: 'held',
              status: 'archived',
              access: {},
              createdBy: 'alice',
              ...hold,
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'held' })

          expect(result.data?.branch).toMatchObject({ status: 'archived', ...hold })
          expect(result.data?.kept).toMatchObject(hold)
          const deleted = await deleteAsCreator('held', result.data!.branch)
          expect(deleted).toMatchObject({
            ok: false,
            status: 409,
            error: DELETE_NEEDS_ADMIN_REASON,
          })
        },
      )

      it.each([
        ['unpublishedAtMerge', { unpublishedAtMerge: 'yes' }, { unpublishedAtMerge: true }],
        ['rewrittenOnGitHub', { rewrittenOnGitHub: 7 }, { rewrittenOnGitHub: '' }],
      ])(
        'takes an unreadable %s at its most restrictive, holding the delete',
        async (_field, damaged, restrictive) => {
          await createDamaged(
            'held',
            damagedJson({
              name: 'held',
              status: 'archived',
              access: {},
              createdBy: 'alice',
              ...damaged,
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'held' })

          expect(result.data?.branch).toMatchObject(restrictive)
          expect(result.data?.reset).toEqual(restrictive)
          const deleted = await deleteAsCreator('held', result.data!.branch)
          expect(deleted).toMatchObject({ status: 409, error: DELETE_NEEDS_ADMIN_REASON })
        },
      )

      it('keeps out a creator the damaged list excluded, carrying the removals that read', async () => {
        const adminRemoval = { by: 'admin', at: '2026-11-01T00:00:00.000Z', byAdmin: true }
        const excluded = { alice: adminRemoval }
        const excludedGroups = { writers: adminRemoval }
        await createDamaged(
          'creator-removed',
          damagedJson({
            name: 'creator-removed',
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
        expect(result.data?.reset).toEqual({ access })
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

      it("keeps each removal entry, a malformed one as an admin's", async () => {
        await createDamaged(
          'entries',
          damagedJson({
            name: 'entries',
            access: { excluded: { bob: removal, carol: 'damaged' }, entryMeta: 1 },
            createdBy: 'alice',
          }),
        )

        const entries = await repairHandler(ctx, req, { dirName: 'entries' })

        expect(entries.data?.branch.access).toEqual({
          restricted: true,
          excluded: {
            bob: removal,
            carol: { by: 'unknown', at: expect.any(String), byAdmin: true },
          },
        })
        expect(await canOpen('entries', carol)).toBe(false)
      })

      it('drops a removals value that is no object, listing no one and leaving re-adding to admins', async () => {
        await createDamaged(
          'no-object',
          damagedJson({ name: 'no-object', access: { excluded: 'carol' }, createdBy: 'alice' }),
        )

        const noObject = await repairHandler(ctx, req, { dirName: 'no-object' })

        expect(noObject.data?.branch.access).toEqual({ restricted: true, addBy: 'admins' })
        expect(noObject.data?.removalsUnreadable).toBe(true)
      })

      it('leaves re-adding to admins when the removed groups cannot be read', async () => {
        await createDamaged(
          'no-groups',
          damagedJson({
            name: 'no-groups',
            access: { excludedGroups: ['readers'], addBy: 'members' },
            createdBy: 'alice',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'no-groups' })

        expect(result.data?.branch.access).toEqual({ restricted: true, addBy: 'admins' })
        expect(result.data?.removalsUnreadable).toBe(true)
        expect(result.data?.isBase).toBe(false)
      })

      it.each([
        ['members', 'members'],
        ['owner', 'owner'],
        ['admins', 'admins'],
        ['damaged', 'admins'],
      ])('carries addBy %j as %j', async (addBy, written) => {
        await createDamaged(
          'add-by',
          damagedJson({ name: 'add-by', access: { addBy, entryMeta: 1 }, createdBy: 'alice' }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'add-by' })

        expect(result.data?.branch.access).toEqual({ restricted: true, addBy: written })
      })

      it.each([true, 'yes'])(
        'leaves a branch under lockdown (%j), then damaged, locked to admins and reviewers',
        async (managerOrAdminAllowed) => {
          await createDamaged(
            'locked',
            damagedJson({
              name: 'locked',
              access: { managerOrAdminAllowed, allowedUsers: ['alice'], entryMeta: 'damaged' },
              createdBy: 'alice',
            }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'locked' })

          const written = result.data!.branch
          expect(written.access).toEqual({ restricted: true, managerOrAdminAllowed: true })
          expect(result.data?.lockedByRepair).toBe(managerOrAdminAllowed !== true)
          expect(await canOpen('locked', reviewer)).toBe(true)
          // Only the lockdown keeps out someone an admin lists again afterwards.
          const relisted = { ...written, access: { ...written.access, allowedUsers: ['alice'] } }
          const check = createCheckBranchAccess(site, ctx.services.config)
          const branchRoot = path.join(branchesRoot, 'locked')
          expect(
            check({ branch: relisted, branchRoot, baseRoot: branchesRoot }, alice).allowed,
          ).toBe(false)
        },
      )

      it('keeps the push-safety markers that read, so the worker still refuses the push', async () => {
        const markers = {
          rewrittenOnGitHub: 'a'.repeat(40),
          lastGitHubTip: 'b'.repeat(40),
          historyRewrittenFrom: 'c'.repeat(40),
          historyRewrittenTo: 'd'.repeat(40),
        }
        const createdAt = '2026-01-01T00:00:00.000Z'
        await createDamaged(
          'markers',
          damagedJson({ name: 'markers', access: {}, createdBy: 'alice', createdAt, ...markers }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'markers' })

        expect(result.data?.branch).toMatchObject({ ...markers, createdAt })
        expect(result.data?.kept).toMatchObject({ rewrittenOnGitHub: markers.rewrittenOnGitHub })
        expect(result.data?.otherFields.kept).toEqual(
          expect.arrayContaining(['lastGitHubTip', 'historyRewrittenFrom', 'historyRewrittenTo']),
        )
        expect(refusesPushAsRewritten(result.data!.branch)).toBe(true)
      })

      it('refuses the push when the rewrite marker cannot be read', async () => {
        await createDamaged(
          'marker-damaged',
          damagedJson({
            name: 'marker-damaged',
            access: {},
            createdBy: 'alice',
            rewrittenOnGitHub: { sha: 'x' },
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'marker-damaged' })

        expect(result.data?.reset).toEqual({ rewrittenOnGitHub: '' })
        const onDisk = await BranchMetadataFileManager.loadOnly(
          path.join(branchesRoot, 'marker-damaged'),
        )
        expect(refusesPushAsRewritten(onDisk!.branch)).toBe(true)
      })

      it.each([{}, { restricted: false }])(
        'keeps an open branch (access %j) open as the site default leaves it',
        async (access) => {
          await createDamaged('open', damagedJson({ name: 'open', access, createdBy: 'alice' }))

          const result = await repairHandler(ctx, req, { dirName: 'open' })

          expect(result.ok).toBe(true)
          expect(result.data?.branch.access).toEqual(access)
          expect(result.data?.reset).toEqual({})
          expect(result.data?.kept).toEqual({ status: 'editing', access, createdBy: 'alice' })
          expect(result.data?.restricted).toBe(false)
          expect(result.data?.openToEveryone).toBe(site === 'allow')
          expect(await canOpen('open', alice)).toBe(true)
          expect(await canOpen('open', dave)).toBe(site === 'allow')
        },
      )

      it('takes the creator grant from an open branch whose creator cannot be read', async () => {
        await createDamaged(
          'open-unknown',
          damagedJson({ name: 'open-unknown', access: {}, createdBy: ['alice'] }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'open-unknown' })

        expect(result.data?.branch).toMatchObject({ access: {}, createdBy: 'unknown' })
        expect(await canOpen('open-unknown', alice)).toBe(site === 'allow')
        const namedUnknown = createMockUser('user', { userId: 'unknown' })
        expect(await canOpen('open-unknown', namedUnknown)).toBe(site === 'allow')
      })

      it('leaves the base branch without a list when its file is not JSON', async () => {
        await createDamaged('main', 'not json {{{')

        const result = await repairHandler(ctx, req, { dirName: 'main' })

        expect(result.ok).toBe(true)
        expect(result.data?.branch.access).toEqual({})
        expect(result.data?.reset).toEqual({
          status: 'submitted',
          access: {},
          createdBy: 'unknown',
        })
        expect(result.data?.restricted).toBe(false)
        expect(result.data?.openToEveryone).toBe(true)
        expect(await canOpen('main', dave)).toBe(true)
      })

      it("reports a base branch's own lockdown as kept, not turned on by repair", async () => {
        await createDamaged(
          'main',
          damagedJson({
            name: 'main',
            access: { managerOrAdminAllowed: true, allowedUsers: 'x' },
            createdBy: 'canopycms-system',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'main' })

        expect(result.data?.branch.access).toEqual({ managerOrAdminAllowed: true })
        expect(result.data?.lockedByRepair).toBe(false)
      })

      it('gives the base branch only its readable narrowing when nothing suggests a restriction', async () => {
        const excluded = { bob: removal }
        await createDamaged(
          'main',
          damagedJson({
            name: 'main',
            access: { excluded, entryMeta: 1 },
            createdBy: 'canopycms-system',
          }),
        )

        const result = await repairHandler(ctx, req, { dirName: 'main' })

        expect(result.data?.branch.access).toEqual({ excluded })
        expect(result.data?.openToEveryone).toBe(true)
        expect(await canOpen('main', dave)).toBe(true)
        expect(await canOpen('main', bob)).toBe(false)
      })

      it.each([
        ['an allowedGroups that does not read', { allowedGroups: 'staff' }],
        ['a lockdown that does not read', { managerOrAdminAllowed: 'true' }],
        ['a list beside unreadable fields', { allowedUsers: 'x', excluded: { bob: removal } }],
        ['removals that are no object', { excluded: 'bob' }],
        ['removed groups that are no object', { excludedGroups: 'readers' }],
      ])(
        'locks the base branch to admins and reviewers when its access had %s',
        async (_c, access) => {
          await createDamaged(
            'main',
            damagedJson({ name: 'main', access, createdBy: 'canopycms-system' }),
          )

          const result = await repairHandler(ctx, req, { dirName: 'main' })

          expect(result.data?.branch.access).toMatchObject({ managerOrAdminAllowed: true })
          expect(result.data?.lockedByRepair).toBe(true)
          expect(result.data?.isBase).toBe(true)
          expect(hasAccessList(result.data!.branch.access)).toBe(false)
          expect(result.data?.restricted).toBe(false)
          expect(result.data?.openToEveryone).toBe(false)
          expect(await canOpen('main', dave)).toBe(false)
          expect(await canOpen('main', reviewer)).toBe(true)
        },
      )
    },
  )

  describe('POST /admin/branch-dirs/:dirName/repair-metadata in dev on a deny site', () => {
    const dave = createMockUser('user', { userId: 'dave' })
    const bob = createMockUser('user', { userId: 'bob' })
    const removal = { by: 'admin', at: '2026-11-01T00:00:00.000Z', byAdmin: true }
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
        JSON.stringify({
          branch: { name: dirName, status: 'editing', pullRequestNumber: 'damaged', ...branch },
        }),
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

      expect(result.data?.kept).toEqual({
        status: 'editing',
        access: {},
        createdBy: 'canopycms-system',
      })
      expect(result.data?.openToEveryone).toBe(true)
      expect(await canOpen('work', dave)).toBe(true)
    })

    it('gives the dev active branch only its readable narrowing when nothing suggests a restriction', async () => {
      useConfig({ defaultBaseBranch: 'main', defaultActiveBranch: 'work' })
      const excluded = { bob: removal }
      await createDamaged('work', {
        access: { excluded, entryMeta: 1 },
        createdBy: 'canopycms-system',
      })

      const result = await repairHandler(ctx, req, { dirName: 'work' })

      expect(result.data?.branch.access).toEqual({ excluded })
      expect(result.data?.reset).toEqual({ access: { excluded } })
      expect(result.data?.openToEveryone).toBe(true)
      expect(await canOpen('work', dave)).toBe(true)
      expect(await canOpen('work', bob)).toBe(false)
    })

    it('locks the dev active branch when its damaged access held a list', async () => {
      useConfig({ defaultBaseBranch: 'main', defaultActiveBranch: 'work' })
      await createDamaged('work', {
        access: { allowedUsers: 'x' },
        createdBy: 'canopycms-system',
      })

      const result = await repairHandler(ctx, req, { dirName: 'work' })

      expect(result.data?.branch.access).toEqual({ managerOrAdminAllowed: true })
      expect(result.data?.openToEveryone).toBe(false)
      expect(await canOpen('work', dave)).toBe(false)
    })

    it("stops treating the active branch as dev's own when its creator cannot be read", async () => {
      useConfig({ defaultBaseBranch: 'main', defaultActiveBranch: 'work' })
      await createDamaged('work', { access: {}, createdBy: 42 })

      const result = await repairHandler(ctx, req, { dirName: 'work' })

      expect(result.data?.branch).toMatchObject({ access: {}, createdBy: 'unknown' })
      expect(result.data?.openToEveryone).toBe(false)
      expect(await canOpen('work', dave)).toBe(false)
    })

    it('treats a base workspace as base by its recorded base branch after the default drifts', async () => {
      useConfig({ defaultBaseBranch: 'develop' })
      await createDamaged('main', {
        baseBranch: 'main',
        access: { excluded: { bob: removal }, entryMeta: 1 },
        createdBy: 'canopycms-system',
      })

      const result = await repairHandler(ctx, req, { dirName: 'main' })

      expect(result.data?.branch).toMatchObject({
        access: { excluded: { bob: removal } },
        baseBranch: 'main',
      })
      expect(result.data?.kept).toEqual({
        status: 'editing',
        createdBy: 'canopycms-system',
        baseBranch: 'main',
      })
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
