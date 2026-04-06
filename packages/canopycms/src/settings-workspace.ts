import fs from 'node:fs/promises'
import path from 'node:path'
import type { CanopyConfig } from './config'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'
import { isFileExistsError } from './utils/error'

const log = createDebugLogger({ prefix: 'SettingsWorkspace' })

// In-memory lock to prevent concurrent workspace initialization within the same process.
// Settings only need one lock (not per-branch like content branches).
let settingsInitLock: Promise<void> | null = null

// Stale lock threshold — init should complete well within this window
const LOCK_STALE_MS = 30_000

export interface EnsureSettingsWorkspaceOptions {
  settingsRoot: string
  branchName: string
  mode: OperatingMode
  remoteUrl?: string
}

/**
 * Acquire a file-based lock for cross-process synchronization.
 * Uses O_CREAT|O_EXCL (wx flag) for atomic file creation.
 * Stale locks (older than LOCK_STALE_MS) are cleaned up automatically.
 *
 * Returns true if lock was acquired, false if another process holds it.
 */
async function acquireFileLock(lockPath: string): Promise<boolean> {
  const lockContent = JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })

  await fs.mkdir(path.dirname(lockPath), { recursive: true })

  try {
    const handle = await fs.open(lockPath, 'wx')
    await handle.writeFile(lockContent, 'utf-8')
    await handle.close()
    return true
  } catch (err) {
    if (!isFileExistsError(err)) throw err
  }

  // Lock file exists — check if stale
  try {
    const stat = await fs.stat(lockPath)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs < LOCK_STALE_MS) {
      // Lock is fresh — another process is initializing
      return false
    }

    // Stale lock — another process likely crashed during init
    log.debug('workspace', 'Removing stale settings init lock', { ageMs })
    await fs.unlink(lockPath).catch(() => {})
  } catch {
    // Lock file vanished between check and stat — try again
  }

  // Retry lock acquisition after stale cleanup
  try {
    const handle = await fs.open(lockPath, 'wx')
    await handle.writeFile(lockContent, 'utf-8')
    await handle.close()
    return true
  } catch (retryErr) {
    if (isFileExistsError(retryErr)) return false
    throw retryErr
  }
}

async function releaseFileLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {})
}

/**
 * Manages settings filesystem workspace and git operations.
 *
 * Settings are stored separately from content branches:
 * - prod/dev: Orphan git branches (no shared history with content)
 *
 * Unlike BranchWorkspaceManager, this does not:
 * - Create or manage metadata files
 * - Interact with the branch registry
 * - Check for special cases (settings are always settings)
 *
 * Uses two layers of locking:
 * - In-memory Promise lock for within-process serialization (Lambda request lifecycle)
 * - File-based lock for cross-process synchronization (multiple Lambda instances on EFS)
 */
export class SettingsWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  async ensureGitWorkspace(options: EnsureSettingsWorkspaceOptions): Promise<void> {
    return log.timed('workspace', 'ensureGitWorkspace', async () => {
      // Layer 1: In-memory lock (prevents redundant async calls within same process)
      if (settingsInitLock) {
        await settingsInitLock
        return
      }

      // Create new in-memory lock promise
      settingsInitLock = (async () => {
        try {
          log.debug('workspace', 'Ensuring settings git workspace', {
            branchName: options.branchName,
            mode: options.mode,
          })

          // Layer 2: File-based lock (prevents concurrent init across processes)
          // Lock file is placed OUTSIDE the settings root (as a sibling) so that
          // acquireFileLock's mkdir does not pre-create the settings directory,
          // which would cause git clone to fail ("already exists and is not empty").
          const lockPath = path.join(path.dirname(options.settingsRoot), '.settings-init.lock')
          const acquired = await acquireFileLock(lockPath)

          try {
            // GitManager.initializeWorkspace is idempotent (checks for .git),
            // so it's safe to call even if another process just finished init.
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
              gitBotAuthorName: this.config.gitBotAuthorName,
              gitBotAuthorEmail: this.config.gitBotAuthorEmail,
            })
          } finally {
            if (acquired) {
              await releaseFileLock(lockPath)
            }
          }
        } finally {
          // Always clean up the in-memory lock when done (success or failure)
          settingsInitLock = null
        }
      })()

      // Wait for initialization to complete
      await settingsInitLock
    })
  }
}
