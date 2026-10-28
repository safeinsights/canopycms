'use client'

/**
 * SWR-backed read of what a branch changes against its base (GET /:branch/changes), for the
 * Content panel's Changed filter. Keyed per branch like useCommentsData.ts; a null key while
 * `enabled` is false fetches nothing.
 */

import { useCallback, useRef } from 'react'
import useSWR from 'swr'
import type { ApiClient } from '../context'
import type { BranchChangesData } from '../../api/branch-changes'

const KEY_PREFIX = 'canopy:changes:'

/** Cache key for a branch's changes against its base. */
const branchChangesKey = (branch: string): string => `${KEY_PREFIX}${branch}`

/**
 * Why a branch's changes could not be loaded: the branch moved under the read (a 409, nothing
 * lost; `message` is the server's) or anything else.
 */
export type BranchChangesError =
  | { kind: 'syncing'; message?: string }
  | { kind: 'failed'; message: string }

class BranchChangesLoadError extends Error {
  constructor(readonly reason: BranchChangesError) {
    super(reason.message ?? 'syncing')
  }
}

async function fetchBranchChanges(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
): Promise<BranchChangesData> {
  const result = await apiClient.changes.list({ branch })
  // A body no CanopyCMS handler wrote, such as a proxy's, is a failure, not an empty list.
  if (result.ok && Array.isArray(result.data?.entries) && Array.isArray(result.data.collections)) {
    return result.data
  }
  throw new BranchChangesLoadError(
    result.status === 409
      ? { kind: 'syncing', ...(result.error && { message: result.error }) }
      : { kind: 'failed', message: result.error ?? `HTTP ${result.status}` },
  )
}

const toError = (err: unknown): BranchChangesError =>
  err instanceof BranchChangesLoadError
    ? err.reason
    : { kind: 'failed', message: err instanceof Error ? err.message : String(err) }

export interface BranchChangesState {
  data: BranchChangesData | undefined
  error: BranchChangesError | undefined
  isLoading: boolean
  isValidating: boolean
  /**
   * Starts a fresh fetch through SWR's revalidating `mutate()`, never coalesced with one in
   * flight; SWR keeps whichever fetch started last (hooks/README.md).
   */
  reload: () => Promise<void>
}

export function useBranchChangesData(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
  enabled: boolean,
): BranchChangesState {
  const key = branch && enabled ? branchChangesKey(branch) : null
  // Per key, how many fetches have started, and the last answer one returned.
  const startsRef = useRef(new Map<string, number>())
  const answersRef = useRef(new Map<string, BranchChangesData>())
  const swr = useSWR(key, async (cacheKey: string) => {
    const started = (startsRef.current.get(cacheKey) ?? 0) + 1
    startsRef.current.set(cacheKey, started)
    try {
      // The branch comes from the key, so a fetch outliving a branch switch reads its own branch.
      const data = await fetchBranchChanges(apiClient, cacheKey.slice(KEY_PREFIX.length))
      answersRef.current.set(cacheKey, data)
      return data
    } catch (err) {
      // SWR 2.4 drops an overtaken fetch's result but still shows its error. Overtaken, it
      // resolves instead, and SWR drops that: a newer fetch holds the key, or has finished.
      if ((startsRef.current.get(cacheKey) ?? 0) > started) return answersRef.current.get(cacheKey)
      throw err
    }
  })
  const { mutate } = swr
  const reload = useCallback(async () => {
    await mutate()
  }, [mutate])

  return {
    data: swr.data,
    error: key && swr.error !== undefined ? toError(swr.error) : undefined,
    isLoading: swr.isLoading,
    isValidating: swr.isValidating,
    reload,
  }
}
