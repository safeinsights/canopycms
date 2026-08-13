import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchManager, UseBranchManagerOptions } from './useBranchManager'
import type { BranchMetadata } from '../../types'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { unsafeAsContentId } from '../../paths/test-utils'
import {
  setupMockApiClient,
  setupMockLocation,
  setupMockHistory,
  setupMockConsole,
  createApiClientWrapper,
  createStrictModeApiClientWrapper,
} from './__test__/test-utils'

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
    hide: vi.fn(),
  },
}))

// Mock modals - auto-confirm by default
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn((options) => {
      // Automatically call onConfirm to simulate user clicking "Confirm"
      if (options.onConfirm) {
        options.onConfirm()
      }
    }),
  },
}))

describe('useBranchManager', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  const mockBranches: BranchMetadata[] = [
    {
      name: 'main',
      status: 'editing',
      title: 'Main Branch',
      access: { allowedUsers: [], allowedGroups: [] },
      createdBy: 'user1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
    },
    {
      name: 'feature',
      status: 'submitted',
      title: 'Feature Branch',
      access: { allowedUsers: ['user1'], allowedGroups: ['group1'] },
      createdBy: 'user1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-03',
    },
  ]

  const mockSetBusy = vi.fn()

  const defaultOptions: UseBranchManagerOptions = {
    initialBranch: 'main',
    operatingMode: 'dev' as const,
    setBusy: mockSetBusy,
    comments: [],
  }

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)

    setupMockLocation()
    setupMockHistory()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('initializes with initial branch', () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: [] },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    expect(result.current.branchName).toBe('main')
    expect(result.current.branches).toEqual([])
  })

  it('loads branches on mount', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toEqual(mockBranches)
    })

    expect(mockClient.branches.list).toHaveBeenCalled()
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('mounting under Strict Mode issues one branches request, not two', async () => {
    // Headline claim for the SWR migration: React Strict Mode double-invokes
    // effects (mount -> cleanup -> remount) in dev, which used to fire this
    // hook's fetch-on-load effect twice. SWR's request dedup must collapse
    // that to a single actual network call.
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const strictWrapper = createStrictModeApiClientWrapper(mockClient)
    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper: strictWrapper,
    })

    await waitFor(() => expect(result.current.branches).toEqual(mockBranches))

    expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
  })

  it('adopts the server default branch when no branch is pinned', async () => {
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: mockBranches, defaultBranch: 'feature-x' },
    })

    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: '' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.branchName).toBe('feature-x')
    })
  })

  it('keeps a pinned branch even when the server reports a different default', async () => {
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: mockBranches, defaultBranch: 'feature-x' },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toEqual(mockBranches)
    })
    expect(result.current.branchName).toBe('main')
  })

  it('clears the sticky error toast once a later load succeeds', async () => {
    const { restore } = setupMockConsole(['error'])
    const { notifications } = await import('@mantine/notifications')
    mockClient.branches.list
      .mockResolvedValueOnce({ ok: false, status: 503, error: 'provisioning failed' })
      .mockResolvedValue({ ok: true, status: 200, data: { branches: mockBranches } })

    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'canopy-branches-load-failed' }),
      )
    })

    await act(() => result.current.loadBranches())

    expect(notifications.hide).toHaveBeenCalledWith('canopy-branches-load-failed')
    restore()
  })

  it('handles branch load returning 404 gracefully', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toEqual([])
    })
  })

  it('handles branch load error', async () => {
    const { restore } = setupMockConsole(['error'])
    mockClient.branches.list.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(mockSetBusy).toHaveBeenCalledWith(false)
    })

    restore()
  })

  it('surfaces the server error message when loading branches fails', async () => {
    const { restore } = setupMockConsole(['error'])
    const { notifications } = await import('@mantine/notifications')
    mockClient.branches.list.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "Branch workspace provisioning failed for 'main': clone failed",
    })

    renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Branch workspace provisioning failed for 'main': clone failed",
          color: 'red',
        }),
      )
    })

    restore()
  })

  it('passes pullRequestState and mergedAt through branchSummaries unchanged', async () => {
    const branchesWithPrState: BranchMetadata[] = [
      {
        ...mockBranches[0],
        status: 'archived',
        pullRequestState: 'merged',
        mergedAt: '2024-02-01T00:00:00.000Z',
      },
      {
        ...mockBranches[1],
        pullRequestState: 'closed',
      },
    ]
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: branchesWithPrState },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branchSummaries).toHaveLength(2)
    })

    expect(result.current.branchSummaries[0]).toMatchObject({
      name: 'main',
      pullRequestState: 'merged',
      mergedAt: '2024-02-01T00:00:00.000Z',
    })
    expect(result.current.branchSummaries[1]).toMatchObject({
      name: 'feature',
      pullRequestState: 'closed',
    })
    expect(result.current.branchSummaries[1].mergedAt).toBeUndefined()
  })

  it('maps isProtected/readOnly/writeBlocked/submitBlocked flags into branchSummaries, failing CLOSED when the wire omits them (version skew)', async () => {
    // Version skew / a branches-list response that doesn't carry the newer
    // flags at all must lock the UI, not unlock it -- see branchContentLocked's
    // doc comment in Editor.tsx for the full rationale (the old client-side
    // derivation locked correctly with zero data; an `?? false` default here
    // would silently invert that).
    const branchesWithFlags: BranchMetadata[] = [
      {
        ...mockBranches[0],
        isProtected: true,
        readOnly: true,
        writeBlocked: true,
        submitBlocked: true,
      } as BranchMetadata,
      mockBranches[1], // no flags on the wire at all -- the version-skew case
    ]
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: branchesWithFlags },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branchSummaries).toHaveLength(2)
    })

    expect(result.current.branchSummaries[0]).toMatchObject({
      name: 'main',
      isProtected: true,
      readOnly: true,
      writeBlocked: true,
      submitBlocked: true,
    })
    // Absent case, asserted specifically (not just "always sends the field"):
    // isProtected/writeBlocked/submitBlocked gate real mutating actions, so
    // they must fail CLOSED (true) when missing. readOnly only picks WHICH
    // lock banner to show once something is already locked, so it alone
    // stays `false` (unlocked-looking) when absent -- see the comment beside
    // its default in useBranchManager.tsx.
    expect(result.current.branchSummaries[1]).toMatchObject({
      name: 'feature',
      isProtected: true,
      readOnly: false,
      writeBlocked: true,
      submitBlocked: true,
    })
  })

  it('lands branchless adoption on the protected default branch, carrying its flags', async () => {
    const branchesWithFlags: BranchMetadata[] = [
      { ...mockBranches[0], isProtected: true, readOnly: true } as BranchMetadata,
      mockBranches[1],
    ]
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: branchesWithFlags, defaultBranch: 'main' },
    })

    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: '' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.branchName).toBe('main')
    })
    await waitFor(() => {
      expect(result.current.currentBranch?.isProtected).toBe(true)
      expect(result.current.currentBranch?.readOnly).toBe(true)
    })
  })

  it('passes syncStatus, conflictStatus, and conflictFiles through branchSummaries unchanged', async () => {
    const branchesWithSyncState: BranchMetadata[] = [
      {
        ...mockBranches[0],
        syncStatus: 'sync-failed',
        syncFailureReason: 'Push rejected for branch "main": it has moved on GitHub',
        conflictStatus: 'conflicts-detected',
        conflictFiles: [unsafeAsContentId('content/a.md'), unsafeAsContentId('content/b.md')],
      },
      {
        ...mockBranches[1],
        syncStatus: 'pending-sync',
      },
    ]
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: branchesWithSyncState },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branchSummaries).toHaveLength(2)
    })

    expect(result.current.branchSummaries[0]).toMatchObject({
      name: 'main',
      syncStatus: 'sync-failed',
      syncFailureReason: 'Push rejected for branch "main": it has moved on GitHub',
      conflictStatus: 'conflicts-detected',
      conflictFiles: ['content/a.md', 'content/b.md'],
    })
    expect(result.current.branchSummaries[1]).toMatchObject({
      name: 'feature',
      syncStatus: 'pending-sync',
    })
    expect(result.current.branchSummaries[1].conflictStatus).toBeUndefined()
    expect(result.current.branchSummaries[1].conflictFiles).toBeUndefined()
  })

  it('computes currentBranch and branchStatus', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.currentBranch).toEqual(mockBranches[0])
      expect(result.current.branchStatus).toBe('editing')
    })
  })

  it('resolves currentBranch when state holds the raw form of a sanitized branch name', async () => {
    // Legacy deep-link case: the URL/state carries the raw, unsanitized name
    // (e.g. "feature/x") but the server only ever persisted the sanitized
    // form ("feature-x"). currentBranch must still resolve so branchStatus,
    // access, and isProtected/readOnly flags are available to the header.
    const sanitizedBranch: BranchMetadata = {
      ...mockBranches[1],
      name: 'feature-x',
    }
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: [mockBranches[0], sanitizedBranch] },
    })

    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: 'feature/x' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    expect(result.current.branchName).toBe('feature/x')
    expect(result.current.currentBranch).toEqual(sanitizedBranch)
    expect(result.current.branchStatus).toBe(sanitizedBranch.status)
  })

  it('submits branch successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })

    mockClient.workflow.submit.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleSubmit('feature')
    })

    expect(mockClient.workflow.submit).toHaveBeenCalledWith({
      branch: 'feature',
    })
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('handles submit error', async () => {
    const { restore } = setupMockConsole(['error'])
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    mockClient.workflow.submit.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Submit failed',
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      try {
        await result.current.handleSubmit('feature')
        // Should not reach here - expect rejection
        expect.fail('Expected handleSubmit to reject')
      } catch (err) {
        // Expected - error should be rejected
        expect(err).toBeInstanceOf(Error)
      }
    })

    expect(mockSetBusy).toHaveBeenCalledWith(false)
    restore()
  })

  it('withdraws branch successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })

    mockClient.workflow.withdraw.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleWithdraw('feature')
    })

    expect(mockClient.workflow.withdraw).toHaveBeenCalledWith({
      branch: 'feature',
    })
  })

  it('requests changes successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })

    mockClient.workflow.requestChanges.mockResolvedValueOnce({
      ok: true,
      status: 200,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleRequestChanges('feature')
    })

    expect(mockClient.workflow.requestChanges).toHaveBeenCalledWith({ branch: 'feature' })
  })

  it('reloads branch data', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches },
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleReloadBranchData()
    })

    // Verify loadBranches was called
    expect(mockClient.branches.list).toHaveBeenCalledTimes(2)
  })

  it('syncs branch name to URL', async () => {
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalled()
    })

    const calls = (window.history.replaceState as any).mock.calls
    const urlCall = calls.find((call: any) => call[2].includes('branch='))
    expect(urlCall).toBeTruthy()
  })

  it('loads branches on mount', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // Verify loadBranches was called
    expect(mockClient.branches.list).toHaveBeenCalled()
  })

  it('handles error during loadBranches in useEffect', async () => {
    const { error, restore } = setupMockConsole(['error'])
    mockClient.branches.list.mockRejectedValueOnce(new Error('Network error'))

    renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(error).toHaveBeenCalled()
    })

    restore()
  })
})
