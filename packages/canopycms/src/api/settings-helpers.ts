import type { ApiContext } from './types'
import type { OperatingMode } from '../paths'
import { operatingStrategy } from '../operating-mode'

/**
 * Get the appropriate branch context for settings (permissions/groups).
 * In local-simple mode, returns the main branch context for reading/writing files.
 * In prod mode, returns the settings branch context.
 * In local-prod-sim mode, returns the main branch context.
 */
export async function getSettingsBranchContext(
  ctx: ApiContext,
): Promise<
  { context: any; mode: OperatingMode; branchName: string } | { error: string; status: number }
> {
  const mode = ctx.services.config.mode

  // Determine which branch to use based on operating mode strategy
  const branchName = operatingStrategy(mode).getSettingsBranchName({
    settingsBranch: ctx.services.config.settingsBranch,
    defaultBaseBranch: ctx.services.config.defaultBaseBranch,
  })

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
    mode: OperatingMode
  },
): Promise<void> {
  const strategy = operatingStrategy(options.mode)

  // No git operations if mode doesn't support commits
  if (!strategy.shouldCommit()) {
    return
  }

  // For modes that use separate settings branch, commit to settings branch
  if (strategy.usesSeparateSettingsBranch()) {
    const result = await ctx.services.commitToSettingsBranch({
      branchRoot: options.branchRoot,
      files: options.fileName,
      message: options.message,
      createPR: strategy.shouldCreatePermissionsPR({
        autoCreatePermissionsPR: ctx.services.config.autoCreatePermissionsPR,
      }),
    })

    if (!result.pushed) {
      console.warn(`${options.message} committed but not pushed:`, result.error)
    }
  }
}
