/**
 * The trigger: that a failing git sync actually re-reads the GitHub credential.
 *
 * `github-auth.test.ts` covers `refreshCredential()` itself — that a rotated
 * token reaches both consumers. This file covers the half that makes any of it
 * happen at run time, and it is the half most easily left inert: if
 * `start()` schedules `syncGit()` instead of `syncGitWithCredentialRefresh()`,
 * every test in that other file still passes and no credential is ever
 * re-read. So the wiring is exercised through a REAL `start()` against a real
 * local git fixture, with the loop interval turned down, rather than by
 * calling the wrapper directly.
 *
 * The fixture setup is `cms-worker-github-app-auth.test.ts`'s, which
 * established that a full start() is affordable in a unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'

import { CmsWorker } from './cms-worker'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'

/** `syncGit` is public but the wrapper around it is not; both are stubbed here. */
type SyncInternals = {
  syncGit(): Promise<void>
  syncGitWithCredentialRefresh(): Promise<void>
  buildGitHubUrl(): Promise<string>
}

describe('CmsWorker credential refresh on a failing sync', () => {
  let tmpDir: string
  let workspacePath: string
  let githubFixture: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-cred-refresh-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])
    await simpleGit().raw(['init', '--bare', githubFixture])
    await seedBaseBranch()
  })

  /** ensureRemoteGit refuses a refs-less bare repo, so give remote.git a `main`. */
  const seedBaseBranch = async () => {
    const seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'README.md'), 'seed')
    await seedGit.add(['README.md'])
    await seedGit.commit('seed')
    await seedGit.addRemote('origin', path.join(workspacePath, 'remote.git'))
    await seedGit.raw(['push', 'origin', 'HEAD:main'])
  }

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = (refreshGitHubToken: () => Promise<string | undefined>) => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'ghp_boot',
      refreshGitHubToken,
      // Fast enough that the test does not wait out the 5-minute default,
      // slow enough not to spin. The floor that keeps this from hammering
      // Secrets Manager in production lives in the PROVIDER, not here --
      // see canopycms-cdk/worker/credential-refresh.ts.
      gitSyncInterval: 20,
      taskPollInterval: 10_000,
    })
    ;(worker as unknown as SyncInternals).buildGitHubUrl = async () => githubFixture
    return worker
  }

  /** Wait for `predicate`, or give up — so a failure reads as a timeout, not a hang. */
  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return predicate()
  }

  it('re-reads the credential when the scheduled sync fails', async () => {
    const refreshGitHubToken = vi.fn(async () => undefined)
    const worker = makeWorker(refreshGitHubToken)

    try {
      await worker.start()
      // AFTER start(), so the boot-time sync succeeds against the fixture and
      // only the scheduled loop sees the failure.
      ;(worker as unknown as SyncInternals).syncGit = vi
        .fn()
        .mockRejectedValue(new Error('fatal: Authentication failed'))

      // The assertion that pins the wiring. Scheduling `syncGit` instead of
      // the wrapper leaves this false until the deadline.
      expect(await waitFor(() => refreshGitHubToken.mock.calls.length > 0)).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  it('does NOT re-read while the sync is succeeding', async () => {
    const refreshGitHubToken = vi.fn(async () => undefined)
    const worker = makeWorker(refreshGitHubToken)

    try {
      await worker.start()
      // Let several intervals elapse with a sync that works.
      ;(worker as unknown as SyncInternals).syncGit = vi.fn().mockResolvedValue(undefined)
      await new Promise((r) => setTimeout(r, 200))

      // The steady state, and the whole reason this is reactive rather than a
      // fourth polling loop: a healthy worker makes zero Secrets Manager calls.
      expect(refreshGitHubToken).not.toHaveBeenCalled()
    } finally {
      await worker.stop()
    }
  })

  describe('the wrapper itself', () => {
    /** Drive the wrapper directly, without the scheduler, for its error contract. */
    const wrapperOf = (worker: CmsWorker) => worker as unknown as SyncInternals

    it('rethrows the SYNC error, not anything the refresh produced', async () => {
      const refreshGitHubToken = vi.fn(async () => {
        throw new Error('AccessDeniedException reading the secret')
      })
      const worker = makeWorker(refreshGitHubToken)
      wrapperOf(worker).syncGit = vi.fn().mockRejectedValue(new Error('fetch rejected by GitHub'))

      // The refresh is best-effort: a failure to read the secret is logged and
      // swallowed, because replacing the sync error with it would hide the
      // thing that actually went wrong from scheduleLoop's log line.
      await expect(wrapperOf(worker).syncGitWithCredentialRefresh()).rejects.toThrow(
        'fetch rejected by GitHub',
      )
      expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
      expect(consoleSpy).toHaveErrored('Failed to re-read the GitHub credential')
    })

    it('passes a successful sync straight through without refreshing', async () => {
      const refreshGitHubToken = vi.fn(async () => undefined)
      const worker = makeWorker(refreshGitHubToken)
      wrapperOf(worker).syncGit = vi.fn().mockResolvedValue(undefined)

      await expect(wrapperOf(worker).syncGitWithCredentialRefresh()).resolves.toBeUndefined()
      expect(refreshGitHubToken).not.toHaveBeenCalled()
    })

    it('refreshes on ANY sync failure, not only an auth-shaped one', async () => {
      const refreshGitHubToken = vi.fn(async () => undefined)
      const worker = makeWorker(refreshGitHubToken)
      // A git failure carries no HTTP status at all -- exit 128 and a message.
      // That is precisely why this is not gated on isPermanentTaskFailure,
      // which would read it as transient and never fire.
      wrapperOf(worker).syncGit = vi
        .fn()
        .mockRejectedValue(new Error('fatal: could not read Username for https://github.com'))

      await expect(wrapperOf(worker).syncGitWithCredentialRefresh()).rejects.toThrow()
      expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
    })
  })
})
