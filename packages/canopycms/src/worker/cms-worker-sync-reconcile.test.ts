/**
 * Regression tests for the destructive `syncGit()` fetch refspec bug.
 *
 * `syncGit()` used to fetch GitHub straight into `refs/heads/*` inside
 * `remote.git` (`+refs/heads/*:refs/heads/*` with `--prune`). `remote.git`
 * is not a throwaway mirror in prod -- it's the deployment's local origin:
 * `GitManager.push()` writes editor work into it, branch-workspace clones
 * are cloned FROM it, and this worker itself pushes it on to GitHub. That
 * refspec could therefore destroy work that reached `remote.git` but not
 * GitHub yet:
 *   1. A branch pushed into `remote.git` and not yet on GitHub was DELETED
 *      by `--prune`.
 *   2. A branch where `remote.git` was ahead of GitHub was force-rewound to
 *      GitHub's older tip; the worker's next push then printed "Everything
 *      up-to-date" and the editor's commit silently never reached GitHub.
 *
 * The fix fetches into a remote-tracking namespace
 * (`GITHUB_TRACKING_REF_PREFIX`) instead, then reconciles `refs/heads/*`
 * toward it non-destructively (`reconcileTrackedBranches()`, invoked from
 * `syncGit()`). These tests exercise the whole `syncGit()` cycle against
 * real git repos (a bare "GitHub" fixture and a bare `remote.git`), the
 * same style as cms-worker.test.ts's "worker-status.json bookkeeping" suite
 * and cms-worker-rebase.test.ts.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { getBranchMetadataFileManager } from '../branch-metadata'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { mockConsole, openBareRepo, useLocalGitHubGateway } from '../test-utils'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import type { WorkerStatusReport } from '../types'
import { CmsWorker } from './cms-worker'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'

/**
 * `hook` runs while stale-mirror.ts's `readEditorWork` lists the queue, after the heads are read
 * and before any leased update: the window a concurrent Lambda push lands in. `queueReads` counts
 * every queue listing, which only a settle makes during a sync.
 */
const duringStaleMirrorCheck = vi.hoisted(() => ({
  hook: null as null | (() => Promise<void>),
  queueReads: 0,
}))

vi.mock('../task-queue/cms-task-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-queue/cms-task-queue')>()
  return {
    ...actual,
    listTasks: async (...args: Parameters<typeof actual.listTasks>) => {
      duringStaleMirrorCheck.queueReads++
      if (args[1] === 'processing' && duringStaleMirrorCheck.hook) {
        const hook = duringStaleMirrorCheck.hook
        duringStaleMirrorCheck.hook = null
        await hook()
      }
      return actual.listTasks(...args)
    },
  }
})

// ---------------------------------------------------------------------------
// Bare-repo helpers
//
// Both `githubPath` and `remoteGitPath` below are real bare repos. Building
// up specific ahead/behind/diverged histories on them needs an actual
// working tree at some point (to create commits), so `commitOnto` clones (or
// initializes) a throwaway scratch working repo, commits into it, and pushes
// straight back into the target bare repo -- mirroring the existing
// fixture-seeding pattern in cms-worker.test.ts (`pushInitialCommitToFixture`)
// and cms-worker-rebase.test.ts (`createBranchSetup`). `seedBranch` covers
// the "no new commit, just give two repos a shared starting point" need via
// a direct bare-to-bare fetch (no working tree required).
// ---------------------------------------------------------------------------

/** Whether `ref` exists in the bare repo at `bareRepoPath`. */
async function bareRefExists(bareRepoPath: string, ref: string): Promise<boolean> {
  try {
    await openBareRepo(bareRepoPath).raw(['rev-parse', '--verify', ref])
    return true
  } catch {
    return false
  }
}

/** Resolve `ref` to its commit SHA in the bare repo at `bareRepoPath`. */
async function bareRevParse(bareRepoPath: string, ref: string): Promise<string> {
  return (await openBareRepo(bareRepoPath).raw(['rev-parse', ref])).trim()
}

/**
 * Point `branch` in `targetBareRepo` at whatever it currently is in
 * `sourceBareRepo` (a direct bare-to-bare fetch, no new commit, no working
 * tree) -- used to give two independent bare repos a shared starting point
 * before diverging them independently.
 */
async function seedBranch(
  targetBareRepo: string,
  sourceBareRepo: string,
  branch: string,
): Promise<string> {
  await openBareRepo(targetBareRepo).raw([
    'fetch',
    sourceBareRepo,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ])
  return bareRevParse(targetBareRepo, branch)
}

let scratchCounter = 0

/**
 * Add a new commit on `branch` inside `bareRepoPath` via a throwaway
 * scratch working-tree clone, then push the result back. If `branch`
 * doesn't exist yet in `bareRepoPath`, it's created as an orphan (a
 * brand-new, unrelated history) -- use `seedBranch` first if the branch
 * should instead build on an existing history shared with another repo.
 * Returns the new commit SHA.
 */
async function commitOnto(
  scratchRoot: string,
  bareRepoPath: string,
  branch: string,
  files: Record<string, string>,
  message = `commit on ${branch}`,
): Promise<string> {
  const scratchDir = path.join(scratchRoot, `scratch-${scratchCounter++}`)
  await fs.mkdir(scratchDir, { recursive: true })

  const exists = await bareRefExists(bareRepoPath, `refs/heads/${branch}`)
  let scratchGit: SimpleGit
  if (exists) {
    await simpleGit().clone(bareRepoPath, scratchDir, ['--branch', branch, '--single-branch'])
    scratchGit = simpleGit({ baseDir: scratchDir, unsafe: { allowUnsafeEditor: true } })
  } else {
    scratchGit = simpleGit({ baseDir: scratchDir, unsafe: { allowUnsafeEditor: true } })
    await scratchGit.init()
    await scratchGit.checkout(['--orphan', branch])
  }
  await scratchGit.addConfig('user.name', 'Test Bot')
  await scratchGit.addConfig('user.email', 'test@canopycms.test')

  for (const [name, content] of Object.entries(files)) {
    const fullPath = path.join(scratchDir, name)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  await scratchGit.add(['.'])
  await scratchGit.commit(message)
  const sha = (await scratchGit.revparse(['HEAD'])).trim()
  await scratchGit.raw(['push', bareRepoPath, `${branch}:${branch}`])
  return sha
}

/**
 * Rebase-and-force-push on GitHub: `branch` is replaced by a new commit on `onto`, so the old tip is
 * no longer an ancestor of the new one, and the new one no ancestor of the old. Returns the new tip.
 */
async function forcePushRewrite(
  scratchRoot: string,
  bareRepoPath: string,
  branch: string,
  onto = 'main',
): Promise<string> {
  const scratchDir = path.join(scratchRoot, `scratch-${scratchCounter++}`)
  await simpleGit().clone(bareRepoPath, scratchDir, ['--branch', onto, '--single-branch'])
  const scratchGit = simpleGit({ baseDir: scratchDir, unsafe: { allowUnsafeEditor: true } })
  await scratchGit.addConfig('user.name', 'Test Bot')
  await scratchGit.addConfig('user.email', 'test@canopycms.test')
  await scratchGit.checkout(['-B', branch])
  await fs.writeFile(path.join(scratchDir, `rewrite-${scratchCounter}.txt`), 'rebased\n')
  await scratchGit.add(['.'])
  await scratchGit.commit(`rewrite ${branch}`)
  await scratchGit.raw(['push', '--force', bareRepoPath, `${branch}:${branch}`])
  return (await scratchGit.revparse(['HEAD'])).trim()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Narrow `lastGitSync.tracked`, which is optional on the wire (a
 * worker-status.json written before the tracked-branch reconcile shipped has
 * no such field). Every test here drives a real syncGit(), which always writes
 * it, so its absence is a genuine failure worth naming rather than a case to
 * tolerate.
 */
function trackedOf(
  status: WorkerStatusReport,
): NonNullable<NonNullable<WorkerStatusReport['lastGitSync']>['tracked']> {
  const tracked = status.lastGitSync?.tracked
  if (!tracked) throw new Error('expected syncGit() to record lastGitSync.tracked')
  return tracked
}

describe('CmsWorker.syncGit() non-destructive GitHub reconcile', () => {
  let tmpDir: string
  let workspacePath: string
  let githubPath: string
  let remoteGitPath: string

  const statusPath = () => path.join(workspacePath, '.tasks', WORKER_STATUS_FILE)
  const readStatus = async (): Promise<WorkerStatusReport> =>
    JSON.parse(await fs.readFile(statusPath(), 'utf-8'))

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-reconcile-test-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubPath = path.join(tmpDir, 'fixture-github.git')
    remoteGitPath = path.join(workspacePath, 'remote.git')

    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', githubPath])
    await simpleGit().raw(['init', '--bare', remoteGitPath])

    // Seed 'main' identically on both sides -- mirrors the steady state
    // ensureRemoteGit's bare clone of GitHub would have produced (that
    // guard/clone step is exercised elsewhere; these tests start from an
    // already-cloned remote.git and call syncGit() directly).
    await commitOnto(tmpDir, githubPath, 'main', { 'README.md': '# hello\n' }, 'initial commit')
    await seedBranch(remoteGitPath, githubPath, 'main')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** A branch workspace at `dirName`, as the Lambda publishes one: a clone with branch.json. */
  const giveWorkspace = async (dirName: string) => {
    const branchPath = path.join(workspacePath, 'content-branches', dirName)
    await fs.mkdir(path.join(branchPath, '.git'), { recursive: true })
    await getBranchMetadataFileManager(branchPath, path.dirname(branchPath)).save({
      branch: { name: dirName },
    })
  }

  const makeWorker = () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    // Point the GitHub fetch/push URL at the local bare fixture instead of a
    // real GitHub URL (same technique as cms-worker.test.ts's syncGit suite).
    useLocalGitHubGateway(worker, { remoteUrl: () => githubPath })
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  it('does not delete a branch that exists only in remote.git (unpushed editor work)', async () => {
    // Never reaches GitHub -- simulates GitManager.push() landing editor
    // work in remote.git before the corresponding push-branch task runs.
    // Branched from main, so only the workspace keeps it (an unrelated history is kept anyway).
    const sha = await forcePushRewrite(tmpDir, remoteGitPath, 'feature-unpushed')
    await giveWorkspace('feature-unpushed')

    const worker = makeWorker()
    await worker.syncGit()

    // Old refspec: `--prune` deletes any refs/heads/* remote.git has that
    // GitHub doesn't -- this would have vanished.
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-unpushed')).resolves.toBe(true)
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-unpushed')).resolves.toBe(sha)
  })

  it('does not rewind a branch ahead of GitHub, and a subsequent push still transfers the commit', async () => {
    await commitOnto(tmpDir, githubPath, 'feature-ahead', { 'a.txt': 'base' })
    await seedBranch(remoteGitPath, githubPath, 'feature-ahead')
    // remote.git advances beyond GitHub's tip (an editor's save that hasn't
    // been pushed to GitHub yet).
    const aheadSha = await commitOnto(tmpDir, remoteGitPath, 'feature-ahead', {
      'b.txt': 'editor work not yet on github',
    })

    const worker = makeWorker()
    await worker.syncGit()

    // Old refspec: force-rewinds remote.git's ref back to GitHub's older
    // tip ("+refs/heads/*" is a forced update, no ff check).
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-ahead')).resolves.toBe(aheadSha)

    // The silent-data-loss check: with the old refspec, remote.git's ref
    // was already rewound to match GitHub, so a subsequent push would print
    // "Everything up-to-date" and the commit would never reach GitHub. Here
    // it must actually transfer.
    await openBareRepo(remoteGitPath).raw(['push', githubPath, 'feature-ahead:feature-ahead'])
    await expect(bareRevParse(githubPath, 'refs/heads/feature-ahead')).resolves.toBe(aheadSha)
  })

  it('fast-forwards a branch that is behind GitHub', async () => {
    await commitOnto(tmpDir, githubPath, 'feature-behind', { 'a.txt': 'base' })
    await seedBranch(remoteGitPath, githubPath, 'feature-behind')
    const advancedSha = await commitOnto(tmpDir, githubPath, 'feature-behind', {
      'b.txt': 'merged on github',
    })

    const worker = makeWorker()
    await worker.syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-behind')).resolves.toBe(
      advancedSha,
    )

    const status = await readStatus()
    expect(trackedOf(status).fastForwarded).toContain('feature-behind')
  })

  it('creates a local head for a branch that exists only on GitHub', async () => {
    const sha = await commitOnto(tmpDir, githubPath, 'feature-new-on-github', {
      'a.txt': 'only ever existed on github',
    })
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-new-on-github')).resolves.toBe(
      false,
    )

    const worker = makeWorker()
    await worker.syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-new-on-github')).resolves.toBe(sha)

    const status = await readStatus()
    expect(trackedOf(status).created).toContain('feature-new-on-github')
  })

  it('leaves a diverged branch untouched, does not throw, and counts + warns about it', async () => {
    await commitOnto(tmpDir, githubPath, 'feature-diverged', { 'a.txt': 'base' })
    await seedBranch(remoteGitPath, githubPath, 'feature-diverged')
    // Both sides advance independently from the shared base commit.
    const localSha = await commitOnto(tmpDir, remoteGitPath, 'feature-diverged', {
      'local.txt': 'local-only work',
    })
    await commitOnto(tmpDir, githubPath, 'feature-diverged', {
      'github.txt': 'github-only work',
    })
    await giveWorkspace('feature-diverged')

    const consoleSpy = mockConsole()
    const worker = makeWorker()
    await expect(worker.syncGit()).resolves.toBeUndefined()

    // Left alone -- neither GitHub's nor remote.git's version wins silently.
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-diverged')).resolves.toBe(localSha)
    expect(consoleSpy).toHaveWarned(/diverged/i)
    consoleSpy.restore()

    const status = await readStatus()
    expect(trackedOf(status).diverged).toContain('feature-diverged')
    // A diverged branch must not fail the whole sync cycle.
    expect(status.lastGitSyncError).toBeUndefined()
  })

  it('[SYNC-M2] one unreadable branch does not halt the rest of the sync cycle', async () => {
    // A ref whose reachable ancestor object is missing -- plausible on EFS
    // with a concurrent Lambda writer. The rev-list that classifies
    // ahead/behind used to sit outside any try/catch (only the two update-ref
    // calls around it were guarded), so this threw out of the reconcile loop,
    // out of syncGit()'s try, and skipped pushSettingsBranches,
    // refreshBaseBranchWorkspace and rebaseActiveBranches -- every cycle,
    // with nothing to heal it.
    //
    // The fixture has to be a PARTIALLY WRITTEN ancestor, not a missing one,
    // and not a bad tip. Verified against real git while writing this test:
    // a ref pointing at a wholly absent object kills the cycle-opening fetch
    // instead (never reaching the reconcile), and an ancestor object that is
    // merely DELETED gets silently re-sent by that same fetch, healing itself
    // before the reconcile runs. A zero-length (torn) object file survives
    // the fetch untouched and makes rev-list fatal -- which is also the
    // likelier EFS failure in the first place. Loose objects are written
    // read-only, hence the chmod.
    //
    // Built on an orphan branch so the damaged object is reachable from this
    // branch only and cannot harm 'main' or the healthy branch below.
    await commitOnto(tmpDir, githubPath, 'feature-broken', { 'a.txt': 'base' })
    await seedBranch(remoteGitPath, githubPath, 'feature-broken')
    const brokenAncestor = await bareRevParse(remoteGitPath, 'refs/heads/feature-broken')

    // A healthy branch that must still be reconciled despite the bad one.
    await commitOnto(tmpDir, githubPath, 'feature-healthy', { 'b.txt': 'base' })
    await seedBranch(remoteGitPath, githubPath, 'feature-healthy')

    // Diverge the branch so it reaches the rev-list at all, then run one
    // clean cycle. The damage has to land on a workspace already in its
    // steady state (a cycle every 5 minutes in production): a fetch only
    // walks a branch's history when it has something new to transfer, so
    // corrupting before the branch's commits have been fetched would fail
    // the fetch itself, before the reconcile is ever reached.
    await commitOnto(tmpDir, remoteGitPath, 'feature-broken', { 'local.txt': 'local' })
    await commitOnto(tmpDir, githubPath, 'feature-broken', { 'github.txt': 'github' })
    // Editor work, so the diverged head is kept rather than moved to GitHub's tip.
    await giveWorkspace('feature-broken')
    await makeWorker().syncGit()

    // Only the healthy branch has anything new this cycle.
    const healthyAhead = await commitOnto(tmpDir, githubPath, 'feature-healthy', {
      'b.txt': 'moved ahead on github',
    })

    // Truncate the ancestor commit object in remote.git.
    const brokenObject = path.join(
      remoteGitPath,
      'objects',
      brokenAncestor.slice(0, 2),
      brokenAncestor.slice(2),
    )
    await fs.chmod(brokenObject, 0o644)
    await fs.writeFile(brokenObject, '')

    const consoleSpy = mockConsole()
    const worker = makeWorker()
    await expect(worker.syncGit()).resolves.toBeUndefined()
    expect(consoleSpy).toHaveWarned(/skipping feature-broken/i)
    consoleSpy.restore()

    // The rest of the cycle ran: the healthy branch was still fast-forwarded,
    // and the cycle recorded no error at all.
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-healthy')).resolves.toBe(
      healthyAhead,
    )
    const status = await readStatus()
    expect(trackedOf(status).fastForwarded).toContain('feature-healthy')
    expect(trackedOf(status).diverged).not.toContain('feature-broken')
    expect(status.lastGitSyncError).toBeUndefined()
    // The phases that used to be skipped entirely still completed.
    expect(status.lastGitSync).toBeDefined()
  })

  it("records the base clone's refresh outcome and counts a dirty base in skippedDirty", async () => {
    const basePath = path.join(workspacePath, 'content-branches', 'main')
    await simpleGit().clone(remoteGitPath, basePath, ['--branch', 'main'])
    await getBranchMetadataFileManager(basePath, path.dirname(basePath)).save({
      branch: { name: 'main' },
    })
    await fs.writeFile(path.join(basePath, 'README.md'), 'uncommitted edit\n')

    const consoleSpy = mockConsole()
    await makeWorker().syncGit()
    expect(consoleSpy).toHaveErrored(/Base branch workspace \(main\) has uncommitted changes/)
    consoleSpy.restore()

    const sync = (await readStatus()).lastGitSync
    expect(sync?.skippedDirty).toEqual(['main'])
    expect(sync?.baseRefresh).toMatchObject({
      outcome: 'skipped-dirty',
      dirtyFiles: ['README.md'],
    })
  })

  it('keeps the head of a branch GitHub deleted while its workspace remains', async () => {
    // Branched from main, so only the workspace keeps it (an unrelated history is kept anyway).
    await forcePushRewrite(tmpDir, githubPath, 'feature-deleted-upstream')
    const sha = await seedBranch(remoteGitPath, githubPath, 'feature-deleted-upstream')
    await giveWorkspace('feature-deleted-upstream')
    await makeWorker().syncGit()

    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-deleted-upstream'])
    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-deleted-upstream')).resolves.toBe(
      sha,
    )
    expect(trackedOf(await readStatus()).pruned).toEqual([])
  })
})

describe('CmsWorker.syncGit() stale branch copies', () => {
  let tmpDir: string
  let workspacePath: string
  let githubPath: string
  let remoteGitPath: string

  const readStatus = async (): Promise<WorkerStatusReport> =>
    JSON.parse(await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'))
  const taskDir = () => path.join(workspacePath, '.tasks')

  beforeEach(async () => {
    mockConsole()
    duringStaleMirrorCheck.hook = null
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-stale-mirror-test-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubPath = path.join(tmpDir, 'fixture-github.git')
    remoteGitPath = path.join(workspacePath, 'remote.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', '--initial-branch', 'main', githubPath])
    await simpleGit().raw(['init', '--bare', '--initial-branch', 'main', remoteGitPath])
    await commitOnto(tmpDir, githubPath, 'main', { 'README.md': '# hello\n' }, 'initial commit')
    await seedBranch(remoteGitPath, githubPath, 'main')
  })

  afterEach(async () => {
    duringStaleMirrorCheck.hook = null
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    // One worker runs several cycles in a test, each of which must see GitHub's latest change.
    useLocalGitHubGateway(worker, { remoteUrl: () => githubPath, fetchCoalesceMs: 0 })
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  const giveWorkspace = async (dirName: string) => {
    const branchPath = path.join(workspacePath, 'content-branches', dirName)
    await fs.mkdir(path.join(branchPath, '.git'), { recursive: true })
    await getBranchMetadataFileManager(branchPath, path.dirname(branchPath)).save({
      branch: { name: dirName },
    })
  }

  /** A branch mirrored into remote.git by one cycle, then rebased and force-pushed on GitHub. */
  const forcePushedAfterMirroring = async (
    branch: string,
  ): Promise<{ oldTip: string; newTip: string }> => {
    const oldTip = await commitOnto(tmpDir, githubPath, branch, { 'a.txt': 'before rebase' })
    await makeWorker().syncGit()
    await expect(bareRevParse(remoteGitPath, `refs/heads/${branch}`)).resolves.toBe(oldTip)
    const newTip = await forcePushRewrite(tmpDir, githubPath, branch)
    return { oldTip, newTip }
  }

  const warningsNaming = (consoleSpy: ReturnType<typeof mockConsole>, text: string) =>
    consoleSpy.all().warn.filter((line) => line.includes(text) && /diverged/.test(line))

  it("moves a stale copy of a force-pushed branch to GitHub's tip, without a warning", async () => {
    const { newTip } = await forcePushedAfterMirroring('feature-rebased')

    const consoleSpy = mockConsole()
    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-rebased')).resolves.toBe(newTip)
    const tracked = trackedOf(await readStatus())
    expect(tracked.repointed).toEqual(['feature-rebased'])
    expect(tracked.diverged).toEqual([])
    expect(consoleSpy.all().warn.filter((line) => /diverged/.test(line))).toEqual([])
  })

  it('keeps a diverged head that has a workspace, a queued push, or is a settings branch', async () => {
    const workspace = await forcePushedAfterMirroring('feature-with-workspace')
    await giveWorkspace('feature-with-workspace')
    const queued = await forcePushedAfterMirroring('feature-queued')
    await enqueueTask(taskDir(), { action: 'push-branch', payload: { branch: 'feature-queued' } })
    const settings = await forcePushedAfterMirroring('canopycms-settings-elsewhere')

    const consoleSpy = mockConsole()
    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-with-workspace')).resolves.toBe(
      workspace.oldTip,
    )
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-queued')).resolves.toBe(
      queued.oldTip,
    )
    await expect(
      bareRevParse(remoteGitPath, 'refs/heads/canopycms-settings-elsewhere'),
    ).resolves.toBe(settings.oldTip)
    const tracked = trackedOf(await readStatus())
    expect([...tracked.diverged].sort()).toEqual([
      'canopycms-settings-elsewhere',
      'feature-queued',
      'feature-with-workspace',
    ])
    expect(tracked.repointed).toEqual([])
    expect(warningsNaming(consoleSpy, 'feature-with-workspace')[0]).toMatch(
      /has a branch workspace/,
    )
    expect(warningsNaming(consoleSpy, 'feature-queued')[0]).toMatch(/a push of it is queued/)
    expect(warningsNaming(consoleSpy, 'canopycms-settings-elsewhere')[0]).toMatch(
      /is a settings branch/,
    )
  })

  it('warns once per pair of tips, and again when either tip moves', async () => {
    await forcePushedAfterMirroring('feature-collision')
    await giveWorkspace('feature-collision')
    const worker = makeWorker()

    const consoleSpy = mockConsole()
    await worker.syncGit()
    await worker.syncGit()
    expect(warningsNaming(consoleSpy, 'feature-collision')).toHaveLength(1)

    const githubTip = await commitOnto(tmpDir, githubPath, 'feature-collision', { 'g.txt': '1' })
    await worker.syncGit()
    await worker.syncGit()
    expect(warningsNaming(consoleSpy, 'feature-collision')).toHaveLength(2)
    expect(warningsNaming(consoleSpy, 'feature-collision')[1]).toContain(githubTip)

    const localTip = await commitOnto(tmpDir, remoteGitPath, 'feature-collision', { 'l.txt': '1' })
    await worker.syncGit()
    expect(warningsNaming(consoleSpy, 'feature-collision')).toHaveLength(3)
    expect(warningsNaming(consoleSpy, 'feature-collision')[2]).toContain(localTip)
    expect(trackedOf(await readStatus()).diverged).toEqual(['feature-collision'])
  })

  it('deletes the head of a branch GitHub deleted once no editor work is left in it', async () => {
    await forcePushRewrite(tmpDir, githubPath, 'feature-merged')
    await makeWorker().syncGit()
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-merged')).resolves.toBe(true)

    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-merged'])
    await makeWorker().syncGit()

    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-merged')).resolves.toBe(false)
    expect(trackedOf(await readStatus()).pruned).toEqual(['feature-merged'])
  })

  it('deletes nothing when GitHub answers without the base branch', async () => {
    await forcePushRewrite(tmpDir, githubPath, 'feature-kept')
    await makeWorker().syncGit()

    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-kept'])
    await openBareRepo(githubPath).raw(['symbolic-ref', 'HEAD', 'refs/heads/feature-other'])
    await commitOnto(tmpDir, githubPath, 'feature-other', { 'b.txt': 'other' })
    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/main'])
    duringStaleMirrorCheck.queueReads = 0
    await makeWorker()
      .syncGit()
      .catch(() => {})

    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-kept')).resolves.toBe(true)
    // No head was even checked: an unrelated history would be kept anyway.
    expect(duringStaleMirrorCheck.queueReads).toBe(0)
  })

  it('stops deleting for the cycle while packed-refs.lock is held, and only then', async () => {
    for (const branch of ['feature-a-packed-refs', 'feature-b', 'feature-c']) {
      await forcePushRewrite(tmpDir, githubPath, branch)
    }
    await makeWorker().syncGit()
    for (const branch of ['feature-a-packed-refs', 'feature-b']) {
      await openBareRepo(githubPath).raw(['update-ref', '-d', `refs/heads/${branch}`])
    }

    // A branch's own lock, whose name also ends in packed-refs.lock, costs only that branch.
    const ownLock = path.join(remoteGitPath, 'refs', 'heads', 'feature-a-packed-refs.lock')
    await fs.writeFile(ownLock, '')
    const consoleSpy = mockConsole()
    await makeWorker().syncGit()
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-a-packed-refs')).resolves.toBe(
      true,
    )
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-b')).resolves.toBe(false)
    expect(consoleSpy).toHaveWarned(/feature-a-packed-refs moved while it was checked/)
    await fs.rm(ownLock)

    // The repository's packed-refs.lock stops every deletion, so the loop stops at the first.
    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-c'])
    await fs.writeFile(path.join(remoteGitPath, 'packed-refs.lock'), '')
    const lockedSpy = mockConsole()
    await makeWorker().syncGit()
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-a-packed-refs')).resolves.toBe(
      true,
    )
    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-c')).resolves.toBe(true)
    expect(lockedSpy.all().warn.filter((line) => /moved while it was checked/.test(line))).toEqual(
      [],
    )
  })

  it('warns once about a head GitHub no longer has that could not be checked', async () => {
    await forcePushRewrite(tmpDir, githubPath, 'feature-unreadable')
    await makeWorker().syncGit()
    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-unreadable'])
    // The provisioning lock cannot be taken where the branches root is a file.
    await fs.rm(path.join(workspacePath, 'content-branches'), { recursive: true, force: true })
    await fs.writeFile(path.join(workspacePath, 'content-branches'), '')
    const worker = makeWorker()

    const consoleSpy = mockConsole()
    await worker.syncGit().catch(() => {})
    await worker.syncGit().catch(() => {})

    await expect(bareRefExists(remoteGitPath, 'refs/heads/feature-unreadable')).resolves.toBe(true)
    const lines = consoleSpy
      .all()
      .warn.filter((line) => /feature-unreadable, which GitHub no longer has/.test(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/could not be checked: \S/)
  })

  it("keeps every head when this deployment's settings branch cannot be named", async () => {
    const { oldTip } = await forcePushedAfterMirroring('feature-unnamed-settings')
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
      settingsBranch: 'not a valid ref',
    })
    useLocalGitHubGateway(worker, { remoteUrl: () => githubPath, fetchCoalesceMs: 0 })
    ;(worker as unknown as { running: boolean }).running = true
    ;(worker as unknown as { ensureSettingsBranch: () => string }).ensureSettingsBranch = () => {
      throw new Error('invalid deployment name')
    }

    const consoleSpy = mockConsole()
    await worker.syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-unnamed-settings')).resolves.toBe(
      oldTip,
    )
    expect(warningsNaming(consoleSpy, 'feature-unnamed-settings')[0]).toMatch(
      /settings branch cannot be named/,
    )
  })

  it('leaves a head that moved during the check alone, and settles it next cycle', async () => {
    const { newTip } = await forcePushedAfterMirroring('feature-raced')
    let movedTip = ''
    duringStaleMirrorCheck.hook = async () => {
      movedTip = await commitOnto(tmpDir, remoteGitPath, 'feature-raced', { 'race.txt': 'push' })
    }

    const consoleSpy = mockConsole()
    await expect(makeWorker().syncGit()).resolves.toBeUndefined()

    expect(movedTip).not.toBe('')
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-raced')).resolves.toBe(movedTip)
    expect(consoleSpy).toHaveWarned(/feature-raced moved while it was checked/)
    const tracked = trackedOf(await readStatus())
    expect(tracked.repointed).toEqual([])
    expect(tracked.diverged).toEqual([])

    await makeWorker().syncGit()
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-raced')).resolves.toBe(newTip)
    expect(trackedOf(await readStatus()).repointed).toEqual(['feature-raced'])
  })

  it('keeps a diverged head while its provisioning lock is held elsewhere', async () => {
    const { oldTip } = await forcePushedAfterMirroring('feature-provisioning')
    const release = await tryAcquireProvisioningLock(
      path.join(workspacePath, 'content-branches'),
      branchProvisioningLockName('feature-provisioning'),
    )
    try {
      const consoleSpy = mockConsole()
      await makeWorker().syncGit()

      await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-provisioning')).resolves.toBe(
        oldTip,
      )
      expect(trackedOf(await readStatus()).diverged).toEqual(['feature-provisioning'])
      expect(warningsNaming(consoleSpy, 'feature-provisioning')[0]).toMatch(
        /workspace is being created, repaired or purged/,
      )
    } finally {
      await release()
    }
  })

  it('never writes through a symbolic ref planted under refs/heads', async () => {
    const mainSha = await bareRevParse(remoteGitPath, 'refs/heads/main')
    await openBareRepo(remoteGitPath).raw(['symbolic-ref', 'refs/heads/planted', 'refs/heads/main'])

    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/main')).resolves.toBe(mainSha)
    await expect(
      openBareRepo(remoteGitPath).raw(['symbolic-ref', 'refs/heads/planted']),
    ).resolves.toContain('refs/heads/main')
    expect(trackedOf(await readStatus()).pruned).toEqual([])
  })

  it('reads past a task file without a payload', async () => {
    const { newTip } = await forcePushedAfterMirroring('feature-beside-bad-task')
    await fs.mkdir(path.join(taskDir(), 'pending'), { recursive: true })
    await fs.writeFile(
      path.join(taskDir(), 'pending', 'no-payload.json'),
      JSON.stringify({ id: 'no-payload', action: 'push-branch' }),
    )

    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-beside-bad-task')).resolves.toBe(
      newTip,
    )
  })

  it('keeps a head GitHub does not have whose history shares nothing with the base', async () => {
    // A settings branch under a name this worker does not know as one: an orphan history.
    const sha = await commitOnto(tmpDir, remoteGitPath, 'site-settings', { 'groups.json': '[]' })

    await makeWorker().syncGit()

    await expect(bareRevParse(remoteGitPath, 'refs/heads/site-settings')).resolves.toBe(sha)
    expect(trackedOf(await readStatus()).pruned).toEqual([])
  })

  it('escapes a hostile branch name in the warning', async () => {
    const hostile = 'feature-\u202eevil'
    await forcePushedAfterMirroring(hostile)
    await enqueueTask(taskDir(), { action: 'push-branch', payload: { branch: hostile } })

    const consoleSpy = mockConsole()
    await makeWorker().syncGit()

    const [line] = warningsNaming(consoleSpy, 'feature-\\u{202e}evil')
    expect(line).toBeDefined()
    expect(line).not.toContain('\u202e')
    expect(trackedOf(await readStatus()).diverged).toEqual([hostile])
  })
})
