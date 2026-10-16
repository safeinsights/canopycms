import DataLoader from 'dataloader'
import type { ApiClient } from '../context'
import type { UserSearchResult } from '../../auth/types'
import { MAX_USER_METADATA_BATCH } from '../../api/users-constants'

/** Long enough to gather every badge one render mounts. */
const BATCH_WINDOW_MS = 10

/**
 * Sends the ids asked for within one window as one `POST /users/batch`, split at the cap. Pass
 * it to useUserMetadata, whose per-user SWR key is the cache. A failed request rejects every id
 * in it, so SWR keeps the last good record; an id a successful response omits resolves `null`.
 */
export function createUserMetadataBatcher(
  apiClient: ApiClient,
): (userId: string) => Promise<UserSearchResult | null> {
  const loader = new DataLoader<string, UserSearchResult | null>(
    async (userIds) => {
      let result: Awaited<ReturnType<ApiClient['permissions']['batchGetUserMetadata']>>
      try {
        result = await apiClient.permissions.batchGetUserMetadata({ userIds: [...userIds] })
      } catch (err) {
        console.error('Batch get user metadata failed:', err)
        throw err
      }
      if (!result.ok) {
        const reason = result.error ?? `status ${result.status}`
        console.error('Batch get user metadata failed:', reason)
        throw new Error(`Batch get user metadata failed: ${reason}`)
      }
      const byId = new Map((result.data?.users ?? []).map((u) => [u.id, u]))
      return userIds.map((id) => byId.get(id) ?? null)
    },
    {
      cache: false,
      maxBatchSize: MAX_USER_METADATA_BATCH,
      batchScheduleFn: (dispatch) => setTimeout(dispatch, BATCH_WINDOW_MS),
    },
  )
  return (userId) => loader.load(userId)
}
