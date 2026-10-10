import fs from 'node:fs/promises'
import {
  completeTask,
  dequeueTask,
  failTask,
  recoverOrphanedTasks,
  releaseTask,
  retryTask,
} from '../task-queue/cms-task-queue'
import type { Task } from '../task-queue/cms-task-queue'
import {
  createOrUpdatePullRequest,
  isNoCommitsBetweenError,
  isRefAlreadyGoneError,
} from '../github-service'
import {
  BranchMetadataCorruptError,
  BranchMetadataFileManager,
  getBranchMetadataFileManager,
} from '../branch-metadata'
import { sanitizeBranchName, RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { getErrorMessage, redactCredentials } from '../utils/error'
import {
  isNonFastForwardRejection,
  isStaleLeaseRejection,
  workflowPushRefusalFile,
} from '../utils/git'
import { RefusedPushError, assertPlainBranchName } from './github-mirror'
import { clearHistoryRewrittenMarker, readPublishedSha } from './history-rewrite'
import { writeWorkerStatus } from '../task-queue/worker-status'
import { workerLog, workerLogError, workerLogWarn } from './log'
import { assertSharedRepoConfig } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

/**
 * The task-queue cluster: everything reachable from
 * `CmsWorker.processTaskQueue()`, the loop that drains tasks Lambda enqueued
 * because it has no internet. It owns the GitHub-facing side of the worker --
 * pushing branches, creating and updating PRs, recording the outcome on branch
 * metadata -- plus the permanent-vs-transient classification that decides
 * whether a failed task is retried or fails fast.
 *
 * It shares nothing with the git-sync cluster but the four resolved paths, the
 * Octokit client and the history-rewrite marker (history-rewrite.ts), and the
 * two loops run CONCURRENTLY: `scheduleLoop` drives this on `taskPollInterval`
 * (default 5s) and syncGit on `gitSyncInterval` (default 5min). So anything
 * here that reads branch metadata written by the rebase loop MUST re-read it
 * rather than trust a snapshot.
 */
export type TaskRunnerContext = Pick<
  WorkerContext,
  | 'githubOwner'
  | 'githubRepo'
  | 'baseBranch'
  | 'sanitizedBaseBranch'
  | 'taskDir'
  | 'remoteGitPath'
  | 'contentBranchesPath'
  | 'taskTimeoutMs'
  | 'maxTasksPerCycle'
  | 'maxRetries'
  | 'log'
  | 'octokit'
  | 'buildGitHubUrl'
  | 'githubMirror'
  | 'refreshGitHubCredential'
  | 'branchWorkspacePath'
  // Both are implemented in THIS module and are still reached through the
  // context: cms-worker.test.ts replaces each on the CmsWorker instance, so a
  // direct module-level call silently bypasses the stub. See WorkerContext.
  | 'executeTask'
  | 'pushBranchToGitHub'
  | 'isRunning'
  | 'isDraining'
  | 'shutdownSignal'
  | 'ensureStatusReport'
>

/**
 * An error inherent to the task itself (malformed payload, unknown action):
 * retrying can never succeed, so the task should fail fast instead of
 * burning its retry budget.
 */
export class PermanentTaskError extends Error {}

/**
 * The attempt was cut off by a draining `stop()` reaching its deadline, not by
 * anything wrong with the task: it goes back to pending with no retry spent.
 */
class TaskAbortedForShutdownError extends Error {}

/**
 * GitHub refused a submit's PR because the pushed branch has no commits its base lacks: the API's
 * own check found changes against an older base, or could not run. The failure handler returns
 * the branch to editing if it is still in that submit, since nothing is under review.
 */
class NothingToSubmitTaskError extends PermanentTaskError {}

/**
 * Classify a task failure as permanent (fail fast) or transient (retry).
 *
 * Transient — worth retrying with backoff:
 * - network errors / anything without an HTTP status, git failures included:
 *   most push/fetch failures are connectivity or contention, and the retry
 *   budget bounds the pathological cases;
 * - HTTP 408 and 429;
 * - HTTP 403 carrying a rate-limit signal (`isRateLimitSignal403`): GitHub
 *   returns 403, not 429, for both primary and secondary rate limits. The
 *   throttling plugin (github-service.ts's createCanopyOctokit) retries short
 *   waits, and this carve-out is the safety net for waits it gives up on and
 *   errors it never sees — without it a rate-limited
 *   push-and-create-or-update-pr task fails permanently and wedges the branch;
 * - HTTP 5xx.
 *
 * Permanent — retrying the identical request cannot succeed:
 * - PermanentTaskError (malformed payload, unknown action);
 * - other HTTP 4xx (401/404/422): the request itself is bad;
 * - plain HTTP 403 with no rate-limit signal: a real permission denial.
 */
export function isPermanentTaskFailure(err: unknown): boolean {
  if (err instanceof PermanentTaskError) return true
  const status = getHttpStatus(err)
  if (status === null) return false
  if (status === 408 || status === 429) return false
  if (status === 403 && isRateLimitSignal403(err)) return false
  return status >= 400 && status < 500
}

/** Extract an HTTP status from an error, if present (Octokit RequestError shape). */
function getHttpStatus(err: unknown): number | null {
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

/** Narrow an unknown value to a response-headers record, if present (Octokit lowercases header names). */
function getResponseHeaders(err: unknown): Record<string, unknown> | null {
  if (typeof err !== 'object' || err === null || !('response' in err)) return null
  const response = (err as { response: unknown }).response
  if (typeof response !== 'object' || response === null || !('headers' in response)) return null
  const headers = (response as { headers: unknown }).headers
  if (typeof headers !== 'object' || headers === null) return null
  return headers as Record<string, unknown>
}

/**
 * Whether a 403 is a GitHub rate-limit response rather than a plain permission
 * denial. GitHub signals rate limiting on 403s three ways: the primary limit
 * zeroes `x-ratelimit-remaining`, secondary limits often carry `retry-after`,
 * and both produce a message containing "rate limit".
 */
function isRateLimitSignal403(err: unknown): boolean {
  const headers = getResponseHeaders(err)
  if (headers) {
    if (headers['x-ratelimit-remaining'] === '0') return true
    if (typeof headers['retry-after'] === 'string' && headers['retry-after'].length > 0) return true
  }
  if (err instanceof Error && /rate limit/i.test(err.message)) return true
  return false
}

// Payload validation helpers — fail fast with clear errors instead of silent `as` casts

/**
 * Whether `branch` carries the reserved settings-branch prefix. Matching on the prefix
 * alone, never on a configured name, is what keeps a content branch out: branch creation
 * rejects the prefix, while a configured name the worker and API disagree on could be a
 * content branch's.
 */
function isSettingsBranch(branch: string) {
  return branch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const val = payload[key]
  if (typeof val !== 'string')
    throw new PermanentTaskError(`Task payload missing required string field: ${key}`)
  return val
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const val = payload[key]
  if (typeof val !== 'number')
    throw new PermanentTaskError(`Task payload missing required number field: ${key}`)
  return val
}

function optionalString(payload: Record<string, unknown>, key: string, fallback: string): string {
  const val = payload[key]
  return typeof val === 'string' ? val : fallback
}

/**
 * Staleness threshold for recoverOrphanedTasks, derived from the configured
 * task timeout rather than fixed. The safety argument for running recovery on
 * every poll cycle is "no legitimately in-flight task can be this old, because
 * executeTaskWithTimeout bounds every attempt by taskTimeoutMs" -- true only
 * while this threshold scales with taskTimeoutMs. The 5-minute floor covers a
 * replacement instance's boot window.
 */
export function orphanRecoveryMaxAgeMs(ctx: Pick<TaskRunnerContext, 'taskTimeoutMs'>): number {
  return Math.max(5 * 60_000, ctx.taskTimeoutMs * 2)
}

/**
 * Process queued tasks from Lambda, up to maxTasksPerCycle per invocation.
 */
export async function processTaskQueue(ctx: TaskRunnerContext): Promise<void> {
  if (!ctx.isRunning()) return

  // Recover tasks orphaned in processing/ on EVERY cycle, not only at boot
  // (start()'s call). Instance replacement is routine -- CanopyCmsService's
  // worker ASG rolls on every `cdk deploy` -- and a replacement's user-data
  // takes roughly 2-4 minutes, well under the staleness threshold, so a
  // boot-only call sees the just-orphaned file as "too fresh", skips it, and
  // nothing rescans: the task and its branch's syncStatus wedge forever.
  //
  // Safe to run this often because executeTaskWithTimeout() guarantees every
  // task THIS process dequeues is completed, failed or retried (all three
  // remove the processing/ file) within taskTimeoutMs -- which is why the
  // threshold is derived from taskTimeoutMs (orphanRecoveryMaxAgeMs) rather
  // than fixed. A fixed 5 minutes would steal the worker's own in-flight task
  // back to pending whenever an adopter configured a longer timeout.
  const recovered = await recoverOrphanedTasks(ctx.taskDir, orphanRecoveryMaxAgeMs(ctx), ctx.log)
  if (recovered > 0) {
    workerLog(`Recovered ${recovered} orphaned task(s)`)
  }

  let processed = 0
  let task: Task | null
  // Checked before every claim: a draining worker finishes the task it holds
  // and claims no other.
  while (
    processed < ctx.maxTasksPerCycle &&
    !ctx.isDraining() &&
    (task = await dequeueTask(ctx.taskDir, ctx.log)) !== null
  ) {
    try {
      const result = await executeTaskWithTimeout(ctx, task)
      await completeTask(ctx.taskDir, task.id, result, ctx.log)
      await updateBranchMetadata(ctx, task, result)
    } catch (err) {
      if (err instanceof TaskAbortedForShutdownError) {
        // The next worker runs it again from the start, exactly as a retry
        // after a timed-out attempt does.
        await releaseTask(ctx.taskDir, task.id, ctx.log)
        workerLogWarn(
          `Drain deadline hit, aborted task ${task.id} (${task.action}); released to pending for the next worker`,
        )
        break
      }
      const message = getErrorMessage(err)
      workerLogError(`Task ${task.id} (${task.action}) failed:`, message)

      // [REDACT] task.error is persisted (pending/failed task JSON) and served
      // to the browser by the admin panel's Tasks tab -- a push failure's
      // message can embed the bot token via buildGitHubUrl(). Console output
      // above stays raw (journald/CloudWatch is trusted).
      const persistedMessage = redactCredentials(message)

      // DEP-L1: only transient failures are worth retrying; a permanent one
      // would burn the retry budget on an identical doomed request.
      const permanent = isPermanentTaskFailure(err)
      const retryCount = task.retryCount ?? 0
      const maxRetries = task.maxRetries ?? ctx.maxRetries
      if (!permanent && retryCount < maxRetries) {
        await retryTask(ctx.taskDir, task.id, persistedMessage, ctx.log)
        workerLog(`  Will retry (attempt ${retryCount + 1}/${maxRetries})`)
      } else {
        await failTask(ctx.taskDir, task.id, persistedMessage, ctx.log)
        await updateBranchMetadataOnFailure(ctx, task, persistedMessage, {
          unlock: err instanceof NothingToSubmitTaskError,
        })
        workerLogError(
          permanent
            ? '  Permanently failed (non-retryable error)'
            : `  Permanently failed after ${maxRetries} retries`,
        )
      }

      // The credential may have rotated, and the next retry resolves
      // buildGitHubUrl() afresh to pick a new token up. Without this a push
      // meeting a revoked token spends its whole retry budget (5s/10s/20s
      // backoff) waiting on the git-sync loop's refresh up to 5 minutes away,
      // and fails permanently while the working token sits in the secret store.
      //
      // Ungated, and AFTER the outcome is recorded rather than before: the task
      // is safely in pending/ or failed/ while a network read runs, and that
      // read is bounded and never throws. See CmsWorker.refreshGitHubCredential.
      await ctx.refreshGitHubCredential()
    }
    processed++
  }

  // Only stamp/write when work actually happened this poll: otherwise every
  // idle 5s poll would hit worker-status.json, an EFS write treadmill for no
  // signal, since liveness is already covered by the lock heartbeat (see
  // api/admin.ts's classifyWorkerLiveness).
  if (processed > 0) {
    const report = ctx.ensureStatusReport()
    report.lastTaskCycleAt = new Date().toISOString()
    await writeWorkerStatus(ctx.taskDir, report).catch((writeErr) =>
      workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
    )
  }
}

/**
 * Execute a task bounded by taskTimeoutMs (DEP-H1) and by the worker's
 * shutdown signal. Two layers:
 * - an AbortSignal cancels Octokit HTTP calls and kills the push's git process
 *   (pushBranchToGitHub passes it to simple-git's `abort`);
 * - a Promise.race rejects when either fires, so work that cannot observe the
 *   signal (a hung `ctx.buildGitHubUrl()` in pushBranchToGitHub) still ends
 *   the attempt and the worker moves on instead of stalling forever.
 *
 * A raced-out credential resolution is not cancelled. On the App path the mint
 * is separately bounded by gitTokenMintTimeoutMs, and git-sync.ts's two
 * resolutions run on the sync loop and are not bounded by taskTimeoutMs at all.
 */
async function executeTaskWithTimeout(
  ctx: TaskRunnerContext,
  task: Task,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.taskTimeoutMs)
  const shutdown = ctx.shutdownSignal()
  const signal = AbortSignal.any([controller.signal, shutdown])
  try {
    const work = ctx.executeTask(task, signal)
    // If the abort wins the race, the losing promise must not surface an
    // unhandled rejection when it eventually settles.
    work.catch(() => {})
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(
          shutdown.aborted
            ? new TaskAbortedForShutdownError(`Task aborted: the worker is shutting down`)
            : new Error(`Task timed out after ${ctx.taskTimeoutMs}ms`),
        )
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([work, aborted])
  } finally {
    clearTimeout(timer)
  }
}

export async function executeTask(
  ctx: TaskRunnerContext,
  task: Task,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { action, payload } = task

  switch (action) {
    case 'push-branch': {
      const branch = requireString(payload, 'branch')
      await ctx.pushBranchToGitHub(branch, signal)
      return { pushed: true }
    }
    case 'push-and-create-pr': {
      const branch = requireString(payload, 'branch')
      await ctx.pushBranchToGitHub(branch, signal)
      const pr = await ctx.octokit().pulls.create({
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        head: branch,
        base: optionalString(payload, 'baseBranch', ctx.baseBranch),
        title: optionalString(payload, 'title', `Submit ${branch}`),
        body: optionalString(payload, 'body', ''),
        request: { signal },
      })
      workerLog(`Created PR #${pr.data.number} for ${branch}`)
      return { prUrl: pr.data.html_url, prNumber: pr.data.number }
    }
    case 'push-and-update-pr': {
      const branch = requireString(payload, 'branch')
      const prNumber = requireNumber(payload, 'pullRequestNumber')
      await ctx.pushBranchToGitHub(branch, signal)
      await ctx.octokit().pulls.update({
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        pull_number: prNumber,
        title: optionalString(payload, 'title', `Submit ${branch}`),
        body: optionalString(payload, 'body', ''),
        request: { signal },
      })
      workerLog(`Updated PR #${prNumber} for ${branch}`)
      return { prNumber }
    }
    case 'push-and-create-or-update-pr': {
      // GIT-H1: idempotent create-or-update, so a retry after a crash (the task
      // completed on GitHub but branch metadata never recorded the PR number)
      // recovers the existing PR instead of hitting the 422 a blind
      // `pulls.create` throws on a duplicate head+base. Delegates to the shared
      // helper GitHubService's direct-API path also uses, so the
      // list->tiebreak->update/create logic and the draft->ready conversion
      // live in one place.
      const branch = requireString(payload, 'branch')
      const base = optionalString(payload, 'baseBranch', ctx.baseBranch)
      // Defense-in-depth: refuse head===base even if the 'submittableBranch'
      // API guard and the syncSubmitPr backstop were both bypassed.
      // PermanentTaskError, not a plain Error, so it fails immediately --
      // retrying can never make the branch not be the base branch.
      if (sanitizeBranchName(branch) === ctx.sanitizedBaseBranch) {
        throw new PermanentTaskError(
          `Refusing to push-and-create-or-update-pr for "${branch}": it is the base branch -- submitting the base branch is never valid`,
        )
      }
      // The settings branch is an orphan with no history in common with the
      // base, so GitHub 422s a PR for it: push it and stop.
      if (isSettingsBranch(branch)) {
        await ctx.pushBranchToGitHub(branch, signal)
        workerLog(`Pushed settings branch ${branch}; settings branches never get a PR`)
        return { pushed: true }
      }
      await ctx.pushBranchToGitHub(branch, signal)

      let result: Awaited<ReturnType<typeof createOrUpdatePullRequest>>
      try {
        result = await createOrUpdatePullRequest({
          octokit: ctx.octokit(),
          owner: ctx.githubOwner,
          repo: ctx.githubRepo,
          head: branch,
          base,
          title: optionalString(payload, 'title', `Submit ${branch}`),
          body: optionalString(payload, 'body', ''),
          // Content submits (api/github-sync.ts) set both.
          markReadyIfDraft: payload.markReadyIfDraft === true,
          mergeSectionIntoBody: payload.mergeSectionIntoBody === true,
          signal,
        })
      } catch (err) {
        if (!isNoCommitsBetweenError(err)) throw err
        throw new NothingToSubmitTaskError(
          `Nothing was submitted: "${branch}" has no changes compared with "${base}", so GitHub ` +
            'opened no pull request.',
        )
      }
      workerLog(
        result.created
          ? `Created PR #${result.number} for ${branch}`
          : `Updated existing PR #${result.number} for ${branch}`,
      )
      return { prUrl: result.url, prNumber: result.number }
    }
    case 'convert-to-draft': {
      const draftPrNumber = requireNumber(payload, 'pullRequestNumber')
      // GitHub REST API doesn't support converting to draft directly.
      // Use the GraphQL API via Octokit.
      const { data: pr } = await ctx.octokit().pulls.get({
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        pull_number: draftPrNumber,
        request: { signal },
      })
      await ctx
        .octokit()
        .graphql(
          `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          { id: pr.node_id, request: { signal } },
        )
      workerLog(`Converted PR #${draftPrNumber} to draft`)
      return { prNumber: draftPrNumber, draft: true }
    }
    case 'close-pr': {
      const closePrNumber = requireNumber(payload, 'pullRequestNumber')
      await ctx.octokit().pulls.update({
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        pull_number: closePrNumber,
        state: 'closed',
        request: { signal },
      })
      return { closed: true }
    }
    case 'delete-remote-branch': {
      const branch = requireString(payload, 'branch')
      // Defense-in-depth behind the delete handler's own refusal.
      if (sanitizeBranchName(branch) === ctx.sanitizedBaseBranch || isSettingsBranch(branch)) {
        throw new PermanentTaskError(
          `Refusing to delete "${branch}" on GitHub: the base and settings branches are never deleted`,
        )
      }
      // A branch that reused the name after this task was queued (a requeued task can run long
      // after) owns the GitHub branch once it recorded a different PR or GitHub push. Without
      // either, the ref is taken to be the deleted branch's. Corrupt metadata, which includes a
      // file with no branch record, keeps the GitHub branch; other read errors retry.
      const deletedPr =
        typeof payload.pullRequestNumber === 'number' ? payload.pullRequestNumber : undefined
      const deletedPushedAt =
        typeof payload.pushedToGitHubAt === 'string' ? payload.pushedToGitHubAt : undefined
      let live: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>> = null
      let unreadable = false
      try {
        live = await BranchMetadataFileManager.loadOnly(ctx.branchWorkspacePath(branch))
      } catch (err) {
        if (!(err instanceof BranchMetadataCorruptError)) throw err
        unreadable = true
      }
      if (unreadable) {
        workerLog(
          `Not deleting GitHub branch ${branch}: the branch now under that name is unreadable`,
        )
        return { deleted: false, skipped: 'metadata-unreadable' }
      }
      const livePr = live?.branch.pullRequestNumber
      if (livePr !== undefined && livePr !== deletedPr) {
        workerLog(`Not deleting GitHub branch ${branch}: a newer branch's PR #${livePr} uses it`)
        return { deleted: false, skipped: 'name-reused' }
      }
      const livePushedAt = live?.branch.pushedToGitHubAt
      if (livePushedAt !== undefined && livePushedAt !== deletedPushedAt) {
        workerLog(`Not deleting GitHub branch ${branch}: a newer branch pushed under that name`)
        return { deleted: false, skipped: 'name-reused' }
      }
      try {
        await ctx.octokit().git.deleteRef({
          owner: ctx.githubOwner,
          repo: ctx.githubRepo,
          ref: `heads/${branch}`,
          request: { signal },
        })
      } catch (err) {
        // Already gone is the outcome this task wants; failing it would only park it in failed/.
        if (!isRefAlreadyGoneError(err)) throw err
        workerLog(`GitHub branch ${branch} was already deleted`)
        return { deleted: false, alreadyGone: true }
      }
      workerLog(`Deleted GitHub branch ${branch}`)
      return { deleted: true }
    }
    default:
      throw new PermanentTaskError(`Unknown task action: ${action}`)
  }
}

/**
 * The branch whose metadata records a task's outcome, or null when none does. A
 * delete-remote-branch task names a branch already deleted here, so a workspace under that
 * name is leftover or a newer branch's that reused the name.
 */
function metadataBranchOf(task: Task): string | null {
  if (task.action === 'delete-remote-branch') return null
  return typeof task.payload.branch === 'string' ? task.payload.branch : null
}

/**
 * Update branch metadata after successful task completion.
 */
export async function updateBranchMetadata(
  ctx: TaskRunnerContext,
  task: Task,
  result: Record<string, unknown>,
): Promise<void> {
  const branch = metadataBranchOf(task)
  if (!branch) return

  const branchPath = ctx.branchWorkspacePath(branch)
  try {
    await fs.stat(branchPath)
  } catch {
    return // Branch directory doesn't exist
  }

  try {
    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    const updates: Record<string, unknown> = {
      name: branch,
      syncStatus: 'synced',
      // save()'s merge only overwrites keys present in this update, so a prior
      // syncFailureReason would survive this successful sync forever unless
      // cleared explicitly (same pattern as rebaseFailure elsewhere).
      syncFailureReason: undefined,
    }
    if (result.prUrl) updates.pullRequestUrl = result.prUrl
    if (result.prNumber) {
      updates.pullRequestNumber = result.prNumber
      // As soon as the PR exists the field reads 'open', rather than staying
      // absent until the next poll cycle observes it. Exception: the git-sync
      // loop may have archived this branch (PR merged/closed) while the task
      // was in flight, and a late completion must not downgrade that terminal
      // state back to 'open'.
      const current = await BranchMetadataFileManager.loadOnly(branchPath)
      const terminal =
        current?.branch.status === 'archived' ||
        current?.branch.pullRequestState === 'merged' ||
        current?.branch.pullRequestState === 'closed'
      if (!terminal) {
        updates.pullRequestState = 'open'
      }
    }
    await meta.save({ branch: updates })
  } catch (err) {
    workerLogError(
      `Failed to update metadata for ${branch}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Update branch metadata after permanent task failure. `error` is already
 * redacted by the caller (see [REDACT] in processTaskQueue) and is recorded as
 * syncFailureReason so the editor can show WHY, not just that it failed.
 *
 * `unlock` also returns the branch to 'editing', but only while it is still in
 * the submit this task carries (its `submittedAt`), 'submitted' with no PR: a
 * withdraw, a newer submit, or a review decision that landed meanwhile is left
 * alone.
 */
async function updateBranchMetadataOnFailure(
  ctx: TaskRunnerContext,
  task: Task,
  error: string,
  options: { unlock: boolean },
): Promise<void> {
  const branch = metadataBranchOf(task)
  if (!branch) return

  const branchPath = ctx.branchWorkspacePath(branch)
  try {
    await fs.stat(branchPath)
  } catch {
    return
  }

  try {
    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    const failed = { name: branch, syncStatus: 'sync-failed', syncFailureReason: error } as const
    const submittedAt = task.payload.submittedAt
    const unlocked =
      options.unlock &&
      typeof submittedAt === 'string' &&
      (await meta.saveIf(
        {
          branch: {
            ...failed,
            status: 'editing',
            syncFailureReason: `${error} The branch is unlocked for editing; save a change, then submit again.`,
          },
        },
        (existing) =>
          existing?.branch.status === 'submitted' &&
          existing.branch.pullRequestNumber === undefined &&
          existing.branch.submittedAt === submittedAt,
      )) !== null
    if (!unlocked) await meta.save({ branch: failed })
  } catch (err) {
    workerLogError(
      `Failed to update failure metadata for ${branch}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Fail fast when GitHub refused the push for adding workflow content it does not already hold: the
 * worker's credential deliberately lacks the workflows permission, so the identical push can never
 * succeed. Rebasing onto a base that changed a workflow does not trigger it; a workflow edit made
 * outside the editor, auto-merged by the rebase with a base change to the same file, does.
 */
function throwIfWorkflowRefusal(branch: string, message: string): void {
  const file = workflowPushRefusalFile(message)
  if (file === null) return
  throw new PermanentTaskError(
    `Push refused for branch "${branch}": it would put a version of ${file} on GitHub that ` +
      `GitHub does not already have, and this deployment's GitHub credential is deliberately not ` +
      `allowed to change workflow files. Such a change usually comes from outside the editor, ` +
      `such as a direct push to this branch. Nothing was pushed, and ` +
      `retrying will not help until a developer with permission to change workflow files ` +
      `resolves it on GitHub.`,
  )
}

export async function pushBranchToGitHub(
  ctx: TaskRunnerContext,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  // The credential's only repository is the worker's private mirror (worker/github-mirror.ts);
  // remote.git's config is Lambda-writable. The pushes below send exactly `outgoingSha`, the
  // commit remote.git held when it was read, so what the marker logic at the end compares is
  // what GitHub received.
  await assertSharedRepoConfig(ctx.remoteGitPath, 'bare')
  // Before `branch` reaches any git: `readPublishedSha` below would read a `<rev>:<path>` form as a
  // tree lookup in remote.git. A refusal is permanent; a failure to run git is retried.
  try {
    await assertPlainBranchName(branch)
  } catch (err) {
    if (err instanceof RefusedPushError) throw new PermanentTaskError(err.message)
    throw err
  }

  // Resolve the tokenized URL ONCE, here: all three pushes below use this
  // const and none calls ctx.buildGitHubUrl() again. A correctness
  // requirement, not tidiness, since resolution is async: the retry push sits
  // INSIDE the stale-lease catch, and a resolution that threw there would
  // replace the push error being classified, so neither isStaleLeaseRejection
  // nor isNonFastForwardRejection would run and a genuinely diverged branch
  // would be retried instead of raising PermanentTaskError. It also means every
  // push provably carries the same credential.
  const githubUrl = await ctx.buildGitHubUrl()

  // [SYNC-H1] If the rebase loop rewrote this branch's already-published
  // history, GitHub still holds the commit it replaced, so an ordinary
  // push is non-fast-forward forever. Push under a lease keyed to exactly
  // that commit: it moves GitHub off the commit we rewrote away, and
  // refuses in every other case (including a commit someone else pushed).
  const branchPath = ctx.branchWorkspacePath(branch)
  const metaFile = await BranchMetadataFileManager.loadOnly(branchPath).catch(() => null)
  const marker = metaFile?.branch.historyRewrittenFrom
  const outgoingSha = await readPublishedSha(ctx, branch)
  if (outgoingSha === null) {
    throw new Error(`Branch "${branch}" is not in remote.git, so there is nothing to push`)
  }
  // The whole exchange, retry included, is one mirror session; the mirror kills its git when
  // `signal` aborts (the task timed out, or the worker's drain deadline hit). GitHub moves the ref
  // only after receiving the whole pack: a push killed before that changes nothing, and one
  // killed after it is found already done by the re-run.
  const outcome = await ctx.githubMirror().exclusive(async (mirror) => {
    const push = (lease?: string) =>
      mirror.pushToGitHub(githubUrl, branch, outgoingSha, {
        lease,
        signal,
        protectedBranches: [ctx.baseBranch],
      })
    try {
      await push(marker)
      return 'pushed'
    } catch (err) {
      // A retry can never make the branch not protected.
      if (err instanceof RefusedPushError) throw new PermanentTaskError(err.message)
      const message = getErrorMessage(err)
      throwIfWorkflowRefusal(branch, message)

      // A refused lease means GitHub is not at the commit we rewrote, so the
      // marker is stale -- routine, not exceptional: tasks are re-run after a
      // crash (recoverOrphanedTasks) and the marker survives any failure to
      // clear it. The two benign shapes that reach here (GitHub already holds
      // the rewritten history, or the branch moved past it) are ordinary
      // fast-forwards a lease has no business blocking.
      //
      // So retry PLAIN and let git adjudicate: a non-forced push succeeds if and
      // only if it fast-forwards, so it can never destroy anything, with no
      // ancestry check to get wrong and no extra round trip to read GitHub's
      // tip. Only if THAT is also rejected has the branch genuinely diverged.
      //
      // (git evaluates the lease only when it actually has an update to apply,
      // so an up-to-date ref with a stale lease prints "Everything up-to-date",
      // exits 0, and is absorbed above without reaching here.)
      if (marker && isStaleLeaseRejection(message)) {
        try {
          await push()
        } catch (retryErr) {
          const retryMessage = getErrorMessage(retryErr)
          throwIfWorkflowRefusal(branch, retryMessage)
          if (isNonFastForwardRejection(retryMessage)) {
            throw new PermanentTaskError(
              `Push rejected for branch "${branch}": GitHub's tip is neither the commit this ` +
                `deployment last published nor an ancestor of what it is pushing, so the branch ` +
                `has genuinely diverged and nothing was overwritten. Something else moved it on ` +
                `GitHub -- a direct push, or another CanopyCMS deployment sharing this repository.`,
            )
          }
          throw retryErr
        }
        return 'pushed-past-stale-lease'
      }

      // An ordinary non-fast-forward rejection: GitHub has commits this
      // deployment never published, so retrying the identical push can never
      // succeed (DEP-L1's git-failure-is-transient carve-out does NOT apply) and
      // it fails fast instead of burning the retry budget. Deliberately does NOT
      // advise renaming the branch: one reaching this point usually has an open
      // PR, which renaming would orphan.
      if (isNonFastForwardRejection(message)) {
        throw new PermanentTaskError(
          `Push rejected for branch "${branch}": GitHub's tip is not what this deployment last ` +
            `published, so the branch has diverged and needs reconciling. Something else moved it ` +
            `on GitHub -- a direct push, or another CanopyCMS deployment sharing this repository.`,
        )
      }
      throw err
    }
  })

  if (outcome === 'pushed-past-stale-lease') {
    // The lease was refused, so GitHub is provably not at the marker: it
    // has moved past the rewritten commit and the marker is spent.
    await clearHistoryRewrittenMarker(ctx, branchPath, branch)
    await recordPushedToGitHub(ctx, branchPath, branch)
    workerLog(`Pushed ${branch} to GitHub (GitHub had already moved past the rewritten commit)`)
    return
  }

  // Clear the marker only once GitHub is confirmed to hold something other
  // than the commit we rewrote. A push that sent nothing new (remote.git
  // still at the marker because its own publish has not landed yet) must
  // leave the marker set -- it is the sole trigger for the self-heal pass.
  if (marker && outgoingSha !== marker) {
    await clearHistoryRewrittenMarker(ctx, branchPath, branch)
  }
  await recordPushedToGitHub(ctx, branchPath, branch)
  workerLog(`Pushed ${branch} to GitHub`)
}

/**
 * Stamp `pushedToGitHubAt`, branch delete's proof that the GitHub branch is this one. Recorded
 * when the push lands, whatever the PR call after it does. Best-effort: a branch deleted
 * meanwhile has no metadata to stamp, and a failed stamp only leaves a later delete to skip
 * GitHub.
 */
async function recordPushedToGitHub(
  ctx: TaskRunnerContext,
  branchPath: string,
  branch: string,
): Promise<void> {
  if (isSettingsBranch(branch)) return
  try {
    await fs.stat(branchPath)
  } catch {
    return
  }
  try {
    await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).save({
      branch: { name: branch, pushedToGitHubAt: new Date().toISOString() },
    })
  } catch (err) {
    workerLogError(`Failed to record the GitHub push for ${branch}:`, getErrorMessage(err))
  }
}
