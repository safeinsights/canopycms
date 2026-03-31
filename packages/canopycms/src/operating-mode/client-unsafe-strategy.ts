/**
 * Client-Unsafe Operating Mode Strategies
 *
 * Full strategy implementations that extend client-safe base classes.
 * INCLUDES Node.js imports (fs, path, process) - can only be imported server-side.
 *
 * These classes inherit all client-safe methods and add client-unsafe functionality.
 */

import path from 'node:path'
import { ProdClientSafeStrategy, DevClientSafeStrategy } from './client-safe-strategy'
import type { OperatingMode, ClientUnsafeStrategy } from './types'
import type { CanopyConfig } from '../config'
import { DEFAULT_PROD_WORKSPACE } from '../config'

// ============================================================================
// Production Mode - Full Strategy
// ============================================================================

class ProdStrategy extends ProdClientSafeStrategy implements ClientUnsafeStrategy {
  // All client-safe methods inherited automatically from ProdClientSafeStrategy:
  // - mode, supportsBranching(), supportsStatusBadge(), supportsComments()
  // - supportsPullRequests(), getPermissionsFileName(), getGroupsFileName()
  // - shouldCommit(), shouldPush()

  // Add client-unsafe methods (use Node.js APIs)

  getWorkspaceRoot(_sourceRoot?: string): string {
    return path.resolve(process.env.CANOPYCMS_WORKSPACE_ROOT ?? DEFAULT_PROD_WORKSPACE)
  }

  getContentRoot(sourceRoot?: string): string {
    // In prod, content is at workspace root (not project root)
    // This is called with sourceRoot = workspace path
    return path.resolve(sourceRoot ?? process.cwd(), 'content')
  }

  getContentBranchesRoot(sourceRoot?: string): string {
    return path.join(this.getWorkspaceRoot(sourceRoot), 'content-branches')
  }

  getContentBranchRoot(branchName: string, sourceRoot?: string): string {
    return path.resolve(this.getContentBranchesRoot(sourceRoot), branchName)
  }

  getGitExcludePattern(): string {
    return '.canopy-meta/'
  }

  getPermissionsFilePath(root: string): string {
    return path.join(root, this.getPermissionsFileName())
  }

  getGroupsFilePath(root: string): string {
    return path.join(root, this.getGroupsFileName())
  }

  getRemoteUrlConfig(): import('./types').RemoteUrlConfig {
    return {
      shouldAutoInitLocal: false,
      defaultRemotePath: '',
      envVarName: 'CANOPYCMS_REMOTE_URL',
      autoDetectRemotePath: path.join(this.getWorkspaceRoot(), 'remote.git'),
    }
  }

  requiresExistingRepo(): boolean {
    return false // Will clone if needed
  }

  getSettingsBranchName(config: {
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }): string {
    if (config.settingsBranch) return config.settingsBranch
    const deploymentName = config.deploymentName ?? 'prod'
    return `canopycms-settings-${deploymentName}`
  }

  getSettingsRoot(sourceRoot?: string): string {
    return path.join(this.getWorkspaceRoot(sourceRoot), 'settings')
  }

  usesSeparateSettingsBranch(): boolean {
    return true
  }

  validateConfig(config: Partial<CanopyConfig>): void {
    if (!config.gitBotAuthorName || !config.gitBotAuthorEmail) {
      throw new Error('gitBotAuthorName and gitBotAuthorEmail are required in prod mode')
    }
  }

  shouldCreateSettingsPR(config: { autoCreateSettingsPR?: boolean }): boolean {
    return config.autoCreateSettingsPR ?? true
  }
}

// ============================================================================
// Dev Mode - Full Strategy
// ============================================================================

class DevStrategy extends DevClientSafeStrategy implements ClientUnsafeStrategy {
  // Inherits client-safe methods from DevClientSafeStrategy

  getWorkspaceRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), '.canopy-dev')
  }

  getContentRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), 'content')
  }

  getContentBranchesRoot(sourceRoot?: string): string {
    return path.join(this.getWorkspaceRoot(sourceRoot), 'content-branches')
  }

  getContentBranchRoot(branchName: string, sourceRoot?: string): string {
    return path.resolve(this.getContentBranchesRoot(sourceRoot), branchName)
  }

  getGitExcludePattern(): string {
    return '.canopy-meta/'
  }

  getPermissionsFilePath(root: string): string {
    return path.join(root, this.getPermissionsFileName())
  }

  getGroupsFilePath(root: string): string {
    return path.join(root, this.getGroupsFileName())
  }

  getRemoteUrlConfig(): import('./types').RemoteUrlConfig {
    return {
      shouldAutoInitLocal: true,
      defaultRemotePath: '.canopy-dev/remote.git',
      envVarName: 'CANOPYCMS_REMOTE_URL',
    }
  }

  requiresExistingRepo(): boolean {
    return false
  }

  getSettingsBranchName(config: {
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }): string {
    if (config.settingsBranch) return config.settingsBranch
    const deploymentName = config.deploymentName ?? 'local'
    return `canopycms-settings-${deploymentName}`
  }

  getSettingsRoot(sourceRoot?: string): string {
    return path.join(this.getWorkspaceRoot(sourceRoot), 'settings')
  }

  usesSeparateSettingsBranch(): boolean {
    return true
  }

  validateConfig(_config: Partial<CanopyConfig>): void {
    // No special validation for dev mode
  }

  shouldCreateSettingsPR(_config: { autoCreateSettingsPR?: boolean }): boolean {
    return false // No real GitHub in local dev mode
  }
}

// ============================================================================
// Factory with Memoization
// ============================================================================

const strategyCache = new Map<OperatingMode, ClientUnsafeStrategy>()

/**
 * Get the full strategy (client-unsafe) for an operating mode.
 *
 * Strategies are memoized - one instance per mode for the entire process lifetime.
 * Safe to call inline: operatingStrategy(mode).getBaseRoot()
 *
 * Includes all client-safe methods (inherited) plus client-unsafe methods (Node.js APIs).
 *
 * @param mode - The operating mode
 * @returns Full strategy instance with client-unsafe methods
 */
export function operatingStrategy(mode: OperatingMode): ClientUnsafeStrategy {
  const cached = strategyCache.get(mode)
  if (cached) return cached

  let strategy: ClientUnsafeStrategy
  switch (mode) {
    case 'prod':
      strategy = new ProdStrategy()
      break
    case 'dev':
      strategy = new DevStrategy()
      break
    default: {
      // Exhaustiveness check - TypeScript will error if a mode is not handled
      const _exhaustive: never = mode
      throw new Error(`Unknown operating mode: ${_exhaustive}`)
    }
  }

  strategyCache.set(mode, strategy)
  return strategy
}

/**
 * Clear the strategy cache (mainly for testing)
 */
export function clearStrategyCache(): void {
  strategyCache.clear()
}
