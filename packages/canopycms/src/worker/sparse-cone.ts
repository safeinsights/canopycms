import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

import { readRecordedSparseCone, sameCone } from '../branch-sparse'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { getErrorMessage, isNodeError } from '../utils/error'
import { isRebaseInProgress } from '../utils/git'
import { workerLog, workerLogWarn } from './log'
import { holdProvisionedWorkspace, releaseProvisionedWorkspace } from './provisioned-workspace'

export interface SparseConeReport {
  reapplied: string[]
  failed: { branch: string; error: string }[]
}

/** A clone's cone directories, or null when it is not sparse (or cannot be read). */
async function currentCone(git: SimpleGit): Promise<string[] | null> {
  try {
    const listed = (await git.raw(['sparse-checkout', 'list'])).trim()
    return listed ? listed.split('\n') : null
  } catch {
    return null
  }
}

/**
 * Move each provisioned sparse clone to the cone the deployment's config now asks for, as
 * recorded beside the branch directories by the Lambda (branch-sparse.ts): a changed content
 * root would otherwise leave every existing clone without its content. A full clone stays
 * full. Best-effort per clone, like [SYNC-M2].
 *
 * The cone is compared without a lock, and changed only under the clone's provisioning lock
 * and content-write lock, both zero-retry, outside a rebase: `sparse-checkout set` rewrites the
 * working tree. A clone that is busy is retried next cycle.
 */
export async function reapplySparseCones(ctx: {
  contentBranchesPath: string
}): Promise<SparseConeReport> {
  const report: SparseConeReport = { reapplied: [], failed: [] }
  const recorded = await readRecordedSparseCone(ctx.contentBranchesPath)
  if (!recorded) return report

  let entries: Dirent[]
  try {
    entries = await fs.readdir(ctx.contentBranchesPath, { withFileTypes: true })
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return report
    throw err
  }
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
  for (const dirName of dirNames) {
    const branchPath = path.join(ctx.contentBranchesPath, dirName)
    // Without its own .git, git would answer for a repository above the branches root.
    const isClone = await fs.stat(path.join(branchPath, '.git')).then(
      (stat) => stat.isDirectory(),
      () => false,
    )
    if (!isClone) continue
    const git = simpleGit({ baseDir: branchPath })
    const cone = await currentCone(git)
    if (cone === null || sameCone(cone, recorded.cone)) continue
    try {
      if (await reapplyOne(ctx.contentBranchesPath, dirName, git, recorded.cone)) {
        workerLog(
          `  ${dirName}: sparse-checkout cone ${[...cone].sort().join(',')} -> ` +
            (recorded.cone ? [...recorded.cone].sort().join(',') : 'full checkout'),
        )
        report.reapplied.push(dirName)
      }
    } catch (err: unknown) {
      const error = getErrorMessage(err)
      workerLogWarn(`  ${dirName}: could not change the sparse-checkout cone: ${error}`)
      report.failed.push({ branch: dirName, error })
    }
  }
  return report
}

/** Apply `target` under both locks; false when the clone is busy or no longer differs. */
async function reapplyOne(
  contentBranchesPath: string,
  dirName: string,
  git: SimpleGit,
  target: string[] | null,
): Promise<boolean> {
  const branchPath = path.join(contentBranchesPath, dirName)
  const hold = await holdProvisionedWorkspace(contentBranchesPath, dirName)
  if (hold.kind !== 'held') return false
  try {
    let releaseContent: () => Promise<void>
    let contentLost = false
    try {
      releaseContent = await tryAcquireContentWriteLock(branchPath, () => {
        contentLost = true
      })
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ELOCKED') return false
      throw err
    }
    try {
      if (await isRebaseInProgress(branchPath)) return false
      const cone = await currentCone(git)
      if (cone === null || sameCone(cone, target)) return false
      if (hold.isCompromised() || contentLost) return false
      try {
        await git.raw(
          target
            ? ['sparse-checkout', 'set', '--cone', '--', ...target]
            : ['sparse-checkout', 'disable'],
        )
      } finally {
        await invalidateBranchContentCaches(branchPath)
      }
      return true
    } finally {
      await releaseContent().catch(() => {})
    }
  } finally {
    await releaseProvisionedWorkspace(hold.release, dirName)
  }
}
