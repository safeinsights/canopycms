/**
 * Two ways a branch clone was left mid-rebase forever, with no recovery path.
 *
 * Both leave `.git/rebase-merge` on disk, which nothing detected: the sync
 * loop's dirty check classified the clone `skippedDirty` on EVERY cycle from
 * then on, and `branch-health` saw intact branch.json and scanned it as
 * healthy. Editors meanwhile read -- and could save over -- conflict-marker
 * content. Recovery meant an operator running `git rebase --abort` on EFS.
 *
 *  1. A modify/delete conflict. `git checkout --theirs` on a path whose
 *     "their" side is a deletion exits non-zero and simple-git throws. That
 *     throw originated inside the round loop's OWN catch, so it escaped the
 *     round loop entirely and skipped both `rebase --abort` sites.
 *
 *  2. A rebase interrupted by worker termination -- SIGKILL, OOM on the 512MB
 *     t4g.nano, spot interruption, or the ASG rolling the instance, which
 *     happens on every `cdk deploy`.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { scanBranchHealth } from '../branch-health'
import { initTestRepo, mockConsole } from '../test-utils'
import { isRebaseInProgress } from '../utils/git'
import { CmsWorker } from './cms-worker'

const ENTRY_FILE = 'content/posts/post.hello.TESTENTRYabc.json'

const makeWorker = (workspacePath: string) =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
  })

interface RebaseInternals {
  rebaseActiveBranches(): Promise<{
    rebased: string[]
    skippedDirty: string[]
    skippedLocked: string[]
    failed: { branch: string; error: string }[]
  }>
}

const runRebase = (worker: CmsWorker) =>
  (worker as unknown as RebaseInternals).rebaseActiveBranches()

interface Setup {
  branchPath: string
  branchGit: SimpleGit
  contentBranchesPath: string
}

/**
 * A branch clone set up so the rebase must enter a conflict round. When
 * `branchDeletesEntry` is true the branch DELETES the entry the base branch
 * modifies -- git status `UD`, "deleted by them", the modify/delete shape.
 * Mirrors cms-worker-content-lock.test.ts's `createConflictSetup`.
 */
async function createSetup(
  tmpDir: string,
  branchName: string,
  opts: { branchDeletesEntry: boolean },
): Promise<Setup> {
  const remotePath = path.join(tmpDir, 'remote')
  const contentBranchesPath = path.join(tmpDir, 'content-branches')
  const branchPath = path.join(contentBranchesPath, branchName)

  await fs.mkdir(remotePath)
  const remoteGit = await initTestRepo(remotePath)
  await remoteGit.raw(['branch', '-M', 'main'])

  const writeInto = async (root: string, content: string) => {
    const full = path.join(root, ENTRY_FILE)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  await writeInto(remotePath, '{\n  "title": "base"\n}\n')
  await remoteGit.add(['.'])
  await remoteGit.commit('initial commit')

  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remotePath, branchPath)

  const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
  await branchGit.addConfig('user.name', 'Test Bot')
  await branchGit.addConfig('user.email', 'test@canopycms.test')
  await branchGit.addConfig('core.editor', 'true')

  const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')

  await branchGit.checkoutBranch(branchName, 'origin/main')
  await branchGit.raw(['branch', '--set-upstream-to=origin/main', branchName])

  // The editor's change on the branch...
  if (opts.branchDeletesEntry) {
    await branchGit.rm([ENTRY_FILE])
    await branchGit.commit('branch: delete entry')
  } else {
    await writeInto(branchPath, '{\n  "title": "branch version"\n}\n')
    await branchGit.add(['.'])
    await branchGit.commit('branch: update entry')
  }

  // ...and an upstream PR modifying the same file.
  await writeInto(remotePath, '{\n  "title": "main version"\n}\n')
  await remoteGit.add(['.'])
  await remoteGit.commit('main: update same entry')

  const meta = BranchMetadataFileManager.get(branchPath, contentBranchesPath)
  await meta.save({
    branch: { name: branchName, status: 'editing' as const, access: {}, createdBy: 'test' },
  })

  return { branchPath, branchGit, contentBranchesPath }
}

describe('rebase wedge recovery', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-rebase-wedge-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('modify/delete conflict', () => {
    it('does not leave the clone mid-rebase when the branch deleted a file base modified', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: true })

      await runRebase(makeWorker(tmpDir))

      // The core guarantee: whatever the outcome, no rebase state is left on
      // disk. Before the fix this was `true` and stayed true forever.
      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
    })

    it('honours the branch-side delete and leaves the branch usable', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: true })

      const summary = await runRebase(makeWorker(tmpDir))

      // Keep-branch-version policy: the branch deleted the entry, so the
      // rebase resolves by honouring that delete rather than resurrecting
      // base's modified copy.
      expect(summary.rebased).toContain('my-feature')
      await expect(fs.stat(path.join(setup.branchPath, ENTRY_FILE))).rejects.toThrow()

      // HEAD is back on a real branch (not detached), and the tree is clean --
      // so the next cycle does not classify it `skippedDirty`.
      const status = await setup.branchGit.status()
      expect(status.files).toHaveLength(0)
      expect((await setup.branchGit.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('my-feature')
    })

    it('still keeps the branch version for an ordinary content conflict', async () => {
      // Guards the refactor: the non-delete path must behave exactly as before.
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })

      const summary = await runRebase(makeWorker(tmpDir))

      expect(summary.rebased).toContain('my-feature')
      const entry = await fs.readFile(path.join(setup.branchPath, ENTRY_FILE), 'utf8')
      expect(entry).toContain('branch version')
      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
    })
  })

  describe('rebase interrupted by worker termination', () => {
    /** Leave the clone exactly as a SIGKILL mid-rebase would. */
    async function interruptRebase(setup: Setup): Promise<void> {
      await setup.branchGit.fetch('origin')
      await setup.branchGit.rebase(['origin/main']).catch(() => {})
      expect(await isRebaseInProgress(setup.branchPath)).toBe(true)
    }

    it('detects and aborts an interrupted rebase instead of skipping the branch forever', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      await interruptRebase(setup)

      const summary = await runRebase(makeWorker(tmpDir))

      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
      // Recovered and synced in the SAME cycle, rather than being reported as
      // "has uncommitted changes" every cycle from now on.
      expect(summary.skippedDirty).not.toContain('my-feature')
      expect(summary.rebased).toContain('my-feature')
    })

    it('leaves no conflict markers for editors to read or save over', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      await interruptRebase(setup)

      await runRebase(makeWorker(tmpDir))

      const entry = await fs.readFile(path.join(setup.branchPath, ENTRY_FILE), 'utf8')
      expect(entry).not.toContain('<<<<<<<')
      expect(entry).not.toContain('>>>>>>>')
    })
  })

  describe('branch-health visibility', () => {
    it('flags an interrupted rebase instead of reporting the branch as plain healthy', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })

      const before = await scanBranchHealth(setup.contentBranchesPath, { baseBranchName: 'main' })
      expect(before.find((e) => e.dirName === 'my-feature')?.rebaseInProgress).toBeUndefined()

      await setup.branchGit.fetch('origin')
      await setup.branchGit.rebase(['origin/main']).catch(() => {})

      const during = await scanBranchHealth(setup.contentBranchesPath, { baseBranchName: 'main' })
      const entry = during.find((e) => e.dirName === 'my-feature')
      // Still `healthy` -- the metadata is intact and the state self-recovers.
      // The flag is what makes the window visible at all.
      expect(entry?.kind).toBe('healthy')
      expect(entry?.rebaseInProgress).toBe(true)
    })
  })

  describe('isRebaseInProgress', () => {
    it('returns false for a clean repo and for a nonexistent path', async () => {
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
      expect(await isRebaseInProgress(path.join(tmpDir, 'nope'))).toBe(false)
    })

    it('resolves a `.git` FILE pointer, not just a `.git` directory', async () => {
      // Linked-worktree / submodule layout: `.git` is a file containing
      // `gitdir: <path>`.
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      const realGitDir = path.join(tmpDir, 'detached-git')
      await fs.rename(path.join(setup.branchPath, '.git'), realGitDir)
      await fs.writeFile(path.join(setup.branchPath, '.git'), `gitdir: ${realGitDir}\n`)

      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
      await fs.mkdir(path.join(realGitDir, 'rebase-merge'), { recursive: true })
      expect(await isRebaseInProgress(setup.branchPath)).toBe(true)
    })
  })
})
