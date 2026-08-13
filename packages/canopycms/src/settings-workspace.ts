import fs from 'node:fs/promises'
import path from 'node:path'
import type { CanopyConfig } from './config'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'
import { getErrorMessage, isFileExistsError } from './utils/error'
import { RESERVED_SETTINGS_BRANCH_PREFIX } from './paths'

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
/**
 * Whether a settings workspace actually holds settings data yet. Used by the
 * rename guard to tell an already-populated workspace (refuse) apart from a
 * clone that was interrupted before its orphan branch was ever created
 * (harmless — let init finish). File names come from the operating-mode
 * strategy so this stays in step with whatever the mode calls them.
 */
async function settingsFilesPresent(settingsRoot: string): Promise<boolean> {
  const names = ['permissions.json', 'groups.json']
  for (const name of names) {
    try {
      await fs.access(path.join(settingsRoot, name))
      return true
    } catch {
      // Not present — keep checking the rest.
    }
  }
  return false
}

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
            // Rename guard (settings-branch protection). Refuses to boot when
            // an ALREADY-POPULATED settings workspace would be re-orphaned
            // under a different branch name.
            //
            // Trace of what happens without it: GitManager.initializeWorkspace
            // sees an existing .git (no clone happens) and goes straight to
            // createOrphanSettingsBranch(options.branchName). If that name
            // isn't already known, git runs `checkout --orphan <name>` +
            // `rm -rf .` + an empty `--allow-empty` commit — orphan branches
            // share no history, so this isn't a "migration", it PERMANENTLY
            // WIPES permissions.json/groups.json with nothing to recover from.
            // That almost always means deploymentName / settingsBranch /
            // CANOPYCMS_DEPLOYMENT_NAME changed on a live deployment (see
            // resolveDeploymentName in operating-mode/deployment-name.ts).
            //
            // What this deliberately does NOT refuse, and why it matters:
            // initializeWorkspace clones at the BASE branch and only creates
            // the orphan branch several steps later (addConfig, resolveRemoteUrl,
            // ensureRemote come in between). If that first init is interrupted
            // — a Lambda timeout on a slow EFS clone, an OOM, a spot
            // interruption — it leaves a perfectly valid repo sitting on the
            // base branch with NO settings files in it. Refusing on "branch
            // differs" alone would then brick the deployment permanently on
            // every subsequent boot, to protect data that was never written.
            // So the refusal additionally requires evidence that this really
            // is a populated settings workspace: either it is checked out on
            // some OTHER settings branch, or the settings files are actually
            // on disk.
            const repoExists = await GitManager.repoExistsAt(options.settingsRoot)
            // Deliberately NOT gated on `acquired`: when another process holds
            // the init lock, THIS process still proceeds to initializeWorkspace
            // below (pre-existing concurrent-init design), so skipping the
            // guard here would let the un-locked process wipe a populated
            // workspace — concurrent cold starts are routine right after a
            // deploy, which is exactly when a changed deploymentName arrives.
            // Running the guard lock-free cannot false-positive on a
            // legitimate concurrent init: a first-ever init sits on the base
            // branch with no settings files (fires neither arm of the
            // condition below), and a same-name re-init has
            // currentBranch === options.branchName. The only mid-init state
            // that fires is another process initializing a DIFFERENT settings
            // branch name — the rename hazard itself, where firing is correct.
            if (repoExists) {
              let currentBranch: string | undefined
              let readError: string | undefined
              try {
                const existing = new GitManager({ repoPath: options.settingsRoot })
                currentBranch = (await existing.status()).current ?? undefined
              } catch (err) {
                currentBranch = undefined
                readError = getErrorMessage(err)
              }

              const onDifferentBranch = currentBranch !== options.branchName
              const looksLikeSettingsBranch =
                currentBranch !== undefined &&
                currentBranch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
              const hasSettingsData = await settingsFilesPresent(options.settingsRoot)

              if (onDifferentBranch && (looksLikeSettingsBranch || hasSettingsData)) {
                throw new Error(
                  `CanopyCMS: refusing to initialize settings workspace at ${options.settingsRoot}. ` +
                    (currentBranch
                      ? `It is currently on branch '${currentBranch}', but this deployment resolved ` +
                        `settings branch '${options.branchName}'.`
                      : `Its current branch could not be read (${readError ?? 'unknown error'}), but it ` +
                        `holds settings files, and this deployment resolved settings branch ` +
                        `'${options.branchName}'.`) +
                    ` Proceeding would run \`git checkout --orphan\` + \`rm -rf .\` on this workspace, ` +
                    `which PERMANENTLY WIPES permissions.json/groups.json (orphan branches share no ` +
                    `history — there is nothing to migrate from). This almost always means ` +
                    `deploymentName, settingsBranch, or CANOPYCMS_DEPLOYMENT_NAME changed on a ` +
                    `deployment that already has a populated settings workspace. To resolve: restore ` +
                    `the previous value so this resolves back to ` +
                    `'${currentBranch ?? options.branchName}', or, if starting fresh is genuinely ` +
                    `intended, move ${options.settingsRoot} aside manually first.`,
                )
              }
            }

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
              allowNetworkRemoteInProd: this.config.allowNetworkRemoteInProd,
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
