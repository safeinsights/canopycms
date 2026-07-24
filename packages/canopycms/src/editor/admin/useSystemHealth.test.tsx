import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSystemHealth } from './useSystemHealth'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useSystemHealth', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('does not fetch anything while closed', () => {
    const { result } = renderHook(() => useSystemHealth({ isOpen: false }), { wrapper })

    expect(result.current.status).toBeNull()
    expect(result.current.tasks).toBeNull()
    expect(result.current.branchHealth).toBeNull()
    expect(mockClient.admin.status).not.toHaveBeenCalled()
    expect(mockClient.admin.listTasks).not.toHaveBeenCalled()
    expect(mockClient.admin.branchHealth).not.toHaveBeenCalled()
  })

  it('fetches status, tasks (default status "failed"), and branch health on open', async () => {
    const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })

    expect(result.current.taskStatus).toBe('failed')

    await waitFor(() => expect(result.current.statusLoading).toBe(false))
    await waitFor(() => expect(result.current.tasksLoading).toBe(false))
    await waitFor(() => expect(result.current.branchHealthLoading).toBe(false))

    expect(mockClient.admin.status).toHaveBeenCalled()
    expect(mockClient.admin.listTasks).toHaveBeenCalledWith({ status: 'failed' })
    expect(mockClient.admin.branchHealth).toHaveBeenCalled()
    expect(result.current.status).not.toBeNull()
    expect(result.current.branchHealth).not.toBeNull()
  })

  it('refetches tasks (only) when setTaskStatus is called', async () => {
    const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })

    await waitFor(() => expect(result.current.tasksLoading).toBe(false))
    mockClient.admin.listTasks.mockClear()

    act(() => {
      result.current.setTaskStatus('corrupt')
    })

    expect(result.current.taskStatus).toBe('corrupt')
    await waitFor(() =>
      expect(mockClient.admin.listTasks).toHaveBeenCalledWith({ status: 'corrupt' }),
    )
  })

  it('retryTask notifies success and refreshes on success', async () => {
    const { notifications } = await import('@mantine/notifications')
    mockClient.admin.retryTask.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { newTaskId: 'new-task-id' },
    })

    const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
    await waitFor(() => expect(result.current.statusLoading).toBe(false))
    mockClient.admin.status.mockClear()

    await act(async () => {
      await result.current.retryTask('old-task-id')
    })

    expect(mockClient.admin.retryTask).toHaveBeenCalledWith({ taskId: 'old-task-id' })
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'green', message: expect.stringContaining('new-task-id') }),
    )
    // refresh() re-fetches status as part of the full refresh
    expect(mockClient.admin.status).toHaveBeenCalled()
  })

  it('retryTask shows a red notification with the server error on failure', async () => {
    const { notifications } = await import('@mantine/notifications')
    mockClient.admin.retryTask.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'Failed task file is unparseable; delete it instead of retrying',
    })

    const { result } = renderHook(() => useSystemHealth({ isOpen: false }), { wrapper })

    await act(async () => {
      await result.current.retryTask('bad-task-id')
    })

    expect(notifications.show).toHaveBeenCalledWith({
      message: 'Failed task file is unparseable; delete it instead of retrying',
      color: 'red',
    })
  })

  it('deleteTask, purgeDir, repairDir, and markMerged call the right client methods', async () => {
    mockClient.admin.deleteTask.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { deleted: true },
    })
    mockClient.admin.purgeBranchDir.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { trashedAs: '.trash-foo-20260101T000000Z' },
    })
    mockClient.admin.repairBranchDir.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        branch: {
          name: 'foo',
          status: 'editing',
          access: {},
          createdBy: 'admin',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
        archivedAs: 'branch.json.corrupt-20260101T000000Z',
      },
    })
    mockClient.workflow.markMerged.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branch: { name: 'foo', status: 'archived' } },
    })

    const { result } = renderHook(() => useSystemHealth({ isOpen: false }), { wrapper })

    await act(async () => {
      await result.current.deleteTask('pending', 'abc.json')
    })
    expect(mockClient.admin.deleteTask).toHaveBeenCalledWith({
      status: 'pending',
      fileName: 'abc.json',
    })

    await act(async () => {
      await result.current.purgeDir('foo')
    })
    expect(mockClient.admin.purgeBranchDir).toHaveBeenCalledWith({ dirName: 'foo' })

    await act(async () => {
      await result.current.repairDir('foo')
    })
    expect(mockClient.admin.repairBranchDir).toHaveBeenCalledWith({ dirName: 'foo' })

    await act(async () => {
      await result.current.markMerged('foo')
    })
    // markMerged is namespaced under `workflow` (not `admin`) on the client --
    // it's the same endpoint editors' Submit/Withdraw actions use, widened by
    // PR-A4 to also accept the 'approved' status.
    expect(mockClient.workflow.markMerged).toHaveBeenCalledWith({ branch: 'foo' })
  })

  it('polls every 30s while open and stops polling after close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result, rerender } = renderHook(({ isOpen }) => useSystemHealth({ isOpen }), {
      wrapper,
      initialProps: { isOpen: true },
    })

    await vi.waitFor(() => expect(mockClient.admin.status).toHaveBeenCalledTimes(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mockClient.admin.status).toHaveBeenCalledTimes(2)

    rerender({ isOpen: false })
    mockClient.admin.status.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockClient.admin.status).not.toHaveBeenCalled()
    expect(result.current).toBeDefined()
  })
})
