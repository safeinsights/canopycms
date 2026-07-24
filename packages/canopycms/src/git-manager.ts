import fs from 'node:fs/promises'
import path from 'node:path'

import {
  simpleGit,
  type ConfigListSummary,
  type SimpleGit,
  type SimpleGitOptions,
  type StatusResult,
} from 'simple-git'

import { invalidateContentIndexesForRoot } from './content-index-registry'
import { invalidateBranchContentCaches } from './content-index-generation'
import type { OperatingMode } from './operating-mode'
import { createDebugLogger } from './utils/debug'
import { getErrorMessage, isNotFoundError } from './utils/error'
import { isNetworkRemoteUrl, resolveBaseBranch } from './utils/git'
import { acquireProvisioningLock } from './utils/provisioning-lock'

const log = createDebugLogger({ prefix: 'GitManager' })

/**
 * Child environment for spawned git processes. simple-git's .env() REPLACES
 * the child env entirely (deploy-proven 2026-07-24: every Lambda git spawn
 * failed with "dubious ownership" on the uid-1000-owned EFS clones because
 * the child env lost the runtime's git variables). Spreading ALL of
 * process.env trips simple-git's unsafe-variable blocklist on hosts where
 * GIT_EDITOR/GIT_SSH_COMMAND etc. are set - so pass through a deterministic
 * ALLOWLIST of process basics + author/tracing families.
 *
 * GIT_CONFIG_* is deliberately NOT passed through: simple-git hard-blocks
 * env-based git config (allowUnsafeConfigEnvCount) since it can inject
 * arbitrary settings. Host-level config like the safe.directory workaround
 * for uid-mismatched EFS clones belongs in the image's SYSTEM gitconfig -
 * see Dockerfile.cms.template's `git config --system` line.
 */
const GIT_ENV_PASSTHROUGH =
  /^(PATH|HOME|USER|LANG|LC_[A-Z]+|TZ|TMPDIR|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|GIT_TERMINAL_PROMPT|GIT_TRACE[A-Z_]*)$/
function gitChildEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && GIT_ENV_PASSTHROUGH.test(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

// In-memory lock to prevent concurrent remote.git initialization
// Maps remotePath -> Promise<void> to serialize access
const remoteInitLocks = new Map<string, Promise<void>>()

/**
 * Add a pattern to a repo's .git/info/exclude (a per-repository gitignore that
 * never gets committed) so runtime metadata like .canopy-meta/ can't be staged
 * by broad `git add` calls. Idempotent. Standalone so workspace-creating code
 * that doesn't hold a GitManager (e.g. CLI sync auto-create) can use it too.
 */
export async function ensureGitExcludePattern(repoPath: string, pattern: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude')

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

export interface GitManagerOptions {
  repoPath: string
  baseBranch?: string
  remote?: string
  /**
   * Skip writing the on-disk content-index generation marker after working-tree
   * mutations. Set for settings workspaces: no ContentStore is ever rooted at
   * one, and the marker file would sit untracked in the settings repo.
   * In-process index invalidation still runs (it is free and harmless).
   */
  skipIndexMarker?: boolean
}

export type GitStatus = Pick<StatusResult, 'files' | 'ahead' | 'behind' | 'current' | 'tracking'>

export class GitConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Git conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}`)
    this.name = 'GitConflictError'
  }
}

export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch: string
  sourceRoot?: string
  /**
   * Escape hatch: allow a resolved NETWORK remote URL (from remoteUrl/
   * defaultRemoteUrl/the strategy env var) in prod mode. See CanopyConfig's
   * `allowNetworkRemoteInProd` doc comment. Has no effect in dev mode.
   */
  allowNetworkRemoteInProd?: boolean
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
  /**
   * Escape hatch: allow a resolved NETWORK remote URL in prod mode. Threaded
   * through to `resolveRemoteUrl` — see its option of the same name and
   * CanopyConfig's `allowNetworkRemoteInProd` doc comment.
   */
  allowNetworkRemoteInProd?: boolean
  branchType: 'content' | 'orphan' // Determines checkout vs createOrphan
  /** Git author name for internal commits (e.g., orphan branch init). */
  gitBotAuthorName: string
  /** Git author email for internal commits (e.g., orphan branch init). */
  gitBotAuthorEmail: string
  /**
   * Pattern to add to `.git/info/exclude` so runtime metadata
   * (e.g., `.canopy-meta/`) never enters the workspace's git history.
   * Only applied to content branches; settings workspaces don't need it
   * (their payloads live at the workspace root and are committed by
   * explicit path).
   */
  gitExcludePattern?: string
}

export class GitManager {
  private readonly git: SimpleGit
  private readonly repoPath: string
  private readonly baseBranch: string
  private readonly remote: string
  private readonly skipIndexMarker: boolean

  constructor(options: GitManagerOptions, gitOptions?: Partial<SimpleGitOptions>) {
    this.repoPath = path.resolve(options.repoPath)
    this.baseBranch = options.baseBranch ?? 'main'
    this.remote = options.remote ?? 'origin'
    this.skipIndexMarker = options.skipIndexMarker ?? false
    this.git = simpleGit({ baseDir: this.repoPath, ...gitOptions })
    // Prevent git from traversing above repoPath to find a parent .git directory.
    // If the workspace's .git is corrupt/missing, git should fail rather than
    // silently operating on the host repo above.
    this.git.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(this.repoPath) }))
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
   * When the remote already exists but is missing the requested baseBranch
   * (dev-mode branch auto-detect makes this routine: any git branch created
   * after the remote was first seeded), that branch is pushed from the source
   * repo on demand. Branches that already exist in the remote are never
   * updated here — the CMS pushes editor state into this remote, and a
   * refresh from the source repo would clobber it.
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
    // when multiple requests try to initialize the same remote simultaneously.
    // After waiting, still proceed: the finished initialization may have seeded
    // a different baseBranch than the one this caller needs.
    const existingLock = remoteInitLocks.get(options.remotePath)
    if (existingLock) {
      log.debug('git', 'Waiting for existing remote initialization', {
        remotePath: options.remotePath,
      })
      await existingLock
    }

    // Create new lock promise
    const lockPromise = log.timed('git', 'ensureLocalSimulatedRemote', async () => {
      // The in-memory lock above only serializes within one process; take a
      // cross-process lock too so parallel build workers can't both create the
      // bare remote and race ("cannot mkdir remote.git: File exists"). Released
      // in the finally below.
      let releaseLock: (() => Promise<void>) | undefined
      try {
        log.debug('git', 'Initializing local simulated remote', {
          remotePath: options.remotePath,
          baseBranch: options.baseBranch,
        })

        // Take the cross-process lock before checking/creating the bare remote.
        const remoteParent = path.dirname(options.remotePath)
        releaseLock = await acquireProvisioningLock(remoteParent, '.remote-init.lock')

        // Check if already exists — another process may have finished
        // provisioning while we waited for the lock.
        let remoteExists = false
        try {
          const stat = await fs.stat(options.remotePath)
          remoteExists = stat.isDirectory()
        } catch (err: unknown) {
          if (!isNotFoundError(err)) throw err
        }

        if (
          remoteExists &&
          (await GitManager.bareRemoteHasBranch(options.remotePath, options.baseBranch))
        ) {
          log.debug('git', 'Remote already has base branch, skipping')
          return
        }

        // Find the actual git root directory — the subdirectory snapshot path
        // (`<branch>:<subdirectory>`) is relative to the repository toplevel
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

        if (remoteExists) {
          // Refresh path: the remote predates this base branch (e.g. it was seeded
          // months ago and the developer has since created/switched branches).
          // Push just the missing branch; existing branches are never touched.
          log.debug('git', 'Existing remote is missing base branch — pushing it from source', {
            remotePath: options.remotePath,
            baseBranch: options.baseBranch,
          })
        } else {
          // Create bare remote (parent dir already ensured above, under the lock)
          log.debug('git', 'Creating bare remote repository')
          await simpleGit().raw([
            'init',
            '--bare',
            `--initial-branch=${options.baseBranch}`,
            options.remotePath,
          ])
        }

        // Push baseBranch to remote (not current HEAD)
        await GitManager.pushBranchToLocalRemote({
          sourceGit,
          remotePath: options.remotePath,
          baseBranch: options.baseBranch,
          subdirectory: options.subdirectory,
        })

        log.debug('git', 'Remote initialization complete')
      } finally {
        // Release the cross-process lock first, then clear the in-memory lock.
        if (releaseLock) {
          try {
            await releaseLock()
          } catch (err: unknown) {
            log.debug('git', 'Failed to release remote-init lock', { err })
          }
        }
        remoteInitLocks.delete(options.remotePath)
      }
    })

    // Store the lock promise
    remoteInitLocks.set(options.remotePath, lockPromise)

    // Wait for initialization to complete
    await lockPromise
  }

  /**
   * Whether a bare repository already has a local branch of the given name.
   *
   * Runs git with an explicit `--git-dir` instead of a cwd inside the repo:
   * environments with `safe.bareRepository=explicit` (sandboxed/CI git setups)
   * refuse cwd-based discovery of bare repos but expressly allow `--git-dir`.
   * `branch --list` exits 0 whether or not the branch exists (no
   * exception-based control flow — also why `rev-parse --verify --quiet`
   * can't be used: simple-git only fails a task on stderr output, and --quiet
   * suppresses exactly that). A failure here therefore means the remote
   * itself is unreadable and is surfaced, NOT treated as "branch absent" —
   * that would route to the push path against a repo we couldn't even read.
   */
  private static async bareRemoteHasBranch(remotePath: string, branch: string): Promise<boolean> {
    let output: string
    try {
      output = await simpleGit().raw(['--git-dir', remotePath, 'branch', '--list', branch])
    } catch (err) {
      throw new Error(`Cannot inspect simulated remote at ${remotePath}: ${getErrorMessage(err)}`)
    }
    return output
      .split('\n')
      .map((line) => line.replace(/^[*+]\s*/, '').trim())
      .includes(branch)
  }

  /**
   * Push baseBranch from the source repo into the local bare remote via a
   * temporary remote. With `subdirectory`, pushes a single snapshot commit of
   * that subdirectory's tree at baseBranch instead of the full history:
   * `git subtree split` forks subprocesses per commit (minutes on large
   * repos), and the simulated remote never needs history — branches already
   * present are never updated, and editor state is committed on top of the
   * seed.
   */
  private static async pushBranchToLocalRemote(options: {
    sourceGit: SimpleGit
    remotePath: string
    baseBranch: string
    subdirectory?: string
  }): Promise<void> {
    const { sourceGit } = options
    const tempRemoteName = `__canopycms_init_${Date.now()}__`
    try {
      await sourceGit.addRemote(tempRemoteName, options.remotePath)

      if (options.subdirectory) {
        // Snapshot the subdirectory tree at baseBranch (not HEAD) and push it
        // as a single root commit.
        const tree = (
          await sourceGit.raw(['rev-parse', `${options.baseBranch}:${options.subdirectory}`])
        ).trim()
        const commit = (
          await sourceGit.raw([
            '-c',
            'user.name=CanopyCMS',
            '-c',
            'user.email=canopycms@localhost',
            'commit-tree',
            tree,
            '-m',
            `CanopyCMS dev base snapshot of ${options.baseBranch}:${options.subdirectory}`,
          ])
        ).trim()
        // --no-verify: this is internal plumbing into the simulated remote;
        // the adopter's pre-push hooks (husky etc.) must not block it
        await sourceGit.raw([
          'push',
          '--no-verify',
          tempRemoteName,
          `${commit}:refs/heads/${options.baseBranch}`,
        ])
      } else {
        // Normal push of entire repo (--no-verify: see above)
        await sourceGit.raw([
          'push',
          '--no-verify',
          tempRemoteName,
          `${options.baseBranch}:${options.baseBranch}`,
        ])
      }
    } finally {
      try {
        await sourceGit.removeRemote(tempRemoteName)
      } catch {
        // ignore cleanup errors
      }
    }
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
   * Guards prod mode against pointing git operations at a NETWORK remote
   * (http(s)://, ssh://, git://, or scp-like `user@host:path`).
   *
   * In the intended prod architecture the CMS Lambda has no internet access:
   * all git network I/O happens on the EC2 worker against the EFS-local bare
   * repo `{workspace}/remote.git`, which the Lambda reaches via auto-detect
   * (see `resolveRemoteUrl`'s auto-detect step, which always yields a local
   * path by construction — never checked here). A network URL supplied via
   * any of the three resolvable sources (explicit param, config, env var) is
   * almost always a misconfiguration: the internet-less Lambda would try to
   * clone/fetch/push it directly and hang until timeout.
   *
   * Dev mode is never restricted here — this only fires for `mode === 'prod'`.
   * `file://` URLs and plain filesystem paths are LOCAL and always allowed.
   *
   * @param source - Human-readable description of where `url` came from, used
   *   only in the thrown error message (e.g. "config.defaultRemoteUrl").
   */
  private static assertRemoteUrlAllowedInMode(
    mode: OperatingMode,
    url: string,
    source: string,
    allowNetworkRemoteInProd: boolean | undefined,
  ): void {
    if (mode !== 'prod') return
    if (allowNetworkRemoteInProd) return
    if (!isNetworkRemoteUrl(url)) return

    throw new Error(
      `CanopyCMS: refusing to use a network remote URL in prod mode (from ${source}: "${url}"). ` +
        `The standard AWS Lambda+EC2-worker topology runs the CMS Lambda with no internet ` +
        `access — the EC2 worker owns all network git I/O, and the Lambda is expected to reach ` +
        `the EFS-local bare repo ({workspace}/remote.git) via auto-detect instead. Pointing a ` +
        `network URL here would make the internet-less Lambda try to clone/fetch/push it ` +
        `directly and hang until timeout. If this prod host genuinely has internet access and ` +
        `intentionally runs git against a network remote (e.g. a single-VM deployment), set ` +
        `config.allowNetworkRemoteInProd: true to acknowledge this.`,
    )
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
   * In prod mode, a resolved network URL from any of the first three sources
   * is rejected unless `options.allowNetworkRemoteInProd` is set — see
   * `assertRemoteUrlAllowedInMode`. Auto-detect/auto-init (source 4) are never
   * checked: they always yield a local filesystem path by construction.
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
    if (options.remoteUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        options.remoteUrl,
        'the explicit remoteUrl parameter',
        options.allowNetworkRemoteInProd,
      )
      return options.remoteUrl
    }
    if (options.defaultRemoteUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        options.defaultRemoteUrl,
        'config.defaultRemoteUrl',
        options.allowNetworkRemoteInProd,
      )
      return options.defaultRemoteUrl
    }
    const envUrl = process.env[config.envVarName]
    if (envUrl) {
      this.assertRemoteUrlAllowedInMode(
        options.mode,
        envUrl,
        `the ${config.envVarName} environment variable`,
        options.allowNetworkRemoteInProd,
      )
      return envUrl
    }

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
    // Resolve the fork point through the shared resolver (dev mode detects the
    // current HEAD when baseBranch is not explicitly set).
    const baseBranch = await resolveBaseBranch({
      defaultBaseBranch: options.baseBranch,
      mode: options.mode,
      detectFrom: options.sourceRoot
        ? path.resolve(process.cwd(), options.sourceRoot)
        : process.cwd(),
    })
    const remoteName = options.remoteName ?? 'origin'

    // 1. Check if git already initialized (with traversal protection)
    let repoExists = false
    try {
      const checkGit = simpleGit({ baseDir: options.workspacePath })
      // Ceiling prevents git from traversing to a parent repo if .git is corrupt
      checkGit.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(options.workspacePath) }))
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
        allowNetworkRemoteInProd: options.allowNetworkRemoteInProd,
      })

      // Require remoteUrl for cloning
      if (!remoteUrl) {
        throw new Error(
          'CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to initialize workspace',
        )
      }

      // Clone repository (automatically configures 'origin' remote)
      try {
        await GitManager.cloneRepo(remoteUrl, options.workspacePath, baseBranch)
      } catch (err) {
        // The raw git error ("Cloning into <workspace>… branch <base> not found")
        // mixes the workspace name and the base branch — spell both out.
        throw new Error(
          `Failed to clone branch workspace at ${options.workspacePath} ` +
            `from ${remoteUrl} (base branch '${baseBranch}'): ${getErrorMessage(err)}`,
        )
      }
      justCloned = true

      // Mark as managed immediately after clone so ensureRemote guard works.
      // Also set a fallback author identity — GIT_CEILING_DIRECTORIES blocks
      // global gitconfig, and internal commits (e.g., orphan branch init) need one.
      // The real bot author is set later via ensureAuthor() before user-facing commits.
      const freshGit = simpleGit({ baseDir: options.workspacePath })
      freshGit.env(gitChildEnv({ GIT_CEILING_DIRECTORIES: path.dirname(options.workspacePath) }))
      await freshGit.addConfig('canopycms.managed', 'true')
      await freshGit.addConfig('user.name', options.gitBotAuthorName)
      await freshGit.addConfig('user.email', options.gitBotAuthorEmail)
    }

    // 3. Create GitManager instance. Settings (orphan) workspaces never host
    // ContentStores, so they skip the on-disk content-index generation marker.
    const git = new GitManager({
      repoPath: options.workspacePath,
      baseBranch,
      remote: remoteName,
      skipIndexMarker: options.branchType === 'orphan',
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
        allowNetworkRemoteInProd: options.allowNetworkRemoteInProd,
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
      // Exclude runtime metadata (.canopy-meta/) from git tracking on content
      // branches. Settings workspaces don't need it: their payloads live at
      // the workspace root (permissions.json/groups.json) and commits there
      // add explicit file paths only, so nothing under .canopy-meta/ is ever
      // staged — and they skip the index marker entirely (skipIndexMarker).
      if (options.gitExcludePattern) {
        await git.ensureGitExclude(options.gitExcludePattern)
      }
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

  /**
   * Mark ContentStore ID indexes AND the resolved-schema cache rooted at (or
   * under) this repo as stale. Called after operations that mutate the
   * working tree (checkout/merge/rebase) so ID→path lookups don't keep
   * resolving to pre-mutation paths, and so a rebase/checkout that pulled in
   * upstream `.collection.json` changes doesn't leave the schema cache
   * pinned to the pre-mutation schema. Invoked in `finally` blocks because
   * even failed merges/rebases may have touched the tree before aborting;
   * over-invalidating is safe.
   *
   * Covers both scopes: in-process stores/caches via their registries, and
   * consumers in OTHER processes sharing the filesystem (worker vs Lambda on
   * EFS) via the on-disk generation markers — unless this manager targets a
   * settings workspace (skipIndexMarker), where only the free in-process
   * content-index invalidation runs and NEITHER marker is bumped (settings
   * workspaces have no schema cache of their own either).
   */
  private async invalidateContentIndexes(): Promise<void> {
    if (this.skipIndexMarker) {
      invalidateContentIndexesForRoot(this.repoPath)
      return
    }
    await invalidateBranchContentCaches(this.repoPath)
  }

  async checkoutBranch(branch: string): Promise<void> {
    try {
      await this.checkoutBranchInner(branch)
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async checkoutBranchInner(branch: string): Promise<void> {
    const branches = await this.git.branch()
    if (branches.all.includes(branch)) {
      // No `--`/`--end-of-options` separator here: a bare `--` switches
      // `git checkout` into pathspec-restore mode instead of switching
      // branches (breaking this call), and `--end-of-options` is not
      // honored by `git checkout` on git versions still in the field
      // (e.g. Apple's bundled git 2.39.5 treats it as a literal, unmatched
      // pathspec rather than an options terminator). Safety instead relies
      // on parseBranchName() rejecting a leading hyphen before `branch`
      // ever reaches here.
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
      // `-b`/`-B` consume the very next token as their literal branch-name
      // value (not subject to option re-scanning), and git independently
      // rejects a leading-hyphen value there ("... is not a valid branch
      // name") — verified on both a modern git and Apple's bundled git
      // 2.39.5. So `branch` needs no separator here either.
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
    try {
      await this.pullBaseInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async pullBaseInner(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    try {
      await this.git.merge([`${this.remote}/${this.baseBranch}`])
    } catch (err) {
      // Capture conflicted files before aborting — abort clears them from status.
      // If status() itself fails (e.g. corrupted .git), still abort and re-throw
      // the original error so the workspace is left as clean as possible.
      try {
        const status = await this.git.status()
        await this.git.merge(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.merge(['--abort']).catch(() => {})
      }
      throw err
    }
  }

  async pullCurrentBranch(): Promise<void> {
    try {
      await this.pullCurrentBranchInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async pullCurrentBranchInner(): Promise<void> {
    const branches = await this.git.branch()
    const currentBranch = branches.current
    await this.git.fetch(this.remote, currentBranch)
    try {
      await this.git.merge([`${this.remote}/${currentBranch}`])
    } catch (err) {
      try {
        const status = await this.git.status()
        await this.git.merge(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.merge(['--abort']).catch(() => {})
      }
      throw err
    }
  }

  async rebaseOntoBase(): Promise<void> {
    try {
      await this.rebaseOntoBaseInner()
    } finally {
      await this.invalidateContentIndexes()
    }
  }

  private async rebaseOntoBaseInner(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    try {
      await this.git.rebase([`${this.remote}/${this.baseBranch}`])
    } catch (err) {
      try {
        const status = await this.git.status()
        await this.git.rebase(['--abort']).catch(() => {})
        if (status.conflicted.length > 0) throw new GitConflictError(status.conflicted)
      } catch (recoveryErr) {
        if (recoveryErr instanceof GitConflictError) throw recoveryErr
        await this.git.rebase(['--abort']).catch(() => {})
      }
      throw err
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
    // Built via raw() (rather than the push() wrapper) so --end-of-options
    // can be placed immediately before the positional remote/refspec
    // arguments, guarding against a refspec starting with '-' being parsed
    // as a git option (e.g. --receive-pack=...). Real flags must precede
    // --end-of-options, since everything after it is treated as positional.
    await this.git.raw([
      'push',
      '--set-upstream',
      '--end-of-options',
      this.remote,
      `${target}:${target}`,
    ])
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
    // See push() above for why raw() + --end-of-options is used here.
    await this.git.raw(['push', '--force-with-lease', '--end-of-options', this.remote, target])
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
    await ensureGitExcludePattern(this.repoPath, pattern)
  }

  /**
   * Create an orphan branch for settings (permissions/groups).
   *
   * Orphan branches have no shared history with other branches - they start fresh.
   * This is perfect for deployment-specific settings that shouldn't pollute content history.
   *
   * The branch contains only settings files committed by explicit path
   * (e.g. permissions.json, groups.json at the workspace root).
   *
   * @param branchName - Name of the orphan branch (e.g., 'canopycms-settings-prod')
   * @param initialFiles - Files to commit to the new branch (e.g., { 'permissions.json': '{}', 'groups.json': '{}' })
   */
  async createOrphanSettingsBranch(
    branchName: string,
    initialFiles: Record<string, string>,
  ): Promise<void> {
    try {
      await this.createOrphanSettingsBranchInner(branchName, initialFiles)
    } finally {
      // Both branches of Inner swap the working tree (checkout / checkout --orphan)
      await this.invalidateContentIndexes()
    }
  }

  private async createOrphanSettingsBranchInner(
    branchName: string,
    initialFiles: Record<string, string>,
  ): Promise<void> {
    log.debug('git', 'Creating orphan settings branch', { branchName })

    // Check if branch already exists
    const branches = await this.git.branch()
    if (branches.all.includes(branchName)) {
      log.debug('git', 'Orphan branch already exists', { branchName })
      // No separator here — see checkoutBranch() above for why plain
      // `git checkout <branch>` can't safely take one. branchName is always
      // an internal/config-derived settings-branch name, never user input
      // (see createOrphanSettingsBranch's callers).
      await this.git.checkout(branchName)
      return
    }

    // Create orphan branch (--orphan creates a branch with no parent/history).
    // branchName is consumed as --orphan's literal argument value (like -b/-B
    // above), so it can't be reinterpreted as a flag; git's own ref-name
    // validation additionally rejects a leading-hyphen value here.
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
