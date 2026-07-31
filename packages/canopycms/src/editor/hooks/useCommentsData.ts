'use client'

/**
 * SWR-backed read of a branch's comment threads (GET /:branch/comments).
 *
 * Keyed per branch, so switching branches automatically triggers (and
 * dedupes) a fresh fetch for the new key without useCommentSystem needing
 * its own branch-keyed effect. See useBranchesData.ts for the same pattern
 * applied to the branches list.
 */

import useSWR, { type SWRResponse } from 'swr'
import type { ApiClient } from '../context'
import type { CommentThread } from '../../comment-store'

/** Cache key for a branch's comment threads. */
export const commentsKey = (branch: string): string => `canopy:comments:${branch}`

export interface CommentsData {
  threads: CommentThread[]
}

/**
 * Fetch a branch's comment threads. Never throws -- matches the pre-SWR
 * `loadComments` behavior of logging and resolving to an empty list on
 * failure rather than surfacing an error state (comments have no error UI).
 * Exported for direct testing and for the imperative reload path.
 */
export async function fetchComments(
  apiClient: Pick<ApiClient, 'comments'>,
  branch: string,
): Promise<CommentsData> {
  try {
    const result = await apiClient.comments.list({ branch })
    if (!result.ok) {
      console.error('Failed to load comments:', result.status)
      return { threads: [] }
    }
    return { threads: result.data?.threads ?? [] }
  } catch (err) {
    console.error('Failed to load comments:', err)
    return { threads: [] }
  }
}

/**
 * SWR-backed read of a branch's comment threads. `branch` may be empty
 * (branchless start), in which case fetching is disabled entirely (null key).
 */
export function useCommentsData(
  apiClient: Pick<ApiClient, 'comments'>,
  branch: string,
): SWRResponse<CommentsData, never> {
  return useSWR(branch ? commentsKey(branch) : null, () => fetchComments(apiClient, branch))
}
