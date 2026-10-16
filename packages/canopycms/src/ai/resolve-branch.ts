/**
 * Shared branch root resolution for AI content generation.
 * Used by both the route handler and build utility.
 */

import { loadOrCreateBranchContext } from '../branch-workspace'
import { readsFromCheckout } from '../build-mode'
import type { CanopyConfig } from '../config'
import { GitManager } from '../git-manager'
import { baseBranchOf } from '../utils/base-branch'
import { detectHeadBranch } from '../utils/git'

/**
 * Resolve the branch root directory for reading content.
 *
 * The active-branch priority below mirrors `createActiveBranchDetector` in services.ts —
 * keep the two in sync if either changes.
 */
export async function resolveBranchRoot(config: CanopyConfig): Promise<string> {
  if (readsFromCheckout(config)) {
    return process.cwd()
  }

  // Prod reads an unset base branch from the remote's HEAD, as services does; provisioning
  // needs it even when the active branch is configured.
  const resolved: CanopyConfig =
    config.mode === 'prod' && !config.defaultBaseBranch
      ? { ...config, defaultBaseBranch: await GitManager.detectBaseBranch(config, 'throw') }
      : config

  let activeBranch: string
  if (config.defaultActiveBranch) {
    activeBranch = config.defaultActiveBranch
  } else if (config.mode === 'dev') {
    activeBranch = await detectHeadBranch(process.cwd(), config.defaultBaseBranch ?? 'main')
  } else {
    activeBranch = baseBranchOf(resolved)
  }

  const context = await loadOrCreateBranchContext({
    config: resolved,
    branchName: activeBranch,
    mode: config.mode,
    createdBy: 'canopycms-ai',
    remoteUrl: config.defaultRemoteUrl,
  })

  return context.branchRoot
}
