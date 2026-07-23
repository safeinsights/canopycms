import path from 'node:path'

import type { CanopyConfig } from './config'
import { ensureBranchRoot } from './paths'
import { getBranchMetadataFileManager, loadBranchContext } from './branch-metadata'
import { isDeployedStatic } from './build-mode'
import type { BranchAccessControl, BranchContext, CanopyUserId } from './types'
import type { OperatingMode } from './operating-mode'
import { operatingStrategy } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'
import { resolveBaseBranch } from './utils/git'
import { acquireProvisioningLock } from './utils/provisioning-lock'

const log = createDebugLogger({ prefix: 'BranchWorkspace' })

// In-memory lock to prevent concurrent workspace initialization
const workspaceInitLocks = new Map<string, Promise<void>>()

export interface OpenBranchOptions {
  branchName: string
  mode: OperatingMode
  basePathOverride?: string
  title?: string
  description?: string
  access?: BranchAccessControl
  createdBy: CanopyUserId
  remoteUrl?: string
}

/**
 * Manages per-branch filesystem workspace: resolves root, ensures metadata,
 * and updates the branch registry.
 */
export class BranchWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  private async ensureGitWorkspace(options: {
    branchRoot: string
    branchName: string
    mode: OperatingMode
    baseBranch: string
    remoteUrl?: string
  }) {
    return log.timed('workspace', 'ensureGitWorkspace', async () => {
      // Serialize access per branch workspace to prevent race conditions
      const existingLock = workspaceInitLocks.get(options.branchRoot)
      if (existingLock) {
        await existingLock
        return
      }

      // Create new lock promise
      const lockPromise = (async () => {
        // The in-memory lock above only serializes within one process. Parallel
        // build workers (separate processes) could otherwise both clone into the
        // same branch workspace ("destination path already exists"), so guard the
        // workspace init with a cross-process lock too. initializeWorkspace is
        // idempotent, so the waiter simply finds the workspace already cloned.
        let releaseLock: (() => Promise<void>) | undefined
        try {
          log.debug('workspace', 'Ensuring git workspace', {
            branchName: options.branchName,
            mode: options.mode,
          })

          releaseLock = await acquireProvisioningLock(
            path.dirname(options.branchRoot),
            `.${path.basename(options.branchRoot)}.init.lock`,
          )

          // Delegate git initialization to GitManager
          await GitManager.initializeWorkspace({
            workspacePath: options.branchRoot,
            branchName: options.branchName,
            mode: options.mode,
            baseBranch: options.baseBranch,
            sourceRoot: this.config.sourceRoot,
            defaultRemoteUrl: this.config.defaultRemoteUrl,
            remoteUrl: options.remoteUrl,
            remoteName: this.config.defaultRemoteName,
            allowNetworkRemoteInProd: this.config.allowNetworkRemoteInProd,
            branchType: 'content',
            gitBotAuthorName: this.config.gitBotAuthorName,
            gitBotAuthorEmail: this.config.gitBotAuthorEmail,
            gitExcludePattern: operatingStrategy(options.mode).getGitExcludePattern(),
          })
        } finally {
          // Release the cross-process lock first, then clear the in-memory lock.
          if (releaseLock) {
            try {
              await releaseLock()
            } catch (err: unknown) {
              log.debug('workspace', 'Failed to release workspace-init lock', { err })
            }
          }
          workspaceInitLocks.delete(options.branchRoot)
        }
      })()

      // Store the lock promise
      workspaceInitLocks.set(options.branchRoot, lockPromise)

      // Wait for initialization to complete
      await lockPromise
    })
  }

  async openOrCreateBranch(options: OpenBranchOptions): Promise<BranchContext> {
    const { branchName, mode, basePathOverride, title, description, access, createdBy, remoteUrl } =
      options
    const {
      branchRoot,
      baseRoot,
      branchName: safeName,
    } = await ensureBranchRoot({
      mode,
      branchName,
      basePathOverride,
    })

    // Resolve the fork point once so the workspace clone and the recorded
    // metadata are guaranteed to agree (config value, or dev-mode git HEAD).
    const baseBranch = await resolveBaseBranch({
      defaultBaseBranch: this.config.defaultBaseBranch,
      mode,
      detectFrom: this.config.sourceRoot
        ? path.resolve(process.cwd(), this.config.sourceRoot)
        : undefined,
    })

    await this.ensureGitWorkspace({
      branchRoot,
      branchName: safeName,
      mode,
      baseBranch,
      remoteUrl,
    })

    // save() handles both creation and updates, preserving existing values and invalidating registry
    const metadata = getBranchMetadataFileManager(branchRoot, baseRoot)
    const meta = await metadata.save({
      branch: {
        name: safeName,
        title,
        description,
        access,
        createdBy,
        baseBranch,
      },
    })

    return {
      branch: meta.branch,
      branchRoot,
      baseRoot,
    }
  }
}

export { loadBranchContext } from './branch-metadata'

/**
 * Load an existing branch context, or create the workspace if it doesn't exist yet.
 *
 * Static deployments skip all git/branch workspace operations and return
 * a synthetic context pointing at the current working directory.
 */
export async function loadOrCreateBranchContext(options: {
  config: CanopyConfig
  branchName: string
  mode: OperatingMode
  basePathOverride?: string
  createdBy: CanopyUserId
  remoteUrl?: string
}): Promise<BranchContext> {
  // Static deployments read content directly from the checkout — no git ops needed
  if (isDeployedStatic(options.config)) {
    const cwd = process.cwd()
    return {
      branch: {
        name: options.branchName,
        status: 'editing',
        access: {},
        createdBy: '__static_deploy__',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      branchRoot: cwd,
      baseRoot: cwd,
    }
  }

  const existing = await loadBranchContext({
    branchName: options.branchName,
    mode: options.mode,
    basePathOverride: options.basePathOverride,
  })
  if (existing) return existing
  const manager = new BranchWorkspaceManager(options.config)
  return manager.openOrCreateBranch({
    branchName: options.branchName,
    mode: options.mode,
    basePathOverride: options.basePathOverride,
    createdBy: options.createdBy,
    remoteUrl: options.remoteUrl,
  })
}
