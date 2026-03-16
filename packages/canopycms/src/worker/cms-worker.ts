import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Octokit } from '@octokit/rest'
import { dequeueTask, completeTask, failTask, retryTask, recoverOrphanedTasks, cleanupOldTasks, cmsTaskQueueLogger } from './task-queue'
import type { Task } from './task-queue'
import { getBranchMetadataFileManager, BranchMetadataFileManager } from '../branch-metadata'
import { extractIdFromFilename } from '../content-id-index'
import type { ContentId } from '../paths/types'
import { isFileExistsError } from '../utils/error'

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
}

const DEFAULT_TASK_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 3

// Payload validation helpers — fail fast with clear errors instead of silent `as` casts

function requireString(payload: Record<string, unknown>, key: string): string {
  const val = payload[key]
  if (typeof val !== 'string') throw new Error(`Task payload missing required string field: ${key}`)
  return val
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const val = payload[key]
  if (typeof val !== 'number') throw new Error(`Task payload missing required number field: ${key}`)
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
  private currentOperation: Promise<void> | null = null
  private maxTasksPerCycle: number
  private taskTimeoutMs: number
  private maxRetries: number
  private lockFilePath: string
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
    // Wait for any in-flight operation to complete (up to taskTimeoutMs)
    if (this.currentOperation) {
      await Promise.race([
        this.currentOperation,
        new Promise<void>((r) => setTimeout(r, this.taskTimeoutMs)),
      ])
    }
    await this.releaseLock()
    console.log('CMS Worker stopped')
  }

  /**
   * Acquire an EFS-based lock file to prevent concurrent workers.
   * Uses O_CREAT|O_EXCL for atomic file creation.
   * Stale locks (older than 10 minutes with no running PID) are overwritten.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockFilePath), { recursive: true })

    const lockContent = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })

    // Try atomic create first
    try {
      const handle = await fs.open(this.lockFilePath, 'wx')
      await handle.writeFile(lockContent, 'utf-8')
      await handle.close()
      return
    } catch (err) {
      if (!isFileExistsError(err)) throw err
    }

    // Lock file exists — check staleness
    try {
      const content = await fs.readFile(this.lockFilePath, 'utf-8')
      const { pid, timestamp } = JSON.parse(content) as { pid: number; timestamp: string }
      const lockAgeMs = Date.now() - new Date(timestamp).getTime()
      const pidAlive = this.isPidAlive(pid)

      if (pidAlive && lockAgeMs < 10 * 60_000) {
        throw new Error(`Another worker is running (PID ${pid}, locked at ${timestamp}). Exiting.`)
      }

      console.log(`Overwriting stale lock (PID ${pid}, age ${Math.round(lockAgeMs / 1000)}s)`)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Another worker')) throw err
      // Lock file is corrupt or unreadable — overwrite it
    }

    // Stale or corrupt lock — unlink and retry with atomic create
    await fs.unlink(this.lockFilePath).catch(() => {})
    try {
      const handle = await fs.open(this.lockFilePath, 'wx')
      await handle.writeFile(lockContent, 'utf-8')
      await handle.close()
    } catch (err) {
      if (isFileExistsError(err)) {
        throw new Error('Another worker acquired the lock during stale lock recovery. Exiting.')
      }
      throw err
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockFilePath)
    } catch {
      // Lock file already gone
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
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
        this.currentOperation = operation
        await operation
        this.currentOperation = null
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
    while (processed < this.maxTasksPerCycle && (task = await dequeueTask(this.taskDir, this.log)) !== null) {
      try {
        const result = await this.executeTaskWithTimeout(task)
        await completeTask(this.taskDir, task.id, result, this.log)
        await this.updateBranchMetadata(task, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`Task ${task.id} (${task.action}) failed:`, message)

        const retryCount = task.retryCount ?? 0
        const maxRetries = task.maxRetries ?? this.maxRetries
        if (retryCount < maxRetries) {
          await retryTask(this.taskDir, task.id, message, this.log)
          console.log(`  Will retry (attempt ${retryCount + 1}/${maxRetries})`)
        } else {
          await failTask(this.taskDir, task.id, message, this.log)
          await this.updateBranchMetadataOnFailure(task, message)
          console.error(`  Permanently failed after ${maxRetries} retries`)
        }
      }
      processed++
    }
  }

  /**
   * Execute a task with a timeout. Uses AbortController to cancel
   * the underlying operation if the timeout fires.
   */
  private async executeTaskWithTimeout(task: Task): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.taskTimeoutMs)
    try {
      return await this.executeTask(task, controller.signal)
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
          const existing = existingPRs.data[0]
          await this.octokit.pulls.update({
            owner: this.config.githubOwner,
            repo: this.config.githubRepo,
            pull_number: existing.number,
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
          title: optionalString(payload, 'title', `Settings update`),
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
        throw new Error(`Unknown task action: ${action}`)
    }
  }

  /**
   * Update branch metadata after successful task completion.
   * Writes PR URL/number and sets syncStatus to 'synced'.
   */
  private async updateBranchMetadata(
    task: Task,
    result: Record<string, unknown>,
  ): Promise<void> {
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
      const updates: Record<string, unknown> = { name: branch, syncStatus: 'synced' }
      if (result.prUrl) updates.pullRequestUrl = result.prUrl
      if (result.prNumber) updates.pullRequestNumber = result.prNumber
      await meta.save({ branch: updates })
    } catch (err) {
      console.error(`Failed to update metadata for ${branch}:`, err instanceof Error ? err.message : err)
    }
  }

  /**
   * Update branch metadata after permanent task failure.
   * Sets syncStatus to 'sync-failed' with error details.
   */
  private async updateBranchMetadataOnFailure(
    task: Task,
    _error: string,
  ): Promise<void> {
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
      console.error(`Failed to update failure metadata for ${branch}:`, err instanceof Error ? err.message : err)
    }
  }

  private buildGitHubUrl(): string {
    return `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  private async pushBranchToGitHub(branch: string): Promise<void> {
    const git = simpleGit({ baseDir: this.remoteGitPath })
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
      const settingsBranches = branches.all.filter(b => b.startsWith('canopycms-settings-'))
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
      console.warn('Failed to list branches for settings push:', err instanceof Error ? err.message : err)
    }
  }

  async syncGit(): Promise<void> {
    if (!this.running) return

    console.log('Syncing git...')
    const git = simpleGit({ baseDir: this.remoteGitPath })

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

        // Skip branches in review — don't rewrite their history
        if (branchStatus === 'submitted' || branchStatus === 'approved') {
          console.log(`  Skipping ${branchDir} (${branchStatus}, in review)`)
          continue
        }

        const branchGit = simpleGit({ baseDir: branchPath })

        // Skip dirty branches — editor has unsaved changes that can't be rebased
        const dirtyCheck = await branchGit.status()
        if (dirtyCheck.files.length > 0) {
          console.log(`  Skipping ${branchDir}: has uncommitted changes`)
          continue
        }

        await branchGit.fetch('origin', this.baseBranch)

        const status = await branchGit.status()
        const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)

        if (status.behind === 0) {
          // Already in sync — clear any stale conflict state
          await meta.save({ branch: { name: branchDir, conflictStatus: 'clean', conflictFiles: [] } })
          continue
        }

        console.log(`Rebasing ${branchDir} (${status.behind} commits behind)...`)

        // Resolve-and-continue loop: apply --ours for conflicting files, then continue
        // Non-conflicting files get main's changes; conflicting files keep branch version.
        const ourFiles: string[] = []
        let nextAction: 'start' | 'continue' | 'skip' = 'start'
        let completed = false
        const MAX_ROUNDS = 50  // safety limit against infinite loops

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
                ourFiles.push(file)
              }
              // nextAction stays 'continue'
            } else {
              const msg = rebaseErr instanceof Error ? rebaseErr.message : ''
              if (msg.toLowerCase().includes('nothing to commit') || msg.toLowerCase().includes('apply --skip')) {
                // Empty commit after --ours resolution — skip it
                nextAction = 'skip'
              } else {
                // Unexpected error — abort, leave branch behind
                console.warn(`  Unexpected rebase error in ${branchDir}: ${msg || 'Unknown error'}`)
                await branchGit.rebase(['--abort']).catch(() => {})
                break
              }
            }
          }
        }

        if (!completed) continue

        // Convert file paths to ContentIds — immutable, survives slug renames
        const conflictIds = [...new Set(ourFiles)]
          .map(f => extractIdFromFilename(path.basename(f)))
          .filter((id): id is ContentId => id !== null)

        const hadConflicts = conflictIds.length > 0
        console.log(
          hadConflicts
            ? `  Rebased ${branchDir} (kept branch version for ${conflictIds.length} conflicting file(s))`
            : `  Rebased ${branchDir} successfully`
        )
        await meta.save({
          branch: {
            name: branchDir,
            conflictStatus: hadConflicts ? 'conflicts-detected' : 'clean',
            conflictFiles: conflictIds,
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
