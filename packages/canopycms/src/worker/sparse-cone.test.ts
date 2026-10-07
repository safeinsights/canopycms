/**
 * The worker re-applying a changed sparse-checkout cone to provisioned content-branch clones
 * (sparse-cone.ts), against clones provisioned by the real create path in prod mode.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { recordConfiguredSparseCone } from '../branch-sparse'
import { BranchWorkspaceManager } from '../branch-workspace'
import { defineCanopyTestConfig } from '../config-test'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { CmsWorker } from './cms-worker'
import { reapplySparseCones } from './sparse-cone'

let tmpDir: string
let workspaceRoot: string
let baseRoot: string
let remoteUrl: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sparse-cone-'))
  workspaceRoot = path.join(tmpDir, 'ws')
  baseRoot = path.join(workspaceRoot, 'content-branches')
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)

  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(sourceDir, { recursive: true })
  const source = await initTestRepo(sourceDir)
  await source.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [file, body] of Object.entries({
    'permissions.json': '{}',
    'content/a.md': 'a',
    'cms/content/b.md': 'b',
    'src/app.ts': 'app',
  })) {
    await fs.mkdir(path.dirname(path.join(sourceDir, file)), { recursive: true })
    await fs.writeFile(path.join(sourceDir, file), body)
  }
  await source.add('.')
  await source.commit('initial')
  remoteUrl = path.join(workspaceRoot, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remoteUrl])
})

afterEach(async () => {
  consoleSpy.restore()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function config(contentRoot: string) {
  return defineCanopyTestConfig({
    mode: 'prod',
    defaultBaseBranch: 'main',
    defaultRemoteUrl: remoteUrl,
    deploymentName: 'test',
    schema: { collections: [] },
    contentRoot,
  })
}

async function provision(branchName: string, contentRoot: string): Promise<string> {
  const context = await new BranchWorkspaceManager(config(contentRoot)).openOrCreateBranch({
    branchName,
    mode: 'prod',
    createdBy: 'user-1',
  })
  return context.branchRoot
}

async function cone(root: string): Promise<string[] | null> {
  try {
    const listed = await simpleGit({ baseDir: root }).raw(['sparse-checkout', 'list'])
    return listed.trim().split('\n').sort()
  } catch {
    return null
  }
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

describe('reapplySparseCones', () => {
  it('moves a sparse clone to the recorded cone when the content root changes', async () => {
    const feat = await provision('feat', 'content')
    await recordConfiguredSparseCone(config('cms/content'))

    const report = await reapplySparseCones({ contentBranchesPath: baseRoot })

    expect(report.reapplied).toEqual(['feat'])
    expect(await cone(feat)).toEqual(['.canopy-meta', 'cms/content'])
    expect(await exists(path.join(feat, 'cms/content/b.md'))).toBe(true)
    expect(await exists(path.join(feat, 'content/a.md'))).toBe(false)
    expect(await exists(path.join(feat, 'src'))).toBe(false)
    expect(await exists(path.join(feat, '.canopy-meta/branch.json'))).toBe(true)
    expect((await simpleGit({ baseDir: feat }).status()).isClean()).toBe(true)
    expect(consoleSpy).toHaveLogged(
      /feat: sparse-checkout cone .canopy-meta,content -> .canopy-meta,cms\/content/,
    )
  })

  it('makes a sparse clone full when the content root becomes the repository root', async () => {
    const feat = await provision('feat', 'content')
    await recordConfiguredSparseCone(config('.'))

    await reapplySparseCones({ contentBranchesPath: baseRoot })

    expect(await cone(feat)).toBeNull()
    expect(await exists(path.join(feat, 'src/app.ts'))).toBe(true)
  })

  it('leaves full clones full and matching clones alone', async () => {
    const full = await provision('full', '.')
    const feat = await provision('feat', 'content')

    expect(await reapplySparseCones({ contentBranchesPath: baseRoot })).toEqual({
      reapplied: [],
      failed: [],
    })
    expect(await cone(full)).toBeNull()
    expect(await cone(feat)).toEqual(['.canopy-meta', 'content'])

    await recordConfiguredSparseCone(config('cms/content'))
    expect((await reapplySparseCones({ contentBranchesPath: baseRoot })).reapplied).toEqual([
      'feat',
    ])
    expect(await cone(full)).toBeNull()
  })

  it('does nothing until a cone is recorded', async () => {
    const feat = await provision('feat', 'content')
    await fs.rm(path.join(baseRoot, '.sparse-cone.json'))

    expect(await reapplySparseCones({ contentBranchesPath: baseRoot })).toEqual({
      reapplied: [],
      failed: [],
    })
    expect(await cone(feat)).toEqual(['.canopy-meta', 'content'])
  })

  it('skips a clone whose provisioning or content-write lock is held, and applies it later', async () => {
    const feat = await provision('feat', 'content')
    const other = await provision('other', 'content')
    await recordConfiguredSparseCone(config('cms/content'))
    const releaseProvisioning = await tryAcquireProvisioningLock(
      baseRoot,
      branchProvisioningLockName('feat'),
    )
    const releaseContent = await tryAcquireContentWriteLock(other)

    const first = await reapplySparseCones({ contentBranchesPath: baseRoot })
    await releaseProvisioning()
    await releaseContent()
    expect(first.reapplied).toEqual([])
    expect(await cone(feat)).toEqual(['.canopy-meta', 'content'])
    expect(await cone(other)).toEqual(['.canopy-meta', 'content'])

    const second = await reapplySparseCones({ contentBranchesPath: baseRoot })
    expect(second.reapplied.sort()).toEqual(['feat', 'other'])
  })

  it('skips a clone with a rebase in progress, and applies it once the rebase is gone', async () => {
    const feat = await provision('feat', 'content')
    await recordConfiguredSparseCone(config('cms/content'))
    const rebaseDir = path.join(feat, '.git', 'rebase-merge')
    await fs.mkdir(rebaseDir)

    expect(await reapplySparseCones({ contentBranchesPath: baseRoot })).toEqual({
      reapplied: [],
      failed: [],
    })
    expect(await cone(feat)).toEqual(['.canopy-meta', 'content'])

    await fs.rm(rebaseDir, { recursive: true })
    expect((await reapplySparseCones({ contentBranchesPath: baseRoot })).reapplied).toEqual([
      'feat',
    ])
  })

  it('skips a clone with an unpublished deletion, and applies it once the deletion is committed', async () => {
    const feat = await provision('feat', 'content')
    await recordConfiguredSparseCone(config('cms/content'))
    const git = simpleGit({ baseDir: feat })
    await fs.rm(path.join(feat, 'content/a.md'))

    const first = await reapplySparseCones({ contentBranchesPath: baseRoot })

    expect((await git.status()).deleted).toEqual(['content/a.md'])
    expect(first).toEqual({ reapplied: [], failed: [] })
    expect(await cone(feat)).toEqual(['.canopy-meta', 'content'])
    expect(consoleSpy).toHaveLogged(/feat: sparse-checkout cone waits for 1 unpublished deletion/)

    await git.raw(['rm', '-q', '--cached', 'content/a.md'])
    await git.commit('delete a')
    expect((await reapplySparseCones({ contentBranchesPath: baseRoot })).reapplied).toEqual([
      'feat',
    ])
    expect(await cone(feat)).toEqual(['.canopy-meta', 'cms/content'])
    expect((await git.raw(['ls-files', 'content'])).trim()).toBe('')
  })

  it('runs first in the sync cycle, even when the GitHub fetch then fails', async () => {
    const feat = await provision('feat', 'content')
    await recordConfiguredSparseCone(config('cms/content'))
    const worker = new CmsWorker({
      workspacePath: workspaceRoot,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () =>
      path.join(tmpDir, 'no-such-github.git')
    ;(worker as unknown as { running: boolean }).running = true

    await expect(worker.syncGit()).rejects.toThrow()

    expect(await cone(feat)).toEqual(['.canopy-meta', 'cms/content'])
  })
})
