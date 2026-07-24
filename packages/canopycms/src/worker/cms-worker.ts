import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import {
  dequeueTask,
  completeTask,
  failTask,
  retryTask,
  recoverOrphanedTasks,
  cleanupOldTasks,
  cmsTaskQueueLogger,
} from './task-queue'
import type { Task } from './task-queue'
import { createOrUpdatePullRequest, createCanopyOctokit } from '../github-service'
import {
  getBranchMetadataFileManager,
  BranchMetadataFileManager,
  buildMergedBranchUpdate,
  type BranchMetadataFile,
} from '../branch-metadata'
import { extractIdFromFilename } from '../content-id-index'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { type ContentId, type SanitizedBranchName, ROOT_COLLECTION_ID } from '../paths/types'
import { sanitizeBranchName } from '../paths/branch'
import type { PullRequestState } from '../types'
import { getErrorMessage, isNodeError } from '../utils/error'

/**
 * Auth cache refresh function type.
 * Adopters provide their auth-plugin-specific implementation.
 * For Clerk: use refreshClerkCache from canopycms-auth-clerk/cache-writer.
 */
export type AuthCacheRefresher = () => Promise<void>

export interface CmsWorkerConfig {
  /** Path to workspace root on EFS (e.g., /mnt/efs/workspace) */
  workspacePath: string
  /** GitHub owner (e.g., 'safeinsights') */
  githubOwner: string
  /** GitHub repo name (e.g., 'docs-site') */
  githubRepo: string
  /** GitHub bot token for pushing and PR operations */
  githubToken: string
  /**
   * Auth cache refresh callback. Called periodically to update the auth
   * metadata cache on EFS. Adopters provide their auth-plugin-specific
   * implementation (e.g., refreshClerkCache from canopycms-auth-clerk).
   */
  refreshAuthCache?: AuthCacheRefresher
  /** Task queue poll interval in ms (default: 5000) */
  taskPollInterval?: number
  /** Git sync interval in ms (default: 5 * 60 * 1000) */
  gitSyncInterval?: number
  /** Auth cache refresh interval in ms (default: 15 * 60 * 1000) */
  authCacheRefreshInterval?: number
  /** Base branch name (default: 'main') */
  baseBranch?: string
  /** Max tasks to process per cycle (default: 10) */
  maxTasksPerCycle?: number
  /** Per-task timeout in ms (default: 60000) */
  taskTimeoutMs?: number
  /** Max retries for failed tasks (default: 3) */
  maxRetries?: number
  /** Content root directory name relative to repo root (default: 'content') */
  contentRoot?: string
  /**
   * Worker lock staleness TTL in ms (default: 60000, minimum 2000).
   * The holder refreshes the lock heartbeat at half this interval; a lock
   * whose heartbeat is older than this is considered abandoned and taken
   * over by the next worker to start.
   */
  lockStaleMs?: number
}

const DEFAULT_TASK_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_LOCK_STALE_MS = 60_000

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
 * CMS Worker daemon.
 * Handles operations that Lambda (with no internet) cannot perform:
 * - Processing queued tasks (push branches, create PRs)
 * - Syncing bare repo with GitHub
 * - Rebasing active branch workspaces
 * - Refreshing auth metadata cache (via pluggable callback)
 *
 * Auth-agnostic: does not depend on any specific auth provider.
 * Cloud-agnostic: uses git/Octokit directly, no AWS SDK dependency.
 */
export class CmsWorker {
  private octokit: Octokit
  private taskDir: string
  private remoteGitPath: string
  private contentBranchesPath: string
  private baseBranch: string
  // Workspace directories use sanitized names; git refs (fetch/rev-list/merge
  // against origin/<baseBranch>) must keep using the raw `baseBranch` name.
  // Computed once so both filesystem call sites (refreshBaseBranchWorkspace's
  // path.join and rebaseActiveBranches' skip comparison) agree, instead of
  // re-deriving it (and risking drift) at each use.
  private sanitizedBaseBranch: SanitizedBranchName
  private activeTimeouts = new Set<NodeJS.Timeout>()
  private running = false
  private activeOperations = new Set<Promise<void>>()
  private maxTasksPerCycle: number
  private taskTimeoutMs: number
  private maxRetries: number
  private lockFilePath: string
  private lockStaleMs: number
  private releaseLockFn: (() => Promise<void>) | null = null
  private contentRoot: string
  private log = cmsTaskQueueLogger

  constructor(private config: CmsWorkerConfig) {
    this.octokit = createCanopyOctokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.baseBranch = config.baseBranch ?? 'main'
    this.sanitizedBaseBranch = sanitizeBranchName(this.baseBranch)
    this.maxTasksPerCycle = config.maxTasksPerCycle ?? 10
    this.taskTimeoutMs = config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.lockFilePath = path.join(config.workspacePath, '.tasks', '.worker-lock')
    this.lockStaleMs = config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.contentRoot = config.contentRoot ?? 'content'
  }

  async start(): Promise<void> {
    this.running = true
    console.log('CMS Worker starting...')

    // Acquire lock to prevent concurrent workers
    await this.acquireLock()

    // Everything below runs while holding the cross-host worker lock. A
    // failure here (most notably the empty-remote guard inside
    // ensureRemoteGit) means the process is about to exit, and systemd
    // (Restart=always) will retry — but a still-held lock would make every
    // retry fail with ELOCKED for up to lockStaleMs. Release before
    // rethrowing so the next start() (this process's retry, or another host)
    // can acquire immediately. We deliberately do NOT reorder ensureRemoteGit
    // ahead of acquireLock: two hosts cold-starting at once would then both
    // race to `git clone --bare` into the same remoteGitPath (the same class
    // of race that acquireProvisioningLock guards against for workspace
    // clones elsewhere) — acquiring the lock first is what already
    // serializes that.
    try {
      // Ensure remote.git exists (init bare repo if first run)
      await this.ensureRemoteGit()

      // Recover any orphaned tasks from a previous crash
      const recovered = await recoverOrphanedTasks(this.taskDir, undefined, this.log)
      if (recovered > 0) {
        console.log(`Recovered ${recovered} orphaned task(s)`)
      }

      // Run initial sync + cache refresh immediately
      const initialTasks: Promise<void>[] = [this.syncGit()]
      if (this.config.refreshAuthCache) {
        initialTasks.push(this.refreshAuthCache())
      }
      await Promise.allSettled(initialTasks)
    } catch (err) {
      await this.releaseLock()
      throw err
    }

    // Start recurring task loops using setTimeout chaining
    // (avoids setInterval overlap when tasks take longer than the interval)
    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000

    this.scheduleLoop(() => this.processTaskQueue(), taskInterval)
    this.scheduleLoop(() => this.syncGit(), gitInterval)

    if (this.config.refreshAuthCache) {
      const cacheInterval = this.config.authCacheRefreshInterval ?? 15 * 60_000
      this.scheduleLoop(() => this.refreshAuthCache(), cacheInterval)
      console.log(`  Auth cache refresh: every ${cacheInterval / 1000}s`)
    }

    console.log('CMS Worker started')
    console.log(`  Task queue poll: every ${taskInterval / 1000}s`)
    console.log(`  Git sync: every ${gitInterval / 1000}s`)
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.activeTimeouts) {
      clearTimeout(t)
    }
    this.activeTimeouts.clear()
    // Wait for all in-flight operations to complete (up to taskTimeoutMs)
    let drainTimer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...this.activeOperations]),
      new Promise<void>((r) => {
        drainTimer = setTimeout(r, this.taskTimeoutMs)
      }),
    ])
    clearTimeout(drainTimer)
    await this.releaseLock()
    console.log('CMS Worker stopped')
  }

  /**
   * Acquire the cross-host worker lock (DEP-C2).
   *
   * The task queue is single-consumer (see task-queue/task-queue.ts): two
   * concurrent workers would double-process tasks (duplicate pushes, duplicate
   * PRs). The workspace lives on a shared filesystem (EFS), so mutual
   * exclusion must be sound ACROSS HOSTS — a PID liveness probe
   * (`process.kill(pid, 0)`) only means something on the holder's own machine
   * and must never participate in staleness decisions.
   *
   * proper-lockfile provides a heartbeat lease with no PID involved: the lock
   * is a directory created atomically (mkdir — atomic on NFS/EFS), the holder
   * refreshes its mtime every lockStaleMs/2, and the lock is considered
   * abandoned — and taken over — only when that heartbeat is older than
   * lockStaleMs. Liveness is judged purely by heartbeat freshness.
   *
   * No acquire retries: a second worker exits immediately, matching daemon
   * semantics (the supervisor restarts it later). After a crash, the dead
   * holder's heartbeat expires within lockStaleMs and the next start succeeds.
   *
   * Staleness is judged by comparing the lock's mtime against the local
   * clock, so correct cross-host takeover assumes reasonable clock agreement
   * between hosts (e.g. NTP); with the default TTL, ordinary clock skew is
   * negligible, but a host with a badly wrong clock could misjudge liveness.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(this.taskDir, { recursive: true })
    try {
      this.releaseLockFn = await lockfile.lock(this.taskDir, {
        lockfilePath: this.lockFilePath,
        stale: this.lockStaleMs,
        onCompromised: (err) => {
          // Our heartbeat could not be maintained (lock deleted or taken
          // over). Another worker may now be consuming the queue — stop
          // processing to preserve the single-consumer invariant.
          console.error('Worker lock compromised, shutting down:', getErrorMessage(err))
          this.releaseLockFn = null // the lock is already lost; nothing to release
          void this.stop()
        },
      })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ELOCKED') {
        throw new Error(
          `Another worker is running (lock ${this.lockFilePath} has a heartbeat fresher than ${this.lockStaleMs}ms). Exiting.`,
        )
      }
      throw err
    }
  }

  private async releaseLock(): Promise<void> {
    const release = this.releaseLockFn
    this.releaseLockFn = null
    if (!release) return
    try {
      await release()
    } catch {
      // Lock already released or compromised
    }
  }

  /**
   * Schedule a function to run repeatedly with setTimeout chaining.
   * The next invocation starts `interval` ms after the previous one completes,
   * preventing overlapping executions.
   */
  private scheduleLoop(fn: () => Promise<void>, interval: number): void {
    const run = () => {
      if (!this.running) return
      const timeout = setTimeout(async () => {
        this.activeTimeouts.delete(timeout)
        const operation = fn().catch((err) => {
          console.error('Worker loop error:', err instanceof Error ? err.message : err)
        })
        this.activeOperations.add(operation)
        operation.finally(() => this.activeOperations.delete(operation))
        await operation
        run()
      }, interval)
      this.activeTimeouts.add(timeout)
    }
    run()
  }

  /**
   * Whether the bare repo at `gitDir` has a local `refs/heads/<baseBranch>`.
   *
   * Uses an explicit `--git-dir` invocation rather than `simpleGit({ baseDir
   * })` so this also works in sandboxed/CI git environments that set
   * `safe.bareRepository=explicit` (which refuses cwd-based discovery of
   * bare repos but expressly allows `--git-dir` — see
   * GitManager.bareRemoteHasBranch for the same pattern).
   *
   * Deliberately omits `--quiet`: simple-git only treats a task as failed
   * when the process both exits non-zero AND writes to stderr
   * (isTaskError), so a quiet, silent-on-failure `--verify` would leave a
   * missing branch indistinguishable from success. Without `--quiet`,
   * `rev-parse --verify` writes its "fatal: ..." to stderr on failure, which
   * is what makes simple-git reject the promise here.
   */
  private async verifyBaseBranchExists(gitDir: string): Promise<void> {
    await simpleGit().raw([
      '--git-dir',
      gitDir,
      'rev-parse',
      '--verify',
      `refs/heads/${this.baseBranch}`,
    ])
  }

  /**
   * Ensure remote.git bare repo exists.
   * On first run, clone from GitHub as a bare repo.
   *
   * Empty-remote guard: simple-git's bare clone of an EMPTY GitHub repo (no
   * commits, or a base branch that's never been pushed) exits 0 and produces
   * a refs-less bare repo — HEAD points at an unborn branch. `fs.stat`
   * cannot distinguish this from a healthy clone, so left unchecked it
   * silently poisons remote.git: every later branch operation (Lambda-side
   * clone provisioning, worker pushes) breaks, and the fs.stat short-circuit
   * means it never heals on its own. We verify the base branch exists right
   * after cloning and again on the already-exists fast path, since a
   * previous run could have left a poisoned remote.git behind before this
   * guard existed.
   */
  private async ensureRemoteGit(): Promise<void> {
    let exists: boolean
    try {
      await fs.stat(this.remoteGitPath)
      exists = true
    } catch {
      exists = false
    }

    if (exists) {
      try {
        await this.verifyBaseBranchExists(this.remoteGitPath)
      } catch (err) {
        console.error(`remote.git base branch verification failed: ${getErrorMessage(err)}`)
        // Do NOT auto-delete: an existing remote.git could hold unpushed
        // canopycms-settings-* branches or other state worth preserving.
        // Deletion here is the operator's call, not ours.
        throw new Error(
          `remote.git at ${this.remoteGitPath} has no branch '${this.baseBranch}' (likely cloned while the GitHub repo was empty). Delete ${this.remoteGitPath} and restart the worker to re-clone.`,
        )
      }
      return // Already exists and has the base branch
    }

    console.log('Initializing remote.git from GitHub...')
    const git = simpleGit()
    await git.clone(this.buildGitHubUrl(), this.remoteGitPath, ['--bare'])

    try {
      await this.verifyBaseBranchExists(this.remoteGitPath)
    } catch (err) {
      console.error(
        `remote.git base branch verification failed after clone: ${getErrorMessage(err)}`,
      )
      // Deleting before throwing is what makes this recoverable: the next
      // start() sees no remote.git and re-clones, instead of being stuck
      // forever behind a poisoned bare repo that fs.stat alone can't detect.
      await fs.rm(this.remoteGitPath, { recursive: true, force: true })
      throw new Error(
        `remote.git clone of ${this.config.githubOwner}/${this.config.githubRepo} has no branch '${this.baseBranch}' - the GitHub repository is empty or the base branch does not exist. Push an initial commit to '${this.baseBranch}' and restart the worker (systemd will retry automatically).`,
      )
    }

    // Remove the origin remote so the token doesn't persist in config
    const bareGit = simpleGit({ baseDir: this.remoteGitPath })
    await bareGit.removeRemote('origin').catch(() => {})
    console.log('remote.git initialized')
  }

  /**
   * Process queued tasks from Lambda.
   * Polls .tasks/pending/ directory and executes each task.
   * Processes up to maxTasksPerCycle tasks per invocation.
   * Retries transient failures with exponential backoff.
   */
  async processTaskQueue(): Promise<void> {
    if (!this.running) return

    let processed = 0
    let task: Task | null
    while (
      processed < this.maxTasksPerCycle &&
      (task = await dequeueTask(this.taskDir, this.log)) !== null
    ) {
      try {
        const result = await this.executeTaskWithTimeout(task)
        await completeTask(this.taskDir, task.id, result, this.log)
        await this.updateBranchMetadata(task, result)
      } catch (err) {
        const message = getErrorMessage(err)
        console.error(`Task ${task.id} (${task.action}) failed:`, message)

        // DEP-L1: only transient failures (network, 429/5xx, timeouts) are
        // worth retrying; permanent ones (malformed payload, other 4xx) would
        // just burn the retry budget on an identical doomed request.
        const permanent = isPermanentTaskFailure(err)
        const retryCount = task.retryCount ?? 0
        const maxRetries = task.maxRetries ?? this.maxRetries
        if (!permanent && retryCount < maxRetries) {
          await retryTask(this.taskDir, task.id, message, this.log)
          console.log(`  Will retry (attempt ${retryCount + 1}/${maxRetries})`)
        } else {
          await failTask(this.taskDir, task.id, message, this.log)
          await this.updateBranchMetadataOnFailure(task, message)
          console.error(
            permanent
              ? '  Permanently failed (non-retryable error)'
              : `  Permanently failed after ${maxRetries} retries`,
          )
        }
      }
      processed++
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
  private async executeTaskWithTimeout(task: Task): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.taskTimeoutMs)
    try {
      const work = this.executeTask(task, controller.signal)
      // If the timeout wins the race, the losing promise must not surface an
      // unhandled rejection when it eventually settles.
      work.catch(() => {})
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(`Task timed out after ${this.taskTimeoutMs}ms`)),
          { once: true },
        )
      })
      return await Promise.race([work, timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  private async executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { action, payload } = task

    switch (action) {
      case 'push-branch': {
        const branch = requireString(payload, 'branch')
        await this.pushBranchToGitHub(branch)
        return { pushed: true }
      }
      case 'push-and-create-pr': {
        const branch = requireString(payload, 'branch')
        await this.pushBranchToGitHub(branch)
        const pr = await this.octokit.pulls.create({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          head: branch,
          base: optionalString(payload, 'baseBranch', this.baseBranch),
          title: optionalString(payload, 'title', `Submit ${branch}`),
          body: optionalString(payload, 'body', ''),
          request: { signal },
        })
        console.log(`Created PR #${pr.data.number} for ${branch}`)
        return { prUrl: pr.data.html_url, prNumber: pr.data.number }
      }
      case 'push-and-update-pr': {
        const branch = requireString(payload, 'branch')
        const prNumber = requireNumber(payload, 'pullRequestNumber')
        await this.pushBranchToGitHub(branch)
        await this.octokit.pulls.update({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: prNumber,
          title: optionalString(payload, 'title', `Submit ${branch}`),
          body: optionalString(payload, 'body', ''),
          request: { signal },
        })
        console.log(`Updated PR #${prNumber} for ${branch}`)
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
        await this.pushBranchToGitHub(branch)

        const result = await createOrUpdatePullRequest({
          octokit: this.octokit,
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          head: branch,
          base: optionalString(payload, 'baseBranch', this.baseBranch),
          title: optionalString(payload, 'title', `Submit ${branch}`),
          body: optionalString(payload, 'body', ''),
          // Content submits (api/github-sync.ts) set this; settings-branch
          // syncs (services.ts) deliberately don't.
          markReadyIfDraft: payload.markReadyIfDraft === true,
          signal,
        })
        console.log(
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
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: draftPrNumber,
          request: { signal },
        })
        await this.octokit.graphql(
          `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          { id: pr.node_id, request: { signal } },
        )
        console.log(`Converted PR #${draftPrNumber} to draft`)
        return { prNumber: draftPrNumber, draft: true }
      }
      case 'close-pr': {
        const closePrNumber = requireNumber(payload, 'pullRequestNumber')
        await this.octokit.pulls.update({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: closePrNumber,
          state: 'closed',
          request: { signal },
        })
        return { closed: true }
      }
      case 'delete-remote-branch': {
        const branch = requireString(payload, 'branch')
        await this.octokit.git.deleteRef({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
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
  private async updateBranchMetadata(task: Task, result: Record<string, unknown>): Promise<void> {
    const branch = typeof task.payload.branch === 'string' ? task.payload.branch : null
    if (!branch) return

    const branchPath = path.join(this.contentBranchesPath, branch)
    try {
      await fs.stat(branchPath)
    } catch {
      return // Branch directory doesn't exist
    }

    try {
      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
      const updates: Record<string, unknown> = {
        name: branch,
        syncStatus: 'synced',
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
      console.error(
        `Failed to update metadata for ${branch}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  /**
   * Update branch metadata after permanent task failure.
   * Sets syncStatus to 'sync-failed' with error details.
   */
  private async updateBranchMetadataOnFailure(task: Task, _error: string): Promise<void> {
    const branch = typeof task.payload.branch === 'string' ? task.payload.branch : null
    if (!branch) return

    const branchPath = path.join(this.contentBranchesPath, branch)
    try {
      await fs.stat(branchPath)
    } catch {
      return
    }

    try {
      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
      await meta.save({ branch: { name: branch, syncStatus: 'sync-failed' } })
    } catch (err) {
      console.error(
        `Failed to update failure metadata for ${branch}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  private buildGitHubUrl(): string {
    return `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  private async pushBranchToGitHub(branch: string): Promise<void> {
    const git = simpleGit({
      baseDir: this.remoteGitPath,
      // DEP-H1: kill the git process if it produces no output for
      // taskTimeoutMs (network stall, credential prompt) instead of letting
      // it hang past the task timeout.
      timeout: { block: this.taskTimeoutMs },
    })
    // Pass URL directly to avoid persisting the token in remote.git/config
    await git.push(this.buildGitHubUrl(), branch)
    console.log(`Pushed ${branch} to GitHub`)
  }

  /**
   * Push any canopycms-settings-* branches from remote.git to GitHub.
   * Non-fatal: a no-op push for up-to-date branches just succeeds quietly.
   */
  private async pushSettingsBranches(git: ReturnType<typeof simpleGit>): Promise<void> {
    try {
      const branches = await git.branch()
      const settingsBranches = branches.all.filter((b) => b.startsWith('canopycms-settings-'))
      for (const branch of settingsBranches) {
        try {
          await git.push(this.buildGitHubUrl(), branch)
          console.log(`Pushed settings branch ${branch} to GitHub`)
        } catch (err) {
          // Non-fatal: branch may already be up-to-date or not yet created
          console.warn(`Settings push for ${branch}:`, err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      console.warn(
        'Failed to list branches for settings push:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  async syncGit(): Promise<void> {
    if (!this.running) return

    console.log('Syncing git...')
    const git = simpleGit({
      baseDir: this.remoteGitPath,
      // DEP-H1: a hung fetch/push would stall the sync loop forever
      // (scheduleLoop only reschedules after completion). The block timeout
      // is inactivity-based, so a slow-but-flowing transfer is unaffected.
      timeout: { block: this.taskTimeoutMs },
    })

    // Fetch all branches from GitHub using direct URL (no named remote)
    // We use raw git commands since simple-git's fetch() with a URL
    // doesn't support --prune directly
    await git.raw(['fetch', this.buildGitHubUrl(), '--prune', '+refs/heads/*:refs/heads/*'])
    console.log('Fetched from GitHub')

    // Push settings branches to GitHub (belt-and-suspenders for task queue).
    // Ensures settings reach GitHub even if a task queue entry is lost.
    await this.pushSettingsBranches(git)

    await this.refreshBaseBranchWorkspace()

    await this.rebaseActiveBranches()

    // Periodically clean up old completed/failed tasks
    await cleanupOldTasks(this.taskDir, undefined, this.log)
  }

  /**
   * Fast-forward the base branch's own working-tree clone
   * (content-branches/<baseBranch>) to match origin/<baseBranch>.
   *
   * Previously this clone was refreshed only incidentally, by the generic
   * rebase loop below (rebaseActiveBranches): for a branch with status
   * 'editing', rebasing onto origin/<baseBranch> degenerates to a
   * fast-forward when the clone IS the base branch. But that loop's skip
   * paths -- a dirty tree, a missing .git -- are silent, which is the
   * suspected live failure mode: a wedged base clone with no diagnosable
   * signal in the logs. This dedicated step makes the refresh explicit,
   * ff-only, and loud, so a stuck base view (an editor forking a new branch
   * "from base" that's actually a stale snapshot) is diagnosable from logs.
   * This runs every sync cycle so the drift window is bounded by
   * gitSyncInterval.
   *
   * ff-only on purpose: this clone must stay a linear mirror of
   * origin/<baseBranch>, so a merge that isn't a fast-forward (diverged
   * local history) is treated as a should-never-happen condition and left
   * untouched rather than force-resolved.
   */
  private async refreshBaseBranchWorkspace(): Promise<void> {
    // Sanitized name for the workspace directory (a base branch containing
    // e.g. '/' would otherwise stat a wrong nested path here forever).
    const basePath = path.join(this.contentBranchesPath, this.sanitizedBaseBranch)
    const gitDir = path.join(basePath, '.git')

    try {
      let gitDirStat
      try {
        gitDirStat = await fs.stat(gitDir)
      } catch {
        gitDirStat = null
      }
      if (!gitDirStat || !gitDirStat.isDirectory()) {
        console.log(
          `Base branch workspace (${this.baseBranch}): not yet provisioned, skipping refresh`,
        )
        return
      }

      const baseGit = simpleGit({
        baseDir: basePath,
        // Keep git non-interactive during the merge so it never blocks on an
        // editor. simple-git >=3.32 blocks setting core.editor unless
        // explicitly opted in; the value here is a hardcoded literal
        // ("true", the shell no-op), not user input, so enabling
        // allowUnsafeEditor carries no injection risk (same as the rebase
        // loop's git config below).
        config: ['core.editor=true'],
        unsafe: { allowUnsafeEditor: true },
        // DEP-H1: a hung fetch/merge against this EFS-backed clone would
        // stall the sync loop forever (scheduleLoop only reschedules after
        // completion). The block timeout is inactivity-based, so a
        // slow-but-flowing transfer is unaffected -- same as syncGit()'s
        // remote handle.
        timeout: { block: this.taskTimeoutMs },
      })

      // Nothing makes this clone read-only. A direct edit here (or a stray
      // process) wedges every editor's view of the base branch until an
      // operator intervenes, so a dirty tree is loud, not a quiet skip.
      // Only TRACKED changes block the refresh: a stray untracked file (e.g.
      // runtime metadata missing from .git/info/exclude) must not wedge the
      // fast-forward forever — if an untracked file would collide with
      // incoming content, the --ff-only merge below refuses on its own and
      // that failure is already logged loudly.
      const status = await baseGit.status()
      const trackedDirty = status.files.filter((f) => f.index !== '?' || f.working_dir !== '?')
      if (trackedDirty.length > 0) {
        console.error(
          `Base branch workspace (${this.baseBranch}) has uncommitted changes -- skipping refresh. Dirty files: ${trackedDirty.map((f) => f.path).join(', ')}`,
        )
        return
      }

      // Raw (unsanitized) name from here on: these are git ref operations
      // against origin/<baseBranch>, not filesystem paths, so they must use
      // the same name GitHub knows the branch by.
      await baseGit.fetch('origin', this.baseBranch)

      // Use rev-list instead of status.behind for the same reason as the
      // rebase loop below: status.behind only works with an upstream
      // tracking branch configured, which isn't guaranteed here.
      // Compare against FETCH_HEAD (the tip the fetch above just retrieved)
      // rather than origin/<base>: workspaces are cloned --single-branch
      // (git-manager.ts), so their fetch refspec only materializes a
      // remote-tracking ref for the branch they were cloned from — for any
      // other base branch, origin/<base> simply never exists and rev-list
      // dies with "ambiguous argument".
      const behindCount = parseInt(
        (await baseGit.raw(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim(),
        10,
      )

      if (behindCount > 0) {
        try {
          await baseGit.merge(['--ff-only', 'FETCH_HEAD'])
        } catch (err) {
          console.error(
            `Base branch workspace (${this.baseBranch}) failed to fast-forward (diverged local history?): ${getErrorMessage(err)}`,
          )
          return
        }
        await invalidateBranchContentCaches(basePath)
      }

      // Hygiene: conflictStatus/conflictFiles are meaningless for the base
      // branch's own metadata and may be left over from before the base was
      // excluded from rebaseActiveBranches()'s conflict-resolution loop.
      // Reuse the already-clean no-op-save guard from that loop: save()
      // eager-regenerates the branch registry (O(branch count) EFS reads),
      // so skip it when there's nothing to clear.
      const currentMeta = await BranchMetadataFileManager.loadOnly(basePath)
      const conflictStatus = currentMeta?.branch.conflictStatus
      const conflictFiles = currentMeta?.branch.conflictFiles
      const alreadyClean =
        (conflictStatus === undefined || conflictStatus === 'clean') &&
        (conflictFiles === undefined || conflictFiles.length === 0)
      if (!alreadyClean) {
        const meta = getBranchMetadataFileManager(basePath, this.contentBranchesPath)
        await meta.save({
          branch: { name: this.baseBranch, conflictStatus: 'clean', conflictFiles: [] },
        })
      }

      // One concise per-cycle line -- the diagnostic for the next live deploy.
      console.log(
        behindCount > 0
          ? `Base branch workspace (${this.baseBranch}): fast-forwarded ${behindCount} commit(s)`
          : `Base branch workspace (${this.baseBranch}): up to date`,
      )
    } catch (err) {
      console.error(
        `Base branch workspace (${this.baseBranch}) refresh failed: ${getErrorMessage(err)}`,
      )
    }
  }

  /**
   * Poll GitHub for a submitted/approved branch's PR resolution.
   *
   * submitted/approved branches sit outside the rebase loop and get no
   * other signal that their PR resolved on GitHub -- nothing pushes a
   * merge/close webhook back into the branch workspace. merged ->
   * auto-archive via buildMergedBranchUpdate (shared with the manual
   * markAsMerged API so both paths produce identical archived-branch
   * metadata). closed-without-merge -> record pullRequestState only; an
   * admin decides the workflow transition from there. Best-effort: any
   * failure here is logged and swallowed, retried next sync cycle.
   */
  private async pollMergeState(
    branchDir: string,
    branchPath: string,
    metaFile: BranchMetadataFile | null,
  ): Promise<void> {
    const prNumber = metaFile?.branch.pullRequestNumber
    if (!prNumber) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.taskTimeoutMs)
    try {
      const { data } = await this.octokit.pulls.get({
        owner: this.config.githubOwner,
        repo: this.config.githubRepo,
        pull_number: prNumber,
        request: { signal: controller.signal },
      })

      if (data.merged) {
        const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
        // Use GitHub's actual merge time when available; buildMergedBranchUpdate
        // falls back to "now" (its default `now` param) when merged_at is absent.
        await meta.save({
          branch: buildMergedBranchUpdate(
            branchDir,
            data.merged_at ? new Date(data.merged_at) : undefined,
          ),
        })
        console.log(`  PR #${prNumber} for ${branchDir} is merged -> archived`)
        return
      }

      const newState: PullRequestState = data.state === 'closed' ? 'closed' : 'open'
      // Re-load fresh (not the loop-top `metaFile` snapshot passed in) -- a
      // concurrent Lambda write (e.g. an editor re-submitting) may have
      // landed since that snapshot was taken.
      const currentMeta = await BranchMetadataFileManager.loadOnly(branchPath)
      if (currentMeta?.branch.pullRequestState === newState) return

      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
      await meta.save({ branch: { name: branchDir, pullRequestState: newState } })
      console.log(`  PR #${prNumber} for ${branchDir}: pullRequestState -> ${newState}`)
    } catch (err) {
      // Non-fatal: transient GitHub/network errors are retried next cycle.
      console.warn(`  Failed to poll PR #${prNumber} for ${branchDir}: ${getErrorMessage(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async rebaseActiveBranches(): Promise<void> {
    let branchDirs: string[]
    try {
      branchDirs = await fs.readdir(this.contentBranchesPath)
    } catch {
      return
    }

    for (const branchDir of branchDirs) {
      // Known structural entries under content-branches/, not branch
      // workspaces: branches.json (registry snapshot) and dot-prefixed
      // entries (.canopy-meta/, transient lock dirs). Skip them silently so
      // the no-.git skip logs below don't fire for them every cycle.
      // Everything else still logs loudly on skip.
      if (branchDir.startsWith('.') || branchDir === 'branches.json') {
        continue
      }

      const branchPath = path.join(this.contentBranchesPath, branchDir)
      const gitDir = path.join(branchPath, '.git')

      try {
        const stat = await fs.stat(gitDir)
        if (!stat.isDirectory()) {
          console.log(`  Skipping ${branchDir}: .git is not a directory`)
          continue
        }
      } catch {
        console.log(`  Skipping ${branchDir}: no .git directory (not a branch workspace)`)
        continue
      }

      // The base branch's own clone is refreshed ff-only by
      // refreshBaseBranchWorkspace() earlier in syncGit(). Routing it
      // through this conflict-resolution rebase loop could rewrite its
      // history (the --theirs loop below) and stamp meaningless conflict
      // metadata on it. Compare sanitized-vs-sanitized: branchDir is a
      // filesystem name (already sanitized), this.baseBranch is raw.
      if (branchDir === this.sanitizedBaseBranch) {
        console.log(`  Skipping ${branchDir}: base branch (refreshed separately)`)
        continue
      }

      try {
        // Load metadata before any git ops to check branch status
        const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
        const branchStatus = metaFile?.branch.status

        // Skip branches that shouldn't be mutated:
        // - submitted/approved: in review, don't rewrite history under an
        //   active PR -- but do poll GitHub for the PR's resolution, since
        //   nothing else tells the worker a merge/close happened.
        // - archived: already merged, no reason to rebase and no PR left to
        //   poll (avoid the wasted API call).
        if (branchStatus === 'submitted' || branchStatus === 'approved') {
          console.log(`  Skipping ${branchDir} (${branchStatus})`)
          await this.pollMergeState(branchDir, branchPath, metaFile)
          continue
        }
        if (branchStatus === 'archived') {
          console.log(`  Skipping ${branchDir} (${branchStatus})`)
          continue
        }

        const branchGit = simpleGit({
          baseDir: branchPath,
          // Keep git non-interactive during rebase/merge so it never blocks on an editor.
          // simple-git >=3.32 blocks setting core.editor unless explicitly opted in; the
          // value here is a hardcoded literal ("true", the shell no-op), not user input,
          // so enabling allowUnsafeEditor carries no injection risk.
          config: ['core.editor=true'],
          unsafe: { allowUnsafeEditor: true },
        })

        // Skip dirty branches — editor has unsaved changes that can't be rebased.
        // Note: there's a small TOCTOU window between this check and the rebase start.
        // If an editor saves between here and `git rebase`, the rebase will fail and
        // the catch block will abort safely — the branch stays behind and retries next cycle.
        const dirtyCheck = await branchGit.status()
        if (dirtyCheck.files.length > 0) {
          console.log(`  Skipping ${branchDir}: has uncommitted changes`)
          continue
        }

        await branchGit.fetch('origin', this.baseBranch)

        // Use rev-list instead of status.behind — status.behind only works when the
        // branch has an upstream tracking branch configured, which isn't guaranteed
        // (checkoutBranch fallback paths create branches without --track).
        // FETCH_HEAD, not origin/<base>: branch clones are --single-branch, so
        // no remote-tracking ref exists for a base branch other than the one
        // they were cloned from (see the base-refresh comment above).
        const behindCount = parseInt(
          (await branchGit.raw(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim(),
          10,
        )
        const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)

        if (behindCount === 0) {
          // Already in sync. This is the overwhelmingly common outcome per
          // branch per cycle (most branches are caught up most of the
          // time), so skip the save entirely when metadata already reflects
          // a clean state -- every save() now eager-regenerates the branch
          // registry (branch-metadata.ts's invalidateRegistry(), O(branch
          // count) fs reads on EFS), so an unconditional save here turns
          // every rebase cycle into O(N^2) registry work across N branches
          // for what is otherwise a true no-op. Re-load fresh (not the
          // `metaFile` snapshot from before the fetch/rev-list above) so a
          // concurrent editor-driven metadata change during that window
          // isn't clobbered by a stale skip decision.
          const currentMeta = await BranchMetadataFileManager.loadOnly(branchPath)
          const conflictStatus = currentMeta?.branch.conflictStatus
          const conflictFiles = currentMeta?.branch.conflictFiles
          const alreadyClean =
            (conflictStatus === undefined || conflictStatus === 'clean') &&
            (conflictFiles === undefined || conflictFiles.length === 0)
          if (alreadyClean) {
            continue
          }
          await meta.save({
            branch: {
              name: branchDir,
              conflictStatus: 'clean',
              conflictFiles: [],
            },
          })
          continue
        }

        console.log(`Rebasing ${branchDir} (${behindCount} commits behind)...`)

        // Resolve-and-continue loop: keep branch version for conflicting files, then continue
        // Non-conflicting files get main's changes; conflicting files keep branch version.
        const conflictedFiles: string[] = []
        let nextAction: 'start' | 'continue' | 'skip' = 'start'
        let completed = false
        const MAX_ROUNDS = 50 // safety limit against infinite loops

        for (let round = 0; round < MAX_ROUNDS && !completed; round++) {
          try {
            if (nextAction === 'start') {
              // FETCH_HEAD == the base tip fetched above (single-branch clones
              // have no origin/<base> remote-tracking ref for other branches).
              await branchGit.rebase(['FETCH_HEAD'])
            } else if (nextAction === 'continue') {
              await branchGit.rebase(['--continue'])
            } else {
              await branchGit.rebase(['--skip'])
            }
            completed = true
          } catch (rebaseErr) {
            nextAction = 'continue'
            const st = await branchGit.status()

            if (st.conflicted.length > 0) {
              // During rebase, --theirs = the branch being replayed (editor's work).
              // (git rebase reverses ours/theirs: "ours" is the rebase target, "theirs" is the branch.)
              for (const file of st.conflicted) {
                await branchGit.raw(['checkout', '--theirs', file])
                await branchGit.add(file)
                conflictedFiles.push(file)
              }
              // nextAction stays 'continue'
            } else {
              const msg = rebaseErr instanceof Error ? rebaseErr.message : ''
              if (
                msg.toLowerCase().includes('nothing to commit') ||
                msg.toLowerCase().includes('apply --skip')
              ) {
                // Empty commit after --theirs resolution — skip it
                nextAction = 'skip'
              } else {
                // Unexpected error — abort and leave branch behind.
                // We intentionally don't update conflictStatus/conflictFiles here:
                // the rebase didn't complete so we can't determine the true conflict
                // state. Previous metadata (possibly stale) is preserved until the
                // next successful rebase cycle corrects it.
                console.warn(`  Unexpected rebase error in ${branchDir}: ${msg || 'Unknown error'}`)
                await branchGit.rebase(['--abort']).catch(() => {})
                break
              }
            }
          }
        }

        if (!completed) {
          console.warn(
            `  Rebase of ${branchDir} did not complete within ${MAX_ROUNDS} rounds, aborting`,
          )
          await branchGit.rebase(['--abort']).catch(() => {})
          continue
        }

        // The rebase rewrote the branch clone's working tree — mark ContentStore
        // ID indexes rooted here stale so lookups rebuild from disk, in this
        // process and (via the on-disk generation marker) in the Lambda
        // containers sharing this filesystem.
        await invalidateBranchContentCaches(branchPath)

        // Convert file paths to ContentIds — immutable, survives slug renames.
        // Entry files have IDs in their filename (e.g., "post.slug.a1b2c3d4e5f6.mdx").
        // .collection.json files have no ID themselves (extractIdFromFilename returns null
        // for dot-prefixed files), so we extract the ID from the parent directory instead.
        // The root content directory (e.g., "content/") has no embedded ID, so we use
        // ROOT_COLLECTION_ID as a sentinel — but only for the configured contentRoot.
        const conflictIds = [...new Set(conflictedFiles)]
          .map((f) => {
            const fileId = extractIdFromFilename(path.basename(f))
            if (fileId) return fileId
            const parentDir = path.basename(path.dirname(f))
            const dirId = extractIdFromFilename(parentDir)
            if (dirId) return dirId
            // Only assign ROOT_COLLECTION_ID when the parent matches the configured
            // content root (e.g., "content"). Other unrecognized paths are filtered out.
            if (path.basename(f) === '.collection.json' && parentDir === this.contentRoot) {
              return ROOT_COLLECTION_ID
            }
            return null
          })
          .filter((id): id is ContentId => id !== null)
        const conflictIdsDeduped = [...new Set(conflictIds)]

        const hadConflicts = conflictIdsDeduped.length > 0
        console.log(
          hadConflicts
            ? `  Rebased ${branchDir} (kept branch version for ${conflictIdsDeduped.length} conflicting file(s))`
            : `  Rebased ${branchDir} successfully`,
        )
        await meta.save({
          branch: {
            name: branchDir,
            conflictStatus: hadConflicts ? 'conflicts-detected' : 'clean',
            conflictFiles: conflictIdsDeduped,
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.warn(`  Failed to sync ${branchDir}: ${message}`)
      }
    }
  }

  async refreshAuthCache(): Promise<void> {
    if (!this.running || !this.config.refreshAuthCache) return

    console.log('Refreshing auth cache...')
    try {
      await this.config.refreshAuthCache()
      console.log('Auth cache refreshed')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('Failed to refresh auth cache:', message)
    }
  }
}
