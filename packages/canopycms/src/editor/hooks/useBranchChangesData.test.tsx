import { act, renderHook, waitFor } from '@testing-library/react'
import { useSWRConfig } from 'swr'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { BranchChangesData, BranchChangesResponse } from '../../api/branch-changes'
import { createApiClientWrapper } from './__test__/test-utils'
import { useBranchChangesData } from './useBranchChangesData'

const answer = (logicalPath: string): BranchChangesData => ({
  base: 'main',
  entries: [
    {
      status: 'modified',
      logicalPath,
      contentId: 'aB3cD4eF5gH6',
      collectionPath: 'content',
      entryType: 'page',
    },
  ],
  collections: [],
  hiddenChanges: false,
})

let client: MockApiClient

beforeEach(() => {
  client = createMockApiClient()
})

const renderChanges = (branch = 'feature', enabled = true) =>
  renderHook(({ branch, enabled }) => useBranchChangesData(client as never, branch, enabled), {
    wrapper: createApiClientWrapper(client),
    initialProps: { branch, enabled },
  })

describe('useBranchChangesData', () => {
  it('loads the branch’s changes', async () => {
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    const { result } = renderChanges()
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.data).toEqual(answer('content/a')))
    expect(client.changes.list).toHaveBeenCalledWith({ branch: 'feature' })
    expect(result.current.error).toBeUndefined()
  })

  it('fetches nothing while disabled or branchless, then loads once enabled', async () => {
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    const { result, rerender } = renderChanges('feature', false)
    await act(() => result.current.reload())
    rerender({ branch: '', enabled: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.changes.list).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ data: undefined, error: undefined, isLoading: false })

    rerender({ branch: 'feature', enabled: true })
    await waitFor(() => expect(result.current.data).toEqual(answer('content/a')))
  })

  it('reloads with a fresh fetch and replaces the data', async () => {
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    const { result } = renderChanges()
    await waitFor(() => expect(result.current.data).toBeDefined())
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/b') })
    await act(() => result.current.reload())
    expect(client.changes.list).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual(answer('content/b'))
  })

  it('maps a 409 to syncing and anything else to failed, keeping the data loaded before', async () => {
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    const { result } = renderChanges()
    await waitFor(() => expect(result.current.data).toBeDefined())

    client.changes.list.mockResolvedValue({ ok: false, status: 409, error: 'syncing' })
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({ kind: 'syncing' })
    expect(result.current.data).toEqual(answer('content/a'))

    client.changes.list.mockResolvedValue({ ok: false, status: 500, error: 'Disk full' })
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Disk full' })

    // The same answer as before: SWR keeps its data's identity, yet the error still clears.
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    await act(() => result.current.reload())
    expect(result.current.error).toBeUndefined()
    expect(result.current.data).toEqual(answer('content/a'))
  })

  it('reports a failed first load', async () => {
    client.changes.list.mockResolvedValue({ ok: false, status: 409, error: 'syncing' })
    const { result } = renderChanges()
    await waitFor(() => expect(result.current.error).toEqual({ kind: 'syncing' }))
    expect(result.current.data).toBeUndefined()
  })
})

describe('useBranchChangesData ordering', () => {
  it('never lets a reload that started before SWR’s latest fetch replace that fetch’s answer', async () => {
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/a') })
    const { result } = renderHook(
      () => ({
        changes: useBranchChangesData(client as never, 'feature', true),
        swr: useSWRConfig(),
      }),
      { wrapper: createApiClientWrapper(client) },
    )
    await waitFor(() => expect(result.current.changes.data).toEqual(answer('content/a')))

    let settleReload: (value: BranchChangesResponse) => void = () => {}
    client.changes.list.mockImplementationOnce(
      () => new Promise((resolve) => (settleReload = resolve)),
    )
    let reloading: Promise<void> = Promise.resolve()
    act(() => {
      reloading = result.current.changes.reload()
    })
    client.changes.list.mockResolvedValue({ ok: true, status: 200, data: answer('content/newer') })
    await act(() => result.current.swr.mutate('canopy:changes:feature'))
    await waitFor(() => expect(result.current.changes.data).toEqual(answer('content/newer')))

    await act(async () => {
      settleReload({ ok: true, status: 200, data: answer('content/older') })
      await reloading
    })
    expect(result.current.changes.data).toEqual(answer('content/newer'))
  })
})
