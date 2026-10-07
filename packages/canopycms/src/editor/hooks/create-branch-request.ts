import type { BranchListItem, CreateBranchBody } from '../../api/branch'
import { isNonApiResponse, type CanopyApiClient } from '../../api/client'
import { sanitizeBranchName } from '../../paths/branch-name'

/** @internal Exported for tests. Past the 60 s a Lambda behind CloudFront gets, so its 504 lands first. */
export const CREATE_BRANCH_DEADLINE_MS = 90_000

/** @internal Exported for tests. */
export const CREATE_TIMED_OUT_MESSAGE =
  "Creating the branch didn't finish (the server timed out). It's safe to try again."

export type CreateBranchOutcome =
  | { kind: 'created'; branch: BranchListItem | undefined }
  | { kind: 'failed'; message: string }

const DEADLINE = Symbol('deadline')

/**
 * Create a branch. Past the deadline, after an error page from in front of the API, or after a
 * busy 503 the branch may exist anyway, so the branch list decides; retrying is safe because a
 * create publishes the whole branch or nothing.
 */
export async function requestBranchCreate(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  body: CreateBranchBody,
  deadlineMs = CREATE_BRANCH_DEADLINE_MS,
): Promise<CreateBranchOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), deadlineMs)
  })
  const result = await Promise.race([apiClient.branches.create(body), deadline]).finally(() =>
    clearTimeout(timer),
  )

  if (result === DEADLINE) return settle(apiClient, body.branch, CREATE_TIMED_OUT_MESSAGE)
  if (result.ok) return { kind: 'created', branch: result.data?.branch }
  if (isNonApiResponse(result)) return settle(apiClient, body.branch, CREATE_TIMED_OUT_MESSAGE)
  const message = result.error || 'Failed to create branch'
  return result.status === 503
    ? settle(apiClient, body.branch, message)
    : { kind: 'failed', message }
}

async function settle(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  requested: string,
  message: string,
): Promise<CreateBranchOutcome> {
  const listed = await findListedBranch(apiClient, requested)
  return listed ? { kind: 'created', branch: listed } : { kind: 'failed', message }
}

async function findListedBranch(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  requested: string,
): Promise<BranchListItem | undefined> {
  const name = sanitizeBranchName(requested)
  try {
    const listing = await apiClient.branches.list()
    if (!listing.ok) return undefined
    return listing.data?.branches.find((branch) => sanitizeBranchName(branch.name) === name)
  } catch {
    return undefined
  }
}
