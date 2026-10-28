import type { ApiContext } from './types'
import type { BranchContext } from '../types'
import { clientOperatingStrategy } from '../operating-mode'
import { SYNC_PR_COMMENTS_ACTION, renderPrCommentsBody } from '../pr-comments'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import { withLock } from '../utils/async-mutex'
import { getErrorMessage } from '../utils/error'

/** A PR the comment summary is still worth updating on: one exists and is not merged or closed. */
function openPullRequest(context: BranchContext): number | undefined {
  const { pullRequestNumber, pullRequestState, status } = context.branch
  if (!pullRequestNumber || status === 'archived') return undefined
  return pullRequestState === 'merged' || pullRequestState === 'closed'
    ? undefined
    : pullRequestNumber
}

/**
 * Brings the PR's editor-comment summary up to date after a comment is added, replied to or
 * resolved. Best-effort: a failure is logged and never fails the comment request.
 *
 * Direct path: read the PR body, replace the block, write it back. GitHub's PR update takes
 * no expected version, so a human editing the body at that moment can lose one side; the
 * per-branch lock only orders writers in this process (docs/concurrency.md).
 *
 * Queued path: one pending task per branch, rendered by the worker from comments.json when it
 * runs, so a burst of comments costs one update. Skipping the enqueue loses nothing: the
 * comment was written before this call, and a task still pending now reads comments.json only
 * after it leaves pending. A task already running doesn't count, so a later change gets a run.
 */
export async function syncPrComments(ctx: ApiContext, context: BranchContext): Promise<void> {
  const prNumber = openPullRequest(context)
  if (prNumber === undefined) return
  if (!clientOperatingStrategy(ctx.services.config.mode).supportsPullRequests()) return
  const branch = context.branch.name
  const editorUrl = ctx.services.config.editorUrl ?? context.branch.editorUrl

  try {
    const { githubService } = ctx.services
    if (githubService) {
      await withLock(`pr-comments:${context.branchRoot}`, async () => {
        const pr = await githubService.getPullRequest(prNumber)
        if (pr.state !== 'open') return
        const body = await renderPrCommentsBody({
          branchRoot: context.branchRoot,
          branch,
          editorUrl,
          body: pr.body,
        })
        if (body !== undefined) await githubService.updatePullRequest(prNumber, { body })
      })
      return
    }

    const taskDir = getTaskQueueDir(ctx.services.config)
    const pending = await listTasks(taskDir, 'pending', Number.MAX_SAFE_INTEGER)
    if (pending.some((t) => t.action === SYNC_PR_COMMENTS_ACTION && t.payload.branch === branch)) {
      return
    }
    await enqueueTask(taskDir, {
      action: SYNC_PR_COMMENTS_ACTION,
      payload: { branch, pullRequestNumber: prNumber, ...(editorUrl ? { editorUrl } : {}) },
    })
  } catch (err) {
    console.warn(
      `CanopyCMS: Could not update the editor comments on PR #${prNumber} for ${branch}:`,
      getErrorMessage(err),
    )
  }
}
