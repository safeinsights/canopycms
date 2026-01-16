import type { CanopyConfig, FlatSchemaItem, FieldConfig, RootCollectionConfig } from './config'
import { flattenSchema } from './config'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import { createCheckPathAccess } from './path-permissions'
import { createCheckBranchAccess } from './authz'
import { createCheckContentAccess } from './content-access'
import { loadPathPermissions } from './permissions-loader'
import { GitManager } from './git-manager'
import { BranchRegistry } from './branch-registry'
import { BranchWorkspaceManager } from './branch-workspace'
import { SettingsWorkspaceManager } from './settings-workspace'
import { getDefaultBranchBase } from './paths'
import { createGitHubService, type GitHubService } from './github-service'
import { operatingStrategy } from './operating-mode'
import { loadCollectionMetaFiles, resolveCollectionReferences } from './schema-meta-loader'

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
  /** Cached flattened schema for O(1) lookups */
  flatSchema: FlatSchemaItem[]
  /** Schema registry for access by admin UI */
  schemaRegistry: Record<string, readonly FieldConfig[]>
  checkBranchAccess: (
    context: BranchContext,
    user: CanopyUser,
  ) => ReturnType<ReturnType<typeof createCheckBranchAccess>>
  checkPathAccess: ReturnType<typeof createCheckPathAccess>
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  createGitManagerFor: (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string },
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
  }>
  /** Get the root path for settings storage (ensures workspace exists) */
  getSettingsBranchRoot: () => Promise<string>
}

/**
 * Create reusable helpers from a validated CanopyConfig.
 * Intended to be called once at startup and injected where needed
 * (e.g., request handlers, loaders).
 *
 * @param config - Validated Canopy configuration
 * @param schemaRegistry - Optional schema registry for resolving .collection.json references.
 *                         If not provided, only config-defined schemas will be used.
 */
export const createCanopyServices = async (
  config: CanopyConfig,
  schemaRegistry: Record<string, readonly FieldConfig[]> = {},
): Promise<CanopyServices> => {
  // Validate mode-specific requirements (e.g., prod requires git bot credentials for GitHub)
  const strategy = operatingStrategy(config.mode)
  strategy.validateConfig(config)

  // Load bootstrap admin IDs from environment
  const bootstrapAdminIds = getBootstrapAdminIds()

  // Load .collection.json meta files (including root content/.collection.json if it exists)
  const metaFiles = await loadCollectionMetaFiles(config.contentRoot)

  // Resolve schema references to get RootCollectionConfig
  const schemaFromMeta = resolveCollectionReferences(metaFiles, schemaRegistry)

  // Merge with config schema (config can still define collections/singletons too)
  const schema: RootCollectionConfig = {
    entries: schemaFromMeta.entries || config.schema?.entries,
    collections: [...(schemaFromMeta.collections || []), ...(config.schema?.collections || [])],
    singletons: [...(schemaFromMeta.singletons || []), ...(config.schema?.singletons || [])],
  }

  // Validate that we have at least one schema source
  if (
    !schema.entries &&
    (!schema.collections || schema.collections.length === 0) &&
    (!schema.singletons || schema.singletons.length === 0)
  ) {
    throw new Error(
      'Schema must have at least one of: entries, collections, or singletons. ' +
        'Either define them in canopycms.config.ts or create .collection.json meta files in your content directory.',
    )
  }

  // Flatten schema once for O(1) lookups throughout the app
  const flatSchema = flattenSchema(schema, config.contentRoot)

  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny')
  // Path permissions are loaded dynamically from settings branch or .canopy-dev/permissions.json at request time.
  // At the service level, we bind with empty rules for direct path checks.
  const checkPathAccess = createCheckPathAccess([], config.defaultPathAccess ?? 'deny')
  // Content access loads permissions dynamically from settings root
  // In prod/prod-sim modes, permissions are loaded from settings branch (orphan git branch)
  // In dev mode, permissions are in .canopy-dev/settings/
  const getSettingsBranchRoot = async (): Promise<string> => {
    const strategy = operatingStrategy(config.mode)

    // Only applicable in modes that use separate settings branch
    if (!strategy.usesSeparateSettingsBranch()) {
      throw new Error(
        'getSettingsBranchRoot called in mode that does not use separate settings branch',
      )
    }

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
  }

  const checkContentAccess = createCheckContentAccess({
    checkBranchAccess,
    loadPathPermissions,
    defaultPathAccess: config.defaultPathAccess ?? 'deny',
    mode: config.mode,
    getSettingsBranchRoot,
  })
  const createGitManagerFor = (repoPath: string, opts?: { baseBranch?: string; remote?: string }) =>
    new GitManager({
      repoPath,
      // TODO DRY up default values (probably already in the schema definition)
      baseBranch: opts?.baseBranch ?? config.defaultBaseBranch ?? 'main',
      remote: opts?.remote ?? config.defaultRemoteName ?? 'origin',
    })

  const commitFiles = async (options: {
    context: BranchContext
    files: string | string[]
    message: string
  }): Promise<void> => {
    const git = createGitManagerFor(options.context.branchRoot)
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
    const git = createGitManagerFor(options.context.branchRoot)
    await git.ensureAuthor({
      name: config.gitBotAuthorName,
      email: config.gitBotAuthorEmail,
    })
    await git.checkoutBranch(options.context.branch.name)
    const status = await git.status()
    if (status.files.length > 0) {
      await git.add('.')
      await git.commit(options.message ?? `Submit ${options.context.branch.name}`)
      await git.push(options.context.branch.name)
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
  }> => {
    const mode = config.mode

    // Check if this mode supports git operations
    if (!operatingStrategy(mode).shouldCommit()) {
      return { committed: false, pushed: false }
    }

    const settingsBranch = config.settingsBranch ?? 'canopycms-settings'
    const git = createGitManagerFor(options.branchRoot)

    try {
      // Pull latest changes from remote settings branch (not base branch!)
      // Settings branches are orphan branches and should never merge from main
      // Note: BranchWorkspaceManager already ensured we're on the settings branch
      try {
        await git.pullCurrentBranch()
      } catch (err) {
        // First push, no remote branch yet, or no changes to pull
        console.log('No remote settings branch changes to pull (this is normal for first commit)')
      }

      // Commit
      await git.ensureAuthor({
        name: config.gitBotAuthorName,
        email: config.gitBotAuthorEmail,
      })
      await git.add(options.files)
      await git.commit(options.message)

      // Push to settings branch
      let pushed = false
      try {
        await git.push(settingsBranch)
        pushed = true
      } catch (error) {
        return {
          committed: true,
          pushed: false,
          error: error instanceof Error ? error.message : 'Push failed',
        }
      }

      // Create or update PR
      let prUrl: string | undefined
      if (options.createPR !== false && githubService) {
        try {
          prUrl = await githubService.createOrUpdatePR({
            head: settingsBranch,
            base: config.defaultBaseBranch ?? 'main',
            title: 'Update permissions and groups',
            body: 'Automated PR for permission and group changes. Changes are already active in the CMS and will be persisted when this PR is merged.',
          })
        } catch (err) {
          console.warn('Failed to create/update PR:', err)
        }
      }

      return { committed: true, pushed: true, prUrl }
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

  // Create GitHub service if applicable (only for modes that support pull requests)
  let githubService: GitHubService | undefined
  const mode = config.mode
  if (operatingStrategy(mode).supportsPullRequests()) {
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

  return {
    config,
    flatSchema,
    schemaRegistry,
    checkBranchAccess,
    checkPathAccess,
    checkContentAccess,
    createGitManagerFor,
    registry,
    githubService,
    bootstrapAdminIds,
    commitFiles,
    submitBranch,
    commitToSettingsBranch,
    getSettingsBranchRoot,
  }
}
