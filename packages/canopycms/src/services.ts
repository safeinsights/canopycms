import type { CanopyConfig } from './config'
import type { BranchState } from './types'
import type { UserContext } from './authz'
import { createCheckPathAccess } from './path-permissions'
import { createCheckBranchAccess } from './authz'
import { createCheckContentAccess } from './content-access'
import { loadPathPermissions } from './permissions-loader'
import { GitManager } from './git-manager'
import { BranchRegistry } from './branch-registry'
import { getDefaultBranchBase } from './paths'
import { createGitHubService, type GitHubService } from './github-service'
import { RESERVED_GROUPS } from './reserved-groups'

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

/**
 * Get effective groups for a user, adding Admins group if they're a bootstrap admin.
 */
export const getEffectiveGroups = (
  userId: string,
  groups: string[] | undefined,
  bootstrapAdminIds: Set<string>,
): string[] => {
  const effectiveGroups = groups ? [...groups] : []
  if (bootstrapAdminIds.has(userId) && !effectiveGroups.includes(RESERVED_GROUPS.ADMINS)) {
    effectiveGroups.push(RESERVED_GROUPS.ADMINS)
  }
  return effectiveGroups
}

export interface CanopyServices {
  config: CanopyConfig
  checkBranchAccess: (
    state: BranchState,
    user: UserContext,
  ) => ReturnType<ReturnType<typeof createCheckBranchAccess>>
  checkPathAccess: ReturnType<typeof createCheckPathAccess>
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  createGitManagerFor: (
    repoPath: string,
    opts?: { baseBranch?: string; remote?: string },
  ) => GitManager
  registry: BranchRegistry
  githubService?: GitHubService
  /** Bootstrap admin user IDs that are always treated as Admins */
  bootstrapAdminIds: Set<string>
}

/**
 * Create reusable helpers from a validated CanopyConfig.
 * Intended to be called once at startup and injected where needed
 * (e.g., request handlers, loaders).
 */
export const createCanopyServices = (config: CanopyConfig): CanopyServices => {
  if (!config.gitBotAuthorName || !config.gitBotAuthorEmail) {
    throw new Error('CanopyCMS: gitBotAuthorName and gitBotAuthorEmail are required')
  }

  // Load bootstrap admin IDs from environment
  const bootstrapAdminIds = getBootstrapAdminIds()

  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny')
  // Path permissions are loaded dynamically from .canopycms/permissions.json at request time.
  // At the service level, we bind with empty rules for direct path checks.
  const checkPathAccess = createCheckPathAccess([], config.defaultPathAccess ?? 'allow')
  // Content access loads permissions dynamically from the branch root
  const checkContentAccess = createCheckContentAccess({
    checkBranchAccess,
    loadPathPermissions,
    defaultPathAccess: config.defaultPathAccess ?? 'allow',
  })
  const createGitManagerFor = (repoPath: string, opts?: { baseBranch?: string; remote?: string }) =>
    new GitManager({
      repoPath,
      // TODO DRY up default values (probably already in the schema definition)
      baseBranch: opts?.baseBranch ?? config.defaultBaseBranch ?? 'main',
      remote: opts?.remote ?? config.defaultRemoteName ?? 'origin',
    })
  const branchMode = config.mode ?? 'local-simple'
  const registry = new BranchRegistry(getDefaultBranchBase(branchMode))

  // Create GitHub service if applicable (only for prod/local-prod-sim modes)
  let githubService: GitHubService | undefined
  const mode = config.mode ?? 'local-simple'
  if (mode !== 'local-simple') {
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
    checkBranchAccess,
    checkPathAccess,
    checkContentAccess,
    createGitManagerFor,
    registry,
    githubService,
    bootstrapAdminIds,
  }
}
