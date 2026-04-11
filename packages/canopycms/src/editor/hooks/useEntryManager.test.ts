import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEntryManager } from './useEntryManager'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { MockApiClient } from '../../api/__test__/mock-client'
import {
  setupMockApiClient,
  setupMockLocation,
  setupMockHistory,
  createApiClientWrapper,
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
    apiPath: '/api/canopycms/main/content/posts/test',
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

    expect(mockClient.entries.list).toHaveBeenCalledWith({ branch: 'main' })
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

    // Mock entries.list for the refresh after create
    mockClient.entries.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        entries: [
          mockCollectionItem,
          {
            ...mockCollectionItem,
            logicalPath: unsafeAsLogicalPath('new-post'),
            slug: unsafeAsSlug('new-post'),
            physicalPath: unsafeAsPhysicalPath('/content/posts/new-post'),
          },
        ],
        pagination: { hasMore: false, limit: 100 },
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
})
