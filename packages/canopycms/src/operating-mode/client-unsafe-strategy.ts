/**
 * Full strategies: the client-safe base classes plus the methods that need
 * Node.js (fs, path, process). Server-side imports only.
 */

import path from 'node:path'
import { ProdClientSafeStrategy, DevClientSafeStrategy } from './client-safe-strategy'
import { resolveDeploymentName } from './deployment-name'
import type { OperatingMode, ClientUnsafeStrategy, RemoteUrlConfig } from './types'
import type { CanopyConfig } from '../config'
import { DEFAULT_PROD_WORKSPACE } from '../config'

class ProdStrategy extends ProdClientSafeStrategy implements ClientUnsafeStrategy {
  getWorkspaceRoot(_sourceRoot?: string): string {
    return path.resolve(process.env.CANOPYCMS_WORKSPACE_ROOT ?? DEFAULT_PROD_WORKSPACE)
  }

  getContentRoot(contentRoot: string, sourceRoot?: string): string {
    // In prod the caller passes sourceRoot = the workspace path, because
    // content sits at the workspace root rather than a project root.
    return path.resolve(sourceRoot ?? process.cwd(), contentRoot)
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

  getRemoteUrlConfig(): RemoteUrlConfig {
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
    return `canopycms-settings-${resolveDeploymentName(config, 'prod')}`
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

class DevStrategy extends DevClientSafeStrategy implements ClientUnsafeStrategy {
  getWorkspaceRoot(sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), '.canopy-dev')
  }

  getContentRoot(contentRoot: string, sourceRoot?: string): string {
    return path.resolve(sourceRoot ?? process.cwd(), contentRoot)
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

  getRemoteUrlConfig(): RemoteUrlConfig {
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
    return `canopycms-settings-${resolveDeploymentName(config, 'local')}`
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

const strategyCache = new Map<OperatingMode, ClientUnsafeStrategy>()

/**
 * Memoized: one instance per mode for the process lifetime, so this is safe to
 * call inline — `operatingStrategy(mode).getWorkspaceRoot()`.
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
      // Exhaustiveness check: adding a mode without a case fails to compile.
      const _exhaustive: never = mode
      throw new Error(`Unknown operating mode: ${_exhaustive}`)
    }
  }

  strategyCache.set(mode, strategy)
  return strategy
}

/**
 * Mainly for testing.
 * @internal Exported for tests.
 */
export function clearStrategyCache(): void {
  strategyCache.clear()
}
