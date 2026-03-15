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
        const result = await githubService.createPullRequest({
          branchName: context.branch.name,
          title: prTitle,
          body: prBody,
          draft: false,
        })
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
      }
    }
  }

  // Async path: queue task for worker
  return enqueueGitHubTask(ctx, context, {
    action: context.branch.pullRequestNumber ? 'push-and-update-pr' : 'push-and-create-pr',
    payload: {
      branch: context.branch.name,
      title: prTitle,
      body: prBody,
      baseBranch: ctx.services.config.defaultBaseBranch ?? 'main',
      pullRequestNumber: context.branch.pullRequestNumber,
    },
  })
}

/**
 * Convert a PR to draft (used by withdraw and request-changes).
 * Uses githubService directly if available, otherwise queues a task.
 */
export async function syncConvertToDraft(
  ctx: ApiContext,
  context: BranchContext,
): Promise<void> {
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
  if (!taskDir) return {}

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
