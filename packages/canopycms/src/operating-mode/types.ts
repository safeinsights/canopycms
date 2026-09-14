/** Operating-mode strategy types. */

import type { OperatingMode as OM } from '.'
import type { CanopyConfig } from '../config'

export type OperatingMode = OM

/** @internal No importer. */
export interface ResolveRemoteUrlOptions {
  mode: OperatingMode
  remoteUrl?: string
  defaultRemoteUrl?: string
  baseBranch?: string
  sourceRoot?: string
}

/** Strategies return this data; GitManager executes the logic. */
export interface RemoteUrlConfig {
  shouldAutoInitLocal: boolean
  /** Default path for local remote (e.g., '.canopycms/remote.git') */
  defaultRemotePath: string
  envVarName: string
  /**
   * If this absolute path exists on disk it becomes the remote URL (file://).
   * Set in prod, where the EC2 worker creates remote.git on EFS. Unlike
   * shouldAutoInitLocal, this only DETECTS a remote; it never creates one.
   */
  autoDetectRemotePath?: string
}

/**
 * Methods safe to import in 'use client' React components: pure logic and
 * simple data, NO Node.js APIs (fs, path, process).
 */
export interface ClientSafeStrategy {
  readonly mode: OperatingMode

  /** Whether this mode supports multiple branch workspaces */
  supportsBranching(): boolean

  supportsStatusBadge(): boolean

  supportsComments(): boolean

  supportsPullRequests(): boolean

  /** Get the permissions file name (e.g., 'permissions.json' or 'permissions.local.json') */
  getPermissionsFileName(): string

  /** Get the groups file name (e.g., 'groups.json' or 'groups.local.json') */
  getGroupsFileName(): string

  /** Whether git commits should be made in this mode */
  shouldCommit(): boolean

  /** Whether git pushes should be made in this mode */
  shouldPush(): boolean
}

/** The full strategy, including Node.js APIs. Server-side imports only. */
export interface ClientUnsafeStrategy extends ClientSafeStrategy {
  /**
   * The mode's workspace root; content-branches, settings and .cache all live
   * under it. prod: CANOPYCMS_WORKSPACE_ROOT ?? /mnt/efs/workspace.
   * dev: {sourceRoot ?? cwd}/.canopy-dev.
   */
  getWorkspaceRoot(sourceRoot?: string): string

  /**
   * The content directory, `{sourceRoot ?? cwd}/{contentRoot}` in both modes.
   *
   * `contentRoot` is REQUIRED and must be the caller's already-resolved
   * `config.contentRoot` (falling back to 'content' at the call site, not here).
   * Defaulting it here would silently disarm any caller configured with a
   * non-default contentRoot: it would resolve a directory that never exists,
   * and a missing content directory reads as "nothing to do" rather than as an
   * error. Requiring the parameter makes that mistake impossible.
   */
  getContentRoot(contentRoot: string, sourceRoot?: string): string

  /**
   * `{workspaceRoot}/content-branches`: the parent of every content branch
   * workspace, and the home of branches.json.
   */
  getContentBranchesRoot(sourceRoot?: string): string

  /** `{contentBranchesRoot}/{branchName}`. */
  getContentBranchRoot(branchName: string, sourceRoot?: string): string

  /**
   * Runtime-metadata pattern (e.g. '.canopy-meta/') that GitManager adds to
   * .git/info/exclude in every content branch workspace.
   */
  getGitExcludePattern(): string

  getPermissionsFilePath(root: string): string

  getGroupsFilePath(root: string): string

  getRemoteUrlConfig(): RemoteUrlConfig

  /** Whether this mode requires an existing git repository */
  requiresExistingRepo(): boolean

  /** The permissions/groups branch: `canopycms-settings-{deploymentName}`. */
  getSettingsBranchName(config: {
    settingsBranch?: string
    deploymentName?: string
    defaultBaseBranch?: string
  }): string

  /** `{workspaceRoot}/settings`, where settings storage lives. */
  getSettingsRoot(sourceRoot?: string): string

  usesSeparateSettingsBranch(): boolean

  validateConfig(config: Partial<CanopyConfig>): void

  shouldCreateSettingsPR(config: { autoCreateSettingsPR?: boolean }): boolean
}
