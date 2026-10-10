/**
 * The worker's base branch when CANOPYCMS_BASE_BRANCH is unset, through a real start() against a
 * local GitHub fixture whose default branch is `production`: detected rather than assumed to be
 * 'main', and recorded as remote.git's HEAD, which is what the Lambda reads.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockConsole, type MockConsole } from '../test-utils'
import { readHeadBranch } from '../utils/git'
import { CmsWorker, type CmsWorkerConfig } from './cms-worker'

type WorkerInternals = {
  buildGitHubUrl: () => Promise<string>
  octokit: unknown
  baseBranch: string
}

let tmpDir: string
let workspacePath: string
let githubFixture: string
let remoteGitPath: string
let consoleSpy: MockConsole
let reposGet: ReturnType<typeof vi.fn>

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-base-branch-'))
  workspacePath = path.join(tmpDir, 'workspace')
  githubFixture = path.join(tmpDir, 'github.git')
  remoteGitPath = path.join(workspacePath, 'remote.git')
  await fs.mkdir(workspacePath, { recursive: true })

  // GitHub's default is `production`; a `main` exists too, so assuming 'main' would not fail.
  const seedDir = path.join(tmpDir, 'seed')
  await fs.mkdir(seedDir)
  const seed = simpleGit({ baseDir: seedDir })
  await seed.init(['--initial-branch=production'])
  await seed.addConfig('user.name', 'Test Bot')
  await seed.addConfig('user.email', 'test@canopycms.test')
  await fs.writeFile(path.join(seedDir, 'README.md'), '# site\n')
  await seed.add('.')
  await seed.commit('initial commit')
  await seed.branch(['main'])
  await simpleGit().raw(['clone', '-q', '--bare', seedDir, githubFixture])

  reposGet = vi.fn(async () => ({ data: { default_branch: 'production' } }))
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
    taskPollInterval: 60_000,
    gitSyncInterval: 60_000,
    ...extra,
  })
  const internals = worker as unknown as WorkerInternals
  internals.buildGitHubUrl = async () => githubFixture
  internals.octokit = { repos: { get: reposGet } }
  return worker
}

async function boot(worker: CmsWorker): Promise<string> {
  try {
    await worker.start()
    return (worker as unknown as WorkerInternals).baseBranch
  } finally {
    await worker.stop()
  }
}

describe('CmsWorker base branch', () => {
  it("detects GitHub's default branch on first boot and records it as remote.git HEAD", async () => {
    expect(await boot(makeWorker())).toBe('production')

    expect(reposGet).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo' })
    expect(await readHeadBranch(remoteGitPath)).toBe('production')
  })

  it('reads an existing remote.git HEAD rather than asking GitHub', async () => {
    await simpleGit().raw(['clone', '-q', '--bare', githubFixture, remoteGitPath])

    expect(await boot(makeWorker())).toBe('production')

    expect(reposGet).not.toHaveBeenCalled()
  })

  it('uses a configured base branch and points remote.git HEAD at it', async () => {
    expect(await boot(makeWorker({ baseBranch: 'main' }))).toBe('main')

    expect(reposGet).not.toHaveBeenCalled()
    expect(await readHeadBranch(remoteGitPath)).toBe('main')
  })

  it('fails to start, naming CANOPYCMS_BASE_BRANCH, when remote.git HEAD names no branch', async () => {
    await simpleGit().raw(['clone', '-q', '--bare', githubFixture, remoteGitPath])
    await simpleGit().raw(['--git-dir', remoteGitPath, 'symbolic-ref', 'HEAD', 'refs/heads/gone'])

    const worker = makeWorker()
    try {
      await expect(worker.start()).rejects.toThrow(/CANOPYCMS_BASE_BRANCH is not set/)
    } finally {
      await worker.stop()
    }
  })

  it('refuses to report a base branch before start() has resolved one', () => {
    const worker = makeWorker()
    expect(() => (worker as unknown as WorkerInternals).baseBranch).toThrow(/start\(\)/)
  })
})
