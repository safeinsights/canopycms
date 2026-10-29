/**
 * Editor branches the GitHub gateway will not publish, by ref: outside its namespace or protected
 * (`publishesBranch`, worker/branch-policy.ts). Read against the gateway's own description each
 * sync, so the list follows a change to `legacyBranches` or `protectedBranches`.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { BranchMetadataCorruptError, BranchMetadataFileManager } from '../branch-metadata'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import type {
  UnpublishableBranch,
  UnpublishableBranchReason,
  UnpublishableBranchesReport,
} from '../types'
import { isNodeError } from '../utils/error'
import {
  MAX_BRANCH_NAME_LENGTH,
  legacyBranchProblem,
  publishesBranch,
  type BranchPolicyDescription,
} from './branch-policy'
import type { WorkerContext } from './worker-context'

/**
 * The most branches a report lists; its `count` says how many there are.
 * @internal Exported for tests.
 */
export const MAX_UNPUBLISHABLE_LISTED = 50

/**
 * Why a `legacyBranches` entry would not publish `name` in `namespace`, or undefined when one
 * would. The ancestor test is the `BranchPolicy` constructor's and `namespaceBlocker`'s.
 */
function reasonFor(name: string, namespace: string): UnpublishableBranchReason | undefined {
  if (namespace.startsWith(`${name}/`)) return 'blocks-namespace'
  if (legacyBranchProblem(name) !== null) return 'unlistable'
  return undefined
}

/**
 * The editor branches the gateway that described its policy as `policy` would refuse to push.
 * Each is the `name` its branch.json records, the git ref: the directory holding it is only the
 * ref sanitized, and `cms/prod/x` and a legacy `cms-prod-x` share one. Only a directory can be a
 * branch: a regular file, such as `branches.json` or a registry write's temp file, or a symlink,
 * is skipped. A directory with no branch.json, or a corrupt one, is no branch. Throws when the
 * branches directory or a branch directory's branch.json cannot be read, so the caller keeps the
 * last report.
 */
export async function findUnpublishableBranches(
  ctx: Pick<WorkerContext, 'contentBranchesPath' | 'sanitizedBaseBranch'>,
  policy: BranchPolicyDescription,
): Promise<Omit<UnpublishableBranchesReport, 'at'>> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(ctx.contentBranchesPath, { withFileTypes: true })
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err
    entries = []
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const branches: UnpublishableBranch[] = []
  for (const dir of dirs.sort()) {
    // The base branch is protected and never published; the `.trash-*` directories purged
    // branches wait in are not branches.
    if (dir.startsWith('.') || dir === ctx.sanitizedBaseBranch) continue
    let meta: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>>
    try {
      meta = await BranchMetadataFileManager.loadOnly(path.join(ctx.contentBranchesPath, dir))
    } catch (err) {
      // Corrupt metadata is no branch, and a directory removed since the listing holds none.
      const notABranch =
        err instanceof BranchMetadataCorruptError || (isNodeError(err) && err.code === 'ENOENT')
      if (!notABranch) throw err
      meta = null
    }
    const branch = meta?.branch
    if (!branch || branch.status === 'archived') continue
    if (publishesBranch(policy, branch.name)) continue
    const reason = reasonFor(branch.name, policy.namespace)
    branches.push(reason ? { name: branch.name, reason } : { name: branch.name })
  }
  return { branches: branches.slice(0, MAX_UNPUBLISHABLE_LISTED), count: branches.length }
}

const REASONS = new Set<string>([
  'blocks-namespace',
  'unlistable',
] satisfies UnpublishableBranchReason[])

/**
 * Whether `value` is a report `findUnpublishableBranches` could have made: at most
 * MAX_UNPUBLISHABLE_LISTED names, none longer than a branch name can be, and a whole `count` no
 * smaller than the list. The Lambda can write the status file, so nothing larger is carried.
 */
function isUnpublishableBranchesReport(value: unknown): value is UnpublishableBranchesReport {
  if (typeof value !== 'object' || value === null) return false
  if (!('branches' in value) || !('count' in value) || !('at' in value)) return false
  const { branches, count, at } = value
  return (
    typeof at === 'string' &&
    Array.isArray(branches) &&
    branches.length <= MAX_UNPUBLISHABLE_LISTED &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count >= branches.length &&
    branches.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'name' in entry &&
        typeof entry.name === 'string' &&
        entry.name.length <= MAX_BRANCH_NAME_LENGTH &&
        (!('reason' in entry) || (typeof entry.reason === 'string' && REASONS.has(entry.reason))),
    )
  )
}

/**
 * The report in the status file a previous worker process left, so a restarted worker shows it
 * until its first sync can ask the gateway. Tolerant: an unreadable or malformed file carries
 * nothing.
 */
export async function readCarriedUnpublishableBranches(
  taskDir: string,
): Promise<UnpublishableBranchesReport | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    )
    if (typeof parsed !== 'object' || parsed === null || !('unpublishableBranches' in parsed)) {
      return undefined
    }
    return isUnpublishableBranchesReport(parsed.unpublishableBranches)
      ? parsed.unpublishableBranches
      : undefined
  } catch {
    return undefined
  }
}
