/**
 * Client-Unsafe Operating Mode Strategies
 *
 * Full strategy implementations that extend client-safe base classes.
 * INCLUDES Node.js imports (fs, path, process) - can only be imported server-side.
 *
 * These classes inherit all client-safe methods and add client-unsafe functionality.
 */

import path from 'node:path'
import {
  ProdClientSafeStrategy,
  LocalProdSimClientSafeStrategy,
  LocalSimpleClientSafeStrategy,
} from './client-safe-strategy'
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

  getContentRoot(sourceRoot?: string): string {
    // In prod, content is at workspace root (not project root)
    // This is called with sourceRoot = workspace path
    return path.resolve(sourceRoot ?? process.cwd(), 'content')
  }

  getContentBranchesRoot(_sourceRoot?: string): string {
    const envWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    const workspace = path.resolve(envWorkspace ?? DEFAULT_PROD_WORKSPACE)
    return path.join(workspace, 'content-branches')
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
    const envWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    const workspace = path.resolve(envWorkspace ?? DEFAULT_PROD_WORKSPACE)
    return {
      shouldAutoInitLocal: false,
      defaultRemotePath: '',
      envVarName: 'CANOPYCMS_REMOTE_URL',
      autoDetectRemotePath: path.join(workspace, 'remote.git'),
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

  getSettingsRoot(_sourceRoot?: string): string {
    const envWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    const workspace = path.resolve(envWorkspace ?? DEFAULT_PROD_WORKSPACE)
    return path.join(workspace, 'settings')
  }

  usesSeparateSettingsBranch(): boolean {
    return true
  }

  validateConfig(config: Partial<CanopyConfig>): void {
    if (!config.gitBotAuthorName || !config.gitBotAuthorEmail) {
      throw new Error(
        'gitBotAuthorName and gitBotAuthorEmail are required in prod mode'
      )
    }
  }

  shouldCreateSettingsPR(config: { autoCreateSettingsPR?: boolean }): boolean {
    return config.autoCreateSettingsPR ?? true
  }
}

// ============================================================================
// Local Production Simulation - Full Strategy
// ============================================================================

class LocalProdSimStrategy
  extends LocalProdSimClientSafeStrategy
  implements ClientUnsafeStrategy
{
  // Inherits client-safe methods from LocalProdSimClientSafeStrategy

  private getProdSimRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), '.canopy-prod-sim')
  }

  getContentRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), 'content')
  }

  getContentBranchesRoot(sourceRoot?: string): string {
    return path.join(this.getProdSimRoot(sourceRoot), 'content-branches')
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
      defaultRemotePath: '.canopy-prod-sim/remote.git',
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
    const deploymentName = config.deploymentName ?? 'prod'
    return `canopycms-settings-${deploymentName}`
  }

  getSettingsRoot(sourceRoot?: string): string {
    return path.join(this.getProdSimRoot(sourceRoot), 'settings')
  }

  usesSeparateSettingsBranch(): boolean {
    return true
  }

  validateConfig(_config: Partial<CanopyConfig>): void {
    // No special validation for prod-sim
  }

  shouldCreateSettingsPR(_config: { autoCreateSettingsPR?: boolean }): boolean {
    return false // No real GitHub in simulation
  }
}

// ============================================================================
// Local Simple Mode - Full Strategy
// ============================================================================

class LocalSimpleStrategy
  extends LocalSimpleClientSafeStrategy
  implements ClientUnsafeStrategy
{
  // Inherits: supportsBranching() returns false, getPermissionsFileName() returns 'permissions.local.json'

  private getDevConfigRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), '.canopy-dev')
  }

  getContentRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), 'content')
  }

  getContentBranchesRoot(_sourceRoot?: string): string {
    throw new Error('No branching in dev mode')
  }

  getContentBranchRoot(_branchName: string, _sourceRoot?: string): string {
    throw new Error('No branching in dev mode')
  }

  getGitExcludePattern(): string {
    return '.canopy-meta/'
  }

  getPermissionsFilePath(root: string): string {
    // Returns: {projectRoot}/.canopy-dev/settings/permissions.json
    return path.join(this.getDevConfigRoot(root), 'settings', 'permissions.json')
  }

  getGroupsFilePath(root: string): string {
    // Returns: {projectRoot}/.canopy-dev/settings/groups.json
    return path.join(this.getDevConfigRoot(root), 'settings', 'groups.json')
  }

  getRemoteUrlConfig(): import('./types').RemoteUrlConfig {
    return {
      shouldAutoInitLocal: false,
      defaultRemotePath: '',
      envVarName: 'CANOPYCMS_REMOTE_URL',
    }
  }

  requiresExistingRepo(): boolean {
    return true // Must have existing repo
  }

  getSettingsBranchName(config: {
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }): string {
    // Use main branch for settings in dev (no separate settings branch)
    return config.defaultBaseBranch ?? 'main'
  }

  getSettingsRoot(sourceRoot?: string): string {
    return path.join(this.getDevConfigRoot(sourceRoot), 'settings')
  }

  usesSeparateSettingsBranch(): boolean {
    return false
  }

  validateConfig(_config: Partial<CanopyConfig>): void {
    // No special validation for dev
  }

  shouldCreateSettingsPR(_config: { autoCreateSettingsPR?: boolean }): boolean {
    return false // No GitHub in dev
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
    case 'prod-sim':
      strategy = new LocalProdSimStrategy()
      break
    case 'dev':
      strategy = new LocalSimpleStrategy()
      break
    default:
      // Exhaustiveness check - TypeScript will error if a mode is not handled
      const _exhaustive: never = mode
      throw new Error(`Unknown operating mode: ${_exhaustive}`)
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
