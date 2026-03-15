import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Octokit } from '@octokit/rest'
import { dequeueTask, completeTask, failTask } from 'canopycms/worker/task-queue'
import type { WorkerTask } from 'canopycms/worker/task-queue'
import { refreshClerkCache } from 'canopycms-auth-clerk/cache-writer'

export interface CmsWorkerConfig {
  /** Path to workspace root on EFS (e.g., /mnt/efs/workspace) */
  workspacePath: string
  /** GitHub owner (e.g., 'safeinsights') */
  githubOwner: string
  /** GitHub repo name (e.g., 'docs-site') */
  githubRepo: string
  /** GitHub bot token for pushing and PR operations */
  githubToken: string
  /** Clerk secret key for refreshing user cache */
  clerkSecretKey: string
  /** Whether to use Clerk organizations as groups (default: true) */
  useOrganizationsAsGroups?: boolean
  /** Task queue poll interval in ms (default: 5000) */
  taskPollInterval?: number
  /** Git sync interval in ms (default: 5 * 60 * 1000) */
  gitSyncInterval?: number
  /** Clerk cache refresh interval in ms (default: 15 * 60 * 1000) */
  clerkRefreshInterval?: number
  /** Base branch name (default: 'main') */
  baseBranch?: string
}

/**
 * CMS Worker daemon.
 * Runs on an EC2 instance with internet access, handling operations
 * that Lambda (with no internet) cannot perform:
 * - Processing queued tasks (push branches, create PRs)
 * - Syncing bare repo with GitHub
 * - Rebasing active branch workspaces
 * - Refreshing Clerk user/org metadata cache
 */
export class CmsWorker {
  private octokit: Octokit
  private taskDir: string
  private remoteGitPath: string
  private contentBranchesPath: string
  private cachePath: string
  private baseBranch: string
  private intervals: NodeJS.Timeout[] = []
  private running = false

  constructor(private config: CmsWorkerConfig) {
    this.octokit = new Octokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.cachePath = path.join(config.workspacePath, '.cache')
    this.baseBranch = config.baseBranch ?? 'main'
  }

  async start(): Promise<void> {
    this.running = true
    console.log('CMS Worker starting...')

    // Ensure remote.git exists (init bare repo if first run)
    await this.ensureRemoteGit()

    // Run initial sync + cache refresh immediately
    await Promise.allSettled([this.syncGit(), this.refreshCache()])

    // Start recurring task loops
    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000
    const cacheInterval = this.config.clerkRefreshInterval ?? 15 * 60_000

    this.intervals.push(
      setInterval(() => this.processTaskQueue().catch(console.error), taskInterval),
      setInterval(() => this.syncGit().catch(console.error), gitInterval),
      setInterval(() => this.refreshCache().catch(console.error), cacheInterval),
    )

    console.log('CMS Worker started')
    console.log(`  Task queue poll: every ${taskInterval / 1000}s`)
    console.log(`  Git sync: every ${gitInterval / 1000}s`)
    console.log(`  Clerk cache refresh: every ${cacheInterval / 1000}s`)
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
      // Create bare clone from GitHub
      console.log('Initializing remote.git from GitHub...')
      const remoteUrl = `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
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
    // Process all pending tasks in one batch
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

  /**
   * Push a branch from the local remote.git to GitHub.
   */
  private async pushBranchToGitHub(branch: string): Promise<void> {
    const git = simpleGit({ baseDir: this.remoteGitPath })
    const remoteUrl = `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`

    // Ensure github remote is configured
    const remotes = await git.getRemotes(true)
    const githubRemote = remotes.find((r) => r.name === 'github')
    if (!githubRemote) {
      await git.addRemote('github', remoteUrl)
    }

    await git.push('github', branch)
    console.log(`Pushed ${branch} to GitHub`)
  }

  /**
   * Sync local remote.git with GitHub.
   * Fetches all branches from GitHub, then for each active branch workspace,
   * fetches from local remote.git and attempts rebase.
   */
  async syncGit(): Promise<void> {
    if (!this.running) return

    console.log('Syncing git...')
    const git = simpleGit({ baseDir: this.remoteGitPath })
    const remoteUrl = `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`

    // Ensure github remote
    const remotes = await git.getRemotes(true)
    if (!remotes.find((r) => r.name === 'github')) {
      await git.addRemote('github', remoteUrl)
    }

    // Fetch from GitHub into bare repo
    await git.fetch('github', ['--all', '--prune'])
    console.log('Fetched from GitHub')

    // Rebase active branch workspaces
    await this.rebaseActiveBranches()
  }

  /**
   * For each active branch workspace, fetch from local remote.git
   * and attempt rebase onto updated base branch.
   */
  private async rebaseActiveBranches(): Promise<void> {
    let branchDirs: string[]
    try {
      branchDirs = await fs.readdir(this.contentBranchesPath)
    } catch {
      return // No branches yet
    }

    for (const branchDir of branchDirs) {
      const branchPath = path.join(this.contentBranchesPath, branchDir)
      const gitDir = path.join(branchPath, '.git')

      try {
        const stat = await fs.stat(gitDir)
        if (!stat.isDirectory()) continue
      } catch {
        continue // Not a git workspace
      }

      try {
        const branchGit = simpleGit({ baseDir: branchPath })

        // Fetch from local remote.git (fast, no network)
        await branchGit.fetch('origin', this.baseBranch)

        // Check if rebase is needed
        const status = await branchGit.status()
        if (status.behind > 0) {
          console.log(`Rebasing ${branchDir} (${status.behind} commits behind)...`)
          try {
            await branchGit.rebase([`origin/${this.baseBranch}`])
            console.log(`  Rebased ${branchDir} successfully`)
            // TODO: Update branch metadata with last-synced timestamp
          } catch {
            // Conflict — abort rebase and flag the branch
            await branchGit.rebase(['--abort']).catch(() => {})
            console.warn(`  Conflict detected in ${branchDir}`)
            // TODO: Write conflict status to branch metadata
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.warn(`  Failed to sync ${branchDir}: ${message}`)
      }
    }
  }

  /**
   * Refresh Clerk user/org metadata cache.
   * Writes JSON files to .cache/ on EFS for Lambda's CachingAuthPlugin.
   */
  async refreshCache(): Promise<void> {
    if (!this.running) return

    console.log('Refreshing Clerk cache...')
    try {
      const result = await refreshClerkCache({
        secretKey: this.config.clerkSecretKey,
        cachePath: this.cachePath,
        useOrganizationsAsGroups: this.config.useOrganizationsAsGroups ?? true,
      })
      console.log(`Clerk cache refreshed: ${result.userCount} users, ${result.groupCount} groups`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('Failed to refresh Clerk cache:', message)
    }
  }
}
