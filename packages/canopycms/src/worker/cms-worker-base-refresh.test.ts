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
import type { BaseRefreshReport } from '../types'
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
const refreshBase = (worker: CmsWorker): Promise<BaseRefreshReport> =>
  (
    worker as unknown as { refreshBaseBranchWorkspace(): Promise<BaseRefreshReport> }
  ).refreshBaseBranchWorkspace()

interface BaseWorkspaceSetup {
  basePath: string
  contentBranchesPath: string
  remotePath: string
  remoteGit: SimpleGit
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
  opts: {
    baseBranch?: string
    initialFiles?: Record<string, string>
    /** Leave .git/info/exclude without `.canopy-meta/`, as an older clone has it. */
    skipExclude?: boolean
  } = {},
): Promise<BaseWorkspaceSetup> {
  const { baseBranch = 'main', initialFiles = { '.gitkeep': '' }, skipExclude = false } = opts

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
  if (!skipExclude) {
    const excludeFile = path.join(basePath, '.git', 'info', 'exclude')
    await fs.mkdir(path.dirname(excludeFile), { recursive: true })
    await fs.appendFile(excludeFile, '\n.canopy-meta/\n')
  }

  const pushToRemote = async (files: Record<string, string>, message = 'remote commit') => {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(remotePath, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }
    await remoteGit.add(['.'])
    await remoteGit.commit(message)
  }

  return { basePath, contentBranchesPath, remotePath, remoteGit, baseGit, pushToRemote }
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

    await expect(refreshBase(worker)).resolves.toEqual({ outcome: 'skipped-not-provisioned' })

    expect(consoleSpy).toHaveLogged(/not yet provisioned/)
    consoleSpy.restore()
  })

  it('logs loudly and skips the refresh when the base workspace has uncommitted tracked changes', async () => {
    const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir, {
      initialFiles: { 'tracked.txt': 'original' },
    })
    await pushToRemote({ 'remote-update.txt': 'from origin' })
    // Modify a TRACKED file — untracked files no longer block (see next test)
    await fs.writeFile(path.join(basePath, 'tracked.txt'), 'uncommitted editor draft')

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    const report = await refreshBase(worker)

    expect(consoleSpy).toHaveErrored(/uncommitted changes/i)
    consoleSpy.restore()
    expect(report).toMatchObject({ outcome: 'skipped-dirty', dirtyFiles: ['tracked.txt'] })

    // Dirty file untouched, remote content never fetched/merged in.
    await expect(fs.readFile(path.join(basePath, 'tracked.txt'), 'utf8')).resolves.toBe(
      'uncommitted editor draft',
    )
    await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()
  })

  it('still fast-forwards when only untracked files are present (no silent wedge)', async () => {
    // A stray untracked file (e.g. runtime metadata missing from
    // .git/info/exclude) must not block the refresh forever — only tracked
    // changes indicate content that a fast-forward could interact with.
    const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
    await pushToRemote({ 'remote-update.txt': 'from origin' })
    await fs.writeFile(path.join(basePath, 'stray-untracked.txt'), 'runtime artifact')

    const worker = makeWorker(tmpDir)
    await refreshBase(worker)

    // Refresh proceeded: remote content arrived, untracked file untouched.
    await expect(fs.readFile(path.join(basePath, 'remote-update.txt'), 'utf8')).resolves.toBe(
      'from origin',
    )
    await expect(fs.readFile(path.join(basePath, 'stray-untracked.txt'), 'utf8')).resolves.toBe(
      'runtime artifact',
    )
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

  it('is non-fatal when the fetch fails, leaving the working tree untouched', async () => {
    const { basePath } = await createBaseWorkspaceSetup(tmpDir)
    // Break the clone's origin so fetch() fails.
    const basePathGit = simpleGit({ baseDir: basePath, unsafe: { allowUnsafeEditor: true } })
    await basePathGit.raw(['remote', 'set-url', 'origin', '/nonexistent/path'])

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)

    await expect(refreshBase(worker)).resolves.toMatchObject({
      outcome: 'failed',
      message: expect.stringMatching(/does not appear to be a git repository/),
    })

    // Caught by refreshBaseBranchWorkspace's outer try/catch and logged.
    expect(consoleSpy).toHaveErrored(/refresh failed/i)
    consoleSpy.restore()

    // Working tree untouched -- only the original .gitkeep is present.
    await expect(fs.readdir(basePath)).resolves.toContain('.gitkeep')
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
  describe("canopycms's own state", () => {
    it('fast-forwards despite a modified tracked .canopy-meta file, and reports the tracking', async () => {
      const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir, {
        initialFiles: { '.canopy-meta/comments.json': '{"committed":true}' },
      })
      await pushToRemote({ 'remote-update.txt': 'from origin' })
      await fs.writeFile(path.join(basePath, '.canopy-meta', 'comments.json'), '{"local":true}')

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))

      await expect(fs.readFile(path.join(basePath, 'remote-update.txt'), 'utf8')).resolves.toBe(
        'from origin',
      )
      expect(report).toEqual({
        outcome: 'refreshed',
        trackedCanopyMeta: ['.canopy-meta/comments.json'],
      })
      expect(consoleSpy).toHaveWarned(/tracks canopycms state.*git rm -r --cached \.canopy-meta/)
      consoleSpy.restore()
      // canopycms's own state survives the fast-forward.
      await expect(
        fs.readFile(path.join(basePath, '.canopy-meta', 'comments.json'), 'utf8'),
      ).resolves.toBe('{"local":true}')
    })

    it('warns about tracked state once per process, but reports it every cycle', async () => {
      await createBaseWorkspaceSetup(tmpDir, {
        initialFiles: { '.canopy-meta/comments.json': '{}' },
      })
      const worker = makeWorker(tmpDir)

      const consoleSpy = mockConsole()
      const first = await refreshBase(worker)
      const second = await refreshBase(worker)

      expect(consoleSpy.all().warn.filter((m) => /tracks canopycms state/.test(m))).toHaveLength(1)
      consoleSpy.restore()
      expect(first.trackedCanopyMeta).toEqual(['.canopy-meta/comments.json'])
      expect(second.trackedCanopyMeta).toEqual(['.canopy-meta/comments.json'])
    })

    it("restores the retired in-tree schema cache, so the adopter's untracking commit fast-forwards", async () => {
      const { basePath, remoteGit } = await createBaseWorkspaceSetup(tmpDir, {
        initialFiles: { 'content/a.md': 'a', '.canopy-meta/schema-cache.json': '{"v":"old"}' },
      })
      // What a pre-move canopycms left behind in the clone.
      await fs.writeFile(path.join(basePath, '.canopy-meta', 'schema-cache.json'), '{"v":"local"}')
      // The adopter's fix lands upstream.
      await remoteGit.raw(['rm', '-r', '--cached', '.canopy-meta'])
      await remoteGit.commit('untrack canopycms state')

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))

      const tracked = await simpleGit({ baseDir: basePath }).raw(['ls-files', '--', '.canopy-meta'])
      expect(tracked).toBe('')
      expect(report.outcome).toBe('refreshed')
      expect(consoleSpy).toHaveLogged(/restored the retired in-tree schema cache/)
      consoleSpy.restore()
    })

    it("fast-forwards past the adopter's untracking commit without touching live state", async () => {
      const { basePath, remoteGit } = await createBaseWorkspaceSetup(tmpDir, {
        initialFiles: { 'content/a.md': 'a', '.canopy-meta/comments.json': '{"threads":[]}' },
      })
      const commentsPath = path.join(basePath, '.canopy-meta', 'comments.json')
      await fs.writeFile(commentsPath, '{"threads":["live"]}')
      await remoteGit.raw(['rm', '-r', '--cached', '-q', '.canopy-meta'])
      await remoteGit.commit('untrack canopycms state')

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))
      expect(consoleSpy).toHaveLogged(
        /stopped tracking \.canopy-meta\/comments\.json, as upstream has/,
      )
      consoleSpy.restore()

      expect(report).toEqual({ outcome: 'refreshed' })
      await expect(fs.readFile(commentsPath, 'utf8')).resolves.toBe('{"threads":["live"]}')
      expect(await simpleGit({ baseDir: basePath }).raw(['ls-files', '--', '.canopy-meta'])).toBe(
        '',
      )
    })

    it('re-applies the .canopy-meta/ exclude to a clone that predates it', async () => {
      const { basePath } = await createBaseWorkspaceSetup(tmpDir, { skipExclude: true })

      await refreshBase(makeWorker(tmpDir))

      const exclude = await fs.readFile(path.join(basePath, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude.split('\n')).toContain('.canopy-meta/')
    })

    it('caps the reported dirty files but counts them all in the message', async () => {
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`content/f${i}.md`, 'x']),
      )
      const { basePath } = await createBaseWorkspaceSetup(tmpDir, { initialFiles: files })
      for (const name of Object.keys(files)) {
        await fs.writeFile(path.join(basePath, name), 'edited')
      }

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))
      expect(consoleSpy).toHaveErrored(/uncommitted changes/)
      consoleSpy.restore()

      expect(report.outcome).toBe('skipped-dirty')
      expect(report.dirtyFiles).toHaveLength(10)
      expect(report.message).toMatch(/^12 uncommitted/)
    })
  })
})
