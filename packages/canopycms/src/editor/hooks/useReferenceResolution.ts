import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntrySchema } from '../../config'
import {
  applyReferenceCache,
  expireReferences,
  fetchReferences,
  idsToFetch,
  storeReferences,
  type ReferenceCache,
} from '../client-reference-resolver'
import { useOptionalApiClient } from '../context'

type FormValue = Record<string, unknown>

export interface UseReferenceResolutionOptions {
  value: FormValue
  fields: EntrySchema
  branch: string
  /** Identifies the open entry; when it changes every cached target is fetched again. */
  entryKey?: string
}

export interface UseReferenceResolutionResult {
  /** The draft with every reference replaced by its target, or `null` until it has one. */
  resolvedValue: FormValue
  /** `true` at each reference position still resolving; see `applyReferenceCache`. */
  loadingState: FormValue
}

/**
 * The draft as live preview shows it. Computed during render from the cache, so the first value
 * for a new entry or edit already has no bare ids; a debounced effect then fetches the ids the
 * cache lacks, in one batched request, and re-renders when they arrive.
 */
export function useReferenceResolution({
  value,
  fields,
  branch,
  entryKey,
}: UseReferenceResolutionOptions): UseReferenceResolutionResult {
  // The context client carries the deployment's basePath. `null` outside an ApiClientProvider
  // (this hook's own unit tests); fetchReferences then falls back to a default client.
  const apiClient = useOptionalApiClient()
  // One map per branch, so a request for a branch left behind stores into an orphaned map.
  const cacheRef = useRef<ReferenceCache>(new Map())
  // The cache is a ref, so a fetch that fills it bumps this to recompute the memo below.
  const [cacheVersion, setCacheVersion] = useState(0)
  // Ids already requested, so an edit while a request is in flight does not repeat it.
  const inFlightRef = useRef(new Set<string>())
  // An edit skipped in-flight ids, so a failed request retries instead of awaiting an edit.
  const skippedRef = useRef(false)
  const [retryTick, setRetryTick] = useState(0)

  const { resolvedValue, loadingState } = useMemo(
    () => applyReferenceCache(fields, value, branch, cacheRef.current),
    [fields, value, branch, cacheVersion],
  )

  // These two are declared before the fetch effect, so it sees their result in the same commit.
  useEffect(() => {
    cacheRef.current = new Map()
    setCacheVersion((prev) => prev + 1)
  }, [branch])

  useEffect(() => {
    expireReferences(cacheRef.current)
  }, [entryKey])

  useEffect(() => {
    const cache = cacheRef.current
    const inFlight = inFlightRef.current
    const needed = idsToFetch(fields, value, branch, cache, Date.now())
    const ids = needed.filter((id) => !inFlight.has(`${branch}:${id}`))
    if (ids.length < needed.length) skippedRef.current = true
    if (ids.length === 0) return

    const timeout = setTimeout(async () => {
      const keys = ids.map((id) => `${branch}:${id}`)
      keys.forEach((key) => inFlight.add(key))
      try {
        const found = await fetchReferences(ids, branch, apiClient ?? undefined)
        // Keyed by branch and id, a result stays valid however the draft changed meanwhile.
        storeReferences(cache, branch, found, Date.now())
        skippedRef.current = false
        setCacheVersion((prev) => prev + 1)
      } catch (error) {
        console.error('Reference resolution failed:', error)
        if (skippedRef.current) {
          skippedRef.current = false
          setRetryTick((prev) => prev + 1)
        }
      } finally {
        keys.forEach((key) => inFlight.delete(key))
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [value, fields, branch, apiClient, retryTick])

  return { resolvedValue, loadingState }
}
