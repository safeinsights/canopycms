'use client'

/**
 * SWR-backed read of what a branch changes against its base (GET /:branch/changes), for the
 * Content panel's Changed filter. Keyed per branch like useCommentsData.ts; a null key while
 * `enabled` is false fetches nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import type { ApiClient } from '../context'
import type { BranchChangesData } from '../../api/branch-changes'

/** Cache key for a branch's changes against its base. */
const branchChangesKey = (branch: string): string => `canopy:changes:${branch}`

/** Why a branch's changes could not be loaded: mid-sync (a 409, nothing lost) or anything else. */
export type BranchChangesError = { kind: 'syncing' } | { kind: 'failed'; message: string }

class BranchChangesLoadError extends Error {
  constructor(readonly reason: BranchChangesError) {
    super(reason.kind === 'failed' ? reason.message : 'syncing')
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
      ? { kind: 'syncing' }
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
  /** Fetches afresh, never coalesced with a load in flight (hooks/README.md "Explicit reload"). */
  reload: () => Promise<void>
}

export function useBranchChangesData(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
  enabled: boolean,
): BranchChangesState {
  const { mutate } = useSWRConfig()
  const key = branch && enabled ? branchChangesKey(branch) : null
  // One start order for SWR's own fetches and explicit reloads, and per key the start of the
  // newest answer that landed: an answer that started earlier than that one is never shown.
  const startedRef = useRef(0)
  const landedRef = useRef(new Map<string, number>())
  const isStale = (cacheKey: string, seq: number) => seq < (landedRef.current.get(cacheKey) ?? 0)
  const land = (cacheKey: string, seq: number) => landedRef.current.set(cacheKey, seq)
  const swr = useSWR(key, async (cacheKey: string) => {
    const seq = ++startedRef.current
    const data = await fetchBranchChanges(apiClient, branch)
    if (!isStale(cacheKey, seq)) land(cacheKey, seq)
    return data
  })
  // An explicit reload's failure, for the branch it was for; SWR holds only its own fetch's.
  const [reloadFailure, setReloadFailure] = useState<{
    branch: string
    error: BranchChangesError
  }>()
  const [reloading, setReloading] = useState(0)
  useEffect(() => setReloadFailure(undefined), [swr.data])

  const reload = useCallback(async () => {
    if (!key) return
    const seq = ++startedRef.current
    setReloading((n) => n + 1)
    try {
      const data = await fetchBranchChanges(apiClient, branch)
      if (isStale(key, seq)) return
      land(key, seq)
      setReloadFailure(undefined)
      await mutate(key, data, { revalidate: false })
    } catch (err) {
      if (!isStale(key, seq)) setReloadFailure({ branch, error: toError(err) })
    } finally {
      setReloading((n) => n - 1)
    }
  }, [apiClient, branch, key, mutate])

  const error =
    reloadFailure?.branch === branch
      ? reloadFailure.error
      : swr.error === undefined
        ? undefined
        : toError(swr.error)
  return {
    data: swr.data,
    error: key ? error : undefined,
    isLoading: swr.isLoading,
    isValidating: swr.isValidating || reloading > 0,
    reload,
  }
}
