import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Octokit } from '@octokit/rest'
import { dequeueTask, completeTask, failTask, recoverOrphanedTasks } from './task-queue'
import type { WorkerTask } from './task-queue'
import { getBranchMetadataFileManager } from '../branch-metadata'

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
}

const DEFAULT_TASK_TIMEOUT = 60_000

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
  private timeouts: NodeJS.Timeout[] = []
  private running = false
  private maxTasksPerCycle: number
  private taskTimeoutMs: number
  private lockFilePath: string

  constructor(private config: CmsWorkerConfig) {
    this.octokit = new Octokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.baseBranch = config.baseBranch ?? 'main'
    this.maxTasksPerCycle = config.maxTasksPerCycle ?? 10
    this.taskTimeoutMs = config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT
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
    const recovered = await recoverOrphanedTasks(this.taskDir)
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
    for (const timeout of this.timeouts) {
      clearTimeout(timeout)
    }
    this.timeouts = []
    await this.releaseLock()
    console.log('CMS Worker stopped')
  }

  /**
   * Acquire an EFS-based lock file to prevent concurrent workers.
   * Stale locks (older than 10 minutes with no running PID) are overwritten.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockFilePath), { recursive: true })

    try {
      const content = await fs.readFile(this.lockFilePath, 'utf-8')
      const { pid, timestamp } = JSON.parse(content) as { pid: number; timestamp: string }

      // Check if the lock is stale (PID no longer running or lock older than 10 minutes)
      const lockAgeMs = Date.now() - new Date(timestamp).getTime()
      const pidAlive = this.isPidAlive(pid)

      if (pidAlive && lockAgeMs < 10 * 60_000) {
        throw new Error(`Another worker is running (PID ${pid}, locked at ${timestamp}). Exiting.`)
      }

      console.log(`Overwriting stale lock (PID ${pid}, age ${Math.round(lockAgeMs / 1000)}s)`)
    } catch (err) {
      // Lock file doesn't exist or is invalid — proceed
      if (err instanceof Error && err.message.startsWith('Another worker')) throw err
    }

    await fs.writeFile(
      this.lockFilePath,
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      'utf-8',
    )
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
        try {
          await fn()
        } catch (err) {
          console.error('Worker loop error:', err instanceof Error ? err.message : err)
        }
        run()
      }, interval)
      this.timeouts.push(timeout)
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
      const remoteUrl = this.buildGitHubUrl()
      const git = simpleGit()
      await git.clone(remoteUrl, this.remoteGitPath, ['--bare'])
      console.log('remote.git initialized')
    }
  }

  /**
   * Process queued tasks from Lambda.
   * Polls .tasks/pending/ directory and executes each task.
   * Processes up to maxTasksPerCycle tasks per invocation.
   */
  async processTaskQueue(): Promise<void> {
    if (!this.running) return

    let processed = 0
    let task: WorkerTask | null
    while (processed < this.maxTasksPerCycle && (task = await dequeueTask(this.taskDir)) !== null) {
      try {
        const result = await this.executeTaskWithTimeout(task)
        await completeTask(this.taskDir, task.id, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`Task ${task.id} (${task.action}) failed:`, message)
        await failTask(this.taskDir, task.id, message)
      }
      processed++
    }
  }

  /**
   * Execute a task with a timeout. If the task takes longer than
   * taskTimeoutMs, it is aborted with a timeout error.
   */
  private async executeTaskWithTimeout(task: WorkerTask): Promise<Record<string, unknown>> {
    return Promise.race([
      this.executeTask(task),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timed out after ${this.taskTimeoutMs}ms`)), this.taskTimeoutMs),
      ),
    ])
  }

  private async executeTask(task: WorkerTask): Promise<Record<string, unknown>> {
    const { action, payload } = task
    const branch = payload.branch as string

    switch (action) {
      case 'push-branch': {
        await this.pushBranchToGitHub(branch)
        return { pushed: true }
      }
      case 'push-and-create-pr': {
        await this.pushBranchToGitHub(branch)
        const pr = await this.octokit.pulls.create({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          head: branch,
          base: (payload.baseBranch as string) ?? this.baseBranch,
          title: (payload.title as string) ?? `Submit ${branch}`,
          body: (payload.body as string) ?? '',
        })
        console.log(`Created PR #${pr.data.number} for ${branch}`)
        return { prUrl: pr.data.html_url, prNumber: pr.data.number }
      }
      case 'push-and-update-pr': {
        await this.pushBranchToGitHub(branch)
        const prNumber = payload.pullRequestNumber as number
        await this.octokit.pulls.update({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: prNumber,
          title: payload.title as string,
          body: payload.body as string,
        })
        console.log(`Updated PR #${prNumber} for ${branch}`)
        return { prNumber }
      }
      case 'convert-to-draft': {
        const draftPrNumber = payload.pullRequestNumber as number
        // GitHub REST API doesn't support converting to draft directly.
        // Use the GraphQL API via Octokit.
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: draftPrNumber,
        })
        await this.octokit.graphql(
          `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          { id: pr.node_id },
        )
        console.log(`Converted PR #${draftPrNumber} to draft`)
        return { prNumber: draftPrNumber, draft: true }
      }
      case 'close-pr': {
        const closePrNumber = payload.pullRequestNumber as number
        await this.octokit.pulls.update({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          pull_number: closePrNumber,
          state: 'closed',
        })
        return { closed: true }
      }
      case 'delete-remote-branch': {
        await this.octokit.git.deleteRef({
          owner: this.config.githubOwner,
          repo: this.config.githubRepo,
          ref: `heads/${branch}`,
        })
        return { deleted: true }
      }
      default:
        throw new Error(`Unknown task action: ${action}`)
    }
  }

  private buildGitHubUrl(): string {
    return `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  private async pushBranchToGitHub(branch: string): Promise<void> {
    const git = simpleGit({ baseDir: this.remoteGitPath })
    await this.ensureGitHubRemote(git)
    await git.push('github', branch)
    console.log(`Pushed ${branch} to GitHub`)
  }

  async syncGit(): Promise<void> {
    if (!this.running) return

    console.log('Syncing git...')
    const git = simpleGit({ baseDir: this.remoteGitPath })
    await this.ensureGitHubRemote(git)

    await git.fetch('github', ['--all', '--prune'])
    console.log('Fetched from GitHub')

    await this.rebaseActiveBranches()
  }

  private async ensureGitHubRemote(git: ReturnType<typeof simpleGit>): Promise<void> {
    const remotes = await git.getRemotes(true)
    if (!remotes.find(r => r.name === 'github')) {
      await git.addRemote('github', this.buildGitHubUrl())
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
      const branchPath = path.join(this.contentBranchesPath, branchDir)
      const gitDir = path.join(branchPath, '.git')

      try {
        const stat = await fs.stat(gitDir)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      try {
        const branchGit = simpleGit({ baseDir: branchPath })
        await branchGit.fetch('origin', this.baseBranch)

        const meta = getBranchMetadataFileManager(branchPath, this.contentBranchesPath)

        const status = await branchGit.status()
        if (status.behind > 0) {
          console.log(`Rebasing ${branchDir} (${status.behind} commits behind)...`)
          try {
            await branchGit.rebase([`origin/${this.baseBranch}`])
            console.log(`  Rebased ${branchDir} successfully`)
            await meta.save({ branch: { name: branchDir, conflictStatus: 'clean' } })
          } catch {
            await branchGit.rebase(['--abort']).catch(() => {})
            console.warn(`  Conflict detected in ${branchDir}`)
            await meta.save({ branch: { name: branchDir, conflictStatus: 'conflicts-detected' } })
          }
        }
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
