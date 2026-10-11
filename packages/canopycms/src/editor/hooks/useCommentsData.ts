'use client'

/**
 * SWR-backed read of a branch's comment threads (GET /:branch/comments).
 *
 * Keyed per branch, so switching branches automatically triggers (and
 * dedupes) a fresh fetch for the new key without useCommentSystem needing
 * its own branch-keyed effect. See useBranchesData.ts for the same pattern
 * applied to the branches list.
 */

import useSWR, { useSWRConfig, type ScopedMutator, type SWRResponse } from 'swr'
import type { ApiClient } from '../context'
import type { CommentThread } from '../../comment-store'
import type { UserProfile } from '../../auth/types'
import { seedUserProfiles } from './useUserMetadata'

/** Cache key for a branch's comment threads. */
export const commentsKey = (branch: string): string => `canopy:comments:${branch}`

export interface CommentsData {
  threads: CommentThread[]
  /** Who wrote or resolved `threads`: name and avatar, never email. */
  users: UserProfile[]
}

/** A branch's comment threads. Never throws: a failed load has no error UI, so it logs and is empty. */
async function fetchComments(
  apiClient: Pick<ApiClient, 'comments'>,
  branch: string,
): Promise<CommentsData> {
  try {
    const result = await apiClient.comments.list({ branch })
    if (!result.ok) {
      console.error('Failed to load comments:', result.status)
      return { threads: [], users: [] }
    }
    return { threads: result.data?.threads ?? [], users: result.data?.users ?? [] }
  } catch (err) {
    console.error('Failed to load comments:', err)
    return { threads: [], users: [] }
  }
}

/**
 * {@link fetchComments}, with the users it names written into the user-metadata cache before the
 * threads that show them land, so their badges render named.
 */
export async function fetchCommentsSeedingUsers(
  apiClient: Pick<ApiClient, 'comments'>,
  mutate: ScopedMutator,
  branch: string,
): Promise<CommentsData> {
  const data = await fetchComments(apiClient, branch)
  await seedUserProfiles(mutate, data.users)
  return data
}

/**
 * SWR-backed read of a branch's comment threads. `branch` may be empty
 * (branchless start), in which case fetching is disabled entirely (null key).
 */
export function useCommentsData(
  apiClient: Pick<ApiClient, 'comments'>,
  branch: string,
): SWRResponse<CommentsData, never> {
  const { mutate } = useSWRConfig()
  return useSWR(branch ? commentsKey(branch) : null, () =>
    fetchCommentsSeedingUsers(apiClient, mutate, branch),
  )
}
