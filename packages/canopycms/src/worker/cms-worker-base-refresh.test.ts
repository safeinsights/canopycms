/**
 * Tests for CmsWorker.refreshBaseBranchWorkspace() (Gap 2: the base-branch
 * working-tree clone at content-branches/<base> is never explicitly kept in
 * sync with origin/<base> -- it's provisioned once on demand and then just
 * sits there while later content PRs merge on GitHub).
 *
 * Uses real git operations against temp directories, mirroring
 * cms-worker-rebase.test.ts's style: a local "remote" repo, and here the
 * branch-workspace clone is checked out AS the base branch itself (unlike
 * the rebase tests, which check out a distinct feature branch).
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { readContentIndexGeneration } from '../content-index-generation'
import type { ContentId } from '../paths/types'
import { initTestRepo, mockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeWorker = (workspacePath: string, baseBranch = 'main') =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch,
  })

/** Invoke the private refreshBaseBranchWorkspace() method. */
const refreshBase = (worker: CmsWorker): Promise<void> =>
  (
    worker as unknown as { refreshBaseBranchWorkspace(): Promise<void> }
  ).refreshBaseBranchWorkspace()

interface BaseWorkspaceSetup {
  basePath: string
  contentBranchesPath: string
  remotePath: string
  baseGit: SimpleGit
  /** Add a commit to the origin remote (makes the base workspace "behind"). */
  pushToRemote: (files: Record<string, string>, message?: string) => Promise<void>
}

/**
 * Creates a local git setup where content-branches/<baseBranch> is a clone
 * checked out AS the base branch itself (not a distinct feature branch) --
 * matching what Lambda provisions for the base branch's own workspace.
 */
async function createBaseWorkspaceSetup(
  tmpDir: string,
  opts: { baseBranch?: string; initialFiles?: Record<string, string> } = {},
): Promise<BaseWorkspaceSetup> {
  const { baseBranch = 'main', initialFiles = { '.gitkeep': '' } } = opts

  const remotePath = path.join(tmpDir, 'remote')
  const contentBranchesPath = path.join(tmpDir, 'content-branches')
  const basePath = path.join(contentBranchesPath, baseBranch)

  await fs.mkdir(remotePath, { recursive: true })
  const remoteGit = await initTestRepo(remotePath)
  await remoteGit.raw(['branch', '-M', baseBranch])
  for (const [name, content] of Object.entries(initialFiles)) {
    const fullPath = path.join(remotePath, name)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  await remoteGit.add(['.'])
  await remoteGit.commit('initial commit')

  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remotePath, basePath, ['--branch', baseBranch])

  // allowUnsafeEditor: simple-git >=3.32 blocks setting core.editor without opt-in;
  // mirrors the production CmsWorker git config (hardcoded literal, no user input).
  const baseGit = simpleGit({ baseDir: basePath, unsafe: { allowUnsafeEditor: true } })
  await baseGit.addConfig('user.name', 'Test Bot')
  await baseGit.addConfig('user.email', 'test@canopycms.test')
  await baseGit.addConfig('core.editor', 'true')

  // Exclude .canopy-meta/ from git tracking (matches production ensureGitExclude)
  const excludeFile = path.join(basePath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')

  const pushToRemote = async (files: Record<string, string>, message = 'remote commit') => {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(remotePath, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }
    await remoteGit.add(['.'])
    await remoteGit.commit(message)
  }

  return { basePath, contentBranchesPath, remotePath, baseGit, pushToRemote }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CmsWorker.refreshBaseBranchWorkspace()', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-base-refresh-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('skips quietly when the base branch workspace has not been provisioned yet', async () => {
    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)

    await expect(refreshBase(worker)).resolves.toBeUndefined()

    expect(consoleSpy).toHaveLogged(/not yet provisioned/)
    consoleSpy.restore()
  })

  it('logs loudly and skips the refresh when the base workspace has uncommitted changes', async () => {
    const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
    await pushToRemote({ 'remote-update.txt': 'from origin' })
    await fs.writeFile(path.join(basePath, 'dirty.txt'), 'uncommitted editor draft')

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    expect(consoleSpy).toHaveErrored(/uncommitted changes/i)
    consoleSpy.restore()

    // Dirty file untouched, remote content never fetched/merged in.
    await expect(fs.readFile(path.join(basePath, 'dirty.txt'), 'utf8')).resolves.toBe(
      'uncommitted editor draft',
    )
    await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()
  })

  it('fast-forwards when behind and invalidates the content-index cache', async () => {
    const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
    await pushToRemote({ 'new-content.txt': 'fresh from a merged PR' })

    const beforeToken = await readContentIndexGeneration(basePath)

    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    const content = await fs.readFile(path.join(basePath, 'new-content.txt'), 'utf8')
    expect(content).toBe('fresh from a merged PR')

    const afterToken = await readContentIndexGeneration(basePath)
    expect(afterToken).not.toBeNull()
    expect(afterToken).not.toBe(beforeToken)
  })

  it('is a no-op when already up to date', async () => {
    await createBaseWorkspaceSetup(tmpDir)

    const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    expect(saveSpy).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveLogged(/up to date/)
    consoleSpy.restore()
    saveSpy.mockRestore()
  })

  it('does not fast-forward on diverged local history and leaves the local commit as HEAD', async () => {
    const { basePath, baseGit, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)

    // Local commit not on origin -- should never happen in production
    // (nothing else writes to this clone), simulated here directly.
    await fs.writeFile(path.join(basePath, 'local-only.txt'), 'local commit')
    await baseGit.add(['.'])
    await baseGit.commit('local: unexpected local commit')
    const localHeadBefore = (await baseGit.revparse(['HEAD'])).trim()

    // Remote advances independently, so origin/main is not an ancestor of HEAD.
    await pushToRemote({ 'remote-update.txt': 'remote work' })

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    expect(consoleSpy).toHaveErrored(/failed to fast-forward/i)
    consoleSpy.restore()

    const localHeadAfter = (await baseGit.revparse(['HEAD'])).trim()
    expect(localHeadAfter).toBe(localHeadBefore)
    await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()
  })

  it('clears stale conflictStatus/conflictFiles on the base branch metadata', async () => {
    const { basePath, contentBranchesPath } = await createBaseWorkspaceSetup(tmpDir)
    const meta = getBranchMetadataFileManager(basePath, contentBranchesPath)
    await meta.save({
      branch: {
        name: 'main',
        conflictStatus: 'conflicts-detected',
        conflictFiles: ['staleContentId' as ContentId],
      },
    })

    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    const after = await BranchMetadataFileManager.loadOnly(basePath)
    expect(after?.branch.conflictStatus).toBe('clean')
    expect(after?.branch.conflictFiles).toEqual([])
  })

  it('does not save metadata when already up to date and conflict state is already clean', async () => {
    const { basePath, contentBranchesPath } = await createBaseWorkspaceSetup(tmpDir)
    const meta = getBranchMetadataFileManager(basePath, contentBranchesPath)
    await meta.save({ branch: { name: 'main', conflictStatus: 'clean', conflictFiles: [] } })

    const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    expect(saveSpy).not.toHaveBeenCalled()
    saveSpy.mockRestore()
  })
})
