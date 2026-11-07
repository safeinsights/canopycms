import fs from 'node:fs/promises'
import path from 'node:path'

import { archivedCutoff, archivedTime, deletableByAge } from '../branch-archive'
import { deleteBranchWorkspace } from '../branch-delete'
import { BranchMetadataCorruptError, BranchMetadataFileManager } from '../branch-metadata'
import { BranchRegistry } from '../branch-registry'
import { isSettingsBranchName, sanitizeBranchName } from '../paths/branch-name'
import { enqueueTask } from '../task-queue/cms-task-queue'
import type { ArchivedSweepReport, BranchContext, BranchMetadata } from '../types'
import { getErrorMessage, isNotFoundError } from '../utils/error'
import { workerLog, workerLogError, workerLogWarn } from './log'
import { holdProvisionedWorkspace, releaseProvisionedWorkspace } from './provisioned-workspace'
import { sharedRepoGit } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

export type ArchivedSweepContext = Pick<
  WorkerContext,
  | 'archivedBranchRetentionDays'
  | 'baseBranch'
  | 'contentBranchesPath'
  | 'ensureSettingsBranch'
  | 'isDraining'
  | 'remoteGitPath'
  | 'sanitizedBaseBranch'
  | 'taskDir'
>

/**
 * The most branches one cycle deletes, oldest first: turning retention on over a long backlog must
 * not hold up the cycle's next git sync. The rest wait for the next cycle.
 * @internal Exported for tests.
 */
export const MAX_ARCHIVED_SWEEP_PER_CYCLE = 25

interface DueBranch {
  dirName: string
  branch: BranchMetadata
}

/** Branches past the cutoff, oldest first. Reads disk: a stale registry must not choose them. */
async function listDueBranches(ctx: ArchivedSweepContext, cutoff: number): Promise<DueBranch[]> {
  const settingsBranch = ctx.ensureSettingsBranch()
  const due: DueBranch[] = []
  const entries = await fs.readdir(ctx.contentBranchesPath, { withFileTypes: true })
  for (const entry of entries) {
    const dirName = entry.name
    if (!entry.isDirectory() || dirName.startsWith('.')) continue
    if (dirName === ctx.sanitizedBaseBranch || isSettingsBranchName(dirName, settingsBranch)) {
      continue
    }
    let branch: BranchMetadata | undefined
    try {
      const metaFile = await BranchMetadataFileManager.loadOnly(
        path.join(ctx.contentBranchesPath, dirName),
      )
      branch = metaFile?.branch
    } catch (err: unknown) {
      // System health lists a corrupt branch.json; what it says can't select a branch here.
      if (!(err instanceof BranchMetadataCorruptError)) throw err
    }
    if (
      branch !== undefined &&
      sanitizeBranchName(branch.name) === dirName &&
      (branch.baseBranch === undefined || sanitizeBranchName(branch.baseBranch) !== dirName) &&
      deletableByAge(branch, cutoff)
    ) {
      due.push({ dirName, branch })
    }
  }
  return due.sort((a, b) => (archivedTime(a.branch) ?? 0) - (archivedTime(b.branch) ?? 0))
}

/** `git update-ref -d` by expected value, so a head a reused name pushed meanwhile stays. */
async function deleteMirrorHead(ctx: ArchivedSweepContext, branch: string): Promise<void> {
  const git = sharedRepoGit(ctx.remoteGitPath, 'bare')
  const ref = `refs/heads/${branch}`
  const sha = (await git.raw(['for-each-ref', '--format=%(objectname)', ref])).trim()
  if (sha !== '') await git.raw(['update-ref', '--no-deref', '-d', ref, sha])
}

/** The API's `syncDeleteRemoteBranch`, queued to this worker: the task guards a reused name. */
async function queueGitHubDelete(
  ctx: ArchivedSweepContext,
  branch: BranchMetadata,
): Promise<string | undefined> {
  const { name, pullRequestNumber, pushedToGitHubAt } = branch
  if (!pullRequestNumber && !pushedToGitHubAt) return undefined
  try {
    await enqueueTask(ctx.taskDir, {
      action: 'delete-remote-branch',
      payload: { branch: name, pullRequestNumber, pushedToGitHubAt },
    })
    return undefined
  } catch (err: unknown) {
    return `Deleting the branch on GitHub could not be queued: ${getErrorMessage(err)}`
  }
}

/**
 * Delete merged, archived branches past `archivedBranchRetentionDays`, oldest first, through the
 * one delete path (branch-delete.ts). Off unless the deployment set that.
 *
 * Each branch is held by its provisioning lock, zero-retry as everywhere in the sync loop, across
 * the rename and the mirror head's delete, so a branch recreated under the name cannot land between
 * them. The selection is decided again under the lock the delete takes, from a fresh read.
 *
 * Never throws, and one branch's failure costs only that branch, which the next cycle retries. A
 * kill past the rename leaves a `.deleting-*` directory `sweepProvisioningLeftovers` clears, a
 * mirror head the name's next create clears, and at worst a GitHub branch.
 */
export async function sweepArchivedBranches(
  ctx: ArchivedSweepContext,
  now = Date.now(),
): Promise<ArchivedSweepReport | undefined> {
  if (ctx.archivedBranchRetentionDays === undefined) return undefined
  const cutoff = archivedCutoff(ctx.archivedBranchRetentionDays, now)

  let due: DueBranch[]
  try {
    due = await listDueBranches(ctx, cutoff)
  } catch (err: unknown) {
    if (!isNotFoundError(err)) {
      workerLogError('Could not list archived branches to sweep:', getErrorMessage(err))
    }
    return undefined
  }
  if (due.length === 0) return undefined

  const report: ArchivedSweepReport = {
    deleted: [],
    skippedLocked: [],
    failed: [],
    deferred: Math.max(0, due.length - MAX_ARCHIVED_SWEEP_PER_CYCLE),
  }
  const registry = new BranchRegistry(ctx.contentBranchesPath)

  for (const { dirName, branch } of due.slice(0, MAX_ARCHIVED_SWEEP_PER_CYCLE)) {
    if (ctx.isDraining()) break
    const { name } = branch
    try {
      const hold = await holdProvisionedWorkspace(ctx.contentBranchesPath, dirName)
      if (hold.kind === 'locked') {
        report.skippedLocked.push(name)
        continue
      }
      if (hold.kind === 'not-provisioned') continue
      try {
        if (hold.isCompromised()) {
          report.skippedLocked.push(name)
          continue
        }
        const context: BranchContext = {
          baseRoot: ctx.contentBranchesPath,
          branchRoot: path.join(ctx.contentBranchesPath, dirName),
          branch,
        }
        const outcome = await deleteBranchWorkspace({
          context,
          baseBranch: branch.baseBranch ?? ctx.baseBranch,
          registry,
          deleteMirrorHead: () => deleteMirrorHead(ctx, name),
          deleteOnGitHub: () => queueGitHubDelete(ctx, branch),
          stillWanted: (current) => current.name === name && deletableByAge(current, cutoff),
        })
        if (outcome.kind === 'deleted') {
          report.deleted.push(name)
          workerLog(`  Deleted archived branch ${name}: past the retention period`)
          if (outcome.cleanupWarning) workerLogWarn(`  ${name}: ${outcome.cleanupWarning}`)
        } else if (outcome.kind === 'busy') {
          report.failed.push({ branch: name, error: outcome.error })
        }
      } finally {
        await releaseProvisionedWorkspace(hold.release, dirName)
      }
    } catch (err: unknown) {
      report.failed.push({ branch: name, error: getErrorMessage(err) })
    }
  }
  for (const { branch, error } of report.failed) {
    workerLogWarn(`  Could not delete archived branch ${branch}: ${error}`)
  }
  return report
}
