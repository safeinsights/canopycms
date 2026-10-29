import type React from 'react'
import { ApiTimeoutError } from '../../api/request-deadline'
import { CanopyApiClient } from '../../api/client'
import type { RetryToastMessageProps } from '../components/RetryToastMessage'
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { useSWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  branchActionOutcomeUnknown,
  CREATED_BRANCH_GRACE_MS,
  useBranchManager,
  UseBranchManagerOptions,
  withdrawPullRequestBullet,
} from './useBranchManager'
import type { BranchListItem } from '../../api/branch'
import { BRANCHES_KEY } from './useBranchesData'
import type { BranchMetadata } from '../../types'
import type { CommentThread } from '../../comment-store'
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

  // The listing with 'feature' still being edited, so a submit of it goes through.
  const editingFeature: BranchMetadata[] = [
    mockBranches[0],
    { ...mockBranches[1], status: 'editing' },
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
      data: { branches: [], users: [] },
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
      data: { branches: mockBranches, users: [] },
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
      data: { branches: mockBranches, users: [] },
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
      data: { branches: mockBranches, defaultBranch: 'feature-x', users: [] },
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
      data: { branches: mockBranches, defaultBranch: 'feature-x', users: [] },
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
      .mockResolvedValue({ ok: true, status: 200, data: { branches: mockBranches, users: [] } })

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

  it('offers Retry on the sticky error toast, which reloads the branch list', async () => {
    const { restore } = setupMockConsole(['error'])
    const { notifications } = await import('@mantine/notifications')
    mockClient.branches.list
      .mockRejectedValueOnce(new ApiTimeoutError('GET', '/branches', 30_000))
      .mockResolvedValue({ ok: true, status: 200, data: { branches: mockBranches, users: [] } })

    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })

    let toast: { message?: unknown } | undefined
    await waitFor(() => {
      toast = vi
        .mocked(notifications.show)
        .mock.calls.map(([n]) => n)
        .find((n) => n.id === 'canopy-branches-load-failed')
      expect(toast).toBeDefined()
    })
    expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
    expect(toast).toMatchObject({ title: 'Could not load branches' })

    await act(async () =>
      (toast?.message as React.ReactElement<RetryToastMessageProps>).props.onRetry(),
    )

    await waitFor(() => expect(result.current.branches).toEqual(mockBranches))
    expect(mockClient.branches.list).toHaveBeenCalledTimes(2)
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
          message: expect.objectContaining({
            props: expect.objectContaining({
              message: "Branch workspace provisioning failed for 'main': clone failed",
            }),
          }),
          color: 'red',
        }),
      )
    })

    restore()
  })

  it('passes the managerOrAdminAllowed lockdown through branchSummaries', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        branches: [
          mockBranches[0],
          {
            ...mockBranches[1],
            access: { ...mockBranches[1].access, managerOrAdminAllowed: true },
          },
        ],
        users: [],
      },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.branchSummaries).toHaveLength(2)
    })

    expect(result.current.branchSummaries[0].access?.managerOrAdminAllowed).toBeUndefined()
    expect(result.current.branchSummaries[1].access?.managerOrAdminAllowed).toBe(true)
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
      data: { branches: branchesWithPrState, users: [] },
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
      data: { branches: branchesWithFlags, users: [] },
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
    // lock the status names once something is already locked, so it alone
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
      data: { branches: branchesWithFlags, defaultBranch: 'main', users: [] },
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
      data: { branches: branchesWithSyncState, users: [] },
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

  it('computes currentBranch', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches, users: [] },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.currentBranch).toEqual(mockBranches[0])
    })
  })

  it('resolves currentBranch when state holds the raw form of a sanitized branch name', async () => {
    // Legacy deep-link case: the URL/state carries the raw, unsanitized name
    // (e.g. "feature/x") but the server only ever persisted the sanitized
    // form ("feature-x"). currentBranch must still resolve so its status,
    // access, and isProtected/readOnly flags are available to the header.
    const sanitizedBranch: BranchMetadata = {
      ...mockBranches[1],
      name: 'feature-x',
    }
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: [mockBranches[0], sanitizedBranch], users: [] },
    })

    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: 'feature/x' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    expect(result.current.currentBranch).toEqual(sanitizedBranch)
    await waitFor(() => expect(result.current.branchName).toBe('feature-x'))
  })

  it('opens a namespace branch named by its short name, unlocked and acting on its full name', async () => {
    const spring: BranchListItem = {
      ...mockBranches[1],
      name: 'canopycms/local/spring',
      shortName: 'spring',
      status: 'editing',
      writeBlocked: false,
      submitBlocked: false,
      isProtected: false,
    }
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: [mockBranches[0], spring], users: [] },
    })
    mockClient.workflow.submit.mockResolvedValueOnce({ ok: true, status: 200 })
    const thread: CommentThread = {
      id: 't1',
      comments: [],
      resolved: false,
      createdAt: '2024-01-01',
      type: 'branch',
      authorId: 'user1',
    }

    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: 'spring', comments: [thread] }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.branches).toHaveLength(2))

    expect(result.current.currentBranch?.name).toBe('canopycms/local/spring')
    expect(result.current.currentBranch?.writeBlocked).toBe(false)
    await waitFor(() => expect(result.current.branchName).toBe('canopycms/local/spring'))
    expect(
      result.current.branchSummaries.find((b) => b.name === 'canopycms/local/spring')?.commentCount,
    ).toBe(1)

    await act(async () => {
      await result.current.handleSubmit('spring')
    })
    expect(mockClient.workflow.submit).toHaveBeenCalledWith(
      { branch: 'canopycms/local/spring' },
      expect.anything(),
    )
  })

  it('leaves a deleted namespace branch opened by its short name', async () => {
    const spring: BranchListItem = {
      ...mockBranches[1],
      name: 'canopycms/local/spring',
      shortName: 'spring',
      status: 'editing',
    }
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: [mockBranches[0], spring], defaultBranch: 'main', users: [] },
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: [mockBranches[0]], defaultBranch: 'main', users: [] },
      })
    mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })
    const { result } = renderHook(
      () => useBranchManager({ ...defaultOptions, initialBranch: 'spring' }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.currentBranch?.name).toBe('canopycms/local/spring'))

    await act(async () => {
      await result.current.handleDelete('spring')
    })

    expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'canopycms/local/spring' })
    expect(result.current.branchName).toBe('main')
  })

  describe('branches created this session', () => {
    const createdBranch: BranchListItem = {
      name: 'new-branch',
      status: 'editing',
      title: 'New Branch',
      access: { allowedUsers: [], allowedGroups: [] },
      createdBy: 'user1',
      createdAt: '2024-02-01',
      updatedAt: '2024-02-01',
      isProtected: false,
      readOnly: false,
      writeBlocked: false,
      submitBlocked: false,
    }

    // A listing served by a container that has not yet seen the new branch.
    const mockStaleListing = () =>
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })

    const renderLoaded = async () => {
      const hook = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => {
        expect(hook.result.current.branches).toHaveLength(2)
      })
      return hook
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shows an added branch in branches and branchSummaries and resolves it as currentBranch', async () => {
      mockStaleListing()
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
      })

      expect(result.current.branches.map((b) => b.name)).toEqual(['main', 'feature', 'new-branch'])
      expect(result.current.branchSummaries.map((b) => b.name)).toContain('new-branch')

      act(() => {
        result.current.setBranchName('new-branch')
      })

      expect(result.current.currentBranch).toEqual(createdBranch)
      expect(result.current.branchSummaries.find((b) => b.name === 'new-branch')).toMatchObject({
        isProtected: false,
        writeBlocked: false,
        submitBlocked: false,
      })
    })

    it('keeps an added branch, and the selected branch name, across a listing that lags the create', async () => {
      mockStaleListing()
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
        result.current.setBranchName('new-branch')
      })

      await act(async () => {
        await result.current.loadBranches()
      })

      expect(mockClient.branches.list).toHaveBeenCalledTimes(2)
      expect(result.current.branches.map((b) => b.name)).toContain('new-branch')
      expect(result.current.branchName).toBe('new-branch')
      expect(result.current.currentBranch).toEqual(createdBranch)
    })

    it('prefers the server copy once a listing includes the branch, and keeps it through a lagging listing after that', async () => {
      const t0 = 1_700_000_000_000
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
      mockStaleListing()
      const renders: BranchListItem[][] = []
      const { result } = renderHook(
        () => {
          const manager = useBranchManager(defaultOptions)
          renders.push(manager.branches)
          return manager
        },
        { wrapper },
      )
      await waitFor(() => {
        expect(result.current.branches).toHaveLength(2)
      })

      act(() => {
        result.current.addCreatedBranch(createdBranch)
      })

      const serverCopy: BranchListItem = {
        ...createdBranch,
        status: 'submitted',
        updatedAt: '2024-02-02',
        writeBlocked: true,
      }
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: [...mockBranches, serverCopy], users: [] },
      })
      await act(async () => {
        await result.current.loadBranches()
      })

      const copies = result.current.branches.filter((b) => b.name === 'new-branch')
      expect(copies).toEqual([serverCopy])
      // Not even transiently, between the listing landing and the pending copy being replaced.
      const listedRenders = renders.filter((list) =>
        list.some((b) => b.name === 'new-branch' && b.status === 'submitted'),
      )
      expect(listedRenders.length).toBeGreaterThan(0)
      for (const list of listedRenders) {
        expect(list.filter((b) => b.name === 'new-branch')).toEqual([serverCopy])
      }

      // Another container's listing can still lag it; the latest listed copy stays.
      now.mockReturnValue(t0 + 1_000)
      mockStaleListing()
      await act(async () => {
        await result.current.loadBranches()
      })
      expect(result.current.branches.filter((b) => b.name === 'new-branch')).toEqual([serverCopy])

      now.mockReturnValue(t0 + CREATED_BRANCH_GRACE_MS + 1)
      await act(async () => {
        await result.current.loadBranches()
      })
      expect(result.current.branches.map((b) => b.name)).not.toContain('new-branch')
    })

    it('drops an added branch once a listing past the grace window still lacks it', async () => {
      const t0 = 1_700_000_000_000
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
      mockStaleListing()
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
      })

      // Exactly at the bound the branch is still within the grace window.
      now.mockReturnValue(t0 + CREATED_BRANCH_GRACE_MS)
      await act(async () => {
        await result.current.loadBranches()
      })
      expect(result.current.branches.map((b) => b.name)).toContain('new-branch')

      now.mockReturnValue(t0 + CREATED_BRANCH_GRACE_MS + 1)
      await act(async () => {
        await result.current.loadBranches()
      })
      expect(result.current.branches.map((b) => b.name)).not.toContain('new-branch')
    })

    it('lists an added branch once when it is added again', async () => {
      mockStaleListing()
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
        result.current.addCreatedBranch({ ...createdBranch, title: 'Renamed' })
      })

      const copies = result.current.branches.filter((b) => b.name === 'new-branch')
      expect(copies).toHaveLength(1)
      expect(copies[0].title).toBe('Renamed')
    })

    it('takes the server copy of an added branch from an automatic revalidation', async () => {
      mockStaleListing()
      const { result } = renderHook(
        () => ({ manager: useBranchManager(defaultOptions), swr: useSWRConfig() }),
        { wrapper },
      )
      await waitFor(() => {
        expect(result.current.manager.branches).toHaveLength(2)
      })

      act(() => {
        result.current.manager.addCreatedBranch(createdBranch)
      })

      // SWR's own revalidation, not the hook's loadBranches().
      const serverCopy: BranchListItem = { ...createdBranch, status: 'submitted' }
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: [...mockBranches, serverCopy], users: [] },
      })
      await act(async () => {
        await result.current.swr.mutate(BRANCHES_KEY)
      })
      await waitFor(() => {
        expect(result.current.manager.branches).toHaveLength(3)
      })

      // Written straight to the cache, bypassing loadBranches(), so only an
      // update that already ran on the listing above can show the server copy now.
      await act(async () => {
        await result.current.swr.mutate(
          BRANCHES_KEY,
          { branches: mockBranches, receivedAt: Date.now() },
          { revalidate: false },
        )
      })

      expect(result.current.manager.branches.filter((b) => b.name === 'new-branch')).toEqual([
        serverCopy,
      ])
    })

    it('keeps an added branch when a cache write carries no receivedAt', async () => {
      mockStaleListing()
      const { result } = renderHook(
        () => ({ manager: useBranchManager(defaultOptions), swr: useSWRConfig() }),
        { wrapper },
      )
      await waitFor(() => {
        expect(result.current.manager.branches).toHaveLength(2)
      })
      act(() => {
        result.current.manager.addCreatedBranch(createdBranch)
      })

      await act(async () => {
        await result.current.swr.mutate(
          BRANCHES_KEY,
          { branches: mockBranches },
          { revalidate: false },
        )
      })

      expect(result.current.manager.branches.map((b) => b.name)).toContain('new-branch')
    })

    it('keeps an added branch when a revalidation past the grace window fails', async () => {
      const t0 = 1_700_000_000_000
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
      mockStaleListing()
      const { result } = renderHook(
        () => ({ manager: useBranchManager(defaultOptions), swr: useSWRConfig() }),
        { wrapper },
      )
      await waitFor(() => {
        expect(result.current.manager.branches).toHaveLength(2)
      })
      act(() => {
        result.current.manager.addCreatedBranch(createdBranch)
      })

      // SWR keeps the previous (lagging) listing as `data` when a revalidation fails.
      now.mockReturnValue(t0 + CREATED_BRANCH_GRACE_MS + 1)
      // Rejected only once the fetch is in flight, so the in-flight render is observed.
      let rejectList: (err: Error) => void = () => {}
      mockClient.branches.list.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectList = reject
        }),
      )
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let revalidation: Promise<unknown> = Promise.resolve()
      act(() => {
        revalidation = result.current.swr.mutate(BRANCHES_KEY).catch(() => {})
      })
      await waitFor(() => {
        expect(mockClient.branches.list).toHaveBeenCalledTimes(2)
      })
      await act(async () => {
        rejectList(new Error('network down'))
        await revalidation
      })

      expect(result.current.manager.branches.map((b) => b.name)).toContain('new-branch')
    })

    it.each([
      ['submit', 'handleSubmit', 'submitted'],
      ['withdraw', 'handleWithdraw', 'editing'],
      ['requestChanges', 'handleRequestChanges', 'editing'],
    ] as const)(
      'overlays the copy %s returns on an added branch a lagging listing still lacks',
      async (endpoint, handler, status) => {
        mockStaleListing()
        const returned: BranchListItem = {
          ...createdBranch,
          status,
          writeBlocked: status !== 'editing',
          submitBlocked: status !== 'editing',
        }
        mockClient.workflow[endpoint].mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branch: returned },
        })
        const { result } = await renderLoaded()

        act(() => {
          result.current.addCreatedBranch(createdBranch)
          result.current.setBranchName('new-branch')
        })

        await act(async () => {
          await result.current[handler]('new-branch')
        })

        expect(mockClient.workflow[endpoint].mock.calls[0]?.[0]).toEqual({ branch: 'new-branch' })
        expect(mockClient.branches.list).toHaveBeenCalledTimes(2)
        expect(result.current.currentBranch).toEqual(returned)
      },
    )

    it.each([
      ['submit', 'handleSubmit'],
      ['withdraw', 'handleWithdraw'],
      ['requestChanges', 'handleRequestChanges'],
    ] as const)(
      'stops overlaying an added branch when %s returns no copy, so its pre-action state cannot show',
      async (endpoint, handler) => {
        mockStaleListing()
        mockClient.workflow[endpoint].mockResolvedValueOnce({ ok: true, status: 200 })
        const { result } = await renderLoaded()

        act(() => {
          result.current.addCreatedBranch(createdBranch)
        })
        expect(result.current.branches.map((b) => b.name)).toContain('new-branch')

        await act(async () => {
          await result.current[handler]('new-branch')
        })

        expect(result.current.branches.map((b) => b.name)).not.toContain('new-branch')
      },
    )

    it('removes an added branch when it is deleted, even though a lagging listing lacks it', async () => {
      mockStaleListing()
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
      })
      expect(result.current.branches.map((b) => b.name)).toContain('new-branch')

      await act(async () => {
        await result.current.handleDelete('new-branch')
      })

      expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'new-branch' })
      expect(result.current.branches.map((b) => b.name)).not.toContain('new-branch')
    })

    it('keeps an added branch when deleting it fails', async () => {
      mockStaleListing()
      mockClient.branches.delete.mockResolvedValueOnce({ ok: false, status: 500, error: 'nope' })
      const { result } = await renderLoaded()

      act(() => {
        result.current.addCreatedBranch(createdBranch)
      })

      await act(async () => {
        await result.current.handleDelete('new-branch')
      })

      expect(result.current.branches.map((b) => b.name)).toContain('new-branch')
    })
  })

  describe('confirmation dialog copy', () => {
    const lastDialog = async () => {
      const { modals } = await import('@mantine/modals')
      const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
      if (!options) throw new Error('no confirm dialog was opened')
      const shown = render(<MantineProvider>{options.children}</MantineProvider>)
      const body = shown.container.textContent ?? ''
      shown.unmount()
      return { options, body }
    }
    const loaded = async (
      branches: BranchMetadata[],
      overrides: Partial<UseBranchManagerOptions> = {},
    ) => {
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches, users: [] },
      })
      const hook = renderHook(() => useBranchManager({ ...defaultOptions, ...overrides }), {
        wrapper,
      })
      await waitFor(() => {
        expect(hook.result.current.branches).toHaveLength(2)
      })
      return hook
    }

    it('asks to submit for review, with a labelled confirm button', async () => {
      mockClient.workflow.submit.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(editingFeature)

      await act(async () => {
        await result.current.handleSubmit('feature')
      })

      const { options, body } = await lastDialog()
      expect(options.title).toBe('Submit for review')
      expect(options.labels).toEqual({ confirm: 'Submit for review', cancel: 'Cancel' })
      expect(options.confirmProps).toEqual(
        expect.objectContaining({ 'data-testid': 'confirm-submit-branch' }),
      )
      expect(body).toContain('Submit “feature” for review?')
      expect(body).toContain('• Create a pull request for review')
      expect(body).not.toContain('Are you sure')
    })

    it('names unsaved entries on the open branch, which the submit leaves out', async () => {
      mockClient.workflow.submit.mockResolvedValueOnce({ ok: true, status: 200 })
      const getUnsaved = vi.fn(async () => ({ count: 2, labels: ['Home', 'About'] }))
      const { result } = await loaded(editingFeature, { initialBranch: 'feature', getUnsaved })

      await act(async () => {
        await result.current.handleSubmit('feature')
      })

      const { options, body } = await lastDialog()
      expect(options.labels).toEqual({ confirm: 'Submit anyway', cancel: 'Cancel' })
      expect(body).toContain("2 entries have unsaved changes that won't be submitted")
      expect(body).toContain('Unsaved changes in: "Home", "About".')
      expect(body).toContain('Submit “feature” for review?')
    })

    it('checks the open branch opened by its unsanitized name, showing busy meanwhile', async () => {
      mockClient.workflow.submit.mockResolvedValueOnce({ ok: true, status: 200 })
      let answer: (summary: { count: number; labels: string[] }) => void = () => {}
      const getUnsaved = vi.fn(
        () => new Promise<{ count: number; labels: string[] }>((resolve) => (answer = resolve)),
      )
      const { result } = await loaded(
        [mockBranches[0], { ...mockBranches[1], name: 'feature-x', status: 'editing' }],
        { initialBranch: 'feature/x', getUnsaved },
      )
      mockSetBusy.mockClear()

      let pending!: Promise<void>
      act(() => {
        pending = result.current.handleSubmit('feature/x')
      })
      await waitFor(() => expect(getUnsaved).toHaveBeenCalled())
      expect(mockSetBusy).toHaveBeenLastCalledWith(true)
      await act(async () => {
        answer({ count: 1, labels: ['Home'] })
        await pending
      })

      const { options } = await lastDialog()
      expect(options.labels).toEqual({ confirm: 'Submit anyway', cancel: 'Cancel' })
    })

    it("asks nothing about another branch's drafts", async () => {
      mockClient.workflow.submit.mockResolvedValueOnce({ ok: true, status: 200 })
      const getUnsaved = vi.fn(async () => ({ count: 1, labels: ['Home'] }))
      const { result } = await loaded(editingFeature, { getUnsaved })

      await act(async () => {
        await result.current.handleSubmit('feature')
      })

      const { options, body } = await lastDialog()
      expect(getUnsaved).not.toHaveBeenCalled()
      expect(options.labels).toEqual({ confirm: 'Submit for review', cancel: 'Cancel' })
      expect(body).not.toContain('unsaved')
    })

    describe("a submit's stamps", () => {
      const stamped = [
        {
          contentId: unsafeAsContentId('abc123def456'),
          fields: { publishedAt: '2026-10-14T09:00:00.000Z' },
          previousVersion: 100,
          version: 150,
        },
      ]
      const answer = () =>
        mockClient.workflow.submit.mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            branch: { ...editingFeature[1], status: 'submitted' } as BranchListItem,
            stamped,
          },
        })

      it('hands the entries stamped on the open branch to the drafts', async () => {
        answer()
        const onStamped = vi.fn()
        const { result } = await loaded(editingFeature, { initialBranch: 'feature', onStamped })

        await act(async () => {
          await result.current.handleSubmit('feature')
        })

        expect(onStamped).toHaveBeenCalledWith(stamped)
      })

      it('says how many new entries the submit dated', async () => {
        const { notifications } = await import('@mantine/notifications')
        answer()
        const { result } = await loaded(editingFeature, { initialBranch: 'feature' })

        await act(async () => {
          await result.current.handleSubmit('feature')
        })

        expect(notifications.show).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Branch submitted for review. Dates set on 1 new entry.',
          }),
        )
      })

      it("hands over nothing from another branch's submit", async () => {
        answer()
        const onStamped = vi.fn()
        const { result } = await loaded(editingFeature, { onStamped })

        await act(async () => {
          await result.current.handleSubmit('feature')
        })

        expect(mockClient.workflow.submit).toHaveBeenCalled()
        expect(onStamped).not.toHaveBeenCalled()
      })
    })

    it('asks to withdraw from review, with a labelled confirm button', async () => {
      mockClient.workflow.withdraw.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(mockBranches)

      await act(async () => {
        await result.current.handleWithdraw('feature')
      })

      const { options, body } = await lastDialog()
      expect(options.title).toBe('Withdraw from review')
      expect(options.labels).toEqual({ confirm: 'Withdraw from review', cancel: 'Cancel' })
      expect(options.confirmProps).toEqual(
        expect.objectContaining({ 'data-testid': 'confirm-withdraw-branch' }),
      )
      expect(body).toContain('Withdraw “feature” from review?')
      expect(body).toContain('• Change the branch status back to “editing”')
      expect(body).not.toContain('Are you sure')
    })

    it('asks to delete the branch in sentence case', async () => {
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(mockBranches)

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      const { options, body } = await lastDialog()
      expect(options.title).toBe('Delete branch')
      expect(options.labels).toEqual({ confirm: 'Delete branch', cancel: 'Cancel' })
      expect(body).toContain('Delete “feature”?')
      expect(body).toContain('This cannot be undone.')
      expect(body).not.toContain('Are you sure')
    })
  })

  it('submits branch successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: editingFeature, users: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: editingFeature, users: [] },
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

    // The PR body's editor links start from the page the editor runs on.
    expect(mockClient.workflow.submit).toHaveBeenCalledWith(
      { branch: 'feature' },
      { editorUrl: `${window.location.origin}${window.location.pathname}` },
    )
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
  })

  it('handles submit error', async () => {
    const { restore } = setupMockConsole(['error'])
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: editingFeature, users: [] },
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

  it('ends a timed-out submit, says it may have gone through, and reloads the list to show it', async () => {
    const { restore } = setupMockConsole(['error'])
    const { notifications } = await import('@mantine/notifications')
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: editingFeature, users: [] },
    })
    mockClient.workflow.submit.mockRejectedValueOnce(
      new ApiTimeoutError('POST', '/feature/submit', 180_000),
    )

    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
    await waitFor(() => expect(result.current.branches).toHaveLength(2))
    let finishReload: () => void = () => {}
    mockClient.branches.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = () =>
            resolve({ ok: true, status: 200, data: { branches: editingFeature, users: [] } })
        }),
    )

    let settled = false
    await act(async () => {
      void result.current
        .handleSubmit('feature')
        .catch(() => {})
        .finally(() => (settled = true))
    })

    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: branchActionOutcomeUnknown('Submit for review'),
        color: 'yellow',
        autoClose: false,
      }),
    )
    // The reload runs inside the action's busy window: still busy until the list answers.
    expect(settled).toBe(false)
    expect(mockSetBusy).toHaveBeenLastCalledWith(true)
    await act(async () => finishReload())
    await waitFor(() => expect(settled).toBe(true))
    expect(mockSetBusy).toHaveBeenLastCalledWith(false)
    restore()
  })

  describe('a delete that times out', () => {
    const deleteTimesOut = async (listedAfter: BranchMetadata[]) => {
      mockClient.branches.list
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branches: editingFeature, users: [] },
        })
        .mockResolvedValue({ ok: true, status: 200, data: { branches: listedAfter, users: [] } })
      mockClient.branches.delete.mockRejectedValueOnce(
        new ApiTimeoutError('DELETE', '/feature', 75_000),
      )
      const hook = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => expect(hook.result.current.branches).toHaveLength(2))
      act(() => hook.result.current.setBranchName('feature'))
      await act(async () => {
        await hook.result.current.handleDelete('feature')
      })
      return hook
    }

    it('reports it deleted, and leaves it, when the reloaded list no longer has it', async () => {
      const { notifications } = await import('@mantine/notifications')
      const remaining = editingFeature.filter((b) => b.name !== 'feature')
      const { result } = await deleteTimesOut(remaining)

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Branch deleted' }),
      )
      expect(result.current.branchName).not.toBe('feature')
    })

    it('does not report a just-created branch deleted when only the listing lacks it', async () => {
      const { notifications } = await import('@mantine/notifications')
      const created = { ...mockBranches[1], name: 'brand-new', status: 'editing' as const }
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: editingFeature, users: [] },
      })
      mockClient.branches.delete.mockRejectedValueOnce(
        new ApiTimeoutError('DELETE', '/brand-new', 75_000),
      )
      const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => expect(result.current.branches).toHaveLength(2))
      act(() => result.current.addCreatedBranch(created as unknown as BranchListItem))
      act(() => result.current.setBranchName('brand-new'))

      await act(async () => {
        await result.current.handleDelete('brand-new')
      })

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: branchActionOutcomeUnknown('Delete branch') }),
      )
      expect(result.current.branchName).toBe('brand-new')
    })

    it("takes the API's 404 as an earlier delete having gone through, and leaves the branch", async () => {
      const { notifications } = await import('@mantine/notifications')
      const remaining = editingFeature.filter((b) => b.name !== 'feature')
      mockClient.branches.list
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branches: editingFeature, users: [] },
        })
        .mockResolvedValue({ ok: true, status: 200, data: { branches: remaining, users: [] } })
      mockClient.branches.delete.mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: 'Branch not found',
      })
      const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => expect(result.current.branches).toHaveLength(2))
      act(() => result.current.setBranchName('feature'))

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Branch deleted' }),
      )
      expect(result.current.branchName).not.toBe('feature')
    })

    it('treats a gateway error page like no answer', async () => {
      const { notifications } = await import('@mantine/notifications')
      const gateway = new CanopyApiClient({
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 504,
          headers: new Headers(),
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }),
      })
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: editingFeature, users: [] },
      })
      mockClient.workflow.submit.mockResolvedValueOnce(
        await gateway.workflow.submit({ branch: 'feature' }, {}),
      )
      const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => expect(result.current.branches).toHaveLength(2))

      await act(async () => {
        await result.current.handleSubmit('feature').catch(() => {})
      })

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: branchActionOutcomeUnknown('Submit for review') }),
      )
    })

    it('says it may have gone through when the branch is still listed', async () => {
      const { notifications } = await import('@mantine/notifications')
      const { result } = await deleteTimesOut(editingFeature)

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: branchActionOutcomeUnknown('Delete branch') }),
      )
      expect(result.current.branchName).toBe('feature')
    })
  })

  it('withdraws branch successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
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

  // CF1/D2: delete is irreversible -- unlike submit/withdraw, which the
  // top-of-file modals mock auto-confirms for every other test in this file
  // -- so this exercises the actual confirm/cancel branches rather than
  // relying on the blanket auto-confirm.
  describe('handleDelete confirmation (CF1/D2)', () => {
    it('shows a confirmation modal naming the branch before deleting', async () => {
      const { modals } = await import('@mantine/modals')
      mockClient.branches.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })

      const { result } = renderHook(() => useBranchManager(defaultOptions), {
        wrapper,
      })

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(2)
      })

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmProps: expect.objectContaining({ color: 'red' }),
        }),
      )
      // The modal mock auto-confirms, so the delete call is the proof the
      // confirmation flow actually ran through to onConfirm, not just that
      // the modal was shown.
      expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'feature' })
    })

    it('cancelling the confirmation issues no delete request', async () => {
      const { modals } = await import('@mantine/modals')
      // Override the default auto-confirm mock for this test only: simulate
      // the user clicking "Cancel" instead of "Delete branch".
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onCancel?.()
        return 'mock-modal-id'
      })

      mockClient.branches.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })

      const { result } = renderHook(() => useBranchManager(defaultOptions), {
        wrapper,
      })

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(2)
      })

      // Resolves, not rejects: a dismissal is a normal outcome. The only
      // caller (Editor.tsx) catches into console.error, so rejecting turned
      // every Cancel click into a logged error.
      await act(async () => {
        await expect(result.current.handleDelete('feature')).resolves.toBeUndefined()
      })

      expect(mockClient.branches.delete).not.toHaveBeenCalled()
    })

    // Mantine does not call onCancel for these, so a promise settled only by
    // onCancel stayed pending forever and the caller's `await` never returned.
    it('resolves when the confirmation is dismissed via Escape or the overlay', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onClose?.()
        return 'mock-modal-id'
      })

      mockClient.branches.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })

      const { result } = renderHook(() => useBranchManager(defaultOptions), {
        wrapper,
      })

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(2)
      })

      await act(async () => {
        await expect(result.current.handleDelete('feature')).resolves.toBeUndefined()
      })

      expect(mockClient.branches.delete).not.toHaveBeenCalled()
    })

    it('confirming issues exactly one delete request', async () => {
      mockClient.branches.list.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })

      const { result } = renderHook(() => useBranchManager(defaultOptions), {
        wrapper,
      })

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(2)
      })

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(mockClient.branches.delete).toHaveBeenCalledTimes(1)
      expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'feature' })
    })
  })

  it('requests changes successfully', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
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

    expect(mockClient.workflow.requestChanges).toHaveBeenCalledWith({ branch: 'feature' }, {})
  })

  it('opens one Request changes confirm for a double-click', async () => {
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockImplementation(() => 'mock-modal-id')
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches, users: [] },
    })
    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    act(() => {
      void result.current.handleRequestChanges('feature')
      void result.current.handleRequestChanges('feature')
    })

    expect(
      vi
        .mocked(modals.openConfirmModal)
        .mock.calls.filter(([options]) => options.title === 'Request changes'),
    ).toHaveLength(1)
  })

  it('asks before requesting changes, and a cancel sends nothing', async () => {
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
      options.onCancel?.()
      return 'mock-modal-id'
    })
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches, users: [] },
    })

    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
    await waitFor(() => {
      expect(result.current.branches).toHaveLength(2)
    })

    await act(async () => {
      await expect(result.current.handleRequestChanges('feature')).resolves.toBeUndefined()
    })

    expect(modals.openConfirmModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Request changes',
        confirmProps: expect.objectContaining({ color: 'red' }),
      }),
    )
    expect(mockClient.workflow.requestChanges).not.toHaveBeenCalled()
  })

  it('reloads branch data', async () => {
    mockClient.branches.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branches: mockBranches, users: [] },
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
      data: { branches: mockBranches, users: [] },
    })

    renderHook(() => useBranchManager(defaultOptions), { wrapper })

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalled()
    })

    const calls = (window.history.replaceState as any).mock.calls
    const urlCall = calls.find((call: any) => call[2].includes('branch='))
    expect(urlCall).toBeTruthy()
  })

  describe('the branch in ?branch=', () => {
    const spring: BranchListItem = {
      ...mockBranches[1],
      name: 'canopycms/local/spring',
      shortName: 'spring',
      status: 'editing',
      isProtected: false,
    }
    const branchesOf = (...branches: BranchListItem[]) =>
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: [mockBranches[0], ...branches], defaultBranch: 'main', users: [] },
      })
    const writtenBranches = () =>
      vi
        .mocked(window.history.replaceState)
        .mock.calls.map(([, , url]) => new URL(String(url)).searchParams.get('branch'))

    it('is the short name of the branch the state holds', async () => {
      branchesOf(spring)
      renderHook(() => useBranchManager({ ...defaultOptions, initialBranch: spring.name }), {
        wrapper,
      })

      await waitFor(() => expect(writtenBranches()).toEqual(['spring']))
    })

    it('is left as the link wrote it until the listing resolves the branch', async () => {
      mockClient.branches.list.mockReturnValue(new Promise(() => {}))
      renderHook(() => useBranchManager({ ...defaultOptions, initialBranch: spring.name }), {
        wrapper,
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(window.history.replaceState).not.toHaveBeenCalled()
    })

    it('is the full name the server lists for a namespace branch named after the active one', async () => {
      // `shortNameOf` gives such a branch its full name as its short name.
      const shadowed: BranchListItem = {
        ...spring,
        name: 'canopycms/local/main',
        shortName: 'canopycms/local/main',
      }
      branchesOf(shadowed)
      renderHook(() => useBranchManager({ ...defaultOptions, initialBranch: shadowed.name }), {
        wrapper,
      })

      await waitFor(() => expect(writtenBranches()).toEqual(['canopycms/local/main']))
    })

    describe('beside a branch outside the namespace named its short name', () => {
      const outside: BranchListItem = { ...spring, name: 'spring', shortName: 'spring' }
      const listBoth = () =>
        mockClient.branches.list.mockResolvedValue({
          ok: true,
          status: 200,
          data: {
            branches: [mockBranches[0], outside, spring],
            defaultBranch: 'main',
            users: [],
          },
        })
      // Earlier tests leave the confirm mock dismissing; these confirm, then put it back.
      let previousConfirm:
        | (typeof import('@mantine/modals'))['modals']['openConfirmModal']
        | undefined
      beforeEach(async () => {
        const { modals } = await import('@mantine/modals')
        const confirm = vi.mocked(modals.openConfirmModal)
        previousConfirm = confirm.getMockImplementation()
        confirm.mockImplementation((options) => {
          options.onConfirm?.()
          return 'mock-modal-id'
        })
      })
      afterEach(async () => {
        const { modals } = await import('@mantine/modals')
        if (previousConfirm) vi.mocked(modals.openConfirmModal).mockImplementation(previousConfirm)
      })
      const loaded = async (initialBranch: string) => {
        listBoth()
        const hook = renderHook(() => useBranchManager({ ...defaultOptions, initialBranch }), {
          wrapper,
        })
        await waitFor(() => expect(hook.result.current.currentBranch).toBeDefined())
        return hook
      }

      it('opens each by the name its card hands an action, and writes a URL that opens it', async () => {
        const opened = await loaded('refs/heads/spring')
        expect(opened.result.current.currentBranch?.name).toBe('spring')
        await waitFor(() => expect(writtenBranches()).toEqual(['refs/heads/spring']))
        opened.unmount()

        const other = await loaded('canopycms/local/spring')
        expect(other.result.current.currentBranch?.name).toBe('canopycms/local/spring')
        await waitFor(() => expect(writtenBranches()).toEqual(['refs/heads/spring', 'spring']))
      })

      it.each([
        ['the outside branch', 'refs/heads/spring', 'spring'],
        ['the namespace branch', 'canopycms/local/spring', 'canopycms/local/spring'],
      ])('sends every action on %s under its own name', async (_label, address, sent) => {
        const ok = { ok: true, status: 200 } as const
        mockClient.workflow.submit.mockResolvedValue(ok)
        mockClient.workflow.withdraw.mockResolvedValue(ok)
        mockClient.workflow.approve.mockResolvedValue(ok)
        mockClient.workflow.requestChanges.mockResolvedValue(ok)
        mockClient.branches.delete.mockResolvedValue(ok)
        const { result } = await loaded('main')

        await act(async () => {
          await result.current.handleSubmit(address)
          await result.current.handleWithdraw(address)
          await result.current.handleApprove(address)
          await result.current.handleRequestChanges(address)
          await result.current.handleDelete(address)
        })

        expect(mockClient.workflow.submit).toHaveBeenCalledWith({ branch: sent }, expect.anything())
        expect(mockClient.workflow.withdraw).toHaveBeenCalledWith({ branch: sent })
        expect(mockClient.workflow.approve).toHaveBeenCalledWith({ branch: sent })
        expect(mockClient.workflow.requestChanges).toHaveBeenCalledWith({ branch: sent }, {})
        expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: sent })
      })

      it('stays on the namespace branch when the outside one is deleted', async () => {
        mockClient.branches.delete.mockResolvedValue({ ok: true, status: 200 })
        const { result } = await loaded('spring')
        expect(result.current.currentBranch?.name).toBe('canopycms/local/spring')

        await act(async () => {
          await result.current.handleDelete('refs/heads/spring')
        })

        expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'spring' })
        expect(result.current.branchName).toBe('canopycms/local/spring')
      })

      it('leaves the outside branch when it is the one open and deleted', async () => {
        mockClient.branches.delete.mockResolvedValue({ ok: true, status: 200 })
        const { result } = await loaded('refs/heads/spring')
        expect(result.current.currentBranch?.name).toBe('spring')

        await act(async () => {
          await result.current.handleDelete('refs/heads/spring')
        })

        expect(result.current.branchName).toBe('main')
      })

      const listOnly = (...branches: BranchListItem[]) =>
        mockClient.branches.list.mockResolvedValue({
          ok: true,
          status: 200,
          data: { branches: [mockBranches[0], ...branches], defaultBranch: 'main', users: [] },
        })

      /** The hook, and every `branchName` it has given since the listing first resolved it. */
      const tracked = async (initialBranch: string) => {
        const given: string[] = []
        const hook = renderHook(
          () => {
            const manager = useBranchManager({ ...defaultOptions, initialBranch })
            if (manager.currentBranch) given.push(manager.branchName)
            return manager
          },
          { wrapper },
        )
        await waitFor(() => expect(hook.result.current.currentBranch).toBeDefined())
        return { ...hook, given }
      }

      it('keeps the outside branch, and the name its drafts are keyed by, as the shadow comes and goes', async () => {
        listBoth()
        const { result, given } = await tracked('refs/heads/spring')
        expect(result.current.currentBranch?.name).toBe('spring')

        listOnly(outside)
        await act(() => result.current.loadBranches())
        listBoth()
        await act(() => result.current.loadBranches())

        expect(result.current.currentBranch?.name).toBe('spring')
        expect(new Set(given)).toEqual(new Set(['spring']))
      })

      it('stays on the outside branch when a later listing gives its name to a namespace branch', async () => {
        listOnly(outside)
        const { result, given } = await tracked('spring')
        expect(result.current.currentBranch?.name).toBe('spring')

        listBoth()
        await act(() => result.current.loadBranches())

        expect(result.current.branches).toHaveLength(3)
        expect(result.current.currentBranch?.name).toBe('spring')
        expect(new Set(given)).toEqual(new Set(['spring']))
      })

      it('sends an action in the exact form once the listing drops its branch under the dialog', async () => {
        const { modals } = await import('@mantine/modals')
        let confirm: (() => void) | undefined
        vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
          confirm = options.onConfirm
          return 'mock-modal-id'
        })
        mockClient.branches.delete.mockResolvedValue({ ok: true, status: 200 })
        const { result } = await loaded('main')

        let deleting: Promise<void> | undefined
        act(() => {
          deleting = result.current.handleDelete('refs/heads/spring')
        })
        await waitFor(() => expect(confirm).toBeDefined())
        listOnly(spring)
        await act(() => result.current.loadBranches())
        await act(async () => {
          confirm?.()
          await deleting
        })

        expect(mockClient.branches.delete).toHaveBeenCalledWith({ branch: 'refs/heads/spring' })
      })
    })

    it('opens no branch for a raw name that a namespace branch shadows, and writes no URL', async () => {
      const outside: BranchListItem = { ...spring, name: 'feature-y', shortName: 'feature-y' }
      const namespaced: BranchListItem = {
        ...spring,
        name: 'canopycms/local/feature-y',
        shortName: 'feature-y',
      }
      branchesOf(outside, namespaced)
      const { result } = renderHook(
        () => useBranchManager({ ...defaultOptions, initialBranch: 'feature/y' }),
        { wrapper },
      )

      await waitFor(() => expect(result.current.branches).toHaveLength(3))
      expect(result.current.currentBranch).toBeUndefined()
      expect(result.current.branchName).toBe('feature/y')
      expect(window.history.replaceState).not.toHaveBeenCalled()
    })
  })

  it('leaves the URL alone once the page shown is not the editor', async () => {
    mockClient.branches.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { branches: mockBranches, users: [] },
    })
    const location = window.location as unknown as { pathname: string }
    location.pathname = '/edit'
    const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
    await waitFor(() => expect(window.history.replaceState).toHaveBeenCalled())
    vi.mocked(window.history.replaceState).mockClear()
    location.pathname = '/docs/guide'

    act(() => result.current.setBranchName('feature'))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(window.history.replaceState).not.toHaveBeenCalled()
  })

  it('loads branches on mount', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: mockBranches, users: [] },
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
  describe('one confirm per action and branch', () => {
    type ConfirmOptions = {
      children?: { props: { children: string } }
      onConfirm?: () => void
      onCancel?: () => void
      onClose?: () => void
      returnFocus?: boolean
      onExitTransitionEnd?: () => void
    }

    // Holds each confirm open until the test acts on it, the way a user leaves one on screen.
    const holdConfirms = async (): Promise<ConfirmOptions[]> => {
      const { modals } = await import('@mantine/modals')
      const opened: ConfirmOptions[] = []
      vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
        opened.push(options as ConfirmOptions)
        return `modal-${opened.length}`
      })
      return opened
    }

    // What Mantine does on a click of the confirm button: onConfirm, then onClose.
    const confirm = (modal: ConfirmOptions) => {
      modal.onConfirm?.()
      modal.onClose?.()
    }

    const renderLoaded = async (branches: BranchMetadata[] = editingFeature) => {
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches, defaultBranch: 'main', users: [] },
      })
      const rendered = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => {
        expect(rendered.result.current.branches).toHaveLength(branches.length)
      })
      return rendered
    }

    afterEach(async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockReset()
    })

    it('a second submit while the first confirm is open opens nothing, and confirming submits once', async () => {
      const opened = await holdConfirms()
      mockClient.workflow.submit.mockResolvedValue({ ok: true, status: 200 })
      const { result } = await renderLoaded()

      let first!: Promise<void>
      act(() => {
        first = result.current.handleSubmit('feature')
      })
      await act(async () => {
        await expect(result.current.handleSubmit('feature')).resolves.toBeUndefined()
      })
      expect(opened).toHaveLength(1)

      await act(async () => {
        confirm(opened[0])
        await first
      })
      expect(mockClient.workflow.submit).toHaveBeenCalledTimes(1)
      expect(mockClient.workflow.submit.mock.calls[0]?.[0]).toEqual({ branch: 'feature' })
    })

    it('a repeat request while the confirmed work is still in flight opens nothing', async () => {
      const opened = await holdConfirms()
      let finishSubmit!: () => void
      mockClient.workflow.submit.mockReturnValue(
        new Promise((resolve) => {
          finishSubmit = () => resolve({ ok: true, status: 200 })
        }),
      )
      const { result } = await renderLoaded()

      let first!: Promise<void>
      act(() => {
        first = result.current.handleSubmit('feature')
      })
      act(() => confirm(opened[0]))
      await act(async () => {
        await expect(result.current.handleSubmit('feature')).resolves.toBeUndefined()
      })
      expect(opened).toHaveLength(1)

      await act(async () => {
        finishSubmit()
        await first
      })
      expect(mockClient.workflow.submit).toHaveBeenCalledTimes(1)
    })

    it.each(['submit', 'withdraw', 'delete'] as const)(
      'a %s confirm frees the action once it is dismissed, and never blocks another branch',
      async (action) => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded()
        const handlers = {
          submit: result.current.handleSubmit,
          withdraw: result.current.handleWithdraw,
          delete: result.current.handleDelete,
        }

        let first!: Promise<void>
        act(() => {
          first = handlers[action]('feature')
        })
        await act(async () => {
          await handlers[action]('feature')
        })
        expect(opened).toHaveLength(1)

        let other!: Promise<void>
        act(() => {
          other = handlers[action]('main')
        })
        expect(opened).toHaveLength(2)

        await act(async () => {
          opened[0].onClose?.()
          opened[1].onClose?.()
          await first
          await other
        })

        act(() => {
          void handlers[action]('feature')
        })
        expect(opened).toHaveLength(3)
        act(() => opened[2].onClose?.())
      },
    )

    it('a confirmed submit of a branch the listing already shows submitted calls nothing', async () => {
      const opened = await holdConfirms()
      const { result } = await renderLoaded(mockBranches)

      await act(async () => {
        const pending = result.current.handleSubmit('feature')
        confirm(opened[0])
        await expect(pending).resolves.toBeUndefined()
      })
      expect(mockClient.workflow.submit).not.toHaveBeenCalled()
    })

    it('treats the raw form of a listed name as that branch', async () => {
      const opened = await holdConfirms()
      mockClient.workflow.submit.mockResolvedValue({ ok: true, status: 200 })
      const featureX: BranchMetadata = {
        ...editingFeature[1],
        name: 'feature-x',
        pullRequestNumber: 7,
        pullRequestState: 'open',
      }
      const { result } = await renderLoaded([mockBranches[0], featureX])

      let first!: Promise<void>
      act(() => {
        first = result.current.handleSubmit('feature/x')
      })
      await act(async () => {
        await result.current.handleSubmit('feature-x')
      })
      expect(opened).toHaveLength(1)
      await act(async () => {
        confirm(opened[0])
        await first
      })
      expect(mockClient.workflow.submit.mock.calls[0]?.[0]).toEqual({ branch: 'feature-x' })

      act(() => {
        void result.current.handleWithdraw('feature/x')
      })
      expect(opened[1].children?.props.children).toContain('Convert pull request #7 to a draft')
      act(() => opened[1].onClose?.())
    })

    describe('focus after the dialog', () => {
      const control = () => {
        const button = document.createElement('button')
        document.body.append(button)
        return button
      }

      afterEach(() => {
        document.body.replaceChildren()
      })

      it.each([
        ['submit', editingFeature],
        ['withdraw', mockBranches],
      ] as const)('returns %s focus to the control it is given', async (action, branches) => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded([...branches])
        const target = control()
        act(() => {
          if (action === 'submit') void result.current.handleSubmit('feature', () => target)
          else void result.current.handleWithdraw('feature', () => target)
        })
        await waitFor(() => expect(opened).toHaveLength(1))
        expect(opened[0].returnFocus).toBe(false)
        act(() => opened[0].onClose?.())
        opened[0].onExitTransitionEnd?.()
        expect(document.activeElement).toBe(target)
      })

      it("keeps Mantine's own focus return without one", async () => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded()
        act(() => {
          void result.current.handleSubmit('feature')
        })
        await waitFor(() => expect(opened).toHaveLength(1))
        expect(opened[0].returnFocus).toBeUndefined()
        expect(opened[0].onExitTransitionEnd).toBeUndefined()
        act(() => opened[0].onClose?.())
      })
    })

    describe('withdraw copy', () => {
      const withPr = (pr: Partial<BranchMetadata>): BranchMetadata[] => [
        mockBranches[0],
        { ...mockBranches[1], ...pr },
      ]

      it.each([
        [
          'an open PR',
          withPr({ pullRequestNumber: 7, pullRequestState: 'open' }),
          'Convert pull request #7 to a draft',
        ],
        [
          'a PR whose state is not yet known',
          withPr({ pullRequestNumber: 7 }),
          'Convert pull request #7 to a draft',
        ],
        [
          'a closed PR',
          withPr({ pullRequestNumber: 7, pullRequestState: 'closed' }),
          'Leave the closed pull request #7 as it is; submitting again opens a new one',
        ],
        [
          'a merged PR',
          withPr({ pullRequestNumber: 7, pullRequestState: 'merged' }),
          'Leave the merged pull request #7 as it is',
        ],
      ])('for %s says "%s"', async (_label, branches, bullet) => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded(branches)
        act(() => {
          void result.current.handleWithdraw('feature')
        })
        const text = opened[0].children?.props.children ?? ''
        expect(text).toContain(`• ${bullet}\n`)
        expect(text.match(/pull request/g)).toHaveLength(1)
        act(() => opened[0].onClose?.())
      })

      it('for a branch without a PR mentions no pull request', async () => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded(mockBranches)
        act(() => {
          void result.current.handleWithdraw('feature')
        })
        const text = opened[0].children?.props.children ?? ''
        expect(text).not.toMatch(/pull request/i)
        expect(text).toContain('• Change the branch status back to “editing”')
        act(() => opened[0].onClose?.())
      })

      it('says nothing about a PR state when no PR number is recorded', () => {
        expect(withdrawPullRequestBullet({ pullRequestState: 'closed' })).toBeUndefined()
      })
    })

    describe('delete copy', () => {
      it('says the GitHub branch goes too when the branch has a PR', async () => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded([
          mockBranches[0],
          { ...mockBranches[1], status: 'editing', pullRequestNumber: 7 },
        ])
        act(() => {
          void result.current.handleDelete('feature')
        })
        expect(opened[0].children?.props.children).toContain(
          '• Delete its branch on GitHub too, which closes pull request #7 if it is still open',
        )
        act(() => opened[0].onClose?.())
      })

      it('says nothing about GitHub when the branch has no PR', async () => {
        const opened = await holdConfirms()
        const { result } = await renderLoaded()
        act(() => {
          void result.current.handleDelete('feature')
        })
        expect(opened[0].children?.props.children).not.toMatch(/GitHub/)
        act(() => opened[0].onClose?.())
      })
    })
  })

  describe('deleting the open branch', () => {
    const lastUrl = () => {
      const calls = vi.mocked(window.history.replaceState).mock.calls
      return String(calls[calls.length - 1]?.[2] ?? '')
    }

    const listings = (defaultBranch: string | undefined) => {
      mockClient.branches.list
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branches: editingFeature, defaultBranch, users: [] },
        })
        .mockResolvedValue({
          ok: true,
          status: 200,
          data: { branches: [mockBranches[0]], defaultBranch, users: [] },
        })
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })
    }

    it('switches to the default branch, and the URL follows', async () => {
      listings('main')
      const { result } = renderHook(
        () => useBranchManager({ ...defaultOptions, initialBranch: 'feature' }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.branches).toHaveLength(2))
      expect(lastUrl()).toContain('branch=feature')

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(result.current.branchName).toBe('main')
      expect(result.current.currentBranch?.name).toBe('main')
      await waitFor(() => expect(lastUrl()).toContain('branch=main'))
    })

    it('switches when the URL carries the raw form of the deleted branch name', async () => {
      const featureX: BranchMetadata = { ...editingFeature[1], name: 'feature-x' }
      mockClient.branches.list
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branches: [mockBranches[0], featureX], defaultBranch: 'main', users: [] },
        })
        .mockResolvedValue({
          ok: true,
          status: 200,
          data: { branches: [mockBranches[0]], defaultBranch: 'main', users: [] },
        })
      mockClient.branches.delete.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = renderHook(
        () => useBranchManager({ ...defaultOptions, initialBranch: 'feature/x' }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.currentBranch?.name).toBe('feature-x'))

      await act(async () => {
        await result.current.handleDelete('feature-x')
      })

      expect(result.current.branchName).toBe('main')
    })

    it('stays on the open branch when another branch is deleted', async () => {
      listings('main')
      const { result } = renderHook(
        () => useBranchManager({ ...defaultOptions, initialBranch: 'main' }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.branches).toHaveLength(2))

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(result.current.branchName).toBe('main')
    })

    it('shows the server cleanup warning instead of a plain success', async () => {
      const { notifications } = await import('@mantine/notifications')
      listings('main')
      mockClient.branches.delete.mockReset()
      mockClient.branches.delete.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { deleted: true, cleanupWarning: 'GitHub said no' },
      })
      const { result } = renderHook(() => useBranchManager(defaultOptions), { wrapper })
      await waitFor(() => expect(result.current.branches).toHaveLength(2))

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Branch deleted, with a warning: GitHub said no',
          color: 'yellow',
        }),
      )
      expect(notifications.show).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Branch deleted' }),
      )
    })

    it('stays on the branch when the delete fails', async () => {
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches: editingFeature, defaultBranch: 'main', users: [] },
      })
      mockClient.branches.delete.mockResolvedValueOnce({ ok: false, status: 409, error: 'busy' })
      const { result } = renderHook(
        () => useBranchManager({ ...defaultOptions, initialBranch: 'feature' }),
        { wrapper },
      )
      await waitFor(() => expect(result.current.branches).toHaveLength(2))

      await act(async () => {
        await result.current.handleDelete('feature')
      })

      expect(result.current.branchName).toBe('feature')
    })
  })

  describe('review actions', () => {
    const listing = (branches: BranchMetadata[] = mockBranches) =>
      mockClient.branches.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { branches, users: [] },
      })
    const loaded = async (
      branches: BranchMetadata[] = mockBranches,
      overrides: Partial<UseBranchManagerOptions> = {},
    ) => {
      listing(branches)
      const hook = renderHook(() => useBranchManager({ ...defaultOptions, ...overrides }), {
        wrapper,
      })
      await waitFor(() => {
        expect(hook.result.current.branches).toHaveLength(2)
      })
      return hook
    }
    const withPullRequest: BranchMetadata[] = [
      mockBranches[0],
      { ...mockBranches[1], pullRequestNumber: 12, pullRequestState: 'open' },
    ]
    /** The text of the dialog `modals.openConfirmModal` was last called with. */
    const dialogBody = async () => {
      const { modals } = await import('@mantine/modals')
      const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
      if (!options) throw new Error('no confirm dialog was opened')
      const shown = render(<MantineProvider>{options.children}</MantineProvider>)
      const body = shown.container.textContent ?? ''
      shown.unmount()
      return { options, body }
    }
    /**
     * Makes the next confirm dialog render its body, run `typing` on it, then confirm, as a user
     * does; the default mock confirms without ever showing the body.
     */
    const confirmAfter = async (
      typing: (shown: ReturnType<typeof render>) => Promise<void>,
      exit: 'confirm' | 'cancel' = 'confirm',
    ) => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        const shown = render(<MantineProvider>{options.children}</MantineProvider>)
        // A task later, once the dialog has rendered, and without a `waitFor` in flight: one would
        // leave React's act environment off while the handler's own `act` begins.
        setTimeout(() => {
          void typing(shown).then(() => {
            if (exit === 'confirm') options.onConfirm?.()
            else options.onCancel?.()
            shown.unmount()
          })
        }, 0)
        return 'mock-modal-id'
      })
    }
    const typeNote = (note: string) => async (shown: ReturnType<typeof render>) => {
      const field = shown.getByTestId('request-changes-note')
      await act(async () => {
        fireEvent.change(field, { target: { value: note } })
      })
    }
    /**
     * Runs a handler that renders its dialog. Not inside `act` from the start: the dialog's body
     * renders while the handler waits, and an enclosing `act` would hold that render back.
     */
    const call = async (run: () => Promise<void>) => {
      const pending = run()
      await act(async () => {
        await pending
      })
    }
    /** The notification `notifications.show` was last called with, its message rendered. */
    const lastToast = async () => {
      const { notifications } = await import('@mantine/notifications')
      const call = vi.mocked(notifications.show).mock.calls.at(-1)?.[0]
      if (!call) throw new Error('no notification was shown')
      const shown = render(<MantineProvider>{call.message}</MantineProvider>)
      return { call, shown }
    }
    /** The note field's value in the dialog the next `openConfirmModal` call opens, unconfirmed. */
    const nextDialogNote = async () => {
      const { modals } = await import('@mantine/modals')
      let value: string | undefined
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        const shown = render(<MantineProvider>{options.children}</MantineProvider>)
        // After the render settles, wherever the caller's `act` ends.
        setTimeout(() => {
          value = (shown.getByTestId('request-changes-note') as HTMLTextAreaElement).value
          shown.unmount()
          options.onCancel?.()
        }, 0)
        return 'mock-modal-id'
      })
      return () => value
    }

    it('approves through the API, toasts in green and reloads the list', async () => {
      const { notifications } = await import('@mantine/notifications')
      mockClient.workflow.approve.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded()
      mockClient.branches.list.mockClear()

      await act(async () => {
        await result.current.handleApprove('feature')
      })

      expect(mockClient.workflow.approve).toHaveBeenCalledWith({ branch: 'feature' })
      expect(notifications.show).toHaveBeenCalledWith({
        message: 'Branch approved',
        color: 'green',
      })
      expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
    })

    it('asks before approving, naming what stays open on GitHub', async () => {
      mockClient.workflow.approve.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(withPullRequest)

      await act(async () => {
        await result.current.handleApprove('feature')
      })

      const { options, body } = await dialogBody()
      expect(options.title).toBe('Approve')
      expect(options.labels).toEqual({ confirm: 'Approve', cancel: 'Cancel' })
      expect(options.confirmProps).toEqual(
        expect.objectContaining({ color: 'brand', 'data-testid': 'confirm-approve-branch' }),
      )
      expect(body).toContain(
        'Approve “feature”? Its pull request stays open on GitHub for someone with access to merge it.',
      )
    })

    it('leaves GitHub out of the approve dialog for a branch with no pull request', async () => {
      mockClient.workflow.approve.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded()

      await act(async () => {
        await result.current.handleApprove('feature')
      })

      const { body } = await dialogBody()
      expect(body).toContain(
        'Approve “feature”? It stays locked until it is withdrawn or changes are requested.',
      )
      expect(body).not.toContain('GitHub')
    })

    it('sends nothing when the approve dialog is cancelled', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onCancel?.()
        return 'mock-modal-id'
      })
      const { result } = await loaded()

      await act(async () => {
        await expect(result.current.handleApprove('feature')).resolves.toBeUndefined()
      })

      expect(mockClient.workflow.approve).not.toHaveBeenCalled()
    })

    it('opens one approve dialog for a double-click', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce(() => 'mock-modal-id')
      const { result } = await loaded()

      act(() => {
        void result.current.handleApprove('feature')
        void result.current.handleApprove('feature')
      })

      expect(
        vi.mocked(modals.openConfirmModal).mock.calls.filter(([o]) => o.title === 'Approve'),
      ).toHaveLength(1)
    })

    it("shows the server's refusal in red with Retry, and rejects", async () => {
      const { notifications } = await import('@mantine/notifications')
      const { modals } = await import('@mantine/modals')
      mockClient.workflow.approve
        .mockResolvedValueOnce({ ok: false, status: 500, error: 'The disk is full.' })
        .mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded()

      await act(async () => {
        await expect(result.current.handleApprove('feature')).rejects.toThrow('The disk is full.')
      })

      const { call, shown } = await lastToast()
      expect(call.color).toBe('red')
      expect(call.autoClose).toBe(false)
      expect(shown.getByText('The disk is full.')).toBeTruthy()
      expect(vi.mocked(modals.openConfirmModal)).toHaveBeenCalledTimes(1)

      // Retry reopens the Approve dialog (auto-confirmed here), which sends again.
      await act(async () => {
        fireEvent.click(shown.getByRole('button', { name: 'Retry' }))
      })
      await waitFor(() => expect(mockClient.workflow.approve).toHaveBeenCalledTimes(2))
      expect(vi.mocked(modals.openConfirmModal)).toHaveBeenCalledTimes(2)
      expect(notifications.hide).toHaveBeenCalledWith('canopy-approve-failed-feature')
    })

    it('shows a stale-status 409 in yellow, which closes itself, with no Retry, and reloads the list', async () => {
      const { notifications } = await import('@mantine/notifications')
      mockClient.workflow.approve.mockResolvedValueOnce({
        ok: false,
        status: 409,
        error: 'This branch is already approved.',
      })
      const { result } = await loaded()
      mockClient.branches.list.mockClear()

      await act(async () => {
        await result.current.handleApprove('feature').catch(() => {})
      })

      expect(notifications.show).toHaveBeenCalledWith({
        id: 'canopy-review-stale-feature',
        message: 'This branch is already approved.',
        color: 'yellow',
        withCloseButton: true,
      })
      expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
    })

    describe('refusals', () => {
      it('shows a 4xx plainly, with no Retry, and reloads the list so stale buttons update', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 403,
          error: "You can't approve a branch you created. Ask another reviewer to approve it.",
        })
        const { result } = await loaded()
        mockClient.branches.list.mockClear()

        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })

        expect(notifications.show).toHaveBeenCalledWith({
          id: 'canopy-approve-failed-feature',
          message: "You can't approve a branch you created. Ask another reviewer to approve it.",
          color: 'red',
        })
        expect(mockClient.branches.list).toHaveBeenCalledTimes(1)
      })

      it('offers Retry for a 5xx and for an error with no answer at all', async () => {
        mockClient.workflow.approve
          .mockResolvedValueOnce({ ok: false, status: 500, error: 'The disk is full.' })
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        const { result } = await loaded()

        for (const text of ['The disk is full.', 'Failed to fetch']) {
          await act(async () => {
            await result.current.handleApprove('feature').catch(() => {})
          })
          const { call, shown } = await lastToast()
          expect(call.color).toBe('red')
          expect(shown.getByText(text)).toBeTruthy()
          expect(shown.getByRole('button', { name: 'Retry' })).toBeTruthy()
          shown.unmount()
        }
      })

      it('puts a stale-status message, not the dialog, where Retry finds the branch out of review', async () => {
        const { notifications } = await import('@mantine/notifications')
        const { modals } = await import('@mantine/modals')
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 500,
          error: 'The disk is full.',
        })
        const { result } = await loaded()
        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })
        const { shown } = await lastToast()

        // The editor has the branch back. Nothing has reloaded the list, so only Retry's own
        // reload can show it.
        listing(editingFeature)
        expect(result.current.branches[1].status).toBe('submitted')
        vi.mocked(modals.openConfirmModal).mockClear()

        fireEvent.click(shown.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(notifications.show).toHaveBeenCalledTimes(2))

        expect(modals.openConfirmModal).not.toHaveBeenCalled()
        expect(notifications.show).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: 'canopy-review-stale-feature',
            message: "This branch is no longer in review: it's back with its editor.",
            color: 'yellow',
          }),
        )
      })

      it.each([408, 429])('offers Retry for a %i, which asks for a later try', async (status) => {
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status,
          error: 'Try again shortly.',
        })
        const { result } = await loaded()
        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })
        const { shown } = await lastToast()
        expect(shown.getByRole('button', { name: 'Retry' })).toBeTruthy()
      })

      it('shows a refused Request changes with its note to copy, and keeps it up', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 403,
          error: 'Reviewer access required.',
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))

        const { call: toast, shown } = await lastToast()
        expect(toast).toEqual(
          expect.objectContaining({
            id: 'canopy-request-changes-failed-feature',
            color: 'red',
            autoClose: false,
          }),
        )
        expect(shown.container.textContent).toContain('Reviewer access required.')
        expect(shown.getByTestId('note-not-saved-text').textContent).toBe('Fix the intro.')
        expect(shown.getByRole('button', { name: 'Copy note' })).toBeTruthy()
        expect(shown.queryByRole('button', { name: 'Retry' })).toBeNull()
        expect(notifications.show).toHaveBeenCalledTimes(1)
      })

      it('lets a note-less stale toast leave a sticky one that carries a note alone', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: "This branch is no longer in review: it's back with its editor.",
        })
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: "This branch is no longer in review: it's back with its editor.",
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
        const stale = () =>
          vi
            .mocked(notifications.show)
            .mock.calls.filter(([n]) => n.id === 'canopy-review-stale-feature')
        expect(stale()).toHaveLength(1)

        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })

        // The second 409 had no note to show, so it did not replace the one that has.
        expect(stale()).toHaveLength(1)
        expect(
          vi
            .mocked(notifications.hide)
            .mock.calls.filter(([id]) => id === 'canopy-review-stale-feature'),
        ).toHaveLength(1)
      })

      it('shows a stale toast again once the one with the note is dismissed', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: "This branch is no longer in review: it's back with its editor.",
        })
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: "This branch is no longer in review: it's back with its editor.",
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
        const noted = vi.mocked(notifications.show).mock.calls.at(-1)?.[0]
        act(() => noted?.onClose?.(undefined as never))

        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })

        expect(
          vi
            .mocked(notifications.show)
            .mock.calls.filter(([n]) => n.id === 'canopy-review-stale-feature'),
        ).toHaveLength(2)
      })

      it('takes a failure toast down when the same action later succeeds', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.approve
          .mockResolvedValueOnce({ ok: false, status: 500, error: 'The disk is full.' })
          .mockResolvedValueOnce({ ok: true, status: 200 })
        const { result } = await loaded()
        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleApprove('feature')
        })

        expect(notifications.hide).toHaveBeenCalledWith('canopy-approve-failed-feature')
      })
    })

    describe('a namespace branch', () => {
      const spring: BranchListItem = {
        ...mockBranches[1],
        name: 'canopycms/local/spring',
        shortName: 'spring',
        status: 'editing',
        writeBlocked: false,
        submitBlocked: false,
        isProtected: false,
      }
      const loadedSpring = () => loaded([mockBranches[0], spring])

      it.each([
        ['submit', 'Submit “spring” for review?'],
        ['withdraw', 'Withdraw “spring” from review?'],
        ['approve', 'Approve “spring”?'],
        ['request changes', 'Send “spring” back to its editor?'],
        ['delete', 'Delete “spring”?'],
      ] as const)('is called by its short name in the %s dialog', async (action, sentence) => {
        const { result } = await loadedSpring()
        const handlers = {
          submit: result.current.handleSubmit,
          withdraw: result.current.handleWithdraw,
          approve: result.current.handleApprove,
          'request changes': result.current.handleRequestChanges,
          delete: result.current.handleDelete,
        }

        await act(async () => {
          await handlers[action]('canopycms/local/spring').catch(() => {})
        })

        const { body } = await dialogBody()
        expect(body).toContain(sentence)
        expect(body).not.toContain('canopycms/local')
      })

      it('is called by its short name when an approve or request changes got no answer', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.approve.mockRejectedValueOnce(new ApiTimeoutError('POST', '/x', 1000))
        mockClient.workflow.requestChanges.mockRejectedValueOnce(
          new ApiTimeoutError('POST', '/x', 1000),
        )
        const { result } = await loadedSpring()

        await act(async () => {
          await result.current.handleApprove('spring').catch(() => {})
          await result.current.handleRequestChanges('spring').catch(() => {})
        })

        const messages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
        expect(messages).toContain(branchActionOutcomeUnknown('Approve “spring”'))
        expect(messages).toContainEqual(
          expect.stringContaining('Request changes on “spring” may have gone through'),
        )
      })
    })

    it('says an approve that got no answer may have gone through, and reloads', async () => {
      const { notifications } = await import('@mantine/notifications')
      mockClient.workflow.approve.mockRejectedValueOnce(new ApiTimeoutError('POST', '/x', 1000))
      const { result } = await loaded()
      mockClient.branches.list.mockClear()

      await act(async () => {
        await result.current.handleApprove('feature').catch(() => {})
      })

      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: branchActionOutcomeUnknown('Approve “feature”'),
          color: 'yellow',
          autoClose: false,
        }),
      )
      expect(mockClient.branches.list).toHaveBeenCalled()
    })

    it('asks for an optional note when requesting changes', async () => {
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(withPullRequest)

      await act(async () => {
        await result.current.handleRequestChanges('feature')
      })

      const { options, body } = await dialogBody()
      expect(options.title).toBe('Request changes')
      expect(options.confirmProps).toEqual(
        expect.objectContaining({ color: 'red', 'data-testid': 'confirm-request-changes' }),
      )
      expect(body).toContain(
        'Send “feature” back to its editor? It goes back to editing, and its pull request becomes a draft.',
      )
      expect(body).toContain('Note to the editor')
      expect(body).toContain('Saved as a comment on the branch.')
    })

    it('drops the draft clause for a branch with no pull request', async () => {
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded()

      await act(async () => {
        await result.current.handleRequestChanges('feature')
      })

      expect((await dialogBody()).body).toContain(
        'Send “feature” back to its editor? It goes back to editing.',
      )
    })

    it('limits the note field to 2,000 characters and focuses it', async () => {
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded()

      await act(async () => {
        await result.current.handleRequestChanges('feature')
      })

      const { modals } = await import('@mantine/modals')
      const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
      const shown = render(<MantineProvider>{options?.children}</MantineProvider>)
      const field = shown.getByTestId('request-changes-note')
      expect(field.getAttribute('maxlength')).toBe('2000')
      expect(field.hasAttribute('data-autofocus')).toBe(true)
      shown.unmount()
    })

    it('sends the typed note, trimmed away of nothing but its edges', async () => {
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      await confirmAfter(async (shown) => {
        const field = shown.getByTestId('request-changes-note')
        await act(async () => {
          fireEvent.change(field, { target: { value: '  Fix the intro.  ' } })
        })
      })
      const { result } = await loaded()

      // Not inside `act`: the dialog's body renders and takes input while the handler waits.
      const pending = result.current.handleRequestChanges('feature')
      await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
      await act(async () => {
        await pending
      })
      expect(mockClient.workflow.requestChanges).toHaveBeenCalledWith(
        { branch: 'feature' },
        { note: 'Fix the intro.' },
      )
    })

    it('sends no note when the field was left blank', async () => {
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      await confirmAfter(async (shown) => {
        const field = shown.getByTestId('request-changes-note')
        await act(async () => {
          fireEvent.change(field, { target: { value: '   ' } })
        })
      })
      const { result } = await loaded()

      const pending = result.current.handleRequestChanges('feature')
      await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
      await act(async () => {
        await pending
      })
      expect(mockClient.workflow.requestChanges.mock.calls[0][1]).toEqual({})
    })

    it('toasts, then tells the editor to refresh comments, on success', async () => {
      const { notifications } = await import('@mantine/notifications')
      const onChangesRequested = vi.fn()
      mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
      const { result } = await loaded(mockBranches, { onChangesRequested })

      await act(async () => {
        await result.current.handleRequestChanges('feature')
      })

      expect(notifications.show).toHaveBeenCalledWith({
        message: 'Changes requested',
        color: 'blue',
      })
      expect(notifications.show).toHaveBeenCalledTimes(1)
      expect(onChangesRequested).toHaveBeenCalledWith('feature')
    })

    it('keeps a yellow notification up, with the note to copy, when it could not be saved', async () => {
      const warning = "Changes were requested, but your note couldn't be saved."
      mockClient.workflow.requestChanges.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { branch: mockBranches[1] as BranchListItem, warning },
      })
      await confirmAfter(typeNote('  Please fix the intro.  '))
      const { result } = await loaded()

      const pending = result.current.handleRequestChanges('feature')
      await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
      await act(async () => {
        await pending
      })

      const { call, shown } = await lastToast()
      expect(call).toEqual(
        expect.objectContaining({ color: 'yellow', autoClose: false, withCloseButton: true }),
      )
      expect(shown.container.textContent).toContain(
        `${warning} Copy it into a comment on the branch.`,
      )
      expect(shown.getByTestId('note-not-saved-text').textContent).toBe('Please fix the intro.')
      expect(shown.getByRole('button', { name: 'Copy note' })).toBeTruthy()
    })

    describe('a typed note', () => {
      it('is prefilled when the dialog is cancelled and opened again', async () => {
        await confirmAfter(typeNote('Fix the intro.'), 'cancel')
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))

        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))

        expect(reopened()).toBe('Fix the intro.')
        expect(mockClient.workflow.requestChanges).not.toHaveBeenCalled()
      })

      it('survives a refusal, which offers Retry reopening the dialog with it', async () => {
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 500,
          error: 'The disk is full.',
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()

        const pending = result.current.handleRequestChanges('feature')
        await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
        await act(async () => {
          await pending
        })

        const { call, shown } = await lastToast()
        expect(call.color).toBe('red')
        const reopened = await nextDialogNote()
        fireEvent.click(shown.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(reopened()).toBe('Fix the intro.'))
      })

      it('survives a request nobody answered, which checks the branch and its comments', async () => {
        const { notifications } = await import('@mantine/notifications')
        const onChangesRequested = vi.fn()
        mockClient.workflow.requestChanges.mockRejectedValueOnce(
          new ApiTimeoutError('POST', '/x', 1000),
        )
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded(mockBranches, { onChangesRequested })
        mockClient.branches.list.mockClear()

        const pending = result.current.handleRequestChanges('feature')
        await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
        await act(async () => {
          await pending
        })

        expect(notifications.show).toHaveBeenCalledWith(
          expect.objectContaining({
            message:
              'Request changes on “feature” may have gone through even though the server didn\'t answer. Check the branch\'s status and its comments in "Comments".',
            color: 'yellow',
            autoClose: false,
          }),
        )
        expect(mockClient.branches.list).toHaveBeenCalled()
        expect(onChangesRequested).toHaveBeenCalledWith('feature')
        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('Fix the intro.')
      })

      it('is shown back to copy by a 409, whose reload then drops the draft', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: "This branch is no longer in review: it's back with its editor.",
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        // The reload after the 409 finds the branch back with its editor.
        listing(editingFeature)
        await call(() => result.current.handleRequestChanges('feature'))

        const { call: toast, shown } = await lastToast()
        expect(toast).toEqual(
          expect.objectContaining({
            id: 'canopy-review-stale-feature',
            color: 'yellow',
            autoClose: false,
            withCloseButton: true,
          }),
        )
        expect(shown.getByTestId('note-not-saved-text').textContent).toBe('Fix the intro.')
        expect(shown.getByRole('button', { name: 'Copy note' })).toBeTruthy()
        expect(notifications.hide).toHaveBeenCalledWith('canopy-review-stale-feature')

        // The branch is submitted again, a new review cycle: the old note must be gone already.
        listing(mockBranches)
        await act(async () => {
          await result.current.loadBranches()
        })
        await waitFor(() => expect(result.current.branches[1].status).toBe('submitted'))
        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('')
      })

      it('survives an Approve 409 that finds the branch approved, which Request changes still takes', async () => {
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: 'This branch is already approved.',
        })
        await confirmAfter(typeNote('Fix the intro.'), 'cancel')
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))

        listing([mockBranches[0], { ...mockBranches[1], status: 'approved' }])
        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })
        await waitFor(() => expect(result.current.branches[1].status).toBe('approved'))

        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('Fix the intro.')
      })

      it('survives an Approve retry that finds the branch approved, and goes when a Request changes retry finds it back with its editor', async () => {
        mockClient.workflow.approve.mockResolvedValueOnce({
          ok: false,
          status: 500,
          error: 'Boom.',
        })
        mockClient.workflow.requestChanges.mockResolvedValueOnce({
          ok: false,
          status: 500,
          error: 'Boom.',
        })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
        const requestToast = await lastToast()
        await act(async () => {
          await result.current.handleApprove('feature').catch(() => {})
        })
        const approveToast = await lastToast()

        // Approved: Approve has nothing to do, Request changes still does.
        listing([mockBranches[0], { ...mockBranches[1], status: 'approved' }])
        fireEvent.click(within(approveToast.shown.container).getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(result.current.branches[1].status).toBe('approved'))
        const kept = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(kept()).toBe('Fix the intro.')

        // Back with its editor: the request's retry finds no review cycle left to keep a note for.
        listing(editingFeature)
        fireEvent.click(within(requestToast.shown.container).getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(result.current.branches[1].status).toBe('editing'))
        listing(mockBranches)
        await act(async () => {
          await result.current.loadBranches()
        })
        await waitFor(() => expect(result.current.branches[1].status).toBe('submitted'))
        const dropped = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(dropped()).toBe('')
      })

      it('is dropped after an unanswered request when the reloaded branch has left review', async () => {
        mockClient.workflow.requestChanges.mockRejectedValueOnce(
          new ApiTimeoutError('POST', '/x', 1000),
        )
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        // The branch listing the reload brings back shows the request did land.
        mockClient.branches.list.mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { branches: editingFeature, users: [] },
        })
        await call(() => result.current.handleRequestChanges('feature'))

        // The branch is submitted again, a new review cycle: the old note must be gone already.
        listing(mockBranches)
        await act(async () => {
          await result.current.loadBranches()
        })
        await waitFor(() => expect(result.current.branches[1].status).toBe('submitted'))
        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('')
      })

      it('is not prefilled once its branch is out of review', async () => {
        await confirmAfter(typeNote('Fix the intro.'), 'cancel')
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))

        listing(editingFeature)
        await act(async () => {
          await result.current.loadBranches()
        })
        await waitFor(() => expect(result.current.branches[1].status).toBe('editing'))
        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('')
      })

      it('takes the failure toast down when a retried request goes through', async () => {
        const { notifications } = await import('@mantine/notifications')
        mockClient.workflow.requestChanges
          .mockResolvedValueOnce({ ok: false, status: 500, error: 'The disk is full.' })
          .mockResolvedValueOnce({ ok: true, status: 200 })
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
        vi.mocked(notifications.hide).mockClear()

        await call(() => result.current.handleRequestChanges('feature'))

        expect(notifications.hide).toHaveBeenCalledWith('canopy-request-changes-failed-feature')
      })

      it('is cleared once the request goes through', async () => {
        mockClient.workflow.requestChanges.mockResolvedValueOnce({ ok: true, status: 200 })
        await confirmAfter(typeNote('Fix the intro.'))
        const { result } = await loaded()
        const pending = result.current.handleRequestChanges('feature')
        await waitFor(() => expect(mockClient.workflow.requestChanges).toHaveBeenCalled())
        await act(async () => {
          await pending
        })

        const reopened = await nextDialogNote()
        await call(() => result.current.handleRequestChanges('feature'))
        expect(reopened()).toBe('')
      })

      it('shows a count past 1,800 characters', async () => {
        await confirmAfter(async (shown) => {
          await typeNote('x'.repeat(1850))(shown)
          expect(shown.getByTestId('request-changes-note-count').textContent).toBe('1,850 / 2,000')
          expect(shown.getByTestId('request-changes-note-count').hasAttribute('aria-live')).toBe(
            false,
          )
          await typeNote('x'.repeat(1950))(shown)
          expect(shown.getByTestId('request-changes-note-count').getAttribute('aria-live')).toBe(
            'polite',
          )
        }, 'cancel')
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
      })

      it('shows no count for a short note', async () => {
        await confirmAfter(async (shown) => {
          await typeNote('x'.repeat(1800))(shown)
          expect(shown.queryByTestId('request-changes-note-count')).toBeNull()
        }, 'cancel')
        const { result } = await loaded()
        await call(() => result.current.handleRequestChanges('feature'))
      })
    })

    it('sends nothing, and refreshes nothing, when the request-changes dialog is cancelled', async () => {
      const onChangesRequested = vi.fn()
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onCancel?.()
        return 'mock-modal-id'
      })
      const { result } = await loaded(mockBranches, { onChangesRequested })

      await act(async () => {
        await result.current.handleRequestChanges('feature')
      })

      expect(mockClient.workflow.requestChanges).not.toHaveBeenCalled()
      expect(onChangesRequested).not.toHaveBeenCalled()
    })

    it('returns focus to where the caller says, once either dialog closes', async () => {
      mockClient.workflow.approve.mockResolvedValue({ ok: true, status: 200 })
      mockClient.workflow.requestChanges.mockResolvedValue({ ok: true, status: 200 })
      const { result } = await loaded()
      const target = document.createElement('button')
      document.body.append(target)
      const { modals } = await import('@mantine/modals')

      for (const handle of [result.current.handleApprove, result.current.handleRequestChanges]) {
        await act(async () => {
          await handle('feature', () => target)
        })
        const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0] as {
          returnFocus?: boolean
          onExitTransitionEnd?: () => void
        }
        expect(options.returnFocus).toBe(false)
        options.onExitTransitionEnd?.()
        expect(document.activeElement).toBe(target)
        target.blur()
      }
      target.remove()
    })
  })
})
