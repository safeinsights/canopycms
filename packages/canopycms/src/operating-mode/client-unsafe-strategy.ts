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

const DEFAULT_PROD_BASE = '/mnt/efs/site'

// ============================================================================
// Production Mode - Full Strategy
// ============================================================================

class ProdStrategy extends ProdClientSafeStrategy implements ClientUnsafeStrategy {
  // All client-safe methods inherited automatically from ProdClientSafeStrategy:
  // - mode, supportsBranching(), supportsStatusBadge(), supportsComments()
  // - supportsPullRequests(), getPermissionsFileName(), getGroupsFileName()
  // - shouldCommit(), shouldPush()

  // Add client-unsafe methods (use Node.js APIs)

  getBaseRoot(override?: string): string {
    if (override) return path.resolve(override)
    const envBase = process.env.CANOPYCMS_BRANCH_ROOT
    return path.resolve(envBase || DEFAULT_PROD_BASE)
  }

  getBranchRoot(baseRoot: string, branchName: string): string {
    return path.resolve(baseRoot, branchName)
  }

  getPermissionsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getPermissionsFileName())
  }

  getFallbackPermissionsFilePath(_root: string): string | null {
    return null // No fallback in prod
  }

  getGroupsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getGroupsFileName())
  }

  getFallbackGroupsFilePath(_root: string): string | null {
    return null
  }

  getRemoteUrlConfig(): import('./types').RemoteUrlConfig {
    return {
      shouldAutoInitLocal: false,
      defaultRemotePath: '',
      envVarName: 'CANOPYCMS_REMOTE_URL',
    }
  }

  requiresExistingRepo(): boolean {
    return false // Will clone if needed
  }

  getSettingsBranchName(config: { settingsBranch?: string; defaultBaseBranch?: string }): string {
    return config.settingsBranch ?? 'canopycms-settings'
  }

  async getSettingsBranchRoot(
    _branchRoot: string,
    getSettingsBranch: () => Promise<string>,
  ): Promise<string> {
    return getSettingsBranch()
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
// Local Production Simulation - Full Strategy
// ============================================================================

class LocalProdSimStrategy extends LocalProdSimClientSafeStrategy implements ClientUnsafeStrategy {
  // Inherits client-safe methods from LocalProdSimClientSafeStrategy

  getBaseRoot(override?: string): string {
    if (override) return path.resolve(override)
    return path.resolve(process.cwd(), '.canopycms/branches')
  }

  getBranchRoot(baseRoot: string, branchName: string): string {
    return path.resolve(baseRoot, branchName)
  }

  getPermissionsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getPermissionsFileName())
  }

  getFallbackPermissionsFilePath(_root: string): string | null {
    return null
  }

  getGroupsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getGroupsFileName())
  }

  getFallbackGroupsFilePath(_root: string): string | null {
    return null
  }

  getRemoteUrlConfig(): import('./types').RemoteUrlConfig {
    return {
      shouldAutoInitLocal: true,
      defaultRemotePath: '.canopycms/remote.git',
      envVarName: 'CANOPYCMS_REMOTE_URL',
    }
  }

  requiresExistingRepo(): boolean {
    return false
  }

  getSettingsBranchName(config: { settingsBranch?: string; defaultBaseBranch?: string }): string {
    return config.settingsBranch ?? 'canopycms-settings'
  }

  async getSettingsBranchRoot(
    _branchRoot: string,
    getSettingsBranch: () => Promise<string>,
  ): Promise<string> {
    return getSettingsBranch()
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

class LocalSimpleStrategy extends LocalSimpleClientSafeStrategy implements ClientUnsafeStrategy {
  // Inherits: supportsBranching() returns false, getPermissionsFileName() returns 'permissions.local.json'

  getBaseRoot(override?: string): string {
    if (override) return path.resolve(override)
    return path.resolve(process.cwd())
  }

  getBranchRoot(baseRoot: string, _branchName: string): string {
    // In dev, branch root is always the base root (no subdirectories)
    return baseRoot
  }

  getPermissionsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getPermissionsFileName())
  }

  getFallbackPermissionsFilePath(root: string): string | null {
    // Fallback to non-local file for backwards compatibility
    return path.join(root, '.canopycms/permissions.json')
  }

  getGroupsFilePath(root: string): string {
    return path.join(root, '.canopycms', this.getGroupsFileName())
  }

  getFallbackGroupsFilePath(root: string): string | null {
    // Fallback to non-local file for backwards compatibility
    return path.join(root, '.canopycms/groups.json')
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

  getSettingsBranchName(config: { settingsBranch?: string; defaultBaseBranch?: string }): string {
    // Use main branch for settings in dev
    return config.defaultBaseBranch ?? 'main'
  }

  async getSettingsBranchRoot(
    branchRoot: string,
    _getSettingsBranch: () => Promise<string>,
  ): Promise<string> {
    // Settings are in the same branch
    return branchRoot
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
