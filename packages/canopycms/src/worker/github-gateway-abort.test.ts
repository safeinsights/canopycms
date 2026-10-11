/**
 * An aborted push, or an aborted intake of a pushed bundle, stops the gateway's git and everything
 * it spawned: git runs in a process group of its own (worker/git-process.ts), and the abort
 * signals the group. A stand-in `git` on `PATH` runs the real one, except for the command a test
 * holds open, where it starts a child of its own and waits, as git does for a transfer
 * (`git-remote-https`, `pack-objects`). Both its pid and its child's are recorded, and both must
 * be gone after the abort. Over the socket, the worker's abort reaches the gateway as the request
 * closing.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeServedGateways,
  gatewayUnderTest,
  initTestRepo,
  mockConsole,
  type MockConsole,
} from '../test-utils'
import { resolveWorkerGitHubAuth } from './github-auth'
import { createLocalGitHubGateway } from './github-gateway'
import { pushToGitHub } from './github-transfer'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let stubDir: string
let githubPath: string
let remoteGitPath: string
let consoleSpy: MockConsole

/** The real git, found on `PATH` before the stand-in goes in front of it. */
async function realGit(): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'git')
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  throw new Error('git is not on PATH')
}

/**
 * Put a stand-in `git` first on `PATH`. While `<stubDir>/hold-<what>` exists, the command it names
 * (`push`, or `ingest`: a `fetch` of a bundle under the gateway's `incoming/`) starts `sleep` and
 * waits on it, writing `<git pid> <sleep pid>` to `<stubDir>/pids-<what>`. Bash runs it with
 * `--norc`: node gives a child a socket for stdin, which makes bash read the user's rc files.
 */
async function installStub(): Promise<void> {
  const real = await realGit()
  const script = `#!/bin/bash --norc
hold() {
  sleep 300 &
  echo "$$ $!" > "${stubDir}/pids-$1"
  wait
  exit 1
}
for arg in "$@"; do
  if [ "$arg" = "push" ] && [ -e "${stubDir}/hold-push" ]; then hold push; fi
  case "$arg" in
    */incoming/*) if [ -e "${stubDir}/hold-ingest" ]; then hold ingest; fi ;;
  esac
done
exec "${real}" "$@"
`
  await fs.writeFile(path.join(stubDir, 'git'), script, { mode: 0o755 })
  vi.stubEnv('PATH', `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`)
}

/** The pids the stand-in wrote for `what`, once it has. */
async function heldPids(what: 'push' | 'ingest'): Promise<number[]> {
  const file = path.join(stubDir, `pids-${what}`)
  await vi.waitFor(() => fs.access(file), { timeout: 20_000 })
  return (await fs.readFile(file, 'utf8')).trim().split(' ').map(Number)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-gateway-abort-')))
  stubDir = path.join(root, 'stub')
  await fs.mkdir(stubDir)
  githubPath = path.join(root, 'github.git')
  remoteGitPath = path.join(root, 'workspace', 'remote.git')
  await git('init', '-q', '--bare', '--initial-branch', 'main', githubPath)
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
  await installStub()
})

afterEach(async () => {
  await closeServedGateways()
  vi.unstubAllEnvs()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

function gateway() {
  return gatewayUnderTest(
    createLocalGitHubGateway({
      githubOwner: 'o',
      githubRepo: 'r',
      auth: resolveWorkerGitHubAuth({ githubToken: 'ghp_abort_0123456789' }),
      githubApp: false,
      stateDirectory: path.join(root, 'state'),
      workspacePath: path.join(root, 'workspace'),
      // Long, so only the abort can stop the held command.
      timeoutMs: 60_000,
      remoteUrl: githubPath,
      fetchCoalesceMs: 0,
    }),
  )
}

describe('an abort', () => {
  it.each(['push', 'ingest'] as const)(
    'of a %s stops its git and what that git spawned',
    async (what) => {
      await fs.writeFile(path.join(stubDir, `hold-${what}`), '')
      const github = gateway()
      const controller = new AbortController()
      const sha = await git('--git-dir', remoteGitPath, 'rev-parse', 'refs/heads/feature')

      const pushing = pushToGitHub(
        { github: () => github, remoteGitPath, taskTimeoutMs: 60_000 },
        { branch: 'feature', prerequisiteBranches: ['feature', 'main'] },
        async () => sha,
        controller.signal,
      ).catch((err: unknown) => err)
      const pids = await heldPids(what)
      expect(pids.every(isAlive)).toBe(true)
      controller.abort(new Error('task deadline'))

      expect(await pushing).toBeInstanceOf(Error)
      // Within the stop's grace, the whole group: the held git and the child it started.
      await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 10_000 })
      expect(await git('--git-dir', githubPath, 'for-each-ref', 'refs/heads/feature')).toBe('')
    },
  )
})
