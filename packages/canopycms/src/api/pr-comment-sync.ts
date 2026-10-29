import type { ApiContext } from './types'
import type { BranchContext } from '../types'
import { clientOperatingStrategy } from '../operating-mode'
import { SYNC_PR_COMMENTS_ACTION, prBodyLockKey, renderPrCommentsBody } from '../pr-comments'
import { isApiTimeoutError, runWithDeadline } from './request-deadline'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import { withLock } from '../utils/async-mutex'
import { getErrorMessage } from '../utils/error'

/** A PR whose body blocks are still worth updating: one exists and is not merged or closed. */
function openPullRequest(context: BranchContext): number | undefined {
  const { pullRequestNumber, pullRequestState, status } = context.branch
  if (!pullRequestNumber || status === 'archived') return undefined
  return pullRequestState === 'merged' || pullRequestState === 'closed'
    ? undefined
    : pullRequestNumber
}

/** How long a request waits on GitHub for its PR body update, lock wait included. */
const DIRECT_SYNC_TIMEOUT_MS = 10_000

/**
 * Brings both of the PR body's blocks, the editor-comment summary and the review block, up to
 * date after a comment is added, replied to or resolved, or a review is given or withdrawn.
 * Best-effort: a failure is logged and never fails the request.
 *
 * Direct path: read the PR body, replace the blocks, write it back, within
 * DIRECT_SYNC_TIMEOUT_MS so a slow or rate-limited GitHub never holds the request.
 * GitHub's PR update takes no expected version; the per-branch lock (prBodyLockKey) only
 * orders this process's writers (docs/concurrency.md).
 *
 * Queued path: one pending task per branch and PR, rendered by the worker from comments.json
 * and branch.json when it runs, so a burst of changes costs one update. The change was written
 * before this call and a pending task reads those files only after it leaves pending, so its
 * run carries the change this call skipped; a task already running doesn't count, so a later
 * change gets a run of its own.
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
      await runWithDeadline(
        (signal) =>
          withLock(prBodyLockKey(context.branchRoot), async () => {
            const pr = await githubService.getPullRequest(prNumber, signal)
            if (pr.state !== 'open') return
            const body = await renderPrCommentsBody({
              branchRoot: context.branchRoot,
              branch,
              editorUrl,
              body: pr.body,
              warn: (message) => console.warn(`CanopyCMS: ${message}`),
            })
            if (body !== undefined)
              await githubService.updatePullRequest(prNumber, { body }, signal)
          }),
        { method: 'PATCH', path: `pull request #${prNumber}`, timeoutMs: DIRECT_SYNC_TIMEOUT_MS },
      )
      return
    }

    const taskDir = getTaskQueueDir(ctx.services.config)
    const pending = await listTasks(taskDir, 'pending', Number.MAX_SAFE_INTEGER)
    const queued = pending.some(
      (t) =>
        t.action === SYNC_PR_COMMENTS_ACTION &&
        t.payload.branch === branch &&
        t.payload.pullRequestNumber === prNumber,
    )
    if (queued) return
    await enqueueTask(taskDir, {
      action: SYNC_PR_COMMENTS_ACTION,
      payload: { branch, pullRequestNumber: prNumber, ...(editorUrl ? { editorUrl } : {}) },
    })
  } catch (err) {
    console.warn(
      `CanopyCMS: Could not update the editor comments or review state on PR #${prNumber} for ${branch}:`,
      isApiTimeoutError(err)
        ? `GitHub did not answer within ${DIRECT_SYNC_TIMEOUT_MS / 1000} s`
        : getErrorMessage(err),
    )
  }
}
