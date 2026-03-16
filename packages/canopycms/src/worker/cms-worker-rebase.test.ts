/**
 * Tests for CmsWorker.rebaseActiveBranches()
 *
 * Uses real git operations against temp directories to verify:
 * - Branches in review (submitted/approved) are not rebased
 * - Branches with uncommitted changes (dirty working tree) are not rebased
 * - Already-in-sync branches get their stale conflict state cleared
 * - Clean rebases mark the branch as clean
 * - Conflicting files get --ours applied, ContentIds recorded in conflictFiles
 * - Non-entry files (no embedded ContentId) are excluded from conflictFiles
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { initTestRepo } from '../test-utils'
import { CmsWorker } from './cms-worker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instantiate a CmsWorker with minimal config for testing rebase logic only. */
const makeWorker = (workspacePath: string, baseBranch = 'main') =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch,
  })

/** Invoke the private rebaseActiveBranches() method. */
const runRebase = (worker: CmsWorker): Promise<void> =>
  (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()

/** Write branch metadata for a workspace. */
const writeMeta = async (
  branchPath: string,
  contentBranchesPath: string,
  data: Record<string, unknown>
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
  opts: { baseBranch?: string; initialFiles?: Record<string, string> } = {}
): Promise<BranchSetup> {
  const { baseBranch = 'main', initialFiles = { '.gitkeep': '' } } = opts

  const remotePath = path.join(tmpDir, 'remote')
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

  const branchGit = simpleGit({ baseDir: branchPath })
  await branchGit.addConfig('user.name', 'Test Bot')
  await branchGit.addConfig('user.email', 'test@canopycms.test')
  // Prevent interactive editor prompts during `rebase --continue`
  await branchGit.addConfig('core.editor', 'true')

  // Exclude .canopy-meta/ from git tracking (matches production setup via ensureGitExclude)
  const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')

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
    await branchGit.add(['.'])
    await branchGit.commit(message)
  }

  return { branchPath, contentBranchesPath, branchGit, pushToRemote, commitToBranch }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CmsWorker rebaseActiveBranches', () => {
  let tmpDir: string

  beforeEach(async () => {
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
        fs.readFile(path.join(setup.branchPath, 'unsaved-edit.txt'), 'utf8')
      ).resolves.toBe('editor draft')

      // Branch still behind (no rebase happened)
      await setup.branchGit.fetch('origin', 'main')
      const status = await setup.branchGit.status()
      expect(status.behind).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Already in sync
  // -------------------------------------------------------------------------

  describe('already in sync', () => {
    it('marks conflictStatus clean when branch is already up to date', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature')
      // No new commits pushed to remote: branch is already in sync
      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
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
      const mainContent = await fs.readFile(
        path.join(setup.branchPath, 'main-update.txt'),
        'utf8'
      )
      expect(mainContent).toBe('new from main')

      // Metadata should reflect clean state
      const meta = await readMeta(setup.branchPath)
      expect(meta?.conflictStatus).toBe('clean')
      expect(meta?.conflictFiles).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Conflict handling
  // -------------------------------------------------------------------------

  describe('conflict handling', () => {
    // Filename with embedded ContentId: TESTENTRYabc (12-char Base58)
    const ENTRY_FILE = 'page.about.TESTENTRYabc.json'
    const ENTRY_ID = 'TESTENTRYabc'

    it('applies --ours for conflicting entry files, keeps branch version, records ContentId', async () => {
      const setup = await createBranchSetup(tmpDir, 'my-feature', {
        initialFiles: { [ENTRY_FILE]: '{"title":"base content"}' },
      })

      // Branch commits its version of the entry
      await setup.commitToBranch(
        { [ENTRY_FILE]: '{"title":"branch version"}' },
        'branch: update entry'
      )
      // Remote advances with a conflicting version of the same entry
      await setup.pushToRemote(
        { [ENTRY_FILE]: '{"title":"main version"}' },
        'main: update same entry'
      )

      await writeMeta(setup.branchPath, setup.contentBranchesPath, {})

      const worker = makeWorker(tmpDir)
      await runRebase(worker)

      // Branch should be in sync after rebase
      const status = await setup.branchGit.status()
      expect(status.behind).toBe(0)

      // Branch version should be preserved (--ours)
      const fileContent = await fs.readFile(
        path.join(setup.branchPath, ENTRY_FILE),
        'utf8'
      )
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
  })
})
