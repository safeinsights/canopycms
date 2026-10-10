import type { ApiContext } from './types'
import type { OperatingMode } from '../operating-mode'
import { operatingStrategy } from '../operating-mode'
import { sanitizeErrorMessage } from '../utils/error'
import type { CanopyUser } from '../user'
import {
  appendTrailers,
  buildEditorTrailers,
  submissionEditorFromUser,
} from '../submission-attribution'

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

  // Pass the whole config, not a hand-picked subset, so deploymentName flows
  // through (see resolveDeploymentName in operating-mode/deployment-name.ts)
  // -- a subset silently computes the mode-default settings branch instead,
  // ignoring any deploymentName/CANOPYCMS_DEPLOYMENT_NAME resolution.
  const branchName = strategy.getSettingsBranchName(ctx.services.config)

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
 * Settings changes are never reviewed through a PR (see commitToSettingsBranch), and the bot
 * authors the commit, so its trailers, not its author line, name who made the change.
 */
export async function commitSettings(
  ctx: ApiContext,
  options: {
    context: { branchRoot: string }
    branchRoot: string
    fileName: string
    message: string
    /** The user making the change, named in the commit's trailers as a submit names its editors. */
    actor: CanopyUser
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
    const actor = submissionEditorFromUser(options.actor)
    const { config } = ctx.services
    const trailers = buildEditorTrailers(actor ? [actor] : [], {
      editedBy: config.gitEditedByTrailers ?? true,
      coAuthoredBy: config.gitCoAuthoredByTrailers ?? false,
    })
    const result = await ctx.services.commitToSettingsBranch({
      branchRoot: options.branchRoot,
      files: options.fileName,
      message: appendTrailers(options.message, trailers),
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
