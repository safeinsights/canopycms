import { act, renderHook, waitFor } from '@testing-library/react'
import { useSWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifications } from '@mantine/notifications'
import { useBaseUpdate, type UseBaseUpdateOptions } from './useBaseUpdate'
import { BRANCHES_KEY, useBranchesData } from './useBranchesData'
import { useApiClient } from '../context'
import type { BranchListItem } from '../../api/branch'
import type { LastBaseUpdate } from '../../types'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import { createApiClientWrapper } from './__test__/test-utils'

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}))

const NAME = 'content/spring'

const editing = (over: Partial<BranchListItem> = {}): BranchListItem => ({
  name: NAME,
  status: 'editing',
  access: {},
  createdBy: 'u1',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  isProtected: false,
  ...over,
})

/** The open branch as the branch list holds it, the way Editor.tsx feeds the hook. */
function useHarness(options: Omit<UseBaseUpdateOptions, 'branch'>) {
  const api = useApiClient()
  const { data } = useBranchesData(api)
  const { mutate } = useSWRConfig()
  const branch = data?.branches.find((b) => b.name === NAME)
  return { ...useBaseUpdate({ ...options, branch }), branch, reload: () => mutate(BRANCHES_KEY) }
}

describe('useBaseUpdate', () => {
  let client: MockApiClient
  let listed: BranchListItem

  const listing = () => ({
    ok: true,
    status: 200,
    data: { branches: [listed], users: [], serverTime: Date.now() },
  })
  const render = (over: Partial<Omit<UseBaseUpdateOptions, 'branch'>> = {}) => {
    const onUpdated = vi.fn()
    const hook = renderHook(
      () =>
        useHarness({
          operatingMode: 'prod',
          permitted: true,
          unsavedCount: 0,
          onUpdated,
          ...over,
        }),
      { wrapper: createApiClientWrapper(client) },
    )
    return { ...hook, onUpdated }
  }
  const shown = () => vi.mocked(notifications.show).mock.calls.map(([n]) => n)

  beforeEach(() => {
    vi.mocked(notifications.show).mockClear()
    client = createMockApiClient()
    listed = editing()
    client.branches.list.mockImplementation(async () => listing())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies to an editing branch the user may act on, where a worker answers', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())
    expect(result.current.available).toBe(true)
  })

  it.each([
    ['dev mode, with no worker', { operatingMode: 'dev' as const }, editing()],
    ['a user who may not act on it', { permitted: false }, editing()],
    ['a branch in review', {}, editing({ status: 'submitted' })],
    ['the protected base branch', {}, editing({ isProtected: true })],
  ])('does not apply in %s', async (_case, over, branch) => {
    listed = branch
    const { result } = render(over)
    await waitFor(() => expect(result.current.branch).toBeDefined())
    expect(result.current.available).toBe(false)
  })

  it('waits for unsaved changes to be saved first', async () => {
    const { result } = render({ unsavedCount: 2 })
    await waitFor(() => expect(result.current.branch).toBeDefined())
    expect(result.current.blockedReason).toBe('Save your changes first.')
  })

  it('asks, waits read-only, and reports the answer once it lands', async () => {
    const requestedAt = new Date().toISOString()
    client.workflow.updateFromBase.mockResolvedValue({
      ok: true,
      status: 202,
      data: { requestedAt, branch: editing({ baseUpdateRequestedAt: requestedAt }) },
    })
    const { result, onUpdated } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())

    await act(() => result.current.request())
    expect(client.workflow.updateFromBase).toHaveBeenCalledWith({ branch: NAME })
    expect(result.current.wait).toBe('waiting')

    const answer: LastBaseUpdate = { at: requestedAt, outcome: 'merged', baseSha: 'abc' }
    listed = editing({ baseUpdateRequestedAt: requestedAt, lastBaseUpdate: answer })
    await act(() => result.current.reload())

    await waitFor(() => expect(result.current.wait).toBe('none'))
    expect(shown()).toContainEqual(
      expect.objectContaining({ color: 'green', message: 'Latest changes added' }),
    )
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('keeps a failure up, with Retry, and re-reads nothing', async () => {
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result, onUpdated } = render()
    await waitFor(() => expect(result.current.wait).toBe('waiting'))

    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'failed' },
    })
    await act(() => result.current.reload())

    await waitFor(() => expect(shown()).toHaveLength(1))
    expect(shown()[0]).toMatchObject({ color: 'red', autoClose: false })
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('stays quiet when a reload finds the request already answered', async () => {
    const requestedAt = new Date().toISOString()
    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'merged' },
    })
    const { result } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())
    expect(result.current.wait).toBe('none')
    expect(shown()).toHaveLength(0)
  })

  it('unlocks the form after two minutes without an answer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result } = render()
    await vi.waitFor(() => expect(result.current.wait).toBe('waiting'))

    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000 + 100))
    expect(result.current.wait).toBe('slow')
  })

  it('keeps polling through a failed read of the branch list', async () => {
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    let calls = 0
    client.branches.list.mockImplementation(async () => {
      calls++
      if (calls === 2) return { ok: false, status: 502, error: 'Bad gateway' }
      return listing()
    })
    const { result } = render()
    await waitFor(() => expect(result.current.wait).toBe('waiting'))

    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'merged' },
    })
    // The second read fails; the third, 3 s later, brings the answer.
    await waitFor(() => expect(result.current.wait).toBe('none'), { timeout: 9000 })
    expect(calls).toBeGreaterThanOrEqual(3)
  }, 15_000)

  it("times the wait by the server's clock, not the browser's", async () => {
    // The browser runs 20 minutes ahead of the server that stamped the request.
    const serverNow = Date.now() - 20 * 60_000
    const requestedAt = new Date(serverNow).toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    client.branches.list.mockImplementation(async () => ({
      ...listing(),
      data: { ...listing().data, serverTime: serverNow },
    }))
    const { result } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())
    expect(result.current.wait).toBe('waiting')
  })

  it('says when it stops waiting, and still reports an answer that lands later', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result, onUpdated } = render()
    await vi.waitFor(() => expect(result.current.wait).toBe('waiting'))

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 + 100))
    expect(result.current.wait).toBe('none')
    expect(shown()).toContainEqual(expect.objectContaining({ color: 'yellow' }))

    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'merged' },
    })
    await act(() => result.current.reload())
    await vi.waitFor(() =>
      expect(shown()).toContainEqual(expect.objectContaining({ message: 'Latest changes added' })),
    )
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while there are unsaved changes, whatever calls it', async () => {
    const { result } = render({ unsavedCount: 1 })
    await waitFor(() => expect(result.current.branch).toBeDefined())
    await act(() => result.current.request())
    expect(client.workflow.updateFromBase).not.toHaveBeenCalled()
    expect(shown()[0]).toMatchObject({ color: 'yellow', message: 'Save your changes first.' })
  })

  it('keeps waiting when a listing fetched before the request lands after it', async () => {
    const requestedAt = new Date().toISOString()
    client.workflow.updateFromBase.mockResolvedValue({
      ok: true,
      status: 202,
      data: { requestedAt, branch: editing({ baseUpdateRequestedAt: requestedAt }) },
    })
    const { result } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())
    await act(() => result.current.request())

    // The stale listing still lacks the request.
    await act(() => result.current.reload())
    expect(result.current.wait).toBe('waiting')
  })

  it('ends the wait when each read of the list takes longer than the poll interval', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result } = render()
    await vi.waitFor(() => expect(result.current.wait).toBe('waiting'))

    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'merged' },
    })
    client.branches.list.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(listing()), 4_000)),
    )
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(result.current.wait).toBe('none')
  })

  it('stays answered, and reports once, when an older listing arrives after the answer', async () => {
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result, onUpdated } = render()
    await waitFor(() => expect(result.current.wait).toBe('waiting'))

    const answered = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'merged' },
    })
    listed = answered
    await act(() => result.current.reload())
    await waitFor(() => expect(result.current.wait).toBe('none'))

    // Another host's older snapshot, then the current one again.
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    await act(() => result.current.reload())
    expect(result.current.wait).toBe('none')
    listed = answered
    await act(() => result.current.reload())

    expect(shown().filter((n) => n.message === 'Latest changes added')).toHaveLength(1)
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('offers no Retry on a failure to a viewer who may not ask', async () => {
    const requestedAt = new Date().toISOString()
    listed = editing({ baseUpdateRequestedAt: requestedAt })
    const { result } = render({ permitted: false })
    await waitFor(() => expect(result.current.wait).toBe('waiting'))

    listed = editing({
      baseUpdateRequestedAt: requestedAt,
      lastBaseUpdate: { at: requestedAt, outcome: 'failed' },
    })
    await act(() => result.current.reload())
    await waitFor(() => expect(shown()).toHaveLength(1))
    expect(typeof shown()[0]?.message).toBe('string')
  })

  it('reports a refused request, with Retry', async () => {
    client.workflow.updateFromBase.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'This branch is in review. Withdraw it from review to get the latest changes.',
    })
    const { result } = render()
    await waitFor(() => expect(result.current.branch).toBeDefined())
    await act(() => result.current.request())
    expect(shown()).toHaveLength(1)
    expect(shown()[0]).toMatchObject({ color: 'red', autoClose: false })
    expect(result.current.wait).toBe('none')
  })
})
