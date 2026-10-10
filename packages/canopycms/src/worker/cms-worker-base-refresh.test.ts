/**
 * Tests for CmsWorker.refreshBaseBranchWorkspace() (Gap 2: the base-branch
 * working-tree clone at content-branches/<base> is never explicitly kept in
 * sync with remote.git's <base> -- it's provisioned once on demand and then just
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
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
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
  /** The bare `remote.git` the worker fetches from. */
  remotePath: string
  /** The working repository commits are made in before they are pushed to `remotePath`. */
  remoteGit: SimpleGit
  baseGit: SimpleGit
  /** Push the working repository's base branch into the bare `remote.git`. */
  publishRemote: () => Promise<void>
  /** Add a commit to the origin remote (makes the base workspace "behind"). */
  pushToRemote: (files: Record<string, string>, message?: string) => Promise<void>
}

/**
 * Creates a local git setup where content-branches/<baseBranch> is a clone
 * checked out AS the base branch itself (not a distinct feature branch) --
 * matching what Lambda provisions for the base branch's own workspace. `remote.git`
 * is bare, as in production; commits are made in a sibling working repository and
 * pushed into it.
 */
async function createBaseWorkspaceSetup(
  tmpDir: string,
  opts: {
    baseBranch?: string
    initialFiles?: Record<string, string>
    /** Leave .git/info/exclude without `.canopy-meta/`, as an older clone has it. */
    skipExclude?: boolean
    /** Make the clone sparse with this cone, as content-branch provisioning does. */
    sparseCone?: string[]
  } = {},
): Promise<BaseWorkspaceSetup> {
  const {
    baseBranch = 'main',
    initialFiles = { '.gitkeep': '' },
    skipExclude = false,
    sparseCone,
  } = opts

  const remotePath = path.join(tmpDir, 'remote.git')
  const upstreamPath = path.join(tmpDir, 'upstream')
  const contentBranchesPath = path.join(tmpDir, 'content-branches')
  const basePath = path.join(contentBranchesPath, baseBranch)

  await fs.mkdir(upstreamPath, { recursive: true })
  const remoteGit = await initTestRepo(upstreamPath)
  await remoteGit.raw(['branch', '-M', baseBranch])
  const publishRemote = async () => {
    await remoteGit.raw(['push', '-q', '--force', remotePath, `${baseBranch}:${baseBranch}`])
  }
  for (const [name, content] of Object.entries(initialFiles)) {
    const fullPath = path.join(upstreamPath, name)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  await remoteGit.add(['.'])
  await remoteGit.commit('initial commit')
  await simpleGit().raw(['init', '--bare', '--initial-branch', baseBranch, remotePath])
  await publishRemote()

  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remotePath, basePath, ['--branch', baseBranch])

  // allowUnsafeEditor: simple-git >=3.32 blocks setting core.editor without opt-in;
  // mirrors the production CmsWorker git config (hardcoded literal, no user input).
  const baseGit = simpleGit({ baseDir: basePath, unsafe: { allowUnsafeEditor: true } })
  await baseGit.addConfig('user.name', 'Test Bot')
  await baseGit.addConfig('user.email', 'test@canopycms.test')
  if (sparseCone) await baseGit.raw(['sparse-checkout', 'set', '--cone', '--', ...sparseCone])

  // Exclude .canopy-meta/ from git tracking (matches production ensureGitExclude)
  if (!skipExclude) {
    const excludeFile = path.join(basePath, '.git', 'info', 'exclude')
    await fs.mkdir(path.dirname(excludeFile), { recursive: true })
    await fs.appendFile(excludeFile, '\n.canopy-meta/\n')
  }

  // A provisioned workspace has branch metadata; the worker skips one without it.
  await getBranchMetadataFileManager(basePath, contentBranchesPath).save({
    branch: { name: baseBranch },
  })

  const pushToRemote = async (files: Record<string, string>, message = 'remote commit') => {
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(upstreamPath, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }
    await remoteGit.add(['.'])
    await remoteGit.commit(message)
    await publishRemote()
  }

  return {
    basePath,
    contentBranchesPath,
    remotePath,
    remoteGit,
    baseGit,
    publishRemote,
    pushToRemote,
  }
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

  it('fast-forwards a sparse clone, bringing in-cone changes and leaving the rest out', async () => {
    const { basePath, baseGit, pushToRemote } = await createBaseWorkspaceSetup(tmpDir, {
      initialFiles: { 'content/a.md': 'a', 'src/app.ts': 'app' },
      sparseCone: ['content', '.canopy-meta'],
    })
    await pushToRemote({ 'content/b.md': 'b', 'permissions.json': '{}', 'src/app.ts': 'app v2' })

    const report = await refreshBase(makeWorker(tmpDir))

    expect(report.outcome).toBe('refreshed')
    expect((await baseGit.status()).isClean()).toBe(true)
    await expect(fs.readFile(path.join(basePath, 'content/b.md'), 'utf8')).resolves.toBe('b')
    await expect(fs.readFile(path.join(basePath, 'permissions.json'), 'utf8')).resolves.toBe('{}')
    await expect(fs.stat(path.join(basePath, 'src'))).rejects.toThrow()
    expect(await baseGit.show(['HEAD:src/app.ts'])).toBe('app v2')
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

    // Remote advances independently, so its main is not an ancestor of HEAD.
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

  it('fetches from its own remote.git path even when the clone records another origin', async () => {
    const { basePath, baseGit, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
    // The path the cloning process saw, which this process cannot resolve.
    await baseGit.raw(['remote', 'set-url', 'origin', '/nonexistent/other-mount/remote.git'])
    await pushToRemote({ 'remote-update.txt': 'from origin' })

    mockConsole()
    await expect(refreshBase(makeWorker(tmpDir))).resolves.toMatchObject({ outcome: 'refreshed' })
    await expect(fs.readFile(path.join(basePath, 'remote-update.txt'), 'utf-8')).resolves.toBe(
      'from origin',
    )
  })

  it('is non-fatal when the fetch fails, leaving the working tree untouched', async () => {
    const { basePath, remotePath } = await createBaseWorkspaceSetup(tmpDir)
    await fs.rename(remotePath, `${remotePath}.moved`)

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
  describe('provisioning lock', () => {
    it('skips and reports skipped-locked while another holder has the lock', async () => {
      const { basePath, contentBranchesPath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
      await pushToRemote({ 'remote-update.txt': 'from origin' })
      const release = await tryAcquireProvisioningLock(
        contentBranchesPath,
        branchProvisioningLockName('main'),
      )

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir)).finally(release)
      expect(consoleSpy).toHaveLogged(/provisioning lock held elsewhere/)
      consoleSpy.restore()

      expect(report).toEqual({ outcome: 'skipped-locked' })
      await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()
    })

    it('treats a clone without branch.json as not provisioned', async () => {
      const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
      await pushToRemote({ 'remote-update.txt': 'from origin' })
      await fs.rm(path.join(basePath, '.canopy-meta', 'branch.json'))

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))
      expect(consoleSpy).toHaveLogged(/not yet provisioned/)
      consoleSpy.restore()

      expect(report).toEqual({ outcome: 'skipped-not-provisioned' })
      await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()
    })

    it('releases the lock once the refresh is done', async () => {
      const { contentBranchesPath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
      await pushToRemote({ 'remote-update.txt': 'from origin' })

      expect((await refreshBase(makeWorker(tmpDir))).outcome).toBe('refreshed')

      const release = await tryAcquireProvisioningLock(
        contentBranchesPath,
        branchProvisioningLockName('main'),
      )
      await release()
    })
  })

  // [SYNC-C1] In dev the base branch is writable, so its fast-forward must not
  // race an editor save into the same tree.
  describe('content-write lock', () => {
    it('skips and reports skipped-locked while a content write holds the lock, then refreshes', async () => {
      const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir)
      await pushToRemote({ 'remote-update.txt': 'from origin' })
      const release = await tryAcquireContentWriteLock(basePath)

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir)).finally(release)
      expect(consoleSpy).toHaveLogged(/content write in progress/)

      expect(report).toEqual({ outcome: 'skipped-locked' })
      await expect(fs.stat(path.join(basePath, 'remote-update.txt'))).rejects.toThrow()

      expect((await refreshBase(makeWorker(tmpDir))).outcome).toBe('refreshed')
      consoleSpy.restore()
      // Released afterwards.
      const again = await tryAcquireContentWriteLock(basePath)
      await again()
    })
  })

  // Adopter-tracked `.canopy-meta` is inside a content branch's cone, so a sparse clone behaves
  // the same.
  describe.each([
    { clone: 'full', sparseCone: undefined },
    { clone: 'sparse', sparseCone: ['content', '.canopy-meta'] },
  ])("canopycms's own state ($clone clone)", ({ sparseCone }) => {
    it('fast-forwards despite a modified tracked .canopy-meta file, and reports the tracking', async () => {
      const { basePath, pushToRemote } = await createBaseWorkspaceSetup(tmpDir, {
        sparseCone,
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
        sparseCone,
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
      const { basePath, remoteGit, publishRemote } = await createBaseWorkspaceSetup(tmpDir, {
        sparseCone,
        initialFiles: { 'content/a.md': 'a', '.canopy-meta/schema-cache.json': '{"v":"old"}' },
      })
      // What a pre-move canopycms left behind in the clone.
      await fs.writeFile(path.join(basePath, '.canopy-meta', 'schema-cache.json'), '{"v":"local"}')
      // The adopter's fix lands upstream.
      await remoteGit.raw(['rm', '-r', '--cached', '.canopy-meta'])
      await remoteGit.commit('untrack canopycms state')
      await publishRemote()

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))

      const tracked = await simpleGit({ baseDir: basePath }).raw(['ls-files', '--', '.canopy-meta'])
      expect(tracked).toBe('')
      expect(report.outcome).toBe('refreshed')
      expect(consoleSpy).toHaveLogged(/restored the retired in-tree schema cache/)
      consoleSpy.restore()
    })

    it("fast-forwards past the adopter's untracking commit without touching live state", async () => {
      const { basePath, remoteGit, publishRemote } = await createBaseWorkspaceSetup(tmpDir, {
        sparseCone,
        initialFiles: {
          'content/a.md': 'a',
          '.canopy-meta/comments.json': '{"threads":[]}',
          '.canopy-meta/clean-état.json': '{"clean":true}',
        },
      })
      const commentsPath = path.join(basePath, '.canopy-meta', 'comments.json')
      await fs.writeFile(commentsPath, '{"threads":["live"]}')
      await remoteGit.raw(['rm', '-r', '--cached', '-q', '.canopy-meta'])
      await remoteGit.commit('untrack canopycms state')
      await publishRemote()

      const consoleSpy = mockConsole()
      const report = await refreshBase(makeWorker(tmpDir))
      expect(consoleSpy).toHaveLogged(
        /stopped tracking \.canopy-meta\/clean-état\.json, \.canopy-meta\/comments\.json, as upstream has/,
      )
      consoleSpy.restore()

      expect(report).toEqual({ outcome: 'refreshed' })
      await expect(fs.readFile(commentsPath, 'utf8')).resolves.toBe('{"threads":["live"]}')
      // A clean tracked copy would otherwise be deleted by the fast-forward.
      await expect(
        fs.readFile(path.join(basePath, '.canopy-meta', 'clean-état.json'), 'utf8'),
      ).resolves.toBe('{"clean":true}')
      expect(await simpleGit({ baseDir: basePath }).raw(['ls-files', '--', '.canopy-meta'])).toBe(
        '',
      )
    })

    it('re-applies the .canopy-meta/ exclude to a clone that predates it', async () => {
      const { basePath } = await createBaseWorkspaceSetup(tmpDir, { skipExclude: true, sparseCone })

      await refreshBase(makeWorker(tmpDir))

      const exclude = await fs.readFile(path.join(basePath, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude.split('\n')).toContain('.canopy-meta/')
    })

    it('caps the reported dirty files but counts them all in the message', async () => {
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`content/f${i}.md`, 'x']),
      )
      const { basePath } = await createBaseWorkspaceSetup(tmpDir, {
        initialFiles: files,
        sparseCone,
      })
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
