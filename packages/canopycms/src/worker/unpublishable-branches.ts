/**
 * Editor branches the GitHub gateway will not publish, by ref: outside its namespace or protected
 * (`publishesBranch`, worker/branch-policy.ts). Read against the gateway's own description each
 * sync, so the list follows a change to `legacyBranches` or `protectedBranches`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { BranchMetadataFileManager } from '../branch-metadata'
import type { UnpublishableBranchesReport } from '../types'
import { isNodeError } from '../utils/error'
import { publishesBranch, type BranchPolicyDescription } from './branch-policy'
import type { WorkerContext } from './worker-context'

/**
 * The most names a report lists; its `count` says how many there are.
 * @internal Exported for tests.
 */
export const MAX_UNPUBLISHABLE_LISTED = 50

/**
 * The editor branches the gateway that described its policy as `policy` would refuse to push.
 * Each is the `name` its branch.json records, the git ref: the directory holding it is only the
 * ref sanitized, and `cms/prod/x` and a legacy `cms-prod-x` share one. Throws when the branches
 * directory cannot be read, so the caller keeps the last report.
 */
export async function findUnpublishableBranches(
  ctx: Pick<WorkerContext, 'contentBranchesPath' | 'sanitizedBaseBranch'>,
  policy: BranchPolicyDescription,
): Promise<UnpublishableBranchesReport> {
  let dirs: string[]
  try {
    dirs = await fs.readdir(ctx.contentBranchesPath)
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err
    dirs = []
  }
  const names: string[] = []
  for (const dir of dirs.sort()) {
    // The base branch is protected and never published; structural entries are not branches.
    if (dir.startsWith('.') || dir === 'branches.json' || dir === ctx.sanitizedBaseBranch) continue
    const meta = await BranchMetadataFileManager.loadOnly(
      path.join(ctx.contentBranchesPath, dir),
    ).catch(() => null)
    const branch = meta?.branch
    if (!branch || branch.status === 'archived') continue
    if (!publishesBranch(policy, branch.name)) names.push(branch.name)
  }
  return { names: names.slice(0, MAX_UNPUBLISHABLE_LISTED), count: names.length }
}
