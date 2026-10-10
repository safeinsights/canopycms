import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSystemHealth } from './useSystemHealth'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { mockSuccess } from '../../api/__test__/mock-client'
import type { BranchHealthData, BranchHealthResponse } from '../../api/admin-branch-health'
import type { BranchHealthEntry, DuplicateIdScan } from '../../branch-health'
import { unsafeAsContentId, unsafeAsPhysicalPath } from '../../paths/test-utils'
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
        reset: { status: 'editing', access: {}, createdBy: 'admin' },
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

  describe('duplicate-ID scan', () => {
    const healthy = (dirName: string, duplicateIdScan?: DuplicateIdScan): BranchHealthEntry => ({
      dirName,
      kind: 'healthy',
      branch: {
        name: dirName,
        status: 'editing',
        access: {},
        createdBy: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      ...(duplicateIdScan ? { duplicateIdScan } : {}),
    })
    const found: DuplicateIdScan = {
      state: 'found',
      duplicates: [
        {
          id: unsafeAsContentId('a1b2c3d4e5f6'),
          keptPath: unsafeAsPhysicalPath('content/posts/a.a1b2c3d4e5f6.json'),
          droppedPaths: [unsafeAsPhysicalPath('content/posts/b.a1b2c3d4e5f6.json')],
        },
      ],
    }
    const scanned = (entries: BranchHealthEntry[], truncated = false): BranchHealthData => ({
      entries,
      generatedAt: '2026-01-01T00:00:00.000Z',
      duplicateIdScan: { budgetMs: 20_000, truncated },
    })
    const flaggedCalls = () =>
      mockClient.admin.branchHealth.mock.calls.filter(([p]) => p?.duplicates === '1').length

    it('scans once on open, keyed by dirName, and the 30s poll never asks for it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      mockClient.admin.branchHealth.mockImplementation(async (params) =>
        mockSuccess(
          params?.duplicates === '1'
            ? scanned([healthy('a', found), healthy('b', { state: 'none' })], true)
            : { entries: [healthy('a'), healthy('b')], generatedAt: '2026-01-01T00:00:00.000Z' },
        ),
      )
      const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })

      await vi.waitFor(() => expect(result.current.duplicateIdScan).not.toBeNull())
      expect(result.current.duplicateIdScan?.byDir).toEqual({ a: found, b: { state: 'none' } })
      expect(result.current.duplicateIdScan?.truncated).toBe(true)
      expect(flaggedCalls()).toBe(1)
      expect(mockClient.admin.branchHealth).toHaveBeenCalledWith({})

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mockClient.admin.branchHealth.mock.calls.length).toBeGreaterThanOrEqual(4)
      expect(flaggedCalls()).toBe(1)
    })

    it('clears the previous scan and reports the error when a scan request fails', async () => {
      mockClient.admin.branchHealth.mockResolvedValue(mockSuccess(scanned([healthy('a', found)])))
      const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
      await waitFor(() => expect(result.current.duplicateIdScan).not.toBeNull())

      mockClient.admin.branchHealth.mockResolvedValue({ ok: false, status: 500, error: 'EIO' })
      await act(async () => {
        await result.current.checkDuplicateIds()
      })

      expect(result.current.duplicateIdScanError).toBe('EIO')
      expect(result.current.duplicateIdScan).toBeNull()
      expect(result.current.duplicateIdScanLoading).toBe(false)
    })

    it('repairDuplicateIds archives, notifies, and re-scans', async () => {
      const { notifications } = await import('@mantine/notifications')
      mockClient.admin.branchHealth.mockResolvedValue(mockSuccess(scanned([healthy('a', found)])))
      mockClient.admin.repairContentDuplicates.mockResolvedValueOnce(
        mockSuccess({
          resolved: [
            {
              id: 'a1b2c3d4e5f6',
              keptPath: 'content/posts/a.a1b2c3d4e5f6.json',
              archivedAs: ['content/posts/.duplicate-content-id.20260101T000000Z.b.json'],
            },
          ],
        }),
      )
      const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
      await waitFor(() => expect(result.current.duplicateIdScan).not.toBeNull())
      const before = flaggedCalls()

      mockClient.admin.branchHealth.mockResolvedValue(
        mockSuccess(scanned([healthy('a', { state: 'none' })])),
      )
      await act(async () => {
        await result.current.repairDuplicateIds('a')
      })

      expect(mockClient.admin.repairContentDuplicates).toHaveBeenCalledWith({ dirName: 'a' })
      expect(mockClient.admin.purgeBranchDir).not.toHaveBeenCalled()
      expect(notifications.show).toHaveBeenCalledWith({
        message: 'Archived 1 duplicate file',
        color: 'green',
      })
      expect(flaggedCalls()).toBe(before + 1)
      expect(result.current.duplicateIdScan?.byDir.a).toEqual({ state: 'none' })
    })

    it('re-scans after a failed repair too, and shows the server error', async () => {
      const { notifications } = await import('@mantine/notifications')
      mockClient.admin.branchHealth.mockResolvedValue(mockSuccess(scanned([healthy('a', found)])))
      mockClient.admin.repairContentDuplicates.mockResolvedValueOnce({
        ok: false,
        status: 409,
        error: 'No duplicate content IDs found',
      })
      const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
      await waitFor(() => expect(result.current.duplicateIdScan).not.toBeNull())
      const before = flaggedCalls()

      await act(async () => {
        await result.current.repairDuplicateIds('a')
      })

      expect(notifications.show).toHaveBeenCalledWith({
        message: 'No duplicate content IDs found',
        color: 'red',
      })
      expect(flaggedCalls()).toBe(before + 1)
    })

    it('ignores an older scan response that lands after a newer one', async () => {
      let resolveFirst: (value: BranchHealthResponse) => void = () => {}
      mockClient.admin.branchHealth.mockImplementation((params) =>
        params?.duplicates === '1' && flaggedCalls() === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve(mockSuccess(scanned([healthy('a', { state: 'none' })]))),
      )
      const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
      await waitFor(() => expect(flaggedCalls()).toBe(1))

      await act(async () => {
        await result.current.checkDuplicateIds()
      })
      expect(result.current.duplicateIdScan?.byDir.a).toEqual({ state: 'none' })

      await act(async () => {
        resolveFirst(mockSuccess(scanned([healthy('a', found)])))
        await Promise.resolve()
      })
      expect(result.current.duplicateIdScan?.byDir.a).toEqual({ state: 'none' })
      expect(result.current.duplicateIdScanLoading).toBe(false)
    })
  })
})
