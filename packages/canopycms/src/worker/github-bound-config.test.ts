/**
 * The credential's config file reaches a git only through `GIT_CONFIG_GLOBAL`, and only the three
 * GitHub-bound commands are given one: they run through worker/git-process.ts, which has no
 * argument parser, while every other gateway git still runs through simple-git, which refuses the
 * variable. Each spawned git is recorded with the environment it was given.
 */

import childProcess, { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { resolveWorkerGitHubAuth } from './github-auth'
import { createLocalGitHubGateway } from './github-gateway'
import { pushToGitHub } from './github-transfer'
import { mirrorGitOptions, sharedRepoGitOptions } from './shared-repo-git'

const recorded: { args: string[]; configGlobal: string | undefined }[] = []
const originalSpawn = childProcess.spawn

/** The first argument that is not an option, after any `-c` pairs: the subcommand. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++
      continue
    }
    if (!args[i].startsWith('-')) return args[i]
  }
  return ''
}

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-github-bound-opt-in-')))
  recorded.length = 0
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined> },
  ) => {
    if (command === 'git') {
      recorded.push({ args: [...args], configGlobal: options?.env?.GIT_CONFIG_GLOBAL })
    }
    return originalSpawn(command, args, options)
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('GIT_CONFIG_GLOBAL', () => {
  it('reaches only the GitHub fetch, the ls-remote and the push to GitHub', async () => {
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
      timeoutMs: 30_000,
      remoteUrl: githubPath,
    })
    recorded.length = 0

    await github.prepare()
    await github.fetch({ have: [] })
    await pushToGitHub(
      { github: () => github, remoteGitPath, taskTimeoutMs: 30_000 },
      { branch: 'feature', prerequisiteBranches: ['feature'] },
      async () => sha,
    )

    const given = recorded.filter((call) => call.configGlobal !== undefined)
    // The one GitHub fetch, which the fetch and both push calls join; then the push's
    // default-branch ls-remote and the push itself.
    expect(given.map((call) => subcommand(call.args))).toEqual(['fetch', 'ls-remote', 'push'])
    // Not vacuous: the gateway ran plenty of other git, none given the variable.
    expect(recorded.filter((call) => call.configGlobal === undefined).length).toBeGreaterThan(5)
  })

  it.each([
    ['the mirror', mirrorGitOptions()],
    ['a shared bare repository', sharedRepoGitOptions('bare')],
    ['a shared clone', sharedRepoGitOptions('worktree')],
  ])(
    'is refused for every simple-git the gateway or the worker builds: %s',
    async (_label, options) => {
      const { simpleGit } = await vi.importActual<typeof import('simple-git')>('simple-git')
      await expect(
        simpleGit({ baseDir: root, ...options })
          .env({ GIT_CONFIG_GLOBAL: '/dev/null' })
          .raw(['version']),
      ).rejects.toThrow(/allowUnsafeConfigPaths/)
    },
  )
})
