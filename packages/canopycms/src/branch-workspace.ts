import fs from 'node:fs/promises'
import path from 'node:path'

import type { CanopyConfig } from './config'
import { BranchPathError, isSettingsBranchName, resolveBranchPath } from './paths'
import { buildInitialBranchMetadata, loadBranchContext } from './branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE, readBranchMetadataFile } from './branch-metadata-file'
import { BranchRegistry } from './branch-registry'
import {
  BranchDirOccupiedError,
  BranchProvisioningBusyError,
  CREATE_RESIDUE_MIN_QUIET_MS,
  classifyFinalDir,
  removeLeftoverDir,
  lockBranchName,
  publishStaging,
  quietAgeMs,
  stageBranchWorkspace,
  type BlockingKind,
} from './branch-provisioning'
import { recordSparseCone, sparseConeFor } from './branch-sparse'
import { readsFromCheckout } from './build-mode'
import { invalidateBranchContentCaches } from './content-index-generation'
import type { BranchAccessControl, BranchContext, CanopyUserId } from './types'
import type { OperatingMode } from './operating-mode'
import { operatingStrategy } from './operating-mode'
import { GitManager, managedWorkspaceConfig } from './git-manager'
import { getErrorMessage } from './utils/error'
import { resolveBaseBranch } from './utils/git'
import { canopyLogWarn } from './utils/logger'
import { OccWriteConflictError, writeOccJsonFile } from './utils/occ-json-write'
import { ProvisionLog } from './utils/provision-log'
import { branchProvisioningLockName, PROVISIONING_LOCK_STALE_MS } from './utils/provisioning-lock'

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
 * `created`: this call published the branch. `exists`: it was already there, or another request
 * published it first; its metadata is returned as found, never merged with this call's.
 */
export interface ProvisionOutcome {
  kind: 'created' | 'exists'
  context: BranchContext
}

/** @internal Test seams around the publish step. */
export interface ProvisioningTestHooks {
  beforePublish?: (paths: { stagingPath: string; finalPath: string }) => Promise<void>
  inspectBlocked?: (finalPath: string) => Promise<BlockingKind>
}

let testHooks: ProvisioningTestHooks = {}

/** @internal Exported for tests; no argument clears them. */
export function setProvisioningTestHooks(hooks: ProvisioningTestHooks = {}): void {
  testHooks = hooks
}

/** One provisioning per branch path per process; a joiner gets the leader's branch as `exists`. */
const provisionsInFlight = new Map<string, Promise<ProvisionOutcome>>()

interface BranchPaths {
  branchRoot: string
  baseRoot: string
  dirName: string
  safeName: string
}

/**
 * Provisions per-branch workspaces under [PROV-1]: a branch's directory appears only by rename,
 * complete with branch.json (branch-provisioning.ts).
 */
export class BranchWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  /** The branch's context, provisioning it first when it does not exist. */
  async openOrCreateBranch(options: OpenBranchOptions): Promise<BranchContext> {
    return (await this.provisionBranch(options)).context
  }

  /**
   * Provision a branch workspace, or report the one already there.
   *
   * @throws BranchProvisioningBusyError when another process is mid-way through this branch, or
   *   what is at its path is too fresh to judge (retriable)
   * @throws BranchDirOccupiedError in prod, when its path holds a repository this deployment did
   *   not create
   * @throws BranchMetadataCorruptError when its branch.json does not parse
   */
  async provisionBranch(options: OpenBranchOptions): Promise<ProvisionOutcome> {
    // resolveBranchPath refuses the reserved prefix; this also refuses an adopter's
    // configured settings branch name, which only the config knows.
    if (
      isSettingsBranchName(
        options.branchName,
        operatingStrategy(options.mode).getSettingsBranchName(this.config),
      )
    ) {
      throw new BranchPathError('Settings branches are not content branches')
    }
    const { branchRoot, baseRoot, branchName: safeName } = resolveBranchPath(options)
    const paths: BranchPaths = {
      branchRoot,
      baseRoot,
      dirName: path.basename(branchRoot),
      safeName,
    }

    const existing = await readBranchMetadataFile(branchRoot)
    if (existing) {
      return { kind: 'exists', context: { branch: existing.branch, branchRoot, baseRoot } }
    }

    const inFlight = provisionsInFlight.get(branchRoot)
    if (inFlight) return { kind: 'exists', context: (await inFlight).context }

    const run = this.provisionUnshared(options, paths)
    provisionsInFlight.set(branchRoot, run)
    try {
      return await run
    } finally {
      provisionsInFlight.delete(branchRoot)
    }
  }

  private async provisionUnshared(
    options: OpenBranchOptions,
    paths: BranchPaths,
  ): Promise<ProvisionOutcome> {
    const { branchRoot, baseRoot, dirName } = paths
    await fs.mkdir(baseRoot, { recursive: true })

    // Resolve the fork point once so the clone and the recorded metadata agree (config value, or
    // dev-mode git HEAD), and the remote before any clone is paid for.
    const baseBranch = await resolveBaseBranch({
      defaultBaseBranch: this.config.defaultBaseBranch,
      mode: options.mode,
      detectFrom: this.config.sourceRoot
        ? path.resolve(process.cwd(), this.config.sourceRoot)
        : undefined,
    })
    const remoteUrl = await GitManager.resolveCloneRemoteUrl({
      mode: options.mode,
      remoteUrl: options.remoteUrl,
      defaultRemoteUrl: this.config.defaultRemoteUrl,
      baseBranch,
      sourceRoot: this.config.sourceRoot,
      allowNetworkRemoteInProd: this.config.allowNetworkRemoteInProd,
    })
    const metadata = buildInitialBranchMetadata({
      branch: {
        name: paths.safeName,
        title: options.title,
        description: options.description,
        access: options.access,
        createdBy: options.createdBy,
        baseBranch,
      },
    })

    // Advisory and lock-free: refuse early, before paying for a clone, what publish would
    // refuse anyway. Publish re-checks everything under the lock.
    const state = await classifyFinalDir(branchRoot, remoteUrl)
    if (state.kind === 'live' || state.kind === 'corrupt') return this.existing(paths)
    if (state.kind === 'protected') throw new BranchProvisioningBusyError(dirName)
    if (state.kind === 'foreign') {
      // dev's CLI sync builds a branch workspace by `git init` and real commits, with no
      // remote and no branch.json; it is adopted where it is.
      if (options.mode !== 'dev') throw new BranchDirOccupiedError(dirName)
      return this.adoptInPlace(options, paths, baseBranch, metadata)
    }
    if (state.kind === 'residue' && (await this.recentlyActive(paths))) {
      throw new BranchProvisioningBusyError(dirName)
    }

    const sparseCone = sparseConeFor(this.config.contentRoot)
    await recordSparseCone(baseRoot, sparseCone).catch((err: unknown) => {
      canopyLogWarn(`[canopy] Could not record the sparse-checkout cone: ${getErrorMessage(err)}`)
    })

    const provisionLog = new ProvisionLog(dirName)
    let outcome: ProvisionOutcome
    try {
      outcome = await this.stageAndPublish(paths, {
        provisionLog,
        baseBranch,
        remoteUrl,
        metadata,
        mode: options.mode,
        sparseCone,
      })
    } catch (err) {
      provisionLog.finish('error')
      throw err
    }
    provisionLog.finish(outcome.kind === 'created' ? 'ok' : 'exists')
    return outcome
  }

  private async stageAndPublish(
    paths: BranchPaths,
    run: {
      provisionLog: ProvisionLog
      baseBranch: string
      remoteUrl: string
      metadata: ReturnType<typeof buildInitialBranchMetadata>
      mode: OperatingMode
      sparseCone: string[] | null
    },
  ): Promise<ProvisionOutcome> {
    const { branchRoot, baseRoot, dirName } = paths
    const staged = await stageBranchWorkspace({
      baseRoot,
      dirName,
      branchName: paths.safeName,
      baseBranch: run.baseBranch,
      remoteUrl: run.remoteUrl,
      clone: {
        remoteName: this.config.defaultRemoteName,
        config: managedWorkspaceConfig(this.config.gitBotAuthorName, this.config.gitBotAuthorEmail),
      },
      gitExcludePattern: operatingStrategy(run.mode).getGitExcludePattern(),
      metadata: run.metadata,
      provisionLog: run.provisionLog,
      sparseCone: run.sparseCone,
    })
    if (staged.kind === 'exists') return this.existing(paths)

    let published: 'published' | 'exists' | undefined
    try {
      await testHooks.beforePublish?.({ stagingPath: staged.stagingPath, finalPath: branchRoot })
      published = await run.provisionLog.step('publish', () =>
        publishStaging({
          baseRoot,
          dirName,
          stagingPath: staged.stagingPath,
          writeId: staged.meta.writeId,
          expectedRemoteUrl: run.remoteUrl,
          inspectBlocked: testHooks.inspectBlocked,
        }),
      )
    } finally {
      if (published !== 'published') await removeLeftoverDir(staged.stagingPath)
    }
    if (published === 'exists') return this.existing(paths)

    await run.provisionLog.step('register', () => register(paths))
    return { kind: 'created', context: { branch: staged.meta.branch, branchRoot, baseRoot } }
  }

  /**
   * The one exception to [PROV-1]: a dev workspace that already holds real work is kept where it
   * is, given branch.json under the branch's lock.
   */
  private async adoptInPlace(
    options: OpenBranchOptions,
    paths: BranchPaths,
    baseBranch: string,
    metadata: ReturnType<typeof buildInitialBranchMetadata>,
  ): Promise<ProvisionOutcome> {
    const { branchRoot, baseRoot, dirName } = paths
    const provisionLog = new ProvisionLog(dirName)
    let created = false
    try {
      const release = await provisionLog.step('lock', () => lockBranchName(baseRoot, dirName))
      try {
        if (!(await readBranchMetadataFile(branchRoot))) {
          await GitManager.initializeWorkspace({
            workspacePath: branchRoot,
            branchName: paths.safeName,
            mode: options.mode,
            baseBranch,
            sourceRoot: this.config.sourceRoot,
            defaultRemoteUrl: this.config.defaultRemoteUrl,
            remoteUrl: options.remoteUrl,
            remoteName: this.config.defaultRemoteName,
            allowNetworkRemoteInProd: this.config.allowNetworkRemoteInProd,
            branchType: 'content',
            gitBotAuthorName: this.config.gitBotAuthorName,
            gitBotAuthorEmail: this.config.gitBotAuthorEmail,
            gitExcludePattern: operatingStrategy(options.mode).getGitExcludePattern(),
            provisionLog,
          })
          created = await provisionLog.step('metadata', () =>
            writeOccJsonFile(
              path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE),
              { ...metadata },
              { expectedVersion: null, trailingNewline: true },
            ).then(
              () => true,
              (err: unknown) => {
                if (err instanceof OccWriteConflictError) return false
                throw err
              },
            ),
          )
        }
      } finally {
        await release().catch(() => {})
      }
      if (created) await provisionLog.step('register', () => register(paths))
    } catch (err) {
      provisionLog.finish('error')
      throw err
    }
    provisionLog.finish(created ? 'ok' : 'exists')
    if (!created) return this.existing(paths)
    const meta = await readBranchMetadataFile(branchRoot)
    if (!meta) throw new BranchProvisioningBusyError(dirName)
    return { kind: 'created', context: { branch: meta.branch, branchRoot, baseRoot } }
  }

  /** Whether residue at the branch path may still belong to a live process. */
  private async recentlyActive({ branchRoot, baseRoot, dirName }: BranchPaths): Promise<boolean> {
    const lockAgeMs = await fs.stat(path.join(baseRoot, branchProvisioningLockName(dirName))).then(
      (stat) => Date.now() - stat.mtimeMs,
      () => Infinity,
    )
    if (lockAgeMs < PROVISIONING_LOCK_STALE_MS) return true
    return (await quietAgeMs(branchRoot)) < CREATE_RESIDUE_MIN_QUIET_MS
  }

  private async existing({
    branchRoot,
    baseRoot,
    dirName,
  }: BranchPaths): Promise<ProvisionOutcome> {
    const meta = await readBranchMetadataFile(branchRoot)
    if (!meta) throw new BranchProvisioningBusyError(dirName)
    return { kind: 'exists', context: { branch: meta.branch, branchRoot, baseRoot } }
  }
}

/**
 * A new branch directory replaces whatever an earlier one of the same name left in this
 * process's caches, and joins the registry. The branch is already published, so a failure here
 * is logged rather than failing the create; the registry's miss backstop covers it.
 */
async function register({ branchRoot, baseRoot }: BranchPaths): Promise<void> {
  try {
    await invalidateBranchContentCaches(branchRoot)
    await new BranchRegistry(baseRoot).invalidate()
  } catch (err: unknown) {
    canopyLogWarn(`[canopy] Registering new branch ${branchRoot} failed: ${getErrorMessage(err)}`)
  }
}

export { loadBranchContext } from './branch-metadata'

/**
 * Load an existing branch context, provisioning the workspace if there is none.
 *
 * When content is read from the checkout (`readsFromCheckout`: a static
 * deployment, or any build) this skips every git and branch-workspace operation
 * and returns a synthetic context rooted at the current working directory,
 * where `branchName` is echoed back but selects nothing.
 */
export async function loadOrCreateBranchContext(options: {
  config: CanopyConfig
  branchName: string
  mode: OperatingMode
  basePathOverride?: string
  createdBy: CanopyUserId
  remoteUrl?: string
}): Promise<BranchContext> {
  // Static deployments and builds read content directly from the checkout — no git ops
  if (readsFromCheckout(options.config)) {
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
