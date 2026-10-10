/**
 * The triggers: that a failing GitHub fetch on the git-sync loop, and a failing publish on the
 * task loop, actually re-read the GitHub credential, through the gateway's own arming
 * (`LocalGitHubGateway.credentialed`).
 *
 * `github-auth.test.ts` covers `refreshCredential()` itself — that a rotated token reaches both
 * consumers — and `github-gateway-credential.test.ts` the arming rule op by op. This file covers
 * the worker running for real: the sync wiring through a REAL `start()` against a local git
 * fixture with the loop interval turned down, and the task wiring through the real
 * `pushBranchToGitHub` against a local HTTPS git server that refuses the revoked token, as GitHub
 * would. Those tests move the clock past each retry's backoff instead of waiting it out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

import { CmsWorker } from './cms-worker'
import { enqueueTask } from '../task-queue/cms-task-queue'
import {
  initTestRepo,
  mockConsole,
  startHttpsGitServer,
  useLocalGitHubGateway,
  type HttpsGitServer,
  type MockConsole,
} from '../test-utils'
import type { GitHubGateway } from './github-gateway'

const REVOKED = 'ghp_revoked_0123456789'
const ROTATED = 'ghp_rotated_0123456789'

describe('CmsWorker credential refresh', () => {
  let tmpDir: string
  let workspacePath: string
  let githubFixture: string
  let seedGit: SimpleGit
  let seedPath: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-cred-refresh-')),
    )
    workspacePath = path.join(tmpDir, 'workspace')
    githubFixture = path.join(tmpDir, 'served', 'github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])
    await simpleGit().raw(['init', '--bare', githubFixture])
    seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'README.md'), 'seed')
    await seedGit.add(['README.md'])
    await seedGit.commit('seed')
    // ensureRemoteGit refuses a refs-less bare repo, so remote.git gets a `main`; so does
    // "GitHub", for the sync's fetch to bring back.
    await seedGit.raw(['push', path.join(workspacePath, 'remote.git'), 'HEAD:refs/heads/main'])
    await seedGit.raw(['push', githubFixture, 'HEAD:refs/heads/main'])
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** Wait for `predicate`, or give up — so a failure reads as a timeout, not a hang. */
  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return predicate()
  }

  describe('on a failing sync', () => {
    /** "GitHub" until `reachable` is cleared, then a path with no repository. */
    let reachable: boolean

    const makeWorker = (refreshGitHubToken: () => Promise<string | undefined>) => {
      reachable = true
      const worker = new CmsWorker({
        workspacePath,
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        baseBranch: 'main',
        githubToken: 'ghp_boot_0123456789',
        refreshGitHubToken,
        // Fast enough that the test does not wait out the 5-minute default, slow enough not to
        // spin. Core's own refresh floor (60s by default, not overridden here) still holds this
        // to one provider call a minute; the AWS provider adds a five-minute floor of its own
        // (canopycms-cdk/worker/credential-refresh.ts).
        gitSyncInterval: 20,
        taskPollInterval: 10_000,
      })
      const gateway = useLocalGitHubGateway(worker, {
        remoteUrl: async () => (reachable ? githubFixture : path.join(tmpDir, 'gone.git')),
      })
      return { worker, gateway }
    }

    it("re-reads the credential when the scheduled sync's GitHub fetch fails", async () => {
      const refreshGitHubToken = vi.fn(async () => undefined)
      const { worker } = makeWorker(refreshGitHubToken)

      try {
        await worker.start()
        // AFTER start(), so the boot-time sync succeeds against the fixture and only the
        // scheduled loop's real fetch fails.
        expect(refreshGitHubToken).not.toHaveBeenCalled()
        reachable = false

        expect(await waitFor(() => refreshGitHubToken.mock.calls.length > 0)).toBe(true)
        // The sync's own failure still reaches the loop's log.
        await vi.waitFor(() => expect(consoleSpy).toHaveErrored('Worker loop error:'))
      } finally {
        await worker.stop()
      }
    })

    it('does NOT re-read while the sync is succeeding', async () => {
      const refreshGitHubToken = vi.fn(async () => undefined)
      const { worker } = makeWorker(refreshGitHubToken)

      try {
        await worker.start()
        // Let several intervals elapse with a sync that works.
        await new Promise((r) => setTimeout(r, 200))

        expect(consoleSpy).toHaveLogged('Fetched from GitHub')
        // The steady state, and the whole reason this is reactive rather than a fourth polling
        // loop: a healthy worker makes zero Secrets Manager calls.
        expect(refreshGitHubToken).not.toHaveBeenCalled()
      } finally {
        await worker.stop()
      }
    })

    describe("the gateway's fetch", () => {
      it('rejects with its own failure, not anything the refresh produced', async () => {
        const refreshGitHubToken = vi.fn(async () => {
          throw new Error('AccessDeniedException reading the secret')
        })
        const { gateway } = makeWorker(refreshGitHubToken)
        reachable = false

        // The refresh is best-effort: a failure to read the secret is logged and swallowed,
        // because replacing the fetch error with it would hide what actually went wrong.
        const caught = await gateway.fetch({ have: [] }).catch((err: unknown) => err)
        expect(String(caught)).toMatch(/gone\.git/)
        expect(String(caught)).not.toMatch(/AccessDenied/)
        expect(await waitFor(() => refreshGitHubToken.mock.calls.length === 1)).toBe(true)
        await vi.waitFor(() =>
          expect(consoleSpy).toHaveErrored('Failed to re-read the GitHub credential'),
        )
      })

      it('passes a successful fetch straight through without refreshing', async () => {
        const refreshGitHubToken = vi.fn(async () => undefined)
        const { gateway } = makeWorker(refreshGitHubToken)

        await expect(gateway.fetch({ have: [] })).resolves.toEqual({ bundleId: null })
        await new Promise((r) => setTimeout(r, 50))
        expect(refreshGitHubToken).not.toHaveBeenCalled()
      })

      it('refreshes on ANY GitHub-bound failure, not only an auth-shaped one', async () => {
        const refreshGitHubToken = vi.fn(async () => undefined)
        const { gateway } = makeWorker(refreshGitHubToken)
        reachable = false

        // A missing repository: exit 128, no HTTP status, nothing about credentials. GitHub says
        // the same for a token that lost access, which is why this is not gated on the failure
        // looking auth-shaped.
        const caught = await gateway.fetch({ have: [] }).catch((err: unknown) => err)
        expect(String(caught)).not.toMatch(/auth|credential|Username/i)
        expect((caught as { status?: unknown }).status).toBeUndefined()
        expect(await waitFor(() => refreshGitHubToken.mock.calls.length === 1)).toBe(true)
      })
    })

    it("reports a gateway that cannot even be built as the sync loop's error", async () => {
      // No credential at all, and no gateway installed: building one throws. Only a gateway can
      // re-read a credential, and resolving the config throws before one exists, so no provider
      // could be called; what the operator must see is the configuration error itself.
      const worker = new CmsWorker({
        workspacePath,
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        baseBranch: 'main',
      })
      const internals = worker as unknown as {
        running: boolean
        setBaseBranch(name: string): void
        scheduleLoop(label: string, fn: () => Promise<void>, interval: number): void
      }
      internals.running = true
      internals.setBaseBranch('main')
      try {
        internals.scheduleLoop('git sync', () => worker.syncGit(), 10)

        await vi.waitFor(() =>
          expect(consoleSpy).toHaveErrored(
            /Worker loop error:.*githubToken or githubAppAuth is required/,
          ),
        )
      } finally {
        internals.running = false
      }
    })
  })

  describe('on a failing task', () => {
    type TaskInternals = {
      running: boolean
      github(): GitHubGateway
      pushBranchToGitHub(branch: string, signal?: AbortSignal): Promise<void>
    }

    const MAX_RETRIES = 3
    let server: HttpsGitServer

    const taskPath = (state: string, id: string) =>
      path.join(workspacePath, '.tasks', state, `${id}.json`)
    const exists = (p: string) =>
      fs.stat(p).then(
        () => true,
        () => false,
      )
    const enqueuePush = (branch = 'feature-1') =>
      enqueueTask(path.join(workspacePath, '.tasks'), {
        action: 'push-branch',
        payload: { branch },
      })

    /** A commit on each of `branches` in remote.git, one ahead of `main`, for a push to send. */
    const seedBranches = async (...branches: string[]) => {
      for (const branch of branches) {
        await seedGit.raw(['checkout', '-q', '-B', branch, 'main'])
        await fs.writeFile(path.join(seedPath, `${branch}.txt`), branch)
        await seedGit.add('.')
        await seedGit.commit(branch)
        await seedGit.raw([
          'push',
          '-q',
          path.join(workspacePath, 'remote.git'),
          `HEAD:refs/heads/${branch}`,
        ])
      }
    }

    beforeEach(async () => {
      await seedGit.raw(['branch', '-M', 'main'])
      await seedBranches('feature-1', 'feature-2')
      server = await startHttpsGitServer(path.join(tmpDir, 'served'), tmpDir)
      server.acceptedTokens.add(ROTATED)
      vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
      vi.stubEnv('NO_PROXY', '127.0.0.1')
      vi.stubEnv('no_proxy', '127.0.0.1')
      // Date only: the backoff is a `retryAfter` timestamp compared against Date.now(), while
      // the per-task timeout, the refresh bound and the detached refresh are real timers.
      vi.useFakeTimers({ toFake: ['Date'] })
    })

    afterEach(async () => {
      vi.useRealTimers()
      await server.close()
    })

    /**
     * A worker whose push GitHub refuses for as long as it holds the revoked token: the real
     * `pushBranchToGitHub`, through the real gateway, to a server that accepts only the rotated
     * one. Its refusal carries no `.status`, as a real `git push` failure does not, so the task
     * path classifies it transient and retries. `push` counts the attempts.
     */
    const makeTaskWorker = (
      refreshGitHubToken: () => Promise<string | undefined>,
      taskTimeoutMs = 10_000,
      refreshGitHubTokenMinIntervalMs?: number,
    ) => {
      const worker = new CmsWorker({
        workspacePath,
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        baseBranch: 'main',
        githubToken: REVOKED,
        refreshGitHubToken,
        taskTimeoutMs,
        maxRetries: MAX_RETRIES,
        refreshGitHubTokenMinIntervalMs,
      })
      const internals = worker as unknown as TaskInternals
      internals.running = true
      useLocalGitHubGateway(worker, { remoteUrl: server.url('github.git') })
      const realPush = internals.pushBranchToGitHub.bind(worker)
      const push = vi.fn(realPush)
      internals.pushBranchToGitHub = push
      return { worker, push }
    }

    /**
     * Poll until the task settles, moving the clock past each retry's backoff. Bounded by the
     * retry budget plus one cycle, so a task that never settles fails the test instead of hanging.
     */
    const drain = async (worker: CmsWorker, id: string): Promise<'completed' | 'failed'> => {
      for (let cycle = 0; cycle <= MAX_RETRIES + 1; cycle++) {
        await worker.processTaskQueue()
        if (await exists(taskPath('completed', id))) return 'completed'
        if (await exists(taskPath('failed', id))) return 'failed'
        vi.setSystemTime(Date.now() + 61_000)
      }
      throw new Error(`task ${id} never settled`)
    }

    it('saves a publish whose token rotated, which would otherwise exhaust its retries', async () => {
      // The secret store already holds the working token when the push first fails: the
      // provider hands it over once, then has nothing new.
      const refreshGitHubToken = vi
        .fn<() => Promise<string | undefined>>()
        .mockResolvedValueOnce(ROTATED)
        .mockResolvedValue(undefined)
      const { worker, push } = makeTaskWorker(refreshGitHubToken)
      const id = await enqueuePush()

      expect(await drain(worker, id)).toBe('completed')
      // Refused once on the revoked token, then accepted on the first retry.
      expect(push).toHaveBeenCalledTimes(2)
      expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
      const pushed = await simpleGit().raw(['--git-dir', githubFixture, 'rev-parse', 'feature-1'])
      expect(pushed.trim()).toMatch(/^[0-9a-f]{40}$/)
    })

    it('still exhausts the budget when nothing rotated, re-reading after every attempt', async () => {
      // The control for the test above: it proves this harness really drives a task to
      // exhaustion, so "completed" there is the refresh's doing.
      //
      // Floor disabled: this asserts one provider call per attempt, which is this test's own
      // point (re-reading after every attempt), not the floor's.
      const refreshGitHubToken = vi.fn(async () => undefined)
      const { worker, push } = makeTaskWorker(refreshGitHubToken, undefined, 0)
      const id = await enqueuePush()

      expect(await drain(worker, id)).toBe('failed')
      expect(push).toHaveBeenCalledTimes(MAX_RETRIES + 1)
      // Ungated: every failed attempt re-reads, the final one included. That last one starts
      // detached after the failure is recorded, so it is waited for.
      await vi.waitFor(() => expect(refreshGitHubToken).toHaveBeenCalledTimes(MAX_RETRIES + 1))
      expect(consoleSpy).toHaveErrored(`Permanently failed after ${MAX_RETRIES} retries`)
    })

    it('does NOT re-read when the task succeeds', async () => {
      server.acceptedTokens.add(REVOKED)
      const refreshGitHubToken = vi.fn(async () => 'ghp_never_read_0123456789')
      const { worker, push } = makeTaskWorker(refreshGitHubToken)
      const id = await enqueuePush()

      expect(await drain(worker, id)).toBe('completed')
      expect(push).toHaveBeenCalledTimes(1)
      await new Promise((r) => setTimeout(r, 50))
      expect(refreshGitHubToken).not.toHaveBeenCalled()
    })

    it("keeps the task's own error and retry when the re-read itself fails", async () => {
      const refreshGitHubToken = vi.fn(async () => {
        throw new Error('AccessDeniedException reading the secret')
      })
      const { worker } = makeTaskWorker(refreshGitHubToken)
      const id = await enqueuePush()

      await worker.processTaskQueue()

      const pending = JSON.parse(await fs.readFile(taskPath('pending', id), 'utf-8'))
      expect(pending.retryCount).toBe(1)
      expect(pending.error).toMatch(/could not read Username|terminal prompts disabled/)
      expect(pending.error).not.toMatch(/AccessDenied/)
      await vi.waitFor(() =>
        expect(consoleSpy).toHaveErrored('Failed to re-read the GitHub credential'),
      )
    })

    it('keeps draining the queue when the gateway cannot even be built, recording why', async () => {
      // No credential at all, and no gateway installed: building one throws. Only a gateway can
      // re-read a credential, and resolving the config throws before one exists, so no provider
      // could be called; each task records the configuration error itself, which is what the
      // operator must see.
      const worker = new CmsWorker({
        workspacePath,
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        baseBranch: 'main',
        maxRetries: MAX_RETRIES,
      })
      ;(worker as unknown as TaskInternals).running = true
      const first = await enqueuePush('feature-1')
      const second = await enqueuePush('feature-2')

      await worker.processTaskQueue()

      for (const id of [first, second]) {
        const pending = JSON.parse(await fs.readFile(taskPath('pending', id), 'utf-8'))
        expect(pending.retryCount).toBe(1)
        expect(pending.error).toMatch(/githubToken or githubAppAuth is required/)
      }
      expect(consoleSpy).toHaveErrored(
        /Task .* \(push-branch\) failed:.*githubToken or githubAppAuth is required/,
      )
    })

    it('does not let a re-read that never settles stall the task loop', async () => {
      // Rejects long after the bound, so this also proves the losing read's eventual rejection is
      // handled rather than surfacing as unhandled.
      const refreshGitHubToken = vi.fn(
        () =>
          new Promise<string | undefined>((_, reject) => {
            setTimeout(() => reject(new Error('late secret read')), 1_500)
          }),
      )
      const { worker } = makeTaskWorker(refreshGitHubToken, 100)
      const id = await enqueuePush()

      const started = performance.now()
      await worker.processTaskQueue()
      expect(performance.now() - started).toBeLessThan(1_000)

      const pending = JSON.parse(await fs.readFile(taskPath('pending', id), 'utf-8'))
      expect(pending.retryCount).toBe(1)
      await vi.waitFor(() => expect(consoleSpy).toHaveErrored('did not settle within 100ms'))

      await new Promise((r) => setTimeout(r, 1_600))
    })

    it('reaches the provider only once for a burst of failures in the same cycle, under the DEFAULT floor', async () => {
      // Several publishes queued together, all failing, all in ONE processTaskQueue() cycle (up
      // to maxTasksPerCycle, 10 by default, run per cycle), each arming a re-read. Without core's
      // own floor that would be one provider call per task, every cycle. The clock is left
      // untouched and `refreshGitHubTokenMinIntervalMs` is not set, so this is the DEFAULT floor.
      const refreshGitHubToken = vi.fn(async () => undefined)
      const BURST = 5
      const branches = Array.from({ length: BURST }, (_, i) => `burst-${i}`)
      await seedBranches(...branches)
      const { worker, push } = makeTaskWorker(refreshGitHubToken)
      const ids = await Promise.all(branches.map((branch) => enqueuePush(branch)))

      await worker.processTaskQueue()
      await new Promise((r) => setTimeout(r, 50))

      expect(push).toHaveBeenCalledTimes(BURST)
      expect(refreshGitHubToken).toHaveBeenCalledTimes(1)

      // The floor bounds the PROVIDER, not task processing: every task still got its normal
      // outcome (retried, well under maxRetries).
      for (const id of ids) {
        const pending = JSON.parse(await fs.readFile(taskPath('pending', id), 'utf-8'))
        expect(pending.retryCount).toBe(1)
      }
    })
  })
})
