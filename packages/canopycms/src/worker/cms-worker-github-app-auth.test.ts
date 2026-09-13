/**
 * CmsWorker's end of GitHub App authentication: the credential behind
 * buildGitHubUrl(), the Octokit client it hands the same auth to, and the
 * startup preflight that stops a bad credential from being reported as an
 * empty repository.
 *
 * github-auth.test.ts covers the resolver itself; these tests are about the
 * wiring — that the worker really routes both halves through it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'

import { CmsWorker } from './cms-worker'
import type { GitHubAppAuth } from './github-auth'
import { isPermanentTaskFailure } from './task-runner'
import { WORKER_STATUS_FILE } from './worker-status'
import type { WorkerStatusReport } from '../types'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'

/** buildGitHubUrl() is private; these tests are precisely about its output. */
type GitUrlInternals = {
  buildGitHubUrl(): Promise<string>
  octokit: { auth: (options?: unknown) => Promise<unknown> }
}

/**
 * An `@octokit/auth-app`-shaped injection. `octokitAuth.authStrategy` returns
 * one already-constructed instance, which is how a real entrypoint shares a
 * single token cache between Octokit and the git side.
 */
const appAuthWith = (
  mintInstallationToken: GitHubAppAuth['mintInstallationToken'],
): GitHubAppAuth => {
  const instance = Object.assign(async () => ({ token: 'ghs_from_strategy' }), {
    hook: () => {},
  })
  return {
    mintInstallationToken,
    octokitAuth: { authStrategy: () => instance, auth: {} },
  }
}

describe('CmsWorker GitHub App authentication', () => {
  let tmpDir: string
  let workspacePath: string
  let githubFixture: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-app-auth-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])
    await simpleGit().raw(['init', '--bare', githubFixture])
    await seedBaseBranch()
  })

  /**
   * Give remote.git a `main` — ensureRemoteGit refuses a refs-less bare repo
   * (its empty-GitHub-repo guard), and the preflight tests below need startup
   * to get past it.
   */
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

  const makeWorker = (auth: { githubToken?: string; githubAppAuth?: GitHubAppAuth }) =>
    new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      ...auth,
    })

  describe('buildGitHubUrl()', () => {
    it('still embeds a personal access token when no App auth is injected at all', async () => {
      // The regression guard for the default path. App auth is purely
      // additive: nothing about this URL changed, and no App machinery is
      // reachable from it.
      const worker = makeWorker({ githubToken: 'ghp_static' })

      expect(await (worker as unknown as GitUrlInternals).buildGitHubUrl()).toBe(
        'https://x-access-token:ghp_static@github.com/test-owner/test-repo.git',
      )
    })

    it('embeds a freshly minted installation token under App auth', async () => {
      const worker = makeWorker({ githubAppAuth: appAuthWith(async () => 'ghs_minted') })

      expect(await (worker as unknown as GitUrlInternals).buildGitHubUrl()).toBe(
        'https://x-access-token:ghs_minted@github.com/test-owner/test-repo.git',
      )
    })

    it('mints per call, so no tokenized URL is ever reused across calls', async () => {
      // An installation token expires in about an hour; a URL cached from one
      // goes stale with it. Varied ACROSS calls on purpose -- a single
      // pushBranchToGitHub resolves exactly once by design, and
      // cms-worker.test.ts pins that.
      let minted = 0
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => `ghs_token_${++minted}`),
      })
      const internals = worker as unknown as GitUrlInternals

      const first = await internals.buildGitHubUrl()
      const second = await internals.buildGitHubUrl()

      expect(first).toContain('ghs_token_1')
      expect(second).toContain('ghs_token_2')
      expect(first).not.toBe(second)
    })

    it('lets a mint failure through unwrapped, so the task classifier still sees its status', async () => {
      // buildGitHubUrl is on the push path, where a wrapped error would be
      // classified as transient and burn the task's whole retry budget
      // against a permanently bad credential.
      const thrown = Object.assign(new Error('Bad credentials'), { status: 401 })
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => {
          throw thrown
        }),
      })

      const caught = await (worker as unknown as GitUrlInternals)
        .buildGitHubUrl()
        .catch((err: unknown) => err)

      expect(caught).toBe(thrown)
      expect(isPermanentTaskFailure(caught)).toBe(true)
    })
  })

  describe('Octokit', () => {
    it('is built through the injected auth strategy under App auth', async () => {
      const worker = makeWorker({ githubAppAuth: appAuthWith(async () => 'ghs_minted') })

      // Octokit assigns the strategy's return value to `.auth`, so this is
      // the observable proof that the passthrough reached the constructor
      // rather than being dropped on the way through createCanopyOctokit.
      await expect((worker as unknown as GitUrlInternals).octokit.auth()).resolves.toEqual({
        token: 'ghs_from_strategy',
      })
    })

    it('still authenticates with the bare token on the token path', async () => {
      const worker = makeWorker({ githubToken: 'ghp_static' })

      await expect((worker as unknown as GitUrlInternals).octokit.auth()).resolves.toMatchObject({
        token: 'ghp_static',
        type: 'token',
      })
    })
  })

  describe('construction', () => {
    it('refuses a worker configured with neither credential', () => {
      expect(() => makeWorker({})).toThrow(/githubToken or githubAppAuth is required/)
    })

    it('refuses a worker configured with both', () => {
      expect(() =>
        makeWorker({
          githubToken: 'ghp_static',
          githubAppAuth: appAuthWith(async () => 'ghs_minted'),
        }),
      ).toThrow(/not both/)
    })
  })

  describe('startup preflight', () => {
    const readStatus = async (): Promise<WorkerStatusReport> =>
      JSON.parse(
        await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'),
      ) as WorkerStatusReport

    it('reports a bad App credential as an auth failure, not as an empty repository', async () => {
      // Without the preflight the first use of the credential is
      // ensureRemoteGit's bare clone, whose catch says "the GitHub repository
      // may be empty, or the base branch may not exist" -- sending the
      // operator after a repository problem that does not exist.
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => {
          throw Object.assign(new Error('A JSON web token could not be decoded'), {
            status: 401,
          })
        }),
      })

      await expect(worker.start()).rejects.toThrow(/GitHub App authentication failed/)

      const status = await readStatus()
      expect(status.lastFatalError?.phase).toBe('startup')
      expect(status.lastFatalError?.message).toContain('GitHub App authentication failed')
      expect(status.lastFatalError?.message).toContain('A JSON web token could not be decoded')
      expect(status.lastFatalError?.message).toContain('the private key belongs to that app')
      // The claim that matters, and it is only meaningful next to the three
      // positive assertions above: the misleading clone wording is absent
      // because the preflight ran first, not because the message is empty.
      expect(status.lastFatalError?.message).not.toContain('may be empty')
      // The lock must not be left held -- systemd restarts immediately.
      await expect(fs.access(path.join(workspacePath, '.tasks', '.worker-lock'))).rejects.toThrow()
    })

    it('runs BEFORE the clone, on a cold workspace where the clone would otherwise speak first', async () => {
      // The test above cannot pin the ordering: beforeEach seeds remote.git,
      // so ensureRemoteGit short-circuits and its misleading catch is never
      // reachable. Here remote.git does NOT exist, so moving the preflight
      // below ensureRemoteGit really does change which message the operator
      // gets -- measured: with the call moved, this goes red on "may be
      // empty" and the test above stays green.
      await fs.rm(path.join(workspacePath, 'remote.git'), { recursive: true, force: true })
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => {
          throw Object.assign(new Error('Bad credentials'), { status: 401 })
        }),
      })

      await expect(worker.start()).rejects.toThrow(/GitHub App authentication failed/)

      const status = await readStatus()
      expect(status.lastFatalError?.message).toContain('GitHub App authentication failed')
      expect(status.lastFatalError?.message).not.toContain('may be empty')
    })

    it('does not exit on a transient failure, because the token path would not either', async () => {
      // A GitHub 5xx during boot must not be fatal. On the token path a warm
      // remote.git short-circuits ensureRemoteGit and Promise.allSettled
      // swallows the initial syncGit, so the worker starts and retries; if
      // this path exited instead, systemd (Restart=always) would crash-loop
      // the instance until GitHub recovered, blaming the private key each
      // time.
      let mints = 0
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => {
          mints++
          throw Object.assign(new Error('Service unavailable'), { status: 503 })
        }),
      })
      ;(worker as unknown as { buildGitHubUrl(): Promise<string> }).buildGitHubUrl = async () =>
        githubFixture

      try {
        await worker.start()
        expect(mints).toBe(1)
        expect(consoleSpy).toHaveWarned('Could not verify GitHub App authentication at startup')
        expect(consoleSpy).toHaveWarned('Service unavailable')
        expect(consoleSpy).toHaveLogged('CMS Worker started')
        expect(consoleSpy).not.toHaveLogged('GitHub App authentication verified')
      } finally {
        await worker.stop()
      }
    })

    it('still exits on a permanent failure, which is what the check is for', async () => {
      // The complement of the test above, so neither can pass by the
      // classifier having been wired to a constant.
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => {
          throw Object.assign(new Error('Bad credentials'), { status: 401 })
        }),
      })

      await expect(worker.start()).rejects.toThrow(/GitHub App authentication failed/)
      expect(consoleSpy).not.toHaveWarned('Continuing')
    })

    it('mints once before any git work and lets startup continue', async () => {
      let mintedBeforeGit = 0
      const worker = makeWorker({
        githubAppAuth: appAuthWith(async () => `ghs_token_${++mintedBeforeGit}`),
      })
      // Keep every later git operation off the network; the preflight does not
      // go through this seam, so it is unaffected.
      ;(worker as unknown as { buildGitHubUrl(): Promise<string> }).buildGitHubUrl = async () =>
        githubFixture

      try {
        await worker.start()
        expect(mintedBeforeGit).toBe(1)
        expect(consoleSpy).toHaveLogged('GitHub App authentication verified')
      } finally {
        await worker.stop()
      }
    })

    it('does not run at all on the token path', async () => {
      const worker = makeWorker({ githubToken: 'ghp_static' })
      ;(worker as unknown as { buildGitHubUrl(): Promise<string> }).buildGitHubUrl = async () =>
        githubFixture

      try {
        await worker.start()
        expect(consoleSpy).not.toHaveLogged('GitHub App authentication verified')
        expect(consoleSpy).toHaveLogged('CMS Worker started')
      } finally {
        await worker.stop()
      }
    })
  })
})
