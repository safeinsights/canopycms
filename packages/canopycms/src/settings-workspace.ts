import type { CanopyConfig } from './config'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'

const log = createDebugLogger({ prefix: 'SettingsWorkspace' })

// In-memory lock to prevent concurrent workspace initialization
// Settings only need one lock (not per-branch like content branches)
let settingsInitLock: Promise<void> | null = null

export interface EnsureSettingsWorkspaceOptions {
  settingsRoot: string
  branchName: string
  mode: OperatingMode
  remoteUrl?: string
}

/**
 * Manages settings filesystem workspace and git operations.
 *
 * Settings are stored separately from content branches:
 * - prod/prod-sim: Orphan git branches (no shared history with content)
 * - dev: Regular directory (no git)
 *
 * Unlike BranchWorkspaceManager, this does not:
 * - Create or manage metadata files
 * - Interact with the branch registry
 * - Check for special cases (settings are always settings)
 */
export class SettingsWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  async ensureGitWorkspace(options: EnsureSettingsWorkspaceOptions): Promise<void> {
    return log.timed('workspace', 'ensureGitWorkspace', async () => {
      // Serialize access to prevent race conditions
      if (settingsInitLock) {
        await settingsInitLock
        return
      }

      // Create new lock promise
      settingsInitLock = (async () => {
        try {
          log.debug('workspace', 'Ensuring settings git workspace', {
            branchName: options.branchName,
            mode: options.mode,
          })

          // Delegate git initialization to GitManager
          await GitManager.initializeWorkspace({
            workspacePath: options.settingsRoot,
            branchName: options.branchName,
            mode: options.mode,
            baseBranch: this.config.defaultBaseBranch,
            sourceRoot: this.config.sourceRoot,
            defaultRemoteUrl: this.config.defaultRemoteUrl,
            remoteUrl: options.remoteUrl,
            remoteName: this.config.defaultRemoteName,
            branchType: 'orphan', // Key difference: orphan branch for settings
          })
        } finally {
          // Always clean up the lock when done (success or failure)
          settingsInitLock = null
        }
      })()

      // Wait for initialization to complete
      await settingsInitLock
    })
  }
}
