/**
 * Shared branch root resolution for AI content generation.
 * Used by both the route handler and build utility.
 */

import { loadBranchContext } from '../branch-metadata'
import { isDeployedStatic } from '../build-mode'
import type { CanopyConfig } from '../config'

/**
 * Resolve the branch root directory for reading content.
 *
 * - Dev mode: current working directory (content is in the checkout)
 * - Static deployment: current working directory (content is in the checkout)
 * - Prod/prod-sim server: load the default base branch context
 */
export async function resolveBranchRoot(config: CanopyConfig): Promise<string> {
  if (config.mode === 'dev' || isDeployedStatic(config)) {
    return process.cwd()
  }

  const baseBranch = config.defaultBaseBranch ?? 'main'
  const context = await loadBranchContext({
    branchName: baseBranch,
    mode: config.mode,
  })

  if (!context) {
    throw new Error(
      `Could not load branch context for "${baseBranch}". ` +
        'Ensure the branch exists and has been initialized.',
    )
  }

  return context.branchRoot
}
