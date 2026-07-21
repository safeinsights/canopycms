import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GitHubService } from '../github-service'
import type { CanopyConfig } from '../config'
import { createMockApiContext, createMockBranchContext } from '../test-utils'

const baseConfig: CanopyConfig = {
  gitBotAuthorName: 'Canopy Bot',
  gitBotAuthorEmail: 'bot@example.com',
  defaultBaseBranch: 'main',
  mode: 'prod',
  deployedAs: 'server',
  contentRoot: 'content',
}

// ---------------------------------------------------------------------------
// GIT-H1: submit-for-merge must be idempotent on both the direct
// (githubService available) and worker (task-queue) paths, so a PR created
// on GitHub but whose number was never persisted to branch metadata (crash,
// failed write, killed process) does not permanently wedge the branch in
// 'sync-failed' on the next submit attempt.
// ---------------------------------------------------------------------------

const mockEnqueueTask = vi.fn()

vi.mock('../worker/task-queue', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}))

vi.mock('../worker/task-queue-config', () => ({
  getTaskQueueDir: vi.fn().mockReturnValue('/mock/.tasks'),
}))

import { syncSubmitPr } from './github-sync'

const makeGitHubService = (overrides: Record<string, unknown> = {}): GitHubService =>
  ({
    updatePullRequest: vi.fn().mockResolvedValue(undefined),
    getPullRequest: vi.fn().mockResolvedValue({
      number: 123,
      url: 'https://github.com/owner/repo/pull/123',
      state: 'open',
      merged: false,
      draft: false,
    }),
    convertToReady: vi.fn().mockResolvedValue(undefined),
    convertToDraft: vi.fn().mockResolvedValue(undefined),
    createOrUpdatePR: vi.fn().mockResolvedValue({
      number: 123,
      url: 'https://github.com/owner/repo/pull/123',
    }),
    // Intentionally NOT stubbed by default: the fix removes all calls to the
    // non-idempotent createPullRequest from the submit path. If it were
    // called (regression), the mock would throw "not a function" and the
    // catch block in syncSubmitPr would surface as syncStatus: 'sync-failed'.
    ...overrides,
  }) as unknown as GitHubService

beforeEach(() => {
  mockEnqueueTask.mockReset()
  mockEnqueueTask.mockResolvedValue('task-id-1')
})

describe('syncSubmitPr (GIT-H1)', () => {
  it('is a no-op in dev mode (no PR support), even with a githubService present', async () => {
    const ctx = createMockApiContext({
      services: { config: { ...baseConfig, mode: 'dev' }, githubService: makeGitHubService() },
    })
    const branchContext = createMockBranchContext({ branchName: 'feature/x' })

    const result = await syncSubmitPr(ctx, branchContext)

    expect(result).toEqual({})
  })

  describe('direct path (githubService available)', () => {
    it('updates the existing PR when pullRequestNumber is already known', async () => {
      const githubService = makeGitHubService()
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService },
      })
      const branchContext = createMockBranchContext({
        branchName: 'feature/x',
        pullRequestNumber: 123,
        pullRequestUrl: 'https://github.com/owner/repo/pull/123',
      })

      const result = await syncSubmitPr(ctx, branchContext)

      expect(githubService.updatePullRequest).toHaveBeenCalledWith(123, expect.any(Object))
      expect(githubService.createOrUpdatePR).not.toHaveBeenCalled()
      expect(result).toEqual({
        prUrl: 'https://github.com/owner/repo/pull/123',
        prNumber: 123,
        syncStatus: 'synced',
      })
    })

    it('converts an existing draft PR to ready when known PR is still a draft', async () => {
      const githubService = makeGitHubService({
        getPullRequest: vi.fn().mockResolvedValue({
          number: 123,
          url: 'https://github.com/owner/repo/pull/123',
          state: 'open',
          merged: false,
          draft: true,
        }),
      })
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService },
      })
      const branchContext = createMockBranchContext({
        branchName: 'feature/x',
        pullRequestNumber: 123,
      })

      await syncSubmitPr(ctx, branchContext)

      expect(githubService.convertToReady).toHaveBeenCalledWith(123)
    })

    it('creates a new PR via createOrUpdatePR on first submit (no pullRequestNumber yet)', async () => {
      const githubService = makeGitHubService()
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService },
      })
      const branchContext = createMockBranchContext({ branchName: 'feature/new' })

      const result = await syncSubmitPr(ctx, branchContext)

      expect(githubService.createOrUpdatePR).toHaveBeenCalledWith(
        expect.objectContaining({ head: 'feature/new' }),
      )
      expect(result).toEqual({
        prUrl: 'https://github.com/owner/repo/pull/123',
        prNumber: 123,
        syncStatus: 'synced',
      })
    })

    it('recovers instead of wedging when a PR already exists but its number was never recorded (crash recovery)', async () => {
      // Simulates the exact GIT-H1 failure mode: a prior submit created PR
      // #99 on GitHub, then the process died before branch metadata's
      // pullRequestNumber was persisted. context.branch.pullRequestNumber is
      // therefore still undefined on this re-submit. Before the fix, this
      // path called the non-idempotent createPullRequest, which 422s on a
      // duplicate head+base and permanently sets syncStatus: 'sync-failed'.
      const githubService = makeGitHubService({
        createOrUpdatePR: vi.fn().mockResolvedValue({
          number: 99,
          url: 'https://github.com/owner/repo/pull/99',
        }),
        getPullRequest: vi.fn().mockResolvedValue({
          number: 99,
          url: 'https://github.com/owner/repo/pull/99',
          state: 'open',
          merged: false,
          draft: false,
        }),
      })
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService },
      })
      const branchContext = createMockBranchContext({ branchName: 'feature/orphaned-pr' })
      expect(branchContext.branch.pullRequestNumber).toBeUndefined()

      const result = await syncSubmitPr(ctx, branchContext)

      expect(result.syncStatus).toBe('synced')
      expect(result.prNumber).toBe(99)
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/99')
    })

    it('sets sync-failed (not a throw) when the GitHub API call itself fails', async () => {
      const githubService = makeGitHubService({
        createOrUpdatePR: vi.fn().mockRejectedValue(new Error('network error')),
      })
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService },
      })
      const branchContext = createMockBranchContext({ branchName: 'feature/flaky' })

      const result = await syncSubmitPr(ctx, branchContext)

      expect(result.syncStatus).toBe('sync-failed')
    })
  })

  describe('worker path (no githubService — Lambda has no internet)', () => {
    it('enqueues the idempotent push-and-create-or-update-pr action on first submit', async () => {
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService: undefined },
      })
      const branchContext = createMockBranchContext({ branchName: 'feature/new' })

      const result = await syncSubmitPr(ctx, branchContext)

      expect(mockEnqueueTask).toHaveBeenCalledWith(
        '/mock/.tasks',
        expect.objectContaining({
          action: 'push-and-create-or-update-pr',
          payload: expect.objectContaining({ markReadyIfDraft: true }),
        }),
      )
      expect(result.syncStatus).toBe('pending-sync')
    })

    it('still enqueues push-and-create-or-update-pr (not push-and-update-pr) when pullRequestNumber is already known', async () => {
      // Regression guard: the pre-fix code branched to 'push-and-update-pr'
      // here, which calls a blind pulls.update. That's fine when the number
      // is accurate, but the point of the fix is a single idempotent action
      // used unconditionally so a stale/lost number can never route to the
      // non-idempotent create path.
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService: undefined },
      })
      const branchContext = createMockBranchContext({
        branchName: 'feature/existing',
        pullRequestNumber: 55,
        pullRequestUrl: 'https://github.com/owner/repo/pull/55',
      })

      await syncSubmitPr(ctx, branchContext)

      expect(mockEnqueueTask).toHaveBeenCalledWith(
        '/mock/.tasks',
        expect.objectContaining({
          action: 'push-and-create-or-update-pr',
          payload: expect.objectContaining({ markReadyIfDraft: true }),
        }),
      )
    })

    it('returns sync-failed if enqueueing itself fails', async () => {
      mockEnqueueTask.mockRejectedValue(new Error('disk full'))
      const ctx = createMockApiContext({
        services: { config: baseConfig, githubService: undefined },
      })
      const branchContext = createMockBranchContext({ branchName: 'feature/new' })

      const result = await syncSubmitPr(ctx, branchContext)

      expect(result).toEqual({ syncStatus: 'sync-failed' })
    })
  })
})
