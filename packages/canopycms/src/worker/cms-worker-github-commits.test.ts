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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { SCHEMA_GENERATION_RESOURCE } from '../branch-schema-cache'
import { readResourceGeneration } from '../resource-generation'
import { listTasks } from '../task-queue/cms-task-queue'
import { initTestRepo, mockConsole } from '../test-utils'
import { useLocalGitHubGateway } from '../test-utils/worker-gateway'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import type { BranchMetadata } from '../types'
import type { BranchPolicyDescription } from './branch-policy'
import { CmsWorker } from './cms-worker'
import {
  REWRITTEN_PUSH_REFUSAL,
  SEEN_COMMIT_GONE_PUSH_REFUSAL,
  type GitHubSnapshot,
} from './github-commits'
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
  advanceBase(files: Record<string, string>, options?: { force?: boolean }): Promise<void>
  /** A commit in the clone, as submit makes, without the push. */
  commit(files: Record<string, string>, message?: string): Promise<void>
  /** What submit's push does. */
  push(): Promise<void>
  /** Write a saved edit, uncommitted. */
  save(files: Record<string, string>): Promise<void>
  /** A commit on GitHub's copy of the branch, reconciled into remote.git. */
  commitOnGitHub(
    files: Record<string, string>,
    message?: string,
    removes?: string[],
  ): Promise<string>
  /** GitHub's Update branch: base merged into GitHub's copy of the branch. */
  updateBranchOnGitHub(): Promise<string>
  /** GitHub moved, and remote.git's head has not: it is diverged, or this cycle has not reached it. */
  moveGitHubOnly(
    files: Record<string, string>,
    message?: string,
    removes?: string[],
  ): Promise<string>
  /** GitHub's Resolve conflicts: base merged into GitHub's copy, with `files` as a person chose. */
  resolveConflictOnGitHub(files: Record<string, string>): Promise<string>
  /** The push queued for a branch landing on GitHub; `stamp: false` dies before recording it. */
  landPushOnGitHub(options?: { stamp?: boolean }): Promise<void>
  /** GitHub's branch deleted. */
  dropGitHubBranch(): Promise<void>
  /** A second long-lived branch from base's tip. */
  createBranchOnBase(name: string): Promise<void>
  /** `name` gains a commit. */
  advanceReleaseBranch(name: string, files: Record<string, string>): Promise<void>
  /** `name` gains a commit, then is merged into GitHub's copy of the branch. */
  updateBranchFromGitHub(name: string, files: Record<string, string>): Promise<string>
  /** Replace GitHub's copy with a history that drops what it held. */
  forcePushOnGitHub(files: Record<string, string>): Promise<string>
  /** Move GitHub's copy back to `sha`. */
  resetOnGitHub(sha: string): Promise<void>
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
    async advanceBase(files, { force = false } = {}) {
      await write(seedPath, files)
      await seed.raw(['add', ...(force ? ['-f'] : []), '.'])
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
    async commitOnGitHub(files, message = 'maintainer fix', removes = []) {
      await outsideOnBranch()
      for (const file of removes) await outside.raw(['rm', '-q', file])
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
    async moveGitHubOnly(files, message = 'maintainer fix', removes = []) {
      await outside.fetch([
        '--force',
        'origin',
        `refs/remotes/github/${BRANCH}:refs/x/${BRANCH}-github`,
      ])
      await outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}-github`])
      for (const file of removes) await outside.raw(['rm', '-q', file])
      const sha = await outsideCommit(files, message)
      await outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])
      return sha
    },
    async resolveConflictOnGitHub(files) {
      await outsideOnBranch()
      await outside.fetch(['origin', BASE])
      await outside.raw(['merge', '--no-commit', '--no-ff', 'FETCH_HEAD']).catch(() => {})
      await write(outsidePath, files)
      await outside.add(['.'])
      await outside.raw(['commit', '-q', '-m', 'Merge main, resolved by hand'])
      await outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
      const sha = (await outside.revparse(['HEAD'])).trim()
      await trackGitHub(sha)
      return sha
    },
    async landPushOnGitHub({ stamp = true } = {}) {
      await trackGitHub(await setup.head())
      if (!stamp) return
      await writeMeta(setup, {
        pullRequestNumber: 7,
        lastGitHubTip: await setup.head(),
      })
    },
    async dropGitHubBranch() {
      await bare(['update-ref', '-d', `refs/remotes/github/${BRANCH}`])
    },
    async createBranchOnBase(name) {
      await seed.raw(['push', 'origin', `${BASE}:refs/heads/${name}`])
    },
    async advanceReleaseBranch(name, files) {
      await seed.fetch(['origin', name])
      await seed.raw(['checkout', '-q', '-B', name, 'FETCH_HEAD'])
      await write(seedPath, files)
      await seed.add(['.'])
      await seed.commit('commit on the other base')
      await seed.raw(['push', 'origin', `${name}:${name}`])
      await seed.raw(['checkout', '-q', BASE])
    },
    async updateBranchFromGitHub(name, files) {
      await setup.advanceReleaseBranch(name, files)
      await outsideOnBranch()
      await outside.fetch(['origin', name])
      await outside.raw(['merge', '--no-edit', 'FETCH_HEAD'])
      await outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
      const sha = (await outside.revparse(['HEAD'])).trim()
      await trackGitHub(sha)
      return sha
    },
    async forcePushOnGitHub(files) {
      await outside.fetch(['origin', BASE])
      await outside.raw(['checkout', '-q', '-B', 'work', 'FETCH_HEAD'])
      const sha = await outsideCommit(files, 'rewritten')
      await outside.raw(['push', '--force', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])
      return sha
    },
    async resetOnGitHub(sha) {
      await trackGitHub(sha)
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

const contains = async (s: Setup, commit: string, ancestor: string) =>
  (await s.clone.raw(['rev-list', '--count', `${commit}..${ancestor}`])).trim() === '0'

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
async function cycle(
  s: Setup,
  worker = makeWorker(s),
  options: { fetchedAt?: number; policy?: BranchPolicyDescription; tip?: string } = {},
): Promise<RebaseSummary> {
  const tip = options.tip ?? (await s.remoteSha(`refs/remotes/github/${BRANCH}`))
  const tips = new Map(tip === null ? [] : [[BRANCH, tip]])
  const seam = worker as unknown as {
    rebaseActiveBranches(
      policy: BranchPolicyDescription | undefined,
      gitHub: GitHubSnapshot,
    ): Promise<RebaseSummary>
  }
  return seam.rebaseActiveBranches(options.policy, {
    tips,
    fetchedAt: options.fetchedAt ?? Date.now(),
  })
}

const queued = async (s: Setup, action: string) =>
  (await listTasks(path.join(s.workspace, '.tasks'), 'pending'))
    .filter((t) => t.action === action)
    .map((t) => t.payload.branch)

/** A worker whose gateway answers each pull request read with `mergeableState`. */
function workerWithPullRequest(
  s: Setup,
  mergeableState: string,
  {
    state = 'open',
    base = BASE,
    onFetch,
  }: { state?: string; base?: string; onFetch?: () => Promise<unknown> } = {},
) {
  const worker = makeWorker(s)
  useLocalGitHubGateway(worker, {
    octokit: {
      pulls: {
        get: async () => {
          await onFetch?.()
          return {
            data: {
              merged: false,
              merged_at: null,
              state,
              node_id: 'PR_7',
              body: '',
              mergeable_state: mergeableState,
              head: { ref: BRANCH, repo: { id: 1 } },
              base: { ref: base, repo: { id: 1 } },
            },
          }
        },
      },
    } as never,
  })
  return worker
}

describe('an open pull request GitHub reports behind', () => {
  let tmpDir: string
  let s: Setup
  const submitted = { status: 'submitted', pullRequestNumber: 7 } as const

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-pr-behind-'))
    s = await createSetup(tmpDir)
    await s.commit({ 'editor.txt': 'v1\n' })
    await s.push()
    await writeMeta(s, submitted)
    await s.advanceBase({ 'base2.txt': 'moved\n' })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('merges the base and queues the push, leaving the branch in review', async () => {
    const before = await s.head()

    const summary = await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(summary.rebased).toEqual([BRANCH])
    expect(await s.file('base2.txt')).toBe('moved\n')
    expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(await s.head())
    expect(await queued(s, 'push-branch')).toEqual([BRANCH])
    expect((await readMeta(s))?.status).toBe('submitted')
    const parents = (await s.clone.raw(['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ')
    expect(parents[1]).toBe(before)
  })

  it('keeps an approval and the PR body, as the diff is what was reviewed', async () => {
    const review = {
      state: 'approved',
      by: { userId: 'r' },
      at: '2026-10-01T00:00:00.000Z',
    } as const
    await writeMeta(s, { ...submitted, status: 'approved', review })

    await cycle(s, workerWithPullRequest(s, 'behind'))

    const meta = await readMeta(s)
    expect(await s.file('base2.txt')).toBe('moved\n')
    expect(meta?.status).toBe('approved')
    expect(meta?.review?.state).toBe('approved')
    expect(await queued(s, 'sync-pr-comments')).toEqual([])
  })

  it('does nothing when GitHub reports anything else, so no adopter gets commits unasked', async () => {
    const before = await s.head()
    for (const state of ['clean', 'blocked', 'unstable', 'dirty', 'unknown', 'draft']) {
      await cycle(s, workerWithPullRequest(s, state))
    }
    expect(await s.head()).toBe(before)
    expect(await queued(s, 'push-branch')).toEqual([])
  })

  it('leaves a closed pull request, which GitHub still measures', async () => {
    await cycle(s, workerWithPullRequest(s, 'behind', { state: 'closed' }))

    expect(await s.file('base2.txt')).toBeNull()
    expect(await queued(s, 'push-branch')).toEqual([])
  })

  it('leaves a pull request retargeted to another base, under its approval', async () => {
    await cycle(s, workerWithPullRequest(s, 'behind', { base: 'release' }))

    expect(await s.file('base2.txt')).toBeNull()
    expect(await queued(s, 'push-branch')).toEqual([])
  })

  it('leaves a branch whose sync failed, as a push would clear that failure', async () => {
    await writeMeta(s, { ...submitted, syncStatus: 'sync-failed', syncFailureReason: 'x' })

    await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(await s.file('base2.txt')).toBeNull()
    expect((await readMeta(s))?.syncFailureReason).toBe('x')
  })

  it('reports a refused update in the summary, with no failure to reset each cycle', async () => {
    await s.advanceBase({ '.canopy-meta/state.json': '{}\n' }, { force: true })

    const summary = await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect((await readMeta(s))?.rebaseFailure).toBeUndefined()
  })

  describe('what the branch card is told', () => {
    it('records a conflict GitHub reports, and clears it once GitHub stops', async () => {
      await cycle(s, workerWithPullRequest(s, 'dirty'))
      expect((await readMeta(s))?.pullRequestHold).toEqual({ kind: 'conflicts' })

      await cycle(s, workerWithPullRequest(s, 'clean'))
      expect((await readMeta(s))?.pullRequestHold).toBeUndefined()
    })

    it('records a pull request retargeted while it is behind, naming the base', async () => {
      await cycle(s, workerWithPullRequest(s, 'behind', { base: 'release' }))
      expect((await readMeta(s))?.pullRequestHold).toEqual({ kind: 'retargeted', base: 'release' })
    })

    it('keeps a hold while GitHub is still working the state out', async () => {
      await cycle(s, workerWithPullRequest(s, 'dirty'))
      const before = await BranchMetadataFileManager.loadOnly(s.branchPath)

      await cycle(s, workerWithPullRequest(s, 'unknown'))

      const after = await BranchMetadataFileManager.loadOnly(s.branchPath)
      expect(after?.branch.pullRequestHold).toEqual({ kind: 'conflicts' })
      expect(after?.version).toBe(before?.version)
    })

    it('calls a conflict on a retargeted pull request retargeted, as withdrawing cannot fix it', async () => {
      await cycle(s, workerWithPullRequest(s, 'dirty', { base: 'release' }))
      expect((await readMeta(s))?.pullRequestHold).toEqual({ kind: 'retargeted', base: 'release' })
    })

    it('leaves the time editors read as the last edit alone', async () => {
      await writeMeta(s, { ...submitted, pullRequestState: 'open' })
      const before = (await readMeta(s))?.updatedAt
      await cycle(s, workerWithPullRequest(s, 'dirty'))
      expect((await readMeta(s))?.pullRequestHold).toEqual({ kind: 'conflicts' })
      expect((await readMeta(s))?.lastGitHubTip).toBeDefined()
      expect((await readMeta(s))?.updatedAt).toBe(before)
    })

    it('records nothing for a pull request retargeted but not behind', async () => {
      await cycle(s, workerWithPullRequest(s, 'clean', { base: 'release' }))
      expect((await readMeta(s))?.pullRequestHold).toBeUndefined()
    })

    it('records nothing about a pull request a newer submit replaced as it was measured', async () => {
      const resubmitted = '2026-10-02T00:00:00.000Z'
      await writeMeta(s, { ...submitted, submittedAt: '2026-10-01T00:00:00.000Z' })
      const worker = workerWithPullRequest(s, 'dirty', {
        onFetch: () => writeMeta(s, { ...submitted, submittedAt: resubmitted }),
      })

      await cycle(s, worker)

      expect((await readMeta(s))?.submittedAt).toBe(resubmitted)
      expect((await readMeta(s))?.pullRequestHold).toBeUndefined()
    })

    it('records nothing for a closed pull request', async () => {
      await cycle(s, workerWithPullRequest(s, 'dirty', { state: 'closed' }))
      expect((await readMeta(s))?.pullRequestHold).toBeUndefined()
    })

    it('writes once, not every cycle a hold stands', async () => {
      const worker = workerWithPullRequest(s, 'dirty')
      await cycle(s, worker)
      const version = (await BranchMetadataFileManager.loadOnly(s.branchPath))?.version
      await cycle(s, worker)
      expect((await BranchMetadataFileManager.loadOnly(s.branchPath))?.version).toBe(version)
    })
  })

  it('leaves a conflict as it is, with nothing recorded as kept', async () => {
    await s.advanceBase({ 'editor.txt': 'base edit\n' })
    const before = await s.head()

    const summary = await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(await s.head()).toBe(before)
    expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(before)
    expect(summary.failed).toEqual([])
    expect((await readMeta(s))?.conflictFiles).toBeUndefined()
    expect((await readMeta(s))?.keptOverGitHub).toBeUndefined()
  })

  it('waits while a push is on its way, as GitHub is not at the clone', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])

    await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(await s.file('base2.txt')).toBeNull()
  })

  it('takes nothing in while the base branch is held for an editor deploy', async () => {
    const worker = workerWithPullRequest(s, 'behind')
    const report = (
      worker as unknown as { ensureStatusReport(): { baseHold?: unknown } }
    ).ensureStatusReport()
    report.baseHold = { missingSchemas: ['post'], since: '2026-10-01T00:00:00.000Z' }

    await cycle(s, worker)

    expect(await s.file('base2.txt')).toBeNull()
  })

  it('leaves a branch the gateway would refuse', async () => {
    await cycle(s, workerWithPullRequest(s, 'behind'), {
      policy: {
        configured: [],
        githubDefault: null,
        namespace: 'canopycms/prod/',
        legacy: [],
        settingsBranch: null,
      },
    })
    expect(await s.file('base2.txt')).toBeNull()
  })

  it('leaves a branch whose tree holds work, which a merge could not protect', async () => {
    await s.save({ 'stray.txt': 'stray\n' })
    await cycle(s, workerWithPullRequest(s, 'behind'))
    expect(await s.file('base2.txt')).toBeNull()
  })

  it('does nothing when the clone already has the base', async () => {
    await s.clone.fetch(['origin', BASE])
    await s.clone.raw(['merge', '--no-edit', 'FETCH_HEAD'])
    await s.push()
    const before = await s.head()

    await cycle(s, workerWithPullRequest(s, 'behind'))

    expect(await s.head()).toBe(before)
  })

  it('merges the base the branch forked from, not the default', async () => {
    await s.createBranchOnBase('release')
    await s.advanceReleaseBranch('release', { 'release.txt': 'moved\n' })
    await writeMeta(s, { ...submitted, baseBranch: 'release' })

    await cycle(s, workerWithPullRequest(s, 'behind', { base: 'release' }))

    expect(await s.file('release.txt')).toBe('moved\n')
  })

  it('leaves a branch to the next cycle while a content write holds its lock', async () => {
    const worker = workerWithPullRequest(s, 'behind')
    await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    await cycle(s, worker)
    const before = await s.head()
    const release = await tryAcquireContentWriteLock(s.branchPath, () => {})
    try {
      const summary = await cycle(s, worker)
      expect(summary.skippedLocked).toEqual([BRANCH])
      expect(await s.head()).toBe(before)
    } finally {
      await release()
    }
  })
})

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

    it('still has the conflict record when the clone only caught up on the next cycle', async () => {
      await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ [ENTRY]: '{"title":"github"}\n' })
      // The merge is published, then the clone cannot move: as after a crash at that step.
      const lock = path.join(s.branchPath, '.git', 'index.lock')
      await fs.writeFile(lock, '')
      await cycle(s)
      await fs.rm(lock)

      await cycle(s)

      expect(await s.head()).toBe(await s.remoteSha(`refs/heads/${BRANCH}`))
      expect((await readMeta(s))?.conflictFiles).toEqual([CONFLICTED_ID])
      expect((await readMeta(s))?.keptOverGitHub).toEqual([ENTRY])
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

    it('refuses pushes until then, and says which commit is missing', async () => {
      await cycle(s)
      expect((await readMeta(s))?.rewrittenOnGitHub).toBe(lastSeen)
    })

    it('resumes once a developer merges that commit back, as the warning says', async () => {
      await cycle(s)
      await s.outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
      await s.outside.raw(['merge', '--no-edit', '--allow-unrelated-histories', lastSeen])
      await s.outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])

      await cycle(s)

      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(await s.head())
      expect(await s.file('rewritten.txt')).toBe('rewritten\n')
      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
    })
  })

  describe('a branch reset to an earlier commit on GitHub', () => {
    let removed: string
    let kept: string
    beforeEach(async () => {
      kept = await s.head()
      await s.commit({ 'leak.txt': 'secret\n' }, 'bad commit')
      await s.push()
      removed = await s.head()
      await writeMeta(s, { lastGitHubTip: removed })
      await s.outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
      await s.outside.raw(['push', '--force', 'origin', `${kept}:refs/remotes/github/${BRANCH}`])
    })

    it('does not push the removed commit back, and keeps the evidence', async () => {
      await cycle(s)

      const meta = await readMeta(s)
      expect(await queued(s, 'push-branch')).toEqual([])
      expect(meta?.lastGitHubTip).toBe(removed)
      expect(meta?.rewrittenOnGitHub).toBe(removed)
      expect(meta?.rebaseFailure?.message).toContain(removed)
    })

    it('holds for a branch in review too', async () => {
      await writeMeta(s, { status: 'submitted', lastGitHubTip: removed })
      const summary = await cycle(s)
      expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
      expect(await queued(s, 'push-branch')).toEqual([])
    })

    it('reads a push that landed after the fetch as old news, not a rewrite', async () => {
      await writeMeta(s, { lastGitHubTip: removed, pushedToGitHubAt: new Date().toISOString() })

      const summary = await cycle(s, makeWorker(s), { fetchedAt: Date.now() - 60_000 })

      expect(summary.failed).toEqual([])
      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
      expect(await queued(s, 'push-branch')).toEqual([])
    })
  })

  describe("the worker's own rewrite", () => {
    let replaced: string
    beforeEach(async () => {
      replaced = await s.head()
      await writeMeta(s, { lastGitHubTip: replaced })
      await s.advanceBase({ 'base2.txt': 'moved\n' })
      await cycle(s)
      expect((await readMeta(s))?.historyRewrittenFrom).toBe(replaced)
    })

    it('stays a rewrite of its own when the push landed and died before its stamp', async () => {
      await s.landPushOnGitHub({ stamp: false })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])

      const summary = await cycle(s)

      expect(summary.failed).toEqual([])
      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
    })

    it('stays one with a maintainer commit on top of it and a submit', async () => {
      await s.landPushOnGitHub({ stamp: false })
      await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')

      const summary = await cycle(s)

      expect(summary.failed).toEqual([])
      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
      expect(await s.file('fix.txt')).toBe('fix\n')
    })

    it('merges a commit GitHub gained on the replaced history, which is no rewrite', async () => {
      await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })

      const summary = await cycle(s)

      expect(summary.failed).toEqual([])
      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
      expect(await s.file('fix.txt')).toBe('fix\n')
    })

    it('is still told from a force-push while its own push is pending', async () => {
      await s.forcePushOnGitHub({ 'rewritten.txt': 'rewritten\n' })

      await cycle(s)

      // The commit GitHub held, not the rewrite's, which never reached it.
      expect((await readMeta(s))?.rewrittenOnGitHub).toBe(replaced)
    })
  })

  describe('ways out of a recorded rewrite', () => {
    const flag = 'a'.repeat(40)

    it('clears when GitHub stands at a commit it was known to hold again', async () => {
      const held = await s.head()
      await writeMeta(s, { rewrittenOnGitHub: flag, lastGitHubTip: held })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')

      await cycle(s)

      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
    })

    for (const status of ['editing', 'submitted'] as const) {
      it(`clears for a ${status} branch when GitHub no longer has the branch`, async () => {
        await writeMeta(s, {
          status,
          rewrittenOnGitHub: flag,
          rebaseFailure: { message: 'x', firstAt: 'y', lastAt: 'y' },
        })
        await s.dropGitHubBranch()

        await cycle(s)

        const meta = await readMeta(s)
        expect(meta?.rewrittenOnGitHub).toBeUndefined()
      })
    }

    it('clears the text a push refused before any sync saw the rewrite', async () => {
      await writeMeta(s, {
        syncStatus: 'sync-failed',
        syncFailureReason: SEEN_COMMIT_GONE_PUSH_REFUSAL,
        rewrittenOnGitHub: flag,
        lastGitHubTip: await s.head(),
      })

      await cycle(s)

      const meta = await readMeta(s)
      expect(meta?.rewrittenOnGitHub).toBeUndefined()
      expect(meta?.syncFailureReason).toBeUndefined()
    })

    describe("the failed sync a rewrite's refused push left", () => {
      const refused = {
        syncStatus: 'sync-failed',
        syncFailureReason: REWRITTEN_PUSH_REFUSAL,
      } as const

      describe('on a branch in review whose submit never finished', () => {
        const inReview = {
          ...refused,
          status: 'submitted',
          pullRequestNumber: 7,
          submitUnfinished: true,
        } as const

        for (const status of ['submitted', 'approved'] as const) {
          it(`stays failed when ${status}, for a retry to run the PR step, without the false reason`, async () => {
            await writeMeta(s, {
              ...inReview,
              status,
              rewrittenOnGitHub: flag,
              lastGitHubTip: await s.head(),
            })

            await cycle(s)

            const meta = await readMeta(s)
            expect(meta?.rewrittenOnGitHub).toBeUndefined()
            expect(meta?.syncStatus).toBe('sync-failed')
            expect(meta?.syncFailureReason).toBeUndefined()
          })
        }
      })

      it('clears on a branch in review when only a plain push was refused', async () => {
        await writeMeta(s, {
          ...refused,
          status: 'submitted',
          pullRequestNumber: 7,
          rewrittenOnGitHub: flag,
          lastGitHubTip: await s.head(),
        })

        await cycle(s)

        expect((await readMeta(s))?.syncStatus).toBe('synced')
      })

      it('clears with a rewrite GitHub stands past', async () => {
        const held = await s.head()
        await writeMeta(s, { ...refused, rewrittenOnGitHub: flag, lastGitHubTip: held })
        await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')

        await cycle(s)

        const meta = await readMeta(s)
        expect(meta?.syncStatus).toBe('synced')
        expect(meta?.syncFailureReason).toBeUndefined()
      })

      it('clears with a rewrite GitHub is back from', async () => {
        await writeMeta(s, { ...refused, rewrittenOnGitHub: flag, lastGitHubTip: await s.head() })

        await cycle(s)

        expect((await readMeta(s))?.syncStatus).toBe('synced')
      })

      for (const [status, after] of [
        ['editing', 'synced'],
        ['submitted', 'sync-failed'],
      ] as const) {
        it(`drops the reason on a ${status} branch GitHub no longer has`, async () => {
          await writeMeta(s, {
            ...refused,
            status,
            submitUnfinished: true,
            rewrittenOnGitHub: flag,
          })
          await s.dropGitHubBranch()

          await cycle(s)

          expect((await readMeta(s))?.syncFailureReason).toBeUndefined()
          expect((await readMeta(s))?.syncStatus).toBe(after)
        })
      }

      it('leaves any other failure, which says what still needs doing', async () => {
        const syncFailureReason = 'Push rejected.'
        await writeMeta(s, {
          syncStatus: 'sync-failed',
          syncFailureReason,
          rewrittenOnGitHub: flag,
          lastGitHubTip: await s.head(),
        })

        await cycle(s)

        const meta = await readMeta(s)
        expect(meta?.rewrittenOnGitHub).toBeUndefined()
        expect(meta?.syncStatus).toBe('sync-failed')
        expect(meta?.syncFailureReason).toBe(syncFailureReason)
      })
    })

    it('clears when GitHub is back exactly at the last tip seen', async () => {
      await writeMeta(s, { rewrittenOnGitHub: flag, lastGitHubTip: await s.head() })

      await cycle(s)

      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
    })

    it('sends a pending rewrite on from a branch in review when GitHub is back at its commit', async () => {
      const replaced = await s.head()
      await s.clone.commit('amended', [], { '--amend': null, '--allow-empty': null })
      await s.clone.raw(['push', '--force', 'origin', `${BRANCH}:${BRANCH}`])
      await writeMeta(s, {
        status: 'submitted',
        historyRewrittenFrom: replaced,
        lastGitHubTip: await s.head(),
        rewrittenOnGitHub: replaced,
        syncStatus: 'sync-failed',
      })

      await cycle(s)

      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
    })

    it('queues the push a failed one stranded, once the rewrite is resolved', async () => {
      const held = await s.head()
      await writeMeta(s, {
        rewrittenOnGitHub: flag,
        lastGitHubTip: held,
        syncStatus: 'sync-failed',
      })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])

      await cycle(s)

      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
    })

    it('writes the record once, not every cycle a rewrite stands', async () => {
      const kept = await s.head()
      await writeMeta(s, { lastGitHubTip: kept })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.forcePushOnGitHub({ 'rewritten.txt': 'rewritten\n' })
      await cycle(s)
      const version = (await BranchMetadataFileManager.loadOnly(s.branchPath))?.version
      await cycle(s)
      expect((await BranchMetadataFileManager.loadOnly(s.branchPath))?.version).toBe(version)
    })
  })

  it('waits on a tip whose commit never reached this clone, rather than call it a rewrite', async () => {
    await writeMeta(s, { lastGitHubTip: await s.head() })
    const summary = await cycle(s, makeWorker(s), { tip: 'c'.repeat(40) })
    expect(summary.failed).toEqual([])
    expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
  })

  it('keeps a stamp from a push that landed after the cycle read the branch', async () => {
    await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    const pushed = 'b'.repeat(40)
    const realLoad = BranchMetadataFileManager.loadOnly.bind(BranchMetadataFileManager)
    let reads = 0
    const load = vi.spyOn(BranchMetadataFileManager, 'loadOnly')
    // The review check's fresh read comes after the cycle's own, ahead of the stamp.
    load.mockImplementation(async (root) => {
      if (++reads === 2) await writeMeta(s, { lastGitHubTip: pushed })
      return realLoad(root)
    })

    await cycle(s)
    load.mockRestore()

    expect((await readMeta(s))?.lastGitHubTip).toBe(pushed)
  })

  it('leaves a branch as it is when a git call fails, rather than call it a rewrite', async () => {
    // A last-seen commit whose parent is gone: it reads fine, and `rev-list` over it exits 128.
    const tree = (await s.clone.revparse(['HEAD^{tree}'])).trim()
    const parent = (await s.clone.raw(['commit-tree', tree, '-m', 'parent'])).trim()
    const lastSeen = (await s.clone.raw(['commit-tree', tree, '-p', parent, '-m', 'x'])).trim()
    await fs.rm(path.join(s.branchPath, '.git/objects', parent.slice(0, 2), parent.slice(2)))
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    const review = {
      state: 'approved',
      by: { userId: 'r' },
      at: '2026-10-01T00:00:00.000Z',
    } as const
    await writeMeta(s, {
      status: 'approved',
      pullRequestNumber: 7,
      lastGitHubTip: lastSeen,
      review,
    })
    const before = await s.head()

    const summary = await cycle(s)

    const meta = await readMeta(s)
    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect(meta?.rewrittenOnGitHub).toBeUndefined()
    expect(meta?.status).toBe('approved')
    expect(await s.head()).toBe(before)
    expect(await queued(s, 'push-branch')).toEqual([])
  })

  it('leaves a branch as it is when a git call dies with no answer', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    const lastSeen = 'e'.repeat(40)
    await writeMeta(s, { lastGitHubTip: lastSeen })
    // simple-git resolves empty on a killed git, so this is one with nothing on stderr.
    const proto = Object.getPrototypeOf(s.clone) as { raw(args: string[]): Promise<string> }
    const raw = proto.raw
    const killed = vi.spyOn(proto, 'raw').mockImplementation(function (
      this: SimpleGit,
      args: string[],
    ) {
      if (args[0] === 'rev-parse' && args.at(-1)?.startsWith(lastSeen)) return Promise.resolve('')
      return raw.call(this, args)
    })

    const summary = await cycle(s)
    killed.mockRestore()

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
  })

  it('calls nothing a rewrite until the tip is read through', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    await writeMeta(s, { lastGitHubTip: 'e'.repeat(40) })
    const proto = Object.getPrototypeOf(s.clone) as { raw(args: string[]): Promise<string> }
    const raw = proto.raw
    const killed = vi.spyOn(proto, 'raw').mockImplementation(function (
      this: SimpleGit,
      args: string[],
    ) {
      if (args[0] === 'rev-list' && args[1] === '--count') return Promise.resolve('')
      return raw.call(this, args)
    })

    const summary = await cycle(s)
    killed.mockRestore()

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
  })

  it('takes the first force-push it sees on an unrecorded branch for what it is', async () => {
    const kept = await s.head()
    const removed = await s.commitOnGitHub({ 'leak.txt': 'secret\n' })
    await writeMeta(s)
    await s.forcePushOnGitHub({ 'rewritten.txt': 'rewritten\n' })

    await cycle(s)

    expect(await s.head()).toBe(kept)
    expect((await readMeta(s))?.rewrittenOnGitHub).toBe(removed)
    expect(await queued(s, 'push-branch')).toEqual([])
  })

  describe('a branch whose push failed for good', () => {
    let pushed: string
    let unpushed: string
    beforeEach(async () => {
      pushed = await s.head()
      await writeMeta(s, { lastGitHubTip: pushed })
      await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      unpushed = await s.head()
      await writeMeta(s, { lastGitHubTip: pushed, syncStatus: 'sync-failed' })
      await s.advanceBase({ 'base2.txt': 'moved\n' })
    })

    it('takes the base by a merge, as a rebase would replace what GitHub never received', async () => {
      await cycle(s)

      const meta = await readMeta(s)
      expect(await s.file('base2.txt')).toBe('moved\n')
      expect(await contains(s, await s.head(), unpushed)).toBe(true)
      expect(meta?.historyRewrittenFrom).toBeUndefined()
      expect(meta?.lastGitHubTip).toBe(pushed)
      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
    })

    it('reads as nothing wrong on the next cycle, with the merge on its way', async () => {
      await cycle(s)
      await cycle(s)

      expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
      expect(await queued(s, 'push-branch')).toEqual([BRANCH])
    })
  })

  it('reads a removal as one after a crash left a merge in remote.git ahead of the clone', async () => {
    const kept = await s.head()
    await writeMeta(s, { lastGitHubTip: kept })
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    const before = await s.head()
    const removed = await s.moveGitHubOnly({ 'leak.txt': 'secret\n' })
    // Holds git off the clone's index, as a crash does at the same point: the merge is built and
    // published, and the clone can't follow.
    const lock = path.join(s.branchPath, '.git/index.lock')
    await fs.writeFile(lock, '')
    await cycle(s)
    await fs.rm(lock)
    expect(await s.head()).toBe(before)
    expect((await readMeta(s))?.lastGitHubTip).toBe(removed)

    await s.resetOnGitHub(kept)
    await cycle(s)

    expect((await readMeta(s))?.rewrittenOnGitHub).toBe(removed)
    expect(await s.head()).toBe(before)
    expect(await s.file('leak.txt')).toBeNull()
  })

  it('stays level with remote.git when reconcile left it behind this tip', async () => {
    const before = await s.head()
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })

    const summary = await cycle(s)

    expect(summary.failed).toEqual([])
    expect(await s.head()).toBe(before)
  })

  it('moves the schema marker off a tree a rebase abandoned', async () => {
    const read = async () => {
      const result = await readResourceGeneration(s.branchPath, SCHEMA_GENERATION_RESOURCE)
      return result.ok ? result.token : undefined
    }
    await s.advanceBase({ 'editor.txt': 'base changed\n' })
    const worker = makeWorker(s)
    let midRebase: string | null | undefined
    const seam = worker as unknown as { afterConflictDetectedForTesting: () => Promise<void> }
    seam.afterConflictDetectedForTesting = async () => {
      midRebase = await read()
      throw new Error('stopped mid-rebase')
    }

    const summary = await cycle(s, worker)

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect(await s.file('editor.txt')).toBe('v1\n')
    expect(await read()).not.toBe(midRebase)
  })

  it('moves the schema marker before the clone, so no lost write leaves it behind the tree', async () => {
    const read = async () => {
      const result = await readResourceGeneration(s.branchPath, SCHEMA_GENERATION_RESOURCE)
      return result.ok ? result.token : undefined
    }
    await s.commitOnGitHub({ 'editor.txt': 'github\n' })
    await s.save({ 'editor.txt': 'saved\n' })
    const before = await read()
    const head = await s.head()

    await cycle(s)

    expect(await s.head()).toBe(head)
    expect(await read()).not.toBe(before)
  })

  it('fast-forwards past a last-seen commit a rebase of its own replaced', async () => {
    // A tip that contains the clone restores nothing, wherever the record points.
    const fix = await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    await writeMeta(s, { lastGitHubTip: 'a'.repeat(40) })

    await cycle(s)

    expect(await s.head()).toBe(fix)
  })

  describe('a branch whose history holds a merge', () => {
    beforeEach(async () => {
      await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await writeMeta(s, { pullRequestNumber: 7 })
      await s.moveGitHubOnly({ [ENTRY]: '{"title":"github"}\n' })
      await cycle(s)
      await s.landPushOnGitHub()
    })

    it('keeps the version the merge kept when the base moves, with no force-push', async () => {
      await s.advanceBase({ 'base2.txt': 'moved\n' })

      const summary = await cycle(s)

      expect(summary.rebased).toEqual([BRANCH])
      expect(await s.file(ENTRY)).toBe('{"title":"editor"}\n')
      expect(await s.file('base2.txt')).toBe('moved\n')
      expect((await readMeta(s))?.historyRewrittenFrom).toBeUndefined()
      expect(await s.remoteSha(`refs/heads/${BRANCH}`)).toBe(await s.head())
      expect(await queued(s, 'push-branch')).toContain(BRANCH)
    })

    it('keeps a deleted entry deleted when the base moves', async () => {
      await fs.rm(path.join(s.branchPath, ENTRY))
      await s.clone.add(['-A'])
      await s.clone.commit('editor deleted the entry')
      await s.push()
      await s.advanceBase({ 'base2.txt': 'moved\n' })

      await cycle(s)

      expect(await s.file(ENTRY)).toBeNull()
    })
  })

  it("keeps a maintainer's conflict resolution when the base moves", async () => {
    await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
    await s.push()
    await s.advanceBase({ [ENTRY]: '{"title":"base"}\n' })
    // GitHub's Resolve conflicts: base merged in, and a person chose the content.
    await s.resolveConflictOnGitHub({ [ENTRY]: '{"title":"resolved"}\n' })
    await cycle(s)
    expect(await s.file(ENTRY)).toBe('{"title":"resolved"}\n')

    await s.advanceBase({ 'base2.txt': 'moved\n' })
    await cycle(s)

    expect(await s.file(ENTRY)).toBe('{"title":"resolved"}\n')
    expect((await readMeta(s))?.historyRewrittenFrom).toBeUndefined()
  })

  describe('conflicts no rule settles', () => {
    it("keeps the editor's text at the new name when GitHub renamed and changed the file", async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
      const text = (first: string) => [first, ...lines].join('\n') + '\n'
      await s.commit({ 'content/long.txt': text('original') }, 'long file')
      await s.push()
      await s.commit({ 'content/long.txt': text('editor') }, 'editor edit')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ 'content/renamed.txt': text('github') }, 'renamed', [
        'content/long.txt',
      ])

      await cycle(s)

      expect(await s.file('content/renamed.txt')).toBe(text('editor'))
      expect(await s.file('content/long.txt')).toBeNull()
      expect((await readMeta(s))?.keptOverGitHub).toEqual(['content/renamed.txt'])
    })

    it('touches nothing when a file on one side meets a directory on the other', async () => {
      await s.commit({ 'content/x': 'editor\n' }, 'editor file')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ 'content/x/y': 'github\n' })
      const before = await s.head()

      const summary = await cycle(s)

      expect(await s.head()).toBe(before)
      expect(await s.file('content/x')).toBe('editor\n')
      expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
      expect((await readMeta(s))?.rebaseFailure?.message).toContain('CONFLICT (file/directory)')
      expect(await queued(s, 'push-branch')).toEqual([])
    })

    it('keeps a conflicted path that starts with a colon', async () => {
      await s.commit({ ':weird.md': 'editor\n' }, 'editor file')
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.moveGitHubOnly({ ':weird.md': 'github\n' })

      await cycle(s)

      expect(await s.file(':weird.md')).toBe('editor\n')
    })
  })

  it('refuses a commit that stops tracking canopycms state, which would delete the live file', async () => {
    await writeMeta(s, {})
    await s.clone.raw(['add', '-f', '.canopy-meta/branch.json'])
    await s.clone.commit('tracked by mistake')
    await s.push()
    await writeMeta(s, {})
    const before = await s.head()
    await s.outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
    await s.outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}`])
    await s.outside.raw(['rm', '-q', '--cached', '.canopy-meta/branch.json'])
    await s.outside.commit('stop tracking it')
    await s.outside.raw(['push', 'origin', `HEAD:refs/remotes/github/${BRANCH}`])
    await s.outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
    await s.advanceBase({ 'base2.txt': 'moved\n' })

    const summary = await cycle(s)

    expect(await s.head()).toBe(before)
    expect(summary.failed[0]?.error).toContain('manual repair')
    expect((await readMeta(s))?.name).toBe(BRANCH)
  })

  it('takes in the removal of the retired schema cache, which nothing reads', async () => {
    await s.save({ '.canopy-meta/schema-cache.json': '{}\n' })
    await s.clone.raw(['add', '-f', '.canopy-meta/schema-cache.json'])
    await s.clone.commit('old cache')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.landPushOnGitHub()
    await writeMeta(s, {})
    const tip = await s.commitOnGitHub({}, 'drop the cache', ['.canopy-meta/schema-cache.json'])

    const summary = await cycle(s)

    expect(summary.failed).toEqual([])
    expect(await s.head()).toBe(tip)
  })

  it('keeps the live file when a branch added then removed it and the base moves', async () => {
    await s.commitOnGitHub({ '.canopy-meta/branch.json': '{"branch":{"status":"approved"}}\n' })
    await s.commitOnGitHub({}, 'took it out again', ['.canopy-meta/branch.json'])
    await writeMeta(s, { pullRequestNumber: 7 })
    await cycle(s)
    await s.advanceBase({ 'base2.txt': 'moved\n' })

    const summary = await cycle(s)

    expect(summary.failed).toEqual([])
    expect((await readMeta(s))?.name).toBe(BRANCH)
    expect(await s.file('base2.txt')).toBe('moved\n')
    expect((await readMeta(s))?.historyRewrittenFrom).toBeUndefined()
  })

  it('names a path from a commit on one line, however the path is written', async () => {
    await s.commitOnGitHub({ '.canopy-meta/a\nb.json': 'x\n' })

    const summary = await cycle(s)

    expect(summary.failed[0].error).toContain('a\\nb.json')
    expect(summary.failed[0].error).not.toContain('\n')
  })

  it('refuses commits carrying canopycms state, leaving live metadata untouched', async () => {
    const before = await s.head()
    await s.commitOnGitHub({ '.canopy-meta/branch.json': '{"branch":{"status":"approved"}}\n' })

    const summary = await cycle(s)

    expect(await s.head()).toBe(before)
    expect((await readMeta(s))?.status).toBe('editing')
    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect((await readMeta(s))?.rebaseFailure?.message).toContain('.canopy-meta/branch.json')
  })

  it('reports a fast-forward that failed for any reason but saved edits', async () => {
    await s.commitOnGitHub({ 'fix.txt': 'fix\n' })
    await s.save({ 'editor.txt': 'saved\n' })
    await fs.writeFile(path.join(s.branchPath, '.git', 'index.lock'), '')

    const summary = await cycle(s)

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
  })

  it('makes no merge for a branch the gateway would refuse', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    const before = await s.head()

    await cycle(s, makeWorker(s), {
      policy: {
        configured: [],
        githubDefault: null,
        namespace: 'canopycms/prod/',
        legacy: [],
        settingsBranch: null,
      },
    })

    expect(await s.head()).toBe(before)
  })

  it('blocks a merge remote.git would refuse, which only a person can sort out', async () => {
    await s.commit({ 'editor.txt': 'v2\n' }, 'resubmitted')
    await s.moveGitHubOnly({ 'fix.txt': 'fix\n' })
    // remote.git's head holds a commit neither the clone nor GitHub has.
    await s.outside.fetch(['--force', 'origin', `refs/heads/${BRANCH}:refs/x/${BRANCH}`])
    await s.outside.raw(['checkout', '-q', '-B', 'work', `refs/x/${BRANCH}`])
    await s.outside.commit('stray', [], { '--allow-empty': null })
    await s.outside.raw(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
    await s.commit({ [ENTRY]: '{"title":"editor"}\n' }, 'editor entry')
    await s.moveGitHubOnly({ [ENTRY]: '{"title":"github"}\n' })

    const summary = await cycle(s)

    expect(summary.failed.map((f) => f.branch)).toEqual([BRANCH])
    expect((await readMeta(s))?.rebaseFailure?.message).toContain('cannot be published')
    expect((await readMeta(s))?.keptOverGitHub).toBeUndefined()
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

  it('treats a rewrite of a branch never pushed to GitHub as unpublished still', async () => {
    await writeMeta(s, { pushedToGitHubAt: undefined, lastGitHubTip: 'a'.repeat(40) })
    await s.commitOnGitHub({ 'theirs.txt': 'theirs\n' })

    await cycle(s)

    expect(await s.file('theirs.txt')).toBeNull()
    expect((await readMeta(s))?.rewrittenOnGitHub).toBeUndefined()
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

    it('loses its approval when a tip cannot be brought in, since nobody approved that tip', async () => {
      const kept = await s.head()
      await writeMeta(s, {
        status: 'approved',
        pullRequestNumber: 7,
        lastGitHubTip: kept,
        review: { state: 'approved', by: { userId: 'r' }, at: '2026-10-01T00:00:00.000Z' },
      })
      await s.forcePushOnGitHub({ 'rewritten.txt': 'rewritten\n' })

      await cycle(s)

      const meta = await readMeta(s)
      expect(meta?.status).toBe('submitted')
      expect(meta?.review).toBeUndefined()
      expect(await queued(s, 'sync-pr-comments')).toEqual([BRANCH])
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

    it('goes back to review when a merge commit itself changed the reviewed content', async () => {
      await s.advanceBase({ 'base2.txt': 'moved\n' })
      await s.resolveConflictOnGitHub({ 'editor.txt': 'changed in the merge\n' })

      await cycle(s)

      expect(await s.file('editor.txt')).toBe('changed in the merge\n')
      expect((await readMeta(s))?.status).toBe('submitted')
    })

    it('goes back to review when a person settled a conflict with the base, whatever side they took', async () => {
      const seeded = await fs.readFile(path.join(s.branchPath, ENTRY), 'utf-8')
      await s.clone.raw(['rm', '-q', ENTRY])
      await s.clone.raw(['commit', '-q', '-m', 'editor deletes the entry'])
      await s.clone.raw(['push', 'origin', `${BRANCH}:${BRANCH}`])
      await s.advanceBase({ [ENTRY]: '{"title":"base"}\n' })

      // A person keeps the base's file, which is also what a merge leaves in the tree for a
      // modify/delete, so only the conflict tells this from a clean merge: the deletion is gone.
      await s.resolveConflictOnGitHub({ [ENTRY]: '{"title":"base"}\n' })
      expect(seeded).not.toBe('{"title":"base"}\n')

      await cycle(s)

      expect(await s.file(ENTRY)).toBe('{"title":"base"}\n')
      expect((await readMeta(s))?.status).toBe('submitted')
    })

    it('stays approved when the base it forked from came in, whatever the default is', async () => {
      await s.createBranchOnBase('release')
      await writeMeta(s, {
        status: 'approved',
        pullRequestNumber: 7,
        baseBranch: 'release',
        review: { state: 'approved', by: { userId: 'r' }, at: '2026-10-01T00:00:00.000Z' },
      })
      await s.updateBranchFromGitHub('release', { 'release.txt': 'moved\n' })

      await cycle(s)

      expect((await readMeta(s))?.status).toBe('approved')
    })

    it('goes back to review when a real commit came in, and its verdict leaves the PR body', async () => {
      await s.commitOnGitHub({ 'fix.txt': 'fix\n' })

      await cycle(s)

      const meta = await readMeta(s)
      expect(meta?.status).toBe('submitted')
      expect(meta?.review).toBeUndefined()
      expect(await queued(s, 'sync-pr-comments')).toEqual([BRANCH])
      const [task] = await listTasks(path.join(s.workspace, '.tasks'), 'pending')
      expect(task.payload.reviewBlockOnly).toBe(true)
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
