import type { ApiContext } from './types'
import type { OperatingMode } from '../operating-mode';
import { operatingStrategy } from '../operating-mode'

/**
 * Get the appropriate root path for settings (permissions/groups).
 * In dev mode, returns the main branch root (.canopy-dev/settings/).
 * In prod/prod-sim modes, returns the settings root (settings/).
 */
export async function getSettingsBranchContext(
  ctx: ApiContext
): Promise<{ context: { branchRoot: string }; mode: OperatingMode; branchName: string } | { error: string; status: number }> {
  const mode = ctx.services.config.mode
  const strategy = operatingStrategy(mode)

  // Determine which branch name to use (for git operations)
  const branchName = strategy.getSettingsBranchName({
    settingsBranch: ctx.services.config.settingsBranch,
    defaultBaseBranch: ctx.services.config.defaultBaseBranch,
  })

  // For modes with separate settings branch, use settings root
  if (strategy.usesSeparateSettingsBranch()) {
    // Get settings root and ensure workspace exists
    const settingsRoot = await ctx.services.getSettingsBranchRoot()
    return {
      context: { branchRoot: settingsRoot },
      mode,
      branchName,
    }
  }

  // For dev mode, settings are stored in .canopy-dev/settings/
  // We need to pass the workspace root, not a branch root
  const workspaceRoot = ctx.services.config.sourceRoot ?? process.cwd()
  return {
    context: { branchRoot: workspaceRoot },
    mode,
    branchName,
  }
}

/**
 * Commit and push settings changes based on the mode.
 * In dev mode, does nothing (no git operations).
 * In prod mode, uses commitToSettingsBranch.
 * In prod-sim mode, uses regular commitFiles.
 */
export async function commitSettings(
  ctx: ApiContext,
  options: {
    context: any
    branchRoot: string
    fileName: string
    message: string
    mode: OperatingMode
  }
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
      createPR: strategy.shouldCreateSettingsPR({
        autoCreateSettingsPR: ctx.services.config.autoCreateSettingsPR,
      }),
    })

    if (!result.pushed) {
      console.warn(`${options.message} committed but not pushed:`, result.error)
    }
  }
}
