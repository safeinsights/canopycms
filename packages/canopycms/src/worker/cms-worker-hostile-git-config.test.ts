/**
 * The worker against shared repositories whose git config and hooks a compromised CMS Lambda has
 * written. The worker holds the GitHub credential; the Lambda can write `remote.git` and every
 * branch clone. Each test plants something into those repositories, drives the worker the way
 * production does, and asserts that nothing planted ran and that the "credential" (the GitHub
 * URL the worker builds) never reached the attacker's repository.
 *
 * Real git throughout. "GitHub" is a local bare repo the worker's URL points at; the attacker is
 * another local bare repo, which every planted redirect points at. Anything a plant runs appends
 * to `sentinel.log`.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BranchMetadataFileManager } from '../branch-metadata'
import { recordSparseCone } from '../branch-sparse'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import type { WorkerStatusReport } from '../types'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { CmsWorker } from './cms-worker'

const execFileAsync = promisify(execFile)

const BASE = 'main'
const BRANCH = 'feature'

/** The hook events a planted script listens on: every one a fetch, push, rebase or merge fires. */
const HOOKS = [
  'pre-receive',
  'update',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-push',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-auto-gc',
  'post-index-change',
]

interface Fixture {
  root: string
  sentinel: string
  githubPath: string
  attackerPath: string
  workspacePath: string
  remoteGitPath: string
  contentBranchesPath: string
  basePath: string
  branchPath: string
  branchGit: SimpleGit
  worker: WorkerInternals
  /** A new commit on GitHub's base branch. */
  advanceGitHub: (file: string) => Promise<string>
  /** The sha a bare repo holds for `ref`, or null. */
  sha: (gitDir: string, ref: string) => Promise<string | null>
  /** Every ref a bare repo holds. */
  refs: (gitDir: string) => Promise<string[]>
  sentinelLines: () => Promise<string[]>
}

type WorkerInternals = {
  buildGitHubUrl(): Promise<string>
  running: boolean
  syncGit(): Promise<void>
  ensureRemoteGit(): Promise<void>
  pushBranchToGitHub(branch: string): Promise<void>
}

function bare(gitDir: string): SimpleGit {
  return simpleGit({ config: ['safe.bareRepository=all'] }).env({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_DIR: gitDir,
  })
}

async function readStatus(): Promise<WorkerStatusReport | undefined> {
  const file = path.join(f.workspacePath, '.tasks', WORKER_STATUS_FILE)
  return JSON.parse(await fs.readFile(file, 'utf8')) as WorkerStatusReport
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-hostile-git-')))
  const sentinel = path.join(root, 'sentinel.log')
  const githubPath = path.join(root, 'github.git')
  const attackerPath = path.join(root, 'attacker.git')
  const workspacePath = path.join(root, 'workspace')
  const remoteGitPath = path.join(workspacePath, 'remote.git')
  const contentBranchesPath = path.join(workspacePath, 'content-branches')
  const basePath = path.join(contentBranchesPath, BASE)
  const branchPath = path.join(contentBranchesPath, BRANCH)
  await fs.mkdir(contentBranchesPath, { recursive: true })

  const seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  const seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', BASE])
  await fs.writeFile(path.join(seedPath, 'base.txt'), 'base\n')
  await seed.add('.')
  await seed.commit('initial')
  await simpleGit().raw(['init', '-q', '--bare', githubPath])
  await simpleGit().raw(['init', '-q', '--bare', attackerPath])
  await seed.raw(['push', '-q', githubPath, `${BASE}:${BASE}`])

  // remote.git as the worker seeds it: a bare copy of GitHub with no remote configured.
  await simpleGit().raw(['clone', '-q', '--bare', githubPath, remoteGitPath])
  await bare(remoteGitPath).raw(['remote', 'remove', 'origin'])

  const clone = async (dir: string, branch: string) => {
    await simpleGit().raw(['clone', '-q', '--single-branch', '--branch', BASE, remoteGitPath, dir])
    const git = simpleGit({ baseDir: dir })
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await fs.appendFile(path.join(dir, '.git', 'info', 'exclude'), '\n.canopy-meta/\n')
    if (branch !== BASE) await git.raw(['checkout', '-q', '-b', branch])
    await BranchMetadataFileManager.get(dir, contentBranchesPath).save({
      branch: { name: branch, status: 'editing', access: {}, createdBy: 'test' },
    })
    return git
  }
  await clone(basePath, BASE)
  const branchGit = await clone(branchPath, BRANCH)
  await fs.writeFile(path.join(branchPath, 'branch.txt'), 'branch work\n')
  await branchGit.add('branch.txt')
  await branchGit.commit('branch work')
  await branchGit.raw(['push', '-q', remoteGitPath, `${BRANCH}:${BRANCH}`])

  const worker = new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: BASE,
    stateDirectory: path.join(root, 'worker-state'),
  }) as unknown as WorkerInternals
  worker.buildGitHubUrl = async () => githubPath
  worker.running = true

  let n = 0
  const advanceGitHub = async (file: string) => {
    await seed.checkout(BASE)
    await fs.writeFile(path.join(seedPath, file), `upstream ${n++}\n`)
    await seed.add('.')
    await seed.commit(`upstream ${file}`)
    await seed.raw(['push', '-q', githubPath, `${BASE}:${BASE}`])
    return (await seed.revparse(['HEAD'])).trim()
  }
  const sha = async (gitDir: string, ref: string) => {
    try {
      return (await bare(gitDir).raw(['rev-parse', '--verify', '--quiet', ref])).trim() || null
    } catch {
      return null
    }
  }
  const refs = async (gitDir: string) =>
    (await bare(gitDir).raw(['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean)
  const sentinelLines = async () =>
    (await fs.readFile(sentinel, 'utf8').catch(() => '')).split('\n').filter(Boolean)

  return {
    root,
    sentinel,
    githubPath,
    attackerPath,
    workspacePath,
    remoteGitPath,
    contentBranchesPath,
    basePath,
    branchPath,
    branchGit,
    worker,
    advanceGitHub,
    sha,
    refs,
    sentinelLines,
  }
}

/** A shell command appending `label` to the sentinel; what every planted command runs. */
function record(f: Fixture, label: string): string {
  return `echo ${label} >> '${f.sentinel}'`
}

/** Hook scripts for every event in {@link HOOKS}, in `<gitDir>/hooks` and in a hooksPath dir. */
async function plantHookScripts(f: Fixture, gitDir: string, label: string): Promise<void> {
  for (const dir of [path.join(gitDir, 'hooks'), path.join(gitDir, 'planted-hooks')]) {
    await fs.mkdir(dir, { recursive: true })
    for (const hook of HOOKS) {
      const file = path.join(dir, hook)
      await fs.writeFile(file, `#!/bin/sh\n${record(f, `${label}:${hook}`)}\nexit 0\n`)
      await fs.chmod(file, 0o755)
    }
  }
}

/** Write raw config into `<gitDir>/config`, as the Lambda's process could. */
async function plantConfig(gitDir: string, entries: [string, string][]): Promise<void> {
  // Plain git rather than simple-git, which refuses to write most of these keys.
  for (const [key, value] of entries) {
    await execFileAsync('git', [
      'config',
      '--file',
      path.join(gitDir, 'config'),
      '--add',
      key,
      value,
    ])
  }
}

/** Config that runs a command or redirects a transfer, all keyed to `label`. */
function hostileConfig(f: Fixture, label: string, gitDir: string): [string, string][] {
  return [
    // The GitHub URL the worker builds starts with the fixture path, as the real one starts with
    // `https://x-access-token`: insteadOf matches on that prefix and carries the rest along.
    [`url.${f.attackerPath}.insteadOf`, f.githubPath],
    [`url.${f.attackerPath}.pushInsteadOf`, f.githubPath],
    ['credential.helper', `!${record(f, `${label}:credential-helper`)}; true`],
    ['core.fsmonitor', `${record(f, `${label}:fsmonitor`)}; true`],
    ['core.hooksPath', path.join(gitDir, 'planted-hooks')],
    ['hook.planted.command', record(f, `${label}:config-hook`)],
    ...HOOKS.map((hook): [string, string] => ['hook.planted.event', hook]),
    ['core.alternateRefsCommand', `${record(f, `${label}:alternate-refs`)}; true`],
  ]
}

let f: Fixture
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  f = await createFixture()
})

afterEach(async () => {
  consoleSpy.restore()
  if (f) await fs.rm(f.root, { recursive: true, force: true })
})

describe('hooks planted in remote.git and branch clones (no config: the worker proceeds)', () => {
  it('never run during a sync cycle that fetches, reconciles, refreshes the base and rebases', async () => {
    await plantHookScripts(f, f.remoteGitPath, 'remote.git')
    await plantHookScripts(f, path.join(f.basePath, '.git'), 'base-clone')
    await plantHookScripts(f, path.join(f.branchPath, '.git'), 'branch-clone')
    const upstream = await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    // The cycle did its work: remote.git's base moved, and both clones are on it.
    expect(await f.sha(f.remoteGitPath, `refs/heads/${BASE}`)).toBe(upstream)
    const baseHead = (await simpleGit({ baseDir: f.basePath }).revparse(['HEAD'])).trim()
    expect(baseHead).toBe(upstream)
    const merged = await f.branchGit.raw(['merge-base', '--is-ancestor', upstream, 'HEAD'])
    expect(merged).toBe('')
    expect(await f.sentinelLines()).toEqual([])
  })

  it('never run during a publish to GitHub, and the push lands on GitHub', async () => {
    await plantHookScripts(f, f.remoteGitPath, 'remote.git')
    const published = await f.sha(f.remoteGitPath, `refs/heads/${BRANCH}`)

    await f.worker.pushBranchToGitHub(BRANCH)

    expect(await f.sha(f.githubPath, `refs/heads/${BRANCH}`)).toBe(published)
    expect(await f.sentinelLines()).toEqual([])
  })
})

describe('config planted in remote.git', () => {
  it('never redirects a publish or runs code: the push goes nowhere, and says why', async () => {
    await plantHookScripts(f, f.remoteGitPath, 'remote.git')
    await plantConfig(f.remoteGitPath, hostileConfig(f, 'remote.git', f.remoteGitPath))

    await expect(f.worker.pushBranchToGitHub(BRANCH)).rejects.toThrow(
      /^Refusing to run git in \S+remote\.git: .*url\.\S+\.insteadof in \S+remote\.git\/config/,
    )

    expect(await f.refs(f.attackerPath)).toEqual([])
    expect(await f.sha(f.githubPath, `refs/heads/${BRANCH}`)).toBeNull()
    expect(await f.sentinelLines()).toEqual([])
  })

  it('never redirects the GitHub fetch or runs code: the cycle is refused and reported', async () => {
    await plantHookScripts(f, f.remoteGitPath, 'remote.git')
    await plantConfig(f.remoteGitPath, hostileConfig(f, 'remote.git', f.remoteGitPath))
    // What a redirected fetch would bring in.
    await bare(f.attackerPath).raw([
      'fetch',
      '-q',
      f.githubPath,
      `refs/heads/${BASE}:refs/heads/from-the-attacker`,
    ])
    await f.advanceGitHub('upstream.txt')

    await expect(f.worker.syncGit()).rejects.toThrow(/^Refusing to run git in \S+remote\.git/)

    expect((await f.refs(f.remoteGitPath)).filter((r) => r.includes('from-the-attacker'))).toEqual(
      [],
    )
    expect(await f.sentinelLines()).toEqual([])
    const status = await readStatus()
    expect(status?.lastGitSyncError?.message).toMatch(
      /core\.hookspath in \S+remote\.git\/config.*git config --file '\S+remote\.git\/config' --unset-all 'core\.hookspath'/,
    )
  })
})

describe('config planted in a branch clone', () => {
  const drivers = (label: string): [string, string][] => [
    ['filter.planted.smudge', `sh -c '${record(f, `${label}:smudge`)}; cat'`],
    ['filter.planted.clean', `sh -c '${record(f, `${label}:clean`)}; cat'`],
    ['merge.planted.driver', `sh -c '${record(f, `${label}:merge-driver`)}; exit 1'`],
  ]

  it('is refused before any git runs there: no driver, hook or fsmonitor runs, and the branch records the key', async () => {
    const gitDir = path.join(f.branchPath, '.git')
    await plantHookScripts(f, gitDir, 'branch-clone')
    await plantConfig(gitDir, [...hostileConfig(f, 'branch-clone', gitDir), ...drivers('branch')])
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=planted merge=planted\n')
    await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    const status = await readStatus()
    const failure = status?.lastGitSync?.failed.find((entry) => entry.branch === BRANCH)
    expect(failure?.error).toMatch(/^Refusing to run git in \S+\/feature: /)
    expect(failure?.error).toMatch(/filter\.planted\.smudge in \S+\/feature\/\.git\/config/)
    expect(failure?.error).toMatch(/merge\.planted\.driver/)
    const meta = await BranchMetadataFileManager.loadOnly(f.branchPath)
    expect(meta?.branch.rebaseFailure?.message).toMatch(/filter\.planted\.smudge/)
  })

  it('is refused before a sparse-checkout cone change checks files out', async () => {
    await f.branchGit.raw(['sparse-checkout', 'set', '--cone', '--', 'content'])
    const gitDir = path.join(f.branchPath, '.git')
    await plantConfig(gitDir, drivers('sparse'))
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=planted\n')
    await recordSparseCone(f.contentBranchesPath, ['docs'])

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    expect(consoleSpy).toHaveWarned(
      new RegExp(`${BRANCH}: could not change the sparse-checkout cone: Refusing to run git in`),
    )
  })

  it('is refused when its index holds a submodule, which no config check reads', async () => {
    const sub = path.join(f.branchPath, 'sub')
    await fs.mkdir(sub)
    const subGit = await initTestRepo(sub)
    await fs.writeFile(path.join(sub, 'f'), 'a\n')
    await subGit.add('f')
    await subGit.commit('sub')
    await plantConfig(path.join(sub, '.git'), drivers('submodule'))
    await fs.writeFile(path.join(sub, '.gitattributes'), '* filter=planted\n')
    const sha = (await subGit.revparse(['HEAD'])).trim()
    await f.branchGit.raw(['update-index', '--add', '--cacheinfo', `160000,${sha},sub`])
    await fs.writeFile(path.join(sub, 'f'), 'b\n')
    await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    const status = await readStatus()
    expect(status?.lastGitSync?.failed.find((entry) => entry.branch === BRANCH)?.error).toMatch(
      /its index holds a submodule at "sub"/,
    )
  })

  it('in the base clone is refused too, and reported on the refresh', async () => {
    const gitDir = path.join(f.basePath, '.git')
    await plantConfig(gitDir, drivers('base'))
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=planted\n')
    await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    const status = await readStatus()
    expect(status?.lastGitSync?.baseRefresh?.outcome).toBe('failed')
    expect(status?.lastGitSync?.baseRefresh?.message).toMatch(/filter\.planted\.clean/)
  })

  it('reached through an include, or in config.worktree, is refused the same way', async () => {
    const gitDir = path.join(f.branchPath, '.git')
    const included = path.join(f.root, 'included.cfg')
    await fs.writeFile(included, `[filter "planted"]\n\tsmudge = ${record(f, 'include')}\n`)
    await plantConfig(gitDir, [
      ['include.path', included],
      ['extensions.worktreeConfig', 'true'],
    ])
    await fs.writeFile(
      path.join(gitDir, 'config.worktree'),
      `[core]\n\tfsmonitor = ${record(f, 'worktree-config')}\n`,
    )
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=planted\n')
    await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    const status = await readStatus()
    const error = status?.lastGitSync?.failed.find((entry) => entry.branch === BRANCH)?.error
    expect(error).toMatch(/include\.path in \S+\/feature\/\.git\/config/)
    expect(error).toMatch(/filter\.planted\.smudge in \S+included\.cfg/)
    expect(error).toMatch(/core\.fsmonitor in \S+\/feature\/\.git\/config\.worktree/)
  })
})

describe('a repository planted where git would look first', () => {
  it('inside remote.git refuses the cycle, and nothing in it runs', async () => {
    // Given remote.git's path, receive-pack and upload-pack use remote.git/.git when it exists.
    const nested = path.join(f.remoteGitPath, '.git')
    await simpleGit().raw(['init', '-q', '--bare', nested])
    await plantHookScripts(f, nested, 'nested')
    await plantConfig(nested, hostileConfig(f, 'nested', nested))
    await f.advanceGitHub('upstream.txt')

    await expect(f.worker.syncGit()).rejects.toThrow(
      /^Refusing to run git in \S+remote\.git: .*remote\.git\/\.git exists, and git would use it instead/,
    )

    expect(await f.sentinelLines()).toEqual([])
  })

  it('above a clone that lost its .git is never used', async () => {
    const above = path.join(f.contentBranchesPath, '.git')
    await simpleGit().raw(['init', '-q', '--bare', above])
    await plantHookScripts(f, above, 'above')
    await plantConfig(above, hostileConfig(f, 'above', above))
    await fs.rm(path.join(f.branchPath, '.git'), { recursive: true, force: true })
    const upstream = await f.advanceGitHub('upstream.txt')

    await f.worker.syncGit()

    expect(await f.sentinelLines()).toEqual([])
    expect(await f.sha(f.remoteGitPath, `refs/heads/${BASE}`)).toBe(upstream)
    // The rebase loop's own .git check skips it; sharedRepoGit's explicit GIT_DIR covers a .git
    // removed after that check (shared-repo-git.test.ts).
    expect(consoleSpy).toHaveLogged(`Skipping ${BRANCH}: no .git directory`)
  })
})

describe('the state directory', () => {
  it('is refused at start when it is inside the shared workspace, and the refusal is recorded', async () => {
    const worker = new CmsWorker({
      workspacePath: f.workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: BASE,
      stateDirectory: path.join(f.workspacePath, 'worker-state'),
    })

    await expect(worker.start()).rejects.toThrow(
      /^The worker's state directory \(\S+\/workspace\/worker-state\) is inside its shared workspace/,
    )

    expect((await readStatus())?.lastFatalError?.message).toMatch(/inside its shared workspace/)
    await expect(
      fs.access(path.join(f.workspacePath, 'worker-state', 'github.git')),
    ).rejects.toThrow()
  })
})
