/**
 * [SYNC-H1] Tests for the rebase loop publishing what it rewrites.
 *
 * `rebaseActiveBranches()` rewrites the history of an `editing` branch that
 * has fallen behind base. When that branch had already been submitted, its
 * pre-rebase history is in `remote.git` (and on GitHub), and nothing used to
 * reconcile the two: the editor's next submit pushed a history that no longer
 * contained `remote.git`'s tip and was rejected non-fast-forward -- surfaced
 * as a 409 that blamed a foreign deployment and advised renaming the branch,
 * which would orphan the branch's open PR.
 *
 * The loop now force-publishes the rewrite into `remote.git` under a lease
 * keyed to the exact commit it replaced, records that commit
 * (`historyRewrittenFrom`) so the GitHub hop can use the same lease, and
 * queues that hop.
 *
 * The arming guard is the important part, and the reviewer-fixup test below
 * is what pins it: branch clones never fetch their own branch, while
 * `reconcileTrackedBranches` fast-forwards `remote.git` to GitHub's tip, so
 * `remote.git` can legitimately hold commits this clone has never seen. A
 * lease keyed to "whatever remote.git holds" would be satisfied there and
 * would silently delete someone else's pushed work.
 *
 * Unlike cms-worker-rebase.test.ts (whose fixture remote is a non-bare repo
 * at a path the worker never reads), this harness puts a real bare repo at
 * `<workspace>/remote.git` -- the path CmsWorker actually treats as the
 * deployment's local origin -- so the publish paths are live.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { listTasks } from './task-queue'
import { initTestRepo, mockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

const BASE_BRANCH = 'main'

interface PublishSetup {
  workspacePath: string
  remoteGitPath: string
  contentBranchesPath: string
  branchPath: string
  branchGit: SimpleGit
  /** Add a commit to the base branch in remote.git (leaves the branch behind). */
  advanceBase: (files: Record<string, string>, message?: string) => Promise<void>
  /** Commit into the branch clone. */
  commitToBranch: (files: Record<string, string>, message?: string) => Promise<void>
  /** Push the branch clone's current branch into remote.git (what submit does). */
  submit: () => Promise<void>
  /**
   * Land a commit on the branch directly in remote.git, from outside this
   * clone -- what a reviewer pushing to the PR branch looks like locally
   * after reconcileTrackedBranches fast-forwards it in.
   */
  foreignPushToBranch: (files: Record<string, string>, message?: string) => Promise<void>
  /** A ref's SHA inside the bare remote.git. */
  remoteSha: (ref: string) => Promise<string | null>
  /** Subject lines of a ref's history inside remote.git. */
  remoteLog: (ref: string) => Promise<string>
}

async function createPublishSetup(tmpDir: string, branchName: string): Promise<PublishSetup> {
  const workspacePath = tmpDir
  const remoteGitPath = path.join(workspacePath, 'remote.git')
  const contentBranchesPath = path.join(workspacePath, 'content-branches')
  const branchPath = path.join(contentBranchesPath, branchName)

  await simpleGit().raw(['init', '--bare', '--initial-branch', BASE_BRANCH, remoteGitPath])

  // Seed the base branch through a scratch working repo (a bare repo has no
  // worktree to commit in).
  const seedPath = path.join(workspacePath, 'seed')
  await fs.mkdir(seedPath, { recursive: true })
  const seedGit = await initTestRepo(seedPath)
  await seedGit.raw(['branch', '-M', BASE_BRANCH])
  await fs.writeFile(path.join(seedPath, 'base.txt'), 'base\n')
  await seedGit.add(['.'])
  await seedGit.commit('initial commit')
  await seedGit.addRemote('origin', remoteGitPath)
  await seedGit.raw(['push', 'origin', `${BASE_BRANCH}:${BASE_BRANCH}`])

  // Clone exactly as production does (GitManager.provision).
  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remoteGitPath, branchPath, ['--branch', BASE_BRANCH, '--single-branch'])

  const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
  await branchGit.addConfig('user.name', 'Test Bot')
  await branchGit.addConfig('user.email', 'test@canopycms.test')
  await branchGit.addConfig('core.editor', 'true')
  const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')
  await branchGit.checkoutBranch(branchName, `origin/${BASE_BRANCH}`)

  const advanceBase = async (files: Record<string, string>, message = 'base commit') => {
    await seedGit.checkout(BASE_BRANCH)
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(seedPath, name)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content)
    }
    await seedGit.add(['.'])
    await seedGit.commit(message)
    await seedGit.raw(['push', 'origin', `${BASE_BRANCH}:${BASE_BRANCH}`])
  }

  const commitToBranch = async (files: Record<string, string>, message = 'branch commit') => {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(branchPath, name)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content)
    }
    await branchGit.add(['.'])
    await branchGit.commit(message)
  }

  const submit = async () => {
    await branchGit.raw(['push', 'origin', `${branchName}:${branchName}`])
  }

  const foreignPushToBranch = async (files: Record<string, string>, message = 'reviewer fixup') => {
    const otherPath = path.join(workspacePath, `outsider-${Date.now()}`)
    await simpleGit().clone(remoteGitPath, otherPath, ['--branch', branchName, '--single-branch'])
    const otherGit = simpleGit({ baseDir: otherPath })
    await otherGit.addConfig('user.name', 'Reviewer')
    await otherGit.addConfig('user.email', 'reviewer@canopycms.test')
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(otherPath, name), content)
    }
    await otherGit.add(['.'])
    await otherGit.commit(message)
    await otherGit.raw(['push', 'origin', `${branchName}:${branchName}`])
  }

  const remoteSha = async (ref: string): Promise<string | null> => {
    try {
      return (
        await simpleGit().raw(['--git-dir', remoteGitPath, 'rev-parse', '--verify', ref])
      ).trim()
    } catch {
      return null
    }
  }

  const remoteLog = (ref: string) =>
    simpleGit().raw(['--git-dir', remoteGitPath, 'log', ref, '--format=%s'])

  return {
    workspacePath,
    remoteGitPath,
    contentBranchesPath,
    branchPath,
    branchGit,
    advanceBase,
    commitToBranch,
    submit,
    foreignPushToBranch,
    remoteSha,
    remoteLog,
  }
}

const makeWorker = (workspacePath: string) =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: BASE_BRANCH,
  })

const runRebase = (worker: CmsWorker): Promise<void> =>
  (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()

const writeMeta = async (
  branchPath: string,
  contentBranchesPath: string,
  data: Record<string, unknown> = {},
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

const readMeta = (branchPath: string) =>
  BranchMetadataFileManager.loadOnly(branchPath).then((f) => f?.branch)

const queuedPushBranches = async (workspacePath: string): Promise<string[]> => {
  const tasks = await listTasks(path.join(workspacePath, '.tasks'), 'pending')
  return tasks.filter((t) => t.action === 'push-branch').map((t) => String(t.payload.branch))
}

describe('CmsWorker.rebaseActiveBranches() publishes rewritten history', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-rebase-publish-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('never force-publishes over a commit this clone has not seen (reviewer pushed to the PR branch)', async () => {
    // THE safety test. remote.git holds the editor's commit PLUS a reviewer's
    // direct push; the clone has only the editor's. A lease keyed to
    // remote.git's current tip would be satisfied and would erase the fixup.
    const setup = await createPublishSetup(tmpDir, 'feature-reviewed')
    await setup.commitToBranch({ 'entry.md': 'editor v1\n' }, 'editor work')
    await setup.submit()
    const beforeFixup = (await setup.branchGit.revparse(['HEAD'])).trim()

    await setup.foreignPushToBranch({ 'reviewer.md': 'reviewer note\n' }, 'reviewer fixup')
    const withFixup = await setup.remoteSha('refs/heads/feature-reviewed')
    expect(withFixup).not.toBe(beforeFixup)

    await setup.advanceBase({ 'base2.txt': 'moved on\n' })
    await writeMeta(setup.branchPath, setup.contentBranchesPath)

    await runRebase(makeWorker(setup.workspacePath))

    // The fixup survives, in remote.git, untouched.
    expect(await setup.remoteSha('refs/heads/feature-reviewed')).toBe(withFixup)
    expect(await setup.remoteLog('refs/heads/feature-reviewed')).toContain('reviewer fixup')

    // Nothing was armed: no marker, no queued push -- and the divergence is
    // recorded where the editor can see it rather than silently swallowed.
    const meta = await readMeta(setup.branchPath)
    expect(meta?.historyRewrittenFrom).toBeUndefined()
    expect(await queuedPushBranches(setup.workspacePath)).toEqual([])
    expect(meta?.rebaseFailure?.message).toContain('never had')
  })

  it('publishes the rebased history into remote.git so the next submit is no longer rejected', async () => {
    // The direct regression test for the 409: before the fix, the push at the
    // end of this test failed non-fast-forward.
    const setup = await createPublishSetup(tmpDir, 'feature-resubmit')
    await setup.commitToBranch({ 'entry.md': 'editor v1\n' }, 'editor work')
    await setup.submit()
    const published = await setup.remoteSha('refs/heads/feature-resubmit')

    await setup.advanceBase({ 'base2.txt': 'moved on\n' })
    await writeMeta(setup.branchPath, setup.contentBranchesPath)

    await runRebase(makeWorker(setup.workspacePath))

    const rebasedTip = (await setup.branchGit.revparse(['HEAD'])).trim()
    expect(rebasedTip).not.toBe(published)
    expect(await setup.remoteSha('refs/heads/feature-resubmit')).toBe(rebasedTip)

    // The commit GitHub still holds is recorded for the GitHub hop's lease,
    // and that hop is queued.
    const meta = await readMeta(setup.branchPath)
    expect(meta?.historyRewrittenFrom).toBe(published)
    expect(await queuedPushBranches(setup.workspacePath)).toEqual(['feature-resubmit'])

    // What the editor does next: edit and submit again. Before the fix this
    // push was rejected non-fast-forward -- the 409 this finding is about --
    // because remote.git still held the history the rebase had replaced.
    await setup.commitToBranch({ 'entry.md': 'editor v2\n' }, 'editor work 2')
    await setup.submit()
    expect(await setup.remoteLog('refs/heads/feature-resubmit')).toContain('editor work 2')
  })

  it('keeps the marker at the originally published commit across a second rebase', async () => {
    // GitHub still holds the FIRST pre-rebase commit until a push lands, so
    // advancing the marker would aim the lease at a commit it never had.
    const setup = await createPublishSetup(tmpDir, 'feature-twice')
    await setup.commitToBranch({ 'entry.md': 'v1\n' }, 'editor work')
    await setup.submit()
    const originallyPublished = await setup.remoteSha('refs/heads/feature-twice')

    await setup.advanceBase({ 'base2.txt': 'a\n' })
    await writeMeta(setup.branchPath, setup.contentBranchesPath)
    await runRebase(makeWorker(setup.workspacePath))

    await setup.advanceBase({ 'base3.txt': 'b\n' })
    await runRebase(makeWorker(setup.workspacePath))

    const meta = await readMeta(setup.branchPath)
    expect(meta?.historyRewrittenFrom).toBe(originallyPublished)
    // remote.git still follows the clone.
    expect(await setup.remoteSha('refs/heads/feature-twice')).toBe(
      (await setup.branchGit.revparse(['HEAD'])).trim(),
    )
  })

  it('self-heals a publish that never landed, without waiting for another base advance', async () => {
    // The crash window: the marker was written and the worker died before the
    // remote.git push. The branch is NOT behind base, so nothing but the
    // self-heal pass will ever revisit it.
    const setup = await createPublishSetup(tmpDir, 'feature-crashed')
    await setup.commitToBranch({ 'entry.md': 'v1\n' }, 'editor work')
    await setup.submit()
    const published = await setup.remoteSha('refs/heads/feature-crashed')

    // Rewrite the clone's history the way a rebase would, leaving remote.git
    // at the pre-rewrite commit.
    await setup.branchGit.raw(['commit', '--amend', '-m', 'editor work (rewritten)'])
    const rewrittenTip = (await setup.branchGit.revparse(['HEAD'])).trim()
    await writeMeta(setup.branchPath, setup.contentBranchesPath, {
      historyRewrittenFrom: published,
    })

    await runRebase(makeWorker(setup.workspacePath))

    expect(await setup.remoteSha('refs/heads/feature-crashed')).toBe(rewrittenTip)
    expect(await queuedPushBranches(setup.workspacePath)).toEqual(['feature-crashed'])
  })

  it('self-heals a queued push that was lost, without re-pushing remote.git', async () => {
    // The other crash window: remote.git already carries the rewrite, only
    // the GitHub hop is missing.
    const setup = await createPublishSetup(tmpDir, 'feature-lost-task')
    await setup.commitToBranch({ 'entry.md': 'v1\n' }, 'editor work')
    await setup.submit()
    const published = await setup.remoteSha('refs/heads/feature-lost-task')

    await setup.branchGit.raw(['commit', '--amend', '-m', 'editor work (rewritten)'])
    await setup.branchGit.raw(['push', '--force', 'origin', 'feature-lost-task:feature-lost-task'])
    const tip = (await setup.branchGit.revparse(['HEAD'])).trim()
    await writeMeta(setup.branchPath, setup.contentBranchesPath, {
      historyRewrittenFrom: published,
    })

    await runRebase(makeWorker(setup.workspacePath))

    expect(await setup.remoteSha('refs/heads/feature-lost-task')).toBe(tip)
    expect(await queuedPushBranches(setup.workspacePath)).toEqual(['feature-lost-task'])
  })

  it('does not stack duplicate GitHub push tasks across cycles', async () => {
    const setup = await createPublishSetup(tmpDir, 'feature-dupes')
    await setup.commitToBranch({ 'entry.md': 'v1\n' }, 'editor work')
    await setup.submit()
    const published = await setup.remoteSha('refs/heads/feature-dupes')

    await setup.branchGit.raw(['commit', '--amend', '-m', 'editor work (rewritten)'])
    await writeMeta(setup.branchPath, setup.contentBranchesPath, {
      historyRewrittenFrom: published,
    })

    await runRebase(makeWorker(setup.workspacePath))
    await runRebase(makeWorker(setup.workspacePath))
    await runRebase(makeWorker(setup.workspacePath))

    expect(await queuedPushBranches(setup.workspacePath)).toEqual(['feature-dupes'])
  })

  it('leaves an unsubmitted branch alone -- nothing was ever published', async () => {
    const setup = await createPublishSetup(tmpDir, 'feature-fresh')
    await setup.commitToBranch({ 'entry.md': 'v1\n' }, 'editor work')
    await setup.advanceBase({ 'base2.txt': 'moved on\n' })
    await writeMeta(setup.branchPath, setup.contentBranchesPath)

    await runRebase(makeWorker(setup.workspacePath))

    // Rebased, but nothing published into remote.git and nothing marked:
    // an unsubmitted branch's history is the clone's business alone.
    expect(await setup.remoteSha('refs/heads/feature-fresh')).toBeNull()
    const meta = await readMeta(setup.branchPath)
    expect(meta?.historyRewrittenFrom).toBeUndefined()
    expect(await queuedPushBranches(setup.workspacePath)).toEqual([])
  })
})
