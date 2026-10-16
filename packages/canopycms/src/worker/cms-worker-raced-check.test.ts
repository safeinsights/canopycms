/**
 * The worker's git in remote.git when a plant lands AFTER `assertSharedRepoConfig` has passed:
 * the check is skipped here, so what holds is only the git instance each call runs with. A
 * promisor remote planted in remote.git, with HEAD naming a commit that is not there, makes any
 * git that reads HEAD's object lazily fetch it through the planted remote's own upload-pack
 * command, unless that git runs with `sharedRepoGit`'s environment (`GIT_NO_LAZY_FETCH`).
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

vi.mock('./shared-repo-git', async (importOriginal) => {
  const original = await importOriginal<typeof import('./shared-repo-git')>()
  return { ...original, assertSharedRepoConfig: vi.fn(async () => undefined) }
})

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let sentinel: string
let workspacePath: string
let remoteGitPath: string
let consoleSpy: MockConsole

const sentinelLines = async () =>
  (await fs.readFile(sentinel, 'utf8').catch(() => '')).split('\n').filter(Boolean)

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-raced-check-')))
  sentinel = path.join(root, 'sentinel.log')
  workspacePath = path.join(root, 'workspace')
  remoteGitPath = path.join(workspacePath, 'remote.git')
  const seed = path.join(root, 'seed')
  await fs.mkdir(seed)
  const seedGit = await initTestRepo(seed)
  await seedGit.raw(['checkout', '-q', '-b', 'main'])
  await fs.writeFile(path.join(seed, 'a.txt'), 'a\n')
  await seedGit.add('.')
  await seedGit.commit('seed')
  await fs.mkdir(workspacePath)
  await git('clone', '-q', '--bare', seed, remoteGitPath)
  await git('--git-dir', remoteGitPath, 'remote', 'remove', 'origin')

  // The plant: a promisor remote whose upload-pack command records, and a HEAD whose commit is
  // missing, so reading it is a lazy fetch.
  const config = path.join(remoteGitPath, 'config')
  for (const [key, value] of [
    ['core.repositoryformatversion', '1'],
    ['extensions.partialClone', 'planted'],
    ['remote.planted.promisor', 'true'],
    ['remote.planted.url', remoteGitPath],
    ['remote.planted.uploadpack', `sh -c 'echo lazy-fetch >> ${sentinel}; exit 1' #`],
  ]) {
    await git('config', '--file', config, '--add', key, value)
  }
  await fs.writeFile(path.join(remoteGitPath, 'refs', 'heads', 'ghost'), `${'1'.repeat(40)}\n`)
  await git('--git-dir', remoteGitPath, 'symbolic-ref', 'HEAD', 'refs/heads/ghost')
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

function makeWorker(baseBranch?: string): CmsWorker {
  return new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch,
    stateDirectory: path.join(root, 'state'),
  })
}

describe("the worker's reads of remote.git's HEAD, with the config check outrun", () => {
  it('base-branch detection never lazily fetches through a planted promisor remote', async () => {
    await expect(makeWorker().start()).rejects.toThrow(/CANOPYCMS_BASE_BRANCH is not set/)

    expect(await sentinelLines()).toEqual([])
  })

  it('pointing HEAD at the base branch never lazily fetches through one either', async () => {
    const internals = makeWorker('main') as unknown as {
      recordBaseBranchInRemoteHead(): Promise<void>
    }

    await internals.recordBaseBranchInRemoteHead()

    expect(await git('--git-dir', remoteGitPath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(await sentinelLines()).toEqual([])
  })
})
