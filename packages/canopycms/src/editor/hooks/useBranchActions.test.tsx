import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifications } from '@mantine/notifications'
import { useBranchActions } from './useBranchActions'
import type { MockApiClient } from '../../api/__test__/mock-client'
import {
  setupMockApiClient,
  setupMockLocation,
  setupMockHistory,
  createApiClientWrapper,
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

// Mock modals
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn(),
  },
}))

/** The URLs the hook passed to `history.replaceState`. */
const replacedUrls = () =>
  vi.mocked(window.history.replaceState).mock.calls.map((call) => String(call[2]))

describe('useBranchActions', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>
  const mockSetBranchName = vi.fn()
  const mockIsAnyDirty = vi.fn(() => false)
  const mockOnReloadBranches = vi.fn().mockResolvedValue(undefined)
  const mockOnBranchSwitch = vi.fn()
  const mockOnBranchCreated = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    setBranchName: mockSetBranchName,
    isAnyDirty: mockIsAnyDirty,
    onReloadBranches: mockOnReloadBranches,
    onBranchCreated: mockOnBranchCreated,
    onBranchSwitch: mockOnBranchSwitch,
  }

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)

    setupMockLocation()
    setupMockHistory()
    mockSetBranchName.mockClear()
    mockIsAnyDirty.mockReturnValue(false)
    mockOnReloadBranches.mockClear()
    mockOnBranchSwitch.mockClear()
    mockOnBranchCreated.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('handles branch change without unsaved changes', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockSetBranchName).toHaveBeenCalledWith('feature')
    expect(mockOnBranchSwitch).toHaveBeenCalledWith('feature')
    expect(window.history.replaceState).toHaveBeenCalled()
  })

  it('shows confirmation when a non-selected entry has unsaved changes', async () => {
    // This is the core bug: isSelectedDirty only checked the current entry.
    // If you edited entry A, navigated to entry B, then switched branches,
    // no confirmation was shown and entry A's work was silently destroyed.
    // The fix: use isAnyDirty() which checks all draft entries.
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true) // some entry (not necessarily selected) is dirty

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    act(() => {
      result.current.handleBranchChange('feature')
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })

    // Branch should not switch without confirmation
    expect(mockSetBranchName).not.toHaveBeenCalled()
  })

  it('shows confirmation modal when switching with unsaved changes', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    act(() => {
      result.current.handleBranchChange('feature')
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })
  })

  it('does not switch branch when already on that branch', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleBranchChange('main')
    })

    // Should not call setBranchName since we're already on 'main'
    expect(mockSetBranchName).not.toHaveBeenCalled()
  })

  it('does not switch branch when user cancels', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)

    // Mock the confirmation modal to call onCancel
    vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
      config.onCancel?.()
      return 'mock-modal-id'
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await expect(result.current.handleBranchChange('feature')).rejects.toThrow(
      'User cancelled branch switch',
    )

    expect(mockSetBranchName).not.toHaveBeenCalled()
  })

  it('creates new branch successfully', async () => {
    mockClient.branches.create.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        branch: {
          name: 'new-branch',
          status: 'editing',
          access: { allowedUsers: [], allowedGroups: [] },
          createdBy: 'user1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateBranch({
        name: 'new-branch',
        title: 'New Branch',
        description: 'Test branch',
      })
    })

    expect(mockClient.branches.create).toHaveBeenCalledWith({
      branch: 'new-branch',
      title: 'New Branch',
      description: 'Test branch',
    })
    expect(mockOnReloadBranches).toHaveBeenCalled()
    expect(mockSetBranchName).toHaveBeenCalledWith('new-branch')
  })

  it('switches to the created branch without waiting for the branch reload', async () => {
    // The reload may take a long time (a listing served by another container can lag);
    // the switch must not depend on it settling.
    mockOnReloadBranches.mockReturnValueOnce(new Promise<void>(() => {}))
    const createdBranch = {
      name: 'new-branch',
      status: 'editing' as const,
      access: { allowedUsers: [], allowedGroups: [] },
      createdBy: 'user1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isProtected: false,
      readOnly: false,
      writeBlocked: false,
      submitBlocked: false,
    }
    mockClient.branches.create.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branch: createdBranch },
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(true)
    expect(mockOnReloadBranches).toHaveBeenCalledTimes(1)
    expect(mockOnBranchCreated).toHaveBeenCalledWith(createdBranch)
    expect(mockSetBranchName).toHaveBeenCalledWith('new-branch')
    expect(mockOnBranchSwitch).toHaveBeenCalledWith('new-branch')
    expect(replacedUrls().some((url) => url.includes('branch=new-branch'))).toBe(true)
  })

  it('reports a failed create without switching or registering a branch', async () => {
    mockClient.branches.create.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'boom',
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(false)
    expect(notifications.show).toHaveBeenCalledWith({ message: 'boom', color: 'red' })
    expect(mockOnBranchCreated).not.toHaveBeenCalled()
    expect(mockSetBranchName).not.toHaveBeenCalled()
    expect(mockOnBranchSwitch).not.toHaveBeenCalled()
  })

  it('returns false without creating when the user declines the dirty check', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)
    vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
      config.onCancel?.()
      return 'mock-modal-id'
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(false)
    expect(mockClient.branches.create).not.toHaveBeenCalled()
  })

  it('returns false when the dirty-check modal is dismissed by Escape or the overlay', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)
    // Mantine fires only onClose for these exits, never onCancel.
    vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
      config.onClose?.()
      return 'modal-id'
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(false)
    expect(mockClient.branches.create).not.toHaveBeenCalled()
  })

  it('creates when the dirty check is confirmed, despite the close that follows the confirm', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)
    // Mantine closes the modal right after calling onConfirm.
    vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
      config.onConfirm?.()
      config.onClose?.()
      return 'modal-id'
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(true)
    expect(mockClient.branches.create).toHaveBeenCalledTimes(1)
  })

  it('adopts the server-sanitized branch name after create', async () => {
    // The server sanitizes branch names (e.g. "feature/x" -> "feature-x")
    // before persisting them. The client must switch to the name the server
    // actually saved, not the raw name the user typed, or currentBranch
    // lookups in useBranchManager will never resolve.
    mockClient.branches.create.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        branch: {
          name: 'feature-x',
          status: 'editing',
          access: { allowedUsers: [], allowedGroups: [] },
          createdBy: 'user1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'feature/x' })
    })

    expect(mockClient.branches.create).toHaveBeenCalledWith({
      branch: 'feature/x',
      title: undefined,
      description: undefined,
    })
    // setBranchName and the URL should reflect the sanitized name the
    // server persisted, not the raw user-typed name.
    expect(mockSetBranchName).toHaveBeenCalledWith('feature-x')
    expect(mockOnBranchSwitch).toHaveBeenCalledWith('feature-x')
    expect(replacedUrls().find((url) => url.includes('branch=feature-x'))).toBeTruthy()
  })

  it('handles create branch error', async () => {
    mockClient.branches.create.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'Branch already exists',
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'existing-branch' })
    })

    // Should not switch to the branch or reload if creation failed
    expect(mockSetBranchName).not.toHaveBeenCalled()
    expect(mockOnReloadBranches).not.toHaveBeenCalled()
  })

  it('prompts for confirmation when creating branch with unsaved changes', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    act(() => {
      result.current.handleCreateBranch({ name: 'new-branch' })
    })

    await waitFor(() => {
      expect(modals.openConfirmModal).toHaveBeenCalled()
    })
  })

  it('does not create branch when user cancels dirty check', async () => {
    const { modals } = await import('@mantine/modals')
    mockIsAnyDirty.mockReturnValue(true)

    // Mock the confirmation modal to call onCancel
    vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
      config.onCancel?.()
      return 'mock-modal-id'
    })

    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(mockClient.branches.create).not.toHaveBeenCalled()
  })

  it('updates URL when switching branches', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(window.history.replaceState).toHaveBeenCalled()
    expect(replacedUrls().find((url) => url.includes('branch=feature'))).toBeTruthy()
  })

  it('calls onBranchSwitch callback when provided', async () => {
    const { result } = renderHook(() => useBranchActions(defaultOptions), {
      wrapper,
    })

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

    const { result } = renderHook(() => useBranchActions(optionsWithoutCallback), { wrapper })

    await act(async () => {
      await result.current.handleBranchChange('feature')
    })

    expect(mockSetBranchName).toHaveBeenCalledWith('feature')
    // Should not throw error when callback is undefined
  })
})
