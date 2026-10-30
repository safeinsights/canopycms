/**
 * Commits that reach a branch on GitHub without passing through its clone (worker/github-commits.ts).
 *
 * A real bare repo at `<workspace>/remote.git` and a real clone, as production has. GitHub's tip is
 * what this cycle's fetch reports: `refs/remotes/github/<branch>` in remote.git, passed to the loop
 * the way syncGit passes it, with `refs/heads/<branch>` moved as `reconcileTrackedBranches` would.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { listTasks } from '../task-queue/cms-task-queue'
import { initTestRepo, mockConsole } from '../test-utils'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import type { BranchMetadata } from '../types'
import { CmsWorker } from './cms-worker'
import type { RebaseSummary } from './rebase'

const BASE = 'main'
const BRANCH = 'f'
const CONFLICTED_ID = 'abc123def456'
const ENTRY = `content/post.page.${CONFLICTED_ID}.json`

interface Setup {
  workspace: string
  remoteGit: string
  branchPath: string
  contentBranches: string
  clone: SimpleGit
  /** A repository with its own view of remote.git: stands in for a person working on GitHub. */
  outside: SimpleGit
  advanceBase(files: Record<string, string>): Promise<void>
  /** A commit in the clone, as submit makes, without the push. */
  commit(files: Record<string, string>, message?: string): Promise<void>
  /** What submit's push does. */
  push(): Promise<void>
  /** Write a saved edit, uncommitted. */
  save(files: Record<string, string>): Promise<void>
  /** A commit on GitHub's copy of the branch, reconciled into remote.git. */
  commitOnGitHub(files: Record<string, string>, message?: string): Promise<string>
  /** GitHub's Update branch: base merged into GitHub's copy of the branch. */
  updateBranchOnGitHub(): Promise<string>
  /** GitHub moved, and remote.git's head has not: it is diverged, or this cycle has not reached it. */
  moveGitHubOnly(files: Record<string, string>, message?: string): Promise<string>
  /** Replace GitHub's copy with a history that drops what it held. */
  forcePushOnGitHub(files: Record<string, string>): Promise<string>
  remoteSha(ref: string): Promise<string | null>
  head(): Promise<string>
  /** Subjects of a commit's history, newest first. */
  log(ref: string): Promise<string[]>
  file(name: string): Promise<string | null>
}

async function createSetup(workspace: string): Promise<Setup> {
  const remoteGit = path.join(workspace, 'remote.git')
  const contentBranches = path.join(workspace, 'content-branches')
  const branchPath = path.join(contentBranches, BRANCH)
  await simpleGit().raw(['init', '--bare', '--initial-branch', BASE, remoteGit])
  const bare = (args: string[]) => simpleGit().raw(['--git-dir', remoteGit, ...args])

  const seedPath = path.join(workspace, 'seed')
  await fs.mkdir(seedPath, { recursive: true })
  const seed = await initTestRepo(seedPath)
  await seed.raw(['branch', '-M', BASE])
  await fs.mkdir(path.join(seedPath, 'content'), { recursive: true })
  await fs.writeFile(path.join(seedPath, ENTRY), '{"title":"seed"}\n')
  await seed.add(['.'])
  await seed.commit('initial commit')
  await seed.addRemote('origin', remoteGit)
  await seed.raw(['push', 'origin', `${BASE}:${BASE}`])

  await fs.mkdir(contentBranches, { recursive: true })
  await simpleGit().clone(remoteGit, branchPath, ['--branch', BASE, '--single-branch'])
  const clone = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
  await clone.addConfig('user.name', 'Test Bot')
  await clone.addConfig('user.email', 'test@canopycms.test')
  await fs.appendFile(path.join(branchPath, '.git', 'info', 'exclude'), '\n.canopy-meta/\n')
  await clone.checkoutBranch(BRANCH, `origin/${BASE}`)

  const outsidePath = path.join(workspace, 'outside')
  await simpleGit().clone(remoteGit, outsidePath)
  const outside = simpleGit({ baseDir: outsidePath })
  await outside.addConfig('user.name', 'Maintainer')
  await outside.addConfig('user.email', 'maintainer@canopycms.test')

  const write = async (root: string, files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(root, name)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content)
    }
  }
  const outsideOnBranch = async () => {
    await outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
    await outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}`])
  }
  const outsideCommit = async (files: Record<string, string>, message: string) => {
    await write(outsidePath, files)
    await outside.add(['.'])
    await outside.commit(message)
    return (await outside.revparse(['HEAD'])).trim()
  }
  const trackGitHub = (sha: string) => bare(['update-ref', `refs/remotes/github/${BRANCH}`, sha])

  const setup: Setup = {
    workspace,
    remoteGit,
    branchPath,
    contentBranches,
    clone,
    outside,
    async advanceBase(files) {
      await write(seedPath, files)
      await seed.add(['.'])
      await seed.commit('base commit')
      await seed.raw(['push', 'origin', `${BASE}:${BASE}`])
    },
    async commit(files, message = 'editor work') {
      await write(branchPath, files)
      await clone.add(['.'])
      await clone.commit(message)
    },
    async push() {
      await clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await trackGitHub(await setup.head())
    },
    save: (files) => write(branchPath, files),
    async commitOnGitHub(files, message = 'maintainer fix') {
      await outsideOnBranch()
      const sha = await outsideCommit(files, message)
      await outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
      await trackGitHub(sha)
      return sha
    },
    async updateBranchOnGitHub() {
      await outsideOnBranch()
      await outside.fetch(['origin', BASE])
      await outside.raw(['merge', '--no-edit', 'FETCH_HEAD'])
      await outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
      const sha = (await outside.revparse(['HEAD'])).trim()
      await trackGitHub(sha)
      return sha
    },
    async moveGitHubOnly(files, message = 'maintainer fix') {
      await outside.fetch([
        '--force',
        'origin',
        `refs/remotes/github/${BRANCH}:refs/x/${BRANCH}-github`,
      ])
      await outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}-github`])
      const sha = await outsideCommit(files, message)
      await outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])
      return sha
    },
    async forcePushOnGitHub(files) {
      await outside.fetch(['origin', BASE])
      await outside.raw(['checkout', '-q', '-B', 'work', 'FETCH_HEAD'])
      const sha = await outsideCommit(files, 'rewritten')
      await outside.raw(['push', '--force', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])
      return sha
    },
    async remoteSha(ref) {
      return bare(['rev-parse', '--verify', ref]).then(
        (out) => out.trim(),
        () => null,
      )
    },
    head: async () => (await clone.revparse(['HEAD'])).trim(),
    log: async (ref) =>
      (await clone.raw(['log', ref, '--format=%s'])).trim().split('\n').filter(Boolean),
    file: (name) => fs.readFile(path.join(branchPath, name), 'utf-8').catch(() => null),
  }
  return setup
}

const writeMeta = (s: Setup, data: Partial<BranchMetadata> = {}) =>
  BranchMetadataFileManager.get(s.branchPath, s.contentBranches).save({
    branch: {
      name: BRANCH,
      status: 'editing',
      access: {},
      createdBy: 'test',
      pushedToGitHubAt: '2026-10-01T00:00:00.000Z',
      ...data,
    },
  })

const readMeta = async (s: Setup) =>
  (await BranchMetadataFileManager.loadOnly(s.branchPath))?.branch

const makeWorker = (s: Setup) =>
  new CmsWorker({
    workspacePath: s.workspace,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: BASE,
  })

/** One rebase cycle with GitHub's tips as syncGit passes them. */
async function cycle(s: Setup, worker = makeWorker(s)): Promise<RebaseSummary> {
  const tip = await s.remoteSha(`refs/remotes/github/${BRANCH}`)
  const tips = new Map(tip === null ? [] : [[BRANCH, tip]])
  const seam = worker as unknown as {
    rebaseActiveBranches(policy: undefined, tips: Map<string, string>): Promise<RebaseSummary>
  }
  return seam.rebaseActiveBranches(undefined, tips)
}

const queued = async (s: Setup, action: string) =>
  (await listTasks(path.join(s.workspace, '.tasks'), 'pending'))
    .filter((t) => t.action === action)
    .map((t) => t.payload.branch)

describe('bringing commits made on GitHub into a branch clone', () => {
  let tmpDir: string
  let s: Setup

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-github-commits-'))
    s = await createSetup(tmpDir)
    await s.commit({ 'editor.txt': 'v1\n' })
    await s.push()
    await writeMeta(s)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('a resubmit after Update branch on GitHub is no longer refused', async () => {
    await s.advanceBase({ 'base2.txt': 'moved\n' })
    await s.updateBranchOnGitHub()
    await s.advanceBase({ 'base3.txt': 'moved again\n' })

    await cycle(s)
    await s.commit({ 'editor.txt': 'v2\n' }, 'editor work 2')

    await expect(s.push()).resolves.toBeUndefined()
    const history = await s.log('HEAD')
    expect(history).toContain('editor work')
    expect(history).toContain('editor work 2')
    expect(await s.file('base2.txt')).toBe('moved\n')
    expect((await readMeta(s))?.rebaseFailure).toBeUndefined()
  })

  it("a maintainer's fix with the base unmoved is in the clone, and a resubmit passes", async () => {
    const fix = await s.commitOnGitHub({ 'fix.txt': 'fix\n' })

    await cycle(s)

    expect(await s.head()).toBe(fix)
    expect(await s.file('fix.txt')).toBe('fix\n')
    await s.commit({ 'editor.txt': 'v2\n' }, 'editor work 2')
    await expect(s.push()).resolves.toBeUndefined()
  })

  it('brings commits into a branch in review, leaving its status alone', async () => {
    await writeMeta(s, { status: 'submitted', submittedAt: '2026-10-01T00:00:00.000Z' })
    const fix = await s.commitOnGitHub({ 'fix.txt': 'fix\n' })

    await cycle(s)

    expect(await s.head()).toBe(fix)
    expect((await readMeta(s))?.status).toBe('submitted')
  })

  it('records GitHub tip it has taken in', async () => {
    const fix = await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    await cycle(s)
    expect((await readMeta(s))?.lastGitHubTip).toBe(fix)
  })

  it('leaves a branch in review to the next cycle while a content write holds its lock', async () => {
    await writeMeta(s, { status: 'submitted' })
    const before = await s.head()
    await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    const release = await tryAcquireContentWriteLock(s.branchPath, () => {})
    try {
      const summary = await cycle(s)
      expect(summary.skippedLocked).toEqual([BRANCH])
      expect(await s.head()).toBe(before)
    } finally {
      await release()
    }
  })

  it('fast-forwards past saved edits that touch other files', async () => {
    const fix = await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    await s.save({ 'editor.txt': 'saved\n' })

    const summary = await cycle(s)

    expect(summary.skippedDirty).toEqual([BRANCH])
    expect(await s.head()).toBe(fix)
    expect(await s.file('editor.txt')).toBe('saved\n')
  })

  it('leaves saved edits to a file GitHub changed as they are, until a submit commits them', async () => {
    const before = await s.head()
    await s.commitOnGitHub({ 'editor.txt': 'from github\n' })
    await s.save({ 'editor.txt': 'saved\n' })

    await cycle(s)

    expect(await s.head()).toBe(before)
    expect(await s.file('editor.txt')).toBe('saved\n')

    // A submit commits the save and its push is refused, which leaves a clean tree to merge.
    await s.commit({}, 'submitted edit')
    await expect(s.push()).rejects.toThrow(/rejected/)
    await cycle(s)
    await expect(s.push()).resolves.toBeUndefined()
    expect(await s.log('HEAD')).toContain('maintainer fix')
    expect(await s.file('editor.txt')).toBe('saved\n')
  })

  describe('when the clone and GitHub each have commits', () => {
    it('heals a clone an earlier release rebased away from GitHub', async () => {
      await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
      // What the rebase loop left behind before it brought commits in.
      await s.advanceBase({ 'base2.txt': 'moved\n' })
      await s.clone.fetch(['origin', BASE])
      await s.clone.rebase(['FETCH_HEAD'])

      await cycle(s)

      const head = await s.head()
      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(head)
      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
      expect(await s.file('fix.txt')).toBe('fix\n')
      expect(await s.file('editor.txt')).toBe('v1\n')
    })

    it('merges a tip remote.git has not got, keeping both, for a push that can only fast-forward', async () => {
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      const github = await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })

      await cycle(s)

      const head = await s.head()
      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(head)
      const parents = (await s.clone.raw(['rev-list', '--parents', '-n1', head])).trim().split(' ')
      expect(parents.slice(1)).toContain(github)
      expect(await s.file('editor.txt')).toBe('v2\n')
      expect(await s.file('fix.txt')).toBe('fix\n')
    })

    it('ends the cycle for that branch, so no rebase replaces a merge GitHub has not received', async () => {
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
      await s.advanceBase({ 'base2.txt': 'moved\n' })

      await cycle(s)

      expect(await s.file('base2.txt')).toBeNull()
      expect((await readMeta(s))?.historyRewrittenFrom).toBeUndefined()
    })

    it('waits for a clean tree: a merge cannot be undone around saved work', async () => {
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
      await s.save({ 'other.txt': 'saved\n' })
      const before = await s.head()

      await cycle(s)

      expect(await s.head()).toBe(before)
      expect(await s.file('other.txt')).toBe('saved\n')
    })

    it("keeps the branch's version of a file both changed, and says so", async () => {
      await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await writeMeta(s, { pullRequestNumber: 7 })
      await s.moveGitHubOnly({ [ENTRY]: '{"title":"github"}\n', 'fix.txt': 'fix\n' })

      await cycle(s)

      expect(await s.file(ENTRY)).toBe('{"title":"editor"}\n')
      expect(await s.file('fix.txt')).toBe('fix\n')
      const meta = await readMeta(s)
      expect(meta?.conflictStatus).toBe('conflicts-detected')
      expect(meta?.conflictFiles).toEqual([CONFLICTED_ID])
      expect(meta?.keptOverGitHub).toEqual([ENTRY])
      expect(await queued(s, 'sync-pr-comments')).toEqual([BRANCH])
    })

    it('honours a delete on the branch over a change on GitHub', async () => {
      await fs.rm(path.join(s.branchPath, ENTRY))
      await s.clone.add(['-A'])
      await s.clone.commit('editor deleted the entry')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ [ENTRY]: '{"title":"github"}\n' })

      await cycle(s)

      expect(await s.file(ENTRY)).toBeNull()
      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(await s.head())
    })

    it('keeps a change on the branch over a delete on GitHub', async () => {
      await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.outside.fetch([
        '--force',
        'origin',
        `refs/remotes/github/${BRANCH}:refs/x/${BRANCH}-github`,
      ])
      await s.outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}-github`])
      await s.outside.raw(['rm', '-q', ENTRY])
      await s.outside.commit('deleted on GitHub')
      await s.outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])

      await cycle(s)

      expect(await s.file(ENTRY)).toBe('{"title":"editor"}\n')
    })

    it('handles a conflicted path with a space and an accent in its name', async () => {
      const name = 'content/café notes.txt'
      await s.commit({ [name]: 'editor\n' }, 'editor file')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ [name]: 'github\n' })

      await cycle(s)

      expect(await s.file(name)).toBe('editor\n')
      expect((await readMeta(s))?.keptOverGitHub).toEqual([name])
    })
  })

  describe('a branch rewritten on GitHub', () => {
    let lastSeen: string
    beforeEach(async () => {
      lastSeen = await s.head()
      await writeMeta(s, { lastGitHubTip: lastSeen })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.forcePushOnGitHub({ 'rewritten.txt': 'rewritten\n' })
    })

    it('is not merged, and the warning names the commit and stays', async () => {
      const before = await s.head()

      await cycle(s)
      const first = (await readMeta(s))?.rebaseFailure
      await cycle(s)

      expect(await s.head()).toBe(before)
      expect(await s.file('rewritten.txt')).toBeNull()
      expect(first?.message).toContain(lastSeen)
      expect((await readMeta(s))?.rebaseFailure?.message).toBe(first?.message)
      expect(await queued(s, 'push-branch')).toEqual([])
    })

    it('is warned about in review too', async () => {
      await writeMeta(s, { status: 'submitted' })
      const summary = await cycle(s)
      expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
      expect((await readMeta(s))?.rebaseFailure?.message).toContain(lastSeen)
    })

    it('resumes once a developer merges that commit back, as the warning says', async () => {
      await cycle(s)
      await s.outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
      await s.outside.raw(['merge', '--no-edit', '--allow-unrelated-histories', lastSeen])
      await s.outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])

      await cycle(s)

      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(await s.head())
      expect(await s.file('rewritten.txt')).toBe('rewritten\n')
    })
  })

  it('leaves a same-named GitHub branch alone when this deployment never published the branch', async () => {
    await writeMeta(s, { pushedToGitHubAt: undefined })
    const before = await s.head()
    await s.commitOnGitHub({ 'theirs.txt': 'theirs\n' })

    await cycle(s)

    expect(await s.head()).toBe(before)
    expect(await s.file('theirs.txt')).toBeNull()
  })

  it("leaves alone a branch.json that names another branch sharing this clone's directory", async () => {
    await writeMeta(s, { name: 'f/other' })
    const before = await s.head()
    await s.commitOnGitHub({ 'theirs.txt': 'theirs\n' })

    await cycle(s)

    expect(await s.head()).toBe(before)
    expect((await readMeta(s))?.lastGitHubTip).toBeUndefined()
  })

  it('keeps the warning about commits this clone lacks while their cause stands', async () => {
    await writeMeta(s, { pushedToGitHubAt: undefined })
    await s.commitOnGitHub({ 'theirs.txt': 'theirs\n' })
    await s.advanceBase({ 'base2.txt': 'moved\n' })
    const worker = makeWorker(s)

    await cycle(s, worker)
    const recorded = (await readMeta(s))?.rebaseFailure
    await cycle(s, worker)

    expect(recorded?.message).toContain('never had')
    expect((await readMeta(s))?.rebaseFailure?.message).toBe(recorded?.message)
  })

  it('takes nothing in while the base branch is held for an editor deploy', async () => {
    const worker = makeWorker(s)
    const report = (
      worker as unknown as { ensureStatusReport(): { baseHold?: unknown } }
    ).ensureStatusReport()
    report.baseHold = { missingSchemas: ['post'], since: '2026-10-01T00:00:00.000Z' }
    const before = await s.head()
    await s.commitOnGitHub({ 'fix.txt': 'fix\n' })

    await cycle(s, worker)

    expect(await s.head()).toBe(before)
    delete report.baseHold
    await cycle(s, worker)
    expect(await s.file('fix.txt')).toBe('fix\n')
  })

  describe('an approved branch', () => {
    beforeEach(async () => {
      await writeMeta(s, {
        status: 'approved',
        pullRequestNumber: 7,
        review: {
          state: 'approved',
          by: { userId: 'reviewer' },
          at: '2026-10-01T00:00:00.000Z',
        },
      })
    })

    it('stays approved when only the base came in: the diff is what was reviewed', async () => {
      await s.advanceBase({ 'base2.txt': 'moved\n' })
      await s.updateBranchOnGitHub()

      await cycle(s)

      const meta = await readMeta(s)
      expect(await s.file('base2.txt')).toBe('moved\n')
      expect(meta?.status).toBe('approved')
      expect(meta?.review?.state).toBe('approved')
      expect(await queued(s, 'sync-pr-comments')).toEqual([])
    })

    it('goes back to review when a real commit came in, and its verdict leaves the PR body', async () => {
      await s.commitOnGitHub({ 'fix.txt': 'fix\n' })

      await cycle(s)

      const meta = await readMeta(s)
      expect(meta?.status).toBe('submitted')
      expect(meta?.review).toBeUndefined()
      expect(await queued(s, 'sync-pr-comments')).toEqual([BRANCH])
    })
  })

  describe('a push from remote.git to GitHub', () => {
    it('leaves a pending rewrite to its own push: GitHub stands at the commit it replaced', async () => {
      const replaced = await s.head()
      await writeMeta(s, { historyRewrittenFrom: replaced, lastGitHubTip: replaced })
      await s.clone.commit('amended', [], { '--amend': null, '--allow-empty': null })
      await s.clone.raw(['push', '--force', 'origin', `${BRANCH}:${BRANCH}`])
      const rewritten = await s.head()

      await cycle(s)

      expect(await s.head()).toBe(rewritten)
      expect((await readMeta(s))?.historyRewrittenFrom).toBe(replaced)
    })

    it('is queued when remote.git is ahead with none in flight, and holds the rebase', async () => {
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.advanceBase({ 'base2.txt': 'moved\n' })

      await cycle(s)

      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
      expect(await s.file('base2.txt')).toBeNull()
    })

    it('is not queued again after it failed for good', async () => {
      await writeMeta(s, { syncStatus: 'sync-failed' })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])

      await cycle(s)

      expect(await queued(s, 'push-branch')).toEqual([])
    })
  })

  it('catches a clone up with a merge that reached remote.git before a crash', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    await cycle(s)
    const merged = await s.head()
    await s.clone.raw(['reset', '--hard', 'HEAD^1'])

    await cycle(s)

    expect(await s.head()).toBe(merged)
  })
})
