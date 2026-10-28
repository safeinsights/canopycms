/**
 * The in-process GitHub gateway's contract, against real git: "GitHub" is a local bare repository
 * reached through the `remoteUrl` seam, and Octokit is a stub. The worker suites cover how the
 * worker uses each answer; these pin the answers themselves.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import {
  initTestRepo,
  mockConsole,
  octokitErrorFor,
  type MockConsole,
  gatewayUnderTest,
  GATEWAY_TRANSPORT,
  passedSignal,
  serverRequestOption,
  expectRebuiltOctokitError,
  closeServedGateways,
} from '../test-utils'
import { isNonFastForwardRejection } from '../utils/git'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  GitHubPushError,
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import { GitHubMirror, RefusedPushError, parsePushStatus } from './github-mirror'
import {
  fetchGitHubIntoRemoteGit,
  pushToGitHub,
  seedFromGitHub,
  type TransferContext,
} from './github-transfer'

const execFileAsync = promisify(execFile)

let root: string
let githubPath: string
let remoteGitPath: string
let seedPath: string
let seed: SimpleGit
let consoleSpy: MockConsole

const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()
const tip = async (gitDir: string, ref: string) =>
  git('--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref).catch(() => null)

/** Commit `file` on the seed's current branch and push it to `target`'s `ref`. */
async function commitAndPush(target: string, ref: string, file: string): Promise<string> {
  await fs.writeFile(path.join(seedPath, file), `${file}\n`)
  await seed.add('.')
  await seed.commit(file)
  await seed.raw(['push', '-q', '--force', target, `HEAD:${ref}`])
  return (await seed.revparse(['HEAD'])).trim()
}

/** `octokit.repos`, answering GitHub's default branch, which the policy reads before a PR or delete. */
const defaultBranchStub = (name = 'main') => ({
  get: vi.fn().mockResolvedValue({ data: { default_branch: name } }),
})

function gateway(overrides: Partial<LocalGitHubGatewayOptions> = {}): GitHubGateway {
  return gatewayUnderTest(
    createLocalGitHubGateway({
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
      githubApp: false,
      stateDirectory: path.join(root, 'state'),
      workspacePath: path.join(root, 'workspace'),
      timeoutMs: 30_000,
      remoteUrl: githubPath,
      // Each operation fetches GitHub afresh, so a test sees what it changed there.
      fetchCoalesceMs: 0,
      ...overrides,
    }),
  )
}

/** The worker's side of a transfer, over `github`, with remote.git as this test's. */
function transfer(github: GitHubGateway): TransferContext {
  return { github: () => github, remoteGitPath, taskTimeoutMs: 30_000 }
}

/**
 * Push `sha` as the worker does: asked for without objects first, then with a bundle from
 * remote.git when the gateway needs one.
 */
async function pushVia(
  github: GitHubGateway,
  request: { branch: string; sha: string; lease?: string },
) {
  const { sha, ...rest } = request
  const pushed = await pushToGitHub(
    transfer(github),
    { ...rest, prerequisiteBranches: [request.branch] },
    async () => sha,
  )
  return pushed.outcome
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-github-gateway-')))
  githubPath = path.join(root, 'github.git')
  remoteGitPath = path.join(root, 'workspace', 'remote.git')
  seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', 'main'])
  // GitHub's default branch is `main`, whatever git's own default is.
  await git('init', '-q', '--bare', '--initial-branch', 'main', githubPath)
  await git('init', '-q', '--bare', remoteGitPath)
})

afterEach(async () => {
  await closeServedGateways()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('fetch', () => {
  it("publishes GitHub's branches into remote.git's tracking namespace", async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const feature = await commitAndPush(githubPath, 'refs/heads/feature/x', 'feature.txt')

    const { refs } = await fetchGitHubIntoRemoteGit(transfer(gateway()))

    expect(refs).toEqual(
      new Map([
        ['feature/x', feature],
        ['main', main],
      ]),
    )
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}main`)).toBe(main)
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}feature/x`)).toBe(feature)
  })

  it('prunes a branch GitHub no longer has from remote.git', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await commitAndPush(githubPath, 'refs/heads/gone', 'gone.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/gone')

    await fetchGitHubIntoRemoteGit(transfer(github))

    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}gone`)).toBeNull()
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}main`)).not.toBeNull()
  })

  it('resolves a function-valued remoteUrl on every use', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const remoteUrl = vi.fn(() => Promise.resolve(githubPath))
    const github = gateway({ remoteUrl })

    await github.fetch({ have: [] })
    await github.fetch({ have: [] })

    expect(remoteUrl).toHaveBeenCalledTimes(2)
  })
})

describe('fetch progress', () => {
  it("tells the caller of the gateway's git working while it waits", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const onProgress = vi.fn()

    await gateway().fetch({ have: [] }, undefined, onProgress)

    expect(onProgress).toHaveBeenCalled()
  })
})

describe('seedFromGitHub', () => {
  const target = () => path.join(root, 'workspace', 'remote.git.cloning')

  it('seeds a new bare repository with every GitHub branch', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const feature = await commitAndPush(githubPath, 'refs/heads/feature/x', 'feature.txt')

    const refs = await seedFromGitHub(transfer(gateway()), target(), 'main')

    expect(refs).toEqual(
      new Map([
        ['feature/x', feature],
        ['main', main],
      ]),
    )
    expect(await tip(target(), 'refs/heads/main')).toBe(main)
    expect(await tip(target(), 'refs/heads/feature/x')).toBe(feature)
    expect(await tip(target(), `${GITHUB_TRACKING_REF_PREFIX}main`)).toBeNull()
  })

  it('refuses when GitHub has no base branch, before creating anything', async () => {
    await commitAndPush(githubPath, 'refs/heads/other', 'other.txt')

    await expect(seedFromGitHub(transfer(gateway()), target(), 'main')).rejects.toThrow(
      "GitHub has no branch 'main'",
    )
    await expect(fs.stat(target())).rejects.toThrow()
  })
})

describe('push', () => {
  /** A branch in remote.git one commit ahead of what GitHub has for it. */
  const aheadOnRemoteGit = async (branch: string) => {
    const base = await commitAndPush(githubPath, `refs/heads/${branch}`, `${branch}-base.txt`)
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, `${base}:refs/heads/${branch}`)
    const ahead = await commitAndPush(remoteGitPath, `refs/heads/${branch}`, `${branch}-ahead.txt`)
    return { base, ahead }
  }

  it("pushes exactly the commit asked for to GitHub's branch, and says where it moved from", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { base, ahead } = await aheadOnRemoteGit('canopycms-feature')

    const outcome = await pushVia(gateway(), {
      branch: 'canopycms-feature',
      sha: ahead,
    })

    expect(outcome).toEqual({
      moved: true,
      from: expect.stringMatching(/^[0-9a-f]{7,}$/),
      to: ahead,
      pastStaleLease: false,
    })
    expect(outcome.moved && base.startsWith(outcome.from ?? '-')).toBe(true)
    expect(await tip(githubPath, 'refs/heads/canopycms-feature')).toBe(ahead)
  })

  it('reports a push of the commit GitHub already holds as not moved', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')
    const request = { branch: 'canopycms-feature', sha: ahead }
    await pushVia(gateway(), request)

    expect(await pushVia(gateway(), request)).toEqual({ moved: false, pastStaleLease: false })
    expect(await pushVia(gateway(), { ...request, lease: '0'.repeat(40) })).toEqual({
      moved: false,
      pastStaleLease: false,
    })
  })

  it('reports a new branch with no previous tip', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const sha = await commitAndPush(remoteGitPath, 'refs/heads/canopycms-fresh', 'fresh.txt')

    expect(await pushVia(gateway(), { branch: 'canopycms-fresh', sha })).toEqual({
      moved: true,
      from: null,
      to: sha,
      pastStaleLease: false,
    })
  })

  it('reports a forced update under a held lease as moved from the leased commit', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { base } = await aheadOnRemoteGit('canopycms-feature')
    await seed.raw(['checkout', '-q', '--orphan', 'rewritten'])
    const rewritten = await commitAndPush(
      remoteGitPath,
      'refs/heads/canopycms-feature',
      'rewritten.txt',
    )

    const outcome = await pushVia(gateway(), {
      branch: 'canopycms-feature',
      sha: rewritten,
      lease: base,
    })

    expect(outcome).toMatchObject({ moved: true, to: rewritten, pastStaleLease: false })
    expect(outcome.moved && base.startsWith(outcome.from ?? '-')).toBe(true)
    expect(await tip(githubPath, 'refs/heads/canopycms-feature')).toBe(rewritten)
  })

  it('retries a refused stale lease plain, and says so when that fast-forwards', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')

    const outcome = await pushVia(gateway(), {
      branch: 'canopycms-feature',
      sha: ahead,
      lease: '0'.repeat(40),
    })

    expect(outcome).toMatchObject({ moved: true, to: ahead, pastStaleLease: true })
    expect(await tip(githubPath, 'refs/heads/canopycms-feature')).toBe(ahead)
  })

  it('reports a rejected retry after a stale lease as its own kind, with git’s message', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')
    // GitHub moves on to a commit remote.git never had: the branch has diverged.
    await seed.raw(['checkout', '-q', '--orphan', 'elsewhere'])
    const foreign = await commitAndPush(githubPath, 'refs/heads/canopycms-feature', 'foreign.txt')

    const caught = await pushVia(gateway(), {
      branch: 'canopycms-feature',
      sha: ahead,
      lease: '0'.repeat(40),
    }).catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubPushError)
    expect((caught as GitHubPushError).kind).toBe('rejected-after-stale-lease')
    expect(isNonFastForwardRejection((caught as GitHubPushError).message)).toBe(true)
    expect((caught as GitHubPushError).message).toContain('[rejected]')
    expect(await tip(githubPath, 'refs/heads/canopycms-feature')).toBe(foreign)
  })

  it('reports a plain non-fast-forward as rejected, without a retry', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')
    await seed.raw(['checkout', '-q', '--orphan', 'elsewhere'])
    const foreign = await commitAndPush(githubPath, 'refs/heads/canopycms-feature', 'foreign.txt')

    const caught = await pushVia(gateway(), {
      branch: 'canopycms-feature',
      sha: ahead,
    }).catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubPushError)
    expect((caught as GitHubPushError).kind).toBe('rejected')
    expect(isNonFastForwardRejection((caught as GitHubPushError).message)).toBe(true)
    expect(await tip(githubPath, 'refs/heads/canopycms-feature')).toBe(foreign)
  })

  it('throws a refusal to push a protected branch as itself', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const ahead = await commitAndPush(remoteGitPath, 'refs/heads/main', 'ahead.txt')

    const caught = await pushVia(gateway(), {
      branch: 'main',
      sha: ahead,
    }).catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(RefusedPushError)
    expect(await tip(githubPath, 'refs/heads/main')).toBe(main)
  })

  it('resolves the URL once for both attempts', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')
    // Parked on GitHub, so this push is one gateway operation: the URL is resolved once per
    // operation, and a push that needs a bundle (two operations) is the next test's.
    await git('--git-dir', remoteGitPath, 'push', '-q', githubPath, `${ahead}:refs/heads/parked`)
    const remoteUrl = vi.fn(() => githubPath)

    await pushVia(gateway({ remoteUrl, prefetch: false }), {
      branch: 'canopycms-feature',
      sha: ahead,
      lease: '0'.repeat(40),
    })

    expect(remoteUrl).toHaveBeenCalledTimes(1)
  })

  it('resolves the URL once per operation when the push needs a bundle, both attempts included', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('canopycms-feature')
    // One resolution for the push asked without objects, one for the push with the bundle; a
    // third would be a second attempt resolving again.
    let resolutions = 0
    const remoteUrl = vi.fn(() => {
      resolutions++
      if (resolutions > 2) throw new Error('resolved again')
      return githubPath
    })

    const outcome = await pushVia(gateway({ remoteUrl, prefetch: false }), {
      branch: 'canopycms-feature',
      sha: ahead,
      lease: '0'.repeat(40),
    })

    expect(outcome).toMatchObject({ moved: true, to: ahead, pastStaleLease: true })
    expect(remoteUrl).toHaveBeenCalledTimes(2)
  })
})

describe('health', () => {
  it('reports a prepared gateway ready, with its preflight, Clerk and protected set', async () => {
    const github = gateway({
      baseBranch: 'production',
      protectedBranches: ['release/*'],
      authSnapshot: async () => ({ users: [], groups: [], memberships: {} }),
      prefetch: false,
    })
    await github.prepare()

    expect(await github.health()).toEqual({
      ready: true,
      fatalError: null,
      preflight: 'not-an-app',
      clerkConfigured: true,
      protectedBranches: { configured: ['production', 'release/*'], githubDefault: null },
    })
  })

  it('reports Clerk as not configured without an auth provider', async () => {
    const github = gateway({ prefetch: false })
    await github.prepare()

    expect((await github.health()).clerkConfigured).toBe(false)
  })

  it("reports prepare()'s failure as the fatal error, scrubbed", async () => {
    const github = gateway({
      stateDirectory: path.join(root, 'workspace', 'state'),
      prefetch: false,
    })

    await expect(github.prepare()).rejects.toThrow(/inside its shared workspace/)
    const health = await github.health()

    expect(health.ready).toBe(false)
    expect(health.fatalError).toMatch(/inside its shared workspace/)
  })
})

describe('prepare', () => {
  it('stays ready when the mirror cannot be created yet, warning that the next operation tries again', async () => {
    const ensure = vi
      .spyOn(GitHubMirror.prototype, 'ensure')
      .mockRejectedValue(new Error('ENOSPC: no space left on device'))
    const github = gateway({ prefetch: false })

    await expect(github.prepare()).resolves.toBeUndefined()

    expect((await github.health()).ready).toBe(true)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(consoleSpy.all().warn.join('\n')).toMatch(
      /Could not create the GitHub mirror at startup \(ENOSPC: no space left on device\); the next operation tries again/,
    )
    ensure.mockRestore()
    // The mirror comes up with the next operation.
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    expect((await github.fetch({ have: [] })).refs.has('main')).toBe(true)
  })

  it('refuses a state directory other users can write, naming it', async () => {
    const stateDirectory = path.join(root, 'open-state')
    await fs.mkdir(stateDirectory, { mode: 0o755 })
    await fs.chmod(stateDirectory, 0o777)
    const github = gateway({ stateDirectory, prefetch: false })

    await expect(github.prepare()).rejects.toThrow(stateDirectory)
    const health = await github.health()

    expect(health.ready).toBe(false)
    expect(health.fatalError).toContain(stateDirectory)
  })

  it('checks the state directory against the workspace only when it is given one', async () => {
    const github = gateway({
      stateDirectory: path.join(root, 'workspace', 'state'),
      workspacePath: undefined,
      prefetch: false,
    })

    await expect(github.prepare()).resolves.toBeUndefined()

    expect((await github.health()).ready).toBe(true)
  })
})

describe('parsePushStatus', () => {
  const sha = 'b'.repeat(40)

  it.each([
    ['=\tx:refs/heads/topic\t[up to date]', { moved: false }],
    [' \tx:refs/heads/topic\taaaaaaa..bbbbbbb', { moved: true, from: 'aaaaaaa', to: sha }],
    [
      '+\tx:refs/heads/topic\taaaaaaa...bbbbbbb (forced update)',
      { moved: true, from: 'aaaaaaa', to: sha },
    ],
    ['*\tx:refs/heads/topic\t[new branch]', { moved: true, from: null, to: sha }],
  ])('reads %j', (line, expected) => {
    expect(parsePushStatus(`To example\n${line}\nDone\n`, 'topic', sha)).toEqual(expected)
  })

  it("throws rather than guess when no line is the branch's own", () => {
    expect(() =>
      parsePushStatus('To example\n=\tx:refs/heads/team/topic\t[up to date]\nDone\n', 'topic', sha),
    ).toThrow('no readable status for refs/heads/topic')
    expect(() => parsePushStatus('To example\nDone\n', 'topic', sha)).toThrow()
  })
})

describe('Octokit operations', () => {
  it('lets an Octokit error through unchanged, status and response included', async () => {
    const error = await octokitErrorFor(422, { message: 'Validation Failed' })
    const create = vi.fn().mockRejectedValue(error)
    const github = gateway({
      octokit: {
        pulls: { create },
        repos: defaultBranchStub(),
      } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    const caught = await github
      .createPullRequest({ head: 'canopycms-feature', base: 'main', title: 'T', body: 'B' })
      .catch((err: unknown) => err)

    if (GATEWAY_TRANSPORT === 'local') expect(caught).toBe(error)
    else expectRebuiltOctokitError(caught, error)
    expect((caught as { status: number }).status).toBe(422)
  })

  it('supplies owner and repo, and passes the signal through', async () => {
    const signal = new AbortController().signal
    const create = vi
      .fn()
      .mockResolvedValue({ data: { number: 7, html_url: 'https://example.test/7' } })
    const deleteRef = vi.fn().mockResolvedValue({ data: {} })
    const github = gateway({
      octokit: {
        pulls: { create },
        git: { deleteRef },
        repos: defaultBranchStub(),
      } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    expect(
      await github.createPullRequest(
        { head: 'canopycms-feature', base: 'main', title: 'T', body: 'B' },
        signal,
      ),
    ).toEqual({ number: 7, url: 'https://example.test/7' })
    await github.deleteBranch('canopycms-feature', signal)

    expect(create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      head: 'canopycms-feature',
      base: 'main',
      title: 'T',
      body: 'B',
      request: { signal: passedSignal(signal) },
    })
    expect(deleteRef).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      ref: 'heads/canopycms-feature',
      request: { signal: passedSignal(signal) },
    })
  })

  it('asks for the default branch with no request options unless given a signal', async () => {
    const get = vi.fn().mockResolvedValue({ data: { default_branch: 'production' } })
    const github = gateway({
      octokit: { repos: { get } } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    expect(await github.defaultBranch()).toBe('production')
    // Over the socket the server always gives one: the request's own, which ends with it.
    expect(get).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      ...serverRequestOption(),
    })
  })
})
