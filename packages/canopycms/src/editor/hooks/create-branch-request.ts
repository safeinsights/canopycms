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
 * create publishes the whole branch or nothing. `userId` is the current user, the only creator
 * whose listed branch can be this create's result.
 */
export async function requestBranchCreate(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  body: CreateBranchBody,
  userId: string | undefined,
  deadlineMs = CREATE_BRANCH_DEADLINE_MS,
): Promise<CreateBranchOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), deadlineMs)
  })
  const result = await Promise.race([apiClient.branches.create(body), deadline]).finally(() =>
    clearTimeout(timer),
  )

  if (result === DEADLINE) return settle(apiClient, body.branch, userId, CREATE_TIMED_OUT_MESSAGE)
  if (result.ok) return { kind: 'created', branch: result.data?.branch }
  if (isNonApiResponse(result))
    return settle(apiClient, body.branch, userId, CREATE_TIMED_OUT_MESSAGE)
  const message = result.error || 'Failed to create branch'
  return result.status === 503
    ? settle(apiClient, body.branch, userId, message)
    : { kind: 'failed', message }
}

/** A same-named branch someone else made is a name conflict: adopting it would drop this create. */
async function settle(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  requested: string,
  userId: string | undefined,
  message: string,
): Promise<CreateBranchOutcome> {
  const listed = await findListedBranch(apiClient, requested)
  if (!listed) return { kind: 'failed', message }
  if (userId !== undefined && listed.createdBy === userId)
    return { kind: 'created', branch: listed }
  return { kind: 'failed', message: `A branch named "${listed.name}" already exists` }
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
