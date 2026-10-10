import type { ApiContext } from './types'
import type { BranchContext, SyncStatus } from '../types'
import type { TaskAction } from '../task-queue/cms-task-queue'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import { clientOperatingStrategy } from '../operating-mode'
import { getErrorMessage, sanitizeErrorMessage } from '../utils/error'
import { sanitizeBranchName } from '../paths/branch-name'
import { buildPrSection, mergePrSection, type SubmissionEditor } from '../submission-attribution'
import { isNoCommitsBetweenError, isRefAlreadyGoneError } from '../github-service'

/**
 * The caller uses this to update branch metadata.
 */
export interface GitHubSyncResult {
  prUrl?: string
  prNumber?: number
  syncStatus?: SyncStatus
  /** Client-safe reason a direct GitHub call failed, recorded as the branch's syncFailureReason. */
  syncFailureReason?: string
  /** GitHub refused the PR because the pushed branch has no commits its base lacks. */
  nothingToSubmit?: boolean
  /** The direct path, whose submit pushes to GitHub itself: the branch is there whatever the PR call did. */
  pushedToGitHub?: boolean
}

/** What the PR body records about a submit. */
export interface SubmissionRecord {
  submitter?: SubmissionEditor
  /** Every recorded editor of the branch; the PR body lists those other than the submitter. */
  editors?: readonly SubmissionEditor[]
  changedPaths: readonly string[]
  /** The submit's `submittedAt`, carried to the worker so its failure handling targets this submit. */
  submittedAt?: string
}

/**
 * Uses githubService directly if available, otherwise queues a task for the worker.
 *
 * The body is the canopycms PR section (submission-attribution.ts): an existing
 * PR keeps whatever a human wrote outside it.
 */
export async function syncSubmitPr(
  ctx: ApiContext,
  context: BranchContext,
  submission: SubmissionRecord,
): Promise<GitHubSyncResult> {
  const { githubService } = ctx.services
  const mode = ctx.services.config.mode
  const prTitle = context.branch.title || `Submit ${context.branch.name}`
  const prSection = buildPrSection({
    description: context.branch.description,
    submitter: submission.submitter,
    editors: submission.editors,
    changedPaths: submission.changedPaths,
  })
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
        // Read before writing: the update keeps the human text around the
        // canopycms section, and the same read says whether the PR is a draft.
        const pr = await githubService.getPullRequest(context.branch.pullRequestNumber)
        await githubService.updatePullRequest(context.branch.pullRequestNumber, {
          title: prTitle,
          body: mergePrSection(pr.body, prSection),
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
          pushedToGitHub: true,
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
          body: prSection,
          markReadyIfDraft: true,
          mergeSectionIntoBody: true,
        })
        return {
          prUrl: result.url,
          prNumber: result.number,
          syncStatus: 'synced',
          pushedToGitHub: true,
        }
      }
    } catch (err) {
      const message = getErrorMessage(err)
      console.error(`CanopyCMS: Failed to create/update PR for ${context.branch.name}:`, message)
      if (isNoCommitsBetweenError(err)) return { nothingToSubmit: true, pushedToGitHub: true }
      return {
        prUrl: context.branch.pullRequestUrl,
        prNumber: context.branch.pullRequestNumber,
        syncStatus: 'sync-failed',
        syncFailureReason: sanitizeErrorMessage(message),
        pushedToGitHub: true,
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
      body: prSection,
      mergeSectionIntoBody: true,
      baseBranch,
      pullRequestNumber: context.branch.pullRequestNumber,
      // A content submit is an explicit "ready for review" action: convert a
      // pre-existing draft PR to ready.
      markReadyIfDraft: true,
      submittedAt: submission.submittedAt,
    },
  })
}

/**
 * Used by withdraw and request-changes. Uses githubService directly if
 * available, otherwise queues a task.
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
 * Used by delete, after the local delete succeeded. Deletes the branch on GitHub when the CMS
 * put it there: a recorded PR number or `pushedToGitHubAt` stamp is the proof (a submit whose PR
 * GitHub refused pushed the branch but has no PR number). Without either, a same-named GitHub
 * branch is someone else's (the create-time collision check is best-effort) and is never touched.
 *
 * Returns a client-facing warning when the delete could not be done or queued; never throws.
 */
export async function syncDeleteRemoteBranch(
  ctx: ApiContext,
  context: BranchContext,
): Promise<string | undefined> {
  const { pullRequestNumber, pushedToGitHubAt } = context.branch
  if (!pullRequestNumber && !pushedToGitHubAt) return undefined

  const { githubService } = ctx.services
  const branch = context.branch.name

  if (githubService) {
    try {
      await githubService.deleteBranch(branch)
    } catch (err) {
      if (isRefAlreadyGoneError(err)) return undefined
      console.error(
        `CanopyCMS: Failed to delete GitHub branch for ${branch}:`,
        getErrorMessage(err),
      )
      return 'The branch could not be deleted on GitHub; delete it there by hand'
    }
    return undefined
  }

  const mode = ctx.services.config.mode
  if (!clientOperatingStrategy(mode).supportsPullRequests()) return undefined

  const result = await enqueueGitHubTask(ctx, context, {
    action: 'delete-remote-branch',
    payload: { branch, pullRequestNumber, pushedToGitHubAt },
  })
  return result.syncStatus === 'sync-failed'
    ? 'Deleting the branch on GitHub could not be queued; delete it there by hand'
    : undefined
}

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
