import fs from 'node:fs/promises'
import { simpleGit } from 'simple-git'
import { completeTask, dequeueTask, failTask, recoverOrphanedTasks, retryTask } from './task-queue'
import type { Task } from './task-queue'
import { createOrUpdatePullRequest } from '../github-service'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { sanitizeBranchName } from '../paths/branch-name'
import { gitNetworkChildEnv } from '../git-manager'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { isNonFastForwardRejection, isStaleLeaseRejection } from '../utils/git'
import { clearHistoryRewrittenMarker, readPublishedSha } from './history-rewrite'
import { writeWorkerStatus } from './worker-status'
import { workerLog, workerLogError } from './log'
import type { WorkerContext } from './worker-context'

/**
 * The task-queue cluster: everything reachable from `CmsWorker.processTaskQueue()`,
 * the loop that drains tasks Lambda enqueued because it has no internet.
 *
 * One of the four disjoint call trees that used to share cms-worker.ts. It owns
 * the GitHub-facing side of the worker -- pushing branches, creating and
 * updating PRs, and recording the outcome on branch metadata -- plus the
 * permanent-vs-transient failure classification that decides whether a failed
 * task is retried or fails fast.
 *
 * Shares nothing with the git-sync cluster but the four resolved paths, the
 * Octokit client and the history-rewrite marker (history-rewrite.ts). Note the
 * two loops run CONCURRENTLY: `scheduleLoop` drives this on `taskPollInterval`
 * (default 5s) and syncGit on `gitSyncInterval` (default 5min), so anything
 * here that reads branch metadata written by the rebase loop must re-read it
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
  | 'branchWorkspacePath'
  // Both are implemented in THIS module, and are still reached through the
  // context rather than called directly. cms-worker.test.ts replaces each on
  // the CmsWorker instance -- `executeTask` to drive the retry/timeout paths
  // without real work, `pushBranchToGitHub` to exercise the PR actions with no
  // git remote -- so a direct module-level call silently bypasses the stub.
  // See WorkerContext's doc comment.
  | 'executeTask'
  | 'pushBranchToGitHub'
  | 'isRunning'
  | 'ensureStatusReport'
>

/**
 * An error inherent to the task itself (malformed payload, unknown action):
 * retrying can never succeed, so the task should fail fast instead of
 * burning its retry budget.
 */
export class PermanentTaskError extends Error {}

/**
 * Classify a task failure as permanent (fail fast) or transient (retry).
 *
 * Transient — worth retrying with backoff:
 * - network errors / anything without an HTTP status (git failures included:
 *   most push/fetch failures are connectivity or contention and the retry
 *   budget bounds the pathological cases)
 * - HTTP 408 (request timeout) and 429 (rate limited)
 * - HTTP 403 that carries a rate-limit signal (see `isRateLimitSignal403`):
 *   GitHub returns 403, not 429, for both primary and secondary/abuse rate
 *   limits. The throttling plugin (see github-service.ts createCanopyOctokit)
 *   proactively retries short waits, but this carve-out remains the safety
 *   net for waits the plugin gives up on (`shouldRetryRateLimit`/
 *   `shouldRetrySecondaryRateLimit`) and for errors it never sees — without
 *   it a rate-limited push-and-create-or-update-pr task would fail
 *   permanently and wedge the branch (`sync-failed`, no retry).
 * - HTTP 5xx (server-side, usually recovers)
 *
 * Permanent — retrying the identical request cannot succeed:
 * - PermanentTaskError (malformed payload, unknown action)
 * - other HTTP 4xx (e.g. 401/404/422): the request itself is bad
 * - plain HTTP 403 with no rate-limit signal: a real permission denial
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
 * Detect whether a 403 is a GitHub rate-limit response rather than a plain
 * permission denial. GitHub signals rate limiting on 403s three ways: the
 * primary limit zeroes out `x-ratelimit-remaining`, secondary/abuse limits
 * often include a `retry-after` header, and both cases produce a message
 * containing "rate limit" (e.g. "You have exceeded a secondary rate limit").
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
 * Staleness threshold for recoverOrphanedTasks, derived from the
 * configured task timeout rather than fixed: the safety argument for
 * running recovery on every poll cycle is "no legitimately in-flight task
 * can be this old, because executeTaskWithTimeout bounds every attempt by
 * taskTimeoutMs" -- which is only true if this threshold scales with
 * taskTimeoutMs. 2x leaves the same comfortable margin the defaults have
 * (60s timeout vs 5min threshold); the 5-minute floor preserves the
 * long-standing default for a replacement instance's boot window.
 */
export function orphanRecoveryMaxAgeMs(ctx: Pick<TaskRunnerContext, 'taskTimeoutMs'>): number {
  return Math.max(5 * 60_000, ctx.taskTimeoutMs * 2)
}

/**
 * Process queued tasks from Lambda.
 * Polls .tasks/pending/ directory and executes each task.
 * Processes up to maxTasksPerCycle tasks per invocation.
 * Retries transient failures with exponential backoff.
 */
export async function processTaskQueue(ctx: TaskRunnerContext): Promise<void> {
  if (!ctx.isRunning()) return

  // Recover tasks orphaned in processing/ on EVERY cycle, not only at boot
  // (start()'s call above). Before this fix, recoverOrphanedTasks() ran
  // exactly once, at start() - fine when an instance was replaced rarely
  // (a spot interruption), but CanopyCmsService's worker ASG now rolls on
  // every `cdk deploy` (see its UpdatePolicy), making replacement routine.
  // A replacement instance's user-data (yum install git/unzip/nodejs/
  // efs-utils, mount EFS) takes roughly 2-4 minutes, well under
  // recoverOrphanedTasks()'s 5-minute default staleness threshold - so
  // THAT ONE boot-time call would see the just-orphaned file as "too
  // fresh" and skip it, and nothing rescanned afterward: the task (and its
  // branch's syncStatus) would be wedged forever. Re-checking every poll
  // means the file's age eventually crosses the threshold and it gets
  // recovered without operator intervention.
  //
  // Safe to run this often: executeTaskWithTimeout() guarantees every task
  // THIS process dequeues is completed, failed, or retried (all three
  // remove the processing/ file) within taskTimeoutMs - and the staleness
  // threshold is derived from taskTimeoutMs (orphanRecoveryMaxAgeMs below)
  // precisely so that guarantee holds for ANY configured timeout, not just
  // the 60s default: a fixed 5-minute threshold would have this call steal
  // the worker's own still-in-flight task back to pending whenever an
  // adopter configured taskTimeoutMs above ~5 minutes.
  const recovered = await recoverOrphanedTasks(ctx.taskDir, orphanRecoveryMaxAgeMs(ctx), ctx.log)
  if (recovered > 0) {
    workerLog(`Recovered ${recovered} orphaned task(s)`)
  }

  let processed = 0
  let task: Task | null
  while (
    processed < ctx.maxTasksPerCycle &&
    (task = await dequeueTask(ctx.taskDir, ctx.log)) !== null
  ) {
    try {
      const result = await executeTaskWithTimeout(ctx, task)
      await completeTask(ctx.taskDir, task.id, result, ctx.log)
      await updateBranchMetadata(ctx, task, result)
    } catch (err) {
      const message = getErrorMessage(err)
      workerLogError(`Task ${task.id} (${task.action}) failed:`, message)

      // [REDACT] task.error is persisted (pending/failed task JSON) and
      // served to the browser by the admin panel's Tasks tab -- a push
      // failure's message can embed the bot token via buildGitHubUrl().
      // Console output above stays raw (journald/CloudWatch is trusted).
      const persistedMessage = redactCredentials(message)

      // DEP-L1: only transient failures (network, 429/5xx, timeouts) are
      // worth retrying; permanent ones (malformed payload, other 4xx) would
      // just burn the retry budget on an identical doomed request.
      const permanent = isPermanentTaskFailure(err)
      const retryCount = task.retryCount ?? 0
      const maxRetries = task.maxRetries ?? ctx.maxRetries
      if (!permanent && retryCount < maxRetries) {
        await retryTask(ctx.taskDir, task.id, persistedMessage, ctx.log)
        workerLog(`  Will retry (attempt ${retryCount + 1}/${maxRetries})`)
      } else {
        await failTask(ctx.taskDir, task.id, persistedMessage, ctx.log)
        await updateBranchMetadataOnFailure(ctx, task, persistedMessage)
        workerLogError(
          permanent
            ? '  Permanently failed (non-retryable error)'
            : `  Permanently failed after ${maxRetries} retries`,
        )
      }
    }
    processed++
  }

  // PR-W1: only stamp/write when work actually happened this poll --
  // otherwise every idle 5s poll would hit worker-status.json, an EFS
  // write treadmill for no signal (liveness is already covered by the
  // lock heartbeat; see api/admin.ts's classifyWorkerLiveness).
  if (processed > 0) {
    const report = ctx.ensureStatusReport()
    report.lastTaskCycleAt = new Date().toISOString()
    await writeWorkerStatus(ctx.taskDir, report).catch((writeErr) =>
      workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
    )
  }
}

/**
 * Execute a task bounded by taskTimeoutMs (DEP-H1). Two layers:
 * - An AbortSignal cancels Octokit HTTP calls promptly.
 * - A Promise.race rejects when the timeout fires, so work that cannot
 *   observe the signal (git subprocesses via simple-git) still fails the
 *   attempt and the worker moves on instead of stalling forever.
 * pushBranchToGitHub additionally kills stalled git processes via
 * simple-git's block timeout, so a hung push doesn't leak a process.
 */
export async function executeTaskWithTimeout(
  ctx: TaskRunnerContext,
  task: Task,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.taskTimeoutMs)
  try {
    const work = ctx.executeTask(task, controller.signal)
    // If the timeout wins the race, the losing promise must not surface an
    // unhandled rejection when it eventually settles.
    work.catch(() => {})
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error(`Task timed out after ${ctx.taskTimeoutMs}ms`)),
        { once: true },
      )
    })
    return await Promise.race([work, timedOut])
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
      await ctx.pushBranchToGitHub(branch)
      return { pushed: true }
    }
    case 'push-and-create-pr': {
      const branch = requireString(payload, 'branch')
      await ctx.pushBranchToGitHub(branch)
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
      await ctx.pushBranchToGitHub(branch)
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
      // GIT-H1: idempotent create-or-update. Used for both content-branch
      // submits and settings-branch syncs so a retry after a crash (task
      // completed on GitHub but branch metadata never recorded the PR
      // number) recovers the existing PR instead of hitting the 422 that
      // a blind `pulls.create` would throw on a duplicate head+base.
      // Delegates to the shared helper (also used by GitHubService's
      // direct-API path) so the list->tiebreak->update/create logic and
      // the draft->ready conversion live in one place.
      const branch = requireString(payload, 'branch')
      const base = optionalString(payload, 'baseBranch', ctx.baseBranch)
      // Defense-in-depth: refuse head===base even if the 'submittableBranch'
      // API guard and the syncSubmitPr backstop were both somehow bypassed
      // (e.g. a task queued before this check shipped). PermanentTaskError
      // (not a plain Error) so this fails immediately instead of burning
      // the retry budget on an identical doomed request -- retrying can
      // never make the branch not be the base branch.
      if (sanitizeBranchName(branch) === ctx.sanitizedBaseBranch) {
        throw new PermanentTaskError(
          `Refusing to push-and-create-or-update-pr for "${branch}": it is the base branch -- submitting the base branch is never valid`,
        )
      }
      await ctx.pushBranchToGitHub(branch)

      const result = await createOrUpdatePullRequest({
        octokit: ctx.octokit(),
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        head: branch,
        base,
        title: optionalString(payload, 'title', `Submit ${branch}`),
        body: optionalString(payload, 'body', ''),
        // Content submits (api/github-sync.ts) set this; settings-branch
        // syncs (services.ts) deliberately don't.
        markReadyIfDraft: payload.markReadyIfDraft === true,
        signal,
      })
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
      await ctx.octokit().git.deleteRef({
        owner: ctx.githubOwner,
        repo: ctx.githubRepo,
        ref: `heads/${branch}`,
        request: { signal },
      })
      return { deleted: true }
    }
    default:
      throw new PermanentTaskError(`Unknown task action: ${action}`)
  }
}

/**
 * Update branch metadata after successful task completion.
 * Writes PR URL/number and sets syncStatus to 'synced'.
 */
export async function updateBranchMetadata(
  ctx: TaskRunnerContext,
  task: Task,
  result: Record<string, unknown>,
): Promise<void> {
  const branch = typeof task.payload.branch === 'string' ? task.payload.branch : null
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
      // save()'s merge only overwrites keys present in this update (see
      // BranchMetadataFileManager.save()'s spread order) -- a prior
      // syncFailureReason from an earlier failed attempt would otherwise
      // survive forever past this successful sync. Explicitly clear it,
      // same pattern as rebaseFailure's PR-W2 M2 clearing elsewhere.
      syncFailureReason: undefined,
    }
    if (result.prUrl) updates.pullRequestUrl = result.prUrl
    if (result.prNumber) {
      updates.pullRequestNumber = result.prNumber
      // As soon as the PR exists the field should read 'open' -- without
      // this it would stay absent until the next poll cycle observes it.
      // Exception: the git-sync loop may have archived this branch (PR
      // merged/closed) while this task was in flight; a late task
      // completion must not downgrade that terminal state back to 'open'.
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
 * Update branch metadata after permanent task failure.
 * Sets syncStatus to 'sync-failed' and records `error` (already redacted
 * by the caller, processTaskQueue -- see [REDACT] there) as
 * syncFailureReason, so the editor can show WHY, not just that it failed.
 */
export async function updateBranchMetadataOnFailure(
  ctx: TaskRunnerContext,
  task: Task,
  error: string,
): Promise<void> {
  const branch = typeof task.payload.branch === 'string' ? task.payload.branch : null
  if (!branch) return

  const branchPath = ctx.branchWorkspacePath(branch)
  try {
    await fs.stat(branchPath)
  } catch {
    return
  }

  try {
    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    await meta.save({
      branch: { name: branch, syncStatus: 'sync-failed', syncFailureReason: error },
    })
  } catch (err) {
    workerLogError(
      `Failed to update failure metadata for ${branch}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
export async function pushBranchToGitHub(ctx: TaskRunnerContext, branch: string): Promise<void> {
  const git = simpleGit({
    baseDir: ctx.remoteGitPath,
    // DEP-H1: kill the git process if it produces no output for
    // taskTimeoutMs (network stall, credential prompt) instead of letting
    // it hang past the task timeout.
    timeout: { block: ctx.taskTimeoutMs },
  })
  // Force stable (English) git output so isNonFastForwardRejection below
  // can reliably match it -- git's rejection text is gettext-translated, so
  // a non-English host would silently turn that classifier into a no-op.
  // gitNetworkChildEnv (NOT gitChildEnv) because this call talks to GitHub:
  // it keeps ambient HTTPS_PROXY/GIT_SSL_*/GIT_SSH_COMMAND, which
  // gitChildEnv's local-ops allowlist deliberately drops.
  git.env(gitNetworkChildEnv())

  // [SYNC-H1] If the rebase loop rewrote this branch's already-published
  // history, GitHub still holds the commit it replaced, so an ordinary
  // push is non-fast-forward forever. Push under a lease keyed to exactly
  // that commit: it moves GitHub off the commit we rewrote away, and
  // refuses in every other case (including a commit someone else pushed).
  const branchPath = ctx.branchWorkspacePath(branch)
  const metaFile = await BranchMetadataFileManager.loadOnly(branchPath).catch(() => null)
  const marker = metaFile?.branch.historyRewrittenFrom
  // What this push will actually send: remote.git's tip for the branch.
  const outgoingSha = await readPublishedSha(ctx, branch)

  try {
    if (marker) {
      await git.raw([
        'push',
        `--force-with-lease=${branch}:${marker}`,
        '--end-of-options',
        ctx.buildGitHubUrl(),
        `${branch}:${branch}`,
      ])
    } else {
      // Pass URL directly to avoid persisting the token in remote.git/config
      await git.push(ctx.buildGitHubUrl(), branch)
    }
  } catch (err) {
    const message = getErrorMessage(err)

    // A refused lease means GitHub is not at the commit we rewrote, so the
    // marker is stale -- which is routine, not exceptional: tasks are
    // re-run after a crash (recoverOrphanedTasks), and the marker survives
    // any failure to clear it. Two benign shapes reach here, and both are
    // ordinary fast-forwards that a lease has no business blocking:
    // GitHub already holds the rewritten history from an earlier attempt,
    // or the branch has since moved past it.
    //
    // Retry PLAIN, and let git adjudicate. A non-forced push succeeds if
    // and only if it fast-forwards, so it can never destroy anything --
    // there is no ancestry check to get wrong here, and no extra network
    // round trip to read GitHub's tip. Only if THAT is also rejected has
    // the branch genuinely diverged.
    //
    // (Verified: git evaluates the lease only when it actually has an
    // update to apply. An up-to-date ref with a stale lease prints
    // "Everything up-to-date" and exits 0, so the already-landed case is
    // usually absorbed above and never even reaches this branch.)
    if (marker && isStaleLeaseRejection(message)) {
      try {
        await git.push(ctx.buildGitHubUrl(), branch)
      } catch (retryErr) {
        const retryMessage = getErrorMessage(retryErr)
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
      // The lease was refused, so GitHub is provably not at the marker: it
      // has moved past the rewritten commit and the marker is spent.
      await clearHistoryRewrittenMarker(ctx, branchPath, branch)
      workerLog(`Pushed ${branch} to GitHub (GitHub had already moved past the rewritten commit)`)
      return
    }

    // An ordinary non-fast-forward rejection: GitHub has commits this
    // deployment never published. Retrying the identical push can never
    // succeed (DEP-L1's git-failure-is-transient carve-out does NOT apply
    // here), so fail fast instead of burning the task's retry budget.
    // Deliberately does NOT advise renaming the branch: a branch reaching
    // this point usually has an open PR, and renaming would orphan it.
    if (isNonFastForwardRejection(message)) {
      throw new PermanentTaskError(
        `Push rejected for branch "${branch}": GitHub's tip is not what this deployment last ` +
          `published, so the branch has diverged and needs reconciling. Something else moved it ` +
          `on GitHub -- a direct push, or another CanopyCMS deployment sharing this repository.`,
      )
    }
    throw err
  }

  // Clear the marker only once GitHub is confirmed to hold something other
  // than the commit we rewrote. A push that sent nothing new (remote.git
  // still at the marker because its own publish has not landed yet) must
  // leave the marker set -- it is the sole trigger for the self-heal pass.
  if (marker && outgoingSha && outgoingSha !== marker) {
    await clearHistoryRewrittenMarker(ctx, branchPath, branch)
  }
  workerLog(`Pushed ${branch} to GitHub`)
}
