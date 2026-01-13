import type { ApiContext } from './types'
import type { BranchMode } from '../paths'

/**
 * Get the appropriate branch context for settings (permissions/groups).
 * In local-simple mode, returns the main branch context for reading/writing files.
 * In prod mode, returns the settings branch context.
 * In local-prod-sim mode, returns the main branch context.
 */
export async function getSettingsBranchContext(
  ctx: ApiContext,
): Promise<
  { context: any; mode: BranchMode; branchName: string } | { error: string; status: number }
> {
  const mode = ctx.services.config.mode ?? 'local-simple'

  // Determine which branch to use
  let branchName: string
  if (mode === 'prod' || mode === 'local-prod-sim') {
    // Use settings branch in prod and local-prod-sim modes
    branchName = ctx.services.config.settingsBranch ?? 'canopycms-settings'
  } else {
    // Use main branch for local-simple mode
    branchName = ctx.services.config.defaultBaseBranch ?? 'main'
  }

  const context = await ctx.getBranchContext(branchName)

  if (!context) {
    return { error: `Branch ${branchName} not found`, status: 500 }
  }

  return { context, mode, branchName }
}

/**
 * Commit and push settings changes based on the mode.
 * In local-simple mode, does nothing (no git operations).
 * In prod mode, uses commitToSettingsBranch.
 * In local-prod-sim mode, uses regular commitFiles.
 */
export async function commitSettings(
  ctx: ApiContext,
  options: {
    context: any
    branchRoot: string
    fileName: string
    message: string
    mode: BranchMode
  },
): Promise<void> {
  // No git operations in local-simple
  if (options.mode === 'local-simple') {
    return
  }

  if (options.mode === 'prod' || options.mode === 'local-prod-sim') {
    // Use commitToSettingsBranch for prod and local-prod-sim modes
    // In prod mode: create PR if configured
    // In local-prod-sim mode: don't create PR (no real GitHub)
    const result = await ctx.services.commitToSettingsBranch({
      branchRoot: options.branchRoot,
      files: options.fileName,
      message: options.message,
      createPR: options.mode === 'prod' && (ctx.services.config.autoCreatePermissionsPR ?? true),
    })

    if (!result.pushed) {
      console.warn(`${options.message} committed but not pushed:`, result.error)
    }
  }
}
