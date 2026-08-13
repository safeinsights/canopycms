import type { CanopyConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import { getConfigDefaults } from './config'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import {
  createCheckPathAccess,
  createCheckBranchAccess,
  createCheckContentAccess,
  createContentAccessChecker,
  loadPathPermissions,
  type ContentAccessChecker,
} from './authorization'
import { GitManager, GitRemoteRefMissingError } from './git-manager'
import { BranchRegistry } from './branch-registry'
import { SettingsWorkspaceManager } from './settings-workspace'
import { getDefaultBranchBase, sanitizeBranchName } from './paths'
import { createGitHubService, type GitHubService } from './github-service'
import { operatingStrategy } from './operating-mode'
import { BranchSchemaCache } from './branch-schema-cache'
import { enqueueTask } from './worker/task-queue'
import { getTaskQueueDir } from './worker/task-queue-config'
import { detectHeadBranch } from './utils/git'
import { isDeployedStatic } from './build-mode'

/**
 * Create a per-instance active branch detector with its own 5-second TTL cache.
 *
 * Detection priority:
 * - If explicitly configured, use that value (both modes).
 * - In dev mode, auto-detect from the current git HEAD branch.
 * - In prod mode, fall back to defaultBaseBranch ?? 'main'.
 */
function createActiveBranchDetector() {
  let cache: { value: string; expiresAt: number } | null = null

  return async (config: CanopyConfig): Promise<string> => {
    if (config.defaultActiveBranch) return config.defaultActiveBranch
    // Static deployments read content from the checkout — never shell out to git
    if (isDeployedStatic(config)) return config.defaultBaseBranch ?? 'main'
    if (config.mode === 'dev') {
      const now = Date.now()
      if (cache && now < cache.expiresAt) {
        return cache.value
      }
      // Always use cwd for branch detection — git walks up to find .git.
      // sourceRoot is about content location, not the repo root.
      // On detached HEAD or no git repo, detectHeadBranch returns the
      // base-branch fallback instead of throwing.
      const branch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
      cache = { value: branch, expiresAt: now + 5000 }
      return branch
    }
    return config.defaultBaseBranch ?? 'main'
  }
}

/**
 * Parse bootstrap admin IDs from environment variable.
 * These users are always treated as Admins regardless of group membership.
 */
export const getBootstrapAdminIds = (): Set<string> => {
  const envVar = process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
  if (!envVar) return new Set()
  return new Set(
    envVar
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
}

export interface CanopyServices {
  config: CanopyConfig
  /**
   * Re-detect the active branch from git HEAD (dev mode only, cached 5s).
   * Silently updates config if the branch changed — only affects non-editor
   * content serving since the editor is pinned to its own branch via URL params.
   */
  refreshActiveBranch: () => Promise<void>
  /** Entry schema registry mapping entry schema names to field definitions */
  entrySchemaRegistry: EntrySchemaRegistry
  /** Per-branch schema cache */
  branchSchemaCache: import('./branch-schema-cache').BranchSchemaCache
  checkBranchAccess: (
    context: BranchContext,
    user: CanopyUser,
  ) => ReturnType<ReturnType<typeof createCheckBranchAccess>>
  checkPathAccess: ReturnType<typeof createCheckPathAccess>
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  /**
   * Build a batch content-access checker that loads permissions once and returns
   * a synchronous per-path checker. Use this when checking many paths in a single
   * request (e.g. listing entries) to avoid re-loading permissions per path.
   */
  createContentAccessChecker: (
    context: BranchContext,
    branchRoot: string,
    user: CanopyUser,
  ) => Promise<ContentAccessChecker>
  createGitManagerFor: (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string; skipIndexMarker?: boolean },
  ) => GitManager
  registry?: BranchRegistry
  githubService?: GitHubService
  /** Bootstrap admin user IDs that are always treated as Admins */
  bootstrapAdminIds: Set<string>
  /** Commit files to git with automatic author handling */
  commitFiles: (options: {
    context: BranchContext
    files: string | string[]
    message: string
  }) => Promise<void>
  /** Submit branch: commit all changes and push to remote */
  submitBranch: (options: { context: BranchContext; message?: string }) => Promise<void>
  /** Commit to settings branch (for permissions/groups), with optional PR creation */
  commitToSettingsBranch: (options: {
    branchRoot: string
    files: string | string[]
    message: string
    createPR?: boolean
  }) => Promise<{
    committed: boolean
    pushed: boolean
    prUrl?: string
    error?: string
    syncStatus?: 'pending-sync' | 'synced' | 'sync-failed'
  }>
  /** Get the root path for settings storage (ensures workspace exists) */
  getSettingsBranchRoot: () => Promise<string>
}

/**
 * Options for createCanopyServices and createTestCanopyServices.
 */
export interface CreateCanopyServicesOptions {
  /**
   * Entry schema registry for resolving .collection.json references.
   * Maps entry schema names to field definitions.
   */
  entrySchemaRegistry?: EntrySchemaRegistry
  /**
   * Test-only: Custom branch schema cache.
   * When provided, bypasses the default BranchSchemaCache creation.
   * @internal
   */
  branchSchemaCache?: BranchSchemaCache
  /**
   * Test-only: Override for getSettingsBranchRoot.
   * When provided, bypasses the real git workspace setup for settings.
   * @internal
   */
  getSettingsBranchRoot?: () => Promise<string>
}

/**
 * Create reusable helpers from a validated CanopyConfig.
 * Intended to be called once at startup and injected where needed
 * (e.g., request handlers, loaders).
 *
 * Schema is now loaded per-branch via BranchSchemaCache, not at startup.
 *
 * @param config - Validated Canopy configuration
 * @param options - Optional settings including entry schema registry
 */
export const createCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  return _createCanopyServicesInternal(config, options)
}

/**
 * Create services for testing.
 * Schema is loaded per-branch via BranchSchemaCache.
 *
 * @param config - Validated Canopy configuration
 * @param options - Optional settings including entry schema registry
 */
export const createTestCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  // In tests, pin both branch identity fields to avoid auto-detecting from
  // git HEAD (which varies depending on the developer's working branch).
  const testConfig = {
    ...config,
    defaultBaseBranch: config.defaultBaseBranch ?? 'main',
    defaultActiveBranch: config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main',
  }
  return _createCanopyServicesInternal(testConfig, options)
}

/**
 * Internal implementation shared by both production and test functions.
 * Not exported - use createCanopyServices() or createTestCanopyServices().
 */
async function _createCanopyServicesInternal(
  config: CanopyConfig,
  options: CreateCanopyServicesOptions,
): Promise<CanopyServices> {
  // Validate mode-specific requirements (e.g., prod requires git bot credentials for GitHub)
  const strategy = operatingStrategy(config.mode)
  strategy.validateConfig(config)

  // Resolve branch identity once (see ARCHITECTURE.md "Branch Identity"):
  // - active branch: which workspace to serve from (dev: git HEAD, prod: base)
  // - base branch: fork point for new editing branches (dev: git HEAD when
  //   unset, otherwise the configured value; prod: configured value or 'main')
  // Bake both into config so all downstream code reads one consistent value.
  // The detector has its own per-instance 5s TTL cache for git HEAD checks.
  const detectActiveBranch = createActiveBranchDetector()
  const explicitActiveBranch = config.defaultActiveBranch
  const explicitBaseBranch = config.defaultBaseBranch
  const defaultActiveBranch = await detectActiveBranch(config)
  // When unset, the base branch follows the same dev-mode HEAD detection
  // (matching resolveBaseBranch in utils/git.ts, the canonical definition used
  // by workspace provisioning). Reuses the detector's 5s TTL cache.
  const defaultBaseBranch =
    explicitBaseBranch ??
    (config.mode === 'dev' && !isDeployedStatic(config)
      ? await detectActiveBranch({ ...config, defaultActiveBranch: undefined })
      : 'main')
  config = { ...config, defaultActiveBranch, defaultBaseBranch }

  // Load bootstrap admin IDs from environment
  const bootstrapAdminIds = getBootstrapAdminIds()

  // Create per-branch schema cache (or use provided one for testing)
  const branchSchemaCache = options.branchSchemaCache ?? new BranchSchemaCache(config.mode)

  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny')
  // Path permissions are loaded dynamically from the settings branch at request time.
  // At the service level, we bind with empty rules for direct path checks.
  const checkPathAccess = createCheckPathAccess([], config.defaultPathAccess ?? 'deny')
  // Content access loads permissions dynamically from the settings branch (orphan git branch)
  const getSettingsBranchRoot =
    options.getSettingsBranchRoot ??
    (async (): Promise<string> => {
      const strategy = operatingStrategy(config.mode)

      const settingsRoot = strategy.getSettingsRoot()
      const branchName = strategy.getSettingsBranchName(config)

      // Use SettingsWorkspaceManager to ensure git workspace for settings
      // This is Lambda-safe because the lock is in-memory per process
      const manager = new SettingsWorkspaceManager(config)
      await manager.ensureGitWorkspace({
        settingsRoot,
        branchName,
        mode: config.mode,
        remoteUrl: config.defaultRemoteUrl,
      })

      return settingsRoot
    })

  const contentAccessDeps = {
    checkBranchAccess,
    loadPathPermissions,
    defaultPathAccess: config.defaultPathAccess ?? 'deny',
    mode: config.mode,
    getSettingsBranchRoot,
  }
  const checkContentAccess = createCheckContentAccess(contentAccessDeps)
  const createContentAccessCheckerBound = (
    context: BranchContext,
    branchRoot: string,
    user: CanopyUser,
  ): Promise<ContentAccessChecker> =>
    createContentAccessChecker(contentAccessDeps, context, branchRoot, user)
  const configDefaults = getConfigDefaults()
  const createGitManagerFor = (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string; skipIndexMarker?: boolean },
  ) =>
    new GitManager({
      repoPath,
      baseBranch: opts?.baseBranch ?? config.defaultBaseBranch ?? 'main',
      remote: opts?.remote ?? config.defaultRemoteName ?? configDefaults.remoteName,
      skipIndexMarker: opts?.skipIndexMarker,
    })

  const commitFiles = async (options: {
    context: BranchContext
    files: string | string[]
    message: string
  }): Promise<void> => {
    // Prefer the fork point recorded at branch creation over the (possibly
    // re-detected) config value, so operations stay pinned to the branch's base.
    const git = createGitManagerFor(options.context.branchRoot, {
      baseBranch: options.context.branch.baseBranch,
    })
    await git.ensureAuthor({
      name: config.gitBotAuthorName,
      email: config.gitBotAuthorEmail,
    })
    await git.add(options.files)
    await git.commit(options.message)
  }

  const submitBranch = async (options: {
    context: BranchContext
    message?: string
  }): Promise<void> => {
    // Defense-in-depth: refuse to push the base branch to itself even if the
    // 'submittableBranch' guard was somehow bypassed. Prefer the recorded fork
    // point (context.branch.baseBranch) over config.defaultBaseBranch — the
    // closure-captured `config` can go stale after dev refreshActiveBranch().
    const effectiveBase = options.context.branch.baseBranch ?? config.defaultBaseBranch ?? 'main'
    if (sanitizeBranchName(options.context.branch.name) === sanitizeBranchName(effectiveBase)) {
      throw new Error(
        `Refusing to commit and push the base branch "${options.context.branch.name}" — submitting requires a separate editing branch`,
      )
    }

    const git = createGitManagerFor(options.context.branchRoot, {
      baseBranch: options.context.branch.baseBranch,
    })
    await git.ensureAuthor({
      name: config.gitBotAuthorName,
      email: config.gitBotAuthorEmail,
    })
    await git.checkoutBranch(options.context.branch.name)
    const status = await git.status()
    // Commit and push are gated on two DIFFERENT questions. Committing
    // cleans the working tree, so gating the push on "tree is dirty" (as a
    // single combined check) makes a retry after a failed push a silent
    // no-op: the earlier commit already cleaned the tree, so the retry sees
    // nothing to commit, skips the whole block, and reports success even
    // though the commit never reached the remote. Push instead whenever
    // there's something new to send -- we just committed, or the local
    // branch already had unpushed commits from an earlier failed attempt.
    let committed = false
    if (status.files.length > 0) {
      await git.add('.')
      await git.commit(options.message ?? `Submit ${options.context.branch.name}`)
      committed = true
    }
    if (committed || (await git.hasUnpushedCommits(options.context.branch.name))) {
      await git.push(options.context.branch.name)
    }
  }

  // Create GitHub service if applicable (only for modes that support pull requests)
  // Must be initialized before closures that reference it (commitToSettingsBranch)
  let githubService: GitHubService | undefined
  if (operatingStrategy(config.mode).supportsPullRequests()) {
    const remoteUrl = config.defaultRemoteUrl
    if (remoteUrl) {
      try {
        const service = createGitHubService(config, remoteUrl)
        if (service) {
          githubService = service
        }
      } catch (err) {
        console.warn('CanopyCMS: Failed to initialize GitHub service:', err)
        // Continue without GitHub integration
      }
    }
  }

  const commitToSettingsBranch = async (options: {
    branchRoot: string
    files: string | string[]
    message: string
    createPR?: boolean
  }): Promise<{
    committed: boolean
    pushed: boolean
    prUrl?: string
    error?: string
    syncStatus?: 'pending-sync' | 'synced' | 'sync-failed'
  }> => {
    const mode = config.mode

    // Check if this mode supports git operations
    if (!operatingStrategy(mode).shouldCommit()) {
      return { committed: false, pushed: false }
    }

    const settingsBranch = operatingStrategy(config.mode).getSettingsBranchName(config)
    // Settings workspace: no ContentStore roots here, skip the index marker
    const git = createGitManagerFor(options.branchRoot, { skipIndexMarker: true })

    try {
      // Pull latest changes from remote settings branch (not base branch!)
      // Settings branches are orphan branches and should never merge from main
      // Note: BranchWorkspaceManager already ensured we're on the settings branch
      try {
        await git.pullCurrentBranch()
      } catch (err) {
        // Only ONE outcome here is benign: the settings branch has never been
        // pushed, so the remote has no ref to pull. Anything else — a
        // GitConflictError, a merge that cannot proceed, a broken workspace —
        // must surface (the outer catch turns it into an error result).
        // A blanket catch here previously logged every failure as "normal for
        // first commit", which is how pullCurrentBranch could stay broken on
        // every call without anyone noticing: the settings branch then silently
        // never converged with the remote, and each save reported
        // `committed: true, pushed: false` from the push below, forever.
        if (!(err instanceof GitRemoteRefMissingError)) throw err
        console.info(
          'CanopyCMS: settings branch has no remote ref yet, nothing to pull ' +
            '(normal for the first settings commit)',
        )
      }

      // Commit
      await git.ensureAuthor({
        name: config.gitBotAuthorName,
        email: config.gitBotAuthorEmail,
      })
      await git.add(options.files)
      await git.commit(options.message)

      // Push to local remote (remote.git on EFS in prod, origin in other modes)
      try {
        await git.push()
      } catch (error) {
        return {
          committed: true,
          pushed: false,
          error: error instanceof Error ? error.message : 'Push failed',
        }
      }

      // Create or update PR — dual-path like content branches (api/github-sync.ts)
      if (options.createPR !== false) {
        // Both permissions and groups are read live from the settings
        // workspace (getSettingsBranchRoot) — never from this PR's base
        // branch — so the change already took effect the moment it was
        // committed and pushed above, before this PR even exists. Merging
        // does not (re-)activate anything; it only records the change on
        // `base` for review/audit history. Previously worded as "will be
        // persisted when this PR is merged", which implied merging was what
        // made the change durable/live — false for both settings files, and
        // for groups specifically the read side didn't even look at this
        // branch until that bug was fixed (see resolve-canopy-user.ts).
        const settingsPRBody =
          'Automated PR for permission and group changes. These changes already took ' +
          'effect in the CMS when they were saved — merging this PR does not change ' +
          "what's live; it only records the change here for review and audit history."
        // Direct path: githubService available (has internet)
        if (githubService) {
          let prUrl: string | undefined
          try {
            // Settings-branch PRs deliberately never pass markReadyIfDraft:
            // unlike content submits, a settings sync has no explicit "submit
            // for review" step, so an existing draft PR here should stay
            // draft until an admin is ready — don't "helpfully" enable this.
            const result = await githubService.createOrUpdatePR({
              head: settingsBranch,
              base: config.defaultBaseBranch ?? 'main',
              title: 'Update permissions and groups',
              body: settingsPRBody,
            })
            prUrl = result.url
          } catch (err) {
            console.warn('Failed to create/update PR:', err)
            return { committed: true, pushed: true, syncStatus: 'sync-failed' }
          }
          return { committed: true, pushed: true, prUrl, syncStatus: 'synced' }
        }

        // Async path: queue task for worker (prod Lambda has no internet)
        const taskDir = getTaskQueueDir(config)
        try {
          await enqueueTask(taskDir, {
            action: 'push-and-create-or-update-pr',
            payload: {
              branch: settingsBranch,
              baseBranch: config.defaultBaseBranch ?? 'main',
              title: 'Update permissions and groups',
              body: settingsPRBody,
            },
          })
          return { committed: true, pushed: true, syncStatus: 'pending-sync' }
        } catch (err) {
          console.warn('Failed to enqueue settings PR task:', err)
          return { committed: true, pushed: true, syncStatus: 'sync-failed' }
        }
      }

      return { committed: true, pushed: true }
    } catch (error) {
      return {
        committed: false,
        pushed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  const operatingMode = config.mode
  const modeStrategy = operatingStrategy(operatingMode)

  // Create branch registry only in branching modes
  // Settings are now in separate directory, no filtering needed
  const registry = modeStrategy.supportsBranching()
    ? new BranchRegistry(getDefaultBranchBase(operatingMode))
    : undefined

  const services: CanopyServices = {
    config,
    entrySchemaRegistry: options.entrySchemaRegistry ?? {},
    branchSchemaCache,
    checkBranchAccess,
    checkPathAccess,
    checkContentAccess,
    createContentAccessChecker: createContentAccessCheckerBound,
    createGitManagerFor,
    registry,
    githubService,
    bootstrapAdminIds,
    commitFiles,
    submitBranch,
    commitToSettingsBranch,
    getSettingsBranchRoot,
    refreshActiveBranch: async () => {
      if (services.config.mode !== 'dev') return
      // Static deployments serve from the checkout — no git HEAD to track
      if (isDeployedStatic(services.config)) return
      // Explicitly configured values are respected — never overridden by
      // git HEAD detection. Only re-detect what the adopter left unset.
      if (explicitActiveBranch && explicitBaseBranch) return
      // Re-detect from git HEAD (5s TTL cache prevents excessive shell-outs).
      // Silently switch — the public dev site should reflect the current branch
      // just like code hot-reloads. The editor is pinned to its own branch via
      // URL params, so this only affects non-editor content serving. The base
      // branch (fork point) follows HEAD too when unset, so workspaces
      // provisioned mid-session fork from the developer's current branch.
      const fresh = await detectActiveBranch({
        ...services.config,
        defaultActiveBranch: undefined,
      })
      const next = { ...services.config }
      let changed = false
      if (!explicitActiveBranch && fresh !== next.defaultActiveBranch) {
        next.defaultActiveBranch = fresh
        changed = true
      }
      if (!explicitBaseBranch && fresh !== next.defaultBaseBranch) {
        next.defaultBaseBranch = fresh
        changed = true
      }
      if (changed) {
        // Note: closures in this function (getSettingsBranchRoot, checkContentAccess,
        // createGitManagerFor, etc.) capture the original `config` local variable.
        // Only the branch identity fields change here — git operations on existing
        // branches use the fork point recorded in branch metadata, and consumers
        // that need the fresh values must read services.config.
        services.config = next
      }
    },
  }

  return services
}
