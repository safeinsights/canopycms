import fs from 'node:fs/promises'
import path from 'node:path'

import {
  simpleGit,
  type ConfigListSummary,
  type SimpleGit,
  type SimpleGitOptions,
  type StatusResult,
} from 'simple-git'

import type { OperatingMode } from './operating-mode'
import { createDebugLogger } from './utils/debug'
import { isNotFoundError } from './utils/error'
import { detectHeadBranch } from './utils/git'

const log = createDebugLogger({ prefix: 'GitManager' })

// In-memory lock to prevent concurrent remote.git initialization
// Maps remotePath -> Promise<void> to serialize access
const remoteInitLocks = new Map<string, Promise<void>>()

export interface GitManagerOptions {
  repoPath: string
  baseBranch?: string
  remote?: string
}

export type GitStatus = Pick<StatusResult, 'files' | 'ahead' | 'behind' | 'current' | 'tracking'>

export class GitConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Git conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}`)
    this.name = 'GitConflictError'
  }
}

export class GitNonFastForwardError extends Error {
  constructor() {
    super('Non-fast-forward update rejected')
    this.name = 'GitNonFastForwardError'
  }
}

export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch: string
  sourceRoot?: string
}

export interface InitializeWorkspaceOptions {
  workspacePath: string
  branchName: string
  mode: OperatingMode
  baseBranch?: string
  sourceRoot?: string
  defaultRemoteUrl?: string
  remoteUrl?: string
  remoteName?: string
  branchType: 'content' | 'orphan' // Determines checkout vs createOrphan
  /** Git author name for internal commits (e.g., orphan branch init). */
  gitBotAuthorName: string
  /** Git author email for internal commits (e.g., orphan branch init). */
  gitBotAuthorEmail: string
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
    // Prevent git from traversing above repoPath to find a parent .git directory.
    // If the workspace's .git is corrupt/missing, git should fail rather than
    // silently operating on the host repo above.
    this.git.env('GIT_CEILING_DIRECTORIES', path.dirname(this.repoPath))
  }

  static async cloneRepo(
    remoteUrl: string,
    targetPath: string,
    baseBranch = 'main',
  ): Promise<void> {
    log.debug('git', 'Cloning repository', {
      remoteUrl,
      targetPath,
      baseBranch,
    })
    const git = simpleGit()
    await git.clone(remoteUrl, targetPath, ['--branch', baseBranch, '--single-branch'])
    log.debug('git', 'Clone complete')
  }

  /**
   * Initializes a local bare git repository to simulate a remote for dev mode.
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
      } catch (err: unknown) {
        if (!isNotFoundError(err)) throw err
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
        } catch (err: unknown) {
          if (!isNotFoundError(err)) throw err
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
              'Please initialize git or provide an explicit remoteUrl.',
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
              'Please make an initial commit or provide an explicit remoteUrl.',
          )
        }

        // Verify baseBranch exists
        const branches = await sourceGit.branchLocal()
        if (!branches.all.includes(options.baseBranch)) {
          throw new Error(
            `Cannot initialize local simulated remote: base branch '${options.baseBranch}' does not exist locally. ` +
              `Please checkout '${options.baseBranch}' first or provide an explicit remoteUrl.`,
          )
        }

        // Create bare remote
        log.debug('git', 'Creating bare remote repository')
        await fs.mkdir(path.dirname(options.remotePath), { recursive: true })
        await simpleGit().raw([
          'init',
          '--bare',
          `--initial-branch=${options.baseBranch}`,
          options.remotePath,
        ])

        // Push baseBranch to remote (not current HEAD)
        const tempRemoteName = `__canopycms_init_${Date.now()}__`
        try {
          await sourceGit.addRemote(tempRemoteName, options.remotePath)

          if (options.subdirectory) {
            // For subdirectory pushes, use git subtree split
            // This creates a synthetic history with only the subdirectory content
            const splitBranch = `__canopycms_split_${Date.now()}__`
            try {
              await sourceGit.raw([
                'subtree',
                'split',
                '--prefix',
                options.subdirectory,
                '-b',
                splitBranch,
              ])
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
      if (isNotFoundError(err)) {
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
   * 4. Auto-initialized local remote (for dev mode)
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
    // Dynamic import: operating-mode contains Node-only code; deferring the
    // import keeps git-manager loadable in non-Node evaluation contexts
    const { operatingStrategy } = await import('./operating-mode')
    const strategy = operatingStrategy(options.mode)
    const config = strategy.getRemoteUrlConfig()

    // Centralized priority chain (no duplication across strategies)
    if (options.remoteUrl) return options.remoteUrl
    if (options.defaultRemoteUrl) return options.defaultRemoteUrl
    if (process.env[config.envVarName]) return process.env[config.envVarName]

    // Auto-detect: check if a pre-existing remote.git exists at the expected path
    // (e.g., created by EC2 worker on EFS in prod mode)
    if (config.autoDetectRemotePath) {
      try {
        const stat = await fs.stat(config.autoDetectRemotePath)
        if (stat.isDirectory()) {
          log.debug('git', 'Auto-detected local remote', {
            path: config.autoDetectRemotePath,
          })
          return config.autoDetectRemotePath
        }
      } catch {
        // Path doesn't exist — fall through to next resolution step
      }
    }

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

  /**
   * Ensures a git workspace is initialized and ready for use.
   * Handles cloning, remote configuration, and branch checkout/creation.
   *
   * This centralizes the common initialization sequence used by both BranchWorkspaceManager
   * and SettingsWorkspaceManager.
   *
   * Note: Does NOT configure git author - that should be done before commits, not during init.
   *
   * @returns Configured GitManager instance for the workspace
   */
  static async initializeWorkspace(options: InitializeWorkspaceOptions): Promise<GitManager> {
    // In dev mode, auto-detect the current HEAD branch when baseBranch is not explicitly set
    let baseBranch = options.baseBranch
    if (!baseBranch && options.mode === 'dev') {
      const sourceRoot = options.sourceRoot
        ? path.resolve(process.cwd(), options.sourceRoot)
        : process.cwd()
      baseBranch = await detectHeadBranch(sourceRoot)
    }
    baseBranch = baseBranch ?? 'main'
    const remoteName = options.remoteName ?? 'origin'

    // 1. Check if git already initialized (with traversal protection)
    let repoExists = false
    try {
      const checkGit = simpleGit({ baseDir: options.workspacePath })
      // Ceiling prevents git from traversing to a parent repo if .git is corrupt
      checkGit.env('GIT_CEILING_DIRECTORIES', path.dirname(options.workspacePath))
      await checkGit.raw(['rev-parse', '--git-dir'])
      repoExists = true
    } catch {
      // Not a valid git repo — clean up corrupt .git if present so clone can proceed
      const gitPath = path.join(options.workspacePath, '.git')
      try {
        const stat = await fs.stat(gitPath)
        if (stat.isDirectory()) {
          log.debug('git', 'Removing corrupt .git directory', {
            workspacePath: options.workspacePath,
          })
          await fs.rm(gitPath, { recursive: true })
        }
      } catch (cleanupErr: unknown) {
        if (!isNotFoundError(cleanupErr)) throw cleanupErr
      }
    }

    // 2. Clone if needed
    let justCloned = false
    if (!repoExists) {
      // Resolve remote URL only when we need to clone
      const remoteUrl = await GitManager.resolveRemoteUrl({
        mode: options.mode,
        remoteUrl: options.remoteUrl,
        defaultRemoteUrl: options.defaultRemoteUrl,
        baseBranch,
        sourceRoot: options.sourceRoot,
      })

      // Require remoteUrl for cloning
      if (!remoteUrl) {
        throw new Error(
          'CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to initialize workspace',
        )
      }

      // Clone repository (automatically configures 'origin' remote)
      await GitManager.cloneRepo(remoteUrl, options.workspacePath, baseBranch)
      justCloned = true

      // Mark as managed immediately after clone so ensureRemote guard works.
      // Also set a fallback author identity — GIT_CEILING_DIRECTORIES blocks
      // global gitconfig, and internal commits (e.g., orphan branch init) need one.
      // The real bot author is set later via ensureAuthor() before user-facing commits.
      const freshGit = simpleGit({ baseDir: options.workspacePath })
      freshGit.env('GIT_CEILING_DIRECTORIES', path.dirname(options.workspacePath))
      await freshGit.addConfig('canopycms.managed', 'true')
      await freshGit.addConfig('user.name', options.gitBotAuthorName)
      await freshGit.addConfig('user.email', options.gitBotAuthorEmail)
    }

    // 3. Create GitManager instance
    const git = new GitManager({
      repoPath: options.workspacePath,
      baseBranch,
      remote: remoteName,
    })

    // 4. Ensure managed marker and fallback identity.
    // Must happen before ensureRemote (which checks the marker) and before
    // createOrphanSettingsBranch (which commits and needs an author).
    // Idempotent — may already be set from the clone step above.
    await git.git.addConfig('canopycms.managed', 'true')
    await git.git.addConfig('user.name', options.gitBotAuthorName)
    await git.git.addConfig('user.email', options.gitBotAuthorEmail)
    log.debug('git', 'Marked workspace as CanopyCMS-managed', {
      workspacePath: options.workspacePath,
    })

    // 5. Configure git remote only if we didn't just clone
    // (clone already sets up the 'origin' remote)
    if (!justCloned) {
      const remoteUrl = await GitManager.resolveRemoteUrl({
        mode: options.mode,
        remoteUrl: options.remoteUrl,
        defaultRemoteUrl: options.defaultRemoteUrl,
        baseBranch,
        sourceRoot: options.sourceRoot,
      })
      if (remoteUrl) {
        await git.ensureRemote(remoteUrl)
      }
    }

    // 6. Checkout or create branch based on type
    if (options.branchType === 'orphan') {
      await git.createOrphanSettingsBranch(options.branchName, {})
    } else {
      await git.checkoutBranch(options.branchName)
    }

    return git
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
    try {
      await this.git.merge([`${this.remote}/${this.baseBranch}`])
    } catch {
      // Capture conflicted files before aborting — abort clears them from status
      const status = await this.git.status()
      await this.git.merge(['--abort']).catch(() => {})
      throw new GitConflictError(status.conflicted)
    }
  }

  async pullCurrentBranch(): Promise<void> {
    const branches = await this.git.branch()
    const currentBranch = branches.current
    await this.git.fetch(this.remote, currentBranch)
    try {
      await this.git.merge([`${this.remote}/${currentBranch}`])
    } catch {
      // Capture conflicted files before aborting — abort clears them from status
      const status = await this.git.status()
      await this.git.merge(['--abort']).catch(() => {})
      throw new GitConflictError(status.conflicted)
    }
  }

  async rebaseOntoBase(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    try {
      await this.git.rebase([`${this.remote}/${this.baseBranch}`])
    } catch {
      // Capture conflicted files before aborting — abort clears them from status
      const status = await this.git.status()
      await this.git.rebase(['--abort']).catch(() => {})
      throw new GitConflictError(status.conflicted)
    }
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
    // Use explicit refspec (local:remote) so push works for new branches
    // that don't yet exist in the remote (e.g., orphan settings branches).
    await this.git.push(this.remote, `${target}:${target}`, ['--set-upstream'])
  }

  async ensureAuthor(author: { name: string; email: string }): Promise<void> {
    const config = (await this.git.listConfig()) as ConfigListSummary

    // Verify this is a CanopyCMS-managed workspace before setting author
    const isManaged = config.all['canopycms.managed'] === 'true'
    if (!isManaged) {
      throw new Error(
        `Cannot set git bot author in non-managed repository (${this.repoPath}). ` +
          `Bot identity should only be set in CanopyCMS branch clones or test workspaces. ` +
          `If this is a test workspace, add "git config canopycms.managed true" to mark it as managed.`,
      )
    }

    // Set author identity
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
    // Safety: verify this is a managed workspace before modifying remotes.
    // Prevents accidentally overwriting the host repo's origin if git
    // traversed up from a corrupt workspace .git directory.
    const config = (await this.git.listConfig()) as ConfigListSummary
    const isManaged = config.all['canopycms.managed'] === 'true'
    if (!isManaged) {
      throw new Error(
        `Cannot modify remote in non-managed repository (${this.repoPath}). ` +
          `This likely means git traversed to a parent repository. ` +
          `Expected a CanopyCMS workspace.`,
      )
    }

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
    return status.files.map((f) => f.path)
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
    const remote = remotes.find((r) => r.name === this.remote)
    return remote?.refs.push || remote?.refs.fetch
  }

  /**
   * Add a pattern to .git/info/exclude to prevent it from being committed/pushed.
   * This is used to exclude .canopy-meta/ from content branch workspaces.
   *
   * .git/info/exclude is a per-repository gitignore that never gets committed.
   * Perfect for runtime metadata that should never leave the workspace.
   *
   * This is idempotent - if the pattern already exists, it won't be added again.
   */
  async ensureGitExclude(pattern: string): Promise<void> {
    const excludePath = path.join(this.repoPath, '.git', 'info', 'exclude')

    // Ensure .git/info directory exists
    await fs.mkdir(path.dirname(excludePath), { recursive: true })

    // Read existing exclude file (create if doesn't exist)
    let content = ''
    try {
      content = await fs.readFile(excludePath, 'utf-8')
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
      // File doesn't exist, will create it
    }

    // Check if pattern already exists (avoid duplicates)
    const lines = content.split('\n')
    if (lines.some((line) => line.trim() === pattern)) {
      log.debug('git', 'Pattern already in .git/info/exclude', { pattern })
      return
    }

    // Add pattern (with newline if file is not empty and doesn't end with one)
    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n')
    const newContent = content + (needsLeadingNewline ? '\n' : '') + pattern + '\n'

    await fs.writeFile(excludePath, newContent, 'utf-8')
    log.debug('git', 'Added pattern to .git/info/exclude', { pattern })
  }

  /**
   * Create an orphan branch for settings (permissions/groups).
   *
   * Orphan branches have no shared history with other branches - they start fresh.
   * This is perfect for deployment-specific settings that shouldn't pollute content history.
   *
   * The branch contains only settings files in .canopy-meta/ (groups.json, permissions.json).
   *
   * @param branchName - Name of the orphan branch (e.g., 'canopycms-settings-prod')
   * @param initialFiles - Files to commit to the new branch (e.g., { 'permissions.json': '{}', 'groups.json': '{}' })
   */
  async createOrphanSettingsBranch(
    branchName: string,
    initialFiles: Record<string, string>,
  ): Promise<void> {
    log.debug('git', 'Creating orphan settings branch', { branchName })

    // Check if branch already exists
    const branches = await this.git.branch()
    if (branches.all.includes(branchName)) {
      log.debug('git', 'Orphan branch already exists', { branchName })
      // Checkout the existing branch
      await this.git.checkout(branchName)
      return
    }

    // Create orphan branch (--orphan creates a branch with no parent/history)
    await this.git.raw(['checkout', '--orphan', branchName])

    // Remove all files from index (orphan checkout keeps working tree)
    try {
      await this.git.raw(['rm', '-rf', '.'])
    } catch {
      // Ignore errors (might fail if index is already empty)
    }

    // Write initial files
    for (const [filePath, content] of Object.entries(initialFiles)) {
      const absolutePath = path.join(this.repoPath, filePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')
      await this.git.add(filePath)
    }

    // Commit initial files
    await this.git.commit('Initialize settings branch', ['--allow-empty'])

    log.debug('git', 'Orphan settings branch created', { branchName })
  }
}
