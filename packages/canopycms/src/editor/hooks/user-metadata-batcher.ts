import DataLoader from 'dataloader'
import type { ApiClient } from '../context'
import type { UserSearchResult } from '../../auth/types'
import { MAX_USER_METADATA_BATCH } from '../../api/users-constants'

/** Gathers every badge a panel mounts in one render, effect cascades included. */
const BATCH_WINDOW_MS = 10

/**
 * Sends the ids asked for within one window as one `POST /users/batch`, split at the cap. Pass
 * it to useUserMetadata, whose per-user SWR key is the cache; a failed request yields `null`s.
 */
export function createUserMetadataBatcher(
  apiClient: ApiClient,
): (userId: string) => Promise<UserSearchResult | null> {
  const loader = new DataLoader<string, UserSearchResult | null>(
    async (userIds) => {
      try {
        const result = await apiClient.permissions.batchGetUserMetadata({ userIds: [...userIds] })
        const byId = new Map((result.ok ? (result.data?.users ?? []) : []).map((u) => [u.id, u]))
        return userIds.map((id) => byId.get(id) ?? null)
      } catch (err) {
        console.error('Batch get user metadata failed:', err)
        return userIds.map(() => null)
      }
    },
    {
      cache: false,
      maxBatchSize: MAX_USER_METADATA_BATCH,
      batchScheduleFn: (dispatch) => setTimeout(dispatch, BATCH_WINDOW_MS),
    },
  )
  return (userId) => loader.load(userId)
}
