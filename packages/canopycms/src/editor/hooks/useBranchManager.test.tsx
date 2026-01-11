import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchManager, UseBranchManagerOptions, resetApiClient } from './useBranchManager'
import type { BranchMetadata } from '../../types'
import type { MockApiClient } from '../../api/__test__/mock-client'
import {
  setupMockApiClient,
  setupMockLocation,
  setupMockHistory,
  setupMockConsole,
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
    branchMode: 'local-simple' as const,
    setBusy: mockSetBusy,
    comments: [],
  }

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    resetApiClient()

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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    expect(result.current.branchName).toBe('main')
    expect(result.current.branches).toEqual([])
  })

  it('loads branches on mount', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toEqual(mockBranches)
    })

    expect(mockClient.branches.list).toHaveBeenCalled()
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('handles branch load returning 404 gracefully', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

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

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(mockSetBusy).toHaveBeenCalledWith(false)
    })

    restore()
  })

  it('computes currentBranch and branchStatus', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.currentBranch).toEqual(mockBranches[0])
      expect(result.current.branchStatus).toBe('editing')
    })
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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleSubmit('feature')
    })

    expect(mockClient.workflow.submit).toHaveBeenCalledWith({ branch: 'feature' })
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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleWithdraw('feature')
    })

    expect(mockClient.workflow.withdraw).toHaveBeenCalledWith({ branch: 'feature' })
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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleRequestChanges('feature')
    })

    expect(mockClient.workflow.requestChanges).toHaveBeenCalledWith({ branch: 'feature' }, {})
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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

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

    renderHook(() => useBranchManager(defaultOptions))

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

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // Verify loadBranches was called
    expect(mockClient.branches.list).toHaveBeenCalled()
  })

  it('handles error during loadBranches in useEffect', async () => {
    const { error, restore } = setupMockConsole(['error'])
    mockClient.branches.list.mockRejectedValueOnce(new Error('Network error'))

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(error).toHaveBeenCalled()
    })

    restore()
  })
})
