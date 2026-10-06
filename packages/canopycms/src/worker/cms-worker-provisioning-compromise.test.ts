/**
 * The worker stops before its next destructive git step once a lock it holds is compromised.
 * The holds are real; only the compromise is forced, because a genuine one needs a refresh tick
 * (provisioned-workspace.test.ts covers detecting one).
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { initTestRepo, mockConsole } from '../test-utils'
import type { BaseRefreshReport } from '../types'
import { CmsWorker } from './cms-worker'

const lockState = vi.hoisted(() => ({ compromised: false, contentLockCompromised: false }))

vi.mock('./provisioned-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provisioned-workspace')>()
  return {
    ...actual,
    holdProvisionedWorkspace: async (
      ...args: Parameters<typeof actual.holdProvisionedWorkspace>
    ) => {
      const hold = await actual.holdProvisionedWorkspace(...args)
      return hold.kind === 'held' ? { ...hold, isCompromised: () => lockState.compromised } : hold
    },
  }
})

vi.mock('../utils/content-write-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/content-write-lock')>()
  return {
    ...actual,
    tryAcquireContentWriteLock: async (
      ...args: Parameters<typeof actual.tryAcquireContentWriteLock>
    ) => {
      const release = await actual.tryAcquireContentWriteLock(...args)
      if (lockState.contentLockCompromised) args[1]?.(new Error('simulated lock takeover'))
      return release
    },
  }
})

const makeWorker = (workspacePath: string) =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
  })

describe('worker under a compromised provisioning lock', () => {
  let tmpDir: string
  let contentBranchesPath: string
  let remoteGit: SimpleGit

  beforeEach(async () => {
    lockState.compromised = true
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-provisioning-compromise-'))
    contentBranchesPath = path.join(tmpDir, 'content-branches')
    const remotePath = path.join(tmpDir, 'remote.git')
    await fs.mkdir(remotePath)
    remoteGit = await initTestRepo(remotePath)
    await remoteGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(remotePath, 'a.txt'), 'a')
    await remoteGit.add(['.'])
    await remoteGit.commit('initial commit')
    await fs.mkdir(contentBranchesPath)
  })

  afterEach(async () => {
    lockState.compromised = false
    lockState.contentLockCompromised = false
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** A provisioned clone of the remote at content-branches/<dirName>, checked out as `branch`. */
  async function provisionedClone(dirName: string, branch: string): Promise<SimpleGit> {
    const clonePath = path.join(contentBranchesPath, dirName)
    await simpleGit().clone(path.join(tmpDir, 'remote.git'), clonePath)
    const git = simpleGit({ baseDir: clonePath, unsafe: { allowUnsafeEditor: true } })
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await git.addConfig('core.editor', 'true')
    if (branch !== 'main') await git.checkoutBranch(branch, 'origin/main')
    await getBranchMetadataFileManager(clonePath, contentBranchesPath).save({
      branch: { name: branch },
    })
    return git
  }

  async function advanceRemote(): Promise<void> {
    await fs.writeFile(path.join(tmpDir, 'remote.git', 'b.txt'), 'b')
    await remoteGit.add(['.'])
    await remoteGit.commit('advance main')
  }

  it('does not rebase a branch once the lock is lost', async () => {
    const branchGit = await provisionedClone('my-feature', 'my-feature')
    await advanceRemote()
    const headBefore = (await branchGit.revparse(['HEAD'])).trim()

    const consoleSpy = mockConsole()
    await (
      makeWorker(tmpDir) as unknown as { rebaseActiveBranches(): Promise<void> }
    ).rebaseActiveBranches()
    expect(consoleSpy).toHaveWarned(/Skipping my-feature: a lock it held was compromised/)
    consoleSpy.restore()

    expect((await branchGit.revparse(['HEAD'])).trim()).toBe(headBefore)
    const meta = await BranchMetadataFileManager.loadOnly(
      path.join(contentBranchesPath, 'my-feature'),
    )
    // A lost lock is a retry, not a failure an editor should see.
    expect(meta?.branch.rebaseFailure).toBeUndefined()
  })

  it('stops the base refresh before it touches the clone', async () => {
    await provisionedClone('main', 'main')
    await advanceRemote()

    const consoleSpy = mockConsole()
    const report = await (
      makeWorker(tmpDir) as unknown as {
        refreshBaseBranchWorkspace(): Promise<BaseRefreshReport>
      }
    ).refreshBaseBranchWorkspace()
    expect(consoleSpy).toHaveWarned(/provisioning lock lost mid-refresh, stopping/)
    consoleSpy.restore()

    expect(report.outcome).toBe('skipped-locked')
    await expect(fs.stat(path.join(contentBranchesPath, 'main', 'b.txt'))).rejects.toThrow()
  })

  it('stops the base refresh before it touches the clone when the content-write lock is lost', async () => {
    lockState.compromised = false
    lockState.contentLockCompromised = true
    await provisionedClone('main', 'main')
    await advanceRemote()

    const consoleSpy = mockConsole()
    const report = await (
      makeWorker(tmpDir) as unknown as {
        refreshBaseBranchWorkspace(): Promise<BaseRefreshReport>
      }
    ).refreshBaseBranchWorkspace()
    expect(consoleSpy).toHaveWarned(/content-write lock lost mid-refresh, stopping/)
    consoleSpy.restore()

    expect(report.outcome).toBe('skipped-locked')
    await expect(fs.stat(path.join(contentBranchesPath, 'main', 'b.txt'))).rejects.toThrow()
  })
})
