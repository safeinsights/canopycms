/**
 * The gateway's branch policy (worker/branch-policy.ts) through the real in-process gateway:
 * "GitHub" is a local bare repository whose HEAD names `main`, and Octokit a stub. Every refusal
 * must be permanent, must not arm the credential re-read, and must not end the reuse of a GitHub
 * fetch, whatever a hostile worker sends.
 */
import childProcess, { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Octokit } from '@octokit/rest'
import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  initTestRepo,
  mockConsole,
  octokitErrorFor,
  type MockConsole,
  gatewayUnderTest,
  GATEWAY_TRANSPORT,
  expectRebuiltOctokitError,
  closeServedGateways,
} from '../test-utils'
import { DEFAULT_BRANCH_TTL_MS, GatewayRefusalError } from './branch-policy'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import { GitHubTransientError, RefusedPushError } from './github-mirror'
import { pushToGitHub } from './github-transfer'
import { isPermanentTaskFailure } from './task-runner'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let githubPath: string
let remoteGitPath: string
let seed: SimpleGit
let seedPath: string
let consoleSpy: MockConsole

async function commitAndPush(target: string, ref: string, file: string): Promise<string> {
  await fs.writeFile(path.join(seedPath, file), `${file}\n`)
  await seed.add('.')
  await seed.commit(file)
  await seed.raw(['push', '-q', '--force', target, `HEAD:${ref}`])
  return (await seed.revparse(['HEAD'])).trim()
}

const tip = async (ref: string) =>
  git('--git-dir', githubPath, 'rev-parse', '--verify', '-q', ref).catch(() => null)

/** The Octokit calls the policy's operations make, each a spy. */
function octokitStub() {
  return {
    repos: { get: vi.fn().mockResolvedValue({ data: { default_branch: 'main' } }) },
    git: { deleteRef: vi.fn().mockResolvedValue({ data: {} }) },
    pulls: {
      create: vi.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://x.test/1' } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

function gateway(
  overrides: Partial<LocalGitHubGatewayOptions> = {},
  refreshGitHubToken?: () => Promise<string | undefined>,
): GitHubGateway {
  return gatewayUnderTest(
    createLocalGitHubGateway({
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      auth: resolveWorkerGitHubAuth({
        githubToken: 'fake-token-for-policy',
        refreshGitHubToken,
        refreshGitHubTokenMinIntervalMs: 0,
      }),
      githubApp: false,
      stateDirectory: path.join(root, 'state'),
      workspacePath: path.join(root, 'workspace'),
      timeoutMs: 30_000,
      remoteUrl: githubPath,
      ...overrides,
    }),
  )
}

/** Push remote.git's `branch` as the worker does, optionally under a lease. */
function pushVia(github: GitHubGateway, branch: string, lease?: string) {
  return pushToGitHub(
    { github: () => github, remoteGitPath, taskTimeoutMs: 30_000 },
    { branch, lease, prerequisiteBranches: [branch, 'main'] },
    async () => git('--git-dir', remoteGitPath, 'rev-parse', `refs/heads/${branch}`),
  )
}

/** A commit on `branch` in remote.git, on top of GitHub's `main`. */
async function onMain(branch: string): Promise<string> {
  await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'refs/heads/main:refs/heads/main')
  await seed.raw(['checkout', '-q', '-B', `work-${branch.replace(/\W/g, '-')}`, 'main'])
  return commitAndPush(remoteGitPath, `refs/heads/${branch}`, `${branch.replace(/\W/g, '-')}.txt`)
}

/** The git subcommand of a spawn's argv, after simple-git's `-c` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i]
}

/** Every git subcommand spawned with the credential from here on. */
function spyCredentialedGit(): string[] {
  const seen: string[] = []
  const original = childProcess.spawn
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined> },
  ) => {
    if (options?.env?.GIT_CONFIG_GLOBAL !== undefined) seen.push(subcommand(args))
    return original(command, args, options)
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  return seen
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-gateway-policy-')))
  githubPath = path.join(root, 'github.git')
  remoteGitPath = path.join(root, 'workspace', 'remote.git')
  seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', 'main'])
  await git('init', '-q', '--bare', '--initial-branch', 'main', githubPath)
  await git('init', '-q', '--bare', remoteGitPath)
  await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
})

afterEach(async () => {
  await closeServedGateways()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('pushes', () => {
  it('refuses a branch a protectedBranches glob names, plain or leased, leaving GitHub alone', async () => {
    const sha = await onMain('release/2026')
    const github = gateway({ protectedBranches: ['release/*'] })

    for (const lease of [undefined, '0'.repeat(40)]) {
      const caught = await pushVia(github, 'release/2026', lease).catch((err: unknown) => err)
      expect(caught).toBeInstanceOf(RefusedPushError)
      expect(caught).toMatchObject({ reason: 'protected' })
    }
    expect(await tip('refs/heads/release/2026')).toBeNull()
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("refuses the configured base branch when it is not GitHub's default", async () => {
    await onMain('production')

    const caught = await pushVia(gateway({ baseBranch: 'production' }), 'production').catch(
      (err: unknown) => err,
    )

    expect(caught).toMatchObject({ reason: 'protected' })
    expect(await tip('refs/heads/production')).toBeNull()
  })

  it('pushes a branch that differs from a protected one only in case, a ref of its own on GitHub', async () => {
    const sha = await onMain('production')

    await pushVia(gateway({ baseBranch: 'Production' }), 'production')

    expect(await tip('refs/heads/production')).toBe(sha)
  })

  it('pushes the settings branch whatever glob protectedBranches holds', async () => {
    const sha = await onMain('canopycms-settings-prod')

    await pushVia(gateway({ protectedBranches: ['*-prod'] }), 'canopycms-settings-prod')

    expect(await tip('refs/heads/canopycms-settings-prod')).toBe(sha)
  })

  it('pushes a settings branch plainly, and refuses it under a lease', async () => {
    const first = await onMain('canopycms-settings-prod')
    const github = gateway()

    expect((await pushVia(github, 'canopycms-settings-prod')).outcome).toMatchObject({
      moved: true,
      to: first,
    })
    await commitAndPush(remoteGitPath, 'refs/heads/canopycms-settings-prod', 'again.txt')
    const caught = await pushVia(github, 'canopycms-settings-prod', first).catch(
      (err: unknown) => err,
    )

    expect(caught).toMatchObject({ reason: 'settings' })
    expect(await tip('refs/heads/canopycms-settings-prod')).toBe(first)
  })

  it("reads GitHub's default branch once per TTL", async () => {
    await onMain('feature')
    const github = gateway({ fetchCoalesceMs: 0 })
    const credentialed = spyCredentialedGit()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)

    await pushVia(github, 'feature')
    await commitAndPush(remoteGitPath, 'refs/heads/feature', 'second.txt')
    await pushVia(github, 'feature')
    expect(credentialed.filter((command) => command === 'ls-remote')).toHaveLength(1)

    clock.mockReturnValue(now + DEFAULT_BRANCH_TTL_MS)
    await commitAndPush(remoteGitPath, 'refs/heads/feature', 'third.txt')
    await pushVia(github, 'feature')
    expect(credentialed.filter((command) => command === 'ls-remote')).toHaveLength(2)
  })
})

describe('deletions', () => {
  it.each([
    ["GitHub's default branch", 'main', {}],
    ['the configured base branch', 'production', { baseBranch: 'production' }],
    ['a listed branch', 'keep/this', { protectedBranches: ['keep/*'] }],
    ['a settings branch', 'canopycms-settings-prod', {}],
  ] as const)('refuses %s', async (_label, branch, options) => {
    const octokit = octokitStub()

    const caught = await gateway({ ...options, octokit: octokit as unknown as Octokit })
      .deleteBranch(branch)
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GatewayRefusalError)
    expect(caught).toMatchObject({ operation: 'delete', branch })
    expect(octokit.git.deleteRef).not.toHaveBeenCalled()
  })

  it('deletes any other branch', async () => {
    const octokit = octokitStub()

    await gateway({ octokit: octokit as unknown as Octokit }).deleteBranch('feature')

    expect(octokit.git.deleteRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/feature' }),
    )
  })
})

describe('pull requests', () => {
  const request = (head: string, base = 'main') => ({ head, base, title: 'T', body: 'B' })

  it.each([
    ["GitHub's default branch", 'main', {}],
    ['a listed branch', 'release/1', { protectedBranches: ['release/*'] }],
    ['a settings branch', 'canopycms-settings-prod', {}],
  ] as const)(
    'refuses one whose head is %s, both ways of opening it',
    async (_l, head, options) => {
      const octokit = octokitStub()
      const github = gateway({ ...options, octokit: octokit as unknown as Octokit })

      await expect(github.createPullRequest(request(head))).rejects.toBeInstanceOf(
        GatewayRefusalError,
      )
      await expect(github.createOrUpdatePullRequest(request(head))).rejects.toBeInstanceOf(
        GatewayRefusalError,
      )
      expect(octokit.pulls.create).not.toHaveBeenCalled()
      expect(octokit.pulls.list).not.toHaveBeenCalled()
    },
  )

  it('opens one onto a protected base', async () => {
    const octokit = octokitStub()
    const github = gateway({ octokit: octokit as unknown as Octokit, baseBranch: 'production' })

    await github.createPullRequest(request('feature', 'production'))

    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'feature', base: 'production' }),
    )
  })

  it('refuses text over its caps, on create and on update', async () => {
    const octokit = octokitStub()
    const github = gateway({ octokit: octokit as unknown as Octokit })

    await expect(
      github.createPullRequest({ ...request('feature'), title: 't'.repeat(1025) }),
    ).rejects.toMatchObject({ reason: 'too-long' })
    await expect(github.updatePullRequest(3, { body: 'b'.repeat(65_537) })).rejects.toMatchObject({
      reason: 'too-long',
    })
    expect(octokit.pulls.create).not.toHaveBeenCalled()
    expect(octokit.pulls.update).not.toHaveBeenCalled()
  })
})

describe('branch names', () => {
  const request = (head: string, base = 'main') => ({ head, base, title: 'T', body: 'B' })

  it.each([
    ['a leading refs/heads/', 'refs/heads/main'],
    ['a leading heads/', 'heads/main'],
    ['an owner prefix', 'someone:main'],
    ['a percent escape', 'm%61in'],
    ['a leading dash', '--upload-pack=x'],
    ['a bidi control', 'ma\u202ein'],
    ['a range', 'main..x'],
  ])('refuses %s for a delete and a pull request head', async (_label, name) => {
    const octokit = octokitStub()
    const github = gateway({ octokit: octokit as unknown as Octokit })

    for (const attempt of [
      () => github.deleteBranch(name),
      () => github.createPullRequest(request(name)),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ reason: 'invalid' })
    }
    expect(octokit.git.deleteRef).not.toHaveBeenCalled()
    expect(octokit.pulls.create).not.toHaveBeenCalled()
  })

  it.each([
    ['an owner prefix', 'someone:main'],
    ['a leading dash', '--upload-pack=x'],
    ['a range', 'main..x'],
  ])('refuses %s, which git refuses, for a pull request base', async (_label, name) => {
    const octokit = octokitStub()

    await expect(
      gateway({ octokit: octokit as unknown as Octokit }).createPullRequest(
        request('feature', name),
      ),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(octokit.pulls.create).not.toHaveBeenCalled()
  })

  it('refuses a base longer than a branch name can be', async () => {
    const octokit = octokitStub()

    await expect(
      gateway({ octokit: octokit as unknown as Octokit }).createPullRequest(
        request('feature', 'b'.repeat(256)),
      ),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(octokit.pulls.create).not.toHaveBeenCalled()
  })

  it('takes a base git takes, outside the names it acts on: a configured base can be any', async () => {
    const octokit = octokitStub()

    await gateway({ octokit: octokit as unknown as Octokit }).createPullRequest(
      request('feature', 'd\u00e9veloppement'),
    )

    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'd\u00e9veloppement' }),
    )
  })
})

describe('a hostile worker', () => {
  it('drives every refusal without arming the credential re-read or ending fetch reuse', async () => {
    await onMain('feature')
    await onMain('canopycms-settings-prod')
    const blob = await git('--git-dir', githubPath, 'rev-parse', 'main:main.txt')
    const provider = vi.fn(async () => undefined)
    const octokit = octokitStub()
    const github = gateway(
      { octokit: octokit as unknown as Octokit, protectedBranches: ['release/*'] },
      provider,
    )
    const credentialed = spyCredentialedGit()
    await github.fetch({ have: [] })
    const main = await git('--git-dir', githubPath, 'rev-parse', 'refs/heads/main')
    const pushOf = (branch: string, sha: string, lease?: string) =>
      github.push({ branch, sha, lease, prerequisites: [] })

    const refusals = [
      pushOf('main', main),
      pushOf('release/1', main),
      pushOf('canopycms-settings-prod', main, main),
      pushOf('feature', blob),
      pushOf('refs/heads/main', main),
      pushOf('m%61in', main),
      github.deleteBranch('main'),
      github.deleteBranch('canopycms-settings-prod'),
      github.deleteBranch('-x'),
      github.createPullRequest({ head: 'main', base: 'feature', title: 'T', body: 'B' }),
      github.createOrUpdatePullRequest({ head: 'release/1', base: 'main', title: 'T', body: '' }),
      github.createPullRequest({
        head: 'feature',
        base: 'main',
        title: 't'.repeat(2000),
        body: '',
      }),
      github.updatePullRequest(1, { title: 't'.repeat(2000) }),
    ]
    const caught = await Promise.all(
      refusals.map((p) =>
        p.then(
          () => null,
          (err: unknown) => err,
        ),
      ),
    )
    await github.fetch({ have: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))

    for (const err of caught) {
      expect(err).toBeInstanceOf(GatewayRefusalError)
      expect(isPermanentTaskFailure(err)).toBe(true)
    }
    expect(provider).not.toHaveBeenCalled()
    // The first fetch's result served the refused pushes and the second fetch alike.
    expect(credentialed.filter((command) => command === 'fetch')).toHaveLength(1)
    expect(octokit.git.deleteRef).not.toHaveBeenCalled()
    expect(octokit.pulls.create).not.toHaveBeenCalled()
    expect(octokit.pulls.update).not.toHaveBeenCalled()
  })
})

describe('the canary sweep', () => {
  /**
   * No GitHub prefix, so only the gateway's exact-string scrub can catch it; `~` puts a `+` in its
   * base64, so the URL-encoded form differs.
   */
  const TOKEN = 'CANARY~~~sweep0123456789abcdefABCDEF'
  const pair = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  const FORMS = [TOKEN, pair, `AUTHORIZATION: basic ${pair}`, encodeURIComponent(pair)]
  const SECRETS = [TOKEN, pair.slice(20), encodeURIComponent(pair).slice(20)]
  /** No 16 characters in a row of any form: a partial scrub leaks too. */
  const holdsNoForm = (text: string) => {
    for (const secret of SECRETS) {
      for (let i = 0; i + 16 <= secret.length; i++) {
        expect(text).not.toContain(secret.slice(i, i + 16))
      }
    }
  }

  const tokenGateway = (
    overrides: Partial<LocalGitHubGatewayOptions>,
    refreshGitHubToken: () => Promise<string | undefined>,
  ) =>
    gatewayUnderTest(
      createLocalGitHubGateway({
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        auth: resolveWorkerGitHubAuth({
          githubToken: TOKEN,
          refreshGitHubToken,
          refreshGitHubTokenMinIntervalMs: 0,
        }),
        githubApp: false,
        stateDirectory: path.join(root, 'state'),
        workspacePath: path.join(root, 'workspace'),
        timeoutMs: 30_000,
        ...overrides,
      }),
    )

  /** Everything an error carries that can leave the gateway. */
  const everything = (err: unknown): string =>
    err instanceof Error
      ? [
          JSON.stringify(err, Object.getOwnPropertyNames(err)),
          String(err.stack),
          JSON.stringify((err as { response?: unknown }).response ?? null),
          JSON.stringify((err as { request?: unknown }).request ?? null),
        ].join('\n')
      : String(err)

  it('lets no form of the token out in an error, an answer or a log line', async () => {
    // git names a missing repository in its error; this one's path carries every form.
    const missing = path.join(
      root,
      FORMS.map((form) => form.replace(/\//g, '_')).join('-'),
      'x.git',
    )
    const named = path.join(root, `${TOKEN}${pair}`, '_missing.git')
    const octokitError = Object.assign(new Error(`GitHub said ${FORMS.join(' ')}`), {
      status: 500,
      response: { status: 500, headers: { 'x-echo': pair }, data: { message: FORMS.join(' ') } },
      request: { headers: { authorization: `token ${TOKEN}` } },
    })
    const octokit = {
      ...octokitStub(),
      pulls: {
        create: vi.fn().mockRejectedValue(octokitError),
        get: vi.fn().mockResolvedValue({
          data: {
            merged: false,
            merged_at: null,
            state: 'open',
            node_id: TOKEN,
            title: `x ${pair}`,
          },
        }),
      },
    }
    // Armed by each GitHub failure: its own failure is logged.
    const provider = vi.fn(async () => {
      throw new Error(`could not read the secret: ${FORMS.join(' ')}`)
    })
    const sha = await onMain('feature')
    const failing = tokenGateway(
      { remoteUrl: named, octokit: octokit as unknown as Octokit },
      provider,
    )
    const failingToo = tokenGateway(
      { remoteUrl: missing, stateDirectory: path.join(root, 'state-too') },
      provider,
    )

    const caught = await Promise.all(
      [
        failing.fetch({ have: [] }),
        failing.push({ branch: 'feature', sha, prerequisites: [] }),
        failingToo.fetch({ have: [] }),
        failing.createPullRequest({ head: 'feature', base: 'main', title: 'T', body: 'B' }),
      ].map((attempt) =>
        attempt.then(
          () => null,
          (err: unknown) => err,
        ),
      ),
    )
    const answer = await failing.getPullRequest(1)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Not vacuous: git's own output and Octokit's error came through, less the token.
    expect(String(caught[0])).toContain('_missing.git')
    expect(String(caught[3])).toContain('GitHub said')
    expect(provider).toHaveBeenCalled()
    for (const err of caught) {
      expect(err).toBeInstanceOf(Error)
      holdsNoForm(everything(err))
    }
    holdsNoForm(JSON.stringify(answer))
    const logged = Object.values(consoleSpy.all()).flat().join('\n')
    expect(logged).toContain('Failed to re-read the GitHub credential')
    holdsNoForm(logged)
  })
})

describe('an unread default branch', () => {
  it('fails a push as transient, caching nothing, when its ls-remote fails', async () => {
    await onMain('feature')
    const provider = vi.fn(async () => undefined)
    const github = gateway({}, provider)
    const sent: string[] = []
    let failLsRemote = true
    const original = childProcess.spawn
    vi.spyOn(childProcess, 'spawn').mockImplementation(((
      command: string,
      args: readonly string[],
      options: { env?: Record<string, string | undefined> },
    ) => {
      const lsRemote =
        options?.env?.GIT_CONFIG_GLOBAL !== undefined && subcommand(args) === 'ls-remote'
      if (lsRemote) sent.push('ls-remote')
      const redirected =
        lsRemote && failLsRemote
          ? args.map((arg) => (arg === githubPath ? path.join(root, 'missing.git') : arg))
          : args
      return original(command, redirected, options)
    }) as typeof childProcess.spawn)
    syncBuiltinESMExports()

    const caught = await pushVia(github, 'feature').catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(caught).toMatchObject({ code: 'default-branch-unread' })
    expect(isPermanentTaskFailure(caught)).toBe(false)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await tip('refs/heads/feature')).toBeNull()

    failLsRemote = false
    await pushVia(github, 'feature')
    // Read again, not taken from a cache the failure filled.
    expect(sent).toEqual(['ls-remote', 'ls-remote'])
    expect(await tip('refs/heads/feature')).not.toBeNull()
  })

  it("passes a deletion's repos.get failure on unchanged, arming the re-read and caching nothing", async () => {
    const octokit = octokitStub()
    const notFound = await octokitErrorFor(404, { message: 'Not Found' })
    octokit.repos.get.mockRejectedValueOnce(notFound)
    const provider = vi.fn(async () => undefined)
    const github = gateway({ octokit: octokit as unknown as Octokit }, provider)

    const caught = await github.deleteBranch('feature').catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 50))

    if (GATEWAY_TRANSPORT === 'local') expect(caught).toBe(notFound)
    else expectRebuiltOctokitError(caught, notFound)
    expect(caught).toMatchObject({ status: 404 })
    expect(isPermanentTaskFailure(caught)).toBe(true)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(octokit.git.deleteRef).not.toHaveBeenCalled()

    await github.deleteBranch('feature')
    expect(octokit.repos.get).toHaveBeenCalledTimes(2)
    expect(octokit.git.deleteRef).toHaveBeenCalledTimes(1)
  })
})

describe("the pull request helper's warnings", () => {
  it("go through the gateway's log: scrubbed, and on one escaped line", async () => {
    const octokit = octokitStub()
    octokit.pulls.list.mockResolvedValue({
      data: [
        {
          number: 5,
          draft: true,
          node_id: 'PR_5',
          html_url: 'https://x.test/5',
          updated_at: '2026-01-01T00:00:00Z',
          body: '',
        },
      ],
    })
    // GitHub's GraphQL error text is not the gateway's: it can carry anything.
    const leaked = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
    const graphql = vi.fn().mockRejectedValue(new Error(`refused ${leaked}\nFORGED log line`))
    const github = gateway({ octokit: { ...octokit, graphql } as unknown as Octokit })

    await github.createOrUpdatePullRequest({
      head: 'feature',
      base: 'main',
      title: 'T',
      body: 'B',
      markReadyIfDraft: true,
    })

    const warned = consoleSpy.all().warn.filter((line) => line.includes('ready for review'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain(leaked)
    expect(warned[0]).toContain('\\nFORGED log line')
    expect(warned[0]).not.toContain('\n')
  })
})

describe('answers', () => {
  it("keep GitHub's branch names, even ones shaped like a token", async () => {
    const names = [
      'chore/github_pat_rotation',
      'ghs_cleanup_scripts',
      'eyJ-review-notes.abcdefghij.x',
    ]
    for (const name of names) {
      await git('--git-dir', githubPath, 'update-ref', `refs/heads/${name}`, 'refs/heads/main')
    }

    const { refs } = await gateway().fetch({ have: [] })

    for (const name of names) expect(refs.has(name)).toBe(true)
  })
})
