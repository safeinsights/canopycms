/**
 * `CanopyServices` — the long-lived, per-deployment service container, built
 * once by `createCanopyServices` and threaded through `ApiContext.services` to
 * every API handler. Holds config, the schema registry and cache, the ACL
 * checkers, the git-manager factory, the branch registry, the GitHub service,
 * and four branch-workflow operations. Not `context.ts`, which is the
 * per-REQUEST facade built on top of this.
 *
 * SCOPE WARNING: a service locator every api module reaches, so adding a field
 * is free and therefore constant, and no handler's signature reveals what it
 * touches. Give a new capability its own narrow interface instead.
 *
 * `createTestCanopyServices` is test-only despite living in a production
 * module; it reaches the published surface through a wildcard re-export.
 *
 * Module map: ./AGENTS.md.
 */
import type { CanopyConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import { getConfigDefaults } from './config'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import {
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
import { enqueueTask } from './task-queue/cms-task-queue'
import { getTaskQueueDir } from './task-queue/task-queue-config'
import { detectHeadBranch } from './utils/git'
import { readsFromCheckout } from './build-mode'

/**
 * A per-instance active-branch detector with its own 5s TTL cache, in priority
 * order: an explicitly configured value; `defaultBaseBranch ?? 'main'` with no
 * git for static deployments and builds; git HEAD in dev; and
 * `defaultBaseBranch ?? 'main'` in prod.
 */
function createActiveBranchDetector() {
  let cache: { value: string; expiresAt: number } | null = null

  return async (config: CanopyConfig): Promise<string> => {
    if (config.defaultActiveBranch) return config.defaultActiveBranch
    // Static deployments and builds read content from the checkout — never shell out to git
    if (readsFromCheckout(config)) return config.defaultBaseBranch ?? 'main'
    if (config.mode === 'dev') {
      const now = Date.now()
      if (cache && now < cache.expiresAt) {
        return cache.value
      }
      // Detect from cwd, never sourceRoot: git walks up to find .git, and
      // sourceRoot locates content, not the repo root. On a detached HEAD or
      // outside a repo, detectHeadBranch falls back instead of throwing.
      const branch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
      cache = { value: branch, expiresAt: now + 5000 }
      return branch
    }
    return config.defaultBaseBranch ?? 'main'
  }
}

/**
 * Bootstrap admin IDs from the environment. These users are treated as Admins
 * whatever their group membership.
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
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  /**
   * A batch content-access checker: loads permissions once, returns a
   * synchronous per-path check. Use it whenever one request checks many paths,
   * so permissions are not re-loaded per path.
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

export interface CreateCanopyServicesOptions {
  /** Entry schema names → field definitions, for resolving .collection.json references. */
  entrySchemaRegistry?: EntrySchemaRegistry
  /**
   * Test-only: bypasses the default BranchSchemaCache creation.
   * @internal
   */
  branchSchemaCache?: BranchSchemaCache
  /**
   * Test-only: bypasses the real git workspace setup for settings.
   * @internal
   */
  getSettingsBranchRoot?: () => Promise<string>
}

/**
 * Build the reusable helpers from a validated CanopyConfig — once at startup,
 * then injected into request handlers and loaders. Schema is not loaded here;
 * BranchSchemaCache loads it per branch.
 */
export const createCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  return _createCanopyServicesInternal(config, options)
}

/** {@link createCanopyServices} for tests, with branch identity pinned. */
export const createTestCanopyServices = async (
  config: CanopyConfig,
  options: CreateCanopyServicesOptions = {},
): Promise<CanopyServices> => {
  // Pin both branch identity fields rather than auto-detect from git HEAD,
  // which varies with the developer's working branch.
  const testConfig = {
    ...config,
    defaultBaseBranch: config.defaultBaseBranch ?? 'main',
    defaultActiveBranch: config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main',
  }
  return _createCanopyServicesInternal(testConfig, options)
}

/** Shared implementation; call createCanopyServices or createTestCanopyServices. */
async function _createCanopyServicesInternal(
  config: CanopyConfig,
  options: CreateCanopyServicesOptions,
): Promise<CanopyServices> {
  // Mode-specific requirements, e.g. prod's git bot credentials for GitHub.
  const strategy = operatingStrategy(config.mode)
  strategy.validateConfig(config)

  // Resolve branch identity once and bake both into config, so downstream code
  // reads one consistent value (see ARCHITECTURE.md "Branch Identity"): the
  // active branch is the workspace to serve from, the base branch the fork
  // point for new editing branches.
  const detectActiveBranch = createActiveBranchDetector()
  const explicitActiveBranch = config.defaultActiveBranch
  const explicitBaseBranch = config.defaultBaseBranch
  const defaultActiveBranch = await detectActiveBranch(config)
  // Unset, the base branch follows the same dev-mode HEAD detection, matching
  // resolveBaseBranch in utils/git.ts — the canonical definition workspace
  // provisioning uses.
  const defaultBaseBranch =
    explicitBaseBranch ??
    (config.mode === 'dev' && !readsFromCheckout(config)
      ? await detectActiveBranch({ ...config, defaultActiveBranch: undefined })
      : 'main')
  config = { ...config, defaultActiveBranch, defaultBaseBranch }

  const bootstrapAdminIds = getBootstrapAdminIds()

  const branchSchemaCache = options.branchSchemaCache ?? new BranchSchemaCache(config.mode)

  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny', config)
  // Content access loads permissions dynamically from the settings branch (orphan git branch)
  const getSettingsBranchRoot =
    options.getSettingsBranchRoot ??
    (async (): Promise<string> => {
      const strategy = operatingStrategy(config.mode)

      const settingsRoot = strategy.getSettingsRoot()
      const branchName = strategy.getSettingsBranchName(config)

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
    // Commit and push answer two DIFFERENT questions. Committing cleans the
    // working tree, so one combined "tree is dirty" gate makes a retry after a
    // failed push a silent no-op: nothing left to commit, the block is skipped,
    // and success is reported though the commit never reached the remote. Push
    // whenever there is something new to send — we just committed, or the local
    // branch already had unpushed commits from an earlier attempt.
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

    if (!operatingStrategy(mode).shouldCommit()) {
      return { committed: false, pushed: false }
    }

    const settingsBranch = operatingStrategy(config.mode).getSettingsBranchName(config)
    // Settings workspace: no ContentStore roots here, skip the index marker
    const git = createGitManagerFor(options.branchRoot, { skipIndexMarker: true })

    try {
      // Pull the remote SETTINGS branch, never the base branch: settings
      // branches are orphans and must never merge from main.
      // BranchWorkspaceManager has already put us on the settings branch.
      try {
        await git.pullCurrentBranch()
      } catch (err) {
        // Only ONE outcome here is benign: the settings branch has never been
        // pushed, so the remote has no ref to pull. Anything else — a
        // GitConflictError, a merge that cannot proceed, a broken workspace —
        // must surface (the outer catch turns it into an error result).
        if (!(err instanceof GitRemoteRefMissingError)) throw err
        console.info(
          'CanopyCMS: settings branch has no remote ref yet, nothing to pull ' +
            '(normal for the first settings commit)',
        )
      }

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
        // Permissions and groups are read live from the settings workspace
        // (getSettingsBranchRoot), never from this PR's base branch, so the
        // change took effect when it was committed and pushed above, before
        // this PR existed. Merging re-activates nothing; it only records the
        // change on `base` for review and audit history.
        const settingsPRBody =
          'Automated PR for permission and group changes. These changes already took ' +
          'effect in the CMS when they were saved — merging this PR does not change ' +
          "what's live; it only records the change here for review and audit history."
        // Direct path: githubService available (has internet)
        if (githubService) {
          let prUrl: string | undefined
          try {
            // Settings-branch PRs never pass markReadyIfDraft: a settings sync
            // has no explicit "submit for review" step the way a content submit
            // does, so an existing draft PR stays draft until an admin says so.
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

  const registry = modeStrategy.supportsBranching()
    ? new BranchRegistry(getDefaultBranchBase(operatingMode))
    : undefined

  const services: CanopyServices = {
    config,
    entrySchemaRegistry: options.entrySchemaRegistry ?? {},
    branchSchemaCache,
    checkBranchAccess,
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
      // Static deployments and builds serve from the checkout — no git HEAD to track
      if (readsFromCheckout(services.config)) return
      // An explicitly configured value is never overridden by HEAD detection;
      // only what the adopter left unset is re-detected.
      if (explicitActiveBranch && explicitBaseBranch) return
      // The switch is silent, so the dev site tracks the current branch the way
      // code hot-reloads; the editor is pinned to its own branch via URL params,
      // so only non-editor content serving is affected. The base branch follows
      // HEAD too when unset, so a workspace provisioned mid-session forks from
      // the developer's current branch.
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
        // The closures above (getSettingsBranchRoot, checkContentAccess,
        // createGitManagerFor, …) captured the original `config` local. Only
        // branch identity changes here: git operations on existing branches use
        // the fork point in branch metadata, and anything needing the fresh
        // values must read services.config.
        services.config = next
      }
    },
  }

  return services
}
