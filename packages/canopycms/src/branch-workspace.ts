import fs from 'node:fs/promises'
import path from 'node:path'

import type { CanopyConfig } from './config'
import { ensureBranchRoot } from './paths'
import { getBranchMetadataFileManager } from './branch-metadata'
import type { BranchAccessControl, BranchContext, CanopyUserId } from './types'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'
import { operatingStrategy } from './operating-mode'

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

  private isSettingsBranch(branchName: string, mode: OperatingMode): boolean {
    const strategy = operatingStrategy(mode)

    // Only relevant for modes that use separate settings branch
    if (!strategy.usesSeparateSettingsBranch()) {
      return false
    }

    // Get the expected settings branch name for this mode
    const settingsBranchName = strategy.getSettingsBranchName(this.config)
    return branchName === settingsBranchName
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

          const baseBranch = this.config.defaultBaseBranch ?? 'main'
          const remoteUrl = await GitManager.resolveRemoteUrl({
            mode: options.mode,
            remoteUrl: options.remoteUrl,
            defaultRemoteUrl: this.config.defaultRemoteUrl,
            baseBranch,
            sourceRoot: this.config.sourceRoot,
          })
          const remoteName = this.config.defaultRemoteName ?? 'origin'
          const authorName = this.config.gitBotAuthorName
          const authorEmail = this.config.gitBotAuthorEmail
          if (!authorName || !authorEmail) {
            throw new Error('CanopyCMS: gitBotAuthorName and gitBotAuthorEmail are required')
          }

          const hasGit = async () => {
            try {
              const stat = await fs.stat(path.join(options.branchRoot, '.git'))
              return stat.isDirectory()
            } catch (err: any) {
              if (err?.code === 'ENOENT') return false
              throw err
            }
          }

          const repoExists = await hasGit()
          if (!repoExists) {
            // Validate workspace requirements based on operating mode
            const strategy = operatingStrategy(options.mode)
            if (strategy.requiresExistingRepo()) {
              await GitManager.validateGitRepoExists(options.branchRoot)
            }

            // If validation passes (no error thrown), we can clone
            if (!remoteUrl) {
              throw new Error(
                'CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to init branch workspaces',
              )
            }
            log.debug('workspace', 'Cloning repository')
            await GitManager.cloneRepo(remoteUrl, options.branchRoot, baseBranch)
            log.debug('workspace', 'Clone complete')
          }

          const git = new GitManager({
            repoPath: options.branchRoot,
            baseBranch,
            remote: remoteName,
          })
          if (remoteUrl) {
            await git.ensureRemote(remoteUrl)
          }
          await git.ensureAuthor({ name: authorName, email: authorEmail })

          // Check if this is a settings branch
          const isSettingsBranch = this.isSettingsBranch(options.branchName, options.mode)

          if (isSettingsBranch) {
            // Create orphan branch with NO initial files
            // Files will be created on-demand by saveInternalGroups/savePathPermissions
            await git.createOrphanSettingsBranch(options.branchName, {})
          } else {
            await git.checkoutBranch(options.branchName)
          }
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

    await this.ensureGitWorkspace({ branchRoot, branchName: safeName, mode, remoteUrl })

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
