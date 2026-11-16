import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSystemHealth } from './useSystemHealth'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { mockSuccess } from '../../api/__test__/mock-client'
import type {
  BranchHealthData,
  BranchHealthResponse,
  RepairBranchDirResponse,
} from '../../api/admin-branch-health'
import type { BranchAccessControl } from '../../types'
import type { BranchHealthEntry, DuplicateIdScan } from '../../branch-health'
import { unsafeAsContentId, unsafeAsPhysicalPath } from '../../paths/test-utils'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { useBranchesData } from '../hooks/useBranchesData'

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
        reset: { status: 'editing' },
        kept: { access: {}, createdBy: 'admin' },
        restricted: false,
        openToEveryone: false,
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

    await act(async () => {
      await result.current.dismissUnpublished('foo')
    })
    expect(mockClient.admin.dismissUnpublished).toHaveBeenCalledWith({ dirName: 'foo' })
  })

  describe('repairDir says who can open the repaired branch', () => {
    const removal = { by: 'alice', at: '2026-11-01T00:00:00.000Z', byAdmin: false }
    const ARCHIVED =
      ' Its status is editing. The corrupt file is archived as branch.json.corrupt-x.'

    const repairWith = async (
      access: BranchAccessControl,
      fields: Pick<
        NonNullable<RepairBranchDirResponse['data']>,
        'reset' | 'kept' | 'restricted' | 'openToEveryone' | 'warning'
      >,
      createdBy = 'alice',
      status: 'editing' | 'archived' = 'editing',
    ) => {
      mockClient.admin.repairBranchDir.mockResolvedValueOnce(
        mockSuccess({
          branch: {
            name: 'foo',
            status,
            access,
            createdBy,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
          archivedAs: 'branch.json.corrupt-x',
          ...fields,
        }),
      )
      const { notifications } = await import('@mantine/notifications')
      const { result } = renderHook(() => useSystemHealth({ isOpen: false }), { wrapper })
      await act(async () => {
        await result.current.repairDir('foo')
      })
      return vi.mocked(notifications.show).mock.calls.at(-1)?.[0]
    }

    it('says a kept list still decides, and that the people removed stay out', async () => {
      const access = {
        restricted: true,
        allowedUsers: ['alice'],
        excluded: { bob: removal },
        excludedGroups: { readers: removal, editors: removal },
      }
      const shown = await repairWith(access, {
        reset: { status: 'editing' },
        kept: { access, createdBy: 'alice' },
        restricted: true,
        openToEveryone: false,
      })
      expect(shown).toMatchObject({
        title: 'Metadata repaired',
        message:
          'Kept its access: only the people listed can open it. The 1 person and 2 groups removed from it stay out.' +
          ARCHIVED,
        color: 'green',
      })
      expect(mockClient.permissions.batchGetUserMetadata).not.toHaveBeenCalled()
    })

    it('says a kept open branch is open to anyone who can sign in, bar the person removed', async () => {
      const access = { excluded: { bob: removal, carol: removal } }
      const shown = await repairWith(access, {
        reset: { status: 'editing' },
        kept: { access, createdBy: 'alice' },
        restricted: false,
        openToEveryone: true,
      })
      expect(shown).toMatchObject({
        message:
          'Kept its access: anyone who can sign in can open it. The 2 people removed from it stay out.' +
          ARCHIVED,
        color: 'green',
      })
    })

    it('says a kept open branch on a closed site opens only to its creator, admins and reviewers', async () => {
      const shown = await repairWith(
        {},
        {
          reset: { status: 'editing' },
          kept: { access: {}, createdBy: 'alice' },
          restricted: false,
          openToEveryone: false,
        },
      )
      expect(shown?.message).toBe(
        'Kept its access: only its creator, admins and reviewers can open it.' + ARCHIVED,
      )
    })

    it('says one removed group stays out', async () => {
      const access = { restricted: true, excludedGroups: { readers: removal } }
      const shown = await repairWith(access, {
        reset: { status: 'editing' },
        kept: { access, createdBy: 'alice' },
        restricted: true,
        openToEveryone: false,
      })
      expect(shown?.message).toBe(
        'Kept its access: only the people listed can open it. The 1 group removed from it stays out.' +
          ARCHIVED,
      )
    })

    it('names no creator for a kept open branch on a closed site that a system user created', async () => {
      const shown = await repairWith(
        {},
        {
          reset: { status: 'editing' },
          kept: { access: {}, createdBy: 'canopycms-system' },
          restricted: false,
          openToEveryone: false,
        },
        'canopycms-system',
      )
      expect(shown?.message).toBe(
        'Kept its access: only admins and reviewers can open it.' + ARCHIVED,
      )
    })

    it('says a fallen-back branch listing no one opens only to admins and reviewers', async () => {
      const access = { restricted: true }
      const shown = await repairWith(
        access,
        {
          reset: { status: 'editing', access },
          kept: { createdBy: 'canopycms-system' },
          restricted: true,
          openToEveryone: false,
        },
        'canopycms-system',
      )
      expect(shown).toMatchObject({
        message:
          'Access couldn\'t be read, so only admins and reviewers can open it. Share it again from "Branches".' +
          ARCHIVED,
        color: 'yellow',
        autoClose: false,
      })
      expect(mockClient.permissions.batchGetUserMetadata).not.toHaveBeenCalled()
    })

    it('adds the removals a fallen-back branch carried', async () => {
      const access = { restricted: true, excluded: { bob: removal } }
      const shown = await repairWith(access, {
        reset: { status: 'editing', access },
        kept: { createdBy: 'alice' },
        restricted: true,
        openToEveryone: false,
      })
      expect(shown).toMatchObject({
        message:
          'Access couldn\'t be read, so only admins and reviewers can open it. Share it again from "Branches". The 1 person removed from it stays out.' +
          ARCHIVED,
        color: 'yellow',
        autoClose: false,
      })
    })

    it('says a branch that takes no list, its access unreadable, opens to anyone who can sign in', async () => {
      const access = { excluded: { bob: removal } }
      const shown = await repairWith(
        access,
        {
          reset: { status: 'editing', access },
          kept: { createdBy: 'canopycms-system' },
          restricted: false,
          openToEveryone: true,
        },
        'canopycms-system',
      )
      expect(shown).toMatchObject({
        message:
          "Access couldn't be read. This branch takes no access list, so anyone who can sign in can open this branch. The 1 person removed from it stays out." +
          ARCHIVED,
        color: 'green',
      })
    })

    it('says a branch locked because its access could not be read needs branch.json edited', async () => {
      for (const restricted of [false, true]) {
        const access = { managerOrAdminAllowed: true, ...(restricted && { restricted }) }
        const shown = await repairWith(
          access,
          {
            reset: { status: 'editing', access },
            kept: { createdBy: 'canopycms-system' },
            restricted,
            openToEveryone: false,
          },
          'canopycms-system',
        )
        expect(shown).toMatchObject({
          message:
            "Access couldn't be read, so this branch is locked to admins and reviewers. Opening it again needs its branch.json edited by hand." +
            ARCHIVED,
          color: 'yellow',
          autoClose: false,
        })
      }
    })

    it('names no creator for a kept open branch on a closed site that excludes its creator', async () => {
      const access = { excluded: { alice: removal } }
      const shown = await repairWith(access, {
        reset: { status: 'editing' },
        kept: { access, createdBy: 'alice' },
        restricted: false,
        openToEveryone: false,
      })
      expect(shown?.message).toBe(
        'Kept its access: only admins and reviewers can open it. The 1 person removed from it stays out.' +
          ARCHIVED,
      )
    })

    it('says an archived branch stays archived', async () => {
      const access = { restricted: true, allowedUsers: ['alice'] }
      const shown = await repairWith(
        access,
        {
          reset: {},
          kept: { status: 'archived', access, createdBy: 'alice' },
          restricted: true,
          openToEveryone: false,
        },
        'alice',
        'archived',
      )
      expect(shown?.message).toBe(
        'Kept its access: only the people listed can open it. It stays archived. The corrupt file is archived as branch.json.corrupt-x.',
      )
    })

    it('keeps a refused repair on screen, since its error may ask the admin to check access', async () => {
      mockClient.admin.repairBranchDir.mockResolvedValueOnce({
        ok: false,
        status: 409,
        error: 'Check the branch\'s access in "Branches".',
      })
      const { notifications } = await import('@mantine/notifications')
      const { result } = renderHook(() => useSystemHealth({ isOpen: false }), { wrapper })
      await act(async () => {
        await result.current.repairDir('foo')
      })
      expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toEqual({
        message: 'Check the branch\'s access in "Branches".',
        color: 'red',
        autoClose: false,
      })
    })

    it('adds the warning of a repair whose follow-up step failed, and stays until dismissed', async () => {
      const access = { restricted: true, allowedUsers: ['alice'] }
      const shown = await repairWith(access, {
        reset: { status: 'editing' },
        kept: { access, createdBy: 'alice' },
        restricted: true,
        openToEveryone: false,
        warning: 'The list may show the branch late.',
      })
      expect(shown).toMatchObject({
        message:
          'Kept its access: only the people listed can open it.' +
          ARCHIVED +
          ' The list may show the branch late.',
        color: 'yellow',
        autoClose: false,
      })
    })
  })

  it('takes an already-dismissed warning as a conflict, and refreshes the list', async () => {
    const { notifications } = await import('@mantine/notifications')
    const { result } = renderHook(() => useSystemHealth({ isOpen: true }), { wrapper })
    await waitFor(() => expect(result.current.statusLoading).toBe(false))
    mockClient.admin.branchHealth.mockClear()
    mockClient.admin.dismissUnpublished.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'This warning was already dismissed.',
    })

    await act(async () => {
      await result.current.dismissUnpublished('foo')
    })

    expect(notifications.show).toHaveBeenCalledWith({
      message: 'This warning was already dismissed.',
      color: 'yellow',
    })
    expect(mockClient.admin.branchHealth).toHaveBeenCalled()
  })

  it('reloads the branch list after a dismissal, for the hold it carried', async () => {
    const { result } = renderHook(
      () => {
        useBranchesData(mockClient)
        return useSystemHealth({ isOpen: true })
      },
      { wrapper },
    )
    await waitFor(() => expect(result.current.statusLoading).toBe(false))
    await waitFor(() => expect(mockClient.branches.list).toHaveBeenCalled())
    mockClient.branches.list.mockClear()

    await act(async () => {
      await result.current.dismissUnpublished('foo')
    })

    expect(mockClient.branches.list).toHaveBeenCalled()
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
