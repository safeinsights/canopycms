'use client'

/**
 * SWR-backed read of the branches list (GET /branches).
 *
 * Not parameterized by the currently selected branch: the endpoint returns
 * every branch regardless of which one is active, so a single cache key
 * covers the whole editor session. useBranchManager.tsx consumes this for
 * the automatic on-mount fetch (SWR dedupes concurrent mounts -- e.g. React
 * Strict Mode's double effect invoke -- into a single request); its
 * imperative `loadBranches()` reload path fetches independently and writes
 * the result into this same cache key via `mutate(..., { revalidate: false
 * })` -- see the comment on `fetchBranches` for why it doesn't just call
 * `mutate()` to revalidate.
 */

import useSWR, { type SWRResponse } from 'swr'
import type { ApiClient } from '../context'
import type { BranchListItem } from '../../api/branch'

/** Cache key for the branches list. */
export const BRANCHES_KEY = 'canopy:branches'

export interface BranchesData {
  branches: BranchListItem[]
  defaultBranch?: string
}

/**
 * Fetch the branches list. Exported for direct testing and for the
 * imperative reload path.
 */
export async function fetchBranches(apiClient: Pick<ApiClient, 'branches'>): Promise<BranchesData> {
  const result = await apiClient.branches.list()
  if (result.status === 404) {
    // No branch endpoint available; stay branchless rather than erroring --
    // the branch dropdown stays clickable so the user can retry from there.
    return { branches: [] }
  }
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to load branches: ${result.status}`)
  }
  return { branches: result.data?.branches ?? [], defaultBranch: result.data?.defaultBranch }
}

/**
 * How often to re-poll while at least one branch is mid-flight, in ms.
 * Only ever active in the transient window below, so this is not a
 * standing background poll.
 */
export const IN_FLIGHT_POLL_MS = 15_000

/**
 * Whether any branch is in a state the WORKER, not the user, will move on.
 *
 * `pending-sync` -> `synced` | `sync-failed` happens asynchronously on the
 * EC2 worker when it drains the task queue, with nothing pushed to the
 * browser. Before SWR, the branches list happened to refetch on every
 * branch switch, so these badges (PR #160) converged incidentally as the
 * user moved around. That effect is gone now -- correctly, since the list
 * isn't branch-scoped -- so without this a user who submits a branch would
 * watch "Pending sync" forever until they reloaded the page or performed
 * some unrelated branch mutation.
 */
export function hasInFlightBranch(data: BranchesData | undefined): boolean {
  return (data?.branches ?? []).some((b) => b.syncStatus === 'pending-sync')
}

/**
 * SWR-backed read of the branches list. Automatically dedupes concurrent
 * mounts into a single request (see the module doc comment above).
 *
 * Polls ONLY while a branch is waiting on the worker (see
 * `hasInFlightBranch`); once everything has settled the interval returns to
 * 0 and the list goes quiet again. This is strictly narrower than a blanket
 * `refreshInterval`, and narrower than the pre-SWR behavior it replaces.
 */
export function useBranchesData(
  apiClient: Pick<ApiClient, 'branches'>,
): SWRResponse<BranchesData, Error> {
  return useSWR(BRANCHES_KEY, () => fetchBranches(apiClient), {
    refreshInterval: (data: BranchesData | undefined) =>
      hasInFlightBranch(data) ? IN_FLIGHT_POLL_MS : 0,
  })
}
