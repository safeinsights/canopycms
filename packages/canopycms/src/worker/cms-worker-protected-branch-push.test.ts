/**
 * The worker never pushes the base branch or GitHub's default branch, whatever a task asks.
 * The task queue, `remote.git` and a branch's `historyRewrittenFrom` lease marker are all on the
 * shared workspace, which the CMS Lambda can write, so the refusal cannot depend on any of them.
 * "GitHub" here is a local bare repository; the worker's GitHub gateway points at it.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { initTestRepo, mockConsole, useLocalGitHubGateway } from '../test-utils'
import { CmsWorker } from './cms-worker'
import { GitHubMirror, RefusedPushError } from './github-mirror'

describe('the worker refuses to push protected branches', () => {
  let tmp: string
  let workspacePath: string
  let remoteGitPath: string
  let taskDir: string
  let github: string

  beforeEach(async () => {
    mockConsole()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-protected-push-'))
    workspacePath = path.join(tmp, 'workspace')
    remoteGitPath = path.join(workspacePath, 'remote.git')
    taskDir = path.join(workspacePath, '.tasks')
    github = path.join(tmp, 'github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', '--initial-branch', 'main', remoteGitPath])
    // GitHub's default branch is `main`, at commit A; remote.git holds the same.
    await simpleGit().raw(['init', '--bare', '--initial-branch', 'main', github])
    const seed = path.join(tmp, 'seed')
    await fs.mkdir(seed)
    const g = await initTestRepo(seed)
    await g.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(seed, 'site.txt'), 'base\n')
    await g.add(['.'])
    await g.commit('A: base')
    await g.raw(['push', github, 'main:main'])
    await g.raw(['push', remoteGitPath, 'main:main'])
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const githubLog = async (branch: string) =>
    (await simpleGit().raw(['--git-dir', github, 'log', '--format=%s', branch])).trim()

  /** Put a commit on `branch` in remote.git: a fast-forward of `main`, or a history of its own. */
  const commitInRemoteGit = async (branch: string, mode: 'on-main' | 'unrelated') => {
    const work = path.join(tmp, `work-${branch.replace(/\//g, '-')}-${mode}`)
    await simpleGit().clone(remoteGitPath, work, ['--branch', 'main'])
    const g = simpleGit({ baseDir: work })
    await g.addConfig('user.name', 'Test')
    await g.addConfig('user.email', 'test@canopycms.test')
    if (mode === 'unrelated') await g.raw(['checkout', '--orphan', 'tmp'])
    await fs.writeFile(path.join(work, 'site.txt'), `${branch} ${mode}\n`)
    await g.add(['.'])
    await g.commit(`B: ${branch} ${mode}`)
    await g.raw(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`])
  }

  const runQueue = async (baseBranch = 'main') => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'o',
      githubRepo: 'r',
      githubToken: 'fake-token',
      baseBranch,
    })
    useLocalGitHubGateway(worker, { remoteUrl: () => github })
    ;(worker as unknown as { running: boolean }).running = true
    await worker.processTaskQueue()
  }

  const queuePush = (branch: string) =>
    enqueueTask(taskDir, { action: 'push-branch', payload: { branch } })

  const failedErrors = async () => (await listTasks(taskDir, 'failed')).map((t) => t.error ?? '')

  it('refuses a fast-forward push of the base branch, permanently, and leaves GitHub untouched', async () => {
    await commitInRemoteGit('main', 'on-main')
    await queuePush('main')

    await runQueue()

    expect(await githubLog('main')).toBe('A: base')
    const errors = await failedErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Refusing to push "main" to GitHub/)
    expect(await listTasks(taskDir, 'pending')).toHaveLength(0)
  })

  it('refuses a leased (forced) push of the base branch, even with a lease marker on it', async () => {
    const githubTip = (await simpleGit().raw(['--git-dir', github, 'rev-parse', 'main'])).trim()
    await commitInRemoteGit('main', 'unrelated')
    // The marker the worker would lease on, written where it reads it.
    const basePath = path.join(workspacePath, 'content-branches', 'main')
    await fs.mkdir(basePath, { recursive: true })
    await BranchMetadataFileManager.get(
      basePath,
      path.join(workspacePath, 'content-branches'),
    ).save({
      branch: {
        name: 'main',
        status: 'editing',
        access: {},
        createdBy: 'test',
        historyRewrittenFrom: githubTip,
      },
    })
    await queuePush('main')

    await runQueue()

    expect(await githubLog('main')).toBe('A: base')
    expect((await failedErrors())[0]).toMatch(/Refusing to push "main" to GitHub/)
  })

  it("refuses GitHub's default branch even when the worker's base branch is something else", async () => {
    // A worker without CANOPYCMS_BASE_BRANCH takes its base from remote.git's HEAD, which the
    // Lambda can write; GitHub's own HEAD is what protects `main` then.
    await commitInRemoteGit('main', 'on-main')
    await queuePush('main')

    await runQueue('decoy')

    expect(await githubLog('main')).toBe('A: base')
    expect((await failedErrors())[0]).toMatch(/Refusing to push "main" to GitHub/)
  })

  it("refuses the base branch on its own, when it is not GitHub's default branch", async () => {
    // GitHub's default is `main`; this deployment's base is `production`.
    await commitInRemoteGit('production', 'on-main')
    await simpleGit().raw([
      '--git-dir',
      remoteGitPath,
      'push',
      '--force',
      github,
      'refs/heads/main:refs/heads/production',
    ])
    await queuePush('production')

    await runQueue('production')

    expect(await githubLog('production')).toBe('A: base')
    expect((await failedErrors())[0]).toMatch(/Refusing to push "production" to GitHub/)
  })

  it('refuses a name that is not a plain branch name before any git reads it', async () => {
    await commitInRemoteGit('main', 'on-main')
    await queuePush('x:main')

    await runQueue('decoy')

    expect(await githubLog('main')).toBe('A: base')
    const errors = await failedErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/is not a valid branch name/)
  })

  it('still pushes editor branches and the settings branch', async () => {
    await commitInRemoteGit('feature/x', 'on-main')
    await commitInRemoteGit('canopycms-settings-prod', 'unrelated')
    await queuePush('feature/x')
    await queuePush('canopycms-settings-prod')

    await runQueue()

    expect(await failedErrors()).toEqual([])
    expect(await githubLog('feature/x')).toBe('B: feature/x on-main\nA: base')
    expect(await githubLog('canopycms-settings-prod')).toBe('B: canopycms-settings-prod unrelated')
    expect(await githubLog('main')).toBe('A: base')
  })

  it('refuses at the mirror itself, for a caller that passes no protected branches and a lease', async () => {
    const githubTip = (await simpleGit().raw(['--git-dir', github, 'rev-parse', 'main'])).trim()
    await commitInRemoteGit('main', 'unrelated')
    const sha = (
      await simpleGit().raw(['--git-dir', remoteGitPath, 'rev-parse', 'refs/heads/main'])
    ).trim()
    const mirror = new GitHubMirror(path.join(tmp, 'state'), remoteGitPath, 30_000)

    await expect(
      mirror.exclusive((m) =>
        m.pushToGitHub(github, 'main', sha, { lease: githubTip, protectedBranches: [] }),
      ),
    ).rejects.toBeInstanceOf(RefusedPushError)
    expect(await githubLog('main')).toBe('A: base')
  })
})
