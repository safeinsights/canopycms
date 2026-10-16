import fs from 'node:fs/promises'
import path from 'node:path'
import type { CanopyConfig } from './config'
import type { OperatingMode } from './operating-mode'
import { GitManager } from './git-manager'
import {
  removeLeftoverDir,
  settingsStagingDirName,
  settingsTrashDirName,
} from './branch-provisioning'
import { createDebugLogger } from './utils/debug'
import { getErrorMessage, isNodeError } from './utils/error'
import { canopyLogWarn } from './utils/logger'
import { ProvisionLog } from './utils/provision-log'
import { acquireProvisioningLock } from './utils/provisioning-lock'
import { RESERVED_SETTINGS_BRANCH_PREFIX } from './paths'

const log = createDebugLogger({ prefix: 'SettingsWorkspace' })

// In-memory lock against concurrent init within one process. One lock suffices,
// unlike content branches, which need one per branch.
let settingsInitLock: Promise<void> | null = null

/**
 * Settings workspaces this process has fully ensured, keyed by {@link ensuredKey}. A hit
 * skips the guard, the init lock and initializeWorkspace's dozen git subprocesses, which
 * otherwise ran on every API request. It is sound because settings freshness never comes from
 * that pass: it reads the remote only to provision the settings branch or repair an empty one
 * (GitManager.createOrphanSettingsBranch), saves pull, and every process reads the one shared
 * workspace. Everything it verified is fixed for the process: the settings-branch name resolves once
 * from config, the remote URL comes from config, and nothing in CanopyCMS checks the settings
 * workspace out onto another branch. groups.json and permissions.json are still read from
 * disk on every request; only the provisioning is memoized. Failures are never recorded. In
 * dev, a hit also skips re-seeding a deleted `.canopy-dev/remote.git`; a dev-server restart
 * re-seeds it.
 *
 * A hit still reads `.git/HEAD`, so a workspace removed, re-cloned onto another branch, or
 * caught mid-clone by another process (HEAD still on the base branch) misses and runs the full
 * path, guard and lock included.
 */
const ensuredSettingsWorkspaces = new Set<string>()

function ensuredKey(options: EnsureSettingsWorkspaceOptions): string {
  return `${path.resolve(options.settingsRoot)}\0${options.branchName}`
}

async function headBranch(settingsRoot: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(path.join(settingsRoot, '.git', 'HEAD'), 'utf-8')).trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined
  } catch {
    return undefined
  }
}

async function checkedOutOn(settingsRoot: string, branchName: string): Promise<boolean> {
  return (await headBranch(settingsRoot)) === branchName
}

async function hasLocalBranch(settingsRoot: string, branchName: string): Promise<boolean> {
  const gitDir = path.join(settingsRoot, '.git')
  try {
    await fs.access(path.join(gitDir, 'refs', 'heads', branchName))
    return true
  } catch {
    const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf-8').catch(() => '')
    return packed.split('\n').some((line) => line.endsWith(` refs/heads/${branchName}`))
  }
}

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
 * where `ensureLocalSimulatedRemote` puts `.remote-init.lock` — an in-place
 * settings re-init calls into that while holding this lock, so separate directories make the
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
 * What occupies the settings root.
 *
 * `interrupted` is a first init that died before its settings branch existed: not on this
 * deployment's settings branch or any `canopycms-settings-*` one, no local ref for it, and no
 * settings files -- what the rename guard lets through, minus a local settings branch that could
 * hold unpushed commits. A clone killed in place leaves this behind, often with a stale
 * `config.lock` that fails every later git config write.
 */
async function settingsRootState(
  options: EnsureSettingsWorkspaceOptions,
): Promise<'vacant' | 'in-use' | 'interrupted'> {
  let entries: string[]
  try {
    entries = await fs.readdir(options.settingsRoot)
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return 'vacant'
    if (isNodeError(err) && err.code === 'ENOTDIR') return 'interrupted'
    throw err
  }
  if (entries.length === 0) return 'vacant'
  if (await settingsFilesPresent(options.settingsRoot)) return 'in-use'
  if (!(await GitManager.repoExistsAt(options.settingsRoot))) return 'interrupted'
  const head = await headBranch(options.settingsRoot)
  if (head === options.branchName || head?.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)) {
    return 'in-use'
  }
  if (await hasLocalBranch(options.settingsRoot, options.branchName)) return 'in-use'
  return 'interrupted'
}

/**
 * Rename guard (settings-branch protection): refuse to boot when an
 * ALREADY-POPULATED settings workspace would be re-orphaned under a different
 * branch name.
 *
 * Without it, GitManager.initializeWorkspace sees an existing .git, skips the
 * clone, and calls createOrphanSettingsBranch(branchName); for a name neither the
 * workspace nor its remote has, git then runs `checkout --orphan <name>` + `rm -rf .` + an empty commit.
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
        `'${currentBranch ?? options.branchName}', or, if switching is genuinely intended, ` +
        `move ${options.settingsRoot} aside manually first: the next start checks out ` +
        `'${options.branchName}' from the remote, or starts it empty if the remote has none.`,
    )
  }
}

/**
 * The settings filesystem workspace and its git operations. Settings live on an
 * orphan git branch, sharing no history with content, and unlike
 * BranchWorkspaceManager this writes no metadata files and never touches the
 * branch registry.
 *
 * A first clone follows [PROV-1] (branch-provisioning.ts): it is built in a
 * staging sibling and renamed into place, so a process killed mid-clone never
 * leaves a half-made workspace at the settings root. Never sparse: the orphan
 * init's `git rm -rf .` would leave out-of-cone base files in the tree.
 *
 * Two locking layers, mirroring BranchWorkspaceManager: an in-memory promise
 * lock within the process, and `acquireProvisioningLock` (proper-lockfile)
 * across processes and hosts around the publish and every in-place init.
 */
export class SettingsWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  async ensureGitWorkspace(options: EnsureSettingsWorkspaceOptions): Promise<void> {
    const key = ensuredKey(options)
    if (ensuredSettingsWorkspaces.has(key)) {
      if (await checkedOutOn(options.settingsRoot, options.branchName)) return
      ensuredSettingsWorkspaces.delete(key)
    }

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

          if (
            (await settingsRootState(options)) !== 'in-use' ||
            !(await this.ensureInPlace(options))
          ) {
            await this.provisionStaged(options)
          }
          ensuredSettingsWorkspaces.add(key)
        } finally {
          settingsInitLock = null
        }
      })()

      await settingsInitLock
    })
  }

  private initOptions(options: EnsureSettingsWorkspaceOptions, workspacePath: string) {
    return {
      workspacePath,
      branchName: options.branchName,
      mode: options.mode,
      baseBranch: this.config.defaultBaseBranch,
      sourceRoot: this.config.sourceRoot,
      defaultRemoteUrl: this.config.defaultRemoteUrl,
      remoteUrl: options.remoteUrl,
      remoteName: this.config.defaultRemoteName,
      allowNetworkRemoteInProd: this.config.allowNetworkRemoteInProd,
      branchType: 'orphan' as const,
      gitBotAuthorName: this.config.gitBotAuthorName,
      gitBotAuthorEmail: this.config.gitBotAuthorEmail,
    }
  }

  /**
   * Layer 2 around the init itself (proper-lockfile: heartbeat-refreshed while the holder lives,
   * so a slow EFS operation is not mistaken for a crash, and patient retries so a loser WAITS
   * instead of racing into a concurrent init).
   */
  private async withInitLock<T>(
    options: EnsureSettingsWorkspaceOptions,
    run: () => Promise<T>,
  ): Promise<T> {
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
      return await run()
    } finally {
      try {
        await releaseLock()
      } catch (err: unknown) {
        log.debug('workspace', 'Failed to release settings-init lock', { err })
      }
    }
  }

  /** Re-init an existing workspace where it is; false when, under the lock, there is none. */
  private async ensureInPlace(options: EnsureSettingsWorkspaceOptions): Promise<boolean> {
    return this.withInitLock(options, async () => {
      if ((await settingsRootState(options)) !== 'in-use') return false
      await GitManager.initializeWorkspace(this.initOptions(options, options.settingsRoot))
      return true
    })
  }

  /**
   * Clone and set up the settings branch in a staging sibling, then publish it under the init
   * lock, moving an interrupted first init aside to `.trash-settings-*`. A workspace someone
   * else published meanwhile wins and the staging copy is dropped.
   */
  private async provisionStaged(options: EnsureSettingsWorkspaceOptions): Promise<void> {
    const settingsRoot = path.resolve(options.settingsRoot)
    const workspaceRoot = path.dirname(settingsRoot)
    await fs.mkdir(workspaceRoot, { recursive: true })
    const stagingPath = path.join(workspaceRoot, settingsStagingDirName())
    const provisionLog = new ProvisionLog('settings')
    let published = false
    try {
      await GitManager.initializeWorkspace({
        ...this.initOptions(options, stagingPath),
        provisionLog,
      })
      published = await provisionLog.step('publish', () =>
        this.withInitLock(options, async () => {
          const state = await settingsRootState(options)
          if (state === 'in-use') return false
          if (state === 'interrupted') {
            const trashName = settingsTrashDirName()
            await fs.rename(settingsRoot, path.join(workspaceRoot, trashName))
            canopyLogWarn(
              `[canopy] Moved an unfinished settings workspace clone aside as ${trashName}`,
            )
          }
          await fs.rename(stagingPath, settingsRoot)
          return true
        }),
      )
    } catch (err) {
      provisionLog.finish('error')
      throw err
    } finally {
      if (!published) await removeLeftoverDir(stagingPath)
    }
    provisionLog.finish(published ? 'ok' : 'exists')
  }
}
