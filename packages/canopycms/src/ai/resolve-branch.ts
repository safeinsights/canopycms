/**
 * Shared branch root resolution for AI content generation.
 * Used by both the route handler and build utility.
 */

import { loadOrCreateBranchContext } from '../branch-workspace'
import { isDeployedStatic } from '../build-mode'
import type { CanopyConfig } from '../config'

/**
 * Resolve the branch root directory for reading content.
 *
 * - Static deployment: current working directory (content is in the checkout)
 * - Server (prod/dev): load or create the default base branch workspace
 */
export async function resolveBranchRoot(config: CanopyConfig): Promise<string> {
  // Static deployments read content directly from the checkout — no branch workspace needed
  if (isDeployedStatic(config)) {
    return process.cwd()
  }

  const activeBranch = config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main'
  const context = await loadOrCreateBranchContext({
    config,
    branchName: activeBranch,
    mode: config.mode,
    createdBy: 'canopycms-ai',
    remoteUrl: config.defaultRemoteUrl,
  })

  return context.branchRoot
}
