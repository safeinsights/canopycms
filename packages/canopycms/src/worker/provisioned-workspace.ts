import fs from 'node:fs/promises'
import path from 'node:path'

import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import { getErrorMessage, isNodeError } from '../utils/error'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { workerLogWarn } from './log'

export type ProvisionedWorkspaceHold =
  | {
      kind: 'held'
      release: () => Promise<void>
      /**
       * Whether the lock was lost mid-hold (its marker vanished or was taken over), so another
       * process may now be cloning into this directory. Callers check it before each destructive
       * git step and stop rather than carry on unguarded.
       */
      isCompromised: () => boolean
    }
  /** Another process holds the provisioning lock: a clone, or an admin purge or repair, is in flight. */
  | { kind: 'locked' }
  /** No clone with metadata at this path yet. */
  | { kind: 'not-provisioned' }

/**
 * Take a branch workspace's provisioning lock for the sync loop, the same cross-host lock the
 * Lambda holds while it clones the workspace (`branch-workspace.ts`), so the worker never runs git
 * against a half-made clone. The caller holds it across its dirty check and every git step, and
 * releases it in a `finally`.
 *
 * Zero retries: the worker skips and retries next cycle rather than wait, so it never blocks on
 * the Lambda and cannot deadlock with it. The rebase nests the content-write lock inside this one;
 * the worker takes that one try-only as well, so the nesting cannot deadlock either.
 *
 * Provisioned means a `.git` directory AND `branch.json`. The Lambda clones directly into the
 * target path, so `.git` appears early, and writes `branch.json` only after the clone and its
 * lock are done.
 */
export async function holdProvisionedWorkspace(
  contentBranchesPath: string,
  dirName: string,
): Promise<ProvisionedWorkspaceHold> {
  let release: () => Promise<void>
  let compromised = false
  try {
    release = await tryAcquireProvisioningLock(
      contentBranchesPath,
      branchProvisioningLockName(dirName),
      (err) => {
        compromised = true
        workerLogWarn(
          `  Provisioning lock for ${dirName} was compromised mid-hold: ${getErrorMessage(err)}`,
        )
      },
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') return { kind: 'locked' }
    throw err
  }

  const root = path.join(contentBranchesPath, dirName)
  const [gitIsDir, hasMetadata] = await Promise.all([
    fs.stat(path.join(root, '.git')).then(
      (stat) => stat.isDirectory(),
      () => false,
    ),
    fs.stat(path.join(root, BRANCH_META_DIR, BRANCH_META_FILE)).then(
      () => true,
      () => false,
    ),
  ])
  if (gitIsDir && hasMetadata) return { kind: 'held', release, isCompromised: () => compromised }

  await releaseProvisionedWorkspace(release, dirName)
  return { kind: 'not-provisioned' }
}

/** Release a hold, logging rather than throwing: the sync loop's callers never throw. */
export async function releaseProvisionedWorkspace(
  release: () => Promise<void>,
  dirName: string,
): Promise<void> {
  await release().catch((err: unknown) => {
    workerLogWarn(
      `  Failed to release the provisioning lock for ${dirName}: ${getErrorMessage(err)}`,
    )
  })
}
