/**
 * Tests for CmsWorker.rebaseActiveBranches()
 *
 * Uses real git operations against temp directories to verify:
 * - Branches in review (submitted/approved) are not rebased
 * - Branches with uncommitted changes (dirty working tree) are not rebased
 * - Already-in-sync branches get their stale conflict state cleared
 * - Clean rebases mark the branch as clean
 * - Conflicting files keep the branch version (--theirs during rebase), ContentIds recorded in conflictFiles
 * - Non-entry files (no embedded ContentId) are excluded from conflictFiles
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { ROOT_COLLECTION_ID } from '../paths/types'
import { initTestRepo, mockConsole } from '../test-utils'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { CmsWorker } from './cms-worker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instantiate a CmsWorker with minimal config for testing rebase logic only. */
const makeWorker = (workspacePath: string, baseBranch = 'main', contentRoot?: string) =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch,
    contentRoot,
  })

/** Invoke the private rebaseActiveBranches() method. */
const runRebase = (worker: CmsWorker): Promise<void> =>
  (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()

/** Write branch metadata for a workspace. */
const writeMeta = async (
  branchPath: string,
  contentBranchesPath: string,
  data: Record<string, unknown>,
) => {
  const meta = BranchMetadataFileManager.get(branchPath, contentBranchesPath)
  await meta.save({
    branch: {
      name: path.basename(branchPath),
      status: 'editing' as const,
      access: {},
      createdBy: 'test',
      ...data,
    },
  })
}

/** Read saved branch metadata. */
const readMeta = (branchPath: string) =>
  BranchMetadataFileManager.loadOnly(branchPath).then((f) => f?.branch)

// ---------------------------------------------------------------------------
// Test workspace factory
// ---------------------------------------------------------------------------

interface BranchSetup {
  branchPath: string
  contentBranchesPath: string
  branchGit: SimpleGit
  remoteGit: SimpleGit
  /** Add a commit to the origin remote (makes the branch workspace "behind"). */
  pushToRemote: (files: Record<string, string>, message?: string) => Promise<void>
  /** Commit changes in the branch workspace. */
  commitToBranch: (files: Record<string, string>, message?: string) => Promise<void>
}

/**
 * Creates a local git setup: a "remote" repo and a branch-workspace clone.
 * The branch workspace's feature branch tracks origin/<baseBranch>.
 */
async function createBranchSetup(
  tmpDir: string,
  branchName: string,
  opts: {
    baseBranch?: string
    initialFiles?: Record<string, string>
    /** Make the clone sparse with this cone, as content-branch provisioning does. */
    sparseCone?: string[]
  } = {},
): Promise<BranchSetup> {
  const { baseBranch = 'main', initialFiles = { '.gitkeep': '' }, sparseCone } = opts

  const remotePath = path.join(tmpDir, 'remote.git')
  const contentBranchesPath = path.join(tmpDir, 'content-branches')
  const branchPath = path.join(contentBranchesPath, branchName)

  // --- Set up remote repo ---
  await fs.mkdir(remotePath)
  const remoteGit = await initTestRepo(remotePath)
  await remoteGit.raw(['branch', '-M', baseBranch])

  for (const [name, content] of Object.entries(initialFiles)) {
    const fullPath = path.join(remotePath, name)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  await remoteGit.add(['.'])
  await remoteGit.commit('initial commit')

  // --- Clone remote to branch workspace ---
  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remotePath, branchPath)

  // allowUnsafeEditor: simple-git >=3.32 blocks setting core.editor without opt-in;
  // mirrors the production CmsWorker git config (hardcoded literal, no user input).
  const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
  await branchGit.addConfig('user.name', 'Test Bot')
  await branchGit.addConfig('user.email', 'test@canopycms.test')
  // Prevent interactive editor prompts during `rebase --continue`
  await branchGit.addConfig('core.editor', 'true')

  // Exclude .canopy-meta/ from git tracking (matches production setup via ensureGitExclude)
  const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')

  if (sparseCone) await branchGit.raw(['sparse-checkout', 'set', '--cone', '--', ...sparseCone])

  // Check out a feature branch (distinct from baseBranch) that tracks origin/<baseBranch>
  await branchGit.checkoutBranch(branchName, `origin/${baseBranch}`)
  await branchGit.raw(['branch', `--set-upstream-to=origin/${baseBranch}`, branchName])

  const pushToRemote = async (files: Record<string, string>, message = 'remote commit') => {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(remotePath, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }
    await remoteGit.add(['.'])
    await remoteGit.commit(message)
  }

  const commitToBranch = async (files: Record<string, string>, message = 'branch commit') => {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(branchPath, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }
    await branchGit.raw(['add', '--sparse', '.'])
    await branchGit.commit(message)
  }

  return {
    branchPath,
    contentBranchesPath,
    branchGit,
    remoteGit,
    pushToRemote,
    commitToBranch,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CmsWorker rebaseActiveBranches', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-rebase-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Skipping
  // -------------------------------------------------------------------------

  describe('skipping', () => {
    it('does not rebase a submitted branch and leaves metadata unchanged', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'new-file.txt': 'from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        status: 'submitted',
        conflictStatus: 'conflicts-detected',
      })

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Metadata should be unchanged (the worker skipped entirely)
      const meta = await readMeta(setup.branchPath)
      expect(meta?.status).toBe('submitted')
      expect(meta?.conflictStatus).toBe('conflicts-detected')

      // Branch workspace should still be behind (fetch was not called)
      await setup.branchGit.fetch('origin', 'main')
      const status = await setup.branchGit.status()
      expect(status.behind).toBeGreaterThan(0)
    })

    it('does not rebase an approved branch and leaves metadata unchanged', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'new-file.txt': 'from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        status: 'approved',
        conflictStatus: 'clean',
      })

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.status).toBe('approved')
      expect(meta?.conflictStatus).toBe('clean')

      await setup.branchGit.fetch('origin', 'main')
      const status = await setup.branchGit.status()
      expect(status.behind).toBeGreaterThan(0)
    })

    it('skips a branch with uncommitted changes and leaves metadata unchanged', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'new-file.txt': 'from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        conflictStatus: 'conflicts-detected',
      })

      // Make the workspace dirty (uncommitted file)
      await fs.writeFile(path.join(setup.branchPath, 'unsaved-edit.txt'), 'editor draft')

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Metadata unchanged
      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')

      // Dirty file still present
      await expect(
        fs.readFile(path.join(setup.branchPath, 'unsaved-edit.txt'), 'utf8'),
      ).resolves.toBe('editor draft')

      // Branch still behind (no rebase happened)
      await setup.branchGit.fetch('origin', 'main')
      const status = await setup.branchGit.status()
      expect(status.behind).toBeGreaterThan(0)
    })

    it('skips the base branch directory entirely (no rebase, no metadata save)', async () => {
      // No real repo needed: the base-branch check happens right after the
      // .git-directory check, before any git ops or metadata load.
      const basePath = path.join(tmpDir, 'content-branches', 'main')
      await fs.mkdir(path.join(basePath, '.git'), { recursive: true })

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      const consoleSpy = mockConsole()
      const worker = makeWorker(tmpDir, 'main')
      await runRebase(worker)

      expect(saveSpy).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveLogged(/base branch \(refreshed separately\)/)
      const meta = await readMeta(basePath)
      expect(meta).toBeUndefined()

      consoleSpy.restore()
      saveSpy.mockRestore()
    })

    it.each([
      ['a reserved-prefix name', 'canopycms-settings-other', undefined],
      ["the worker's configured settings branch", 'site-settings', 'site-settings'],
    ])(
      'never rebases a settings-branch directory: %s',
      async (_label, branchName, settingsBranch) => {
        // Provisioned, behind, and clean: everything an ordinary branch needs to be rebased.
        const setup = await createBranchSetup(tmpDir, branchName)
        await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
        await setup.pushToRemote({ 'main-update.txt': 'new from main' })
        await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
        const head = await setup.branchGit.revparse(['HEAD'])
        const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
        const consoleSpy = mockConsole()

        try {
          const worker = new CmsWorker({
            workspacePath: tmpDir,
            githubOwner: 'test-owner',
            githubRepo: 'test-repo',
            baseBranch: 'main',
            githubToken: 'fake-token',
            settingsBranch,
          })
          await runRebase(worker)

          expect(await setup.branchGit.revparse(['HEAD'])).toBe(head)
          expect(saveSpy).not.toHaveBeenCalled()
          expect(consoleSpy).toHaveWarned(/settings branch, never a content workspace/)
        } finally {
          consoleSpy.restore()
          saveSpy.mockRestore()
        }
      },
    )

    it('logs when skipping a directory without a .git subdirectory', async () => {
      const notABranchDir = path.join(tmpDir, 'content-branches', 'not-a-branch')
      await fs.mkdir(notABranchDir, { recursive: true })
      await fs.writeFile(path.join(notABranchDir, 'stray-file.txt'), 'oops')

      const consoleSpy = mockConsole()
      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      expect(consoleSpy).toHaveLogged(/no \.git directory/i)
      consoleSpy.restore()
    })

    it('logs when .git exists but is not a directory', async () => {
      const weirdDir = path.join(tmpDir, 'content-branches', 'weird-branch')
      await fs.mkdir(weirdDir, { recursive: true })
      await fs.writeFile(path.join(weirdDir, '.git'), 'not a directory')

      const consoleSpy = mockConsole()
      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      expect(consoleSpy).toHaveLogged(/\.git is not a directory/i)
      consoleSpy.restore()
    })
  })

  // -------------------------------------------------------------------------
  // Already in sync
  // -------------------------------------------------------------------------

  describe('already in sync', () => {
    // Item 5 fix: every save() eager-regenerates the branch registry
    // (O(branch count) fs reads), so a rebase cycle must not unconditionally
    // save metadata for branches that are already in sync AND already
    // reflect a clean/no-conflict state -- that would turn every cycle into
    // O(N^2) registry work across N branches for a true no-op. A branch
    // that's in sync but NOT yet marked clean (e.g. stale
    // conflicts-detected from a previous cycle) must still be saved.

    it('does not save metadata when the branch is already up to date and already marked clean (no-op skip)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        conflictStatus: 'clean',
        conflictFiles: [],
      })

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      const worker = makeWorker(tmpDir)
      await runRebase(worker)
      expect(saveSpy).not.toHaveBeenCalled()
      saveSpy.mockRestore()
    })

    it('does not save metadata when the branch has never recorded a conflict status (undefined treated as clean)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      // No new commits pushed to remote: branch is already in sync, and
      // conflictStatus/conflictFiles were never set (a brand-new branch).
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      const worker = makeWorker(tmpDir)
      await runRebase(worker)
      expect(saveSpy).not.toHaveBeenCalled()
      saveSpy.mockRestore()

      // Untouched -- the skip means these stay exactly as they were.
      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBeUndefined()
      expect(meta?.conflictFiles).toBeUndefined()
    })

    it('clears stale conflictFiles when branch catches up without new conflicts', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      // Write stale conflict state
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        conflictStatus: 'conflicts-detected',
        conflictFiles: ['staleContentId123'],
      })

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Clean rebase
  // -------------------------------------------------------------------------

  describe('clean rebase', () => {
    it('rebases a behind branch and marks it clean when no conflicts', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      // Branch workspace has a commit of its own
      await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
      // Remote advances with a non-conflicting file
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Branch should now be in sync
      const status = await setup.branchGit.status()
      expect(status.behind).toBe(0)

      // Main's file should be present in the workspace
      const mainContent = await fs.readFile(path.join(setup.branchPath, 'main-update.txt'), 'utf8')
      expect(mainContent).toBe('new from main')

      // Metadata should reflect clean state
      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // canopycms's own state (.canopy-meta/)
  // -------------------------------------------------------------------------

  describe('provisioning lock', () => {
    const behindCount = async (setup: BranchSetup) => {
      await setup.branchGit.fetch('origin', 'main')
      return (await setup.branchGit.status()).behind
    }

    it('skips a branch whose provisioning lock is held elsewhere', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      const release = await tryAcquireProvisioningLock(
        setup.contentBranchesPath,
        branchProvisioningLockName('my-feature'),
      )

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir)).finally(release)
      expect(consoleSpy).toHaveLogged(/Skipping my-feature: provisioning lock held elsewhere/)
      consoleSpy.restore()

      await expect(behindCount(setup)).resolves.toBeGreaterThan(0)
    })

    it('skips a clone that has .git but no branch.json, writing nothing', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir))
      expect(consoleSpy).not.toHaveLogged(/my-feature/)
      consoleSpy.restore()

      await expect(behindCount(setup)).resolves.toBeGreaterThan(0)
      await expect(readMeta(setup.branchPath)).resolves.toBeUndefined()
    })

    it('rebases a provisioned branch and releases the lock afterwards', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      await runRebase(makeWorker(tmpDir))

      await expect(behindCount(setup)).resolves.toBe(0)
      const release = await tryAcquireProvisioningLock(
        setup.contentBranchesPath,
        branchProvisioningLockName('my-feature'),
      )
      await release()
    })
  })

  // Adopter-tracked `.canopy-meta` is inside a content branch's cone, so a sparse clone behaves
  // the same.
  describe.each([
    { clone: 'full', sparseCone: undefined },
    { clone: 'sparse', sparseCone: ['content', '.canopy-meta'] },
  ])("canopycms's own state ($clone clone)", ({ sparseCone }) => {
    const behindCount = async (setup: BranchSetup) => {
      await setup.branchGit.fetch('origin', 'main')
      return (await setup.branchGit.status()).behind
    }

    it('rebases when the only dirt is untracked canopycms state (a clone without the exclude)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', { sparseCone })
      await fs.writeFile(path.join(setup.branchPath, '.git', 'info', 'exclude'), '')
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      const dirt = (await setup.branchGit.status()).files.map((f) => f.path)
      expect(dirt).toEqual(['.canopy-meta/branch.json'])

      await runRebase(makeWorker(tmpDir))

      await expect(behindCount(setup)).resolves.toBe(0)
      await expect(
        fs.readFile(path.join(setup.branchPath, 'main-update.txt'), 'utf8'),
      ).resolves.toBe('new from main')
    })

    it('restores the retired in-tree schema cache a repo tracks, then rebases', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        sparseCone,
        initialFiles: { '.canopy-meta/schema-cache.json': '{"v":"committed"}' },
      })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      const cachePath = path.join(setup.branchPath, '.canopy-meta', 'schema-cache.json')
      await fs.writeFile(cachePath, '{"v":"written by an older canopycms"}')

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir))

      await expect(behindCount(setup)).resolves.toBe(0)
      expect(consoleSpy).toHaveLogged(/my-feature: restored the retired in-tree schema cache/)
      consoleSpy.restore()
      await expect(fs.readFile(cachePath, 'utf8')).resolves.toBe('{"v":"committed"}')
    })

    it('skips, naming the fix, when other tracked canopycms state is modified', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        sparseCone,
        initialFiles: { '.canopy-meta/comments.json': '{"threads":[]}' },
      })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      const commentsPath = path.join(setup.branchPath, '.canopy-meta', 'comments.json')
      await fs.writeFile(commentsPath, '{"threads":["a reviewer comment"]}')

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir))

      expect(consoleSpy).toHaveWarned(
        /Skipping my-feature: git cannot rebase over .*\.canopy-meta\/comments\.json.*git rm -r --cached \.canopy-meta/,
      )
      consoleSpy.restore()
      await expect(behindCount(setup)).resolves.toBeGreaterThan(0)
      // Recorded, so the Branches tab shows the wedge rather than only the log.
      expect((await readMeta(setup.branchPath))?.rebaseFailure?.message).toMatch(
        /git rm -r --cached \.canopy-meta/,
      )
      // The index is untouched: the skip is all or nothing.
      expect(await setup.branchGit.raw(['ls-files', '--', '.canopy-meta'])).toBe(
        '.canopy-meta/comments.json\n',
      )
      // canopycms never discards state it still uses.
      await expect(fs.readFile(commentsPath, 'utf8')).resolves.toBe(
        '{"threads":["a reviewer comment"]}',
      )
    })

    it('names the fix from its own remote.git path when the clone records another origin', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        sparseCone,
        initialFiles: { '.canopy-meta/comments.json': '{"threads":[]}' },
      })
      // The path the cloning process saw, which this process cannot resolve.
      await setup.branchGit.raw([
        'remote',
        'set-url',
        'origin',
        '/nonexistent/other-mount/remote.git',
      ])
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      await fs.writeFile(
        path.join(setup.branchPath, '.canopy-meta', 'comments.json'),
        '{"threads":["a reviewer comment"]}',
      )

      mockConsole()
      await runRebase(makeWorker(tmpDir))

      expect((await readMeta(setup.branchPath))?.rebaseFailure?.message).toMatch(
        /git rm -r --cached \.canopy-meta/,
      )
    })

    it('leaves the index and the bytes alone even after the base branch untracks the state', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        sparseCone,
        initialFiles: { '.canopy-meta/comments.json': '{"threads":[]}' },
      })
      // A pre-fix submit committed the state on the branch; replaying this
      // commit over an untracked live file is what makes auto-untracking unsafe.
      await setup.commitToBranch({ '.canopy-meta/comments.json': '{"threads":["submitted"]}' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      const commentsPath = path.join(setup.branchPath, '.canopy-meta', 'comments.json')
      await fs.writeFile(commentsPath, '{"threads":["live"]}')
      await setup.remoteGit.raw(['rm', '-r', '--cached', '-q', '.canopy-meta'])
      await setup.remoteGit.commit('untrack canopycms state')
      const headBefore = (await setup.branchGit.revparse(['HEAD'])).trim()

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir))

      await expect(fs.readFile(commentsPath, 'utf8')).resolves.toBe('{"threads":["live"]}')
      expect(consoleSpy).toHaveWarned(/base branch no longer does; the clone needs manual repair/)
      consoleSpy.restore()
      expect((await setup.branchGit.revparse(['HEAD'])).trim()).toBe(headBefore)
      expect(await setup.branchGit.raw(['ls-files', '--', '.canopy-meta'])).toBe(
        '.canopy-meta/comments.json\n',
      )
      expect((await readMeta(setup.branchPath))?.rebaseFailure?.message).toMatch(/manual repair/)
    })

    it('still skips real editor dirt when canopycms state is dirty too', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', { sparseCone })
      await fs.writeFile(path.join(setup.branchPath, '.git', 'info', 'exclude'), '')
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      await fs.writeFile(path.join(setup.branchPath, 'unsaved-edit.txt'), 'editor draft')

      const consoleSpy = mockConsole()
      await runRebase(makeWorker(tmpDir))

      expect(consoleSpy).toHaveLogged(/Skipping my-feature: has uncommitted changes/)
      consoleSpy.restore()
      await expect(behindCount(setup)).resolves.toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Conflict handling
  // -------------------------------------------------------------------------

  describe('conflict handling', () => {
    // Filename with embedded ContentId: TESTENTRYabc (12-char Base58)
    const ENTRY_FILE = 'page.about.TESTENTRYabc.json'
    const ENTRY_ID = 'TESTENTRYabc'

    it('applies --theirs for conflicting entry files, keeps branch version, records ContentId', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [ENTRY_FILE]: '{"title":"base content"}' },
      })

      // Branch commits its version of the entry
      await setup.commitToBranch(
        { [ENTRY_FILE]: '{"title":"branch version"}' },
        'branch: update entry',
      )
      // Remote advances with a conflicting version of the same entry
      await setup.pushToRemote(
        { [ENTRY_FILE]: '{"title":"main version"}' },
        'main: update same entry',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Branch should be in sync after rebase
      const status = await setup.branchGit.status()
      expect(status.behind).toBe(0)

      // Branch version should be preserved (--theirs during rebase)
      const fileContent = await fs.readFile(path.join(setup.branchPath, ENTRY_FILE), 'utf8')
      expect(fileContent).toBe('{"title":"branch version"}')

      // Metadata should record the conflict
      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toContain(ENTRY_ID)
    })

    it('excludes non-entry files from conflictFiles (conflictStatus stays clean)', async () => {
      // README.md has no embedded ContentId — should be filtered out
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { 'README.md': '# Base' },
      })

      // Both branch and remote modify README.md (conflict, but no ContentId)
      await setup.commitToBranch({ 'README.md': '# Branch heading' }, 'branch: edit readme')
      await setup.pushToRemote({ 'README.md': '# Main heading' }, 'main: edit readme')

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      // No entry ContentIds were involved, so conflict is invisible to the editor
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
    })

    it('records parent collection ContentId when .collection.json conflicts in a subcollection', async () => {
      // Subcollection directory has an embedded ID: posts.cNbR5xFm2Kpd
      const COLLECTION_DIR = 'content/posts.cNbR5xFm2Kpd'
      const COLLECTION_ID = 'cNbR5xFm2Kpd'
      const META_FILE = `${COLLECTION_DIR}/.collection.json`

      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [META_FILE]: '{"name":"posts","order":[]}' },
      })

      await setup.commitToBranch(
        { [META_FILE]: '{"name":"posts","order":["branch-order"]}' },
        'branch: reorder collection',
      )
      await setup.pushToRemote(
        { [META_FILE]: '{"name":"posts","order":["main-order"]}' },
        'main: reorder collection',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toContain(COLLECTION_ID)
    })

    it('records ROOT_COLLECTION_ID when root .collection.json conflicts', async () => {
      // Root content/.collection.json — parent dir "content" has no embedded ID
      const META_FILE = 'content/.collection.json'

      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [META_FILE]: '{"entries":[]}' },
      })

      await setup.commitToBranch(
        { [META_FILE]: '{"entries":[],"order":["branch"]}' },
        'branch: update root schema',
      )
      await setup.pushToRemote(
        { [META_FILE]: '{"entries":[],"order":["main"]}' },
        'main: update root schema',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toContain(ROOT_COLLECTION_ID)
    })

    it('records ROOT_COLLECTION_ID when root .collection.json conflicts with a multi-segment contentRoot', async () => {
      // contentRoot: 'cms/content' is documented as valid (config/helpers.ts). The
      // root .collection.json's parent directory basename is "content", which must
      // NOT be compared against the full configured value "cms/content" -- that
      // comparison is always false and is exactly the bug this test guards against
      // (see cms-worker.ts's normalizedContentRoot comment).
      const META_FILE = 'cms/content/.collection.json'

      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [META_FILE]: '{"entries":[]}' },
      })

      await setup.commitToBranch(
        { [META_FILE]: '{"entries":[],"order":["branch"]}' },
        'branch: update root schema',
      )
      await setup.pushToRemote(
        { [META_FILE]: '{"entries":[],"order":["main"]}' },
        'main: update root schema',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir, 'main', 'cms/content')
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toContain(ROOT_COLLECTION_ID)
    })

    it('filters out .collection.json that is neither in the content root nor an ID-bearing collection dir', async () => {
      // "docs" carries no embedded ContentId (extractIdFromFilename -> null) AND is
      // not the configured content root ("content") -- the fix must not start
      // misclassifying every unrecognized .collection.json as the root collection.
      const META_FILE = 'content/docs/.collection.json'

      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [META_FILE]: '{"name":"docs","order":[]}' },
      })

      await setup.commitToBranch(
        { [META_FILE]: '{"name":"docs","order":["branch"]}' },
        'branch: reorder docs',
      )
      await setup.pushToRemote(
        { [META_FILE]: '{"name":"docs","order":["main"]}' },
        'main: reorder docs',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      // No entry ContentIds, no root-collection match -- conflict is invisible to
      // the editor, same as the pre-existing "excludes non-entry files" case.
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
    })

    it('records both entry and collection ContentIds for mixed conflicts', async () => {
      const COLLECTION_DIR = 'content/posts.cNbR5xFm2Kpd'
      const COLLECTION_ID = 'cNbR5xFm2Kpd'
      const META_FILE = `${COLLECTION_DIR}/.collection.json`
      const ENTRY_FILE = `${COLLECTION_DIR}/page.about.TESTENTRYabc.json`

      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: {
          [META_FILE]: '{"name":"posts","order":[]}',
          [ENTRY_FILE]: '{"title":"base"}',
        },
      })

      await setup.commitToBranch(
        {
          [META_FILE]: '{"name":"posts","order":["branch"]}',
          [ENTRY_FILE]: '{"title":"branch version"}',
        },
        'branch: update both',
      )
      await setup.pushToRemote(
        {
          [META_FILE]: '{"name":"posts","order":["main"]}',
          [ENTRY_FILE]: '{"title":"main version"}',
        },
        'main: update both',
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toContain(COLLECTION_ID)
      expect(meta?.conflictFiles).toContain('TESTENTRYabc')
    })

    it('resolves conflicts on paths outside the cone of a sparse clone, keeping the branch side', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: {
          'content/a.md': 'a',
          'src/both.ts': 'base',
          'src/branch-deletes.ts': 'base',
          'src/main-deletes.ts': 'base',
        },
        sparseCone: ['content', '.canopy-meta'],
      })
      await setup.commitToBranch({ 'src/both.ts': 'branch', 'src/main-deletes.ts': 'branch' })
      await setup.branchGit.raw(['rm', '-q', '--sparse', '--', 'src/branch-deletes.ts'])
      await setup.branchGit.commit('branch: delete')
      await setup.pushToRemote({ 'src/both.ts': 'main', 'src/branch-deletes.ts': 'main' })
      await setup.remoteGit.rm(['src/main-deletes.ts'])
      await setup.remoteGit.commit('main: delete')
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      await runRebase(makeWorker(tmpDir))

      const meta = await readMeta(setup.branchPath)
      expect(meta?.rebaseFailure).toBeUndefined()
      expect((await setup.branchGit.status()).behind).toBe(0)
      const tree = (await setup.branchGit.raw(['ls-tree', '-r', '--name-only', 'HEAD']))
        .trim()
        .split('\n')
      expect(tree).toEqual(['content/a.md', 'src/both.ts', 'src/main-deletes.ts'])
      expect(await setup.branchGit.show(['HEAD:src/both.ts'])).toBe('branch')
    })
  })

  // -------------------------------------------------------------------------
  // rebaseFailure recording (PR-W2)
  // -------------------------------------------------------------------------

  describe('rebaseFailure recording', () => {
    /**
     * Installs a pre-rebase hook that always refuses the rebase before it
     * starts. This drives the round loop's "unexpected error" branch for
     * real (not a conflict -- st.conflicted stays empty since the rebase
     * never begins -- and not the "nothing to commit"/"apply --skip" empty-
     * commit message), without mocking simple-git internals.
     */
    const installRefusingPreRebaseHook = async (branchPath: string) => {
      const hookPath = path.join(branchPath, '.git', 'hooks', 'pre-rebase')
      await fs.writeFile(hookPath, '#!/bin/sh\necho "blocked by test hook" >&2\nexit 1\n')
      await fs.chmod(hookPath, 0o755)
    }

    const readRawBranchJson = async (branchPath: string): Promise<Record<string, unknown>> => {
      const raw = await fs.readFile(path.join(branchPath, '.canopy-meta', 'branch.json'), 'utf8')
      return JSON.parse(raw) as Record<string, unknown>
    }

    it('records a rebaseFailure when the round loop hits an unexpected (non-conflict) error', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      await installRefusingPreRebaseHook(setup.branchPath)

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(typeof meta?.rebaseFailure?.message).toBe('string')
      expect(meta?.rebaseFailure?.message.length).toBeGreaterThan(0)
      expect(typeof meta?.rebaseFailure?.firstAt).toBe('string')
      expect(typeof meta?.rebaseFailure?.lastAt).toBe('string')

      // The rebase never completed, so the branch stays behind.
      await setup.branchGit.fetch('origin', 'main')
      const status = await setup.branchGit.status()
      expect(status.behind).toBeGreaterThan(0)
    })

    it('clears a lingering rebaseFailure after a subsequent successful rebase', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        rebaseFailure: {
          message: 'boom',
          firstAt: '2024-01-01T00:00:00.000Z',
          lastAt: '2024-01-01T00:00:00.000Z',
        },
      })

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Read the raw file, not just the parsed metadata -- this pins the
      // save() merge semantics (explicit `undefined` overwrites the
      // existing key, and JSON.stringify then drops it) rather than just
      // asserting the parsed value happens to be undefined.
      const raw = await readRawBranchJson(setup.branchPath)
      const branch = raw.branch as Record<string, unknown>
      expect('rebaseFailure' in branch).toBe(false)
    })

    it('clears a lingering rebaseFailure when the branch is already up to date and clean', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        conflictStatus: 'clean',
        conflictFiles: [],
        rebaseFailure: {
          message: 'boom',
          firstAt: '2024-01-01T00:00:00.000Z',
          lastAt: '2024-01-01T00:00:00.000Z',
        },
      })

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const raw = await readRawBranchJson(setup.branchPath)
      const branch = raw.branch as Record<string, unknown>
      expect('rebaseFailure' in branch).toBe(false)
    })

    it('still skips the save when up to date, clean, and with no rebaseFailure (no-op guard unaffected)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        conflictStatus: 'clean',
        conflictFiles: [],
      })

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      const worker = makeWorker(tmpDir)
      await runRebase(worker)
      expect(saveSpy).not.toHaveBeenCalled()
      saveSpy.mockRestore()
    })

    it('does not re-save an identical failure within the 1h refresh window (write-amplification guard)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      await installRefusingPreRebaseHook(setup.branchPath)

      const worker = makeWorker(tmpDir)
      await runRebase(worker) // first cycle: records the failure

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      await runRebase(worker) // second cycle: same failure, well within 1h
      expect(saveSpy).not.toHaveBeenCalled()
      saveSpy.mockRestore()
    })

    it('preserves firstAt but refreshes lastAt when the same failure recurs after the 1h window', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.commitToBranch({ 'branch-content.txt': 'branch work' })
      await setup.pushToRemote({ 'main-update.txt': 'new from main' })
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})
      await installRefusingPreRebaseHook(setup.branchPath)

      const worker = makeWorker(tmpDir)
      await runRebase(worker) // first cycle: records the real failure message

      const firstMeta = await readMeta(setup.branchPath)
      const message = firstMeta?.rebaseFailure?.message
      expect(message).toBeTruthy()

      // Back-date the record so the next cycle's failure looks stale (>1h).
      const staleFirstAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      const staleLastAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {
        rebaseFailure: { message, firstAt: staleFirstAt, lastAt: staleLastAt },
      })

      await runRebase(worker) // second cycle: same failure, but stale lastAt

      const secondMeta = await readMeta(setup.branchPath)
      expect(secondMeta?.rebaseFailure?.message).toBe(message)
      expect(secondMeta?.rebaseFailure?.firstAt).toBe(staleFirstAt)
      expect(secondMeta?.rebaseFailure?.lastAt).not.toBe(staleLastAt)
    })

    it('does not throw and skips recording when branch.json is corrupt (guarded-load path)', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      await setup.pushToRemote({ 'new-file.txt': 'from main' })

      const metaDir = path.join(setup.branchPath, '.canopy-meta')
      await fs.mkdir(metaDir, { recursive: true })
      await fs.writeFile(path.join(metaDir, 'branch.json'), '{ not valid json')

      const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
      const worker = makeWorker(tmpDir)

      await runRebase(worker) // must complete without throwing

      expect(saveSpy).not.toHaveBeenCalled()
      saveSpy.mockRestore()
    })
  })
})
