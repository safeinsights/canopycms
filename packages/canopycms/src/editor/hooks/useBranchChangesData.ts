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
  // SWR's own fetches and explicit reloads share one start order. Per key: the fetches in flight,
  // the newest answer to have settled, and the one the cache shows. SWR keeps only its latest
  // fetch's answer and drops one that started before a write, so a reload writes only when no
  // newer fetch is in flight, leaving that one to deliver; a fetch failing after a newer answer
  // settled gives that answer, not its error.
  const startedRef = useRef(0)
  const inFlightRef = useRef(new Map<string, Set<number>>())
  const newestRef = useRef(new Map<string, { seq: number; data: BranchChangesData }>())
  const shownRef = useRef(new Map<string, number>())
  const start = (cacheKey: string) => {
    const seq = ++startedRef.current
    const set = inFlightRef.current.get(cacheKey) ?? new Set<number>()
    inFlightRef.current.set(cacheKey, set.add(seq))
    return seq
  }
  const settle = (cacheKey: string, seq: number, data?: BranchChangesData) => {
    inFlightRef.current.get(cacheKey)?.delete(seq)
    if (data && seq > (newestRef.current.get(cacheKey)?.seq ?? 0)) {
      newestRef.current.set(cacheKey, { seq, data })
    }
  }
  const newerInFlight = (cacheKey: string, seq: number) =>
    [...(inFlightRef.current.get(cacheKey) ?? [])].some((other) => other > seq)
  /** The newest settled answer, when the cache shows an older one. */
  const unshownAnswer = (cacheKey: string) => {
    const newest = newestRef.current.get(cacheKey)
    return newest && newest.seq > (shownRef.current.get(cacheKey) ?? 0) ? newest : undefined
  }

  const swr = useSWR(key, async (cacheKey: string) => {
    const seq = start(cacheKey)
    let data: BranchChangesData
    try {
      data = await fetchBranchChanges(apiClient, branch)
    } catch (err) {
      settle(cacheKey, seq)
      // A newer answer stands, so this fetch's failure is older news.
      const newest = newestRef.current.get(cacheKey)
      if (newest && newest.seq > seq) return newest.data
      throw err
    }
    settle(cacheKey, seq, data)
    shownRef.current.set(cacheKey, seq)
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
    const seq = start(key)
    setReloading((n) => n + 1)
    try {
      let failure: unknown
      try {
        settle(key, seq, await fetchBranchChanges(apiClient, branch))
      } catch (err) {
        settle(key, seq)
        failure = err
      }
      if (newerInFlight(key, seq)) return
      const newest = unshownAnswer(key)
      if (newest) {
        shownRef.current.set(key, newest.seq)
        setReloadFailure(undefined)
        await mutate(key, newest.data, { revalidate: false })
      } else if (failure !== undefined && (newestRef.current.get(key)?.seq ?? 0) < seq) {
        setReloadFailure({ branch, error: toError(failure) })
      }
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
