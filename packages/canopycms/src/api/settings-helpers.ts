import type { ApiContext } from './types'
import type { OperatingMode } from '../operating-mode'
import { operatingStrategy } from '../operating-mode'

/**
 * Get the appropriate root path for settings (permissions/groups).
 * Returns the settings root managed by the settings workspace.
 */
export async function getSettingsBranchContext(
  ctx: ApiContext,
): Promise<
  | { context: { branchRoot: string }; mode: OperatingMode; branchName: string }
  | { error: string; status: number }
> {
  const mode = ctx.services.config.mode
  const strategy = operatingStrategy(mode)

  // Determine which branch name to use (for git operations)
  const branchName = strategy.getSettingsBranchName({
    settingsBranch: ctx.services.config.settingsBranch,
    defaultBaseBranch: ctx.services.config.defaultBaseBranch,
  })

  // Both prod and dev use a separate settings branch
  const settingsRoot = await ctx.services.getSettingsBranchRoot()
  return {
    context: { branchRoot: settingsRoot },
    mode,
    branchName,
  }
}

/**
 * Commit and push settings changes based on the mode.
 * Both prod and dev use commitToSettingsBranch.
 * In dev mode, commits to the settings branch but does not create a PR.
 */
export async function commitSettings(
  ctx: ApiContext,
  options: {
    context: { branchRoot: string }
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
      createPR: strategy.shouldCreateSettingsPR({
        autoCreateSettingsPR: ctx.services.config.autoCreateSettingsPR,
      }),
    })

    if (!result.pushed) {
      console.warn(`${options.message} committed but not pushed:`, result.error)
    }
  }
}
