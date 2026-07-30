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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { mockConsole, openBareRepo } from '../test-utils'
import type { WorkerStatusReport } from '../types'
import { CmsWorker } from './cms-worker'
import { WORKER_STATUS_FILE } from './worker-status'

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
  await scratchGit.addConfig('core.editor', 'true')

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () => githubPath
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  it('does not delete a branch that exists only in remote.git (unpushed editor work)', async () => {
    // Never reaches GitHub -- simulates GitManager.push() landing editor
    // work in remote.git before the corresponding push-branch task runs.
    const sha = await commitOnto(tmpDir, remoteGitPath, 'feature-unpushed', {
      'a.txt': 'editor draft',
    })

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
    expect(status.lastGitSync?.tracked.fastForwarded).toContain('feature-behind')
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
    expect(status.lastGitSync?.tracked.created).toContain('feature-new-on-github')
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

    const consoleSpy = mockConsole()
    const worker = makeWorker()
    await expect(worker.syncGit()).resolves.toBeUndefined()

    // Left alone -- neither GitHub's nor remote.git's version wins silently.
    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-diverged')).resolves.toBe(localSha)
    expect(consoleSpy).toHaveWarned(/diverged/i)
    consoleSpy.restore()

    const status = await readStatus()
    expect(status.lastGitSync?.tracked.diverged).toContain('feature-diverged')
    // A diverged branch must not fail the whole sync cycle.
    expect(status.lastGitSyncError).toBeUndefined()
  })

  it('does not delete a local head when the branch is removed from GitHub', async () => {
    await commitOnto(tmpDir, githubPath, 'feature-deleted-upstream', {
      'a.txt': 'will be deleted upstream',
    })
    const sha = await seedBranch(remoteGitPath, githubPath, 'feature-deleted-upstream')

    // Warm-up cycle: remote.git also gets a GITHUB_TRACKING_REF_PREFIX
    // tracking ref for it, modeling the steady state before the branch
    // disappears from GitHub (not load-bearing for the assertion below,
    // which only checks refs/heads/*, but keeps the fixture realistic).
    await makeWorker().syncGit()

    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/feature-deleted-upstream'])

    const worker = makeWorker()
    await worker.syncGit() // fetch runs with --prune

    await expect(bareRevParse(remoteGitPath, 'refs/heads/feature-deleted-upstream')).resolves.toBe(
      sha,
    )
  })
})
