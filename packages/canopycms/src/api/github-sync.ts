import type { ApiContext } from './types'
import type { BranchContext, SyncStatus } from '../types'
import type { TaskAction } from '../worker/task-queue'
import { enqueueTask } from '../worker/task-queue'
import { getTaskQueueDir } from '../worker/task-queue-config'
import { clientOperatingStrategy } from '../operating-mode'

/**
 * Result of a GitHub sync operation.
 * The caller uses this to update branch metadata.
 */
export interface GitHubSyncResult {
  prUrl?: string
  prNumber?: number
  syncStatus?: SyncStatus
}

/**
 * Submit a branch: create or update a PR.
 * Uses githubService directly if available, otherwise queues a task for the worker.
 */
export async function syncSubmitPr(
  ctx: ApiContext,
  context: BranchContext,
): Promise<GitHubSyncResult> {
  const { githubService } = ctx.services
  const mode = ctx.services.config.mode
  const prTitle = context.branch.title || `Submit ${context.branch.name}`
  const prBody = context.branch.description || ''

  if (!clientOperatingStrategy(mode).supportsPullRequests()) {
    return {}
  }

  // Direct path: githubService available (has internet)
  if (githubService) {
    try {
      if (context.branch.pullRequestNumber) {
        await githubService.updatePullRequest(context.branch.pullRequestNumber, {
          title: prTitle,
          body: prBody,
        })
        const pr = await githubService.getPullRequest(context.branch.pullRequestNumber)
        if (pr.draft) {
          await githubService.convertToReady(context.branch.pullRequestNumber)
        }
        return {
          prUrl: context.branch.pullRequestUrl,
          prNumber: context.branch.pullRequestNumber,
          syncStatus: 'synced',
        }
      } else {
        // GIT-H1: pullRequestNumber isn't recorded — this may be a genuine
        // first submit, or a prior submit that created a PR on GitHub but
        // crashed/failed before persisting its number. createOrUpdatePR is
        // idempotent: it looks up any existing open PR for this branch and
        // updates it instead of calling the non-idempotent create (which
        // 422s on a duplicate and would leave the branch wedged in
        // 'sync-failed' forever with no way to recover).
        const result = await githubService.createOrUpdatePR({
          head: context.branch.name,
          base: context.branch.baseBranch ?? ctx.services.config.defaultBaseBranch ?? 'main',
          title: prTitle,
          body: prBody,
        })
        const pr = await githubService.getPullRequest(result.number)
        if (pr.draft) {
          await githubService.convertToReady(result.number)
        }
        return {
          prUrl: result.url,
          prNumber: result.number,
          syncStatus: 'synced',
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to create/update PR for ${context.branch.name}:`, message)
      return {
        prUrl: context.branch.pullRequestUrl,
        prNumber: context.branch.pullRequestNumber,
        syncStatus: 'sync-failed',
      }
    }
  }

  // Async path: queue task for worker
  // GIT-H1: always use the idempotent create-or-update action rather than
  // branching on whether pullRequestNumber is known. If a prior submit
  // created the PR but the worker crashed before this branch's metadata
  // recorded the number, the next submit would otherwise re-enqueue
  // 'push-and-create-pr' and 422 on GitHub's duplicate-PR check, wedging the
  // branch in 'sync-failed' with no way to recover.
  return enqueueGitHubTask(ctx, context, {
    action: 'push-and-create-or-update-pr',
    payload: {
      branch: context.branch.name,
      title: prTitle,
      body: prBody,
      // Target the fork point recorded at branch creation when available
      baseBranch: context.branch.baseBranch ?? ctx.services.config.defaultBaseBranch ?? 'main',
      pullRequestNumber: context.branch.pullRequestNumber,
    },
  })
}

/**
 * Convert a PR to draft (used by withdraw and request-changes).
 * Uses githubService directly if available, otherwise queues a task.
 */
export async function syncConvertToDraft(ctx: ApiContext, context: BranchContext): Promise<void> {
  if (!context.branch.pullRequestNumber) return

  const { githubService } = ctx.services

  if (githubService) {
    try {
      await githubService.convertToDraft(context.branch.pullRequestNumber)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to convert PR to draft for ${context.branch.name}:`, message)
    }
    return
  }

  // Queue for worker
  const mode = ctx.services.config.mode
  if (clientOperatingStrategy(mode).supportsPullRequests()) {
    await enqueueGitHubTask(ctx, context, {
      action: 'convert-to-draft',
      payload: {
        branch: context.branch.name,
        pullRequestNumber: context.branch.pullRequestNumber,
      },
    })
  }
}

/**
 * Enqueue a GitHub task for the EC2 worker.
 */
async function enqueueGitHubTask(
  ctx: ApiContext,
  context: BranchContext,
  task: { action: TaskAction; payload: Record<string, unknown> },
): Promise<GitHubSyncResult> {
  const taskDir = getTaskQueueDir(ctx.services.config)

  try {
    await enqueueTask(taskDir, task)
    return {
      prUrl: context.branch.pullRequestUrl,
      prNumber: context.branch.pullRequestNumber,
      syncStatus: 'pending-sync',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`CanopyCMS: Failed to enqueue task for ${context.branch.name}:`, message)
    return { syncStatus: 'sync-failed' }
  }
}
