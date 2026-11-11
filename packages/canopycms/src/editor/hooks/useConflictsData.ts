'use client'

/**
 * SWR-backed reads of the conflicts a merge left on a branch (api/merge-conflicts.ts): the list,
 * for Submit's reason, the bar's badge and an entry's notice, and one entry's conflicts for its
 * "Show changes" drawer. A null key fetches nothing.
 */

import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import type { ApiClient } from '../context'
import type { EntryConflictData, MergeConflictsData } from '../../api/merge-conflicts'

const KEY_PREFIX = 'canopy:conflicts:'

/**
 * The list's key. It carries what the branch listing says is open (`conflictFiles`), so a
 * listing that changes it reads the list again.
 */
const listKey = (branch: string, open: readonly string[]): string =>
  `${KEY_PREFIX}${branch}|${open.join(',')}`

/** An entry's key, under its branch's prefix and a `:`, which no branch name holds. */
const entryKey = (branch: string, target: EntryConflictTarget): string =>
  `${KEY_PREFIX}${branch}:${target.logicalPath}${target.id ? `#${target.id}` : ''}`

export interface EntryConflictTarget {
  logicalPath: string
  /** The entry's content id, which tells it from a collection at the same path. */
  id?: string
}

class ConflictsLoadError extends Error {}

export interface ConflictsState<T> {
  data: T | undefined
  /** Why the last read failed, in the server's words where it gave some. */
  error: string | undefined
  isValidating: boolean
  reload: () => Promise<void>
}

/**
 * The branch's open conflicts, read while its listing names any (`conflictFiles`); undefined
 * otherwise, which means none.
 */
export function useBranchConflictsData(
  apiClient: Pick<ApiClient, 'conflicts'>,
  branch: string,
  conflictFiles: readonly string[] | undefined,
): ConflictsState<MergeConflictsData> {
  const key = branch && conflictFiles?.length ? listKey(branch, conflictFiles) : null
  const swr = useSWR(key, async (): Promise<MergeConflictsData> => {
    const result = await apiClient.conflicts.list({ branch })
    if (result.ok && result.data && Array.isArray(result.data.conflicts)) return result.data
    throw new ConflictsLoadError(result.error ?? `HTTP ${result.status}`)
  })
  const { mutate } = swr
  const { mutate: mutateKeys } = useSWRConfig()
  const reload = useCallback(async () => {
    const prefix = `${KEY_PREFIX}${branch}`
    await Promise.all([
      mutate(),
      mutateKeys(
        (k) => typeof k === 'string' && (k.startsWith(`${prefix}:`) || k.startsWith(`${prefix}|`)),
      ),
    ])
  }, [mutate, mutateKeys, branch])
  return {
    data: key ? swr.data : undefined,
    error: key && swr.error instanceof Error ? swr.error.message : undefined,
    isValidating: swr.isValidating,
    reload,
  }
}

/**
 * One entry's conflicts, read while `target` is set (its drawer is open): null when it has none,
 * which the API answers with a 404.
 */
export function useEntryConflictData(
  apiClient: Pick<ApiClient, 'conflicts'>,
  branch: string,
  target: EntryConflictTarget | undefined,
): ConflictsState<EntryConflictData | null> {
  const key = branch && target ? entryKey(branch, target) : null
  const swr = useSWR(key, async (): Promise<EntryConflictData | null> => {
    if (!target) return null
    const result = await apiClient.conflicts.entry({
      branch,
      entryPath: target.logicalPath,
      ...(target.id && { id: target.id }),
    })
    if (result.ok && result.data && Array.isArray(result.data.fields)) return result.data
    if (result.status === 404) return null
    throw new ConflictsLoadError(result.error ?? `HTTP ${result.status}`)
  })
  const { mutate } = swr
  const reload = useCallback(async () => {
    await mutate()
  }, [mutate])
  return {
    data: key ? swr.data : undefined,
    error: key && swr.error instanceof Error ? swr.error.message : undefined,
    isValidating: swr.isValidating,
    reload,
  }
}
