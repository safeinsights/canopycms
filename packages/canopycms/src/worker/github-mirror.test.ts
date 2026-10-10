/**
 * The worker's private GitHub mirror, with no allowlist check in front of it: `remote.git` is
 * planted with redirects, a credential helper and hooks, and every operation that carries the
 * credential must still go to "GitHub" (a local bare repo) and run nothing that was planted.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { GitHubMirror } from './github-mirror'

const execFileAsync = promisify(execFile)

let root: string
let sentinel: string
let githubPath: string
let attackerPath: string
let remoteGitPath: string
let seed: SimpleGit
let seedPath: string
let mirror: GitHubMirror
let consoleSpy: MockConsole

const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()
const tip = async (gitDir: string, ref: string) =>
  git('--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref).catch(() => null)
const refs = async (gitDir: string) =>
  (await git('--git-dir', gitDir, 'for-each-ref', '--format=%(refname)'))
    .split('\n')
    .filter(Boolean)
const sentinelLines = async () =>
  (await fs.readFile(sentinel, 'utf8').catch(() => '')).split('\n').filter(Boolean)

async function commitAndPush(target: string, ref: string, file: string): Promise<string> {
  await fs.writeFile(path.join(seedPath, file), `${file}\n`)
  await seed.add('.')
  await seed.commit(file)
  await seed.raw(['push', '-q', target, `HEAD:${ref}`])
  return (await seed.revparse(['HEAD'])).trim()
}

async function plantHostileRemoteGit(): Promise<void> {
  const record = (label: string) => `echo ${label} >> '${sentinel}'`
  const config = path.join(remoteGitPath, 'config')
  const set = (key: string, value: string) =>
    execFileAsync('git', ['config', '--file', config, '--add', key, value])
  await set(`url.${attackerPath}.insteadOf`, githubPath)
  await set(`url.${attackerPath}.pushInsteadOf`, githubPath)
  await set('credential.helper', `!${record('credential-helper')}; true`)
  await set('core.fsmonitor', `${record('fsmonitor')}; true`)
  await set('hook.planted.command', record('config-hook'))
  for (const event of ['pre-receive', 'post-receive', 'reference-transaction', 'pre-push']) {
    await set('hook.planted.event', event)
    const hook = path.join(remoteGitPath, 'hooks', event)
    await fs.writeFile(hook, `#!/bin/sh\n${record(`hook:${event}`)}\n`)
    await fs.chmod(hook, 0o755)
  }
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-github-mirror-')))
  sentinel = path.join(root, 'sentinel.log')
  githubPath = path.join(root, 'github.git')
  attackerPath = path.join(root, 'attacker.git')
  remoteGitPath = path.join(root, 'workspace', 'remote.git')
  seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', 'main'])
  await git('init', '-q', '--bare', githubPath)
  await git('init', '-q', '--bare', attackerPath)
  await commitAndPush(githubPath, 'refs/heads/main', 'base.txt')
  await git('clone', '-q', '--bare', githubPath, remoteGitPath)
  await git('--git-dir', remoteGitPath, 'remote', 'remove', 'origin')
  mirror = new GitHubMirror(path.join(root, 'state'), remoteGitPath, 30_000)
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('GitHubMirror', () => {
  it("publishes exactly the commit it was given, even after remote.git's ref has moved", async () => {
    const published = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'one.txt')
    await commitAndPush(remoteGitPath, 'refs/heads/feature', 'two.txt')

    await mirror.exclusive((m) =>
      m.pushToGitHub(githubPath, 'feature', published, { protectedBranches: [] }),
    )

    expect(await tip(githubPath, 'refs/heads/feature')).toBe(published)
    expect(await refs(mirror.gitDir)).not.toContain('refs/canopy/outgoing/feature')
  })

  it('holds a lease: a push keyed to a commit GitHub is not at is refused as stale', async () => {
    const first = await commitAndPush(githubPath, 'refs/heads/feature', 'one.txt')
    const next = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'two.txt')
    const notGitHubsTip = (await seed.revparse(['HEAD~2'])).trim()
    expect(notGitHubsTip).not.toBe(first)

    await expect(
      mirror.exclusive((m) =>
        m.pushToGitHub(githubPath, 'feature', next, {
          lease: notGitHubsTip,
          protectedBranches: [],
        }),
      ),
    ).rejects.toThrow(/stale info/)
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(first)
  })

  it('never reads the redirects, helper or hooks planted in remote.git', async () => {
    const published = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'one.txt')
    const upstream = await commitAndPush(githubPath, 'refs/heads/main', 'upstream.txt')
    // After this test's own pushes into remote.git, which would run the hooks.
    await plantHostileRemoteGit()

    await mirror.exclusive(async (m) => {
      await m.fetchFromGitHub(githubPath)
      await m.publishTrackingRefs()
      await m.pushToGitHub(githubPath, 'feature', published, { protectedBranches: [] })
    })

    expect(await tip(githubPath, 'refs/heads/feature')).toBe(published)
    expect(await tip(remoteGitPath, 'refs/remotes/github/main')).toBe(upstream)
    expect(await refs(attackerPath)).toEqual([])
    expect(await sentinelLines()).toEqual([])
  })

  it('prunes tracking refs for branches GitHub no longer has, and leaves refs/heads alone', async () => {
    await commitAndPush(githubPath, 'refs/heads/gone-soon', 'g.txt')
    await mirror.exclusive(async (m) => {
      await m.fetchFromGitHub(githubPath)
      await m.publishTrackingRefs()
    })
    expect(await refs(remoteGitPath)).toContain('refs/remotes/github/gone-soon')
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/gone-soon')
    const local = await commitAndPush(remoteGitPath, 'refs/heads/editor-work', 'e.txt')

    await mirror.exclusive(async (m) => {
      await m.fetchFromGitHub(githubPath)
      await m.publishTrackingRefs()
    })

    expect(await refs(remoteGitPath)).not.toContain('refs/remotes/github/gone-soon')
    expect(await tip(remoteGitPath, 'refs/heads/editor-work')).toBe(local)
  })

  it('recreates itself when its directory is not a repository', async () => {
    await mirror.ensure()
    await fs.rm(path.join(mirror.gitDir, 'HEAD'))
    await expect(mirror.exclusive((m) => m.fetchFromGitHub(githubPath))).rejects.toThrow()

    await mirror.exclusive((m) => m.fetchFromGitHub(githubPath))

    expect(await tip(mirror.gitDir, 'refs/heads/main')).toBe(
      await tip(githubPath, 'refs/heads/main'),
    )
  })

  it('runs one session at a time, in the order they were asked for', async () => {
    await mirror.ensure()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = mirror.exclusive(async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => (releaseFirst = resolve))
      order.push('first:end')
    })
    const second = mirror.exclusive(async () => {
      order.push('second')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('checks every object it receives: a malformed commit in remote.git never reaches GitHub', async () => {
    const tree = await git('--git-dir', remoteGitPath, 'rev-parse', 'main^{tree}')
    const malformed = `tree ${tree}\nauthor No Email 1700000000 +0000\ncommitter x <x@y> 1700000000 +0000\n\nbad\n`
    const file = path.join(root, 'malformed-commit')
    await fs.writeFile(file, malformed)
    const sha = await git(
      '--git-dir',
      remoteGitPath,
      'hash-object',
      '--literally',
      '-t',
      'commit',
      '-w',
      file,
    )
    await git('--git-dir', remoteGitPath, 'update-ref', 'refs/heads/malformed', sha)

    await expect(
      mirror.exclusive((m) =>
        m.pushToGitHub(githubPath, 'malformed', sha, { protectedBranches: [] }),
      ),
    ).rejects.toThrow(/fsck|missingEmail|bad/i)
    expect(await tip(githubPath, 'refs/heads/malformed')).toBeNull()
  })

  it('seeds an empty mirror from remote.git, then makes every ref exactly what GitHub holds', async () => {
    // A commit no GitHub history contains, so only seeding can bring it into the mirror.
    const tree = await git('--git-dir', remoteGitPath, 'rev-parse', 'main^{tree}')
    const onlyInRemoteGit = await git(
      '--git-dir',
      remoteGitPath,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@y',
      'commit-tree',
      tree,
      '-m',
      'only here',
    )
    await git(
      '--git-dir',
      remoteGitPath,
      'update-ref',
      'refs/remotes/github/stale',
      onlyInRemoteGit,
    )
    await git(
      '--git-dir',
      remoteGitPath,
      'update-ref',
      'refs/remotes/github/main',
      'refs/heads/main',
    )
    const upstream = await commitAndPush(githubPath, 'refs/heads/main', 'upstream.txt')

    await mirror.exclusive((m) => m.fetchFromGitHub(githubPath))

    // Seeded: the object only remote.git had is in the mirror, and its ref is pruned.
    expect(await git('--git-dir', mirror.gitDir, 'cat-file', '-t', onlyInRemoteGit)).toBe('commit')
    expect(await refs(mirror.gitDir)).toEqual(['refs/heads/main'])
    expect(await tip(mirror.gitDir, 'refs/heads/main')).toBe(upstream)
  })

  it('falls back to GitHub alone when remote.git cannot seed it', async () => {
    await fs.rm(path.join(remoteGitPath, 'objects'), { recursive: true, force: true })
    await git('init', '-q', '--bare', remoteGitPath)
    await fs.writeFile(path.join(remoteGitPath, 'packed-refs'), 'not a ref line\n')

    await mirror.exclusive((m) => m.fetchFromGitHub(githubPath))

    expect(await tip(mirror.gitDir, 'refs/heads/main')).toBe(
      await tip(githubPath, 'refs/heads/main'),
    )
    expect(consoleSpy).toHaveWarned(
      /Could not seed the GitHub mirror from remote\.git, fetching all of it from GitHub/,
    )
  })

  it('does not object-check what it fetches from GitHub, only what comes from remote.git', async () => {
    const tree = await git('--git-dir', githubPath, 'rev-parse', 'main^{tree}')
    const file = path.join(root, 'old-commit')
    await fs.writeFile(
      file,
      `tree ${tree}\nauthor No Email 1700000000 +0000\ncommitter x <x@y> 1700000000 +0000\n\nold\n`,
    )
    const sha = await git(
      '--git-dir',
      githubPath,
      'hash-object',
      '--literally',
      '-t',
      'commit',
      '-w',
      file,
    )
    await git('--git-dir', githubPath, 'update-ref', 'refs/heads/imported-history', sha)
    await git('--git-dir', remoteGitPath, 'update-ref', '-d', 'refs/remotes/github/main')

    await mirror.exclusive((m) => m.fetchFromGitHub(githubPath))

    expect(await tip(mirror.gitDir, 'refs/heads/imported-history')).toBe(sha)
  })

  it('drops a staging ref a killed push left, so a branch under that name can be pushed', async () => {
    await mirror.ensure()
    const leftover = await commitAndPush(remoteGitPath, 'refs/heads/a', 'a.txt')
    await git(
      '--git-dir',
      mirror.gitDir,
      'fetch',
      '-q',
      remoteGitPath,
      `${leftover}:refs/canopy/outgoing/a`,
    )
    const published = await commitAndPush(remoteGitPath, 'refs/heads/a/b', 'b.txt').catch(
      async () => {
        await git('--git-dir', remoteGitPath, 'update-ref', '-d', 'refs/heads/a')
        return commitAndPush(remoteGitPath, 'refs/heads/a/b', 'b.txt')
      },
    )

    const restarted = new GitHubMirror(path.join(root, 'state'), remoteGitPath, 30_000)
    await restarted.exclusive((m) =>
      m.pushToGitHub(githubPath, 'a/b', published, { protectedBranches: [] }),
    )

    expect(await tip(githubPath, 'refs/heads/a/b')).toBe(published)
  })

  it('refuses a lease that is not an object ID', async () => {
    const published = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'one.txt')
    await expect(
      mirror.exclusive((m) =>
        m.pushToGitHub(githubPath, 'feature', published, {
          lease: 'refs/heads/main',
          protectedBranches: [],
        }),
      ),
    ).rejects.toThrow(/Not a commit ID: "refs\/heads\/main"/)
  })

  it("creates a mirror only it can write, whatever the host's core.sharedRepository", async () => {
    const home = path.join(root, 'home')
    await fs.mkdir(home)
    await fs.writeFile(path.join(home, '.gitconfig'), '[core]\n\tsharedRepository = group\n')
    vi.stubEnv('HOME', home)
    try {
      await mirror.ensure()
    } finally {
      vi.unstubAllEnvs()
    }
    expect((await fs.stat(mirror.gitDir)).mode & 0o077).toBe(0)
  })

  it('refuses a state directory others can write', async () => {
    const state = path.join(root, 'shared-state')
    await fs.mkdir(state)
    await fs.chmod(state, 0o777)
    const exposed = new GitHubMirror(state, remoteGitPath, 30_000)
    await expect(exposed.ensure()).rejects.toThrow(/must be a directory this worker owns/)
  })

  it('refuses a commit argument that is not an object ID', async () => {
    await expect(
      mirror.exclusive((m) =>
        m.pushToGitHub(githubPath, 'feature', 'main:refs/heads/x', { protectedBranches: [] }),
      ),
    ).rejects.toThrow(/Not a commit ID/)
  })
})
