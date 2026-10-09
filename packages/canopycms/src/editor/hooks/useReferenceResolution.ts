import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntrySchema } from '../../config'
import {
  applyReferenceCache,
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
}: UseReferenceResolutionOptions): UseReferenceResolutionResult {
  // The context client carries the deployment's basePath. `null` outside an ApiClientProvider
  // (this hook's own unit tests); fetchReferences then falls back to a default client.
  const apiClient = useOptionalApiClient()
  const cacheRef = useRef<ReferenceCache>(new Map())
  // The cache is a ref, so a fetch that fills it bumps this to recompute the memo below.
  const [cacheVersion, setCacheVersion] = useState(0)
  // Identifies the current fetch attempt. clearTimeout cannot stop a fetch already awaiting the
  // network; this check after the await discards one superseded by a newer value or branch, or
  // by unmount.
  const resolveGenerationRef = useRef(0)

  const { resolvedValue, loadingState } = useMemo(
    () => applyReferenceCache(fields, value, branch, cacheRef.current),
    [fields, value, branch, cacheVersion],
  )

  useEffect(() => {
    const ids = idsToFetch(fields, value, branch, cacheRef.current, Date.now())
    if (ids.length === 0) return

    const generation = ++resolveGenerationRef.current
    const timeout = setTimeout(async () => {
      try {
        const found = await fetchReferences(ids, branch, apiClient ?? undefined)
        if (generation !== resolveGenerationRef.current) return
        storeReferences(cacheRef.current, branch, found, Date.now())
        setCacheVersion((prev) => prev + 1)
      } catch (error) {
        console.error('Reference resolution failed:', error)
      }
    }, 300)

    return () => {
      clearTimeout(timeout)
      // Unmount runs only this cleanup, with no next run to claim a new generation.
      ++resolveGenerationRef.current
    }
  }, [value, fields, branch, apiClient])

  useEffect(() => {
    cacheRef.current.clear()
    setCacheVersion((prev) => prev + 1)
  }, [branch])

  return { resolvedValue, loadingState }
}
