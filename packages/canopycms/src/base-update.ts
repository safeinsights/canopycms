import type { BranchMetadata } from './types'
import type { TaskAction } from './task-queue/cms-task-queue'

/**
 * Asking for the latest changes: the API records the request on branch.json and queues this action
 * (api/branch-update-from-base.ts), the worker's sync answers it in `lastBaseUpdate`
 * (worker/rebase.ts), and the editor waits while it stands. Dependency-free, so all three share it.
 */
export const SYNC_BRANCH_ACTION = 'sync-branch' satisfies TaskAction

/** The shortest time between two requests for one branch; a request inside it joins the last. */
export const BASE_UPDATE_REQUEST_INTERVAL_MS = 30_000

/** Whether the branch's latest request for the latest changes is still unanswered. */
export function isBaseUpdatePending(
  branch: Pick<BranchMetadata, 'baseUpdateRequestedAt' | 'lastBaseUpdate'>,
): boolean {
  const requestedAt = branch.baseUpdateRequestedAt
  if (requestedAt === undefined) return false
  const answeredAt = branch.lastBaseUpdate?.at
  return answeredAt === undefined || Date.parse(answeredAt) < Date.parse(requestedAt)
}
