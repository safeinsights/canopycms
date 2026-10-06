/**
 * The worker's upkeep of `remote.git`, against real bare repos: the config
 * `ensureRemoteGit` writes, and the repack each `syncGit()` cycle runs.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { mockConsole, type MockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

type WorkerInternals = {
  ensureRemoteGit(): Promise<void>
  syncGit(): Promise<void>
  buildGitHubUrl(): string
  running: boolean
}

let tmpDir: string
let workspacePath: string
let githubPath: string
let remoteGitPath: string
let consoleSpy: MockConsole
let savedTrace: string | undefined

const bare = (gitDir: string, args: string[]) => simpleGit().raw(['--git-dir', gitDir, ...args])

async function configValue(gitDir: string, key: string): Promise<string> {
  return (await bare(gitDir, ['config', '--get', key])).trim()
}

async function counts(gitDir: string): Promise<{ loose: number; packs: number }> {
  const out = await bare(gitDir, ['count-objects', '-v'])
  const field = (name: string) =>
    Number(
      out
        .split('\n')
        .find((line) => line.startsWith(`${name}: `))
        ?.slice(name.length + 2),
    )
  return { loose: field('count'), packs: field('packs') }
}

/** A working clone of `remote` on main, with a test identity. */
async function workingClone(remote: string, name: string): Promise<SimpleGit> {
  const dir = path.join(tmpDir, name)
  await simpleGit().clone(remote, dir, ['--branch', 'main'])
  const git = simpleGit({ baseDir: dir })
  await git.addConfig('user.name', 'Test Bot')
  await git.addConfig('user.email', 'test@canopycms.test')
  return git
}

/** One commit per push, each adding a new file. */
async function pushCommits(git: SimpleGit, prefix: string, n: number): Promise<void> {
  const dir = (await git.revparse(['--show-toplevel'])).trim()
  for (let i = 0; i < n; i++) {
    await fs.writeFile(path.join(dir, `${prefix}-${i}.txt`), `${prefix} ${i}\n`)
    await git.raw(['-c', 'gc.auto=0', 'add', '.'])
    await git.raw(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'commit', '-qm', `${i}`])
    await git.raw(['push', '-q', 'origin', 'HEAD'])
  }
}

function makeWorker(): WorkerInternals {
  const worker = new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
  })
  const internals = worker as unknown as WorkerInternals
  internals.buildGitHubUrl = () => githubPath
  internals.running = true
  return internals
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  savedTrace = process.env.GIT_TRACE
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-remote-git-upkeep-'))
  workspacePath = path.join(tmpDir, 'workspace')
  githubPath = path.join(tmpDir, 'fixture-github.git')
  remoteGitPath = path.join(workspacePath, 'remote.git')
  await fs.mkdir(workspacePath, { recursive: true })

  const seedDir = path.join(tmpDir, 'seed')
  await fs.mkdir(seedDir)
  const seed = simpleGit({ baseDir: seedDir })
  await seed.init(['--initial-branch=main'])
  await seed.addConfig('user.name', 'Test Bot')
  await seed.addConfig('user.email', 'test@canopycms.test')
  await fs.writeFile(path.join(seedDir, 'README.md'), '# hello\n')
  await seed.add('.')
  await seed.commit('initial commit')
  await simpleGit().raw(['clone', '-q', '--bare', seedDir, githubPath])
})

afterEach(async () => {
  if (savedTrace === undefined) delete process.env.GIT_TRACE
  else process.env.GIT_TRACE = savedTrace
  consoleSpy.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('CmsWorker.ensureRemoteGit() remote.git config', () => {
  const expected: Array<[string, string]> = [
    ['gc.auto', '0'],
    ['receive.autogc', 'false'],
    ['maintenance.auto', 'false'],
    ['transfer.unpackLimit', '1'],
  ]

  it('configures a freshly cloned remote.git', async () => {
    await makeWorker().ensureRemoteGit()

    for (const [key, value] of expected) {
      expect(await configValue(remoteGitPath, key)).toBe(value)
    }
  })

  it('configures an existing remote.git, then leaves its config file alone', async () => {
    await simpleGit().raw(['clone', '-q', '--bare', githubPath, remoteGitPath])
    await bare(remoteGitPath, ['remote', 'remove', 'origin'])

    await makeWorker().ensureRemoteGit()
    for (const [key, value] of expected) {
      expect(await configValue(remoteGitPath, key)).toBe(value)
    }

    const configPath = path.join(remoteGitPath, 'config')
    const before = await fs.stat(configPath)
    await makeWorker().ensureRemoteGit()
    const after = await fs.stat(configPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('stops a push into remote.git from starting gc', async () => {
    await simpleGit().raw(['clone', '-q', '--bare', githubPath, remoteGitPath])
    await bare(remoteGitPath, ['remote', 'remove', 'origin'])
    for (const [key, value] of [
      ['receive.autogc', 'true'],
      ['gc.auto', '1'],
      ['gc.autoPackLimit', '1'],
      ['gc.autoDetach', 'false'],
    ]) {
      await bare(remoteGitPath, ['config', key, value])
    }
    await bare(remoteGitPath, ['repack', '-a', '-d', '-q'])

    await makeWorker().ensureRemoteGit()

    const work = await workingClone(remoteGitPath, 'pusher')
    const traceFile = path.join(tmpDir, 'push.trace')
    process.env.GIT_TRACE = traceFile
    await pushCommits(work, 'gc-probe', 2)
    delete process.env.GIT_TRACE
    const ran = [...(await fs.readFile(traceFile, 'utf8')).matchAll(/built-in: git (\S+)/g)].map(
      (m) => m[1],
    )

    expect(ran).toContain('receive-pack')
    expect(ran).not.toContain('gc')
    expect(ran).not.toContain('maintenance')
    expect((await counts(remoteGitPath)).packs).toBe(3)
  })
})

describe('CmsWorker.syncGit() remote.git maintenance', () => {
  async function initRemoteGit(): Promise<void> {
    await simpleGit().raw(['clone', '-q', '--bare', githubPath, remoteGitPath])
    await bare(remoteGitPath, ['remote', 'remove', 'origin'])
  }

  it('repacks loose objects, keeping unreachable objects and clones made before the repack', async () => {
    await initRemoteGit()
    const work = await workingClone(remoteGitPath, 'pusher')
    await pushCommits(work, 'loose', 20)

    await work.raw(['checkout', '-q', '-b', 'doomed'])
    await pushCommits(work, 'doomed', 1)
    const unreachable = (await work.revparse(['HEAD'])).trim()
    await bare(remoteGitPath, ['update-ref', '-d', 'refs/heads/doomed'])

    const before = await counts(remoteGitPath)
    expect(before.loose).toBeGreaterThan(50)
    const preClone = path.join(tmpDir, 'pre-clone')
    await simpleGit().clone(remoteGitPath, preClone, ['--branch', 'main'])

    await makeWorker().syncGit()

    const after = await counts(remoteGitPath)
    expect(after.loose).toBe(0)
    expect(after.packs).toBeLessThanOrEqual(2)
    await expect(bare(remoteGitPath, ['fsck', '--full'])).resolves.toBeDefined()
    expect((await bare(remoteGitPath, ['cat-file', '-t', unreachable])).trim()).toBe('commit')
    await expect(simpleGit({ baseDir: preClone }).raw(['fsck', '--full'])).resolves.toBeDefined()
    expect((await fs.readdir(path.join(remoteGitPath, 'objects'))).sort()).toEqual(['info', 'pack'])
    expect(consoleSpy).toHaveLogged(
      `remote.git maintenance: loose ${before.loose}→0 packs ${before.packs}→`,
    )
  })

  it('logs a failed repack and still completes the cycle', async () => {
    await initRemoteGit()
    const work = await workingClone(remoteGitPath, 'pusher')
    await pushCommits(work, 'loose', 20)
    const packDir = path.join(remoteGitPath, 'objects', 'pack')
    await fs.chmod(packDir, 0o555)
    try {
      await expect(makeWorker().syncGit()).resolves.toBeUndefined()
    } finally {
      await fs.chmod(packDir, 0o755)
    }

    expect(consoleSpy).toHaveWarned(/remote\.git maintenance failed/)
    expect(consoleSpy).toHaveLogged(/Fetched from GitHub/)
  })

  it('repacks once remote.git holds more than six packs', async () => {
    await initRemoteGit()
    await bare(remoteGitPath, ['config', 'transfer.unpackLimit', '1'])
    const work = await workingClone(remoteGitPath, 'pusher')
    await pushCommits(work, 'packed', 8)
    expect((await counts(remoteGitPath)).packs).toBeGreaterThan(6)

    await makeWorker().syncGit()

    const after = await counts(remoteGitPath)
    expect(after).toEqual({ loose: 0, packs: 1 })
    await expect(bare(remoteGitPath, ['fsck', '--full'])).resolves.toBeDefined()
  })
})
