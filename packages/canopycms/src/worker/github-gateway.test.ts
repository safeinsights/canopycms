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
import { initTestRepo, mockConsole, octokitErrorFor, type MockConsole } from '../test-utils'
import { isNonFastForwardRejection } from '../utils/git'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  GitHubPushError,
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import { RefusedPushError } from './github-mirror'

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

function gateway(overrides: Partial<LocalGitHubGatewayOptions> = {}): GitHubGateway {
  return createLocalGitHubGateway({
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
    githubApp: false,
    stateDirectory: path.join(root, 'state'),
    workspacePath: path.join(root, 'workspace'),
    remoteGitPath,
    timeoutMs: 30_000,
    remoteUrl: githubPath,
    ...overrides,
  })
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
  await git('init', '-q', '--bare', githubPath)
  await git('init', '-q', '--bare', remoteGitPath)
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('fetch', () => {
  it("returns GitHub's branch map and publishes it into remote.git's tracking namespace", async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const feature = await commitAndPush(githubPath, 'refs/heads/feature/x', 'feature.txt')

    const result = await gateway().fetch({ have: [] })

    expect(result.bundleId).toBeNull()
    expect([...result.branches].sort()).toEqual([
      ['feature/x', feature],
      ['main', main],
    ])
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}main`)).toBe(main)
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}feature/x`)).toBe(feature)
  })

  it('prunes a branch GitHub no longer has, from the map and from remote.git', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await commitAndPush(githubPath, 'refs/heads/gone', 'gone.txt')
    const github = gateway()
    await github.fetch({ have: [] })
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/gone')

    const result = await github.fetch({ have: [] })

    expect([...result.branches.keys()]).toEqual(['main'])
    expect(await tip(remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}gone`)).toBeNull()
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

describe('onGitHub', () => {
  it('names the ids a GitHub branch contains, and only those', async () => {
    const onMain = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const local = await commitAndPush(remoteGitPath, 'refs/heads/local', 'local.txt')
    const github = gateway()
    await github.fetch({ have: [] })

    const found = await github.onGitHub([onMain, local, 'not-an-object-id'])

    expect([...found]).toEqual([onMain])
  })
})

describe('seedBareRepository', () => {
  const target = () => path.join(root, 'workspace', 'remote.git.cloning')
  const createRepository = async () => {
    await git('init', '-q', '--bare', target())
  }

  it("seeds an empty bare repository with every GitHub branch, checking in the fetch's session", async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const order: string[] = []

    await gateway().seedBareRepository(target(), {
      baseBranch: 'main',
      beforeSeed: async (github) => {
        // Runs after the GitHub fetch, so the mirror already knows what GitHub holds.
        order.push(`beforeSeed:${[...(await github.onGitHub([main]))].join(',')}`)
      },
      createRepository: async () => {
        order.push('createRepository')
        await createRepository()
      },
    })

    expect(order).toEqual([`beforeSeed:${main}`, 'createRepository'])
    expect(await tip(target(), 'refs/heads/main')).toBe(main)
  })

  it('stops before creating anything when the check throws', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const create = vi.fn(createRepository)

    await expect(
      gateway().seedBareRepository(target(), {
        baseBranch: 'main',
        beforeSeed: async () => {
          throw new Error('kept')
        },
        createRepository: create,
      }),
    ).rejects.toThrow('kept')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses when GitHub has no base branch, before creating anything', async () => {
    await commitAndPush(githubPath, 'refs/heads/other', 'other.txt')
    const create = vi.fn(createRepository)

    await expect(
      gateway().seedBareRepository(target(), { baseBranch: 'main', createRepository: create }),
    ).rejects.toThrow("GitHub has no branch 'main'")
    expect(create).not.toHaveBeenCalled()
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

  it("pushes exactly the commit asked for to GitHub's branch", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('feature')

    const outcome = await gateway().push({
      branch: 'feature',
      sha: ahead,
      protectedBranches: ['main'],
    })

    expect(outcome).toBe('pushed')
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(ahead)
  })

  it('retries a refused stale lease plain, and says so when that fast-forwards', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('feature')

    const outcome = await gateway().push({
      branch: 'feature',
      sha: ahead,
      lease: '0'.repeat(40),
      protectedBranches: ['main'],
    })

    expect(outcome).toBe('pushed-past-stale-lease')
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(ahead)
  })

  it('reports a rejected retry after a stale lease as its own kind, with git’s message', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('feature')
    // GitHub moves on to a commit remote.git never had: the branch has diverged.
    await seed.raw(['checkout', '-q', '--orphan', 'elsewhere'])
    const foreign = await commitAndPush(githubPath, 'refs/heads/feature', 'foreign.txt')

    const caught = await gateway()
      .push({ branch: 'feature', sha: ahead, lease: '0'.repeat(40), protectedBranches: ['main'] })
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubPushError)
    expect((caught as GitHubPushError).kind).toBe('rejected-after-stale-lease')
    expect(isNonFastForwardRejection((caught as GitHubPushError).message)).toBe(true)
    expect((caught as GitHubPushError).message).toBe(
      ((caught as GitHubPushError).cause as Error).message,
    )
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(foreign)
  })

  it('reports a plain non-fast-forward as rejected, without a retry', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('feature')
    await seed.raw(['checkout', '-q', '--orphan', 'elsewhere'])
    const foreign = await commitAndPush(githubPath, 'refs/heads/feature', 'foreign.txt')

    const caught = await gateway()
      .push({ branch: 'feature', sha: ahead, protectedBranches: ['main'] })
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubPushError)
    expect((caught as GitHubPushError).kind).toBe('rejected')
    expect(isNonFastForwardRejection((caught as GitHubPushError).message)).toBe(true)
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(foreign)
  })

  it('throws a refusal to push a protected branch as itself', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const ahead = await commitAndPush(remoteGitPath, 'refs/heads/main', 'ahead.txt')

    const caught = await gateway()
      .push({ branch: 'main', sha: ahead, protectedBranches: ['main'] })
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(RefusedPushError)
    expect(await tip(githubPath, 'refs/heads/main')).toBe(main)
  })

  it('resolves the URL once for both attempts', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const { ahead } = await aheadOnRemoteGit('feature')
    const remoteUrl = vi.fn(() => githubPath)

    await gateway({ remoteUrl }).push({
      branch: 'feature',
      sha: ahead,
      lease: '0'.repeat(40),
      protectedBranches: ['main'],
    })

    expect(remoteUrl).toHaveBeenCalledTimes(1)
  })
})

describe('Octokit operations', () => {
  it('lets an Octokit error through unchanged, status and response included', async () => {
    const error = await octokitErrorFor(422, { message: 'Validation Failed' })
    const create = vi.fn().mockRejectedValue(error)
    const github = gateway({
      octokit: { pulls: { create } } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    const caught = await github
      .createPullRequest({ head: 'feature', base: 'main', title: 'T', body: 'B' })
      .catch((err: unknown) => err)

    expect(caught).toBe(error)
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
      } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    expect(
      await github.createPullRequest(
        { head: 'feature', base: 'main', title: 'T', body: 'B' },
        signal,
      ),
    ).toEqual({ number: 7, url: 'https://example.test/7' })
    await github.deleteBranch('feature', signal)

    expect(create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      head: 'feature',
      base: 'main',
      title: 'T',
      body: 'B',
      request: { signal },
    })
    expect(deleteRef).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      ref: 'heads/feature',
      request: { signal },
    })
  })

  it('asks for the default branch with no request options unless given a signal', async () => {
    const get = vi.fn().mockResolvedValue({ data: { default_branch: 'production' } })
    const github = gateway({
      octokit: { repos: { get } } as unknown as LocalGitHubGatewayOptions['octokit'],
    })

    expect(await github.defaultBranch()).toBe('production')
    expect(get).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo' })
  })
})
