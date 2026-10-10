/**
 * An existing remote.git with no base branch (cloned while GitHub was empty) is replaced from
 * GitHub when every ref in it is already on GitHub, and kept, with the refs at stake named, when
 * any is not, or when that cannot be established. Real git throughout; "GitHub" is a local bare
 * fixture reached through the worker's mirror.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { readHeadBranch } from '../utils/git'
import { CmsWorker, type CmsWorkerConfig } from './cms-worker'

type Internals = {
  ensureRemoteGit(): Promise<void>
  buildGitHubUrl(): Promise<string>
  octokit: unknown
  baseBranch: string
}

let tmpDir: string
let workspacePath: string
let githubFixture: string
let remoteGitPath: string
let seed: Awaited<ReturnType<typeof initTestRepo>>
let seedDir: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-poisoned-remote-'))
  workspacePath = path.join(tmpDir, 'workspace')
  githubFixture = path.join(tmpDir, 'github.git')
  remoteGitPath = path.join(workspacePath, 'remote.git')
  await fs.mkdir(workspacePath, { recursive: true })
  await simpleGit().raw(['init', '--bare', '--initial-branch=main', githubFixture])
  // remote.git as an empty GitHub repo's clone leaves it: no refs, HEAD naming an unborn 'main'.
  await simpleGit().raw(['init', '--bare', '--initial-branch=main', remoteGitPath])
  seedDir = path.join(tmpDir, 'seed')
  await fs.mkdir(seedDir)
  seed = await initTestRepo(seedDir)
  await seed.raw(['checkout', '-b', 'main'])
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeWorker(extra: Partial<CmsWorkerConfig> = {}): CmsWorker {
  const worker = new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
    taskPollInterval: 60_000,
    gitSyncInterval: 60_000,
    ...extra,
  })
  ;(worker as unknown as Internals).buildGitHubUrl = async () => githubFixture
  return worker
}

const internals = (worker: CmsWorker) => worker as unknown as Internals

/** A worker with no base branch configured, whose GitHub reports `defaultBranch`. */
function unconfigured(defaultBranch: string): CmsWorker {
  const worker = makeWorker({ baseBranch: undefined })
  internals(worker).octokit = {
    repos: { get: vi.fn(async () => ({ data: { default_branch: defaultBranch } })) },
  }
  return worker
}

/** Commit `file` in the seed repo on its current branch and return the commit. */
async function commit(file: string): Promise<string> {
  await fs.writeFile(path.join(seedDir, file), `${file}\n`)
  await seed.add(['.'])
  await seed.commit(`add ${file}`)
  return (await seed.revparse(['HEAD'])).trim()
}

async function push(repo: string, refspec: string): Promise<void> {
  await seed.raw(['push', '--quiet', repo, refspec])
}

async function refsIn(repo: string): Promise<string[]> {
  const out = await simpleGit().raw(['--git-dir', repo, 'for-each-ref', '--format=%(refname)'])
  return out.split('\n').filter(Boolean)
}

async function workspaceEntries(): Promise<string[]> {
  return (await fs.readdir(workspacePath)).filter((e) => e.startsWith('remote.git')).sort()
}

describe('a poisoned remote.git with nothing GitHub lacks', () => {
  it('is replaced from GitHub, and the worker starts', async () => {
    // A branch GitHub has moved past, and a tracking ref for a branch GitHub has since deleted:
    // neither holds work only remote.git has.
    await commit('one.md')
    await push(remoteGitPath, 'HEAD:refs/heads/feature')
    await seed.raw(['checkout', '-b', 'gone'])
    await commit('gone.md')
    await push(remoteGitPath, 'HEAD:refs/remotes/github/gone')
    await seed.raw(['checkout', 'main'])
    await commit('two.md')
    await push(githubFixture, 'main')

    const worker = makeWorker()
    try {
      await worker.start()
    } finally {
      await worker.stop()
    }

    expect(await refsIn(remoteGitPath)).toContain('refs/heads/main')
    expect(await refsIn(remoteGitPath)).not.toContain('refs/heads/feature')
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it('is replaced when it has no refs at all', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')

    await internals(makeWorker()).ensureRemoteGit()

    expect(await refsIn(remoteGitPath)).toEqual(['refs/heads/main'])
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it("takes GitHub's default branch, not the one the poisoned HEAD names, when none is configured", async () => {
    await seed.raw(['checkout', '-b', 'trunk'])
    await commit('one.md')
    await push(githubFixture, 'trunk')
    const worker = unconfigured('trunk')
    try {
      await worker.start()
    } finally {
      await worker.stop()
    }

    expect(internals(worker).baseBranch).toBe('trunk')
    expect(await readHeadBranch(remoteGitPath)).toBe('trunk')
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })
})

describe('a poisoned remote.git that is kept', () => {
  it('names the refs GitHub does not have, and leaves them in place', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')
    await push(remoteGitPath, 'HEAD:refs/heads/on-github')
    await seed.raw(['checkout', '--orphan', 'canopycms-settings-prod'])
    const settings = await commit('permissions.json')
    await push(remoteGitPath, 'HEAD:refs/heads/canopycms-settings-prod')
    await seed.raw(['tag', 'local-only'])
    await push(remoteGitPath, 'refs/tags/local-only')

    const attempt = internals(makeWorker()).ensureRemoteGit()

    await expect(attempt).rejects.toThrow(
      /holds 2 refs GitHub does not have, so the worker will not replace it: refs\/heads\/canopycms-settings-prod, refs\/tags\/local-only\./,
    )
    await expect(attempt).rejects.not.toThrow(/on-github/)
    expect(
      (
        await simpleGit().raw(['--git-dir', remoteGitPath, 'rev-parse', 'canopycms-settings-prod'])
      ).trim(),
    ).toBe(settings)
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it('names a settings branch GitHub does not have when no base branch is configured', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')
    await seed.raw(['checkout', '--orphan', 'canopycms-settings-prod'])
    await commit('permissions.json')
    await push(remoteGitPath, 'HEAD:refs/heads/canopycms-settings-prod')
    const worker = unconfigured('main')
    try {
      await expect(worker.start()).rejects.toThrow(
        /will not replace it: refs\/heads\/canopycms-settings-prod\./,
      )
    } finally {
      await worker.stop()
    }
    expect(await refsIn(remoteGitPath)).toEqual(['refs/heads/canopycms-settings-prod'])
  })

  it('when GitHub cannot be fetched, and deletes nothing', async () => {
    const worker = makeWorker()
    internals(worker).buildGitHubUrl = async () => path.join(tmpDir, 'no-such-repo.git')

    await expect(internals(worker).ensureRemoteGit()).rejects.toThrow(
      /has no branch 'main'.*and it was not replaced/s,
    )
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it('when GitHub has no base branch either', async () => {
    await commit('one.md')
    await push(githubFixture, 'HEAD:refs/heads/other')

    await expect(internals(makeWorker()).ensureRemoteGit()).rejects.toThrow(/not replaced/)
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it('when a ref in it cannot be read', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')
    await fs.writeFile(path.join(remoteGitPath, 'refs', 'heads', 'broken'), 'not an object id\n')

    await expect(internals(makeWorker()).ensureRemoteGit()).rejects.toThrow(
      /refs could not all be read.*broken/s,
    )
    expect(await fs.readFile(path.join(remoteGitPath, 'refs', 'heads', 'broken'), 'utf-8')).toBe(
      'not an object id\n',
    )
  })

  it('when a ref arrives while the replacement is seeded', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')
    await seed.raw(['checkout', '--orphan', 'canopycms-settings-prod'])
    await commit('permissions.json')
    const worker = makeWorker()
    // Resolved after the first listing, inside the seed: the Lambda pushing as it runs.
    internals(worker).buildGitHubUrl = async () => {
      await push(remoteGitPath, 'HEAD:refs/heads/canopycms-settings-prod')
      return githubFixture
    }

    await expect(internals(worker).ensureRemoteGit()).rejects.toThrow(
      /refs changed while the worker seeded its replacement/,
    )
    expect(await refsIn(remoteGitPath)).toEqual(['refs/heads/canopycms-settings-prod'])
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })

  it('when its config holds a key CanopyCMS never writes, though nothing in it is at stake', async () => {
    await commit('one.md')
    await push(githubFixture, 'main')
    await simpleGit().raw([
      'config',
      '--file',
      path.join(remoteGitPath, 'config'),
      'planted.key',
      'value',
    ])

    await expect(internals(makeWorker()).ensureRemoteGit()).rejects.toThrow(/planted\.key/)
    expect(await workspaceEntries()).toEqual(['remote.git'])
  })
})
