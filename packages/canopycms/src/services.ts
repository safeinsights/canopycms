import type { CanopyConfig } from './config'
import type { BranchState } from './types'
import type { UserContext } from './authz'
import { buildPathPermissions, createCheckPathAccess } from './path-permissions'
import { createCheckBranchAccess } from './authz'
import { createCheckContentAccess } from './content-access'
import { GitManager } from './git-manager'
import { BranchRegistry } from './branch-registry'
import { getDefaultBranchBase } from './paths'
import { createGitHubService, type GitHubService } from './github-service'

export interface CanopyServices {
  config: CanopyConfig
  checkBranchAccess: (state: BranchState, user: UserContext) => ReturnType<ReturnType<typeof createCheckBranchAccess>>
  checkPathAccess: ReturnType<typeof createCheckPathAccess>
  checkContentAccess: ReturnType<typeof createCheckContentAccess>
  pathPermissions: ReturnType<typeof buildPathPermissions>
  createGitManagerFor: (repoPath: string, opts?: { baseBranch?: string; remote?: string }) => GitManager
  registry: BranchRegistry
  githubService?: GitHubService
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
  const checkBranchAccess = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny')
  const pathPermissions = buildPathPermissions(config)
  const checkPathAccess = createCheckPathAccess(pathPermissions)
  const checkContentAccess = createCheckContentAccess({
    checkBranchAccess,
    checkPathAccess: (input) => checkPathAccess(input),
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
    pathPermissions,
    createGitManagerFor,
    registry,
    githubService,
  }
}
