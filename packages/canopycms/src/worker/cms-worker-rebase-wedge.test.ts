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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { scanBranchHealth } from '../branch-health'
import { initTestRepo, mockConsole } from '../test-utils'
import { isRebaseInProgress } from '../utils/git'
import { CmsWorker } from './cms-worker'

const ENTRY_FILE = 'content/posts/post.hello.TESTENTRYabc.json'
/**
 * Present from the base commit and touched by neither side, so a test can
 * modify it DURING a wedge to stand in for an editor's save (` M`). It has to
 * predate the rebase: git refuses `commit` while unmerged paths exist.
 */
const BYSTANDER_FILE = 'content/posts/post.bystander.TESTENTRYdef.json'
/**
 * Present from the base commit and edited by the BRANCH in the same commit as
 * the conflicting entry. When the rebase stops on that conflict, this file's
 * cleanly-replayed change is already STAGED (`M `) -- committed history that
 * survives the abort untouched, and must therefore never be reported as a
 * discarded editor save.
 */
const REPLAY_STAGED_FILE = 'content/posts/post.replayed.TESTENTRYghi.json'

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
  opts: { branchDeletesEntry: boolean; baseDeletesEntry?: boolean },
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
  for (const extra of [BYSTANDER_FILE, REPLAY_STAGED_FILE]) {
    const full = path.join(remotePath, extra)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, '{\n  "title": "base"\n}\n')
  }
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
    // Edited in the SAME commit and NOT touched by base, so it replays cleanly
    // and sits staged while the rebase is stopped on the conflict above.
    await fs.writeFile(
      path.join(branchPath, REPLAY_STAGED_FILE),
      '{\n  "title": "branch replayed"\n}\n',
    )
    await branchGit.add(['.'])
    await branchGit.commit('branch: update entry and one clean file')
  }

  // ...and the upstream side, which either modifies the same file or deletes
  // it (the DU direction: "deleted by us" once the rebase reverses sides).
  if (opts.baseDeletesEntry) {
    await remoteGit.rm([ENTRY_FILE])
    await remoteGit.commit('main: delete entry')
  } else {
    await writeInto(remotePath, '{\n  "title": "main version"\n}\n')
    await remoteGit.add(['.'])
    await remoteGit.commit('main: update same entry')
  }

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

    it('keeps the branch version when BASE deleted the file and the branch modified it (DU)', async () => {
      // The mirror image of the case above, and the other half of the
      // conflict-kind dispatch: git status `DU`, "deleted by us". Git leaves
      // the BRANCH's version in the tree, so keep-branch-version means staging
      // it with `git add` -- getting this direction backwards would silently
      // delete an editor's still-wanted file.
      const setup = await createSetup(tmpDir, 'my-feature', {
        branchDeletesEntry: false,
        baseDeletesEntry: true,
      })

      const summary = await runRebase(makeWorker(tmpDir))

      expect(summary.rebased).toContain('my-feature')
      expect(await isRebaseInProgress(setup.branchPath)).toBe(false)
      // The branch's edit survives base's deletion.
      const entry = await fs.readFile(path.join(setup.branchPath, ENTRY_FILE), 'utf8')
      expect(entry).toContain('branch version')
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

    it('names the editor saves it is about to discard, and only those', async () => {
      // This filter has now been written wrong TWICE -- first keyed on the
      // wrong columns entirely, then over-reporting the replay's own staged
      // files -- and both times the whole suite stayed green. So assert the
      // classification directly.
      //
      // A `rebase --abort` hard-resets tracked files. While the worker was
      // down nothing held the content-write lock, so an editor's save could
      // have landed; the abort reverts it, and the log line is the only record
      // an operator gets.
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      await setup.branchGit.fetch('origin')
      await setup.branchGit.rebase(['origin/main']).catch(() => {})
      expect(await isRebaseInProgress(setup.branchPath)).toBe(true)

      // An editor edits an EXISTING entry in the wedged clone (` M`) ...
      const savedOver = path.join(setup.branchPath, BYSTANDER_FILE)
      await fs.writeFile(savedOver, '{\n  "title": "edited during downtime"\n}\n')
      // ... and creates a NEW one, which is untracked and survives the abort.
      const newEntry = path.join(setup.branchPath, 'content/posts/brand-new.json')
      await fs.writeFile(newEntry, '{\n  "title": "new"\n}\n')

      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      })
      try {
        await runRebase(makeWorker(tmpDir))
      } finally {
        spy.mockRestore()
      }

      const discardLine = warnings.find((w) => w.includes('will DISCARD'))
      expect(discardLine, 'the discard warning must be emitted').toBeDefined()
      // The editor's unstaged modification is named...
      expect(discardLine).toContain(BYSTANDER_FILE)
      // ...and the untracked new file, which the abort does NOT delete, is not.
      expect(discardLine).not.toContain('content/posts/brand-new.json')
      // ...nor is the interrupted replay's own STAGED file (`M `). That change
      // is committed history and survives the abort, so naming it would be a
      // false data-loss report -- the exact defect the first two versions of
      // this filter had.
      expect(discardLine).not.toContain(REPLAY_STAGED_FILE)
      // The new entry really did survive, which is what makes that correct.
      expect((await fs.stat(newEntry)).isFile()).toBe(true)
    })

    it('stays silent when there is nothing to discard', async () => {
      // The common recovery: nothing but the interrupted replay's own state.
      // Reporting the replay's staged files here would be a false data-loss
      // alarm naming specific files, which is worse than no report at all.
      const setup = await createSetup(tmpDir, 'my-feature', { branchDeletesEntry: false })
      await setup.branchGit.fetch('origin')
      await setup.branchGit.rebase(['origin/main']).catch(() => {})

      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      })
      try {
        await runRebase(makeWorker(tmpDir))
      } finally {
        spy.mockRestore()
      }

      expect(warnings.find((w) => w.includes('will DISCARD'))).toBeUndefined()
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
