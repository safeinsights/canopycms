import fs from 'node:fs/promises'
import path from 'node:path'

import { simpleGit, type ConfigListSummary, type SimpleGit, type SimpleGitOptions, type StatusResult } from 'simple-git'

import type { OperatingMode } from './operating-mode'
import { createDebugLogger } from './utils/debug'

const log = createDebugLogger({ prefix: 'GitManager' })

// In-memory lock to prevent concurrent remote.git initialization
// Maps remotePath -> Promise<void> to serialize access
const remoteInitLocks = new Map<string, Promise<void>>()

export interface GitManagerOptions {
  repoPath: string
  baseBranch?: string
  remote?: string
}

export interface GitStatus extends Pick<StatusResult, 'files' | 'ahead' | 'behind' | 'current' | 'tracking'> {}

export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch: string
  sourceRoot?: string
}

export class GitManager {
  private readonly git: SimpleGit
  private readonly repoPath: string
  private readonly baseBranch: string
  private readonly remote: string

  constructor(options: GitManagerOptions, gitOptions?: Partial<SimpleGitOptions>) {
    this.repoPath = path.resolve(options.repoPath)
    this.baseBranch = options.baseBranch ?? 'main'
    this.remote = options.remote ?? 'origin'
    this.git = simpleGit({ baseDir: this.repoPath, ...gitOptions })
  }

  static async cloneRepo(remoteUrl: string, targetPath: string, baseBranch = 'main'): Promise<void> {
    log.debug('git', 'Cloning repository', { remoteUrl, targetPath, baseBranch })
    const git = simpleGit()
    await git.clone(remoteUrl, targetPath, ['--branch', baseBranch, '--single-branch'])
    log.debug('git', 'Clone complete')
  }

  /**
   * Initializes a local bare git repository to simulate a remote for local-prod-sim mode.
   *
   * This is idempotent - if the remote already exists, it will not be recreated.
   *
   * The remote is seeded with the current state of the baseBranch (e.g., 'main').
   * If you need to change the baseBranch or reset the simulation, delete
   * `.canopycms/remote.git` and `.canopycms/branches` and restart.
   *
   * @throws Error if not a git repo, no commits, or baseBranch doesn't exist
   */
  static async ensureLocalSimulatedRemote(options: {
    remotePath: string
    sourcePath: string
    baseBranch: string
    subdirectory?: string
  }): Promise<void> {
    // Serialize access per remote path to prevent race conditions
    // when multiple requests try to initialize the same remote simultaneously
    const existingLock = remoteInitLocks.get(options.remotePath)
    if (existingLock) {
      log.debug('git', 'Waiting for existing remote initialization', {
        remotePath: options.remotePath,
      })
      await existingLock
      // After waiting, verify the remote was created successfully
      // If not, fall through to try again (the lock was cleaned up)
      try {
        const stat = await fs.stat(options.remotePath)
        if (stat.isDirectory()) {
          log.debug('git', 'Remote exists after waiting for lock')
          return
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
        // Remote doesn't exist, fall through to create it
        log.debug('git', 'Remote does not exist after lock, will retry initialization')
      }
    }

    // Create new lock promise
    const lockPromise = log.timed('git', 'ensureLocalSimulatedRemote', async () => {
      try {
        log.debug('git', 'Initializing local simulated remote', {
          remotePath: options.remotePath,
          baseBranch: options.baseBranch,
        })

        // Check if already exists (idempotent)
        try {
          const stat = await fs.stat(options.remotePath)
          if (stat.isDirectory()) {
            log.debug('git', 'Remote already exists, skipping')
            return
          }
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err
        }

    // Find the actual git root directory
    // git subtree requires being run from the toplevel of the working tree
    let gitRoot = options.sourcePath
    try {
      const sourceGit = simpleGit({ baseDir: options.sourcePath })
      const result = await sourceGit.raw(['rev-parse', '--show-toplevel'])
      gitRoot = result.trim()
    } catch {
      // If we can't find git root, fall back to sourcePath
      gitRoot = options.sourcePath
    }

    const sourceGit = simpleGit({ baseDir: gitRoot })

    // Verify it's a git repo
    try {
      await sourceGit.status()
    } catch {
      throw new Error(
        'Cannot initialize local simulated remote: current directory is not a git repository. ' +
          'Please initialize git or provide an explicit remoteUrl.'
      )
    }

    // Verify it has commits
    let hasCommits = false
    try {
      const log = await sourceGit.log(['-1'])
      hasCommits = log.total > 0
    } catch {
      // Log command fails if no commits exist
      hasCommits = false
    }

    if (!hasCommits) {
      throw new Error(
        'Cannot initialize local simulated remote: repository has no commits. ' +
          'Please make an initial commit or provide an explicit remoteUrl.'
      )
    }

    // Verify baseBranch exists
    const branches = await sourceGit.branchLocal()
    if (!branches.all.includes(options.baseBranch)) {
      throw new Error(
        `Cannot initialize local simulated remote: base branch '${options.baseBranch}' does not exist locally. ` +
          `Please checkout '${options.baseBranch}' first or provide an explicit remoteUrl.`
      )
    }

      // Create bare remote
      log.debug('git', 'Creating bare remote repository')
      await fs.mkdir(path.dirname(options.remotePath), { recursive: true })
      await simpleGit().raw(['init', '--bare', options.remotePath])

      // Push baseBranch to remote (not current HEAD)
      const tempRemoteName = `__canopycms_init_${Date.now()}__`
      try {
        await sourceGit.addRemote(tempRemoteName, options.remotePath)

        if (options.subdirectory) {
          // For subdirectory pushes, use git subtree split
          // This creates a synthetic history with only the subdirectory content
          const splitBranch = `__canopycms_split_${Date.now()}__`
          try {
            await sourceGit.raw(['subtree', 'split', '--prefix', options.subdirectory, '-b', splitBranch])
            await sourceGit.push(tempRemoteName, `${splitBranch}:${options.baseBranch}`)
            await sourceGit.raw(['branch', '-D', splitBranch])
          } catch (err) {
            // Clean up split branch if it exists
            try {
              await sourceGit.raw(['branch', '-D', splitBranch])
            } catch {
              // ignore
            }
            throw err
          }
        } else {
          // Normal push of entire repo
          await sourceGit.push(tempRemoteName, `${options.baseBranch}:${options.baseBranch}`)
        }
      } finally {
        try {
          await sourceGit.removeRemote(tempRemoteName)
        } catch {
          // ignore cleanup errors
        }
      }

        log.debug('git', 'Remote initialization complete')
      } finally {
        // Always clean up the lock when done (success or failure)
        remoteInitLocks.delete(options.remotePath)
      }
    })

    // Store the lock promise
    remoteInitLocks.set(options.remotePath, lockPromise)

    // Wait for initialization to complete
    await lockPromise
  }

  /**
   * Find the git root directory
   * @returns Path to git root, or cwd if not in a git repo
   */
  static async findGitRoot(): Promise<string> {
    let gitRoot = process.cwd()
    try {
      const git = simpleGit({ baseDir: process.cwd() })
      const result = await git.raw(['rev-parse', '--show-toplevel'])
      gitRoot = result.trim()
    } catch {
      // Fall back to cwd if not in a git repo
    }
    return gitRoot
  }

  /**
   * Validate that a git repository exists at the given path
   * @param repoPath - Path to check for .git directory
   * @throws Error if git repo doesn't exist
   */
  static async validateGitRepoExists(repoPath: string): Promise<void> {
    try {
      const stat = await fs.stat(path.join(repoPath, '.git'))
      if (!stat.isDirectory()) {
        throw new Error(`Expected git repo at ${repoPath}`)
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`Expected git repo at ${repoPath}`)
      }
      throw err
    }
  }

  /**
   * Resolves the remote URL for git operations following the priority:
   * 1. Explicit remoteUrl parameter
   * 2. Config defaultRemoteUrl
   * 3. Environment variable (mode-specific)
   * 4. Auto-initialized local remote (for local-prod-sim mode)
   * 5. undefined (for local-simple mode)
   *
   * Uses strategy flags to determine behavior, GitManager executes the logic.
   *
   * @param options.sourceRoot - Optional source directory for monorepos. When provided,
   *   this directory (relative to git root) is used as the source for the simulated remote.
   *   Defaults to process.cwd().
   *
   * @returns Remote URL or undefined if no remote is needed
   */
  static async resolveRemoteUrl(options: ResolveRemoteUrlOptions): Promise<string | undefined> {
    const { operatingStrategy } = await import('./operating-mode')
    const strategy = operatingStrategy(options.mode)
    const config = strategy.getRemoteUrlConfig()

    // Centralized priority chain (no duplication across strategies)
    if (options.remoteUrl) return options.remoteUrl
    if (options.defaultRemoteUrl) return options.defaultRemoteUrl
    if (process.env[config.envVarName]) return process.env[config.envVarName]

    // Mode-specific behavior: auto-init local remote
    if (config.shouldAutoInitLocal) {
      const gitRoot = await this.findGitRoot()
      const sourceRoot = options.sourceRoot
      const sourcePath = sourceRoot ? path.resolve(gitRoot, sourceRoot) : gitRoot
      const localRemotePath = path.join(sourcePath, config.defaultRemotePath)

      await this.ensureLocalSimulatedRemote({
        remotePath: localRemotePath,
        sourcePath: gitRoot,
        baseBranch: options.baseBranch,
        subdirectory: sourceRoot,
      })

      return localRemotePath
    }

    return undefined
  }

  async status(): Promise<GitStatus> {
    const s = await this.git.status()
    return {
      files: s.files,
      ahead: s.ahead,
      behind: s.behind,
      current: s.current,
      tracking: s.tracking,
    }
  }

  async checkoutBranch(branch: string): Promise<void> {
    const branches = await this.git.branch()
    if (branches.all.includes(branch)) {
      await this.git.checkout(branch)
      return
    }

    const remoteRef = `${this.remote}/${this.baseBranch}`
    try {
      await this.git.fetch(this.remote, this.baseBranch)
    } catch {
      // Best-effort; will fall back to local base branch below if fetch fails
    }
    try {
      await this.git.checkoutBranch(branch, remoteRef)
      return
    } catch {
      const baseExists = branches.all.includes(this.baseBranch)
      if (baseExists) {
        await this.git.checkout(['-B', branch, this.baseBranch])
        return
      }
      await this.git.checkoutLocalBranch(branch)
    }
  }

  async pullBase(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    await this.git.merge([`${this.remote}/${this.baseBranch}`])
  }

  async rebaseOntoBase(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    await this.git.rebase([`${this.remote}/${this.baseBranch}`])
  }

  async add(files: string | string[]): Promise<void> {
    const fileArray = Array.isArray(files) ? files : [files]
    await this.git.add(fileArray)
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message)
  }

  async push(branch?: string): Promise<void> {
    const target = branch ?? (await this.git.revparse(['--abbrev-ref', 'HEAD']))
    await this.git.push(this.remote, target)
  }

  async ensureAuthor(author: { name: string; email: string }): Promise<void> {
    const config = (await this.git.listConfig()) as ConfigListSummary
    const currentName = config.all['user.name']
    const currentEmail = config.all['user.email']
    if (currentName !== author.name) {
      await this.git.addConfig('user.name', author.name)
    }
    if (currentEmail !== author.email) {
      await this.git.addConfig('user.email', author.email)
    }
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    const remotes = await this.git.getRemotes(true)
    const existing = remotes.find((r) => r.name === this.remote)
    if (!existing) {
      await this.git.addRemote(this.remote, remoteUrl)
      return
    }
    const currentUrl = existing.refs.push ?? existing.refs.fetch
    if (currentUrl && currentUrl !== remoteUrl) {
      await this.git.remote(['set-url', this.remote, remoteUrl])
    }
  }

  /**
   * Check if working directory has uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.status()
    return status.files.length > 0
  }

  /**
   * Get list of uncommitted file paths
   */
  async getUncommittedFiles(): Promise<string[]> {
    const status = await this.status()
    return status.files.map(f => f.path)
  }

  /**
   * Force push (use with caution - for PR updates only)
   * Uses --force-with-lease for safer force pushes
   */
  async forcePush(branch?: string): Promise<void> {
    const target = branch ?? (await this.git.revparse(['--abbrev-ref', 'HEAD']))
    await this.git.push(this.remote, target, ['--force-with-lease'])
  }

  /**
   * Get remote URL for current repo
   */
  async getRemoteUrl(): Promise<string | undefined> {
    const remotes = await this.git.getRemotes(true)
    const remote = remotes.find(r => r.name === this.remote)
    return remote?.refs.push || remote?.refs.fetch
  }
}
