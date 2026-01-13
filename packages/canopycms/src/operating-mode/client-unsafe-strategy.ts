/**
 * Client-Unsafe Operating Mode Strategies
 *
 * Full strategy implementations that extend client-safe base classes.
 * INCLUDES Node.js imports (fs, path, process) - can only be imported server-side.
 *
 * These classes inherit all client-safe methods and add client-unsafe functionality.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import simpleGit from 'simple-git'
import {
  ProdClientSafeStrategy,
  LocalProdSimClientSafeStrategy,
  LocalSimpleClientSafeStrategy,
} from './client-safe-strategy'
import type { OperatingMode, ClientUnsafeStrategy, ResolveRemoteUrlOptions } from './types'
import type { CanopyConfig } from '../config'
import { GitManager } from '../git-manager'

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

  async resolveRemoteUrl(options: ResolveRemoteUrlOptions): Promise<string | undefined> {
    // Priority: explicit > config > env variable
    if (options.remoteUrl) return options.remoteUrl
    if (options.defaultRemoteUrl) return options.defaultRemoteUrl
    if (process.env.CANOPYCMS_REMOTE_URL) return process.env.CANOPYCMS_REMOTE_URL
    return undefined
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

  async validateWorkspace(_branchRoot: string): Promise<void> {
    // Prod mode handles workspace initialization automatically
    // No validation needed
  }

  validateConfig(config: Partial<CanopyConfig>): void {
    if (!config.gitBotAuthorName || !config.gitBotAuthorEmail) {
      throw new Error('gitBotAuthorName and gitBotAuthorEmail are required in prod mode')
    }
  }

  shouldCreatePermissionsPR(config: { autoCreatePermissionsPR?: boolean }): boolean {
    return config.autoCreatePermissionsPR ?? true
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

  async resolveRemoteUrl(options: ResolveRemoteUrlOptions): Promise<string | undefined> {
    // Priority: explicit > config > env variable > auto-init local remote
    if (options.remoteUrl) return options.remoteUrl
    if (options.defaultRemoteUrl) return options.defaultRemoteUrl
    if (process.env.CANOPYCMS_REMOTE_URL) return process.env.CANOPYCMS_REMOTE_URL

    // Auto-initialize local simulated remote
    const gitRoot = await this.findGitRoot()
    const sourceRoot = options.sourceRoot
    const sourcePath = sourceRoot ? path.resolve(gitRoot, sourceRoot) : gitRoot
    const localRemotePath = path.join(sourcePath, '.canopycms/remote.git')

    await GitManager.ensureLocalSimulatedRemote({
      remotePath: localRemotePath,
      sourcePath: gitRoot,
      baseBranch: options.baseBranch ?? 'main',
      subdirectory: sourceRoot,
    })

    return localRemotePath
  }

  private async findGitRoot(): Promise<string> {
    let gitRoot = process.cwd()
    try {
      const git = simpleGit({ baseDir: process.cwd() })
      const result = await git.raw(['rev-parse', '--show-toplevel'])
      gitRoot = result.trim()
    } catch {
      // Fall back to cwd if not in a git repo
    }
    return gitRoot
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

  async validateWorkspace(_branchRoot: string): Promise<void> {
    // Local-prod-sim handles initialization automatically
  }

  validateConfig(_config: Partial<CanopyConfig>): void {
    // No special validation for local-prod-sim
  }

  shouldCreatePermissionsPR(_config: { autoCreatePermissionsPR?: boolean }): boolean {
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
    // In local-simple, branch root is always the base root (no subdirectories)
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

  async resolveRemoteUrl(_options: ResolveRemoteUrlOptions): Promise<string | undefined> {
    return undefined // No remote needed in local-simple
  }

  requiresExistingRepo(): boolean {
    return true // Must have existing repo
  }

  getSettingsBranchName(config: { settingsBranch?: string; defaultBaseBranch?: string }): string {
    // Use main branch for settings in local-simple
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

  async validateWorkspace(branchRoot: string): Promise<void> {
    // Local-simple requires existing git repo
    try {
      const stat = await fs.stat(path.join(branchRoot, '.git'))
      if (!stat.isDirectory()) {
        throw new Error(`Expected git repo at ${branchRoot}`)
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`Expected git repo at ${branchRoot}`)
      }
      throw err
    }
  }

  validateConfig(_config: Partial<CanopyConfig>): void {
    // No special validation for local-simple
  }

  shouldCreatePermissionsPR(_config: { autoCreatePermissionsPR?: boolean }): boolean {
    return false // No GitHub in local-simple
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
    case 'local-prod-sim':
      strategy = new LocalProdSimStrategy()
      break
    case 'local-simple':
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
