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

// In-memory lock to prevent concurrent workspace initialization within the same process.
// Settings only need one lock (not per-branch like content branches).
let settingsInitLock: Promise<void> | null = null

const SETTINGS_INIT_LOCK_DIR = '.settings-init'
const SETTINGS_INIT_LOCK_NAME = 'lock'

/**
 * Directory the cross-process init lock is anchored on — a dedicated sibling of
 * the settings root, and NOT the settings root itself.
 *
 * Two properties this name has to satisfy:
 *
 * 1. **It must not pre-create the settings root.** `acquireProvisioningLock`
 *    mkdir's its target, and `GitManager.initializeWorkspace` clones INTO the
 *    settings root — `git clone` refuses a destination that already has content
 *    in it. So the lock lives beside the settings root, never inside it.
 * 2. **Its marker must not collide with another lock's marker.** Since
 *    2026-08-20 `acquireProvisioningLock` anchors proper-lockfile on the lock
 *    MARKER's own path rather than on the directory holding it, so its
 *    in-process registry key is the on-disk lock identity and two live locks
 *    can no longer clobber each other's bookkeeping (see docs/concurrency.md,
 *    "Anchor path matters"). A dedicated dot-directory is still the right home
 *    for this marker: `path.dirname(settingsRoot)` is where
 *    `ensureLocalSimulatedRemote` puts `.remote-init.lock`, and settings init
 *    calls into it while holding this lock, so keeping the two markers in
 *    separate directories keeps that nesting obvious rather than incidental.
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

/**
 * Rename guard (settings-branch protection). Refuses to boot when an
 * ALREADY-POPULATED settings workspace would be re-orphaned under a different
 * branch name.
 *
 * Trace of what happens without it: GitManager.initializeWorkspace sees an
 * existing .git (no clone happens) and goes straight to
 * createOrphanSettingsBranch(branchName). If that name isn't already known, git
 * runs `checkout --orphan <name>` + `rm -rf .` + an empty `--allow-empty`
 * commit — orphan branches share no history, so this isn't a "migration", it
 * PERMANENTLY WIPES permissions.json/groups.json with nothing to recover from.
 * That almost always means deploymentName / settingsBranch /
 * CANOPYCMS_DEPLOYMENT_NAME changed on a live deployment (see
 * resolveDeploymentName in operating-mode/deployment-name.ts).
 *
 * What this deliberately does NOT refuse, and why it matters:
 * initializeWorkspace clones at the BASE branch and only creates the orphan
 * branch several steps later (addConfig, resolveRemoteUrl, ensureRemote come in
 * between). If that first init is interrupted — a Lambda timeout on a slow EFS
 * clone, an OOM, a spot interruption — it leaves a perfectly valid repo sitting
 * on the base branch with NO settings files in it. Refusing on "branch differs"
 * alone would then brick the deployment permanently on every subsequent boot, to
 * protect data that was never written. So the refusal additionally requires
 * evidence that this really is a populated settings workspace: either it is
 * checked out on some OTHER settings branch, or the settings files are actually
 * on disk.
 *
 * This function is NEVER gated on holding the init lock — see its two call
 * sites in ensureGitWorkspace and the comment there.
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
 * Uses two layers of locking, mirroring BranchWorkspaceManager:
 * - In-memory Promise lock for within-process serialization (Lambda request lifecycle)
 * - `acquireProvisioningLock` (proper-lockfile) for cross-process/cross-host
 *   synchronization of the init itself (multiple Lambda containers on EFS)
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

          // Rename guard, run LOCK-FREE and unconditionally, before any waiting.
          // A deployment whose settings-branch name no longer matches the
          // workspace on disk is misconfigured, not contended: it must refuse
          // immediately rather than queue behind a live provisioner for what can
          // be minutes. Running it here also keeps the guarantee the guard has
          // always had — no code path reaches initializeWorkspace without it
          // having run in THIS process.
          await assertSettingsWorkspaceIdentity(options)

          // Layer 2: cross-process/cross-host lock around the init itself
          // (proper-lockfile: heartbeat-refreshed while the holder lives, so a
          // slow EFS clone is not mistaken for a crash, and patient retries so a
          // loser WAITS instead of racing into a concurrent clone).
          //
          // This replaced a bespoke O_CREAT|O_EXCL + 30s-mtime scheme whose
          // return value was only ever used to decide whether to release: the
          // loser proceeded into initializeWorkspace anyway, concurrently with
          // the holder, where it could see a half-written .git, classify it
          // corrupt, and `rm -rf` it out from under the in-flight clone.
          const releaseLock = await acquireProvisioningLock(
            settingsInitLockTarget(options.settingsRoot),
            SETTINGS_INIT_LOCK_NAME,
          )

          try {
            // Re-run the guard on the now-stable state. If we waited above, the
            // previous holder may have created the workspace (or moved it onto
            // its own settings branch) after we sampled it, and acting on that
            // stale sample is exactly the destructive path the guard exists to
            // stop. Still not gated on any "did I win the race" flag — there is
            // no such flag by design; every process either holds the lock here
            // or has already thrown.
            await assertSettingsWorkspaceIdentity(options)

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
            try {
              await releaseLock()
            } catch (err: unknown) {
              log.debug('workspace', 'Failed to release settings-init lock', { err })
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
