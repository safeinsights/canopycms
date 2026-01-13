/**
 * Operating Mode Strategy Types
 *
 * This module defines the two-layer strategy pattern for operating modes:
 * - ClientSafeStrategy: Methods safe for client-side bundles (no Node.js APIs)
 * - ClientUnsafeStrategy: Full strategy with Node.js APIs (server-side only)
 */

import type { OperatingMode as OM } from '../paths'
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

  /** Resolve the base root directory for branches */
  getBaseRoot(override?: string): string

  /** Resolve the branch root given a base and branch name */
  getBranchRoot(baseRoot: string, branchName: string): string

  // ========================================================================
  // File Paths (needs path.join)
  // ========================================================================

  /** Get the full path to the permissions file */
  getPermissionsFilePath(root: string): string

  /** Get fallback permissions file path (if any) for backwards compatibility */
  getFallbackPermissionsFilePath(root: string): string | null

  /** Get the full path to the groups file */
  getGroupsFilePath(root: string): string

  /** Get fallback groups file path (if any) */
  getFallbackGroupsFilePath(root: string): string | null

  // ========================================================================
  // Git Operations
  // ========================================================================

  /** Resolve the remote URL for git operations */
  resolveRemoteUrl(options: ResolveRemoteUrlOptions): Promise<string | undefined>

  /** Whether this mode requires an existing git repository */
  requiresExistingRepo(): boolean

  // ========================================================================
  // Settings
  // ========================================================================

  /** Get the branch name to use for settings (permissions/groups) */
  getSettingsBranchName(config: { settingsBranch?: string; defaultBaseBranch?: string }): string

  /** Get the root directory for loading settings */
  getSettingsBranchRoot(
    branchRoot: string,
    getSettingsBranch: () => Promise<string>,
  ): Promise<string>

  /** Whether settings should be stored in a separate branch */
  usesSeparateSettingsBranch(): boolean

  // ========================================================================
  // Validation (needs fs)
  // ========================================================================

  /** Validate workspace setup (e.g., git repo exists) */
  validateWorkspace(branchRoot: string): Promise<void>

  /** Validate configuration for this mode */
  validateConfig(config: Partial<CanopyConfig>): void

  // ========================================================================
  // GitHub
  // ========================================================================

  /** Whether PRs should be auto-created for permissions/groups changes */
  shouldCreatePermissionsPR(config: { autoCreatePermissionsPR?: boolean }): boolean
}
