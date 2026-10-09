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
  const cacheRef = useRef<ReferenceCache>(new Map())
  // The cache is a ref, so a fetch that fills it bumps this to recompute the memo below.
  const [cacheVersion, setCacheVersion] = useState(0)
  // Ids already requested, so an edit while a request is in flight does not repeat it.
  const inFlightRef = useRef(new Set<string>())

  const { resolvedValue, loadingState } = useMemo(
    () => applyReferenceCache(fields, value, branch, cacheRef.current),
    [fields, value, branch, cacheVersion],
  )

  // Declared before the fetch effect, which therefore sees the entries expired.
  useEffect(() => {
    expireReferences(cacheRef.current)
  }, [entryKey])

  useEffect(() => {
    const inFlight = inFlightRef.current
    const ids = idsToFetch(fields, value, branch, cacheRef.current, Date.now()).filter(
      (id) => !inFlight.has(`${branch}:${id}`),
    )
    if (ids.length === 0) return

    const timeout = setTimeout(async () => {
      const keys = ids.map((id) => `${branch}:${id}`)
      keys.forEach((key) => inFlight.add(key))
      try {
        const found = await fetchReferences(ids, branch, apiClient ?? undefined)
        // Keyed by branch and id, a result stays valid however the draft changed meanwhile.
        storeReferences(cacheRef.current, branch, found, Date.now())
        setCacheVersion((prev) => prev + 1)
      } catch (error) {
        console.error('Reference resolution failed:', error)
      } finally {
        keys.forEach((key) => inFlight.delete(key))
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [value, fields, branch, apiClient])

  useEffect(() => {
    cacheRef.current.clear()
    setCacheVersion((prev) => prev + 1)
  }, [branch])

  return { resolvedValue, loadingState }
}
