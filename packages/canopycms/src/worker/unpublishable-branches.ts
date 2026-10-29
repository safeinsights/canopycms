/**
 * Editor branches the GitHub gateway will not publish, by ref: outside its namespace or protected
 * (`publishesBranch`, worker/branch-policy.ts). Read against the gateway's own description each
 * sync, so the list follows a change to `legacyBranches` or `protectedBranches`.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { BranchMetadataCorruptError, BranchMetadataFileManager } from '../branch-metadata'
import { branchNamespaceProblem } from '../operating-mode/branch-namespace'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import type {
  UnpublishableBranch,
  UnpublishableBranchReason,
  UnpublishableBranchesReport,
  WorkerStatusReport,
} from '../types'
import { isNodeError } from '../utils/error'
import {
  MAX_BRANCH_NAME_LENGTH,
  MAX_PROTECTED_BRANCHES,
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
    // `withFileTypes` may lstat each entry, so an entry removed mid-listing rejects with its own
    // ENOENT: only the branches directory's absence means no branches.
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err
    if (
      typeof err.path !== 'string' ||
      path.resolve(err.path) !== path.resolve(ctx.contentBranchesPath)
    ) {
      throw err
    }
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

const REASONS: ReadonlySet<unknown> = new Set<UnpublishableBranchReason>([
  'blocks-namespace',
  'unlistable',
])

function isReason(value: unknown): value is UnpublishableBranchReason {
  return REASONS.has(value)
}

/** The most branches a carried report may claim to hold; a real workspace has far fewer. */
const MAX_CARRIED_COUNT = 100_000

/** The longest timestamp a carried report's `at` may be; an ISO 8601 instant is 24. */
const MAX_CARRIED_AT_LENGTH = 32

/**
 * The report `value` holds, rebuilt from the fields `findUnpublishableBranches` writes, or
 * undefined when `value` is not one it could have made: at most MAX_UNPUBLISHABLE_LISTED names,
 * none longer than a branch name can be, a whole `count` no smaller than the list and at most
 * MAX_CARRIED_COUNT, and an `at` that parses as a date within MAX_CARRIED_AT_LENGTH characters.
 * The Lambda can write the status file, so nothing else it holds is carried.
 */
function carriedReport(value: unknown): UnpublishableBranchesReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('branches' in value) || !('count' in value) || !('at' in value)) return undefined
  const { branches, count, at } = value
  if (
    typeof at !== 'string' ||
    at.length > MAX_CARRIED_AT_LENGTH ||
    !Number.isFinite(Date.parse(at)) ||
    !Array.isArray(branches) ||
    branches.length > MAX_UNPUBLISHABLE_LISTED ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < branches.length ||
    count > MAX_CARRIED_COUNT
  ) {
    return undefined
  }
  const carried: UnpublishableBranch[] = []
  for (const entry of branches as unknown[]) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('name' in entry) ||
      typeof entry.name !== 'string' ||
      entry.name.length > MAX_BRANCH_NAME_LENGTH
    ) {
      return undefined
    }
    if (!('reason' in entry)) {
      carried.push({ name: entry.name })
    } else if (isReason(entry.reason)) {
      carried.push({ name: entry.name, reason: entry.reason })
    } else {
      return undefined
    }
  }
  return { branches: carried, count, at }
}

/**
 * The report in the status file a previous worker process left, so a restarted worker shows it
 * until its first sync can ask the gateway. Tolerant: an unreadable or malformed file carries
 * nothing.
 */
export async function readCarriedUnpublishableBranches(
  taskDir: string,
): Promise<UnpublishableBranchesReport | undefined> {
  const parsed = await readStatusObject(taskDir)
  if (parsed === undefined || !('unpublishableBranches' in parsed)) return undefined
  return carriedReport(parsed.unpublishableBranches)
}

/**
 * The gateway's namespace and protected names from the status file a previous worker process
 * left, so branch creation, which waits for the namespace, keeps working across a restart until
 * the first sync asks the gateway again. The Lambda can write the status file, so they are carried
 * only in the shape git sync writes: a namespace `branchNamespaceProblem` takes, and at most one
 * more name than `protectedBranches` holds, each exact and no longer than a branch name. Tolerant:
 * no namespace, or one in any other shape, carries nothing, and a list in any other shape
 * carries the namespace alone.
 */
export async function readCarriedGatewayPolicy(
  taskDir: string,
): Promise<Pick<WorkerStatusReport, 'gatewayBranchNamespace' | 'gatewayProtectedBranches'>> {
  const parsed = await readStatusObject(taskDir)
  if (parsed === undefined || !('gatewayBranchNamespace' in parsed)) return {}
  const namespace = parsed.gatewayBranchNamespace
  if (typeof namespace !== 'string' || branchNamespaceProblem(namespace) !== null) return {}
  const names = 'gatewayProtectedBranches' in parsed ? parsed.gatewayProtectedBranches : undefined
  return isExactNameList(names)
    ? { gatewayBranchNamespace: namespace, gatewayProtectedBranches: names }
    : { gatewayBranchNamespace: namespace }
}

function isExactNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PROTECTED_BRANCHES + 1 &&
    value.every(
      (name: unknown) =>
        typeof name === 'string' &&
        name.length > 0 &&
        name.length <= MAX_BRANCH_NAME_LENGTH &&
        !name.includes('*'),
    )
  )
}

/** The status file's top-level object, or undefined when it is missing, unreadable or not one. */
async function readStatusObject(taskDir: string): Promise<object | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    )
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}
