import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Octokit } from '@octokit/rest'
import { dequeueTask, completeTask, failTask } from './task-queue'
import type { WorkerTask } from './task-queue'

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
  private intervals: NodeJS.Timeout[] = []
  private running = false

  constructor(private config: CmsWorkerConfig) {
    this.octokit = new Octokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.baseBranch = config.baseBranch ?? 'main'
  }

  async start(): Promise<void> {
    this.running = true
    console.log('CMS Worker starting...')

    // Ensure remote.git exists (init bare repo if first run)
    await this.ensureRemoteGit()

    // Run initial sync + cache refresh immediately
    const initialTasks: Promise<void>[] = [this.syncGit()]
    if (this.config.refreshAuthCache) {
      initialTasks.push(this.refreshAuthCache())
    }
    await Promise.allSettled(initialTasks)

    // Start recurring task loops
    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000

    this.intervals.push(
      setInterval(() => this.processTaskQueue().catch(console.error), taskInterval),
      setInterval(() => this.syncGit().catch(console.error), gitInterval),
    )

    if (this.config.refreshAuthCache) {
      const cacheInterval = this.config.authCacheRefreshInterval ?? 15 * 60_000
      this.intervals.push(
        setInterval(() => this.refreshAuthCache().catch(console.error), cacheInterval),
      )
      console.log(`  Auth cache refresh: every ${cacheInterval / 1000}s`)
    }

    console.log('CMS Worker started')
    console.log(`  Task queue poll: every ${taskInterval / 1000}s`)
    console.log(`  Git sync: every ${gitInterval / 1000}s`)
  }

  async stop(): Promise<void> {
    this.running = false
    for (const interval of this.intervals) {
      clearInterval(interval)
    }
    this.intervals = []
    console.log('CMS Worker stopped')
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
   */
  async processTaskQueue(): Promise<void> {
    if (!this.running) return

    let task: WorkerTask | null
    while ((task = await dequeueTask(this.taskDir)) !== null) {
      try {
        const result = await this.executeTask(task)
        await completeTask(this.taskDir, task.id, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`Task ${task.id} (${task.action}) failed:`, message)
        await failTask(this.taskDir, task.id, message)
      }
    }
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
    if (!remotes.find((r) => r.name === 'github')) {
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

        const status = await branchGit.status()
        if (status.behind > 0) {
          console.log(`Rebasing ${branchDir} (${status.behind} commits behind)...`)
          try {
            await branchGit.rebase([`origin/${this.baseBranch}`])
            console.log(`  Rebased ${branchDir} successfully`)
          } catch {
            await branchGit.rebase(['--abort']).catch(() => {})
            console.warn(`  Conflict detected in ${branchDir}`)
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
