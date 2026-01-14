import { operatingStrategy } from './operating-mode'
import type { OperatingMode } from './operating-mode'

/**
 * Check if a branch name is the settings branch for the current configuration
 */
export const isSettingsBranch = (
  branchName: string,
  config: {
    mode: OperatingMode
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }
): boolean => {
  const strategy = operatingStrategy(config.mode)

  // Dev mode doesn't have separate settings branch
  if (!strategy.usesSeparateSettingsBranch()) {
    return false
  }

  const settingsBranchName = strategy.getSettingsBranchName({
    settingsBranch: config.settingsBranch,
    deploymentName: config.deploymentName,
    defaultBaseBranch: config.defaultBaseBranch,
  })

  return branchName === settingsBranchName
}

/**
 * Get the settings branch name for the current configuration
 * Returns null if operating mode doesn't use separate settings branch (dev mode)
 */
export const getSettingsBranchName = (config: {
  mode: OperatingMode
  settingsBranch?: string
  deploymentName?: string
  defaultBaseBranch?: string
}): string | null => {
  const strategy = operatingStrategy(config.mode)

  if (!strategy.usesSeparateSettingsBranch()) {
    return null
  }

  return strategy.getSettingsBranchName({
    settingsBranch: config.settingsBranch,
    deploymentName: config.deploymentName,
    defaultBaseBranch: config.defaultBaseBranch,
  })
}
