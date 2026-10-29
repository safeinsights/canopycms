import type { BranchListItem, CreateBranchBody } from '../../api/branch'
import { isCreatorsRecentBranch } from '../../api/branch-create-window'
import { isApiTimeoutError, isNonApiResponse, type CanopyApiClient } from '../../api/client'
import { GATEWAY_MAX_TIMEOUT_MS } from '../../api/request-deadline'
import { parseCreatedBranchName } from '../../paths/validation'

/**
 * @internal Exported for tests. Past the gateway's limit, so its 504 lands first, and under
 * `REQUEST_TIMEOUT_MS.long`. The limit comes from `request-deadline` directly: a test that mocks
 * `api/client` would otherwise lose it at module load.
 */
export const CREATE_BRANCH_DEADLINE_MS = GATEWAY_MAX_TIMEOUT_MS + 30_000

/** @internal Exported for tests. */
export const CREATE_TIMED_OUT_MESSAGE =
  "Creating the branch didn't finish (the server timed out). It's safe to try again."

/** The server refused the typed name: the create form shows `refusal` in place, with no toast. */
export interface CreateRefusal {
  refusal: string
}

export type CreateBranchOutcome =
  | { kind: 'created'; branch: BranchListItem | undefined }
  /** `refused`: the server answered no to this name, so retrying it cannot pass; the form shows why. */
  | { kind: 'failed'; message: string; refused?: true }

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
  let result: Awaited<ReturnType<CanopyApiClient['branches']['create']>>
  try {
    result = await apiClient.branches.create(body, { timeoutMs: deadlineMs })
  } catch (err) {
    if (isApiTimeoutError(err)) {
      return settle(apiClient, body.branch, userId, CREATE_TIMED_OUT_MESSAGE)
    }
    throw err
  }

  if (result.ok) return { kind: 'created', branch: result.data?.branch }
  if (isNonApiResponse(result))
    return settle(apiClient, body.branch, userId, CREATE_TIMED_OUT_MESSAGE)
  const message = result.error || 'Failed to create branch'
  if (result.status === 503) return settle(apiClient, body.branch, userId, message)
  // The create handler answers a name it refuses with 400, or 409 for a clash.
  const refused = result.status === 400 || result.status === 409
  return refused ? { kind: 'failed', message, refused } : { kind: 'failed', message }
}

/** A same-named branch the server would not answer this create with is a name conflict. */
async function settle(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  requested: string,
  userId: string | undefined,
  message: string,
): Promise<CreateBranchOutcome> {
  const listed = await findListedBranch(apiClient, requested)
  if (!listed) return { kind: 'failed', message }
  if (isCreatorsRecentBranch(listed, userId)) return { kind: 'created', branch: listed }
  return {
    kind: 'failed',
    message: `A branch named "${listed.shortName ?? listed.name}" already exists`,
    refused: true,
  }
}

/** The listed namespace branch (short name not its whole name) that `requested` creates. */
async function findListedBranch(
  apiClient: Pick<CanopyApiClient, 'branches'>,
  requested: string,
): Promise<BranchListItem | undefined> {
  const created = parseCreatedBranchName(requested)
  if (!created.ok) return undefined
  try {
    const listing = await apiClient.branches.list()
    if (!listing.ok) return undefined
    return listing.data?.branches.find(
      (branch) => branch.shortName !== branch.name && branch.shortName === created.shortName,
    )
  } catch {
    return undefined
  }
}
