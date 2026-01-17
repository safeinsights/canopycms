/**
 * Hook for live preview reference resolution
 *
 * LIVE PREVIEW REFERENCE RESOLUTION
 *
 * Problem: The preview needs full referenced content (e.g., {name: "Alice", bio: "..."}),
 * but the form only stores IDs (e.g., "5NVkkrB1MJUvnLqEDqDkRN").
 *
 * Solution: Synchronous resolution with background caching
 *
 * 1. SYNCHRONOUS PHASE (useMemo):
 *    - Compute resolvedValue by applying cached data to form value
 *    - If reference ID is in cache, use full object; otherwise keep ID
 *    - Runs during render, so no async gaps or race conditions
 *    - Preview always gets complete, valid data
 *
 * 2. BACKGROUND PHASE (useEffect):
 *    - Find IDs not in cache
 *    - After 300ms debounce, fetch from API
 *    - Update cache with resolved data
 *    - Trigger useMemo re-run via resolutionTrigger
 *    - Preview updates again with full data
 *
 * This two-phase approach eliminates race conditions that occurred with async state,
 * where form data and resolved data could get out of sync during transitions
 * (e.g., "Discard All Drafts" was passing empty objects to preview).
 *
 * Cache structure: Map<string, any> with keys like "main:5NVkkrB1MJUvnLqEDqDkRN"
 * - Branch-scoped to prevent stale cross-branch data
 * - Cleared on branch change
 * - Persists across edits for instant re-renders
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldConfig } from '../../config'
import { resolveChangedReferences } from '../client-reference-resolver'

export type FormValue = Record<string, unknown>

export interface UseReferenceResolutionOptions {
  value: FormValue
  fields: readonly FieldConfig[]
  branch: string
  onResolvedValueChange?: (resolved: FormValue) => void
  onLoadingStateChange?: (loadingState: FormValue) => void
}

export interface UseReferenceResolutionResult {
  resolvedValue: FormValue
  loadingState: FormValue
}

export function useReferenceResolution({
  value,
  fields,
  branch,
  onResolvedValueChange,
  onLoadingStateChange,
}: UseReferenceResolutionOptions): UseReferenceResolutionResult {
  const resolvedCache = useRef<Map<string, unknown>>(new Map())
  const prevValueRef = useRef<FormValue>({}) // Track previous value for change detection
  const lastNotifiedValueRef = useRef<string>('') // Track last notified value to prevent infinite loops
  const [resolutionTrigger, setResolutionTrigger] = useState(0) // Trigger to force useMemo re-computation

  // Map field names to their types for fast lookup
  const referenceFieldNames = useMemo(() => {
    const names = new Set<string>()
    for (const field of fields) {
      if (field.type === 'reference') {
        names.add(field.name)
      }
    }
    return names
  }, [fields])

  /**
   * PHASE 1: SYNCHRONOUS RESOLUTION
   *
   * Compute resolved value by applying cached reference data to form value.
   * This runs synchronously during render (useMemo), so there are no async gaps.
   *
   * For each reference field:
   * - If ID is in cache: substitute full object
   * - If ID not in cache: keep the ID (loading state)
   *
   * Dependencies include resolutionTrigger, which is incremented when cache updates,
   * forcing this to re-run and pick up newly-resolved data.
   */
  const resolvedValue = useMemo(() => {
    const result = { ...value }

    // Synchronously apply cached resolutions
    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        if (Array.isArray(fieldValue)) {
          // List of references
          result[fieldName] = fieldValue.map((id) => {
            if (typeof id === 'string') {
              const cached = resolvedCache.current.get(`${branch}:${id}`)
              // Return cached object, or null if not yet resolved
              return cached || null
            }
            return id
          })
        } else if (typeof fieldValue === 'string') {
          // Single reference
          const cached = resolvedCache.current.get(`${branch}:${fieldValue}`)
          // Return cached object, or null if not yet resolved
          result[fieldName] = cached || null
        }
      }
    }

    return result
  }, [value, branch, resolutionTrigger, referenceFieldNames])

  /**
   * Compute loading state that mirrors the data structure.
   * For each reference field, track if it's currently loading (not in cache).
   */
  const loadingState = useMemo(() => {
    const result: FormValue = {}

    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        if (Array.isArray(fieldValue)) {
          // List of references - return array of booleans
          result[fieldName] = fieldValue.map((id) => {
            if (typeof id === 'string') {
              return !resolvedCache.current.has(`${branch}:${id}`)
            }
            return false
          })
        } else if (typeof fieldValue === 'string') {
          // Single reference - return boolean
          result[fieldName] = !resolvedCache.current.has(`${branch}:${fieldValue}`)
        } else {
          result[fieldName] = false
        }
      } else {
        result[fieldName] = false
      }
    }

    return result
  }, [value, branch, resolutionTrigger, referenceFieldNames])

  /**
   * PHASE 2: BACKGROUND ASYNC RESOLUTION
   *
   * Find reference IDs that aren't in cache yet and fetch them from the API.
   */
  useEffect(() => {
    // Find all uncached reference IDs
    const uncachedIds = new Set<string>()

    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        const ids = Array.isArray(fieldValue) ? fieldValue : [fieldValue]
        for (const id of ids) {
          if (typeof id === 'string' && !resolvedCache.current.has(`${branch}:${id}`)) {
            uncachedIds.add(id)
          }
        }
      }
    }

    if (uncachedIds.size === 0) {
      prevValueRef.current = value
      return
    }

    // Debounce API calls to batch multiple rapid changes
    const timeout = setTimeout(async () => {
      try {
        // Resolve uncached IDs via API
        const updates = await resolveChangedReferences(
          prevValueRef.current,
          value,
          fields,
          branch,
          resolvedCache.current,
        )

        // Update cache with resolved values
        for (const [fieldName, resolvedFieldValue] of Object.entries(updates)) {
          if (Array.isArray(resolvedFieldValue)) {
            resolvedFieldValue.forEach((obj, idx) => {
              const fieldValue = value[fieldName]
              if (Array.isArray(fieldValue)) {
                const id = fieldValue[idx]
                if (typeof obj === 'object' && obj !== null && typeof id === 'string') {
                  resolvedCache.current.set(`${branch}:${id}`, obj)
                }
              }
            })
          } else if (typeof resolvedFieldValue === 'object' && resolvedFieldValue !== null) {
            const id = value[fieldName] as string
            if (typeof id === 'string') {
              resolvedCache.current.set(`${branch}:${id}`, resolvedFieldValue)
            }
          }
        }

        // Trigger useMemo re-computation
        setResolutionTrigger((prev) => prev + 1)
        prevValueRef.current = value
      } catch (error) {
        console.error('Reference resolution failed:', error)
      }
    }, 300) // 300ms debounce

    return () => clearTimeout(timeout)
  }, [value, fields, branch, referenceFieldNames])

  // Clear cache when branch changes
  useEffect(() => {
    resolvedCache.current.clear()
    setResolutionTrigger((prev) => prev + 1) // Trigger re-computation with empty cache
  }, [branch])

  // Notify parent of resolved value changes (with infinite loop prevention)
  useEffect(() => {
    const serialized = JSON.stringify(resolvedValue)
    if (serialized !== lastNotifiedValueRef.current) {
      lastNotifiedValueRef.current = serialized
      onResolvedValueChange?.(resolvedValue)
    }
  }, [resolvedValue, onResolvedValueChange])

  // Notify parent of loading state changes
  const lastNotifiedLoadingRef = useRef<string>('')
  useEffect(() => {
    const serialized = JSON.stringify(loadingState)
    if (serialized !== lastNotifiedLoadingRef.current) {
      lastNotifiedLoadingRef.current = serialized
      onLoadingStateChange?.(loadingState)
    }
  }, [loadingState, onLoadingStateChange])

  return {
    resolvedValue,
    loadingState,
  }
}
