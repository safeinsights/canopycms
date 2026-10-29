import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { BranchChangesData, BranchChangesResponse } from '../../api/branch-changes'
import type {
  BranchEntryChangeData,
  BranchEntryChangeResponse,
} from '../../api/branch-entry-changes'
import { createApiClientWrapper } from './__test__/test-utils'
import {
  useBranchChangesData,
  useEntryChangeData,
  type EntryChangeTarget,
} from './useBranchChangesData'

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
const ok = (logicalPath: string): BranchChangesResponse => ({
  ok: true,
  status: 200,
  data: answer(logicalPath),
})
const failed: BranchChangesResponse = { ok: false, status: 500, error: 'Disk full' }

let client: MockApiClient

beforeEach(() => {
  client = createMockApiClient()
})

const renderChanges = (branch = 'feature', enabled = true) =>
  renderHook(({ branch, enabled }) => useBranchChangesData(client as never, branch, enabled), {
    wrapper: createApiClientWrapper(client),
    initialProps: { branch, enabled },
  })

/** The next request, held until the returned function settles it. */
const holdNext = () => {
  let settle: (value: BranchChangesResponse) => void = () => {}
  client.changes.list.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)))
  return (value: BranchChangesResponse) => settle(value)
}

/** The hook with `content/a` loaded. */
const renderLoaded = async () => {
  client.changes.list.mockResolvedValue(ok('content/a'))
  const rendered = renderChanges()
  await waitFor(() => expect(rendered.result.current.data).toEqual(answer('content/a')))
  return rendered
}

describe('useBranchChangesData', () => {
  it('loads the branch’s changes', async () => {
    client.changes.list.mockResolvedValue(ok('content/a'))
    const { result } = renderChanges()
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.data).toEqual(answer('content/a')))
    expect(client.changes.list).toHaveBeenCalledWith({ branch: 'feature' })
    expect(result.current.error).toBeUndefined()
  })

  it('fetches nothing while disabled or branchless, then loads once enabled', async () => {
    client.changes.list.mockResolvedValue(ok('content/a'))
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
    const { result } = await renderLoaded()
    client.changes.list.mockResolvedValue(ok('content/b'))
    await act(() => result.current.reload())
    expect(client.changes.list).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual(answer('content/b'))
  })

  it('maps a 409 to syncing with the server’s words, and anything else to failed', async () => {
    const { result } = await renderLoaded()
    client.changes.list.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'This branch changed while its changes were being read. Try again in a moment.',
    })
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({
      kind: 'syncing',
      message: 'This branch changed while its changes were being read. Try again in a moment.',
    })
    client.changes.list.mockResolvedValue(failed)
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Disk full' })
  })

  it('shows a failing reload’s error over the data it had, and Retry clears it', async () => {
    const { result } = await renderLoaded()
    client.changes.list.mockResolvedValue(failed)
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Disk full' })
    // SWR keeps the last data beside an error.
    expect(result.current.data).toEqual(answer('content/a'))

    client.changes.list.mockResolvedValue(ok('content/b'))
    await act(() => result.current.reload())
    expect(result.current.error).toBeUndefined()
    expect(result.current.data).toEqual(answer('content/b'))
  })

  it('reports a failed first load', async () => {
    client.changes.list.mockResolvedValue({ ok: false, status: 409, error: 'syncing' })
    const { result } = renderChanges()
    await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'syncing' }))
    expect(result.current.data).toBeUndefined()
  })
})

describe('useBranchChangesData ordering', () => {
  it('shows a reload’s answer over the automatic fetch it overtook, whenever that settles', async () => {
    const settleFirst = holdNext()
    const { result } = renderChanges()
    client.changes.list.mockResolvedValue(ok('content/reload'))
    await act(() => result.current.reload())
    expect(result.current.data).toEqual(answer('content/reload'))
    await act(async () => settleFirst(ok('content/first')))
    expect(result.current.data).toEqual(answer('content/reload'))
  })

  it('shows no error from an older fetch that fails after a newer one succeeded', async () => {
    const settleFirst = holdNext()
    const { result } = renderChanges()
    client.changes.list.mockResolvedValue(ok('content/reload'))
    await act(() => result.current.reload())
    await act(async () => settleFirst(failed))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.error).toBeUndefined()
    expect(result.current.data).toEqual(answer('content/reload'))
  })

  it('keeps a fetch that outlives a branch switch on its own branch', async () => {
    const settleA = holdNext()
    const { result, rerender } = renderChanges('a')
    client.changes.list.mockResolvedValue(ok('content/b'))
    rerender({ branch: 'b', enabled: true })
    await waitFor(() => expect(result.current.data).toEqual(answer('content/b')))
    await act(async () => settleA(ok('content/a')))
    expect(result.current.data).toEqual(answer('content/b'))
    expect(client.changes.list.mock.calls.map(([params]) => params)).toEqual([
      { branch: 'a' },
      { branch: 'b' },
    ])

    client.changes.list.mockResolvedValue(ok('content/b2'))
    await act(() => result.current.reload())
    expect(client.changes.list).toHaveBeenLastCalledWith({ branch: 'b' })
    rerender({ branch: 'a', enabled: true })
    await waitFor(() => expect(result.current.data).toEqual(answer('content/a')))
  })

  it('shows a later failed reload’s error over the newest data, not stale data', async () => {
    // An automatic fetch, overtaken by a reload, settles late with older data; a reload then fails.
    const settleFirst = holdNext()
    const { result } = renderChanges()
    client.changes.list.mockResolvedValue(ok('content/new'))
    await act(() => result.current.reload())
    await act(async () => settleFirst(ok('content/stale')))
    client.changes.list.mockResolvedValue(failed)
    await act(() => result.current.reload())
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Disk full' })
    expect(result.current.data).toEqual(answer('content/new'))
  })
})

const entrySides = (title: string): BranchEntryChangeData => ({
  before: { format: 'json', entryType: 'page', data: { title: 'Before' } },
  after: { format: 'json', entryType: 'page', data: { title } },
  mergeBaseSha: 'a'.repeat(40),
})
const entryOk = (title: string): BranchEntryChangeResponse => ({
  ok: true,
  status: 200,
  data: entrySides(title),
})

describe('useEntryChangeData', () => {
  const renderEntry = (target: EntryChangeTarget | undefined) =>
    renderHook(({ target }) => useEntryChangeData(client as never, 'feature', target), {
      wrapper: createApiClientWrapper(client),
      initialProps: { target },
    })

  it('fetches nothing until it has a target, then reads it, `from` included', async () => {
    client.changes.entry.mockResolvedValue(entryOk('After'))
    const { result, rerender } = renderEntry(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.changes.entry).not.toHaveBeenCalled()

    rerender({ target: { logicalPath: 'content/b', from: 'content/a', id: 'aB3cD4eF5gH6' } })
    await waitFor(() => expect(result.current.data).toEqual(entrySides('After')))
    expect(client.changes.entry).toHaveBeenCalledWith({
      branch: 'feature',
      entryPath: 'content/b',
      from: 'content/a',
      id: 'aB3cD4eF5gH6',
    })
  })

  it.each([
    [409, { kind: 'syncing', message: 'Being synced.' }],
    [413, { kind: 'tooLarge', message: 'Being synced.' }],
    [404, { kind: 'unavailable', message: 'Being synced.' }],
    [422, { kind: 'unavailable', message: 'Being synced.' }],
    [503, { kind: 'failed', message: 'Being synced.' }],
  ])('maps a %i to its kind', async (status, error) => {
    client.changes.entry.mockResolvedValue({ ok: false, status, error: 'Being synced.' })
    const { result } = renderEntry({ logicalPath: 'content/a' })
    await waitFor(() => expect(result.current.error).toEqual(error))
  })

  it('reloads when the branch’s list of changes reloads', async () => {
    client.changes.list.mockResolvedValue(ok('content/a'))
    client.changes.entry.mockResolvedValue(entryOk('First'))
    const { result } = renderHook(
      () => ({
        list: useBranchChangesData(client as never, 'feature', true),
        entry: useEntryChangeData(client as never, 'feature', { logicalPath: 'content/a' }),
        other: useEntryChangeData(client as never, 'other', { logicalPath: 'content/a' }),
      }),
      { wrapper: createApiClientWrapper(client) },
    )
    await waitFor(() => expect(result.current.entry.data).toEqual(entrySides('First')))
    await waitFor(() => expect(result.current.other.data).toBeDefined())
    expect(client.changes.entry).toHaveBeenCalledTimes(2)

    client.changes.entry.mockResolvedValue(entryOk('Second'))
    await act(() => result.current.list.reload())
    await waitFor(() => expect(result.current.entry.data).toEqual(entrySides('Second')))
    // Another branch's entry change is left alone.
    expect(client.changes.entry).toHaveBeenCalledTimes(3)
    expect(client.changes.entry).toHaveBeenLastCalledWith({
      branch: 'feature',
      entryPath: 'content/a',
    })
  })
})
