/**
 * Unit tests for CmsWorker.pollMergeState() (Gap 1: nothing else detects a
 * GitHub PR merge/close on a submitted/approved branch and reflects it back
 * into branch metadata).
 *
 * Also covers rebaseActiveBranches()'s dispatch to pollMergeState by status
 * (submitted/approved polled, archived never polled) -- that routing needs
 * no real git repo, since neither branch of the dispatch touches git for
 * those statuses (see cms-worker.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CmsWorker } from './cms-worker'
import {
  BranchMetadataFileManager,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from '../branch-metadata'

type MergePollInternals = {
  octokit: {
    pulls: {
      get: ReturnType<typeof vi.fn>
    }
  }
  pollMergeState(
    branchDir: string,
    branchPath: string,
    metaFile: BranchMetadataFile | null,
  ): Promise<void>
  rebaseActiveBranches(): Promise<void>
}

describe('CmsWorker.pollMergeState()', () => {
  let tmpDir: string
  let contentBranchesPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-merge-poll-test-'))
    contentBranchesPath = path.join(tmpDir, 'content-branches')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makePollWorker = () => {
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 2000,
    })
    const internals = worker as unknown as MergePollInternals
    internals.octokit = { pulls: { get: vi.fn() } }
    return { worker, internals }
  }

  /** Write branch metadata directly (no git repo needed for these tests). */
  const setupBranchMeta = async (
    branch: string,
    data: Record<string, unknown>,
  ): Promise<string> => {
    const branchPath = path.join(contentBranchesPath, branch)
    await fs.mkdir(branchPath, { recursive: true })
    const meta = getBranchMetadataFileManager(branchPath, contentBranchesPath)
    await meta.save({
      branch: {
        name: branch,
        status: 'submitted',
        access: {},
        createdBy: 'test',
        ...data,
      },
    })
    return branchPath
  }

  /** Same as setupBranchMeta, plus a plain `.git` directory so
   * rebaseActiveBranches() treats it as a branch workspace. */
  const setupGitLikeBranchDir = async (
    branch: string,
    data: Record<string, unknown>,
  ): Promise<string> => {
    const branchPath = await setupBranchMeta(branch, data)
    await fs.mkdir(path.join(branchPath, '.git'), { recursive: true })
    return branchPath
  }

  const readBranchMeta = (branchPath: string) =>
    BranchMetadataFileManager.loadOnly(branchPath).then((f) => f?.branch)

  it('archives the branch when the PR is merged, using GitHub merged_at and preserving PR number/url', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-merged', {
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/test-owner/test-repo/pull/42',
      pullRequestState: 'open',
    })
    internals.octokit.pulls.get.mockResolvedValue({
      data: { merged: true, state: 'closed', merged_at: '2024-03-15T10:30:00Z' },
    })

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await internals.pollMergeState('feature-merged', branchPath, metaFile)

    const meta = await readBranchMeta(branchPath)
    expect(meta?.status).toBe('archived')
    expect(meta?.pullRequestState).toBe('merged')
    // mergedAt reflects GitHub's actual merge time, not the poll time.
    expect(meta?.mergedAt).toBe(new Date('2024-03-15T10:30:00Z').toISOString())
    // PR number/url are not part of buildMergedBranchUpdate -- save()'s
    // merge must preserve them from the existing metadata.
    expect(meta?.pullRequestNumber).toBe(42)
    expect(meta?.pullRequestUrl).toBe('https://github.com/test-owner/test-repo/pull/42')
  })

  it('records closed state without archiving when the PR is closed but not merged', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-closed', {
      pullRequestNumber: 43,
      pullRequestState: 'open',
    })
    internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'closed' } })

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await internals.pollMergeState('feature-closed', branchPath, metaFile)

    const meta = await readBranchMeta(branchPath)
    expect(meta?.status).toBe('submitted')
    expect(meta?.pullRequestState).toBe('closed')
    expect(meta?.mergedAt).toBeUndefined()
  })

  it('records open state on the first poll of an open PR', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-open', { pullRequestNumber: 44 })
    internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'open' } })

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    expect(metaFile?.branch.pullRequestState).toBeUndefined()

    await internals.pollMergeState('feature-open', branchPath, metaFile)

    const meta = await readBranchMeta(branchPath)
    expect(meta?.pullRequestState).toBe('open')
  })

  it('does not save when the polled state already matches recorded state', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-nochange', {
      pullRequestNumber: 45,
      pullRequestState: 'open',
    })
    internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'open' } })

    const saveSpy = vi.spyOn(BranchMetadataFileManager.prototype, 'save')
    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await internals.pollMergeState('feature-nochange', branchPath, metaFile)
    expect(saveSpy).not.toHaveBeenCalled()
    saveSpy.mockRestore()
  })

  it('does not throw and leaves metadata untouched on an Octokit error', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-error', {
      pullRequestNumber: 46,
      pullRequestState: 'open',
    })
    internals.octokit.pulls.get.mockRejectedValue(new Error('network error'))

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await expect(
      internals.pollMergeState('feature-error', branchPath, metaFile),
    ).resolves.toBeUndefined()

    const meta = await readBranchMeta(branchPath)
    expect(meta?.pullRequestState).toBe('open')
    expect(meta?.status).toBe('submitted')
  })

  it('does not call GitHub when metadata has no pull request number', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-no-pr', {})

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await internals.pollMergeState('feature-no-pr', branchPath, metaFile)

    expect(internals.octokit.pulls.get).not.toHaveBeenCalled()
  })

  it('does not call GitHub when there is no metadata at all', async () => {
    const { internals } = makePollWorker()
    await internals.pollMergeState('feature-missing', path.join(contentBranchesPath, 'x'), null)

    expect(internals.octokit.pulls.get).not.toHaveBeenCalled()
  })

  it('records a reopen transition from closed back to open', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-reopened', {
      pullRequestNumber: 47,
      pullRequestState: 'closed',
    })
    internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'open' } })

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    expect(metaFile?.branch.status).toBe('submitted')
    expect(metaFile?.branch.pullRequestState).toBe('closed')

    await internals.pollMergeState('feature-reopened', branchPath, metaFile)

    const meta = await readBranchMeta(branchPath)
    expect(meta?.pullRequestState).toBe('open')
  })

  it('does not throw when the merged-branch metadata save fails, leaving the file unchanged', async () => {
    const { internals } = makePollWorker()
    const branchPath = await setupBranchMeta('feature-merge-save-fails', {
      pullRequestNumber: 49,
      pullRequestState: 'open',
    })
    internals.octokit.pulls.get.mockResolvedValue({ data: { merged: true, state: 'closed' } })

    const saveSpy = vi
      .spyOn(BranchMetadataFileManager.prototype, 'save')
      .mockRejectedValueOnce(new Error('simulated EFS write failure'))

    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    await expect(
      internals.pollMergeState('feature-merge-save-fails', branchPath, metaFile),
    ).resolves.toBeUndefined()
    saveSpy.mockRestore()

    const meta = await readBranchMeta(branchPath)
    expect(meta?.status).toBe('submitted')
    expect(meta?.pullRequestState).toBe('open')
    expect(meta?.mergedAt).toBeUndefined()
  })

  describe('dispatch from rebaseActiveBranches()', () => {
    it('polls approved branches for merge state', async () => {
      const { internals } = makePollWorker()
      await setupGitLikeBranchDir('feature-approved', {
        status: 'approved',
        pullRequestNumber: 50,
      })
      internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'open' } })

      await internals.rebaseActiveBranches()

      expect(internals.octokit.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 50 }),
      )
    })

    it('polls submitted branches for merge state (primary production case)', async () => {
      const { internals } = makePollWorker()
      await setupGitLikeBranchDir('feature-submitted', {
        status: 'submitted',
        pullRequestNumber: 52,
      })
      internals.octokit.pulls.get.mockResolvedValue({ data: { merged: false, state: 'open' } })

      await internals.rebaseActiveBranches()

      expect(internals.octokit.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 52 }),
      )
    })

    it('never polls archived branches', async () => {
      const { internals } = makePollWorker()
      await setupGitLikeBranchDir('feature-archived', {
        status: 'archived',
        pullRequestNumber: 51,
      })

      await internals.rebaseActiveBranches()

      expect(internals.octokit.pulls.get).not.toHaveBeenCalled()
    })
  })
})
