import type { ApiContext } from './types'
import type { OperatingMode } from '../operating-mode'
import { operatingStrategy } from '../operating-mode'
import { sanitizeErrorMessage } from '../utils/error'

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
 * Result of a settings commit attempt. Callers (permissions/groups handlers)
 * MUST check `pushed` before reporting success to the client (API-H1): a
 * settings file can be written to the branch working tree but fail to commit
 * or push (network error, git conflict, etc.), in which case the change is
 * NOT durably saved and will be lost on redeploy/container recycle.
 */
export interface CommitSettingsResult {
  /** True if either no commit was required for this mode, or the commit was pushed. */
  pushed: boolean
  /** Sanitized failure detail, present only when `pushed` is false. */
  error?: string
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
): Promise<CommitSettingsResult> {
  const strategy = operatingStrategy(options.mode)

  // No git operations if mode doesn't support commits - nothing to push, so
  // this isn't a failure to persist durably.
  if (!strategy.shouldCommit()) {
    return { pushed: true }
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
      return {
        pushed: false,
        error: result.error
          ? sanitizeErrorMessage(result.error)
          : 'Settings change was saved but not pushed to git',
      }
    }
  }

  return { pushed: true }
}
