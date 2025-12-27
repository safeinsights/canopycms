import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchManager, UseBranchManagerOptions } from './useBranchManager'
import type { BranchState } from '../../types'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

// Mock modals
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn(),
  },
}))

describe('useBranchManager', () => {
  const mockBranches: BranchState[] = [
    {
      branch: {
        name: 'main',
        status: 'editing',
        title: 'Main Branch',
        access: { allowedUsers: [], allowedGroups: [] },
        createdBy: 'user1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
    },
    {
      branch: {
        name: 'feature',
        status: 'submitted',
        title: 'Feature Branch',
        access: { allowedUsers: ['user1'], allowedGroups: ['group1'] },
        createdBy: 'user1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-03',
      },
    },
  ]

  const mockSetBusy = vi.fn()

  const defaultOptions: UseBranchManagerOptions = {
    initialBranch: 'main',
    branchMode: 'local-simple' as const,
    setBusy: mockSetBusy,
    comments: [],
  }

  beforeEach(() => {
    global.fetch = vi.fn()
    delete (window as any).location
    window.location = {
      href: 'http://localhost/',
      search: '',
    } as any
    window.history.replaceState = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with initial branch', () => {
    const { result } = renderHook(() => useBranchManager(defaultOptions))

    expect(result.current.branchName).toBe('main')
    expect(result.current.branches).toEqual([])
  })

  it('loads branches on mount', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toEqual(mockBranches)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/branches')
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('handles branch load returning 404 gracefully', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toEqual([])
    })
  })

  it('handles branch load error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(mockSetBusy).toHaveBeenCalledWith(false)
    })

    consoleErrorSpy.mockRestore()
  })

  it('computes currentBranch and branchStatus', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.currentBranch).toEqual(mockBranches[0])
      expect(result.current.branchStatus).toBe('editing')
    })
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('handles branch change without unsaved changes', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // handleBranchChange moved to useBranchActions
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('shows confirmation modal when switching with unsaved changes', async () => {
    // handleBranchChange and dirty checking moved to useBranchActions
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('does not switch branch when already on that branch', async () => {
    // handleBranchChange moved to useBranchActions
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('creates new branch successfully', async () => {
    // handleCreateBranch moved to useBranchActions
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('handles create branch error', async () => {
    // handleCreateBranch moved to useBranchActions
  })

  it('submits branch successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleSubmit('feature')
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/feature/submit', { method: 'POST' })
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('handles submit error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Submit failed' }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleSubmit('feature')
    })

    expect(mockSetBusy).toHaveBeenCalledWith(false)
    consoleErrorSpy.mockRestore()
  })

  it('withdraws branch successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleWithdraw('feature')
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/feature/withdraw', { method: 'POST' })
  })

  it('requests changes successfully', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleRequestChanges('feature')
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/feature/request-changes', {
      method: 'POST',
    })
  })

  it('reloads branch data', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleReloadBranchData()
    })

    // Verify loadBranches was called (via fetch)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/branches')
  })

  it('syncs branch name to URL', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalled()
    })

    const calls = (window.history.replaceState as any).mock.calls
    const urlCall = calls.find((call: any) => call[2].includes('branch='))
    expect(urlCall).toBeTruthy()
  })

  // NOTE: Moved to useBranchActions - needs new test file
  it.skip('calls onBranchSwitch callback when provided', async () => {
    // onBranchSwitch and handleBranchChange moved to useBranchActions
  })

  it('loads branches on mount', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // Verify loadBranches was called
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/branches')
  })

  // NOTE: Comment loading moved to useCommentSystem
  it.skip('loads comments when branch name changes', async () => {
    // Comment loading is now handled by useCommentSystem hook
  })

  it('handles error during loadBranches in useEffect', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any).mockRejectedValueOnce(new Error('Network error'))

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    consoleErrorSpy.mockRestore()
  })
})
