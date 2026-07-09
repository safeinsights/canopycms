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
import { getBranchMetadataFileManager, BranchMetadataFileManager } from '../branch-metadata'
import { extractIdFromFilename } from '../content-id-index'
import { type ContentId, ROOT_COLLECTION_ID } from '../paths/types'
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
 * - HTTP 5xx (server-side, usually recovers)
 *
 * Permanent — retrying the identical request cannot succeed:
 * - PermanentTaskError (malformed payload, unknown action)
 * - other HTTP 4xx (e.g. 401/403/404/422): the request itself is bad
 */
export function isPermanentTaskFailure(err: unknown): boolean {
  if (err instanceof PermanentTaskError) return true
  const status = getHttpStatus(err)
  if (status === null) return false
  if (status === 408 || status === 429) return false
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
    this.octokit = new Octokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.baseBranch = config.baseBranch ?? 'main'
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
   * Ensure remote.git bare repo exists.
   * On first run, clone from GitHub as a bare repo.
   */
  private async ensureRemoteGit(): Promise<void> {
    try {
      await fs.stat(this.remoteGitPath)
      return // Already exists
    } catch {
      console.log('Initializing remote.git from GitHub...')
      const git = simpleGit()
      await git.clone(this.buildGitHubUrl(), this.remoteGitPath, ['--bare'])
      // Remove the origin remote so the token doesn't persist in config
      const bareGit = simpleGit({ baseDir: this.remoteGitPath })
      await bareGit.removeRemote('origin').catch(() => {})
      console.log('remote.git initialized')
    }
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
        const branch = requireString(payload, 'branch')
        await this.pushBranchToGitHub(branch)

        // Check if an open PR already exists for this branch
        const existingPRs = await this.octokit.pulls.list({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          head: `${this.config.githubOwner}:${branch}`,
          base: optionalString(payload, 'baseBranch', this.baseBranch),
          state: 'open',
          request: { signal },
        })

        if (existingPRs.data.length > 0) {
          // GIT-M5: GitHub disallows more than one open PR for a given
          // head+base pair, so this should always be a single match. Guard
          // against blindly trusting array order anyway.
          let existing = existingPRs.data[0]
          if (existingPRs.data.length > 1) {
            existing = [...existingPRs.data].sort(
              (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            )[0]
            console.warn(
              `Found ${existingPRs.data.length} open PRs for ${branch}; updating the most recently updated (#${existing.number})`,
            )
          }
          await this.octokit.pulls.update({
            owner: this.config.githubOwner,
            repo: this.config.githubRepo,
            pull_number: existing.number,
            title: optionalString(payload, 'title', `Submit ${branch}`),
            body: optionalString(payload, 'body', ''),
            request: { signal },
          })
          console.log(`Updated existing PR #${existing.number} for ${branch}`)
          return { prUrl: existing.html_url, prNumber: existing.number }
        }

        const newPr = await this.octokit.pulls.create({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          head: branch,
          base: optionalString(payload, 'baseBranch', this.baseBranch),
          title: optionalString(payload, 'title', `Submit ${branch}`),
          body: optionalString(payload, 'body', ''),
          request: { signal },
        })
        console.log(`Created PR #${newPr.data.number} for ${branch}`)
        return { prUrl: newPr.data.html_url, prNumber: newPr.data.number }
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
      if (result.prNumber) updates.pullRequestNumber = result.prNumber
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

    await this.rebaseActiveBranches()

    // Periodically clean up old completed/failed tasks
    await cleanupOldTasks(this.taskDir, undefined, this.log)
  }

  private async rebaseActiveBranches(): Promise<void> {
    let branchDirs: string[]
    try {
      branchDirs = await fs.readdir(this.contentBranchesPath)
    } catch {
      return
    }

    for (const branchDir of branchDirs) {
      const branchPath = path.join(this.contentBranchesPath, branchDir)
      const gitDir = path.join(branchPath, '.git')

      try {
        const stat = await fs.stat(gitDir)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      try {
        // Load metadata before any git ops to check branch status
        const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
        const branchStatus = metaFile?.branch.status

        // Skip branches that shouldn't be mutated:
        // - submitted/approved: in review, don't rewrite history under an active PR
        // - archived: already merged, no reason to rebase
        if (
          branchStatus === 'submitted' ||
          branchStatus === 'approved' ||
          branchStatus === 'archived'
        ) {
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
        const behindCount = parseInt(
          (await branchGit.raw(['rev-list', '--count', `HEAD..origin/${this.baseBranch}`])).trim(),
          10,
        )
        const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)

        if (behindCount === 0) {
          // Already in sync — clear any stale conflict state
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
              await branchGit.rebase([`origin/${this.baseBranch}`])
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
