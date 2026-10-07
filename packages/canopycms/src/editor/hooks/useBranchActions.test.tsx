import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifications } from '@mantine/notifications'
import { isValidElement, type ReactNode } from 'react'
import { useBranchActions } from './useBranchActions'
import { useDraftManager, type UnsavedSummary } from './useDraftManager'
import type { EditorEntry } from '../Editor'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
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

/** The text a (mocked) confirm modal would show, from its React children. */
const textOf = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** The URLs the hook passed to `history.replaceState`. */
const replacedUrls = () =>
  vi.mocked(window.history.replaceState).mock.calls.map((call) => String(call[2]))

describe('useBranchActions', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>
  const mockSetBranchName = vi.fn()
  const CLEAN: UnsavedSummary = { count: 0, labels: [] }
  const DIRTY: UnsavedSummary = { count: 1, labels: ['About'] }
  const mockGetUnsaved = vi.fn<() => Promise<UnsavedSummary>>()
  const mockOnReloadBranches = vi.fn().mockResolvedValue(undefined)
  const mockOnBranchSwitch = vi.fn()
  const mockOnBranchCreated = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    setBranchName: mockSetBranchName,
    getUnsaved: mockGetUnsaved,
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
    mockGetUnsaved.mockResolvedValue(CLEAN)
    // clearAllMocks (afterEach) keeps implementations, so a modal behavior set by one test would leak.
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockReset()
    window.localStorage.clear()
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
    mockGetUnsaved.mockResolvedValue(DIRTY) // some entry (not necessarily selected) is dirty

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
    mockGetUnsaved.mockResolvedValue(DIRTY)

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
    mockGetUnsaved.mockResolvedValue(DIRTY)

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

  describe('confirmCreate', () => {
    it('resolves true without a dialog when nothing is unsaved', async () => {
      const { modals } = await import('@mantine/modals')
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.confirmCreate()
      })

      expect(ok).toBe(true)
      expect(modals.openConfirmModal).not.toHaveBeenCalled()
    })

    it('resolves false when the user declines', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue(DIRTY)
      vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
        config.onCancel?.()
        return 'modal-id'
      })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.confirmCreate()
      })

      expect(ok).toBe(false)
    })

    it('resolves false when the modal is dismissed by Escape or the overlay', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue(DIRTY)
      // Mantine fires only onClose for these exits, never onCancel.
      vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
        config.onClose?.()
        return 'modal-id'
      })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.confirmCreate()
      })

      expect(ok).toBe(false)
    })

    it('resolves true when confirmed, despite the close that follows the confirm', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue(DIRTY)
      // Mantine closes the modal right after calling onConfirm.
      vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
        config.onConfirm?.()
        config.onClose?.()
        return 'modal-id'
      })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.confirmCreate()
      })

      expect(ok).toBe(true)
    })

    it('names the unsaved entries and the branch their drafts stay on', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue({ count: 2, labels: ['Site settings', 'About'] })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      act(() => {
        void result.current.confirmCreate()
      })
      await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalled())

      const text = textOf(vi.mocked(modals.openConfirmModal).mock.calls[0][0].children)
      expect(text).toContain('Unsaved changes in: Site settings, About.')
      expect(text).toContain('Your drafts stay on “main” and come back when you return.')
      expect(vi.mocked(modals.openConfirmModal).mock.calls[0][0].labels).toEqual({
        confirm: 'Continue Anyway',
        cancel: 'Cancel',
      })
    })

    it('abbreviates a long list of unsaved entries', async () => {
      const { modals } = await import('@mantine/modals')
      const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      mockGetUnsaved.mockResolvedValue({ count: 7, labels })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      act(() => {
        void result.current.confirmCreate()
      })
      await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalled())

      const text = textOf(vi.mocked(modals.openConfirmModal).mock.calls[0][0].children)
      expect(text).toContain('Unsaved changes in: A, B, C, D, E and 2 more.')
    })

    it('falls back to a generic message when no entry label is known', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue({ count: 1, labels: [] })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

      act(() => {
        void result.current.confirmCreate()
      })
      await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalled())

      expect(textOf(vi.mocked(modals.openConfirmModal).mock.calls[0][0].children)).toContain(
        'You have unsaved changes.',
      )
    })

    it('reports the confirm as open until it settles', async () => {
      const { modals } = await import('@mantine/modals')
      mockGetUnsaved.mockResolvedValue(DIRTY)
      let settleConfirm: () => void = () => {}
      vi.mocked(modals.openConfirmModal).mockImplementation((config) => {
        settleConfirm = () => config.onCancel?.()
        return 'modal-id'
      })
      const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })
      expect(result.current.confirmOpen).toBe(false)

      act(() => {
        void result.current.confirmCreate()
      })
      await waitFor(() => expect(result.current.confirmOpen).toBe(true))

      act(() => settleConfirm())
      await waitFor(() => expect(result.current.confirmOpen).toBe(false))
    })
  })

  it('handleCreateBranch does not ask about unsaved changes itself', async () => {
    const { modals } = await import('@mantine/modals')
    mockGetUnsaved.mockResolvedValue(DIRTY)
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
    const { result } = renderHook(() => useBranchActions(defaultOptions), { wrapper })

    let created: boolean | undefined
    await act(async () => {
      created = await result.current.handleCreateBranch({ name: 'new-branch' })
    })

    expect(created).toBe(true)
    expect(modals.openConfirmModal).not.toHaveBeenCalled()
    expect(mockClient.branches.create).toHaveBeenCalledTimes(1)
  })

  it('shows no dialog when the only drafts are pristine leftovers, once they are verified', async () => {
    const { modals } = await import('@mantine/modals')
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('about'),
      contentId: unsafeAsContentId('abc123def456'),
      label: 'About',
      schema: [],
    }
    window.localStorage.setItem(
      'canopycms:drafts:main',
      JSON.stringify({ v: 2, drafts: { abc123def456: { title: 'Server' } }, baseVersions: {} }),
    )
    const readEntryValue = vi.fn(async () => ({ title: 'Server' }))
    const entries = [entry]
    const { result } = renderHook(
      () => {
        // The real draft manager over a restored draft whose server value is identical.
        const manager = useDraftManager({
          branchName: 'main',
          selectedPath: '',
          currentEntry: undefined,
          entries,
          loadEntry: vi.fn(),
          readEntryValue,
          saveEntry: vi.fn(),
          setBusy: vi.fn(),
        })
        const actions = useBranchActions({ ...defaultOptions, getUnsaved: manager.resolveUnsaved })
        return { manager, actions }
      },
      { wrapper },
    )

    // Not inside act(): its queue holds the verification read's state update until the
    // callback returns, which is the callback waiting on that very update.
    let ok: boolean | undefined
    void result.current.actions.confirmCreate().then((value) => {
      ok = value
    })
    await waitFor(() => expect(ok).toBeDefined())

    expect(readEntryValue).toHaveBeenCalledTimes(1)
    expect(ok).toBe(true)
    expect(modals.openConfirmModal).not.toHaveBeenCalled()
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
