/**
 * Regression tests for the branches-list poll window.
 *
 * The badges these drive (`pending-sync` -> `synced` | `sync-failed`) are moved
 * by the EC2 worker draining its task queue, with nothing pushed to the
 * browser. Before SWR, the list happened to refetch on every branch switch,
 * so they converged incidentally; that effect is gone, so the poll below is
 * now the only thing that lets a submitted branch stop saying "Pending sync"
 * without a page reload.
 */

import { describe, it, expect, vi } from 'vitest'
import { CanopyApiClient } from '../../api/client'
import { fetchBranches, hasInFlightBranch, IN_FLIGHT_POLL_MS } from './useBranchesData'
import type { BranchesData } from './useBranchesData'

const branches = (...statuses: (string | undefined)[]): BranchesData =>
  ({
    branches: statuses.map((syncStatus, i) => ({ name: `b${i}`, syncStatus })),
  }) as unknown as BranchesData

describe('useBranchesData poll window', () => {
  it('polls while a branch is waiting on the worker', () => {
    expect(hasInFlightBranch(branches('pending-sync'))).toBe(true)
    expect(hasInFlightBranch(branches('synced', 'pending-sync'))).toBe(true)
  })

  it('goes quiet once every branch has settled', () => {
    expect(hasInFlightBranch(branches('synced'))).toBe(false)
    // sync-failed is terminal: the worker will not move it on its own, so
    // polling for it would never stop.
    expect(hasInFlightBranch(branches('sync-failed'))).toBe(false)
    expect(hasInFlightBranch(branches('synced', 'sync-failed', undefined))).toBe(false)
  })

  it('does not poll before any data has loaded, or with no branches', () => {
    expect(hasInFlightBranch(undefined)).toBe(false)
    expect(hasInFlightBranch(branches())).toBe(false)
  })

  it('uses a poll interval long enough not to hammer the branch clone', () => {
    expect(IN_FLIGHT_POLL_MS).toBeGreaterThanOrEqual(10_000)
  })
})

describe('fetchBranches', () => {
  const clientAnswering = (status: number, json: () => Promise<unknown>) =>
    new CanopyApiClient({ fetch: vi.fn().mockResolvedValue({ ok: false, status, json }) })

  it('stays branchless when the API itself answers 404', async () => {
    const client = clientAnswering(404, async () => ({
      ok: false,
      status: 404,
      error: 'Not found',
    }))
    expect(await fetchBranches(client)).toEqual({ branches: [], receivedAt: expect.any(Number) })
  })

  // A proxy's 404 page means the API was never reached: a wrong base path, say.
  it('throws when a 404 came from in front of the API', async () => {
    const client = clientAnswering(404, () => Promise.reject(new SyntaxError('<html>')))
    await expect(fetchBranches(client)).rejects.toThrow(
      'Unexpected response from server (HTTP 404)',
    )
  })
})
