/**
 * simple-git's `allowUnsafeConfigPaths` lets a git be handed a `GIT_CONFIG_GLOBAL`. Only the
 * GitHub-bound commands get it; every other gateway git keeps simple-git's refusal. Each
 * `simpleGit()` instance is recorded with the opt-in it was built with and the commands it ran.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { resolveWorkerGitHubAuth } from './github-auth'
import { createLocalGitHubGateway } from './github-gateway'
import { githubBoundGitOptions, mirrorGitOptions, sharedRepoGitOptions } from './shared-repo-git'

const recorded = vi.hoisted(() => [] as { optedIn: boolean; args: string[] }[])

vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('simple-git')>()
  const simpleGit = ((options?: Parameters<typeof actual.simpleGit>[0]) => {
    const instance = actual.simpleGit(options as Parameters<typeof actual.simpleGit>[0])
    const optedIn = typeof options === 'object' && options?.unsafe?.allowUnsafeConfigPaths === true
    const raw = instance.raw.bind(instance) as (args: string[]) => Promise<string>
    Object.assign(instance, {
      raw: (args: string[]) => {
        recorded.push({ optedIn, args: [...args] })
        return raw(args)
      },
    })
    return instance
  }) as typeof actual.simpleGit
  return { ...actual, simpleGit, default: simpleGit }
})

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-github-bound-opt-in-')))
  recorded.length = 0
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('allowUnsafeConfigPaths', () => {
  it('is on only for the GitHub fetch, the ls-remote and the push to GitHub', async () => {
    const githubPath = path.join(root, 'github.git')
    const remoteGitPath = path.join(root, 'workspace', 'remote.git')
    await git('init', '-q', '--bare', githubPath)
    await git('init', '-q', '--bare', remoteGitPath)
    const seedPath = path.join(root, 'seed')
    await fs.mkdir(seedPath)
    const seed = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'a.txt'), 'a')
    await seed.add('.')
    await seed.commit('a')
    await seed.raw(['push', '-q', githubPath, 'HEAD:refs/heads/main'])
    await seed.raw(['push', '-q', remoteGitPath, 'HEAD:refs/heads/main'])
    await fs.writeFile(path.join(seedPath, 'b.txt'), 'b')
    await seed.add('.')
    await seed.commit('b')
    await seed.raw(['push', '-q', remoteGitPath, 'HEAD:refs/heads/feature'])
    const sha = (await seed.revparse(['HEAD'])).trim()
    const github = createLocalGitHubGateway({
      githubOwner: 'o',
      githubRepo: 'r',
      auth: resolveWorkerGitHubAuth({ githubToken: 'ghp_opt_in_0123456789' }),
      githubApp: false,
      stateDirectory: path.join(root, 'state'),
      workspacePath: path.join(root, 'workspace'),
      remoteGitPath,
      timeoutMs: 30_000,
      remoteUrl: githubPath,
    })
    recorded.length = 0

    await github.prepare()
    await github.fetch({ have: [] })
    await github.push({ branch: 'feature', sha, protectedBranches: ['main'] })
    await github.maintain()

    const optedIn = recorded.filter((call) => call.optedIn).map((call) => call.args[0])
    expect(optedIn).toEqual(['fetch', 'ls-remote', 'push'])
    // Not vacuous: the gateway ran plenty of other git, all without the opt-in.
    expect(recorded.filter((call) => !call.optedIn).length).toBeGreaterThan(5)
  })

  it.each([
    ['the mirror', mirrorGitOptions()],
    ['a shared bare repository', sharedRepoGitOptions('bare')],
    ['a shared clone', sharedRepoGitOptions('worktree')],
  ])('is refused for %s', async (_label, options) => {
    const { simpleGit } = await vi.importActual<typeof import('simple-git')>('simple-git')
    await expect(
      simpleGit({ baseDir: root, ...options })
        .env({ GIT_CONFIG_GLOBAL: '/dev/null' })
        .raw(['version']),
    ).rejects.toThrow(/allowUnsafeConfigPaths/)
  })

  it('is granted for a GitHub-bound command', async () => {
    const { simpleGit } = await vi.importActual<typeof import('simple-git')>('simple-git')
    await expect(
      simpleGit({ baseDir: root, ...githubBoundGitOptions() })
        .env({ GIT_CONFIG_GLOBAL: '/dev/null', PATH: process.env.PATH ?? '' })
        .raw(['version']),
    ).resolves.toMatch(/^git version/)
  })
})
