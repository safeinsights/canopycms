import fs from 'node:fs/promises'
import path from 'node:path'

import { archivedCutoff, archivedTime, deletableByAge } from '../branch-archive'
import { deleteBranchWorkspace } from '../branch-delete'
import { BranchMetadataCorruptError, BranchMetadataFileManager } from '../branch-metadata'
import { BranchRegistry } from '../branch-registry'
import { isSettingsBranchName, sanitizeBranchName } from '../paths/branch-name'
import type { ArchivedSweepReport, BranchMetadata } from '../types'
import { getErrorMessage, isNotFoundError, sanitizeErrorMessage } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
import { workerLog, workerLogError, workerLogWarn } from './log'
import { holdProvisionedWorkspace, releaseProvisionedWorkspace } from './provisioned-workspace'
import type { WorkerContext } from './worker-context'

export type ArchivedSweepContext = Pick<
  WorkerContext,
  | 'archivedBranchRetentionDays'
  | 'contentBranchesPath'
  | 'ensureSettingsBranch'
  | 'isDraining'
  | 'sanitizedBaseBranch'
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
      // One unreadable directory costs only itself. System health lists a corrupt branch.json.
      if (!(err instanceof BranchMetadataCorruptError)) {
        workerLogWarn(`Skipping ${dirName} in the archived sweep: ${getErrorMessage(err)}`)
      }
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

/**
 * Delete merged, archived branches past `archivedBranchRetentionDays`, oldest first, through the
 * one delete path (branch-delete.ts). Off unless the deployment set that.
 *
 * Each branch is held by its provisioning lock, zero-retry as everywhere in the sync loop, and the
 * selection is decided again under the lock the delete takes, from a fresh read.
 *
 * Takes the editor's copy only: `remoteCopies` in branch-delete.ts says why, and reconcile prunes
 * a head no workspace holds once GitHub drops it (stale-mirror.ts).
 *
 * Never throws, and one branch's failure costs only that branch, which the next cycle retries. A
 * kill past the rename leaves a `.deleting-*` directory `sweepProvisioningLeftovers` clears.
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
    warnings: [],
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
        const outcome = await deleteBranchWorkspace({
          context: {
            baseRoot: ctx.contentBranchesPath,
            branchRoot: path.join(ctx.contentBranchesPath, dirName),
            branch,
          },
          registry,
          stillWanted: (current) => current.name === name && deletableByAge(current, cutoff),
        })
        if (outcome.kind === 'deleted') {
          report.deleted.push(name)
          workerLog(`  Deleted archived branch ${escapeForLog(name)}: past the retention period`)
          if (outcome.cleanupWarning) report.warnings.push(`${name}: ${outcome.cleanupWarning}`)
        } else if (outcome.kind === 'busy') {
          report.failed.push({ branch: name, error: sanitizeErrorMessage(outcome.error) })
        }
      } finally {
        await releaseProvisionedWorkspace(hold.release, dirName)
      }
    } catch (err: unknown) {
      report.failed.push({ branch: name, error: sanitizeErrorMessage(getErrorMessage(err)) })
    }
  }
  for (const { branch, error } of report.failed) {
    workerLogWarn(`  Could not delete archived branch ${escapeForLog(branch)}: ${error}`)
  }
  for (const warning of report.warnings) workerLogWarn(`  ${escapeForLog(warning)}`)
  return report
}
