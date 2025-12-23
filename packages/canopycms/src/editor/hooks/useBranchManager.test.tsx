import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchManager } from './useBranchManager'
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

  const mockRefreshEntries = vi.fn()
  const mockLoadComments = vi.fn()
  const mockSetBusy = vi.fn()
  const mockSetDrafts = vi.fn()
  const mockSetLoadedValues = vi.fn()
  const mockSetSelectedId = vi.fn()
  const mockSetEntries = vi.fn()

  const defaultOptions = {
    initialBranch: 'main',
    branchMode: 'collaboration' as const,
    selectedId: 'entry1',
    drafts: {},
    loadedValues: {},
    setDrafts: mockSetDrafts,
    setLoadedValues: mockSetLoadedValues,
    setSelectedId: mockSetSelectedId,
    setEntries: mockSetEntries,
    onEntriesRefresh: mockRefreshEntries,
    onCommentsLoad: mockLoadComments,
    setBusy: mockSetBusy,
    comments: [],
  }

  beforeEach(() => {
    global.fetch = vi.fn()
    mockRefreshEntries.mockResolvedValue(undefined)
    mockLoadComments.mockResolvedValue(undefined)
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

  it('handles branch change without unsaved changes', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(result.current.branchName).toBe('feature')
    expect(mockRefreshEntries).toHaveBeenCalledWith('feature')
    expect(mockLoadComments).toHaveBeenCalledWith('feature')
    expect(mockSetDrafts).toHaveBeenCalledWith({})
    expect(mockSetLoadedValues).toHaveBeenCalledWith({})
    expect(mockSetSelectedId).toHaveBeenCalledWith('')
    expect(mockSetEntries).toHaveBeenCalledWith([])
  })

  it('shows confirmation modal when switching with unsaved changes', async () => {
    const { modals } = await import('@mantine/modals')
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const optionsWithDrafts = {
      ...defaultOptions,
      selectedId: 'entry1',
      drafts: { entry1: { title: 'Draft Title' } },
      loadedValues: { entry1: { title: 'Original Title' } },
    }

    const { result } = renderHook(() => useBranchManager(optionsWithDrafts))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    act(() => {
      result.current.handleBranchChange('feature')
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })
  })

  it('does not switch branch when already on that branch', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // Reset the mock to clear the initial mount call
    mockRefreshEntries.mockClear()

    await act(async () => {
      await result.current.handleBranchChange('main')
    })

    // Should not be called again since we're already on 'main'
    expect(mockRefreshEntries).not.toHaveBeenCalled()
  })

  it('creates new branch successfully', async () => {
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
        json: async () => ({
          data: { branches: [...mockBranches, { branch: { name: 'new-branch' } }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: [] } }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleCreateBranch({
        name: 'new-branch',
        title: 'New Branch',
        description: 'Test branch',
      })
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/branches',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: 'new-branch',
          title: 'New Branch',
          description: 'Test branch',
        }),
      }),
    )
  })

  it('handles create branch error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { branches: mockBranches } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Branch already exists' }),
      })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'existing-branch' })
    })

    expect(mockSetBusy).toHaveBeenCalledWith(false)
    consoleErrorSpy.mockRestore()
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

  it('reloads branch data with entries refresh', async () => {
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

    expect(mockRefreshEntries).toHaveBeenCalledWith('main')
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

  it('calls onBranchSwitch callback when provided', async () => {
    const mockOnBranchSwitch = vi.fn()
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() =>
      useBranchManager({ ...defaultOptions, onBranchSwitch: mockOnBranchSwitch }),
    )

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockOnBranchSwitch).toHaveBeenCalledWith('feature')
  })

  it('loads branches with refreshEntries option', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    // Initial load should have refreshed entries because branchName was truthy
    expect(mockRefreshEntries).toHaveBeenCalledWith('main')
  })

  it('loads comments when branch name changes', async () => {
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { branches: mockBranches } }),
    })

    renderHook(() => useBranchManager(defaultOptions))

    await waitFor(() => {
      expect(mockLoadComments).toHaveBeenCalledWith('main')
    })
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
