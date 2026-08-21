import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import {
  enqueueTask,
  listTasks,
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
import { sanitizeBranchName, RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { normalizeFilesystemPath } from '../paths/normalize'
import { GITHUB_TRACKING_REF_PREFIX, gitChildEnv, gitNetworkChildEnv } from '../git-manager'
import { resolveDeploymentName } from '../operating-mode/deployment-name'
import type { PullRequestState, WorkerStatusReport } from '../types'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { isNonFastForwardRejection, isRebaseInProgress, isStaleLeaseRejection } from '../utils/git'
import { writeWorkerStatus } from './worker-status'
import { workerLog, workerLogWarn, workerLogError } from './log'

// Re-exported so the AWS entrypoint (packages/canopycms-cdk/worker/index.ts)
// can prefix its own startup lines through the same helpers without adding a
// new package entrypoint - `canopycms/worker/cms-worker` already exists. Every
// line in worker.log must carry the timestamp prefix or it gets folded into
// the previous CloudWatch event; see ./log.ts.
export { workerLog, workerLogWarn, workerLogError, installWorkerLogger } from './log'

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
  /**
   * Deployment name, used to compute THIS worker's own settings branch
   * (`canopycms-settings-{deploymentName}`, default: 'prod' — matches
   * ProdStrategy's mode default in operating-mode/client-unsafe-strategy.ts,
   * the only mode the worker runs in). Two deployments can share one GitHub
   * repo with distinct settings branches; this tells the worker which one it
   * owns, so it never pushes another deployment's settings branch (see
   * `pushSettingsBranches`).
   */
  deploymentName?: string
  /**
   * Explicit settings branch name, taking precedence over `deploymentName`.
   * Mirrors the strategy's own precedence (`config.settingsBranch` short-circuits
   * `getSettingsBranchName` before `deploymentName` is consulted, see
   * operating-mode/client-unsafe-strategy.ts): an adopter who overrides
   * `settingsBranch` in canopycms.config.ts must set this too, or the worker
   * would own a branch name the Lambda never writes to.
   */
  settingsBranch?: string
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
 * [C1] Retention window for `.trash-*` branch directories left behind by the
 * admin purge action (api/admin-branch-health.ts). Matches
 * cleanupOldTasks's default task retention for consistency.
 */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000

/** Matches `.trash-{dirName}-{STAMP}` names, capturing the trailing stamp. */
const TRASH_DIR_STAMP_RE = /-(\d{8}T\d{6}Z)$/

/**
 * Parse a purge-generated `YYYYMMDDTHHMMSSZ` stamp into a Date, or null if
 * malformed. Age comes ONLY from this name-embedded stamp, never the dir's
 * own mtime -- `fs.rename` preserves the original directory's mtime, so an
 * mtime-based retention check would delete a months-stale orphan's trash on
 * the very first cleanup pass after purge.
 */
function parseTrashStamp(stamp: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

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
 * Per-cycle outcome of `rebaseActiveBranches()` (PR-W1). Folded by `syncGit()`
 * into the worker's self-reported status (`WorkerStatusReport.lastGitSync`,
 * see worker-status.ts) alongside a `durationMs` measured around the whole
 * sync cycle.
 */
interface RebaseSummary {
  /**
   * Branches that were behind and completed a rebase onto the base branch
   * (successfully, whether or not conflicts were resolved via --theirs).
   * Branches that were already up to date are NOT listed here.
   */
  rebased: string[]
  /** Branches skipped this cycle because their working tree had uncommitted changes. */
  skippedDirty: string[]
  /**
   * [SYNC-C1] Branches skipped this cycle for a content-write-lock reason,
   * either of which is a RETRY rather than a failure:
   *
   * - a content write already held the branch's cross-host content-write lock
   *   (utils/content-write-lock.ts) -- the worker yields on contention, since
   *   the editor on the other side is a person waiting on a save; or
   * - the lock was LOST mid-rebase (compromised), so the worker stopped before
   *   the next destructive git step. Only when the rebase had not completed:
   *   a completed rebase must still run its completion path, or it strands the
   *   [SYNC-H1] marker on a branch nothing will revisit.
   */
  skippedLocked: string[]
  /** Branches whose rebase attempt failed (fetch error, unexpected rebase error, or MAX_ROUNDS exceeded). */
  failed: { branch: string; error: string }[]
}

/**
 * Per-cycle outcome of `reconcileTrackedBranches()` -- the non-destructive
 * replacement for the old `+refs/heads/*:refs/heads/*` fetch refspec (see
 * `GITHUB_TRACKING_REF_PREFIX`'s doc comment for the bug this fixes). Folded
 * by `syncGit()` into the worker's self-reported status
 * (`WorkerStatusReport.lastGitSync.tracked`, see worker-status.ts).
 */
interface TrackedBranchSummary {
  /** GitHub branches with no corresponding local `refs/heads/<name>` yet -- created at GitHub's tip. */
  created: string[]
  /** Local heads that were strict ancestors of GitHub's tip -- fast-forwarded to it. */
  fastForwarded: string[]
  /**
   * Local heads AHEAD of GitHub's tip -- unpushed editor/settings work.
   * Deliberately left untouched; this is exactly what the old refspec used
   * to force-rewind or (with --prune) delete outright.
   */
  ahead: string[]
  /**
   * Local heads that diverged from GitHub's tip (neither side is an
   * ancestor of the other) -- left untouched and logged. A real collision
   * (e.g. another deployment moved the same branch name); the next push
   * attempt will be rejected non-fast-forward, which is the correct,
   * visible outcome.
   */
  diverged: string[]
  /**
   * Local heads that diverged from GitHub's tip because THIS worker's rebase
   * loop rewrote them and published the rewrite into `remote.git`, with the
   * GitHub push still outstanding (`BranchMetadata.historyRewrittenFrom` is
   * set). Structurally identical to `diverged` at the ref level, but a known,
   * self-resolving state rather than a cross-deployment collision -- kept in
   * its own bucket so the collision warning stays meaningful.
   */
  rewritten: string[]
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
  // This deployment's own settings branch — see CmsWorkerConfig.deploymentName.
  // `pushSettingsBranches` pushes ONLY this branch, never any other
  // `canopycms-settings-*` branch it happens to find locally.
  //
  // Resolved lazily by ensureSettingsBranch(), NOT in the constructor: see that
  // method's doc comment. `undefined` here means "not resolved yet", never "no
  // settings branch".
  private settingsBranchResolved?: string
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
  // PR-W1: self-reported liveness/health snapshot, written to
  // worker-status.json. Normally initialized once at the top of start();
  // see ensureStatusReport() for the lazy-init fallback.
  private statusReport?: WorkerStatusReport

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

  /**
   * Lazily get (and initialize if necessary) this worker's self-reported
   * status object (PR-W1). Normally set once, up front, at the top of
   * start(). The lazy fallback here covers two cases: (1) something in
   * start() reaching a status-write point before that normal init runs
   * (defensive -- see start()'s catch), and (2) unit tests that exercise
   * syncGit()/processTaskQueue() directly without calling start() first.
   */
  private ensureStatusReport(): WorkerStatusReport {
    if (!this.statusReport) {
      const now = new Date().toISOString()
      this.statusReport = { version: 1, startedAt: now, updatedAt: now }
    }
    return this.statusReport
  }

  /**
   * Resolve this deployment's settings branch, throwing if the infra-stamped
   * deployment name is not a valid git ref component.
   *
   * Routed through the shared resolver, not a local `?? 'prod'`: it is the
   * single definition of the env > config > mode-default precedence the Lambda
   * already follows, and the only place the resolved value is validated.
   * Without it the worker could silently own a different settings branch than
   * the Lambda writing to the same workspace -- and pushSettingsBranches would
   * then report the real branch as foreign and never push it.
   *
   * DEFERRED out of the constructor deliberately, and this is the whole point
   * of the method existing. Resolving there made the throw land during `new
   * CmsWorker(...)` (canopycms-cdk/worker/index.ts constructs before it calls
   * start()), which is BEFORE the only code that writes `lastFatalError` --
   * start()'s catch. The result was billed as "a loud startup exit" but was
   * nothing of the kind: with systemd `Type=simple` + `Restart=always` and no
   * cfn-signal, an invalid deployment name produced an invisible ~5s
   * crash-loop that `cdk deploy` reported as success while the admin panel
   * showed the worker as 'absent' with no fatal error to explain it. Resolving
   * inside start()'s try block instead means the same throw is recorded to
   * worker-status.json and surfaces in the admin panel.
   *
   * Lazy rather than start()-only so the value is still available to unit tests
   * that drive pushSettingsBranches() directly without calling start() -- the
   * same reason ensureStatusReport() above is shaped this way. Idempotent: the
   * resolver is pure, so a later call returns the identical string.
   */
  private ensureSettingsBranch(): string {
    if (this.settingsBranchResolved === undefined) {
      this.settingsBranchResolved =
        this.config.settingsBranch ??
        `${RESERVED_SETTINGS_BRANCH_PREFIX}${resolveDeploymentName({ deploymentName: this.config.deploymentName }, 'prod')}`
    }
    return this.settingsBranchResolved
  }

  async start(): Promise<void> {
    this.running = true
    workerLog('CMS Worker starting...')
    this.ensureStatusReport()

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
      // FIRST inside the try, before any I/O: an infra-stamped deployment name
      // that is not a valid git ref component throws here, where the catch
      // below records it to worker-status.json. Resolving it in the
      // constructor (as this used to) put the throw outside every
      // status-writing path -- see ensureSettingsBranch()'s doc comment.
      this.ensureSettingsBranch()

      // Ensure remote.git exists (init bare repo if first run)
      await this.ensureRemoteGit()

      // Recover any orphaned tasks from a previous crash, immediately rather
      // than waiting for the first processTaskQueue() poll (taskPollInterval,
      // default 5s) to run it. Not the only call site any more -
      // processTaskQueue() below now repeats this on every cycle; see its
      // doc comment for why a boot-only call is insufficient once the
      // worker's ASG rolls on every `cdk deploy` (CanopyCmsService's
      // UpdatePolicy).
      const recovered = await recoverOrphanedTasks(
        this.taskDir,
        this.orphanRecoveryMaxAgeMs(),
        this.log,
      )
      if (recovered > 0) {
        workerLog(`Recovered ${recovered} orphaned task(s)`)
      }

      // Run initial sync + cache refresh immediately
      const initialTasks: Promise<void>[] = [this.syncGit()]
      if (this.config.refreshAuthCache) {
        initialTasks.push(this.refreshAuthCache())
      }
      await Promise.allSettled(initialTasks)
    } catch (err) {
      // PR-W1: surface a startup failure (e.g. the empty-remote guard's
      // poisoned remote.git) to the admin panel via worker-status.json,
      // not only journald/CloudWatch. Best-effort and BEFORE releaseLock():
      // a status-write failure must never block releasing the lock.
      const report = this.ensureStatusReport()
      report.lastFatalError = {
        // [HIGH-1] Persisted to worker-status.json and served to the
        // browser by the admin panel -- must never carry the bot token
        // that a poisoned/failed git URL (buildGitHubUrl()) can embed.
        message: redactCredentials(getErrorMessage(err)),
        at: new Date().toISOString(),
        phase: 'startup',
      }
      try {
        await writeWorkerStatus(this.taskDir, report)
      } catch (writeErr) {
        workerLogError(
          'Failed to write worker status on startup failure:',
          getErrorMessage(writeErr),
        )
      }
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
      workerLog(`  Auth cache refresh: every ${cacheInterval / 1000}s`)
    }

    workerLog('CMS Worker started')
    workerLog(`  Task queue poll: every ${taskInterval / 1000}s`)
    workerLog(`  Git sync: every ${gitInterval / 1000}s`)
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
    workerLog('CMS Worker stopped')
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
          workerLogError('Worker lock compromised, shutting down:', getErrorMessage(err))
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
          workerLogError('Worker loop error:', err instanceof Error ? err.message : err)
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
   * Guarantee a bare repo's config carries NO `remote.origin.url`, and so no
   * embedded bot token.
   *
   * `git clone https://x-access-token:<token>@github.com/...` records that URL
   * verbatim as `remote.origin.url`, and for `remote.git` that config lives on
   * shared EFS. The security model in docs/deploying-to-aws.md -- "If Lambda is
   * compromised, an attacker can read/write content on EFS but cannot push to
   * GitHub", "Secrets stay on the worker" -- is false while that string is
   * there: a compromised Lambda could read the token off EFS and, despite
   * having no egress of its own, exfiltrate it by writing it into branch
   * content the worker then pushes to GitHub.
   *
   * Nothing needs the remote: every push passes the URL explicitly as an
   * argument (see the `git.push(this.buildGitHubUrl(), ...)` call sites), and
   * `verifyBaseBranchExists` reads local refs.
   *
   * VERIFIES rather than assuming: it re-reads the config and throws if the URL
   * survives, because the previous code's `.catch(() => {})` meant a failed
   * scrub was indistinguishable from a successful one.
   */
  private async scrubPersistedRemote(gitDir: string): Promise<void> {
    const git = simpleGit({ baseDir: gitDir })
    // `git config --get` exits 1 with no output when the key is absent.
    // simple-git does NOT reliably throw on that -- verified against
    // simple-git 3.36: it resolves with an empty string -- so an empty result
    // must be read as "absent" too. Treating "" as a surviving URL is what
    // made the first version of this reject every clean scrub.
    //
    // 'unreadable' is deliberately distinct from 'absent'. A read that fails
    // for any OTHER reason must not be mistaken for "no token here": that
    // would let the pre-check below short-circuit and skip the scrub entirely,
    // silently leaving a token-bearing config on shared EFS -- the exact
    // outcome this function exists to prevent. Fail closed and attempt the
    // removal instead.
    const readOriginUrl = async (): Promise<string | null | 'unreadable'> => {
      try {
        const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim()
        return url === '' ? null : url
      } catch (err: unknown) {
        // Exit code 1 is git's documented "key not found" for `--get`.
        const message = getErrorMessage(err)
        const isKeyAbsent = /exit code=1\b/.test(message) || message.trim() === ''
        return isKeyAbsent ? null : 'unreadable'
      }
    }

    const before = await readOriginUrl()
    if (before === null) return
    if (before === 'unreadable') {
      workerLogWarn(
        `  Could not read remote.origin.url in ${gitDir}; attempting the scrub anyway rather than assuming it is absent`,
      )
    }

    try {
      await git.removeRemote('origin')
    } catch (err: unknown) {
      // Reached only from the 'unreadable' path, where the remote may in fact
      // not exist. Let the verification below decide rather than failing here:
      // it is the authoritative check, and it fails closed.
      workerLogWarn(
        `  removeRemote('origin') failed in ${gitDir}: ${getErrorMessage(err)} -- verifying directly`,
      )
    }

    // Fails closed on BOTH a surviving URL and an unverifiable read: if we
    // cannot prove the token is gone from shared storage, we do not proceed.
    const remaining = await readOriginUrl()
    if (remaining !== null) {
      throw new Error(
        `Could not confirm the 'origin' remote is gone from ${gitDir} (${
          remaining === 'unreadable'
            ? 'its config was unreadable'
            : 'its config still records a URL'
        }). For a token-bearing clone URL that means the GitHub bot token may be persisted on ` +
          `shared storage. Refusing to continue.`,
      )
    }
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
      // SELF-HEAL, before anything else touches this repo. The previous
      // already-exists path fast-returned without ever re-checking the config,
      // so a token that survived one scrub survived forever -- and a clone
      // interrupted by SIGKILL/power-off between `git clone` and the scrub left
      // a repo whose config already held the token, which additionally hit the
      // "delete remote.git and restart" refusal below and so sat on EFS until
      // an operator acted.
      await this.scrubPersistedRemote(this.remoteGitPath)

      try {
        await this.verifyBaseBranchExists(this.remoteGitPath)
      } catch (err) {
        workerLogError(`remote.git base branch verification failed: ${getErrorMessage(err)}`)
        // Do NOT auto-delete: an existing remote.git could hold unpushed
        // canopycms-settings-* branches or other state worth preserving.
        // Deletion here is the operator's call, not ours.
        throw new Error(
          `remote.git at ${this.remoteGitPath} has no branch '${this.baseBranch}' (likely cloned while the GitHub repo was empty). Delete ${this.remoteGitPath} and restart the worker to re-clone.`,
        )
      }
      return // Already exists and has the base branch
    }

    workerLog('Initializing remote.git from GitHub...')
    const git = simpleGit()

    // Clone under a TEMP name and rename into place only once the token has
    // been scrubbed and the repo verified, so `remote.git` never exists on EFS
    // in a token-bearing state. A crash mid-clone now leaves only this staging
    // directory, which the next boot deletes -- rather than a poisoned
    // `remote.git` that fs.stat cannot distinguish from a healthy one.
    const stagingPath = `${this.remoteGitPath}.cloning`
    await fs.rm(stagingPath, { recursive: true, force: true })

    try {
      await git.clone(this.buildGitHubUrl(), stagingPath, ['--bare'])

      // Before the rename, so the token is gone from the config the moment the
      // repo becomes reachable under its real name. Throws (rather than
      // swallowing) if the scrub does not take.
      await this.scrubPersistedRemote(stagingPath)

      await this.verifyBaseBranchExists(stagingPath)
    } catch (err) {
      workerLogError(`remote.git clone failed: ${redactCredentials(getErrorMessage(err))}`)
      // Deleting before throwing is what makes this recoverable: the next
      // start() sees no remote.git and re-clones, instead of being stuck
      // forever behind a poisoned bare repo that fs.stat alone can't detect.
      await fs.rm(stagingPath, { recursive: true, force: true })
      throw new Error(
        `remote.git clone of ${this.config.githubOwner}/${this.config.githubRepo} failed or has no branch '${this.baseBranch}' - the GitHub repository may be empty, or the base branch may not exist. Push an initial commit to '${this.baseBranch}' and restart the worker (systemd will retry automatically).`,
      )
    }

    await fs.rename(stagingPath, this.remoteGitPath)
    workerLog('remote.git initialized')
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
  private orphanRecoveryMaxAgeMs(): number {
    return Math.max(5 * 60_000, this.taskTimeoutMs * 2)
  }

  /**
   * Process queued tasks from Lambda.
   * Polls .tasks/pending/ directory and executes each task.
   * Processes up to maxTasksPerCycle tasks per invocation.
   * Retries transient failures with exponential backoff.
   */
  async processTaskQueue(): Promise<void> {
    if (!this.running) return

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
    const recovered = await recoverOrphanedTasks(
      this.taskDir,
      this.orphanRecoveryMaxAgeMs(),
      this.log,
    )
    if (recovered > 0) {
      workerLog(`Recovered ${recovered} orphaned task(s)`)
    }

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
        workerLogError(`Task ${task.id} (${task.action}) failed:`, message)

        // [HIGH-1] task.error is persisted (pending/failed task JSON) and
        // served to the browser by the admin panel's Tasks tab -- a push
        // failure's message can embed the bot token via buildGitHubUrl().
        // Console output above stays raw (journald/CloudWatch is trusted).
        const persistedMessage = redactCredentials(message)

        // DEP-L1: only transient failures (network, 429/5xx, timeouts) are
        // worth retrying; permanent ones (malformed payload, other 4xx) would
        // just burn the retry budget on an identical doomed request.
        const permanent = isPermanentTaskFailure(err)
        const retryCount = task.retryCount ?? 0
        const maxRetries = task.maxRetries ?? this.maxRetries
        if (!permanent && retryCount < maxRetries) {
          await retryTask(this.taskDir, task.id, persistedMessage, this.log)
          workerLog(`  Will retry (attempt ${retryCount + 1}/${maxRetries})`)
        } else {
          await failTask(this.taskDir, task.id, persistedMessage, this.log)
          await this.updateBranchMetadataOnFailure(task, persistedMessage)
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
      const report = this.ensureStatusReport()
      report.lastTaskCycleAt = new Date().toISOString()
      await writeWorkerStatus(this.taskDir, report).catch((writeErr) =>
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
        workerLog(`Created PR #${pr.data.number} for ${branch}`)
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
        const base = optionalString(payload, 'baseBranch', this.baseBranch)
        // Defense-in-depth: refuse head===base even if the 'submittableBranch'
        // API guard and the syncSubmitPr backstop were both somehow bypassed
        // (e.g. a task queued before this check shipped). PermanentTaskError
        // (not a plain Error) so this fails immediately instead of burning
        // the retry budget on an identical doomed request -- retrying can
        // never make the branch not be the base branch.
        if (sanitizeBranchName(branch) === this.sanitizedBaseBranch) {
          throw new PermanentTaskError(
            `Refusing to push-and-create-or-update-pr for "${branch}": it is the base branch -- submitting the base branch is never valid`,
          )
        }
        await this.pushBranchToGitHub(branch)

        const result = await createOrUpdatePullRequest({
          octokit: this.octokit,
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
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
        workerLog(`Converted PR #${draftPrNumber} to draft`)
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

    const branchPath = this.branchWorkspacePath(branch)
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
   * by the caller, processTaskQueue -- see [HIGH-1] there) as
   * syncFailureReason, so the editor can show WHY, not just that it failed.
   */
  private async updateBranchMetadataOnFailure(task: Task, error: string): Promise<void> {
    const branch = typeof task.payload.branch === 'string' ? task.payload.branch : null
    if (!branch) return

    const branchPath = this.branchWorkspacePath(branch)
    try {
      await fs.stat(branchPath)
    } catch {
      return
    }

    try {
      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
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

  private buildGitHubUrl(): string {
    return `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  /**
   * The workspace directory for a branch named by its GIT REF name -- the
   * form task payloads carry (`context.branch.name`), not the directory form.
   *
   * These differ for any name outside `[A-Za-z0-9._-]`, `/` being the obvious
   * one: workspaces are provisioned under `sanitizeBranchName(...)` (see
   * paths/branch.ts's `resolveBranchPaths`), so `feature/x` lives in
   * `feature-x`. Joining the raw name instead silently addresses a directory
   * that does not exist -- which for the metadata writers below meant the
   * update was quietly dropped, and for the leased push meant the
   * history-rewrite marker read as absent and the push went out unleased,
   * wedging exactly the branch this workstream exists to unwedge.
   *
   * `name` inside the metadata itself stays the raw ref name; only the path
   * is sanitized.
   */
  private branchWorkspacePath(branchRefName: string): string {
    return path.join(this.contentBranchesPath, sanitizeBranchName(branchRefName))
  }

  /**
   * What `remote.git` currently holds for `branchRef`, or null when this
   * branch was never published there (never submitted) or the ref is
   * unreadable.
   *
   * Uses the same explicit `--git-dir` shape as verifyBaseBranchExists()
   * above: reading a bare repo that way does not depend on
   * `safe.bareRepository` being permissive, which is why prod code takes
   * this route rather than the config override the test-only `openBareRepo`
   * helper uses.
   */
  private async readPublishedSha(branchRef: string): Promise<string | null> {
    try {
      const out = await simpleGit().raw([
        '--git-dir',
        this.remoteGitPath,
        'rev-parse',
        '--verify',
        `refs/heads/${branchRef}`,
      ])
      const sha = out.trim()
      return sha.length > 0 ? sha : null
    } catch {
      // Absent from remote.git: this branch was never submitted, so none of
      // its history was ever published. Not an error.
      return null
    }
  }

  /**
   * Record that this worker rewrote `expectedSha` out of a branch's already
   * published history (see BranchMetadata.historyRewrittenFrom).
   *
   * Set-once: if a marker is already present it is LEFT ALONE. Across two
   * rebases before any GitHub push lands, GitHub still holds the commit the
   * FIRST rebase replaced, so advancing the marker would aim the lease at a
   * commit GitHub never had and permanently wedge the branch.
   *
   * Re-reads metadata rather than trusting the caller's loop-top snapshot:
   * the task loop runs concurrently with syncGit() (see scheduleLoop) and may
   * have cleared the marker while this branch was rebasing.
   */
  private async markHistoryRewritten(
    branchPath: string,
    branchDir: string,
    expectedSha: string,
  ): Promise<void> {
    const current = await BranchMetadataFileManager.loadOnly(branchPath)
    if (typeof current?.branch.historyRewrittenFrom === 'string') return
    const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
    await meta.save({ branch: { name: branchDir, historyRewrittenFrom: expectedSha } })
  }

  /**
   * Clear the marker once GitHub is confirmed to hold the rewritten history.
   *
   * Best-effort only in the sense that a failure here destroys nothing: the
   * lease still refuses anything unexpected, and the plain-push fallback only
   * ever fast-forwards. It is NOT harmless. A marker that outlives its
   * episode can wedge the NEXT one -- if the base advances before the stale
   * marker is revisited, the queued push leases a commit GitHub has already
   * moved off, falls back to a plain push of a rebased (non-ancestor)
   * history, and fails permanently with a "something else moved it on
   * GitHub" diagnosis that is false: we did.
   *
   * Tracked, with the concurrent-clear race that can drop a marker
   * mid-arming, in
   * .claude/future-tasks/worker-history-rewrite-marker-races.md.
   */
  private async clearHistoryRewrittenMarker(branchPath: string, branchDir: string): Promise<void> {
    try {
      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
      // Explicit undefined clears the key -- save()'s merge only overwrites
      // keys present in the update (same pattern as rebaseFailure).
      await meta.save({ branch: { name: branchDir, historyRewrittenFrom: undefined } })
    } catch (err) {
      workerLogWarn(
        `  Failed to clear history-rewrite marker for ${branchDir}: ${getErrorMessage(err)}`,
      )
    }
  }

  /**
   * Publish a branch clone's rebased history into `remote.git`, replacing
   * EXACTLY `expectedSha` and nothing else.
   *
   * The lease is the entire safety argument. `--force-with-lease=<ref>:<sha>`
   * refuses unless `remote.git` still stands at `<sha>`, so this can only
   * ever undo the commit our own rebase rewrote away. Callers must never pass
   * "whatever remote.git currently holds" -- see the arming guard in
   * rebaseActiveBranches() for the interleaving where that would silently
   * delete a reviewer's direct push.
   *
   * Returns whether the push landed. A refused lease means a concurrent
   * Lambda push moved the ref; that is logged and retried by the self-heal
   * pass on a later cycle, never thrown.
   */
  private async forcePublishToLocalRemote(
    branchPath: string,
    branchRef: string,
    expectedSha: string,
  ): Promise<boolean> {
    // A dedicated instance rather than the caller's: `.env()` replaces the
    // whole child environment, and the rebase loop's instance must keep its
    // ambient one. gitChildEnv (not gitNetworkChildEnv) because this push
    // targets the local bare repo -- and the locale pin is what keeps
    // isStaleLeaseRejection below from silently becoming a no-op.
    const pushGit = simpleGit({ baseDir: branchPath, timeout: { block: this.taskTimeoutMs } })
    pushGit.env(gitChildEnv({}))
    try {
      await pushGit.raw([
        'push',
        `--force-with-lease=${branchRef}:${expectedSha}`,
        // Real flags must precede --end-of-options; everything after it is
        // positional (see GitManager.push() for the same guard).
        '--end-of-options',
        'origin',
        `${branchRef}:${branchRef}`,
      ])
      workerLog(`  Published rebased ${branchRef} into remote.git`)
      return true
    } catch (err) {
      const message = redactCredentials(getErrorMessage(err))
      workerLogWarn(
        isStaleLeaseRejection(message)
          ? `  Did not publish rebased ${branchRef} into remote.git: it moved since this cycle read it (concurrent submit?) -- retrying next cycle`
          : `  Failed to publish rebased ${branchRef} into remote.git: ${message}`,
      )
      return false
    }
  }

  /**
   * Queue the GitHub hop for a branch whose rewritten history now sits in
   * `remote.git`, so an open PR's head follows the rebase within a cycle
   * instead of waiting for the editor's next submit.
   *
   * Deliberately NOT skipped when a marker is already set: inferring "a task
   * must already be queued" from the marker starves this hop whenever a task
   * was lost, failed permanently, or was never written. Duplicate push tasks
   * are bounded by base-branch advances and are idempotent (a repeat push is
   * a no-op once GitHub holds the tip).
   */
  private async enqueueGitHubPush(branchRef: string): Promise<void> {
    try {
      // Dedupe against tasks actually in flight rather than against the
      // marker: a branch whose GitHub push keeps failing would otherwise
      // gain one task per sync cycle forever.
      for (const status of ['pending', 'processing'] as const) {
        const inFlight = await listTasks(this.taskDir, status)
        if (inFlight.some((t) => t.action === 'push-branch' && t.payload.branch === branchRef)) {
          return
        }
      }
      await enqueueTask(this.taskDir, { action: 'push-branch', payload: { branch: branchRef } })
      workerLog(`  Queued GitHub push for ${branchRef}`)
    } catch (err) {
      workerLogWarn(`  Failed to queue GitHub push for ${branchRef}: ${getErrorMessage(err)}`)
    }
  }

  /**
   * Complete a rewrite this worker started but did not finish: get the
   * rebased history into `remote.git` and queued for GitHub.
   *
   * Runs from the rebase loop for any branch carrying a marker, whether or
   * not it is behind base this cycle, so an interrupted publish converges
   * without waiting for the next base-branch advance.
   *
   * Always leases on the MARKER, never on remote.git's current tip -- the
   * marker is the one commit we know our own rebase replaced.
   */
  private async reconcilePendingRewrite(options: {
    branchPath: string
    branchDir: string
    branchRef: string
    headSha: string
    marker: string
  }): Promise<void> {
    const { branchPath, branchDir, branchRef, headSha, marker } = options
    const publishedSha = await this.readPublishedSha(branchRef)

    if (publishedSha === null) {
      workerLogWarn(
        `  ${branchDir}: a rewritten history is recorded but ${branchRef} is gone from remote.git -- nothing to publish`,
      )
      return
    }
    if (publishedSha === headSha) {
      // remote.git already carries the rewrite; only the GitHub hop is left
      // (a crash between the push and the queue, or a task that was lost).
      await this.enqueueGitHubPush(branchRef)
      return
    }
    if (publishedSha === marker) {
      // The publish into remote.git never landed -- a crash right after the
      // marker was written, or a lease refused by a concurrent submit.
      if (await this.forcePublishToLocalRemote(branchPath, branchRef, marker)) {
        await this.enqueueGitHubPush(branchRef)
      }
      return
    }
    // Neither this branch's rebased tip nor the commit its rewrite replaced:
    // something else moved remote.git. Never force over that.
    workerLogWarn(
      `  ${branchDir}: remote.git is at ${publishedSha} for ${branchRef}, which is neither the ` +
        `rebased tip nor the commit the rewrite replaced -- left untouched`,
    )
  }

  private async pushBranchToGitHub(branch: string): Promise<void> {
    const git = simpleGit({
      baseDir: this.remoteGitPath,
      // DEP-H1: kill the git process if it produces no output for
      // taskTimeoutMs (network stall, credential prompt) instead of letting
      // it hang past the task timeout.
      timeout: { block: this.taskTimeoutMs },
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
    const branchPath = this.branchWorkspacePath(branch)
    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath).catch(() => null)
    const marker = metaFile?.branch.historyRewrittenFrom
    // What this push will actually send: remote.git's tip for the branch.
    const outgoingSha = await this.readPublishedSha(branch)

    try {
      if (marker) {
        await git.raw([
          'push',
          `--force-with-lease=${branch}:${marker}`,
          '--end-of-options',
          this.buildGitHubUrl(),
          `${branch}:${branch}`,
        ])
      } else {
        // Pass URL directly to avoid persisting the token in remote.git/config
        await git.push(this.buildGitHubUrl(), branch)
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
          await git.push(this.buildGitHubUrl(), branch)
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
        await this.clearHistoryRewrittenMarker(branchPath, branch)
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
      await this.clearHistoryRewrittenMarker(branchPath, branch)
    }
    workerLog(`Pushed ${branch} to GitHub`)
  }

  /**
   * Push THIS deployment's own settings branch (`ensureSettingsBranch()`) from
   * remote.git to GitHub. Non-fatal: a no-op push for an up-to-date branch
   * just succeeds quietly.
   *
   * Deliberately narrowed to one branch — this used to push EVERY local
   * branch matching `canopycms-settings-*`. With the tracking-namespace fetch
   * fix (GITHUB_TRACKING_REF_PREFIX), `reconcileTrackedBranches` creates local
   * heads for branches that exist on GitHub, so ANOTHER deployment's settings
   * branch (sharing this same GitHub repo) can legitimately show up as a
   * local head here too. Pushing it would be this deployment shipping
   * settings state it doesn't own.
   */
  private async pushSettingsBranches(
    git: ReturnType<typeof simpleGit>,
    trackedNames: ReadonlySet<string>,
  ): Promise<void> {
    try {
      // Resolved once here rather than at each use below: ensureSettingsBranch()
      // is idempotent, but a local reads better and keeps the eight references
      // in this method obviously talking about one value.
      const settingsBranch = this.ensureSettingsBranch()
      const branches = await git.branch()
      const settingsBranches = branches.all.filter((b) =>
        b.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX),
      )
      const foreign = settingsBranches.filter((b) => b !== settingsBranch)
      if (foreign.length > 0) {
        // Signal, not an error: this is exactly the "two deployments, one repo"
        // condition this workstream exists to make visible. Never push these.
        workerLogWarn(
          `Found settings branch(es) not owned by this deployment (${settingsBranch}): ` +
            `${foreign.join(', ')}. Another CanopyCMS deployment may share this GitHub repo. Not pushing them.`,
        )
      }

      // Check the full branch list, not the `canopycms-settings-*` subset: an
      // adopter-supplied `settingsBranch` override need not carry that prefix.
      const ownBranchMissing = !branches.all.includes(settingsBranch)

      // [SYNC-M3] A settings branch present in remote.git but absent from
      // GitHub's tracking refs was pushed here LOCALLY -- only this
      // deployment's own API can write to remote.git -- and has never
      // reached GitHub. That is the discriminating signature: in the
      // SUPPORTED two-deployments-one-repo case the foreign branch arrives
      // through the GitHub fetch and therefore always has a tracking ref, so
      // the warn above cannot tell the two apart on its own and a
      // "owned-branch-absent" test alone would fire on every deployment that
      // simply has not had a settings edit yet.
      //
      // With this deployment's own branch also missing, the API and this
      // worker have resolved different deploymentNames, and every settings
      // change the API commits is stranded in remote.git forever.
      const strandedLocal = foreign.filter((b) => !trackedNames.has(b))
      if (strandedLocal.length > 0) {
        workerLogWarn(
          ownBranchMissing
            ? `Settings branch mismatch: this worker owns "${settingsBranch}", which does not ` +
                `exist in remote.git, while ${strandedLocal.join(', ')} exist(s) here and has never ` +
                `been pushed to GitHub. The API and this worker disagree about deploymentName, so ` +
                `settings changes are NOT reaching GitHub. Set CANOPYCMS_DEPLOYMENT_NAME (or ` +
                `settingsBranch) on this worker to match what the API resolves.`
            : `Settings branch(es) ${strandedLocal.join(', ')} exist in remote.git but not on ` +
                `GitHub, and are not owned by this deployment (${settingsBranch}) -- nothing ` +
                `will ever push them onward. Check that deploymentName matches across this ` +
                `deployment's API and worker.`,
        )
      }

      if (ownBranchMissing) {
        // Not created locally yet — nothing to push.
        return
      }

      try {
        await git.push(this.buildGitHubUrl(), settingsBranch)
        workerLog(`Pushed settings branch ${settingsBranch} to GitHub`)
      } catch (err) {
        // Non-fatal: branch may already be up-to-date. This call site has no
        // task to throw a PermanentTaskError into (unlike pushBranchToGitHub)
        // and is deliberately not restructured to add one -- but a
        // non-fast-forward rejection here is the highest-signal instance of
        // this whole failure class: it means another CanopyCMS deployment's
        // worker already pushed ITS OWN state to its own settings branch on
        // GitHub (an actual settings-branch name collision, not just the
        // "foreign branch found locally" case warned about above), so make
        // that explicit instead of a generic "push failed" line.
        const message = getErrorMessage(err)
        if (isNonFastForwardRejection(message)) {
          workerLogWarn(
            `Settings push for ${settingsBranch} was rejected (non-fast-forward): another ` +
              `CanopyCMS deployment appears to own this settings branch on GitHub. Settings from ` +
              `that deployment will NOT be overwritten; this deployment's local settings changes ` +
              `were not pushed. Rename this deployment's settings branch (config.settingsBranch or ` +
              `deploymentName) to resolve the collision.`,
          )
        } else {
          workerLogWarn(`Settings push for ${settingsBranch}:`, message)
        }
      }
    } catch (err) {
      workerLogWarn(
        'Failed to list branches for settings push:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  /**
   * Bring `refs/heads/*` in `remote.git` toward what was just fetched into
   * `GITHUB_TRACKING_REF_PREFIX` -- WITHOUT ever force-rewinding or deleting
   * a local head. This is the non-destructive replacement for what the old
   * `+refs/heads/*:refs/heads/*` fetch refspec used to do implicitly (and
   * destructively) as part of the fetch itself; see
   * `GITHUB_TRACKING_REF_PREFIX`'s doc comment for the two failure modes
   * that refspec caused.
   *
   * Per tracked branch:
   * - no local `refs/heads/<name>` yet -> create it at the tracked commit
   *   (a branch created on GitHub, or by another deployment sharing this
   *   GitHub repo, becomes visible locally).
   * - local is a strict ancestor of tracked (behind) -> fast-forward it.
   * - local === tracked -> nothing to do.
   * - tracked is a strict ancestor of local (ahead) -> LEAVE IT ALONE. This
   *   is unpushed editor/settings work; the queued push task (or
   *   pushSettingsBranches) ships it. This is exactly the branch state the
   *   old refspec used to destroy.
   * - neither is an ancestor of the other (diverged) -> LEAVE IT ALONE and
   *   count/log it. A real collision (e.g. another deployment moved the
   *   same branch name on GitHub); the next push attempt will be rejected
   *   non-fast-forward, which is the correct, visible outcome -- this
   *   method must never silently pick a winner. The one expected, benign
   *   form of this -- our own rebase loop having published a rewrite into
   *   remote.git with the GitHub push still queued -- is split out into the
   *   `rewritten` bucket so the collision warning stays meaningful.
   *
   * Never deletes a local head: a branch removed on GitHub simply stops
   * being tracked here; the local ref persists until removed through its
   * own explicit path (the sync loop must not be one of them).
   *
   * `remote.git` is bare, so there is no worktree to invalidate by moving
   * these refs -- unlike a non-bare repo, updating the ref that happens to
   * be "checked out" is a non-issue here.
   *
   * Concurrency: `remote.git` is bare and on EFS, and the Lambda pushes into
   * it concurrently (`GitManager.push()`'s `target:target` refspec) while
   * this runs. Every `update-ref` below passes the expected old value (the
   * all-zeros OID for "must not exist yet" on creation, the previously-read
   * SHA for the fast-forward case) so a concurrent Lambda write landing in
   * the gap between the read and the write loses the ref update instead of
   * being silently clobbered -- the branch is simply revisited next cycle.
   */
  private async reconcileTrackedBranches(
    git: ReturnType<typeof simpleGit>,
  ): Promise<{ summary: TrackedBranchSummary; trackedNames: Set<string> }> {
    const GIT_ZERO_OID = '0000000000000000000000000000000000000000'
    const created: string[] = []
    const fastForwarded: string[] = []
    const ahead: string[] = []
    const diverged: string[] = []
    const rewritten: string[] = []

    // One invocation enumerates both namespaces: refs/heads/<name> (what the
    // Lambda pushes into and branch clones read from) and
    // GITHUB_TRACKING_REF_PREFIX<name> (GitHub's tip, just fetched above).
    const raw = await git.raw([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/',
      GITHUB_TRACKING_REF_PREFIX,
    ])

    const heads = new Map<string, string>()
    const tracked = new Map<string, string>()
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [refname, sha] = trimmed.split(' ')
      if (refname.startsWith('refs/heads/')) {
        heads.set(refname.slice('refs/heads/'.length), sha)
      } else if (refname.startsWith(GITHUB_TRACKING_REF_PREFIX)) {
        tracked.set(refname.slice(GITHUB_TRACKING_REF_PREFIX.length), sha)
      }
    }

    for (const [name, trackedSha] of tracked) {
      const localSha = heads.get(name)
      const localRef = `refs/heads/${name}`

      if (!localSha) {
        try {
          // Zero old-value asserts the ref does not already exist -- guards
          // against a concurrent Lambda push creating this exact branch
          // name between the for-each-ref read above and this update.
          await git.raw(['update-ref', localRef, trackedSha, GIT_ZERO_OID])
          created.push(name)
        } catch (err) {
          workerLogWarn(
            `  Tracked-branch reconcile: failed to create local ref for ${name} (concurrent update?): ${getErrorMessage(err)}`,
          )
        }
        continue
      }

      if (localSha === trackedSha) continue // nothing to do

      // [SYNC-M2] Everything below is per-branch best-effort. The rev-list
      // used to sit between the two guarded update-ref calls with no guard
      // of its own, so a single ref pointing at a missing or partially
      // written object -- plausible on EFS with the Lambda writing
      // concurrently -- threw out of this loop, out of syncGit()'s try, and
      // skipped pushSettingsBranches(), refreshBaseBranchWorkspace() and
      // rebaseActiveBranches() entirely. Nothing self-healed, so it recurred
      // every cycle. One unreadable ref must cost its own branch, not the
      // whole sync cycle.
      try {
        // Count commits unique to each side in one call: left = commits local
        // has that tracked doesn't (ahead), right = commits tracked has that
        // local doesn't (behind). Exits 0 regardless of ancestry direction,
        // unlike `merge-base --is-ancestor` (which simple-git would throw on
        // a non-zero exit for the common "not an ancestor" case).
        const counts = (
          await git.raw(['rev-list', '--left-right', '--count', `${localSha}...${trackedSha}`])
        ).trim()
        const [leftStr, rightStr] = counts.split(/\s+/)
        const localAheadCount = parseInt(leftStr, 10)
        const localBehindCount = parseInt(rightStr, 10)

        if (!Number.isInteger(localAheadCount) || !Number.isInteger(localBehindCount)) {
          // Unparseable output means we could not read this branch, NOT that
          // it diverged: falling through to the `diverged` bucket below would
          // warn operators about a cross-deployment collision that never
          // happened (parseInt yields NaN, and NaN fails both comparisons).
          workerLogWarn(
            `  Tracked-branch reconcile: skipping ${name}: unparseable rev-list output ${JSON.stringify(counts)}`,
          )
          continue
        }

        if (localAheadCount === 0 && localBehindCount > 0) {
          try {
            await git.raw(['update-ref', localRef, trackedSha, localSha])
            fastForwarded.push(name)
          } catch (err) {
            // Concurrent Lambda push moved the ref since the read above --
            // the guard did its job; this branch is simply revisited next cycle.
            workerLogWarn(
              `  Tracked-branch reconcile: failed to fast-forward ${name} (concurrent update?): ${getErrorMessage(err)}`,
            )
          }
        } else if (localBehindCount === 0 && localAheadCount > 0) {
          // Unpushed local work -- exactly what the old destructive refspec
          // used to force-rewind or delete. Leave it.
          ahead.push(name)
        } else if (await this.hasPendingHistoryRewrite(name)) {
          // [SYNC-H1] Our own rebase published a rewrite into remote.git and
          // the GitHub push has not landed yet. Ref-level this is identical
          // to a collision, but it is expected and self-resolving, so it must
          // not fire the collision warning below.
          rewritten.push(name)
        } else {
          // Neither side is an ancestor of the other. Leave both alone.
          diverged.push(name)
        }
      } catch (err) {
        workerLogWarn(
          `  Tracked-branch reconcile: skipping ${name} (unreadable ref or object?): ${getErrorMessage(err)}`,
        )
        continue
      }
    }

    if (diverged.length > 0) {
      workerLogWarn(
        `  Tracked-branch reconcile: ${diverged.length} branch(es) diverged from GitHub and were left untouched: ${diverged.join(', ')}`,
      )
    }
    if (rewritten.length > 0) {
      workerLog(
        `  Tracked-branch reconcile: ${rewritten.length} branch(es) rebased locally with the GitHub push still pending: ${rewritten.join(', ')}`,
      )
    }

    // trackedNames is returned alongside the summary (rather than folded into
    // it) because it is a working set for pushSettingsBranches' stranded-
    // branch check, not part of the worker-status snapshot -- it lists every
    // branch on GitHub and would bloat worker-status.json for no reader.
    return {
      summary: { created, fastForwarded, ahead, diverged, rewritten },
      trackedNames: new Set(tracked.keys()),
    }
  }

  /**
   * Whether this branch carries a pending history rewrite -- the rebase loop
   * rewrote already-published history and the GitHub push has not landed yet
   * (see BranchMetadata.historyRewrittenFrom).
   *
   * `branchName` is a git ref name; branch workspaces are directories named
   * with the sanitized form, hence the conversion. Best-effort: a settings
   * branch (no workspace at all), a missing directory or an unreadable
   * branch.json all mean "no known rewrite", which is the conservative
   * answer -- it keeps the branch in the louder `diverged` bucket.
   */
  private async hasPendingHistoryRewrite(branchName: string): Promise<boolean> {
    try {
      const branchPath = path.join(this.contentBranchesPath, sanitizeBranchName(branchName))
      const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
      return typeof metaFile?.branch.historyRewrittenFrom === 'string'
    } catch {
      return false
    }
  }

  async syncGit(): Promise<void> {
    if (!this.running) return

    workerLog('Syncing git...')
    const cycleStartedAt = Date.now()
    const git = simpleGit({
      baseDir: this.remoteGitPath,
      // DEP-H1: a hung fetch/push would stall the sync loop forever
      // (scheduleLoop only reschedules after completion). The block timeout
      // is inactivity-based, so a slow-but-flowing transfer is unaffected.
      timeout: { block: this.taskTimeoutMs },
    })
    // This instance also drives pushSettingsBranches(git) below, whose
    // classification of a rejected settings-branch push (see that method)
    // needs the same stable-English guarantee as pushBranchToGitHub. Network
    // env for the same reason: the fetch and push here reach GitHub.
    git.env(gitNetworkChildEnv())

    // PR-W1: the whole cycle is wrapped so both outcomes -- success and
    // hard failure (e.g. the fetch throwing against a poisoned remote.git)
    // -- record a worker-status.json snapshot. The status write itself is
    // always best-effort (.catch below): it must never turn an otherwise
    // successful cycle into a failure, and must never mask the real error
    // on a failed one. On failure we rethrow so scheduleLoop's existing
    // per-cycle catch stays the loud path.
    try {
      // Fetch all branches from GitHub using direct URL (no named remote),
      // into the GITHUB_TRACKING_REF_PREFIX remote-tracking namespace rather
      // than refs/heads/* directly -- see that constant's doc comment for
      // the destructive-fetch bug this avoids. We use raw git commands since
      // simple-git's fetch() with a URL doesn't support --prune directly.
      await git.raw([
        'fetch',
        this.buildGitHubUrl(),
        '--prune',
        `+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`,
      ])
      workerLog('Fetched from GitHub')

      // Bring refs/heads/* toward what was just fetched, WITHOUT ever
      // force-rewinding or deleting a local head -- see
      // reconcileTrackedBranches()'s doc comment.
      const { summary: trackedSummary, trackedNames } = await this.reconcileTrackedBranches(git)

      // Push settings branches to GitHub (belt-and-suspenders for task queue).
      // Ensures settings reach GitHub even if a task queue entry is lost.
      // Ordering relative to the fetch/reconcile above is no longer a
      // correctness dependency now that the fetch can't clobber refs/heads/*
      // -- this could run before or after them just as safely.
      await this.pushSettingsBranches(git, trackedNames)

      await this.refreshBaseBranchWorkspace()

      const rebaseSummary = await this.rebaseActiveBranches()

      // Periodically clean up old completed/failed tasks
      await cleanupOldTasks(this.taskDir, undefined, this.log)

      // [C1] Sweep branch directories the admin purge action trashed more
      // than TRASH_RETENTION_MS ago. Worker-only by design: purge itself
      // never deletes anything (reversible), and this cycle is the sole
      // place actual removal happens.
      const trashRemoved = await this.cleanupTrashedBranchDirs()
      if (trashRemoved > 0) {
        workerLog(`Removed ${trashRemoved} expired trashed branch dir(s)`)
      }

      const report = this.ensureStatusReport()
      report.lastGitSyncAt = new Date().toISOString()
      delete report.lastGitSyncError
      report.lastGitSync = {
        durationMs: Date.now() - cycleStartedAt,
        rebased: rebaseSummary.rebased,
        skippedDirty: rebaseSummary.skippedDirty,
        skippedLocked: rebaseSummary.skippedLocked,
        failed: rebaseSummary.failed,
        tracked: trackedSummary,
      }
      await writeWorkerStatus(this.taskDir, report).catch((writeErr) =>
        workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
      )
    } catch (err) {
      const report = this.ensureStatusReport()
      // [HIGH-1] Persisted to worker-status.json and served to the browser
      // by the admin panel -- a fetch/push failure's message can embed the
      // bot token via buildGitHubUrl().
      report.lastGitSyncError = {
        message: redactCredentials(getErrorMessage(err)),
        at: new Date().toISOString(),
      }
      await writeWorkerStatus(this.taskDir, report).catch((writeErr) =>
        workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
      )
      throw err
    }
  }

  /**
   * [C1] Remove `.trash-*` branch directories (created by the admin purge
   * action, api/admin-branch-health.ts) whose name-embedded stamp is older
   * than {@link TRASH_RETENTION_MS}. Names that don't match the expected
   * `.trash-{dirName}-{STAMP}` shape, or whose stamp fails to parse, are
   * left alone (logged once per cycle, not per file, to avoid flooding logs
   * if something odd accumulates) -- purge is the only writer of this
   * naming scheme, so an unparseable name is unexpected and worth a human
   * looking rather than a silent skip.
   */
  private async cleanupTrashedBranchDirs(): Promise<number> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.contentBranchesPath)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return 0
      throw err
    }

    const now = Date.now()
    let removed = 0
    let loggedUnparseable = false

    for (const name of entries) {
      if (!name.startsWith('.trash-')) continue

      const stampMatch = TRASH_DIR_STAMP_RE.exec(name)
      const stampDate = stampMatch ? parseTrashStamp(stampMatch[1]) : null
      if (!stampDate) {
        if (!loggedUnparseable) {
          workerLog(`CanopyCMS: Skipping trash dir with unparseable stamp: ${name}`)
          loggedUnparseable = true
        }
        continue
      }

      if (now - stampDate.getTime() < TRASH_RETENTION_MS) continue

      try {
        await fs.rm(path.join(this.contentBranchesPath, name), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        })
        removed++
      } catch (err: unknown) {
        workerLogError(
          `CanopyCMS: Failed to remove trashed branch dir ${name}:`,
          getErrorMessage(err),
        )
      }
    }

    return removed
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
        workerLog(
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
        workerLogError(
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
      // Compare against the just-fetched tip rather than origin/<base>:
      // workspaces are cloned --single-branch (git-manager.ts), so their
      // fetch refspec only materializes a remote-tracking ref for the branch
      // they were cloned from — for any other base branch, origin/<base>
      // simply never exists and rev-list dies with "ambiguous argument".
      // Pin FETCH_HEAD to a SHA immediately: FETCH_HEAD is one shared mutable
      // file per repo, silently repointed by ANY other fetch in this clone.
      const fetchedTip = (await baseGit.revparse(['FETCH_HEAD'])).trim()
      const behindCount = parseInt(
        (await baseGit.raw(['rev-list', '--count', `HEAD..${fetchedTip}`])).trim(),
        10,
      )

      if (behindCount > 0) {
        try {
          await baseGit.merge(['--ff-only', fetchedTip])
        } catch (err) {
          workerLogError(
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
      workerLog(
        behindCount > 0
          ? `Base branch workspace (${this.baseBranch}): fast-forwarded ${behindCount} commit(s)`
          : `Base branch workspace (${this.baseBranch}): up to date`,
      )
    } catch (err) {
      workerLogError(
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
        workerLog(`  PR #${prNumber} for ${branchDir} is merged -> archived`)
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
      workerLog(`  PR #${prNumber} for ${branchDir}: pullRequestState -> ${newState}`)
    } catch (err) {
      // Non-fatal: transient GitHub/network errors are retried next cycle.
      workerLogWarn(`  Failed to poll PR #${prNumber} for ${branchDir}: ${getErrorMessage(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Persist a per-branch rebase failure to branch.json (PR-W2), bounded to
   * roughly one save per failing branch per hour: a branch stuck failing
   * every cycle must not turn into unbounded save-per-cycle x N-failing-
   * branches write amplification -- save() eager-regenerates the branch
   * registry (branch-metadata.ts's invalidateRegistry(), O(branch count) EFS
   * reads), the same concern the `alreadyClean` no-op guard above exists
   * for.
   *
   * Best-effort and non-fatal like every other metadata write in this
   * loop's error paths: a corrupt branch.json, a lock-contention error, or
   * any other save failure here must never abort the per-branch iteration.
   * This matters doubly at the two call sites -- one is inside the outer
   * per-branch catch, with no further catch of its own around this call --
   * so the whole method is wrapped, not just the load.
   */
  private async recordRebaseFailure(
    branchPath: string,
    branchDir: string,
    message: string,
  ): Promise<void> {
    const RECORD_REFRESH_MS = 60 * 60 * 1000 // 1 hour

    // [HIGH-1] Defense-in-depth redaction: rebaseFailure.message is
    // persisted to branch.json and served to the browser via the
    // branch-health admin endpoint. Both call sites in rebaseActiveBranches
    // already redact before passing in (the failed.push sites below),
    // redactCredentials is idempotent, so redacting again here is free and
    // keeps this method safe on its own.
    const redactedMessage = redactCredentials(message)

    try {
      const existing = await BranchMetadataFileManager.loadOnly(branchPath)
      const prior = existing?.branch.rebaseFailure
      const sameMessage = prior?.message === redactedMessage

      const now = new Date()
      if (sameMessage) {
        const lastAtMs = Date.parse(prior.lastAt)
        if (!Number.isNaN(lastAtMs) && now.getTime() - lastAtMs < RECORD_REFRESH_MS) {
          // Same failure, refreshed within the last hour -- skip the save.
          return
        }
      }

      const nowIso = now.toISOString()
      const firstAt = sameMessage ? prior.firstAt : nowIso

      const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)
      await meta.save({
        branch: {
          name: branchDir,
          rebaseFailure: { message: redactedMessage, firstAt, lastAt: nowIso },
        },
      })
    } catch (err) {
      // Includes BranchMetadataCorruptError from the load above (a save()
      // against the same corrupt file would just throw again) as well as
      // any other load/save failure -- recording is best-effort
      // observability, never allowed to abort the branch loop.
      workerLogWarn(`  Failed to record rebase failure for ${branchDir}: ${getErrorMessage(err)}`)
    }
  }

  /**
   * Test-only seam: awaited inside `rebaseActiveBranches()`'s conflict round,
   * after `git rebase` reported conflicted files and BEFORE the
   * `checkout --theirs` resolution loop overwrites them. No-op in production.
   *
   * A test subclass overrides this to land a real `ContentStore` write at
   * exactly the instant the rebase is mid-flight -- the window the old TOCTOU
   * comment above the dirty check wrongly called safe -- without any sleeps or
   * shell rendezvous. See the "Deterministic interleavings" testing pattern in
   * docs/concurrency.md, and `ContentStore.afterPrePassForTesting()` for the
   * same idiom on the write side.
   */
  protected async afterConflictDetectedForTesting(): Promise<void> {}

  /**
   * Test seam, sibling of {@link afterConflictDetectedForTesting}: runs at the
   * instant a rebase round has succeeded, before the completion path (cache
   * invalidation, conflict metadata, [SYNC-H1] marker) executes. Exists so a
   * test can lose the content-write lock at exactly the point where bailing out
   * would strand a rewritten history.
   */
  protected async afterRebaseCompletedForTesting(): Promise<void> {}

  private async rebaseActiveBranches(): Promise<RebaseSummary> {
    // PR-W1: collected across the loop below and returned as a summary
    // (folded into worker-status.json by syncGit()). Purely additive
    // bookkeeping -- doesn't change any control flow or existing logging.
    const rebased: string[] = []
    const skippedDirty: string[] = []
    const skippedLocked: string[] = []
    const failed: { branch: string; error: string }[] = []

    let branchDirs: string[]
    try {
      branchDirs = await fs.readdir(this.contentBranchesPath)
    } catch {
      return { rebased, skippedDirty, skippedLocked, failed }
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
          workerLog(`  Skipping ${branchDir}: .git is not a directory`)
          continue
        }
      } catch {
        workerLog(`  Skipping ${branchDir}: no .git directory (not a branch workspace)`)
        continue
      }

      // The base branch's own clone is refreshed ff-only by
      // refreshBaseBranchWorkspace() earlier in syncGit(). Routing it
      // through this conflict-resolution rebase loop could rewrite its
      // history (the --theirs loop below) and stamp meaningless conflict
      // metadata on it. Compare sanitized-vs-sanitized: branchDir is a
      // filesystem name (already sanitized), this.baseBranch is raw.
      if (branchDir === this.sanitizedBaseBranch) {
        workerLog(`  Skipping ${branchDir}: base branch (refreshed separately)`)
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
          workerLog(`  Skipping ${branchDir} (${branchStatus})`)
          await this.pollMergeState(branchDir, branchPath, metaFile)
          continue
        }
        if (branchStatus === 'archived') {
          workerLog(`  Skipping ${branchDir} (${branchStatus})`)
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

        // [SYNC-C1] Take the branch's cross-host content-write lock BEFORE the
        // dirty check, and hold it for the whole rebase.
        //
        // The dirty check alone is check-then-act. The old comment here claimed
        // the residual window was safe ("the rebase will fail and the catch
        // block will abort safely"), which only holds for a save landing before
        // `git rebase` STARTS. After that -- a window spanning fetch, replay and
        // N conflict rounds of awaited git subprocesses on EFS -- a save is
        // destroyed two ways: `checkout --theirs` below overwrites the
        // just-saved file with the branch's committed version and the rebase
        // then SUCCEEDS (nothing logs a failure at all), and `rebase --abort`
        // hard-resets the tree. The editor already got its 200 either way.
        //
        // Zero-retry acquisition, deliberately: on contention this branch is
        // skipped and retried on the next sync cycle (~5 min), which is the
        // same principle as the skip-dirty-branches behavior below. Writers get
        // the patient side of the asymmetry -- see utils/content-write-lock.ts.
        //
        // The heartbeat that keeps this lock fresh (proper-lockfile refreshes
        // every `stale`/2 = 15s) is a timer on this event loop; every git step
        // below is an awaited subprocess, never a synchronous block, so the
        // refresh keeps firing for the whole hold.
        let releaseContentLock: (() => Promise<void>) | undefined
        // [SYNC-C1] If the lock is lost mid-hold, a writer may now be live
        // against this same tree. Every git step below is destructive, so
        // record it and bail before the next one rather than replaying over
        // an editor's concurrent save.
        let contentLockCompromised = false
        try {
          releaseContentLock = await tryAcquireContentWriteLock(branchPath, (lockErr) => {
            contentLockCompromised = true
            workerLogWarn(
              `  Content-write lock compromised mid-rebase for ${branchDir}: ${getErrorMessage(lockErr)}`,
            )
          })
        } catch (lockErr: unknown) {
          if (isNodeError(lockErr) && lockErr.code === 'ELOCKED') {
            workerLog(`  Skipping ${branchDir}: content write in progress (retrying next cycle)`)
            skippedLocked.push(branchDir)
            continue
          }
          // Anything else (ENOENT on a branch dir deleted mid-cycle, EACCES,
          // ...) is a real failure: let the outer catch record it.
          throw lockErr
        }

        try {
          // Recover an INTERRUPTED rebase before anything else looks at this
          // tree. A clone left with .git/rebase-merge (or rebase-apply) reports
          // uncommitted changes, so without this the dirty check below would
          // classify it `skippedDirty` on every cycle FOREVER while
          // branch-health scanned it as healthy -- and editors would meanwhile
          // read, and be able to save over, conflict-marker content.
          //
          // An in-progress rebase is always this worker's own abandoned work:
          // it is the only thing that ever rebases these clones, and it got
          // here via a crash, an OOM, a spot interruption, or the ASG rolling
          // the instance (which happens on EVERY `cdk deploy`, while `stop()`
          // drains for at most taskTimeoutMs).
          //
          // NOT LOSSLESS, and it is important not to claim otherwise. `git
          // rebase --abort` hard-resets tracked files to the pre-rebase head.
          // While the worker was DOWN nothing held the [SYNC-C1] content-write
          // lock, so an editor could have saved into this wedged clone and
          // received a 200; that save is a working-tree modification, and the
          // abort reverts it. (New, untracked entry files survive; edits to
          // existing ones do not.) Taking the lock here stops any FURTHER save
          // racing the abort, but cannot recover one that already landed.
          //
          // Aborting anyway is still the right call: the alternative is a
          // branch wedged forever whose tree serves conflict-marker content to
          // editors. What must not happen is doing it SILENTLY -- so anything
          // modified beyond the rebase's own conflict state is logged by path
          // first, which is the only record an operator would have.
          if (await isRebaseInProgress(branchPath)) {
            const preAbort = await branchGit.status().catch(() => null)
            // Plain-modified tracked files, excluding the conflicted paths the
            // interrupted rebase itself produced.
            const collateral = (preAbort?.files ?? [])
              .filter((f) => !preAbort?.conflicted.includes(f.path))
              .filter((f) => f.index !== '?' && f.working_dir !== '?')
              .map((f) => f.path)
            if (collateral.length > 0) {
              workerLogWarn(
                `  ${branchDir}: aborting the interrupted rebase will DISCARD working-tree changes to ` +
                  `${collateral.length} file(s) saved while the worker was down: ${collateral.join(', ')}`,
              )
            }
            workerLogWarn(
              `  ${branchDir}: found an interrupted rebase (this worker's own abandoned work) -- aborting it to recover the branch`,
            )
            try {
              await branchGit.rebase(['--abort'])
            } catch (abortErr: unknown) {
              // Leave it for the next cycle rather than pressing on: every step
              // below assumes a clean tree.
              workerLogWarn(
                `  Skipping ${branchDir}: could not abort its interrupted rebase: ${getErrorMessage(abortErr)}`,
              )
              failed.push({
                branch: branchDir,
                error: redactCredentials(
                  `could not abort interrupted rebase: ${getErrorMessage(abortErr)}`,
                ),
              })
              continue
            }
          }

          // Skip dirty branches — editor has unsaved changes that can't be rebased.
          // Now inside the lock, so no write can land between this check and the
          // rebase below.
          const dirtyCheck = await branchGit.status()
          if (dirtyCheck.files.length > 0) {
            workerLog(`  Skipping ${branchDir}: has uncommitted changes`)
            skippedDirty.push(branchDir)
            continue
          }

          // The clone's own ref name: branchDir is the sanitized DIRECTORY
          // name and need not match it. A literal 'HEAD' means a detached
          // clone (e.g. a crashed rebase left one behind) -- nothing below can
          // safely name a ref then, so every publish path stays disarmed,
          // which is the safe direction.
          const branchRef = (await branchGit.revparse(['--abbrev-ref', 'HEAD'])).trim()
          const canPublish = branchRef.length > 0 && branchRef !== 'HEAD'

          // [SYNC-H1] Self-heal: finish an interrupted publish even when this
          // branch is not behind base. Every crash window in the arming
          // sequence below leaves the marker set with the work unfinished, and
          // this is what completes it -- without it, one lost lease race would
          // strand the branch until the base branch happened to advance again.
          // Gated on the loop-top snapshot, so unmarked branches (nearly all
          // of them, every cycle) cost nothing extra.
          if (canPublish && metaFile?.branch.historyRewrittenFrom) {
            await this.reconcilePendingRewrite({
              branchPath,
              branchDir,
              branchRef,
              headSha: (await branchGit.revparse(['HEAD'])).trim(),
              marker: metaFile.branch.historyRewrittenFrom,
            })
          }

          await branchGit.fetch('origin', this.baseBranch)

          // Use rev-list instead of status.behind — status.behind only works when the
          // branch has an upstream tracking branch configured, which isn't guaranteed
          // (checkoutBranch fallback paths create branches without --track).
          // The just-fetched tip, not origin/<base>: branch clones are
          // --single-branch, so no remote-tracking ref exists for a base branch
          // other than the one they were cloned from (see the base-refresh
          // comment above). Pinned to a SHA immediately — FETCH_HEAD is one
          // shared mutable file per repo, repointed by any concurrent fetch.
          const fetchedBaseTip = (await branchGit.revparse(['FETCH_HEAD'])).trim()
          const behindCount = parseInt(
            (await branchGit.raw(['rev-list', '--count', `HEAD..${fetchedBaseTip}`])).trim(),
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
            const conflictAlreadyClean =
              (conflictStatus === undefined || conflictStatus === 'clean') &&
              (conflictFiles === undefined || conflictFiles.length === 0)
            // PR-W2: a lingering rebaseFailure must also be cleared once the
            // branch catches up clean -- otherwise it sticks as a stale
            // warning forever (nothing else touches this branch once it's
            // caught up, so no other save site would ever clear it).
            const alreadyClean =
              conflictAlreadyClean && currentMeta?.branch.rebaseFailure === undefined
            if (alreadyClean) {
              continue
            }
            await meta.save({
              branch: {
                name: branchDir,
                conflictStatus: 'clean',
                conflictFiles: [],
                rebaseFailure: undefined,
              },
            })
            continue
          }

          workerLog(`Rebasing ${branchDir} (${behindCount} commits behind)...`)

          // Read BOTH sides before rewriting anything: the arming guard after
          // the rebase compares what remote.git published against what this
          // clone is about to rebase away. Reading them afterwards would be
          // useless -- the clone's pre-rebase tip is exactly what disappears.
          const preRebaseHead = (await branchGit.revparse(['HEAD'])).trim()
          const publishedSha = canPublish ? await this.readPublishedSha(branchRef) : null

          // Resolve-and-continue loop: keep branch version for conflicting files, then continue
          // Non-conflicting files get main's changes; conflicting files keep branch version.
          const conflictedFiles: string[] = []
          let nextAction: 'start' | 'continue' | 'skip' = 'start'
          let completed = false
          // PR-W1: captured only on the "unexpected error" exit below, for the
          // failed-summary entry pushed at the `if (!completed)` check.
          let failureReason: string | undefined
          const MAX_ROUNDS = 50 // safety limit against infinite loops

          for (let round = 0; round < MAX_ROUNDS && !completed; round++) {
            // Re-checked every round: the compromise can land between rounds,
            // and `--continue`/`--skip` are as destructive as the initial
            // rebase. Handled after the loop so it cannot be mistaken for the
            // `!completed` rebase-FAILURE path below.
            if (contentLockCompromised) break
            try {
              if (nextAction === 'start') {
                // The pinned base tip fetched above (single-branch clones have
                // no origin/<base> remote-tracking ref for other branches).
                await branchGit.rebase([fetchedBaseTip])
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
                await this.afterConflictDetectedForTesting()
                // During rebase, --theirs = the branch being replayed (editor's work).
                // (git rebase reverses ours/theirs: "ours" is the rebase target, "theirs" is the branch.)
                //
                // MODIFY/DELETE conflicts have no "their version" to check out
                // and must be resolved by staging a delete or an add instead.
                // `git checkout --theirs` on one exits non-zero ("path ... does
                // not have their version") and simple-git throws -- and because
                // this loop body IS the round loop's catch, that throw escapes
                // the round loop entirely, skipping BOTH `rebase --abort` sites
                // below and leaving the clone wedged mid-rebase forever. The
                // index/working-tree code pair identifies which side deleted
                // (verified against real git, not inferred):
                //
                //   U/D  "deleted by them"  -- the BRANCH deleted it, base
                //        modified it. Git leaves base's version in the tree.
                //        Keep-branch-version means honouring the delete: git rm.
                //   D/U  "deleted by us"    -- base deleted it, the BRANCH
                //        modified it. Git leaves the branch's version in the
                //        tree. Keep-branch-version means keeping it: git add.
                //
                // Any per-file resolution that STILL fails routes into the
                // `!completed` path below (which aborts and records) instead of
                // escaping -- deliberately NOT a rethrow, since a throw from
                // here is exactly the bug being fixed.
                const conflictKind = new Map(
                  st.files.map((f) => [f.path, `${f.index}${f.working_dir}`]),
                )
                let resolutionFailure: string | undefined
                for (const file of st.conflicted) {
                  const kind = conflictKind.get(file)
                  try {
                    if (kind === 'UD') {
                      await branchGit.raw(['rm', '-f', '--', file])
                    } else if (kind === 'DU') {
                      await branchGit.add(file)
                    } else {
                      await branchGit.raw(['checkout', '--theirs', file])
                      await branchGit.add(file)
                    }
                  } catch (resolveErr: unknown) {
                    resolutionFailure =
                      `failed to resolve conflicted file '${file}' (status ${kind ?? '??'}): ` +
                      getErrorMessage(resolveErr)
                    break
                  }
                  conflictedFiles.push(file)
                }
                if (resolutionFailure !== undefined) {
                  // Same exit shape as the "unexpected error" branch below: set
                  // failureReason and break, letting the `!completed` block do
                  // the single `rebase --abort` and record the failure once.
                  failureReason = resolutionFailure
                  break
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
                  workerLogWarn(
                    `  Unexpected rebase error in ${branchDir}: ${msg || 'Unknown error'}`,
                  )
                  failureReason = msg || 'Unknown error'
                  await branchGit.rebase(['--abort']).catch(() => {})
                  break
                }
              }
            }
          }

          // Outside the round loop's try/catch, so a throwing test hook can
          // never be misread as a rebase error.
          if (completed) await this.afterRebaseCompletedForTesting()

          // [SYNC-C1] A lost lock is a RETRY, not a rebase failure: nothing is
          // wrong with the branch, we simply can no longer prove we were the
          // only writer. Handled ahead of the `!completed` block so it never
          // records a user-visible rebaseFailure or lands in `failed[]`.
          //
          // ONLY when the rebase did not complete. Bailing out of a COMPLETED
          // rebase would be worse than useless: the history is already
          // rewritten (so `--abort` is a no-op), and skipping the completion
          // path below strands three things the next cycle will never redo,
          // because a caught-up branch short-circuits at the `behindCount === 0`
          // check above -- the [SYNC-H1] `markHistoryRewritten` marker (without
          // which the editor's next submit is rejected non-fast-forward and
          // mis-diagnosed as another deployment), the content-cache
          // invalidation for a tree that DID change, and the conflictStatus
          // save. That converts a transient lock compromise into a permanently
          // wedged published branch.
          //
          // Nor does bailing protect a racing save: a rebase replays COMMITTED
          // history, while a concurrent save is uncommitted working-tree state,
          // and that writer is already told to retry via
          // ContentWriteLockBusyError. So when the rebase completed, log the
          // lost exclusivity loudly and finish the job.
          if (contentLockCompromised && !completed) {
            workerLogWarn(
              `  Skipping ${branchDir}: content-write lock was compromised mid-rebase (retrying next cycle)`,
            )
            // No-op when no rebase is in progress; failure is expected there.
            await branchGit.rebase(['--abort']).catch(() => {})
            skippedLocked.push(branchDir)
            continue
          }
          if (contentLockCompromised) {
            workerLogWarn(
              `  Content-write lock for ${branchDir} was compromised, but its rebase had already completed -- finishing the sync (history is rewritten; skipping now would strand the history-rewrite marker and wedge the branch)`,
            )
          }

          if (!completed) {
            // PR-W2 (M1 rider): failureReason is only set on the "unexpected
            // error" break above -- MAX_ROUNDS exhaustion is a distinct exit
            // path with no error message of its own, so the warn text must
            // not conflate the two.
            workerLogWarn(
              failureReason !== undefined
                ? `  Rebase of ${branchDir} aborted due to unexpected error: ${failureReason}`
                : `  Rebase of ${branchDir} did not complete within ${MAX_ROUNDS} rounds, aborting`,
            )
            await branchGit.rebase(['--abort']).catch(() => {})
            const rebaseFailureMessage =
              failureReason ?? `did not complete within ${MAX_ROUNDS} rounds`
            // [HIGH-1] failed[] folds into worker-status.json's
            // lastGitSync.failed, served to the browser -- failureReason can
            // be an arbitrary git error message that embeds the bot token.
            const redactedRebaseFailureMessage = redactCredentials(rebaseFailureMessage)
            failed.push({
              branch: branchDir,
              error: redactedRebaseFailureMessage,
            })
            // PR-W2: record once here for the "!completed" exit -- the
            // unexpected-error break above is NOT disjoint from this block (it
            // always falls through here), so recording at the break itself
            // would double-record. The outer catch below is the only other
            // record site (a distinct, non-overlapping failure class: errors
            // outside this round loop, e.g. fetch/rev-list failures).
            await this.recordRebaseFailure(branchPath, branchDir, redactedRebaseFailureMessage)
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
          // The root content directory (e.g., "content/", or "cms/content/" for a
          // multi-segment contentRoot) has no embedded ID, so we use ROOT_COLLECTION_ID
          // as a sentinel — but only for the configured contentRoot.
          //
          // Two different notions of "parent" are needed below, and conflating them
          // reproduces the exact bug this comparison guards against (see
          // schema-store.ts's contentRootName doc comment for the same shape elsewhere):
          //  - `parentDir` (a basename) recovers a SUB-collection's own embedded ID
          //    (e.g. "posts.cNbR5xFm2Kpd" -> "cNbR5xFm2Kpd") — correct as a basename,
          //    since a collection directory carries its ID in its own name, one path
          //    segment.
          //  - `parentPath` (the full relative parent path, normalized) is what must be
          //    compared against `this.contentRoot`, because `contentRoot` is documented
          //    (config/helpers.ts) as allowed to span multiple segments (e.g.
          //    "cms/content"). Comparing a basename ("content") against that full value
          //    is always false, which silently drops the root collection's conflict.
          //    Git reports POSIX-style paths and the configured value may be authored
          //    with either separator, so both sides go through normalizeFilesystemPath
          //    before comparing.
          const normalizedContentRoot = normalizeFilesystemPath(this.contentRoot)
          const conflictIds = [...new Set(conflictedFiles)]
            .map((f) => {
              const fileId = extractIdFromFilename(path.basename(f))
              if (fileId) return fileId
              const parentDir = path.basename(path.dirname(f))
              const dirId = extractIdFromFilename(parentDir)
              if (dirId) return dirId
              // Only assign ROOT_COLLECTION_ID when the file's parent directory IS the
              // configured content root. Other unrecognized paths are filtered out.
              const parentPath = normalizeFilesystemPath(path.dirname(f))
              if (path.basename(f) === '.collection.json' && parentPath === normalizedContentRoot) {
                return ROOT_COLLECTION_ID
              }
              return null
            })
            .filter((id): id is ContentId => id !== null)
          const conflictIdsDeduped = [...new Set(conflictIds)]

          const hadConflicts = conflictIdsDeduped.length > 0
          workerLog(
            hadConflicts
              ? `  Rebased ${branchDir} (kept branch version for ${conflictIdsDeduped.length} conflicting file(s))`
              : `  Rebased ${branchDir} successfully`,
          )
          await meta.save({
            branch: {
              name: branchDir,
              conflictStatus: hadConflicts ? 'conflicts-detected' : 'clean',
              conflictFiles: conflictIdsDeduped,
              // PR-W2: the cycle completed successfully -- clear any prior
              // failure record regardless of conflict outcome.
              rebaseFailure: undefined,
            },
          })
          // PR-W1: the branch was behind and the rebase completed (with or
          // without --theirs conflict resolution) -- it moved, so it belongs
          // in the summary. Branches already up to date `continue`d above and
          // are deliberately not listed here.
          rebased.push(branchDir)

          // [SYNC-H1] The rebase just rewrote this clone's history. If that
          // history was already published, nothing else will ever reconcile
          // remote.git (and GitHub) with it -- the editor's next submit would
          // simply be rejected non-fast-forward. Carry the rewrite forward.
          if (publishedSha !== null) {
            if (publishedSha === preRebaseHead) {
              // ARMING GUARD. remote.git holds EXACTLY what this clone just
              // rebased away and nothing more, so a lease keyed to it can only
              // undo our own rewrite.
              //
              // The inequality case below is not defensive padding: branch
              // clones never fetch their own branch (GitManager's clone is
              // --single-branch and checkoutBranch only checks out an existing
              // local branch), while reconcileTrackedBranches fast-forwards
              // remote.git to GitHub's tip. So after a reviewer pushes a fixup
              // straight to the PR branch, remote.git legitimately holds a
              // commit this clone has never seen. Leasing on "whatever
              // remote.git currently holds" would be SATISFIED there and would
              // delete that fixup from remote.git and then from GitHub,
              // silently. Keying the lease to the pre-rebase tip turns that
              // case into the visible divergence it should be.
              //
              // Order matters: mark, then push, then queue. A crash after any
              // step leaves the marker set with the work unfinished, which
              // reconcilePendingRewrite() completes on a later cycle. Pushing
              // first would leave remote.git rewritten, GitHub stale and
              // nothing recorded -- unrecoverable, and landing on exactly the
              // false "another deployment" diagnosis this change removes.
              await this.markHistoryRewritten(branchPath, branchDir, publishedSha)
              if (await this.forcePublishToLocalRemote(branchPath, branchRef, publishedSha)) {
                await this.enqueueGitHubPush(branchRef)
              }
            } else {
              const divergence =
                `rebased locally, but remote.git holds ${publishedSha} for ${branchRef}, which this ` +
                `clone never had (a direct push to the branch?). Left untouched -- reconcile it ` +
                `before submitting again.`
              workerLogWarn(`  ${branchDir}: ${divergence}`)
              await this.recordRebaseFailure(branchPath, branchDir, divergence)
            }
          }
        } finally {
          // Last-resort guarantee that NO exit path leaves this clone
          // mid-rebase -- including an unexpected throw from any git step
          // above, which lands in the outer catch and previously only logged.
          //
          // It must live HERE rather than in that outer catch: the catch runs
          // AFTER this finally has released the content-write lock, so aborting
          // there would hard-reset a working tree an editor's save could
          // already be racing -- precisely the [SYNC-C1] hazard the lock
          // exists to prevent. Inside the finally the lock is still held --
          // EXCEPT on the narrow path where it was compromised mid-hold, in
          // which case a newly-admitted writer may already be live and this
          // abort carries the same exposure as the compromise path's own abort
          // above. Not special-cased: leaving a clone wedged mid-rebase is the
          // worse outcome, and the writer in that window is already being told
          // to retry.
          //
          // Guarded on actual rebase state so the happy path and the `continue`
          // exits cost one stat and do nothing.
          try {
            if (await isRebaseInProgress(branchPath)) {
              workerLogWarn(
                `  ${branchDir}: rebase still in progress on exit -- aborting so the clone is not left wedged`,
              )
              await branchGit.rebase(['--abort'])
            }
          } catch (abortErr: unknown) {
            // Best effort: the next cycle's recovery check retries this.
            workerLogWarn(
              `  Failed to abort in-progress rebase for ${branchDir}: ${getErrorMessage(abortErr)}`,
            )
          }

          // [SYNC-C1] Released on EVERY exit -- the `continue`s above, a throw
          // into the outer catch, and the happy path alike. A stranded lock
          // would wedge every write to this branch until it went stale.
          await releaseContentLock?.().catch((releaseErr: unknown) => {
            workerLogWarn(
              `  Failed to release content-write lock for ${branchDir}: ${getErrorMessage(releaseErr)}`,
            )
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        workerLogWarn(`  Failed to sync ${branchDir}: ${message}`)
        // [HIGH-1] Same rationale as the `if (!completed)` push site above --
        // this catches fetch/rev-list/unexpected errors, whose message can
        // embed the bot token.
        const redactedMessage = redactCredentials(message)
        failed.push({ branch: branchDir, error: redactedMessage })
        // PR-W2: second (and only other) record site -- see the comment at
        // the `if (!completed)` block above for why these two sites are
        // disjoint.
        await this.recordRebaseFailure(branchPath, branchDir, redactedMessage)
      }
    }

    return { rebased, skippedDirty, skippedLocked, failed }
  }

  async refreshAuthCache(): Promise<void> {
    if (!this.running || !this.config.refreshAuthCache) return

    workerLog('Refreshing auth cache...')
    try {
      await this.config.refreshAuthCache()
      workerLog('Auth cache refreshed')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      workerLogError('Failed to refresh auth cache:', message)
    }
  }
}
