import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEntryManager, listAllEntries } from './useEntryManager'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { notifications } from '@mantine/notifications'
import {
  setupMockApiClient,
  setupMockLocation,
  setupMockHistory,
  setupMockConsole,
  createApiClientWrapper,
  createStrictModeApiClientWrapper,
} from './__test__/test-utils'
import {
  unsafeAsLogicalPath,
  unsafeAsPhysicalPath,
  unsafeAsContentId,
  unsafeAsSlug,
} from '../../paths/test-utils'

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

describe('useEntryManager', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  const mockEntry: EditorEntry = {
    path: unsafeAsLogicalPath('entry1'),
    label: 'Test Entry',
    collectionPath: unsafeAsLogicalPath('posts'),
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
    format: 'mdx',
    schema: [],
    contentId: unsafeAsContentId('test123456789'),
  }

  const mockCollectionItem = {
    logicalPath: unsafeAsLogicalPath('entry1'),
    contentId: unsafeAsContentId('abc123XYZ789'),
    slug: unsafeAsSlug('test'),
    collectionPath: unsafeAsLogicalPath('posts'),
    collectionName: 'posts',
    format: 'mdx' as const,
    entryType: 'post',
    physicalPath: unsafeAsPhysicalPath('/content/posts/test'),
  }

  const mockCollections: EditorCollection[] = [
    {
      path: unsafeAsLogicalPath('content/posts'),
      name: 'posts',
      label: 'Posts',
      type: 'collection',
      format: 'mdx',
    },
  ]

  const defaultOptions = {
    initialEntries: [mockEntry],
    branchName: 'main',
    collections: mockCollections,
    resolvePreviewSrc: () => undefined,
    setBusy: vi.fn(),
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

  it('initializes with provided entries and selects first entry', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    expect(result.current.entries).toEqual([mockEntry])
    expect(result.current.selectedPath).toBe('entry1')
    expect(result.current.currentEntry).toEqual(mockEntry)
  })

  it('uses initialSelectedId when provided', () => {
    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, initialSelectedId: 'entry1' }),
      { wrapper },
    )

    expect(result.current.selectedPath).toBe('entry1')
  })

  it('builds collectionByPath map correctly', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    expect(result.current.collectionByPath.get(unsafeAsLogicalPath('content/posts'))).toEqual(
      mockCollections[0],
    )
  })

  it('loads entry successfully', async () => {
    const mockData = { slug: 'test', title: 'Test Entry', body: 'Content' }
    mockClient.content.read.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: mockData as any, // Mock uses simplified format that normalizeContentPayload handles
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    const loaded = await result.current.loadEntry(mockEntry)

    expect(loaded).toEqual({
      slug: 'test',
      title: 'Test Entry',
      body: 'Content',
    })
    expect(mockClient.content.read).toHaveBeenCalledWith({
      branch: 'main',
      path: 'posts/test',
    })
  })

  it('handles load entry error', async () => {
    mockClient.content.read.mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await expect(result.current.loadEntry(mockEntry)).rejects.toThrow('Load failed: 404')
  })

  it('saves entry successfully', async () => {
    const mockValue = { title: 'Updated Title', body: 'Updated Content' }
    const mockResponse = { title: 'Updated Title', body: 'Updated Content' }
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: mockResponse as any, // Mock uses simplified format that normalizeContentPayload handles
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    const saved = await result.current.saveEntry(mockEntry, mockValue)

    expect(saved).toEqual({ title: 'Updated Title', body: 'Updated Content' })
    expect(mockClient.content.write).toHaveBeenCalledWith(
      { branch: 'main', path: 'posts/test' },
      {
        format: 'mdx',
        data: { title: 'Updated Title' }, // body is extracted
        body: 'Updated Content',
      },
    )
  })

  it('saves entry with entryType when entry has entryType set', async () => {
    const entryWithType = {
      ...mockEntry,
      entryType: 'settings',
    }
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { siteName: 'Test' } as any,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await result.current.saveEntry(entryWithType, { siteName: 'Test' })

    expect(mockClient.content.write).toHaveBeenCalledWith(
      { branch: 'main', path: 'posts/test', entryType: 'settings' },
      expect.any(Object),
    )
  })

  it('surfaces validateEntry warnings in a single "; "-joined notification', async () => {
    const { notifications } = await import('@mantine/notifications')
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        title: 'Saved',
        validationWarnings: [
          { level: 'warning', message: 'Heading levels skip from h1 to h3', fieldPath: 'body' },
          { level: 'warning', message: 'Missing alt text on an image' },
        ],
      } as any,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })
    await result.current.saveEntry(mockEntry, { title: 'Saved' })

    // Notifications collapse newlines, so issues must be '; '-joined (not '\n') to stay
    // legible — matches the save-rejection path. Locks the separator against regression.
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Saved with warnings',
        message: 'body: Heading levels skip from h1 to h3; Missing alt text on an image',
        color: 'yellow',
      }),
    )
  })

  it('reuses a stable notification id across repeat saves so a permanent warning replaces in place instead of stacking', async () => {
    const { notifications } = await import('@mantine/notifications')
    mockClient.content.write.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        title: 'Saved',
        validationWarnings: [{ level: 'warning', message: 'Unknown key: legacyField' }],
      } as any,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    // Same permanent condition (e.g. an unknown schema key) fires on every
    // save. Without a stable `id`, Mantine appends a new toast each time --
    // five saves would leave five identical sticky notifications on screen.
    await result.current.saveEntry(mockEntry, { title: 'Saved' })
    await result.current.saveEntry(mockEntry, { title: 'Saved' })
    await result.current.saveEntry(mockEntry, { title: 'Saved' })

    expect(notifications.show).toHaveBeenCalledTimes(3)
    const ids = (notifications.show as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].id,
    )
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2])
  })

  it('handles save entry error', async () => {
    mockClient.content.write.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await expect(result.current.saveEntry(mockEntry, {})).rejects.toThrow('Save failed: 500')
  })

  it('refreshes entries successfully', async () => {
    const mockRefreshed = [
      mockCollectionItem,
      {
        ...mockCollectionItem,
        id: 'entry2',
        slug: unsafeAsSlug('test2'),
        logicalPath: unsafeAsLogicalPath('/content/posts/test2'),
      },
    ]
    // First call is from useEffect on mount, second is from manual call
    mockClient.entries.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { entries: [], pagination: { hasMore: false, limit: 100 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          entries: mockRefreshed,
          pagination: { hasMore: false, limit: 100 },
        },
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2)
    })

    expect(mockClient.entries.list).toHaveBeenCalledWith({ branch: 'main', limit: '200' })
  })

  it('refreshEntries returns the refreshed entries list', async () => {
    // Auto-selection of newly created entries is now handled by handleCreateModalSubmit
    // (which calls refreshEntries and then explicitly selects by collection+slug).
    // refreshEntries itself no longer has auto-selection side effects.
    const newEntry = {
      ...mockCollectionItem,
      logicalPath: unsafeAsLogicalPath('new-entry'),
      slug: unsafeAsSlug('new'),
      physicalPath: unsafeAsPhysicalPath('/content/posts/new'),
    }
    // First call is from useEffect on mount, second is from manual call
    mockClient.entries.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          entries: [mockCollectionItem],
          pagination: { hasMore: false, limit: 100 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          entries: [mockCollectionItem, newEntry],
          pagination: { hasMore: false, limit: 100 },
        },
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    let refreshed: import('../Editor').EditorEntry[] = []
    await act(async () => {
      refreshed = await result.current.refreshEntries()
    })

    // refreshEntries returns the new entries list
    expect(refreshed).toHaveLength(2)
    // selectedPath stays on the existing entry (auto-select is handleCreateModalSubmit's job)
    expect(result.current.selectedPath).toBe('entry1')
  })

  describe('dedup (React Strict Mode)', () => {
    it('mounting under Strict Mode issues one schema request and one entries request, not two', async () => {
      // Headline claim for the SWR migration: React Strict Mode double-invokes
      // effects (mount -> cleanup -> remount) in dev, which used to fire this
      // hook's fetch-on-load effect twice per endpoint. SWR's request dedup
      // (see useEntriesData.ts / SWRProvider) must collapse that to one.
      mockClient.entries.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { entries: [], pagination: { hasMore: false, limit: 200 } },
      })

      const strictWrapper = createStrictModeApiClientWrapper(mockClient)
      const { result } = renderHook(() => useEntryManager(defaultOptions), {
        wrapper: strictWrapper,
      })

      await waitFor(() => expect(result.current.entriesInitializing).toBe(false))

      expect(mockClient.schema.get).toHaveBeenCalledTimes(1)
      expect(mockClient.entries.list).toHaveBeenCalledTimes(1)
    })
  })

  describe('entriesInitializing', () => {
    it('is seeded true on mount with a branch, then clears once the initial load settles', async () => {
      mockClient.entries.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { entries: [], pagination: { hasMore: false, limit: 100 } },
      })

      const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

      // Seeded from the branch prop, before the post-mount load effect resolves — this is
      // what lets the empty pane / navigator show "Loading…" instead of flashing first.
      expect(result.current.entriesInitializing).toBe(true)

      await waitFor(() => expect(result.current.entriesInitializing).toBe(false))
    })

    it('clears after the load settles even when the branch has no entries (no stuck loader)', async () => {
      mockClient.entries.list.mockResolvedValue({
        ok: true,
        status: 200,
        data: { entries: [], pagination: { hasMore: false, limit: 100 } },
      })

      const { result } = renderHook(
        () => useEntryManager({ ...defaultOptions, initialEntries: [] }),
        { wrapper },
      )

      await waitFor(() => expect(result.current.entriesInitializing).toBe(false))
      expect(result.current.entries).toHaveLength(0)
    })

    it('is false on mount when there is no branch to load', () => {
      const { result } = renderHook(() => useEntryManager({ ...defaultOptions, branchName: '' }), {
        wrapper,
      })

      expect(result.current.entriesInitializing).toBe(false)
    })

    it('stays true when a superseded branch load settles before the current one', async () => {
      // Park each entries.list call on a hand-resolved deferred so the two branch
      // loads can settle out of the order they started.
      type ListResult = Awaited<ReturnType<typeof mockClient.entries.list>>
      const resolvers: Array<(v: ListResult) => void> = []
      mockClient.entries.list.mockImplementation(
        () => new Promise<ListResult>((resolve) => resolvers.push(resolve)),
      )
      const emptyPage = {
        ok: true as const,
        status: 200,
        data: { entries: [], pagination: { hasMore: false, limit: 200 } },
      }

      // Mount on a branch (load 1 = the soon-superseded one), wait for it to park at
      // entries.list, then switch branches (load 2 = the current one) so both are in
      // flight together: resolvers[0] = superseded load, resolvers[1] = current load.
      const { result, rerender } = renderHook((props) => useEntryManager(props), {
        wrapper,
        initialProps: { ...defaultOptions, initialEntries: [], branchName: 'main' },
      })

      await waitFor(() => expect(resolvers).toHaveLength(1))
      expect(result.current.entriesInitializing).toBe(true)

      await act(async () => {
        rerender({ ...defaultOptions, initialEntries: [], branchName: 'other' })
      })
      await waitFor(() => expect(resolvers).toHaveLength(2))
      expect(result.current.entriesInitializing).toBe(true)

      // Settle the SUPERSEDED load first. Its `.finally` is seq-guarded, so it must
      // NOT clear the flag while the current branch is still loading.
      await act(async () => {
        resolvers[0](emptyPage)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.entriesInitializing).toBe(true)

      // Settle the current load — now the flag clears.
      await act(async () => {
        resolvers[1](emptyPage)
      })
      await waitFor(() => expect(result.current.entriesInitializing).toBe(false))
    })
  })

  it('opens create modal when creating entry', async () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateEntry(unsafeAsLogicalPath('content/posts'))
    })

    expect(result.current.createModalOpen).toBe(true)
    expect(result.current.createModalCollection).toEqual(
      expect.objectContaining({
        name: 'posts',
        label: 'Posts',
      }),
    )
    expect(mockClient.content.write).not.toHaveBeenCalled()
  })

  it('creates new entry successfully via modal', async () => {
    // Mock content.write for the create operation
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { format: 'mdx', data: {} },
    })

    // Stable mock so both the mount-effect refresh and the post-create refresh
    // see the new entry — otherwise the mount refresh consumes a single
    // mockResolvedValueOnce and the create refresh silently misses navigation.
    mockClient.entries.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        entries: [
          mockCollectionItem,
          {
            ...mockCollectionItem,
            logicalPath: unsafeAsLogicalPath('new-post'),
            slug: unsafeAsSlug('new-post'),
            // collectionPath must match the modal collection ('content/posts') for
            // the create flow's collectionPath+slug navigation lookup to find it.
            collectionPath: unsafeAsLogicalPath('content/posts'),
            physicalPath: unsafeAsPhysicalPath('/content/posts/new-post'),
          },
        ],
        pagination: { hasMore: false, limit: 200 },
      },
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    // Open modal
    await act(async () => {
      await result.current.handleCreateEntry(unsafeAsLogicalPath('content/posts'))
    })

    expect(result.current.createModalOpen).toBe(true)

    // Submit via modal
    await act(async () => {
      await result.current.handleCreateModalSubmit('new-post', 'post')
    })

    expect(mockClient.content.write).toHaveBeenCalledWith(
      { branch: 'main', path: 'content/posts/new-post', entryType: 'post' },
      expect.objectContaining({
        format: 'mdx',
      }),
    )
    expect(result.current.createModalOpen).toBe(false)
    // The create flow navigates to the newly created entry
    expect(result.current.selectedPath).toBe('new-post')
  })

  it('closes modal without creating entry', async () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.handleCreateEntry(unsafeAsLogicalPath('content/posts'))
    })

    expect(result.current.createModalOpen).toBe(true)

    await act(async () => {
      result.current.closeCreateModal()
    })

    // Should not call content.write
    expect(mockClient.content.write).not.toHaveBeenCalled()
    expect(result.current.createModalOpen).toBe(false)
    expect(result.current.createModalCollection).toBeNull()
  })

  it('does not create entry for entry collection', async () => {
    const entryCollections: EditorCollection[] = [
      {
        path: unsafeAsLogicalPath('content/config'),
        name: 'config',
        type: 'entry',
        format: 'json',
      },
    ]

    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, collections: entryCollections }),
      { wrapper },
    )

    await act(async () => {
      await result.current.handleCreateEntry(unsafeAsLogicalPath('content/config'))
    })

    // Should not call content.write for entry
    expect(mockClient.content.write).not.toHaveBeenCalled()
  })

  it('toggles navigator open state', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    expect(result.current.navigatorOpen).toBe(false)

    act(() => {
      result.current.setNavigatorOpen(true)
    })

    expect(result.current.navigatorOpen).toBe(true)
  })

  it('updates selectedPath and syncs to URL', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    act(() => {
      result.current.setSelectedPath('entry1')
    })

    expect(result.current.selectedPath).toBe('entry1')
    expect(window.history.replaceState).toHaveBeenCalled()
  })

  it('resets selectedPath when selected entry is removed', () => {
    const entries = [mockEntry, { ...mockEntry, path: unsafeAsLogicalPath('entry2') }]
    const { result, rerender } = renderHook((props) => useEntryManager(props), {
      initialProps: { ...defaultOptions, initialEntries: entries },
      wrapper,
    })

    act(() => {
      result.current.setSelectedPath('entry2')
    })

    expect(result.current.selectedPath).toBe('entry2')

    act(() => {
      result.current.setEntries([mockEntry])
    })

    rerender({ ...defaultOptions, initialEntries: [mockEntry] })

    waitFor(() => {
      expect(result.current.selectedPath).toBe('entry1')
    })
  })

  it('reads entry from URL parameter on mount', () => {
    window.location.search = '?entry=entry1'

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    waitFor(() => {
      expect(result.current.selectedPath).toBe('entry1')
    })
  })

  it('preserves URL entry param when entries load asynchronously', async () => {
    // Simulate page reload with URL containing a specific entry
    window.location.search = '?entry=entry2'

    const entry1: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry1'),
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry2'),
      slug: 'entry2',
    }

    // Start with empty entries (simulates SSR/hydration scenario)
    const { result } = renderHook((props) => useEntryManager(props), {
      initialProps: { ...defaultOptions, initialEntries: [] },
      wrapper,
    })

    // Initially no selection since no entries
    expect(result.current.selectedPath).toBe('')

    // Simulate entries loading asynchronously
    act(() => {
      result.current.setEntries([entry1, entry2])
    })

    // Should sync from URL and select entry2, not fall back to first entry
    await waitFor(() => {
      expect(result.current.selectedPath).toBe('entry2')
    })
  })

  it('falls back to first entry when URL entry does not exist in entries', async () => {
    // URL contains a non-existent entry
    window.location.search = '?entry=nonexistent'

    const entry1: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry1'),
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry2'),
      slug: 'entry2',
    }

    const { result } = renderHook(
      () =>
        useEntryManager({
          ...defaultOptions,
          initialEntries: [entry1, entry2],
        }),
      { wrapper },
    )

    // Should fall back to first entry since URL entry doesn't exist
    await waitFor(() => {
      expect(result.current.selectedPath).toBe('entry1')
    })
  })

  it('does not update URL until entries have synced from URL', async () => {
    // URL contains entry2
    window.location.search = '?entry=entry2'
    const mockReplaceState = vi.fn()
    window.history.replaceState = mockReplaceState

    const entry1: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry1'),
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry2'),
      slug: 'entry2',
    }

    // Start with entries already loaded (simulates client-side navigation)
    renderHook(
      () =>
        useEntryManager({
          ...defaultOptions,
          initialEntries: [entry1, entry2],
        }),
      { wrapper },
    )

    // Wait for sync to complete
    await waitFor(() => {
      // URL should be updated only after sync is complete
      const lastCall = mockReplaceState.mock.calls[mockReplaceState.mock.calls.length - 1]
      if (lastCall) {
        const url = lastCall[2] as string
        expect(url).toContain('entry2')
      }
    })
  })

  it('does not clear selection on initial mount when branch is set', async () => {
    window.location.search = '?entry=entry1'

    const entry1: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry1'),
      slug: 'entry1',
    }

    // Mock the refresh to return same entry
    mockClient.entries.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        entries: [mockCollectionItem],
        pagination: { hasMore: false, limit: 100 },
      },
    })

    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, initialEntries: [entry1] }),
      { wrapper },
    )

    // Should preserve selection from URL on initial mount, not clear it
    await waitFor(() => {
      expect(result.current.selectedPath).toBe('entry1')
    })
  })

  it('clears OCC version tokens on branch switch so stale tokens are not sent', async () => {
    // Set up: load an entry to populate the version token
    mockClient.content.read.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { format: 'json', data: { v: 1 }, version: 1000 } as any,
    })

    const { result, rerender } = renderHook((props) => useEntryManager(props), {
      initialProps: { ...defaultOptions, branchName: 'main' },
      wrapper,
    })

    // Load entry to capture version token
    await act(async () => {
      await result.current.loadEntry(mockEntry)
    })

    // Set up write mock for the save after branch switch
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { format: 'json', data: { v: 2 } } as any,
    })

    // Switch branch — should clear the version token
    await act(async () => {
      rerender({ ...defaultOptions, branchName: 'feature-branch' })
    })

    // Save on the new branch — must NOT include the stale expectedVersion from 'main'
    await act(async () => {
      await result.current.saveEntry(mockEntry, { v: 2 })
    })

    expect(mockClient.content.write).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature-branch' }),
      expect.not.objectContaining({ expectedVersion: expect.anything() }),
    )
  })

  it('refreshEntries merges all pages into entries state', async () => {
    const page2Item = {
      ...mockCollectionItem,
      slug: unsafeAsSlug('test2'),
      logicalPath: unsafeAsLogicalPath('entry2'),
    }
    // Mount effect + manual refresh both paginate; serve two pages per refresh
    mockClient.entries.list.mockImplementation((params: Record<string, string>) =>
      Promise.resolve({
        ok: true,
        status: 200,
        data:
          params.cursor === '200'
            ? { entries: [page2Item], pagination: { hasMore: false, limit: 200 } }
            : {
                entries: [mockCollectionItem],
                pagination: { cursor: '200', hasMore: true, limit: 200 },
              },
      }),
    )

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2)
    })
    expect(result.current.entries.map((e) => e.path)).toEqual(['entry1', 'entry2'])
  })

  it('a superseded refresh does not overwrite newer entries state', async () => {
    const itemForSlug = (slug: string) => ({
      ...mockCollectionItem,
      slug: unsafeAsSlug(slug),
      logicalPath: unsafeAsLogicalPath(slug),
    })
    const page = (slug: string) => ({
      ok: true as const,
      status: 200,
      data: { entries: [itemForSlug(slug)], pagination: { hasMore: false, limit: 200 } },
    })

    // Each entries.list call parks on a deferred we resolve by hand, so we can
    // settle the two refreshes out of the order they were started.
    type ListResult = Awaited<ReturnType<typeof mockClient.entries.list>>
    const resolvers: Array<(v: ListResult) => void> = []
    mockClient.entries.list.mockImplementation(
      () => new Promise<ListResult>((resolve) => resolvers.push(resolve)),
    )

    const { result } = renderHook(() => useEntryManager(defaultOptions), {
      wrapper,
    })

    // Settle the automatic mount load first, so the two manual refreshes
    // below race only against each other.
    await waitFor(() => expect(resolvers).toHaveLength(1))
    await act(async () => {
      resolvers[0](page('initial'))
    })
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['initial']))

    let firstRefresh: Promise<unknown> = Promise.resolve()
    let secondRefresh: Promise<unknown> = Promise.resolve()
    await act(async () => {
      firstRefresh = result.current.refreshEntries() // the stale one
      secondRefresh = result.current.refreshEntries() // the winner
      await waitFor(() => expect(resolvers).toHaveLength(3))
    })

    // Settle the SECOND (newest) refresh first — it should commit.
    await act(async () => {
      resolvers[2](page('newest'))
      await secondRefresh
    })
    expect(result.current.entries.map((e) => e.path)).toEqual(['newest'])

    // Now settle the FIRST (stale) refresh — its commit must be skipped.
    await act(async () => {
      resolvers[1](page('stale'))
      await firstRefresh
    })
    expect(result.current.entries.map((e) => e.path)).toEqual(['newest'])
  })

  it('switching A→B→A inside the SWR dedupe window re-commits branch A’s cached entries instead of leaving branch B’s on screen', async () => {
    // Regression test for a cross-branch data bleed: SWR serves branch A's
    // CACHED tagged result on the switch back and, inside dedupingInterval,
    // does NOT revalidate. The original commit guard compared the cached
    // tag's seq against a GLOBAL claim counter that branch B's load had
    // already advanced, so the replayed tag was never committed — and with
    // no revalidation coming, the editor kept showing branch B's entries
    // under branch A indefinitely. The per-branch committed-seq rule (see
    // refreshSeqRef in useEntryManager.ts) accepts the replay.
    const itemForBranch = (branch: string) => ({
      ...mockCollectionItem,
      slug: unsafeAsSlug(`${branch}-entry`),
      logicalPath: unsafeAsLogicalPath(`${branch}-entry`),
    })
    mockClient.entries.list.mockImplementation((params: Record<string, string>) =>
      Promise.resolve({
        ok: true as const,
        status: 200,
        data: {
          entries: [itemForBranch(params.branch)],
          pagination: { hasMore: false, limit: 200 },
        },
      }),
    )

    const optionsFor = (branch: string) => ({
      ...defaultOptions,
      initialEntries: [],
      branchName: branch,
    })
    const { result, rerender } = renderHook((props) => useEntryManager(props), {
      wrapper,
      initialProps: optionsFor('branch-a'),
    })

    await waitFor(() =>
      expect(result.current.entries.map((e) => e.path)).toEqual(['branch-a-entry']),
    )

    rerender(optionsFor('branch-b'))
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.path)).toEqual(['branch-b-entry']),
    )

    // Immediately back to A — well inside dedupingInterval (2000ms in the
    // wrapper, matching production SWRProvider), so SWR replays A's cache
    // without a new request. A's entries must come back regardless.
    rerender(optionsFor('branch-a'))
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.path)).toEqual(['branch-a-entry']),
    )
  })

  it('a refresh of a branch the user has switched away from does not overwrite the new branch’s entries', async () => {
    const itemForSlug = (slug: string) => ({
      ...mockCollectionItem,
      slug: unsafeAsSlug(slug),
      logicalPath: unsafeAsLogicalPath(slug),
    })
    const page = (slug: string) => ({
      ok: true as const,
      status: 200,
      data: { entries: [itemForSlug(slug)], pagination: { hasMore: false, limit: 200 } },
    })

    type ListResult = Awaited<ReturnType<typeof mockClient.entries.list>>
    const parked: Array<{ branch: string; resolve: (v: ListResult) => void }> = []
    mockClient.entries.list.mockImplementation(
      (params: Record<string, string>) =>
        new Promise<ListResult>((resolve) => parked.push({ branch: params.branch, resolve })),
    )

    const optionsFor = (branch: string) => ({
      ...defaultOptions,
      initialEntries: [],
      branchName: branch,
    })
    const { result, rerender } = renderHook((props) => useEntryManager(props), {
      wrapper,
      initialProps: optionsFor('branch-a'),
    })

    // Settle A's automatic load.
    await waitFor(() => expect(parked).toHaveLength(1))
    await act(async () => {
      parked[0].resolve(page('a-initial'))
    })
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a-initial']))

    // Start an explicit refresh of A, then switch to B while it's in flight.
    let lateRefresh: Promise<unknown> = Promise.resolve()
    await act(async () => {
      lateRefresh = result.current.refreshEntries()
      await waitFor(() => expect(parked).toHaveLength(2))
    })
    rerender(optionsFor('branch-b'))

    // Settle B's automatic load, then the late A refresh.
    await waitFor(() => expect(parked).toHaveLength(3))
    const bLoad = parked.find((p) => p.branch === 'branch-b')!
    await act(async () => {
      bLoad.resolve(page('b-entries'))
    })
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['b-entries']))

    await act(async () => {
      parked[1].resolve(page('a-late'))
      await lateRefresh
    })
    // The late A response must not bleed into B's view.
    expect(result.current.entries.map((e) => e.path)).toEqual(['b-entries'])
  })

  describe('switching to a branch whose entries have not loaded yet', () => {
    // Same logical path on both branches with DIFFERENT content IDs -- the
    // shape that turns the stale render into a data bug (an entry created
    // independently on each branch, rather than inherited by branching).
    const itemWithId = (contentId: string) => ({
      ...mockCollectionItem,
      logicalPath: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId(contentId),
      slug: unsafeAsSlug('hello'),
      collectionPath: unsafeAsLogicalPath('content/posts'),
    })

    const optionsFor = (branch: string) => ({
      ...defaultOptions,
      initialEntries: [],
      branchName: branch,
    })

    type ListResult = Awaited<ReturnType<typeof mockClient.entries.list>>
    const listPage = (contentId: string) => ({
      ok: true as const,
      status: 200,
      data: { entries: [itemWithId(contentId)], pagination: { hasMore: false, limit: 200 } },
    })

    /** Park every entries.list call so each branch's load settles on demand. */
    const parkListCalls = () => {
      const parked: Array<{ branch: string; resolve: (v: ListResult) => void }> = []
      mockClient.entries.list.mockImplementation(
        (params: Record<string, string>) =>
          new Promise<ListResult>((resolve) => parked.push({ branch: params.branch, resolve })),
      )
      return parked
    }

    it('shows nothing from the previous branch while the new branch loads', async () => {
      // Pre-SWR, `setEntriesInitializing(true)` fired unconditionally on every
      // branch change. Gated on SWR's `isLoading` it stopped covering this
      // case, and nothing reset the committed entries/collections -- so the
      // PREVIOUS branch's entries stayed on screen for the whole duration of
      // the new branch's fetch. Worse than a stale render: the selection
      // fallback effect then auto-selected one of them, with no click from the
      // user, while `branchName` already read the new branch.
      const parked = parkListCalls()
      const { result, rerender } = renderHook((props) => useEntryManager(props), {
        wrapper,
        initialProps: optionsFor('branch-a'),
      })

      await waitFor(() => expect(parked).toHaveLength(1))
      await act(async () => {
        parked[0].resolve(listPage('aaaaaaaaaaaa'))
      })
      await waitFor(() => expect(result.current.entries).toHaveLength(1))
      expect(result.current.selectedPath).toBe('content/posts/hello')

      // Branch B has never been visited, so SWR has no cache for it and its
      // fetch is still in flight.
      rerender(optionsFor('branch-b'))
      await waitFor(() => expect(parked).toHaveLength(2))

      expect(result.current.entries).toEqual([])
      expect(result.current.collections).toEqual([])
      expect(result.current.currentEntry).toBeUndefined()
      expect(result.current.selectedPath).toBe('')
      expect(result.current.entriesInitializing).toBe(true)

      // ...and B's own entries still arrive normally.
      await act(async () => {
        parked[1].resolve(listPage('bbbbbbbbbbbb'))
      })
      await waitFor(() => expect(result.current.entries).toHaveLength(1))
      expect(result.current.entries[0].contentId).toBe('bbbbbbbbbbbb')
      expect(result.current.entriesInitializing).toBe(false)
    })

    it('never saves an entry without the OCC token from its own load', async () => {
      // The data-loss half of the same bug, and the reason it is more than
      // cosmetic. Version tokens are keyed `${branch}:${contentId}`. Pre-fix,
      // clicking the stale entry mid-switch read branch B's file but filed the
      // token under branch A's contentId; when B's entries landed, the
      // same-path entry carried a different contentId, the lookup missed, and
      // the save went out with `expectedVersion: undefined` -- which
      // content-store.ts reads as "skip the mtime check", silently downgrading
      // a conflicting save into a blind overwrite.
      //
      // Asserted as an invariant over every write rather than one value:
      // whatever entry the UI lets the user select and save, it must carry the
      // token from its own load.
      const parked = parkListCalls()
      mockClient.content.read.mockResolvedValue({
        ok: true,
        status: 200,
        data: { format: 'mdx', data: {}, body: 'hi', version: 12345 } as never,
      })
      mockClient.content.write.mockResolvedValue({
        ok: true,
        status: 200,
        data: { format: 'mdx', data: {}, body: 'edited', version: 999 } as never,
      })

      const { result, rerender } = renderHook((props) => useEntryManager(props), {
        wrapper,
        initialProps: optionsFor('branch-a'),
      })

      await waitFor(() => expect(parked).toHaveLength(1))
      await act(async () => {
        parked[0].resolve(listPage('aaaaaaaaaaaa'))
      })
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      rerender(optionsFor('branch-b'))
      await waitFor(() => expect(parked).toHaveLength(2))

      // The interleaving is the bug, so the test has to reproduce it: the user
      // OPENS an entry, the new branch's data lands while the form sits there,
      // and only then do they save. A load and save back-to-back can't expose
      // this -- the contentId has no chance to change in between.
      //
      // Pre-fix the editor offered branch A's entry here, still on screen under
      // branch B; post-fix there is nothing to open until B's data arrives.
      const openedMidSwitch = result.current.currentEntry
      if (openedMidSwitch) {
        await act(async () => {
          await result.current.loadEntry(openedMidSwitch)
        })
      }

      await act(async () => {
        parked[1].resolve(listPage('bbbbbbbbbbbb'))
      })
      await waitFor(() => expect(result.current.entries[0]?.contentId).toBe('bbbbbbbbbbbb'))

      // The user saves what the form is showing. If the editor never offered
      // anything above, this is their first interaction with the entry.
      const showing = result.current.currentEntry
      expect(showing).toBeDefined()
      if (!openedMidSwitch) {
        await act(async () => {
          await result.current.loadEntry(showing!)
        })
      }
      await act(async () => {
        await result.current.saveEntry(showing!, { body: 'edited' } as never)
      })

      expect(mockClient.content.write).toHaveBeenCalledTimes(1)
      expect(mockClient.content.write.mock.calls[0][1]).toEqual(
        expect.objectContaining({ expectedVersion: 12345 }),
      )
    })

    it('reports a failed load on the branch it mounted on (does not cover the loading-forever case below)', async () => {
      // Mounting directly on a failing branch does NOT exercise the guard
      // this hook exists to protect: `view` initializes stamped with
      // `options.branchName` (see BranchView's doc comment), so
      // `isCurrentBranchView` is already true at render 1 and the
      // `!entriesError` term in `entriesInitializing` is never consulted --
      // deleting it leaves this test green. It survives anyway, under an
      // honest name, purely as coverage of the SEPARATE reporting effect
      // (console.error + a red notification on a failed load). The
      // load-bearing case for the guard itself is the switch sequence in the
      // next test.
      const { error, restore } = setupMockConsole(['error'])
      mockClient.schema.get.mockResolvedValue({ ok: false, status: 500 } as never)

      const { result } = renderHook((props) => useEntryManager(props), {
        wrapper,
        initialProps: optionsFor('branch-a'),
      })

      await waitFor(() => expect(result.current.entriesInitializing).toBe(false))
      expect(result.current.entries).toEqual([])
      expect(error).toHaveBeenCalled()
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red' }),
      )
      restore()
    })

    it('a failed load after switching branches settles to the empty state and reports, rather than loading forever', async () => {
      // THIS is the sequence that actually exercises the `!entriesError` term
      // in useEntryManager.ts's `entriesInitializing` (see its doc comment) --
      // replacing a version of this test that mounted directly on the failing
      // branch and stayed green even with `!entriesError && ` deleted from
      // that expression (the finding this test addresses).
      //
      // Mounting directly on a failing branch (previous test) can't exercise
      // it: `view` initializes stamped with the mount branch, so
      // `isCurrentBranchView` is already true at render 1. A SWITCH is what
      // makes `isCurrentBranchView` false while the new branch's fetch is in
      // flight -- `view` stays stamped with the OLD (successfully-loaded)
      // branch until something commits over it -- so once branch B's fetch
      // rejects, `!isCurrentBranchView` alone would keep `entriesInitializing`
      // true forever: SWRProvider's `shouldRetryOnError: false` makes the
      // failure terminal, so no revalidation is ever coming to clear it.
      // `!entriesError` is what settles the pane to the empty state instead
      // of leaving it stuck on "Loading content…" with no retry affordance.
      const { error, restore } = setupMockConsole(['error'])
      try {
        mockClient.entries.list.mockResolvedValue(listPage('aaaaaaaaaaaa'))
        // Keyed on the branch param, not a blanket failure: branch A must
        // load successfully first (so there's a committed view for the
        // switch to leave behind), and only branch B's fetch fails.
        mockClient.schema.get.mockImplementation((params: Record<string, string>) =>
          Promise.resolve(
            params.branch === 'branch-b'
              ? ({ ok: false, status: 500 } as never)
              : ({ ok: true, status: 200, data: { flatSchema: [], entrySchemas: {} } } as never),
          ),
        )

        const { result, rerender } = renderHook((props) => useEntryManager(props), {
          wrapper,
          initialProps: optionsFor('branch-a'),
        })

        // Branch A's load commits successfully -- `view` is now stamped
        // 'branch-a' -- before the switch happens.
        await waitFor(() => expect(result.current.entries).toHaveLength(1))
        await waitFor(() => expect(result.current.entriesInitializing).toBe(false))

        rerender(optionsFor('branch-b'))

        // Pin the TRANSITION, not just the end state -- asserting only that
        // the flag is false at the end would go green again under a future
        // change that made it false from the first post-switch render, which
        // is exactly the shape of vacuity this test was rewritten to remove.
        // Deterministic, not a race: `rerender` is synchronous, `view` is
        // still stamped 'branch-a' so `!isCurrentBranchView` holds, and
        // branch B's rejection needs at least a microtask to land.
        expect(result.current.entriesInitializing).toBe(true)

        // The failure settles instead of hanging -- the whole point of the
        // guard under test.
        await waitFor(() => expect(result.current.entriesInitializing).toBe(false))
        expect(result.current.entries).toEqual([])
        expect(result.current.collections).toEqual([])
        expect(result.current.currentEntry).toBeUndefined()

        // ...and is reported, not silently swallowed.
        expect(error).toHaveBeenCalled()
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ color: 'red' }),
        )
      } finally {
        restore()
      }
    })
  })
})

describe('listAllEntries', () => {
  const makeItem = (slug: string) => ({
    logicalPath: unsafeAsLogicalPath(`content/posts/${slug}`),
    contentId: unsafeAsContentId('abc123XYZ789'),
    slug: unsafeAsSlug(slug),
    collectionPath: unsafeAsLogicalPath('posts'),
    collectionName: 'posts',
    format: 'mdx' as const,
    entryType: 'post',
    physicalPath: unsafeAsPhysicalPath(`/content/posts/${slug}`),
  })

  const pageResponse = (slugs: string[], nextCursor?: string) => ({
    ok: true,
    status: 200,
    data: {
      entries: slugs.map(makeItem),
      pagination: { cursor: nextCursor, hasMore: Boolean(nextCursor), limit: 200 },
    },
  })

  it('follows the cursor across pages and accumulates entries', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(['a', 'b'], '200'))
      .mockResolvedValueOnce(pageResponse(['c', 'd'], '400'))
      .mockResolvedValueOnce(pageResponse(['e']))
    const client = { entries: { list } }

    const result = await listAllEntries(client as Parameters<typeof listAllEntries>[0], 'main')

    expect(result.truncated).toBe(false)
    expect(result.entries.map((e) => e.slug)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(list).toHaveBeenNthCalledWith(1, { branch: 'main', limit: '200' })
    expect(list).toHaveBeenNthCalledWith(2, { branch: 'main', limit: '200', cursor: '200' })
    expect(list).toHaveBeenNthCalledWith(3, { branch: 'main', limit: '200', cursor: '400' })
  })

  it('dedupes entries repeated across pages by logicalPath', async () => {
    // Offset cursors can resend an item if content shifts between requests
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(['a', 'b'], '200'))
      .mockResolvedValueOnce(pageResponse(['b', 'c']))
    const client = { entries: { list } }

    const result = await listAllEntries(client as Parameters<typeof listAllEntries>[0], 'main')

    expect(result.entries.map((e) => e.slug)).toEqual(['a', 'b', 'c'])
  })

  it('rejects the whole call when a page fetch fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(['a'], '200'))
      .mockResolvedValueOnce({ ok: false, status: 500 })
    const client = { entries: { list } }

    await expect(
      listAllEntries(client as Parameters<typeof listAllEntries>[0], 'main'),
    ).rejects.toThrow('Refresh failed: 500')
  })

  it('stops at the safety cap and reports truncation', async () => {
    const list = vi.fn().mockResolvedValue(pageResponse(['a'], '200'))
    const client = { entries: { list } }

    const result = await listAllEntries(client as Parameters<typeof listAllEntries>[0], 'main')

    expect(result.truncated).toBe(true)
    expect(list).toHaveBeenCalledTimes(50)
  })
})
