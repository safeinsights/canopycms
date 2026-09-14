import fs from 'node:fs/promises'
import path from 'node:path'
import type { CanopyConfig } from './config'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import { createDebugLogger } from './utils/debug'
import { getErrorMessage } from './utils/error'
import { acquireProvisioningLock } from './utils/provisioning-lock'
import { RESERVED_SETTINGS_BRANCH_PREFIX } from './paths'

const log = createDebugLogger({ prefix: 'SettingsWorkspace' })

// In-memory lock against concurrent init within one process. One lock suffices,
// unlike content branches, which need one per branch.
let settingsInitLock: Promise<void> | null = null

const SETTINGS_INIT_LOCK_DIR = '.settings-init'
const SETTINGS_INIT_LOCK_NAME = 'lock'

/**
 * Directory the cross-process init lock is anchored on — a dedicated sibling of
 * the settings root, NOT the settings root itself.
 *
 * It must not pre-create the settings root: `acquireProvisioningLock` mkdir's
 * its target, and `GitManager.initializeWorkspace` clones INTO the settings
 * root, which `git clone` refuses if anything is already there. A dedicated
 * dot-directory also keeps this marker out of `path.dirname(settingsRoot)`,
 * where `ensureLocalSimulatedRemote` puts `.remote-init.lock` — settings init
 * calls into that while holding this lock, so separate directories make the
 * nesting obvious rather than incidental. For how a lock's anchor path is
 * chosen, see utils/provisioning-lock.ts and docs/concurrency.md.
 * @internal Exported for tests.
 */
export function settingsInitLockTarget(settingsRoot: string): string {
  return path.join(path.dirname(path.resolve(settingsRoot)), SETTINGS_INIT_LOCK_DIR)
}

export interface EnsureSettingsWorkspaceOptions {
  settingsRoot: string
  branchName: string
  mode: OperatingMode
  remoteUrl?: string
}

/**
 * Whether a settings workspace holds settings data yet. The rename guard uses
 * it to tell an already-populated workspace (refuse) from a clone interrupted
 * before its orphan branch existed (harmless — let init finish). File names
 * come from the operating-mode strategy so this stays in step with whatever
 * the mode calls them.
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

/**
 * Rename guard (settings-branch protection): refuse to boot when an
 * ALREADY-POPULATED settings workspace would be re-orphaned under a different
 * branch name.
 *
 * Without it, GitManager.initializeWorkspace sees an existing .git, skips the
 * clone, and calls createOrphanSettingsBranch(branchName); for an unknown name
 * git then runs `checkout --orphan <name>` + `rm -rf .` + an empty commit.
 * Orphan branches share no history, so that is not a migration — it
 * PERMANENTLY WIPES permissions.json/groups.json with nothing to recover from.
 * The trigger is almost always deploymentName / settingsBranch /
 * CANOPYCMS_DEPLOYMENT_NAME changing on a live deployment (see
 * resolveDeploymentName in operating-mode/deployment-name.ts).
 *
 * The refusal therefore needs evidence of a populated workspace — checked out
 * on some OTHER settings branch, or settings files on disk — not just a
 * differing branch name. initializeWorkspace clones at the BASE branch and
 * creates the orphan branch several steps later, so an interrupted first init
 * (Lambda timeout on a slow EFS clone, OOM, spot interruption) leaves a valid
 * repo on the base branch with no settings files, and refusing on name alone
 * would brick that deployment on every boot to protect data never written.
 *
 * NEVER gated on holding the init lock — see its two call sites below.
 */
async function assertSettingsWorkspaceIdentity(
  options: EnsureSettingsWorkspaceOptions,
): Promise<void> {
  const repoExists = await GitManager.repoExistsAt(options.settingsRoot)
  if (!repoExists) return

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
    currentBranch !== undefined && currentBranch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
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

/**
 * The settings filesystem workspace and its git operations. Settings live on an
 * orphan git branch, sharing no history with content, and unlike
 * BranchWorkspaceManager this writes no metadata files and never touches the
 * branch registry.
 *
 * Two locking layers, mirroring BranchWorkspaceManager: an in-memory promise
 * lock within the process, and `acquireProvisioningLock` (proper-lockfile)
 * across processes and hosts.
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

      settingsInitLock = (async () => {
        try {
          log.debug('workspace', 'Ensuring settings git workspace', {
            branchName: options.branchName,
            mode: options.mode,
          })

          // Rename guard, run LOCK-FREE and unconditionally, before any waiting.
          // A deployment whose settings-branch name no longer matches the
          // workspace on disk is misconfigured, not contended, so it must refuse
          // immediately rather than queue behind a live provisioner for minutes.
          // Running it here also means no path reaches initializeWorkspace
          // without the guard having run in THIS process.
          await assertSettingsWorkspaceIdentity(options)

          // Layer 2: cross-process/cross-host lock around the init itself
          // (proper-lockfile: heartbeat-refreshed while the holder lives, so a
          // slow EFS clone is not mistaken for a crash, and patient retries so a
          // loser WAITS instead of racing into a concurrent clone).
          const releaseLock = await acquireProvisioningLock(
            settingsInitLockTarget(options.settingsRoot),
            SETTINGS_INIT_LOCK_NAME,
          )

          try {
            // Re-run the guard on the now-stable state: a previous holder may
            // have created the workspace, or moved it onto its own settings
            // branch, after we sampled it above, and acting on that stale
            // sample is the destructive path the guard exists to stop. Not
            // gated on any "did I win the race" flag — by design there is none;
            // every process here either holds the lock or has already thrown.
            await assertSettingsWorkspaceIdentity(options)

            // initializeWorkspace is idempotent (it checks for .git), so this
            // is safe even if another process just finished init.
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
            try {
              await releaseLock()
            } catch (err: unknown) {
              log.debug('workspace', 'Failed to release settings-init lock', { err })
            }
          }
        } finally {
          settingsInitLock = null
        }
      })()

      await settingsInitLock
    })
  }
}
