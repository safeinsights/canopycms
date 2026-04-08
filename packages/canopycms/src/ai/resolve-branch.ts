/**
 * Shared branch root resolution for AI content generation.
 * Used by both the route handler and build utility.
 */

import { loadOrCreateBranchContext } from '../branch-workspace'
import { isDeployedStatic } from '../build-mode'
import type { CanopyConfig } from '../config'
import { detectHeadBranch } from '../utils/git'

/**
 * Resolve the branch root directory for reading content.
 *
 * - Static deployment: current working directory (content is in the checkout)
 * - Server (prod/dev): load or create the default active branch workspace
 *
 * Branch resolution priority (mirrors createActiveBranchDetector in services.ts):
 * 1. Explicit `defaultActiveBranch` in config
 * 2. In dev mode, auto-detect from git HEAD
 * 3. Fall back to `defaultBaseBranch` or 'main'
 */
export async function resolveBranchRoot(config: CanopyConfig): Promise<string> {
  // Static deployments read content directly from the checkout — no branch workspace needed
  if (isDeployedStatic(config)) {
    return process.cwd()
  }

  let activeBranch: string
  if (config.defaultActiveBranch) {
    activeBranch = config.defaultActiveBranch
  } else if (config.mode === 'dev') {
    activeBranch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
  } else {
    activeBranch = config.defaultBaseBranch ?? 'main'
  }

  const context = await loadOrCreateBranchContext({
    config,
    branchName: activeBranch,
    mode: config.mode,
    createdBy: 'canopycms-ai',
    remoteUrl: config.defaultRemoteUrl,
  })

  return context.branchRoot
}
