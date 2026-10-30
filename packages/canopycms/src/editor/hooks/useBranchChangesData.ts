'use client'

/**
 * SWR-backed reads of what a branch changes against its base: the list (GET /:branch/changes)
 * for the Content panel's Changed filter, and one entry's two sides (GET
 * /:branch/changes/...entryPath) for its "Show changes" drawer. Keyed per branch like
 * useCommentsData.ts; a null key fetches nothing.
 */

import { useCallback, useRef } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import type { ApiClient } from '../context'
import type { BranchChangesData } from '../../api/branch-changes'
import type { BranchEntryChangeData } from '../../api/branch-entry-changes'

const KEY_PREFIX = 'canopy:changes:'

/** Cache key for a branch's changes against its base. */
const branchChangesKey = (branch: string): string => `${KEY_PREFIX}${branch}`

/** An entry's change on the branch, and where a move started. */
export interface EntryChangeTarget {
  logicalPath: string
  /** A moved entry's path at the base. */
  from?: string
  /** The entry's content id, so a slug another entry reuses isn't read as this one. */
  id?: string
}

/**
 * Cache key for one entry's change. Under its branch's list key and a `:`, which no branch name
 * holds, so a reload of the list finds every entry key of its branch by prefix.
 */
const entryChangeKey = (branch: string, target: EntryChangeTarget): string =>
  `${KEY_PREFIX}${branch}:${target.logicalPath}${target.from ? `?from=${target.from}` : ''}${
    target.id ? `#${target.id}` : ''
  }`

/**
 * Why a branch's changes could not be loaded: the branch moved under the read (a 409, nothing
 * lost; `message` is the server's) or anything else.
 */
export type BranchChangesError =
  | { kind: 'syncing'; message?: string }
  | { kind: 'failed'; message: string }

/**
 * Why an entry's change could not be loaded: as the list's, or a refusal no retry passes: too
 * large to compare (413), on neither side (404), or a side that doesn't parse (422).
 */
type EntryChangeError =
  | BranchChangesError
  | { kind: 'tooLarge'; message: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'unreadable'; message: string }

class ChangesLoadError<E extends { kind: string }> extends Error {
  constructor(readonly reason: E) {
    super(`Couldn't load the branch's changes (${reason.kind})`)
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
  throw new ChangesLoadError<BranchChangesError>(
    result.status === 409
      ? { kind: 'syncing', ...(result.error && { message: result.error }) }
      : { kind: 'failed', message: result.error ?? `HTTP ${result.status}` },
  )
}

async function fetchEntryChange(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
  target: EntryChangeTarget,
): Promise<BranchEntryChangeData> {
  const result = await apiClient.changes.entry({
    branch,
    entryPath: target.logicalPath,
    ...(target.from && { from: target.from }),
    ...(target.id && { id: target.id }),
  })
  if (result.ok && result.data && 'before' in result.data && 'after' in result.data) {
    return result.data
  }
  const message = result.error ?? `HTTP ${result.status}`
  throw new ChangesLoadError<EntryChangeError>(
    result.status === 409
      ? { kind: 'syncing', ...(result.error && { message: result.error }) }
      : result.status === 413
        ? { kind: 'tooLarge', message }
        : result.status === 404
          ? { kind: 'notFound', message }
          : result.status === 422
            ? { kind: 'unreadable', message }
            : { kind: 'failed', message },
  )
}

const toError = <E>(err: unknown): E | { kind: 'failed'; message: string } =>
  err instanceof ChangesLoadError
    ? (err.reason as E)
    : { kind: 'failed', message: err instanceof Error ? err.message : String(err) }

/**
 * `fetch` as an SWR fetcher that never lets an overtaken fetch's error show. SWR 2.4 drops an
 * overtaken fetch's result but still shows its error, so per key it counts the fetches started,
 * and one overtaken resolves with the last answer instead of throwing, which SWR then drops: a
 * newer fetch holds the key, or has finished.
 */
function useOvertakenGuard<T>(fetch: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const startsRef = useRef(new Map<string, number>())
  const answersRef = useRef(new Map<string, T>())
  return async (key: string) => {
    const started = (startsRef.current.get(key) ?? 0) + 1
    startsRef.current.set(key, started)
    try {
      const data = await fetch(key)
      answersRef.current.set(key, data)
      return data
    } catch (err) {
      if ((startsRef.current.get(key) ?? 0) > started) return answersRef.current.get(key) as T
      throw err
    }
  }
}

interface ChangesState<T, E> {
  data: T | undefined
  error: E | undefined
  isLoading: boolean
  isValidating: boolean
  /**
   * Starts a fresh fetch through SWR's revalidating `mutate()`, never coalesced with one in
   * flight; SWR keeps whichever fetch started last (hooks/README.md).
   */
  reload: () => Promise<void>
}

export type BranchChangesState = ChangesState<BranchChangesData, BranchChangesError>

/**
 * The branch's changes. `reload` also revalidates every entry change of the branch that is
 * shown, so one save refreshes the list and an open "Show changes" alike.
 */
export function useBranchChangesData(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
  enabled: boolean,
): BranchChangesState {
  const key = branch && enabled ? branchChangesKey(branch) : null
  const fetcher = useOvertakenGuard((cacheKey) =>
    // The branch is read from the key the fetch was started for, never from the render.
    fetchBranchChanges(apiClient, cacheKey.slice(KEY_PREFIX.length)),
  )
  const swr = useSWR(key, fetcher)
  const { mutate } = swr
  const { mutate: mutateKeys } = useSWRConfig()
  const reload = useCallback(async () => {
    const entryPrefix = `${branchChangesKey(branch)}:`
    await Promise.all([
      mutate(),
      mutateKeys((k) => typeof k === 'string' && k.startsWith(entryPrefix)),
    ])
  }, [mutate, mutateKeys, branch])

  return {
    data: swr.data,
    error: key && swr.error !== undefined ? toError<BranchChangesError>(swr.error) : undefined,
    isLoading: swr.isLoading,
    isValidating: swr.isValidating,
    reload,
  }
}

export type EntryChangeState = ChangesState<BranchEntryChangeData, EntryChangeError>

/** One entry's change on the branch, fetched while `target` is set (the drawer is open). */
export function useEntryChangeData(
  apiClient: Pick<ApiClient, 'changes'>,
  branch: string,
  target: EntryChangeTarget | undefined,
): EntryChangeState {
  const key = branch && target ? entryChangeKey(branch, target) : null
  // What each key fetches, recorded as it is rendered, so a fetch reads its own key's target.
  const targetsRef = useRef(new Map<string, { branch: string; target: EntryChangeTarget }>())
  if (key && target) targetsRef.current.set(key, { branch, target })
  const fetcher = useOvertakenGuard((cacheKey) => {
    const keyed = targetsRef.current.get(cacheKey)
    if (!keyed) throw new Error(`No entry change is keyed ${cacheKey}`)
    return fetchEntryChange(apiClient, keyed.branch, keyed.target)
  })
  const swr = useSWR(key, fetcher)
  const { mutate } = swr
  const reload = useCallback(async () => {
    await mutate()
  }, [mutate])

  return {
    data: swr.data,
    error: key && swr.error !== undefined ? toError<EntryChangeError>(swr.error) : undefined,
    isLoading: swr.isLoading,
    isValidating: swr.isValidating,
    reload,
  }
}
