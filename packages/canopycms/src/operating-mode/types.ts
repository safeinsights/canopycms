/**
 * Operating Mode Strategy Types
 *
 * This module defines the two-layer strategy pattern for operating modes:
 * - ClientSafeStrategy: Methods safe for client-side bundles (no Node.js APIs)
 * - ClientUnsafeStrategy: Full strategy with Node.js APIs (server-side only)
 */

import type { OperatingMode as OM } from '.'
import type { CanopyConfig } from '../config'

// Re-export OperatingMode so it's available from this module
export type OperatingMode = OM

/**
 * Options for resolving git remote URL
 */
export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch?: string
  sourceRoot?: string
}

/**
 * Configuration for remote URL resolution
 * Strategies return this data; GitManager executes the logic
 */
export interface RemoteUrlConfig {
  /** Whether to auto-initialize a local remote */
  shouldAutoInitLocal: boolean
  /** Default path for local remote (e.g., '.canopycms/remote.git') */
  defaultRemotePath: string
  /** Environment variable name for remote URL */
  envVarName: string
}

/**
 * Client-Safe Strategy
 *
 * Methods that can be safely imported in 'use client' React components.
 * NO Node.js APIs (fs, path, process, etc.) - only pure logic and simple data.
 */
export interface ClientSafeStrategy {
  /** The operating mode this strategy represents */
  readonly mode: OperatingMode

  // ========================================================================
  // UI Feature Flags
  // ========================================================================

  /** Whether this mode supports multiple branch workspaces */
  supportsBranching(): boolean

  /** Whether to show status badge in UI */
  supportsStatusBadge(): boolean

  /** Whether comments/collaboration features are enabled */
  supportsComments(): boolean

  /** Whether pull request features are available */
  supportsPullRequests(): boolean

  // ========================================================================
  // Simple Data Methods (no I/O)
  // ========================================================================

  /** Get the permissions file name (e.g., 'permissions.json' or 'permissions.local.json') */
  getPermissionsFileName(): string

  /** Get the groups file name (e.g., 'groups.json' or 'groups.local.json') */
  getGroupsFileName(): string

  /** Whether git commits should be made in this mode */
  shouldCommit(): boolean

  /** Whether git pushes should be made in this mode */
  shouldPush(): boolean
}

/**
 * Client-Unsafe Strategy
 *
 * Full strategy including Node.js APIs. Can only be imported server-side.
 * Extends ClientSafeStrategy, so all client-safe methods are available.
 */
export interface ClientUnsafeStrategy extends ClientSafeStrategy {
  // ========================================================================
  // Path Resolution (needs path, process.cwd, env vars)
  // ========================================================================

  /**
   * Get the content directory path (at project/workspace root).
   * - dev/prod-sim: {cwd}/content
   * - prod (in workspaces): {workspaceRoot}/content
   */
  getContentRoot(sourceRoot?: string): string

  /**
   * Get the parent directory of all branch workspaces (contains branches.json and branch directories).
   * - prod-sim: {cwd}/.canopy-prod-sim/branches
   * - prod: $CANOPYCMS_WORKSPACE_ROOT/branches or /mnt/efs/workspace/branches
   * @throws Error in dev mode (no branching)
   */
  getBranchesRoot(sourceRoot?: string): string

  /**
   * Get individual branch workspace directory.
   * Returns: {branchesRoot}/{branchName}
   * @throws Error in dev mode (no branching)
   */
  getBranchRoot(branchName: string, sourceRoot?: string): string

  /**
   * Get the git exclude pattern for runtime metadata (e.g., '.canopy-meta/').
   * Used by GitManager to add to .git/info/exclude in content branch workspaces.
   */
  getGitExcludePattern(): string

  // ========================================================================
  // File Paths (needs path.join)
  // ========================================================================

  /** Get the full path to the permissions file */
  getPermissionsFilePath(root: string): string

  /** Get the full path to the groups file */
  getGroupsFilePath(root: string): string

  // ========================================================================
  // Git Operations
  // ========================================================================

  /** Get configuration for remote URL resolution (GitManager executes the logic) */
  getRemoteUrlConfig(): RemoteUrlConfig

  /** Whether this mode requires an existing git repository */
  requiresExistingRepo(): boolean

  // ========================================================================
  // Settings
  // ========================================================================

  /**
   * Get the branch name to use for settings (permissions/groups).
   * Returns: canopycms-settings-{deploymentName}
   */
  getSettingsBranchName(config: {
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }): string

  /** Get the root directory for loading settings */
  getSettingsBranchRoot(
    branchRoot: string,
    getSettingsBranch: () => Promise<string>,
  ): Promise<string>

  /** Whether settings should be stored in a separate branch */
  usesSeparateSettingsBranch(): boolean

  // ========================================================================
  // Validation
  // ========================================================================

  /** Validate configuration for this mode */
  validateConfig(config: Partial<CanopyConfig>): void

  // ========================================================================
  // GitHub
  // ========================================================================

  /** Whether PRs should be auto-created for permissions/groups changes */
  shouldCreateSettingsPR(config: { autoCreateSettingsPR?: boolean }): boolean
}
