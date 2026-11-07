import fs from 'node:fs/promises'
import path from 'node:path'

import { BRANCH_META_DIR, BRANCH_META_FILE, readBranchMetadataFile } from './branch-metadata-file'
import { deletingDirName, removeLeftoverDir } from './branch-provisioning'
import type { BranchRegistry } from './branch-registry'
import { RESERVED_SETTINGS_BRANCH_PREFIX, sanitizeBranchName } from './paths/branch-name'
import type { BranchContext, BranchMetadata } from './types'
import { getErrorMessage, isNotFoundError, sanitizeErrorMessage } from './utils/error'
import { filePathExists } from './utils/fs'
import { withOccFileLock } from './utils/occ-json-write'

export interface DeleteBranchWorkspaceOptions {
  context: Pick<BranchContext, 'branch' | 'branchRoot' | 'baseRoot'>
  /** The branch it forked from, or the deployment's base branch. */
  baseBranch: string
  registry: Pick<BranchRegistry, 'invalidate'>
  /** Removes the branch's head from `remote.git`; a failure costs a warning, not the delete. */
  deleteMirrorHead: () => Promise<void>
  /** Deletes or queues deleting the branch on GitHub, resolving a warning if that failed. */
  deleteOnGitHub: () => Promise<string | undefined>
  /**
   * Re-decides from a fresh read inside the lock every save() takes, so a change before the rename
   * keeps the branch and one after it fails. For a caller that chose the branch earlier.
   */
  stillWanted?: (current: BranchMetadata) => boolean
}

export type DeleteBranchWorkspaceOutcome =
  | { kind: 'deleted'; cleanupWarning?: string }
  /** `stillWanted` refused it, or it was already gone. */
  | { kind: 'kept' }
  /** The lock was not taken in time, or branch.json could not be read under it. */
  | { kind: 'busy'; error: string }

/**
 * Delete a branch and everything stored with it: workspace, branch.json and comments.
 *
 * The directory leaves its name by one rename, under the server-enforced lockfile branch-metadata
 * saves hold (utils/occ-json-write.ts), so a save() that reaches that lock after the rename fails
 * rather than recreating the tree. The `rm` runs last: a process killed during it leaves only a
 * `.deleting-*` directory the worker sweeps, never residue under a name that may be created again.
 */
export async function deleteBranchWorkspace(
  options: DeleteBranchWorkspaceOptions,
): Promise<DeleteBranchWorkspaceOutcome> {
  const { context, baseBranch, registry, stillWanted } = options
  const metadataFile = path.join(context.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
  let cleanupWarning: string | undefined
  let deletingPath: string | undefined
  const warn = (warning: string) => {
    cleanupWarning = cleanupWarning ? `${cleanupWarning}; ${warning}` : warning
  }

  let wanted = true
  try {
    await withOccFileLock(metadataFile, async () => {
      if (stillWanted) {
        const current = await readBranchMetadataFile(context.branchRoot)
        if (current === null || !stillWanted(current.branch)) {
          wanted = false
          return
        }
      }
      if (context.branchRoot === context.baseRoot) {
        await fs.unlink(metadataFile).catch((err: unknown) => {
          if (!isNotFoundError(err)) throw err
        })
        return
      }
      const target = path.join(context.baseRoot, deletingDirName(path.basename(context.branchRoot)))
      try {
        await fs.rename(context.branchRoot, target)
        deletingPath = target
      } catch (err: unknown) {
        if (isNotFoundError(err)) return
        // Still deleted logically: without branch.json the branch is unlisted,
        // and the worker quarantines what is left.
        await fs.unlink(metadataFile).catch(() => {})
        // [REDACT] Returned to the browser; the console line keeps the path.
        warn(`Failed to remove branch directory: ${sanitizeErrorMessage(getErrorMessage(err))}`)
        console.error(
          `CanopyCMS: Failed to move branch directory for ${context.branch.name} aside:`,
          getErrorMessage(err),
        )
      }
    })
  } catch (err: unknown) {
    // A lock on a directory another delete took fails like any other.
    if (!(await filePathExists(context.branchRoot))) return { kind: 'kept' }
    return { kind: 'busy', error: getErrorMessage(err) }
  }
  if (!wanted) return { kind: 'kept' }

  // Defense-in-depth only: callers refuse the base branch, and settings branches never resolve
  // to a context here.
  const sanitizedDeleted = sanitizeBranchName(context.branch.name)
  const deletableHead =
    sanitizedDeleted !== sanitizeBranchName(baseBranch) &&
    !sanitizedDeleted.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
  if (deletableHead) {
    try {
      await options.deleteMirrorHead()
    } catch (err: unknown) {
      // Client-facing copy is sanitized (API-H2 — no absolute EFS paths); the console line keeps
      // the raw detail for server logs.
      warn(
        `Failed to remove the deleted branch's head from the local mirror: ${sanitizeErrorMessage(getErrorMessage(err))}`,
      )
      console.warn(
        `CanopyCMS: failed to remove deleted branch's mirror head (branch ${context.branch.name}): ${getErrorMessage(err)}`,
      )
    }
    const warning = await options.deleteOnGitHub()
    if (warning) warn(warning)
  }

  await registry.invalidate()
  if (deletingPath) await removeLeftoverDir(deletingPath)

  return { kind: 'deleted', ...(cleanupWarning && { cleanupWarning }) }
}
