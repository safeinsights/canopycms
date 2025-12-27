import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchActions } from './useBranchActions'

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

describe('useBranchActions', () => {
  const mockSetBranchName = vi.fn()
  const mockIsSelectedDirty = vi.fn(() => false)
  const mockOnReloadBranches = vi.fn().mockResolvedValue(undefined)
  const mockOnBranchSwitch = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    setBranchName: mockSetBranchName,
    isSelectedDirty: mockIsSelectedDirty,
    onReloadBranches: mockOnReloadBranches,
    onBranchSwitch: mockOnBranchSwitch,
  }

  beforeEach(() => {
    global.fetch = vi.fn()
    delete (window as any).location
    window.location = {
      href: 'http://localhost/',
      search: '',
    } as any
    window.history.replaceState = vi.fn()
    mockSetBranchName.mockClear()
    mockIsSelectedDirty.mockReturnValue(false)
    mockOnReloadBranches.mockClear()
    mockOnBranchSwitch.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handles branch change without unsaved changes', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockSetBranchName).toHaveBeenCalledWith('feature')
    expect(mockOnBranchSwitch).toHaveBeenCalledWith('feature')
    expect(window.history.replaceState).toHaveBeenCalled()
  })

  it('shows confirmation modal when switching with unsaved changes', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsSelectedDirty.mockReturnValue(true)

    const { result } = renderHook(() => useBranchActions(defaultOptions))

    act(() => {
      result.current.handleBranchChange('feature')
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })
  })

  it('does not switch branch when already on that branch', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleBranchChange('main')
    })

    // Should not call setBranchName since we're already on 'main'
    expect(mockSetBranchName).not.toHaveBeenCalled()
  })

  it('does not switch branch when user cancels', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsSelectedDirty.mockReturnValue(true)

    // Mock the confirmation modal to call onCancel
    ;(modals.openConfirmModal as any).mockImplementation((config: any) => {
      config.onCancel()
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await expect(result.current.handleBranchChange('feature')).rejects.toThrow(
      'User cancelled branch switch'
    )

    expect(mockSetBranchName).not.toHaveBeenCalled()
  })

  it('creates new branch successfully', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions))

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
      })
    )
    expect(mockOnReloadBranches).toHaveBeenCalled()
    expect(mockSetBranchName).toHaveBeenCalledWith('new-branch')
  })

  it('handles create branch error', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Branch already exists' }),
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'existing-branch' })
    })

    // Should not switch to the branch or reload if creation failed
    expect(mockSetBranchName).not.toHaveBeenCalled()
    expect(mockOnReloadBranches).not.toHaveBeenCalled()
  })

  it('prompts for confirmation when creating branch with unsaved changes', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsSelectedDirty.mockReturnValue(true)

    const { result } = renderHook(() => useBranchActions(defaultOptions))

    act(() => {
      result.current.handleCreateBranch({ name: 'new-branch' })
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })
  })

  it('does not create branch when user cancels dirty check', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsSelectedDirty.mockReturnValue(true)

    // Mock the confirmation modal to call onCancel
    ;(modals.openConfirmModal as any).mockImplementation((config: any) => {
      config.onCancel()
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('updates URL when switching branches', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(window.history.replaceState).toHaveBeenCalled()
    const calls = (window.history.replaceState as any).mock.calls
    const urlCall = calls.find((call: any) => call[2].includes('branch=feature'))
    expect(urlCall).toBeTruthy()
  })

  it('calls onBranchSwitch callback when provided', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions))

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockOnBranchSwitch).toHaveBeenCalledWith('feature')
  })

  it('works without optional onBranchSwitch callback', async () => {
    const optionsWithoutCallback = {
      ...defaultOptions,
      onBranchSwitch: undefined,
    }

    const { result } = renderHook(() => useBranchActions(optionsWithoutCallback))

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockSetBranchName).toHaveBeenCalledWith('feature')
    // Should not throw error when callback is undefined
  })
})
