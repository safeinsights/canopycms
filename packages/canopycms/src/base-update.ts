import type { BranchMetadata } from './types'
import type { TaskAction } from './task-queue/cms-task-queue'

/**
 * Asking for the latest changes: the API records the request on branch.json and queues this action
 * (api/branch-update-from-base.ts), the worker's sync answers it in `lastBaseUpdate`
 * (worker/rebase.ts), and the editor waits while it stands. Dependency-free, so all three share it.
 */
export const SYNC_BRANCH_ACTION = 'sync-branch' satisfies TaskAction

/**
 * How long a request, or an answer that didn't fail, stands for the next request on the branch,
 * which joins it instead (api/branch-update-from-base.ts).
 */
export const BASE_UPDATE_REQUEST_INTERVAL_MS = 30_000

/** How long the editor waits on a request, polling for its answer. */
export const BASE_UPDATE_GIVE_UP_MS = 10 * 60_000

/**
 * How long the worker asks itself for early cycles while a request goes unanswered; its regular
 * cycles answer it after that. Each cycle reads every branch in review from GitHub, so it is short.
 */
export const BASE_UPDATE_EARLY_RETRY_MS = 2 * 60_000

/**
 * How far in the future a request time may lie and still count: the Lambdas' clocks keep NTP time,
 * so a later one is corrupt and is never waited on.
 */
export const BASE_UPDATE_CLOCK_SKEW_MS = 60_000

/** Whether the branch's latest request for the latest changes is still unanswered. */
export function isBaseUpdatePending(
  branch: Pick<BranchMetadata, 'baseUpdateRequestedAt' | 'lastBaseUpdate'>,
): boolean {
  const requestedAt = branch.baseUpdateRequestedAt
  if (requestedAt === undefined) return false
  const answeredAt = branch.lastBaseUpdate?.at
  return answeredAt === undefined || Date.parse(answeredAt) < Date.parse(requestedAt)
}
