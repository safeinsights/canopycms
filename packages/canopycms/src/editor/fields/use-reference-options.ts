'use client'

import { useEffect, useState } from 'react'

import { createApiClient } from '../../api/client'
import { getErrorMessage } from '../../utils/error'
import { useOptionalApiClient } from '../context'

/** An entry a reference field can point at. */
export interface ReferenceOption {
  value: string
  label: string
}

/** The id a stored reference holds: the id itself, or a resolved read's `{ id, … }`. */
export const extractId = (val: unknown): string => {
  if (typeof val === 'string') return val
  if (val && typeof val === 'object' && 'id' in val && typeof val.id === 'string') return val.id
  return ''
}

/** Label for a set value the options omit (a restricted, missing or unlisted target). */
export function unlistedReferenceLabel(value: unknown, id: string): string {
  if (value && typeof value === 'object' && 'unavailable' in value && value.unavailable === true) {
    if ('reason' in value && value.reason === 'restricted' && 'title' in value) {
      return `Restricted entry: ${String(value.title)}`
    }
    return `Missing entry (${id})`
  }
  return `Unavailable entry (${id})`
}

export interface ReferenceOptionsQuery {
  /** Used as given, with no fetch. */
  staticOptions?: ReferenceOption[]
  collections?: string[]
  entryTypes?: string[]
  displayField: string
  branch: string
}

export interface ReferenceOptions {
  options: ReferenceOption[]
  loading: boolean
  error: string | null
  retry: () => void
}

/**
 * The entries a reference field offers: `staticOptions` as given, else one request per field to
 * the reference-options endpoint, made again only when the query or the API client changes, or on
 * `retry`.
 */
export function useReferenceOptions({
  staticOptions,
  collections,
  entryTypes,
  displayField,
  branch,
}: ReferenceOptionsQuery): ReferenceOptions {
  // `null` outside an ApiClientProvider (some stories), so the fetch falls back to a
  // default-configured client.
  const contextApiClient = useOptionalApiClient()
  const hasCollections = !!collections && collections.length > 0
  const hasEntryTypes = !!entryTypes && entryTypes.length > 0
  const needsFetch = !staticOptions && (hasCollections || hasEntryTypes)
  const [fetched, setFetched] = useState<ReferenceOption[]>([])
  const [loading, setLoading] = useState(needsFetch)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  // A changed query starts loading in the same render, so no stale option list shows meanwhile.
  const [prevFetchKey, setPrevFetchKey] = useState('')
  const fetchKey = needsFetch
    ? `${collections?.join(',') ?? ''}:${entryTypes?.join(',') ?? ''}:${displayField}:${branch}`
    : ''
  if (fetchKey !== prevFetchKey) {
    setPrevFetchKey(fetchKey)
    if (needsFetch) {
      setLoading(true)
      setError(null)
    }
  }

  // Keyed on `fetchKey`, not the `collections`/`entryTypes` arrays, which the parent rebuilds on
  // every render, so those and `displayField`/`branch` are left out of the deps on purpose.
  // `active` drops a response a newer request or an unmount has superseded.
  useEffect(() => {
    if (!needsFetch) return
    let active = true
    const apiClient = contextApiClient ?? createApiClient()

    const params: Record<string, string> = { branch, displayField }
    if (collections && collections.length > 0) params.collections = collections.join(',')
    if (entryTypes && entryTypes.length > 0) params.entryTypes = entryTypes.join(',')

    apiClient.content
      .getReferenceOptions(params)
      .then((response) => {
        if (!active) return
        if (response.ok && response.data?.options) {
          setFetched(response.data.options.map((opt) => ({ value: opt.id, label: opt.label })))
        } else {
          setError(response.error || 'Failed to load reference options')
        }
      })
      .catch((err) => {
        if (!active) return
        console.error('Failed to load reference options:', err)
        setError(getErrorMessage(err))
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [needsFetch, fetchKey, retryCount, contextApiClient])

  const retry = () => {
    setLoading(true)
    setError(null)
    setRetryCount((count) => count + 1)
  }

  return {
    options: staticOptions ?? fetched,
    loading: needsFetch && loading,
    error: needsFetch ? error : null,
    retry,
  }
}
