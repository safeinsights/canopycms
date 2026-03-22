import type { CanopyConfig } from './config'
import { ensureBranchRoot } from './paths'
import { getBranchMetadataFileManager } from './branch-metadata'
import type { BranchAccessControl, BranchContext, CanopyUserId } from './types'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'

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
        try {
          log.debug('workspace', 'Ensuring git workspace', {
            branchName: options.branchName,
            mode: options.mode,
          })

          // Delegate git initialization to GitManager
          await GitManager.initializeWorkspace({
            workspacePath: options.branchRoot,
            branchName: options.branchName,
            mode: options.mode,
            baseBranch: this.config.defaultBaseBranch,
            sourceRoot: this.config.sourceRoot,
            defaultRemoteUrl: this.config.defaultRemoteUrl,
            remoteUrl: options.remoteUrl,
            remoteName: this.config.defaultRemoteName,
            branchType: 'content',
          })
        } finally {
          // Always clean up the lock when done (success or failure)
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

    await this.ensureGitWorkspace({
      branchRoot,
      branchName: safeName,
      mode,
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
