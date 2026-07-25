import type { ApiContext } from './types'
import type { BranchContext, SyncStatus } from '../types'
import type { TaskAction } from '../worker/task-queue'
import { enqueueTask } from '../worker/task-queue'
import { getTaskQueueDir } from '../worker/task-queue-config'
import { clientOperatingStrategy } from '../operating-mode'
import { getErrorMessage } from '../utils/error'
import { sanitizeBranchName } from '../paths/branch'

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
  // Target the fork point recorded at branch creation when available.
  const baseBranch = context.branch.baseBranch ?? ctx.services.config.defaultBaseBranch ?? 'main'

  if (!clientOperatingStrategy(mode).supportsPullRequests()) {
    return {}
  }

  // Defense-in-depth: refuse head===base even if the 'submittableBranch' guard
  // was somehow bypassed. GitHub would 422 this request anyway, but silently
  // -- without this check it surfaces only as a swallowed 'sync-failed' while
  // the branch is already marked 'submitted' (see services.ts submitBranch,
  // which pushes before this runs).
  if (sanitizeBranchName(context.branch.name) === sanitizeBranchName(baseBranch)) {
    console.error(
      `CanopyCMS: Refusing to open a PR for ${context.branch.name} against itself (head === base)`,
    )
    return { syncStatus: 'sync-failed' }
  }

  // Direct path: githubService available (has internet)
  if (githubService) {
    try {
      if (context.branch.pullRequestNumber) {
        await githubService.updatePullRequest(context.branch.pullRequestNumber, {
          title: prTitle,
          body: prBody,
        })
        // Best-effort draft->ready conversion. This branch updates a known
        // PR number directly (not through createOrUpdatePR), so it doesn't
        // get the shared helper's built-in markReadyIfDraft handling and
        // does its own here. Wrapped separately so a conversion failure
        // (e.g. a fine-grained token that can update PRs but lacks this
        // mutation's scope) can't sink the update that already succeeded —
        // consistent with createOrUpdatePullRequest's best-effort handling
        // in github-service.ts.
        try {
          const pr = await githubService.getPullRequest(context.branch.pullRequestNumber)
          if (pr.draft) {
            await githubService.convertToReady(context.branch.pullRequestNumber)
          }
        } catch (err) {
          console.warn(
            `CanopyCMS: Failed to convert PR #${context.branch.pullRequestNumber} to ready for review for ${context.branch.name} (the PR update itself succeeded; continuing):`,
            getErrorMessage(err),
          )
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
        //
        // markReadyIfDraft: true delegates draft->ready conversion to the
        // shared createOrUpdatePullRequest helper (github-service.ts), which
        // treats conversion as best-effort so a permissions-limited token
        // can't fail this submit.
        const result = await githubService.createOrUpdatePR({
          head: context.branch.name,
          base: baseBranch,
          title: prTitle,
          body: prBody,
          markReadyIfDraft: true,
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
      baseBranch,
      pullRequestNumber: context.branch.pullRequestNumber,
      // Content submits are an explicit "ready for review" action — convert
      // a pre-existing draft PR to ready, unlike the settings-branch sync
      // path (services.ts commitToSettingsBranch), which enqueues the same
      // action without this flag.
      markReadyIfDraft: true,
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
