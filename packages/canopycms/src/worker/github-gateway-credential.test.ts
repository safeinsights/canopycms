/**
 * How the in-process GitHub gateway hands the credential to git, and when it re-reads it.
 *
 * "GitHub" is a local bare repository, or, where the credential itself must be checked, a local
 * HTTPS smart-git server that refuses any other `Authorization` (test-utils/https-git-server.ts).
 * Every git the gateway spawns is observed through `child_process.spawn`, which simple-git looks up
 * at call time.
 */

import childProcess, { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  initTestRepo,
  mockConsole,
  octokitErrorFor,
  startHttpsGitServer,
  type HttpsGitServer,
  type MockConsole,
  gatewayUnderTest,
  localGatewayOf,
  GATEWAY_TRANSPORT,
  gatewaysSettled,
  closeServedGateways,
} from '../test-utils'
import {
  DEFAULT_GITHUB_TOKEN_REFRESH_MIN_INTERVAL_MS,
  resolveWorkerGitHubAuth,
} from './github-auth'
import {
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import { GitHubTransientError, RefusedPushError, isOwnLockFailure } from './github-mirror'
import { redactEgress } from './gateway-egress'
import { pushToGitHub } from './github-transfer'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

const CANARY = 'ghp_canary0123456789abcdefCANARY'
/** Every form the credential takes on its way to git. */
const canaryForms = (token: string): string[] => {
  const pair = Buffer.from(`x-access-token:${token}`).toString('base64')
  return [token, pair, `AUTHORIZATION: basic ${pair}`, Buffer.from(token).toString('base64')]
}

let root: string
let stateDirectory: string
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

/** `octokit.repos`, answering GitHub's default branch, which the policy reads before a PR or delete. */
const defaultBranchStub = (name = 'main') => ({
  get: vi.fn().mockResolvedValue({ data: { default_branch: name } }),
})

function gateway(
  overrides: Partial<LocalGitHubGatewayOptions> = {},
  refreshGitHubToken?: () => Promise<string | undefined>,
  refreshGitHubTokenMinIntervalMs = 0,
  token = CANARY,
): GitHubGateway {
  return gatewayUnderTest(
    createLocalGitHubGateway({
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      auth: resolveWorkerGitHubAuth({
        githubToken: token,
        refreshGitHubToken,
        refreshGitHubTokenMinIntervalMs,
      }),
      githubApp: false,
      stateDirectory,
      workspacePath: path.join(root, 'workspace'),
      timeoutMs: 30_000,
      remoteUrl: githubPath,
      ...overrides,
    }),
  )
}

/**
 * Push `sha` as the worker does: asked for without objects first, then with a bundle from
 * remote.git when the gateway needs one.
 */
async function pushVia(
  github: GitHubGateway,
  request: { branch: string; sha: string },
  signal?: AbortSignal,
) {
  const { sha, ...rest } = request
  return pushToGitHub(
    { github: () => github, remoteGitPath, taskTimeoutMs: 30_000 },
    { ...rest, prerequisiteBranches: [request.branch] },
    async () => sha,
    signal,
  )
}

/** A commit on `branch` in remote.git that GitHub does not have yet. */
async function aheadOnRemoteGit(branch: string): Promise<string> {
  await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
  await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'refs/heads/main:refs/heads/main')
  return commitAndPush(remoteGitPath, `refs/heads/${branch}`, `${branch.replace(/\//g, '-')}.txt`)
}

const credentialDirs = async (): Promise<string[]> =>
  (await fs.readdir(stateDirectory).catch(() => [])).filter((name) =>
    name.startsWith('.canopy-github-credential-'),
  )

/** The git subcommand of a spawn's argv, after simple-git's `-c` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i]
}

interface ObservedSpawn {
  args: string[]
  env: Record<string, string | undefined>
  /** The `GIT_CONFIG_GLOBAL` file as it was when git started, if there was one. */
  configFile?: { path: string; mode: number; content: string }
}

const originalSpawn = childProcess.spawn

/**
 * Replace `spawn` for simple-git, which imports it by name from the ESM namespace: that binding
 * follows the CommonJS object only after `syncBuiltinESMExports`.
 */
function wrapSpawn(wrapper: typeof childProcess.spawn): void {
  vi.spyOn(childProcess, 'spawn').mockImplementation(wrapper)
  syncBuiltinESMExports()
}

/** Record every git spawned from here on, and what its `GIT_CONFIG_GLOBAL` file held at spawn. */
function spySpawns(): ObservedSpawn[] {
  const observed: ObservedSpawn[] = []
  const original = originalSpawn
  wrapSpawn(((
    command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined> },
  ) => {
    const env = { ...(options?.env ?? {}) }
    const entry: ObservedSpawn = { args: [...args], env }
    const configPath = env.GIT_CONFIG_GLOBAL
    if (configPath !== undefined) {
      entry.configFile = {
        path: configPath,
        mode: statSync(configPath).mode & 0o777,
        content: readFileSync(configPath, 'utf-8'),
      }
    }
    observed.push(entry)
    return original(command, args, options)
  }) as typeof childProcess.spawn)
  return observed
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-gateway-credential-')))
  stateDirectory = path.join(root, 'state')
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
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllEnvs()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('the credential file', () => {
  it('reaches exactly the three GitHub-bound commands, and no argv, environment or trace', async () => {
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    // Trace variables in the worker's own environment pass through to its other git, so they are
    // set here to prove they are stripped from the GitHub-bound commands, and that the trace files
    // the local commands write hold no form of the credential.
    const traceFiles = ['trace', 'trace2-event', 'trace-curl'].map((name) => path.join(root, name))
    vi.stubEnv('GIT_TRACE', traceFiles[0])
    vi.stubEnv('GIT_TRACE2_EVENT', traceFiles[1])
    vi.stubEnv('GIT_TRACE_CURL', traceFiles[2])
    const observed = spySpawns()
    const github = gateway()

    await github.fetch({ have: [] })
    await pushVia(github, { branch: 'canopycms/prod/feature', sha: ahead })

    expect(
      await git('--git-dir', githubPath, 'rev-parse', 'refs/heads/canopycms/prod/feature'),
    ).toBe(ahead)
    const credentialed = observed.filter((spawn) => spawn.env.GIT_CONFIG_GLOBAL !== undefined)
    // The one GitHub fetch, which both push calls join; then the push's default-branch ls-remote
    // and the push itself.
    expect(credentialed.map((spawn) => subcommand(spawn.args))).toEqual([
      'fetch',
      'ls-remote',
      'push',
    ])
    // Not vacuous: the local commands did get the trace variables.
    expect(observed.some((spawn) => spawn.env.GIT_TRACE === traceFiles[0])).toBe(true)
    for (const spawn of credentialed) {
      expect(Object.keys(spawn.env).filter((key) => key.startsWith('GIT_TRACE'))).toEqual([])
      expect(spawn.env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(spawn.configFile?.content).toContain(canaryForms(CANARY)[2])
    }
    const forms = canaryForms(CANARY)
    for (const spawn of observed) {
      const seen = JSON.stringify([spawn.args, spawn.env])
      for (const form of forms) expect(seen).not.toContain(form)
    }
    const processEnv = JSON.stringify(process.env)
    for (const form of forms) expect(processEnv).not.toContain(form)
    for (const file of traceFiles) {
      const written = await fs.readFile(file, 'utf-8').catch(() => '')
      for (const form of forms) expect(written).not.toContain(form)
    }
  })

  it('is 0600, alone in a fresh directory under the state directory, and gone afterwards', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const observed = spySpawns()

    await gateway().fetch({ have: [] })

    const [fetch] = observed.filter((spawn) => spawn.configFile !== undefined)
    const file = fetch.configFile!
    expect(file.mode).toBe(0o600)
    expect(path.dirname(path.dirname(file.path))).toBe(stateDirectory)
    expect(path.basename(path.dirname(file.path))).toMatch(/^\.canopy-github-credential-\w{6}$/)
    // A local path never matches the header's origin, which is GitHub's.
    expect(file.content).toBe(
      `[http "https://github.com/"]\n\textraheader = ${canaryForms(CANARY)[2]}\n` +
        `[credential]\n\thelper =\n`,
    )
    await expect(fs.stat(path.dirname(file.path))).rejects.toThrow(/ENOENT/)
    expect(await credentialDirs()).toEqual([])
  })

  it('is gone after the command fails', async () => {
    const observed = spySpawns()

    await expect(
      gateway({ remoteUrl: path.join(root, 'missing.git') }).fetch({ have: [] }),
    ).rejects.toThrow()

    expect(observed.some((spawn) => spawn.configFile !== undefined)).toBe(true)
    expect(await credentialDirs()).toEqual([])
  })

  it('is gone after the command is aborted', async () => {
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    // "GitHub" holds the push open, so the abort lands while git runs.
    await fs.writeFile(path.join(githubPath, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 5\n', {
      mode: 0o755,
    })
    const controller = new AbortController()
    let killedPush = false
    wrapSpawn(((
      command: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
    ) => {
      const child = originalSpawn(command, args, options)
      if (subcommand(args) === 'push' && options.env?.GIT_CONFIG_GLOBAL !== undefined) {
        killedPush = true
        setTimeout(() => controller.abort(), 200)
      }
      return child
    }) as typeof childProcess.spawn)

    await expect(
      pushVia(gateway(), { branch: 'canopycms/prod/feature', sha: ahead }, controller.signal),
    ).rejects.toThrow()

    expect(killedPush).toBe(true)
    await gatewaysSettled()
    expect(await credentialDirs()).toEqual([])
  })

  it('is swept at startup, and nothing else in the state directory is', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await fs.mkdir(stateDirectory, { mode: 0o700 })
    const leftover = path.join(stateDirectory, '.canopy-github-credential-a1B2c3')
    await fs.mkdir(leftover, { mode: 0o700 })
    await fs.writeFile(path.join(leftover, 'config'), 'left by a crash', { mode: 0o600 })
    const decoys = ['.canopy-github-credential-a1B2c3-kept', '.canopy-github-credential-', 'other']
    for (const decoy of decoys) await fs.mkdir(path.join(stateDirectory, decoy))

    const github = gateway()
    await github.prepare()

    await expect(fs.stat(leftover)).rejects.toThrow(/ENOENT/)
    for (const decoy of decoys) {
      expect((await fs.stat(path.join(stateDirectory, decoy))).isDirectory()).toBe(true)
    }
    // Joins the pre-fetch prepare() started, so it ends before the fixtures are removed.
    await github.fetch({ have: [] })
  })
})

it('is swept before the next session when an earlier delete left it, with the mirror already up', async () => {
  await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
  const github = gateway()
  await github.fetch({ have: [] })
  // As if a delete in a healthy worker had failed: nothing marks the mirror for re-creation.
  const leftover = path.join(stateDirectory, '.canopy-github-credential-zZ9yY8')
  await fs.mkdir(leftover, { mode: 0o700 })
  await fs.writeFile(path.join(leftover, 'config'), 'left by a failed delete', { mode: 0o600 })

  await github.fetch({ have: [] })

  await expect(fs.stat(leftover)).rejects.toThrow(/ENOENT/)
})

it('lets the mirror recover when its state directory disappears under a running worker', async () => {
  const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
  const github = gateway()
  await github.fetch({ have: [] })
  await fs.rm(stateDirectory, { recursive: true, force: true })

  // The first session after it may fail; the next must re-create the mirror and succeed.
  await github.fetch({ have: [] }).catch(() => undefined)
  expect((await github.fetch({ have: [] })).refs).toEqual(new Map([['main', main]]))
  expect((await fs.stat(path.join(stateDirectory, 'github.git'))).isDirectory()).toBe(true)
})

describe('against a server that checks the credential', () => {
  let server: HttpsGitServer
  let serverRoot: string

  beforeEach(async () => {
    serverRoot = path.join(root, 'served')
    await fs.mkdir(serverRoot)
    await git('init', '-q', '--bare', path.join(serverRoot, 'repo.git'))
    githubPath = path.join(serverRoot, 'repo.git')
    server = await startHttpsGitServer(serverRoot, root)
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    vi.stubEnv('no_proxy', '127.0.0.1')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await server.close()
  })

  const basic = (token: string) => `basic ${canaryForms(token)[1]}`

  it('authenticates a fetch and a push with the header, scoped to the remote origin', async () => {
    server.acceptedTokens.add(CANARY)
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    const github = gateway({ remoteUrl: server.url('repo.git') })

    await github.fetch({ have: [] })
    await pushVia(github, { branch: 'canopycms/prod/feature', sha: ahead })

    expect(
      await git('--git-dir', githubPath, 'rev-parse', 'refs/heads/canopycms/prod/feature'),
    ).toBe(ahead)
    expect(server.authorizations.length).toBeGreaterThan(0)
    expect(new Set(server.authorizations)).toEqual(new Set([basic(CANARY)]))
  })

  it('fails on a refused token without asking any credential helper', async () => {
    server.acceptedTokens.add('ghp_the_working_one_0123')
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const github = gateway({ remoteUrl: server.url('repo.git') })
    // A helper in the mirror's own config, which the per-command file and the mirror's `-c` pins
    // must both leave unasked. Created first, so the helper can be planted in its config, and its
    // pre-fetch ended, so the fetch below starts git after the plant: a failed fetch is never joined.
    await github.prepare()
    await github.fetch({ have: [] }).catch(() => undefined)
    const asked = path.join(root, 'helper-was-asked')
    const helper = path.join(root, 'helper.sh')
    await fs.writeFile(helper, `#!/bin/sh\necho "$@" >> '${asked}'\n`, { mode: 0o700 })
    await git(
      '--git-dir',
      path.join(stateDirectory, 'github.git'),
      'config',
      'credential.helper',
      helper,
    )

    const caught = await github.fetch({ have: [] }).catch((err: unknown) => err)

    expect(String(caught)).toMatch(/terminal prompts disabled|could not read Username/)
    await expect(fs.stat(asked)).rejects.toThrow(/ENOENT/)
    expect(server.authorizations).toContain(basic(CANARY))
  })
})

describe('re-reading the credential', () => {
  /** Let a detached re-read, scheduled with setImmediate, start and settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  it('is armed by a failing GitHub-bound fetch', async () => {
    const provider = vi.fn(async () => undefined)

    await expect(
      gateway({ remoteUrl: path.join(root, 'missing.git') }, provider).fetch({ have: [] }),
    ).rejects.toThrow()
    await settle()

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it("is armed by a failing GitHub fetch, a push's first GitHub-bound command, which answers transient", async () => {
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    const provider = vi.fn(async () => undefined)
    const observed = spySpawns()

    const caught = await gateway({ remoteUrl: path.join(root, 'missing.git') }, provider)
      .push({ branch: 'canopycms/prod/feature', sha: ahead, prerequisites: [] })
      .catch((err: unknown) => err)
    await settle()

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('github-fetch-failed')
    expect(observed.filter((s) => s.configFile).map((s) => subcommand(s.args))).toEqual(['fetch'])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it("passes a push's refused mint through with its HTTP status, so the task fails for good", async () => {
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    const refusal = Object.assign(new Error('Not Found'), { status: 404 })
    const auth = {
      ...resolveWorkerGitHubAuth({ githubToken: CANARY }),
      resolveGitToken: async () => {
        throw refusal
      },
    }

    const caught = await gateway({ auth })
      .push({ branch: 'canopycms/prod/feature', sha: ahead, prerequisites: [] })
      .catch((err: unknown) => err)

    expect(caught).not.toBeInstanceOf(GitHubTransientError)
    expect((caught as { status?: unknown }).status).toBe(404)
    // The refusal armed a re-read, whose own read of the token fails too. A served gateway's boot
    // fetch fails the same way and arms one first, so this sees whichever logs first; the
    // `afterEach` waits out the rest (`closeServedGateways`) before the spy goes.
    await vi.waitFor(() =>
      expect(consoleSpy).toHaveErrored('Failed to re-read the GitHub credential'),
    )
  })

  it("is armed by a failing ls-remote, the push's default-branch read", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const main = await git('--git-dir', githubPath, 'rev-parse', 'refs/heads/main')
    await git(
      '--git-dir',
      githubPath,
      'push',
      '-q',
      githubPath,
      'main:refs/heads/canopycms/prod/feature',
    )
    const provider = vi.fn(async () => undefined)
    const credentialed: string[] = []
    // Only the ls-remote is sent somewhere that does not exist.
    wrapSpawn(((
      command: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
    ) => {
      if (options.env?.GIT_CONFIG_GLOBAL !== undefined) credentialed.push(subcommand(args))
      const sent =
        subcommand(args) === 'ls-remote'
          ? args.map((arg) => (arg === githubPath ? path.join(root, 'missing.git') : arg))
          : args
      return originalSpawn(command, sent, options)
    }) as typeof childProcess.spawn)

    await expect(
      gateway({}, provider).push({
        branch: 'canopycms/prod/feature',
        sha: main,
        prerequisites: [],
      }),
    ).rejects.toThrow()
    await settle()

    expect(credentialed).toEqual(['fetch', 'ls-remote'])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('is armed by an Octokit error', async () => {
    const provider = vi.fn(async () => undefined)
    const create = vi.fn().mockRejectedValue(await octokitErrorFor(401, { message: 'Nope' }))
    const github = gateway(
      {
        octokit: {
          pulls: { create },
          repos: defaultBranchStub(),
        } as unknown as LocalGitHubGatewayOptions['octokit'],
      },
      provider,
    )

    await expect(
      github.createPullRequest({ head: 'canopycms/prod/f', base: 'main', title: 'T', body: 'B' }),
    ).rejects.toThrow('Nope')
    await settle()

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('is not armed by an Octokit 422, a validation answer', async () => {
    const provider = vi.fn(async () => undefined)
    const deleteRef = vi
      .fn()
      .mockRejectedValue(await octokitErrorFor(422, { message: 'Reference does not exist' }))
    const github = gateway(
      {
        octokit: {
          git: { deleteRef },
          repos: defaultBranchStub(),
        } as unknown as LocalGitHubGatewayOptions['octokit'],
      },
      provider,
    )

    await expect(github.deleteBranch('canopycms/prod/gone')).rejects.toThrow(
      'Reference does not exist',
    )
    await settle()

    expect(provider).not.toHaveBeenCalled()
  })

  it('is armed by a 404 deleting a branch, which can mean lost access', async () => {
    const provider = vi.fn(async () => undefined)
    const deleteRef = vi
      .fn()
      .mockRejectedValue(await octokitErrorFor(404, { message: 'Not Found' }))
    const github = gateway(
      {
        octokit: {
          git: { deleteRef },
          repos: defaultBranchStub(),
        } as unknown as LocalGitHubGatewayOptions['octokit'],
      },
      provider,
    )

    await expect(github.deleteBranch('canopycms/prod/feature')).rejects.toThrow('Not Found')
    await settle()

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it("is not armed by a lock the mirror's own git found, which it sweeps and fetches again past", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const provider = vi.fn(async () => undefined)
    const github = gateway({ fetchCoalesceMs: 0 }, provider)
    await github.fetch({ have: [] })
    const next = await commitAndPush(githubPath, 'refs/heads/main', 'next.txt')
    await fs.writeFile(path.join(stateDirectory, 'github.git', 'refs', 'heads', 'main.lock'), '')

    const fetched = await github.fetch({ have: [] })
    await settle()

    expect(fetched.refs.get('main')).toBe(next)
    expect(consoleSpy).toHaveWarned(
      /Removed stale locks from the GitHub mirror: refs\/heads\/main\.lock/,
    )
    expect(provider).not.toHaveBeenCalled()
  })

  it('is not armed by a lock the mirror holds while maintenance runs, which it leaves in place', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const provider = vi.fn(async () => undefined)
    const github = gateway({ fetchCoalesceMs: 0 }, provider)
    await github.fetch({ have: [] })
    await commitAndPush(githubPath, 'refs/heads/main', 'next.txt')
    const lock = path.join(stateDirectory, 'github.git', 'refs', 'heads', 'main.lock')
    await fs.writeFile(lock, '')
    // Maintenance running, as far as the fetch can tell: it holds the mutex for the whole test, so
    // a fetch that waited for it would never finish.
    const internals = localGatewayOf(github) as unknown as {
      mirror: { maintenance: { tryAcquire(): (() => void) | null } }
    }
    const release = internals.mirror.maintenance.tryAcquire()
    expect(release).not.toBeNull()

    try {
      const caught = await github.fetch({ have: [] }).catch((err: unknown) => err)
      await settle()

      expect(caught).toBeInstanceOf(GitHubTransientError)
      expect(String(caught)).toMatch(/met a lock maintenance holds/)
      await expect(fs.stat(lock)).resolves.toBeTruthy()
      expect(consoleSpy).not.toHaveWarned(/Removed stale locks/)
      expect(provider).not.toHaveBeenCalled()
    } finally {
      release?.()
    }
  })

  it('is armed by a lock that GitHub reports on a remote: line', async () => {
    const ahead = await aheadOnRemoteGit('canopycms/prod/feature')
    const lockPath = path.join(githubPath, 'refs', 'heads', 'canopycms', 'prod', 'feature.lock')
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, '')
    const provider = vi.fn(async () => undefined)

    const caught = await pushVia(gateway({}, provider), {
      branch: 'canopycms/prod/feature',
      sha: ahead,
    }).catch((err: unknown) => err)
    await settle()

    expect(String(caught)).toMatch(/remote: error: cannot lock ref/)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it("is not armed by the gateway's own refusals", async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const main = await git('--git-dir', githubPath, 'rev-parse', 'refs/heads/main')
    const provider = vi.fn(async () => undefined)
    const github = gateway({}, provider)

    const blob = await git('--git-dir', githubPath, 'rev-parse', 'main:main.txt')

    await expect(
      github.push({ branch: 'main', sha: main, prerequisites: [] }),
    ).rejects.toBeInstanceOf(RefusedPushError)
    await expect(
      github.push({
        branch: 'canopycms/prod/feature',
        sha: 'not-an-id',
        prerequisites: [],
      }),
    ).rejects.toThrow(
      // Over the socket the wire format refuses it, before the gateway sees it.
      GATEWAY_TRANSPORT === 'http' ? /malformed push request/ : /Not a commit ID/,
    )
    await expect(
      github.push({ branch: 'canopycms/prod/feature', sha: blob, prerequisites: [] }),
    ).rejects.toThrow(/is not a commit/)
    await settle()

    expect(provider).not.toHaveBeenCalled()
  })

  // In-process only: over the socket the caller is the server, and the worker learns of the
  // failure from an answer written before the re-read starts but read whenever its I/O runs.
  it.skipIf(GATEWAY_TRANSPORT === 'http')(
    'starts only after the failure has reached the caller',
    async () => {
      let delivered = false
      const startedAfterDelivery: boolean[] = []
      const provider = vi.fn(async () => {
        startedAfterDelivery.push(delivered)
        return undefined
      })

      await gateway({ remoteUrl: path.join(root, 'missing.git') }, provider)
        .fetch({ have: [] })
        .catch(() => {
          delivered = true
        })
      await settle()

      expect(startedAfterDelivery).toEqual([true])
    },
  )

  it('is joined by the next credentialed operation, which then uses the new token', async () => {
    const serverRoot = path.join(root, 'served')
    await fs.mkdir(serverRoot)
    githubPath = path.join(serverRoot, 'repo.git')
    await git('init', '-q', '--bare', githubPath)
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const server = await startHttpsGitServer(serverRoot, root)
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    vi.stubEnv('no_proxy', '127.0.0.1')
    try {
      server.acceptedTokens.add('ghp_rotated_0123456789')
      let release: (token: string) => void = () => undefined
      const provider = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
      const github = gateway({ remoteUrl: server.url('repo.git') }, provider)

      await expect(github.fetch({ have: [] })).rejects.toThrow()
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
      const requestsBefore = server.authorizations.length
      const joined = github.fetch({ have: [] })
      await settle()
      // Still waiting on the re-read: nothing reached the server.
      expect(server.authorizations.length).toBe(requestsBefore)

      release('ghp_rotated_0123456789')
      await joined

      expect(server.authorizations.at(-1)).toBe(`basic ${canaryForms('ghp_rotated_0123456789')[1]}`)
    } finally {
      vi.unstubAllEnvs()
      await server.close()
    }
  })

  it("is joined only until the operation's own signal aborts", async () => {
    const provider = vi.fn(() => new Promise<string>(() => undefined))
    // A short bound, so the abandoned re-read gives up and logs inside this test.
    const github = gateway({ remoteUrl: path.join(root, 'missing.git'), timeoutMs: 200 }, provider)
    await expect(github.fetch({ have: [] })).rejects.toThrow()
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    const observed = spySpawns()
    const controller = new AbortController()

    const joined = github.fetch({ have: [] }, controller.signal)
    setTimeout(() => controller.abort(new Error('task deadline')), 20)

    await expect(joined).rejects.toThrow('task deadline')
    expect(observed).toEqual([])
    await vi.waitFor(() => expect(consoleSpy).toHaveErrored('did not settle within 200ms'))
    // Over the socket the fetch job outlives the aborted wait, and fails on its own.
    await gatewaysSettled()
  })

  it('is joined for no longer than its cap, after which the operation goes on with the token it has', async () => {
    const provider = vi.fn(() => new Promise<string>(() => undefined))
    // The re-read's own bound is long; the join's cap is what ends the wait.
    const github = gateway(
      { remoteUrl: path.join(root, 'missing.git'), timeoutMs: 5_000, refreshJoinCapMs: 150 },
      provider,
    )
    await expect(github.fetch({ have: [] })).rejects.toThrow()
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    const observed = spySpawns()
    const started = Date.now()

    await expect(github.fetch({ have: [] })).rejects.toThrow()

    // It reached git with the token it had, well before the re-read's bound.
    expect(observed.some((spawn) => subcommand(spawn.args) === 'fetch')).toBe(true)
    expect(Date.now() - started).toBeLessThan(4_000)
    await vi.waitFor(() => expect(consoleSpy).toHaveErrored('did not settle within 5000ms'), {
      timeout: 8_000,
    })
    await closeServedGateways()
  })

  it('reaches the provider once for two failures inside the default floor', async () => {
    const provider = vi.fn(async () => undefined)
    const github = gateway(
      { remoteUrl: path.join(root, 'missing.git') },
      provider,
      DEFAULT_GITHUB_TOKEN_REFRESH_MIN_INTERVAL_MS,
    )

    await expect(github.fetch({ have: [] })).rejects.toThrow()
    await settle()
    await expect(github.fetch({ have: [] })).rejects.toThrow()
    await settle()

    expect(provider).toHaveBeenCalledTimes(1)
  })
})

describe('a token the gateway reads without ever resolving it for git', () => {
  /**
   * Unprefixed, so only the exact scrub can catch it: `redactCredentials`'s patterns know the
   * `ghp_` shape and would hide a missing registration.
   */
  const freshToken = (label: string) => `CANARY-${label}-${randomBytes(16).toString('hex')}`

  it('is scrubbed from what an Octokit failure echoes back, and from the log', async () => {
    const token = freshToken('octokit')
    const sent: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        sent.push(init?.headers?.authorization)
        return new Response(
          JSON.stringify({ message: 'Server Error', echoed: init?.headers?.authorization }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    // Never passed through `credential()`: no git runs, and the App path's prepare() is not called.
    const github = gateway({ prefetch: false }, undefined, 0, token)

    const caught = await github.getPullRequest(1).catch((err: unknown) => err)

    // Non-vacuous: the token reached the wire, and the failure carries what was echoed.
    expect(sent).toEqual([`token ${token}`])
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { response?: { data?: unknown } }).response?.data).toBeDefined()
    const everything = JSON.stringify([
      (caught as Error).message,
      (caught as Error).stack,
      (caught as { response?: unknown }).response,
      (caught as { request?: unknown }).request,
      consoleSpy.all(),
    ])
    for (const form of canaryForms(token).slice(0, 3)) expect(everything).not.toContain(form)
    expect(everything).toContain('***')
  })

  it('is scrubbed from the moment a re-read rotates it, before any operation uses it', async () => {
    const rotated = freshToken('rotated')
    const provider = vi.fn(async () => rotated)
    const github = gateway({ remoteUrl: path.join(root, 'missing.git') }, provider)

    expect(redactEgress(`before ${rotated}`)).toContain(rotated)
    await expect(github.fetch({ have: [] })).rejects.toThrow()
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))

    for (const form of canaryForms(rotated).slice(0, 3)) {
      expect(redactEgress(`after ${form} done`)).not.toContain(form)
    }
  })
})

describe('isOwnLockFailure', () => {
  it.each([
    [
      "error: cannot lock ref 'refs/heads/main': Unable to create '/s/github.git/refs/heads/main.lock': File exists.",
      true,
    ],
    [
      "remote: error: cannot lock ref 'refs/heads/f': Unable to create '/gh/refs/heads/f.lock': File exists.",
      false,
    ],
    [
      'error: could not delete reference refs/heads/b: unable to create file /var/lib/canopy state/github.git/packed-refs.new: File exists',
      true,
    ],
    ['remote: error: unable to create file /gh/packed-refs.new: File exists', false],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", false],
  ])('%s → %s', (message, expected) => {
    expect(isOwnLockFailure(message)).toBe(expected)
  })
})
