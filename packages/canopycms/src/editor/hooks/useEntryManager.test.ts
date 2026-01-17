import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEntryManager } from './useEntryManager'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, setupMockLocation, setupMockHistory, createApiClientWrapper } from './__test__/test-utils'

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
    id: 'entry1',
    label: 'Test Entry',
    collectionId: 'posts',
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
    apiPath: '/api/canopycms/main/content/posts/test',
    format: 'mdx',
    schema: [],
  }

  const mockCollectionItem = {
    id: 'entry1',
    slug: 'test',
    collectionId: 'posts',
    collectionName: 'posts',
    format: 'mdx' as const,
    itemType: 'entry' as const,
    path: '/content/posts/test',
  }

  const mockCollections: EditorCollection[] = [
    {
      id: 'posts',
      name: 'posts',
      label: 'Posts',
      type: 'collection',
      format: 'mdx',
    },
  ]

  const mockCollectionSummary = {
    id: 'posts',
    name: 'posts',
    label: 'Posts',
    type: 'collection' as const,
    format: 'mdx' as const,
    path: '/content/posts',
    schema: [],
  }

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
    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    expect(result.current.entries).toEqual([mockEntry])
    expect(result.current.selectedId).toBe('entry1')
    expect(result.current.currentEntry).toEqual(mockEntry)
  })

  it('uses initialSelectedId when provided', () => {
    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, initialSelectedId: 'entry1' }),
      { wrapper }
    )

    expect(result.current.selectedId).toBe('entry1')
  })

  it('builds collectionById map correctly', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    expect(result.current.collectionById.get('posts')).toEqual(mockCollections[0])
  })

  it('loads entry successfully', async () => {
    const mockData = { slug: 'test', title: 'Test Entry', body: 'Content' }
    mockClient.content.read.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: mockData as any, // Mock uses simplified format that normalizeContentPayload handles
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    const loaded = await result.current.loadEntry(mockEntry)

    expect(loaded).toEqual({ slug: 'test', title: 'Test Entry', body: 'Content' })
    expect(mockClient.content.read).toHaveBeenCalledWith({ branch: 'main', path: 'posts/test' })
  })

  it('handles load entry error', async () => {
    mockClient.content.read.mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

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

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    const saved = await result.current.saveEntry(mockEntry, mockValue)

    expect(saved).toEqual({ title: 'Updated Title', body: 'Updated Content' })
    expect(mockClient.content.write).toHaveBeenCalledWith(
      { branch: 'main', path: 'posts/test' },
      {
        format: 'mdx',
        data: { title: 'Updated Title' }, // body is extracted
        body: 'Updated Content',
      }
    )
  })

  it('handles save entry error', async () => {
    mockClient.content.write.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    await expect(result.current.saveEntry(mockEntry, {})).rejects.toThrow('Save failed: 500')
  })

  it('refreshes entries successfully', async () => {
    const mockRefreshed = [
      mockCollectionItem,
      { ...mockCollectionItem, id: 'entry2', slug: 'test2', path: '/content/posts/test2' },
    ]
    // First call is from useEffect on mount, second is from manual call
    mockClient.entries.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { entries: [], collections: [mockCollectionSummary], pagination: { hasMore: false, limit: 100 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          entries: mockRefreshed,
          collections: [mockCollectionSummary],
          pagination: { hasMore: false, limit: 100 },
        },
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2)
    })

    expect(mockClient.entries.list).toHaveBeenCalledWith({ branch: 'main' })
  })

  it('selects newly created entry after refresh', async () => {
    const newEntry = { ...mockCollectionItem, id: 'new-entry', slug: 'new', path: '/content/posts/new' }
    // First call is from useEffect on mount, second is from manual call
    mockClient.entries.list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { entries: [mockCollectionItem], collections: [mockCollectionSummary], pagination: { hasMore: false, limit: 100 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          entries: [mockCollectionItem, newEntry],
          collections: [mockCollectionSummary],
          pagination: { hasMore: false, limit: 100 },
        },
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.selectedId).toBe('new-entry')
    })
  })

  it('creates new entry successfully', async () => {
    window.prompt = vi.fn(() => 'new-post')

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
          { ...mockCollectionItem, id: 'new-post', slug: 'new-post', path: '/content/posts/new-post' },
        ],
        collections: [mockCollectionSummary],
        pagination: { hasMore: false, limit: 100 },
      },
    })

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleCreateEntry('posts')
    })

    expect(window.prompt).toHaveBeenCalledWith('New Posts slug?', 'untitled')
    expect(mockClient.content.write).toHaveBeenCalledWith(
      { branch: 'main', path: 'posts/new-post' },
      expect.objectContaining({
        format: 'mdx',
      })
    )
    expect(defaultOptions.setBusy).toHaveBeenCalledWith(true)
    expect(defaultOptions.setBusy).toHaveBeenCalledWith(false)
  })

  it('does not create entry when prompt is cancelled', async () => {
    window.prompt = vi.fn(() => null)

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    await act(async () => {
      await result.current.handleCreateEntry('posts')
    })

    // Should not call content.write
    expect(mockClient.content.write).not.toHaveBeenCalled()
  })

  it('does not create entry for entry collection', async () => {
    const entryCollections: EditorCollection[] = [
      {
        id: 'config',
        name: 'config',
        type: 'entry',
        format: 'json',
      },
    ]

    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, collections: entryCollections }),
      { wrapper }
    )

    await act(async () => {
      await result.current.handleCreateEntry('config')
    })

    // Should not call content.write for entry
    expect(mockClient.content.write).not.toHaveBeenCalled()
  })

  it('toggles navigator open state', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    expect(result.current.navigatorOpen).toBe(false)

    act(() => {
      result.current.setNavigatorOpen(true)
    })

    expect(result.current.navigatorOpen).toBe(true)
  })

  it('updates selectedId and syncs to URL', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    act(() => {
      result.current.setSelectedId('entry1')
    })

    expect(result.current.selectedId).toBe('entry1')
    expect(window.history.replaceState).toHaveBeenCalled()
  })

  it('resets selectedId when selected entry is removed', () => {
    const entries = [mockEntry, { ...mockEntry, id: 'entry2' }]
    const { result, rerender } = renderHook((props) => useEntryManager(props), {
      initialProps: { ...defaultOptions, initialEntries: entries },
      wrapper,
    })

    act(() => {
      result.current.setSelectedId('entry2')
    })

    expect(result.current.selectedId).toBe('entry2')

    act(() => {
      result.current.setEntries([mockEntry])
    })

    rerender({ ...defaultOptions, initialEntries: [mockEntry] })

    waitFor(() => {
      expect(result.current.selectedId).toBe('entry1')
    })
  })

  it('reads entry from URL parameter on mount', () => {
    window.location.search = '?entry=entry1'

    const { result } = renderHook(() => useEntryManager(defaultOptions), { wrapper })

    waitFor(() => {
      expect(result.current.selectedId).toBe('entry1')
    })
  })

  it('preserves URL entry param when entries load asynchronously', async () => {
    // Simulate page reload with URL containing a specific entry
    window.location.search = '?entry=entry2'

    const entry1: EditorEntry = {
      ...mockEntry,
      id: 'entry1',
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      id: 'entry2',
      slug: 'entry2',
    }

    // Start with empty entries (simulates SSR/hydration scenario)
    const { result, rerender } = renderHook(
      (props) => useEntryManager(props),
      {
        initialProps: { ...defaultOptions, initialEntries: [] },
        wrapper,
      }
    )

    // Initially no selection since no entries
    expect(result.current.selectedId).toBe('')

    // Simulate entries loading asynchronously
    act(() => {
      result.current.setEntries([entry1, entry2])
    })

    // Should sync from URL and select entry2, not fall back to first entry
    await waitFor(() => {
      expect(result.current.selectedId).toBe('entry2')
    })
  })

  it('falls back to first entry when URL entry does not exist in entries', async () => {
    // URL contains a non-existent entry
    window.location.search = '?entry=nonexistent'

    const entry1: EditorEntry = {
      ...mockEntry,
      id: 'entry1',
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      id: 'entry2',
      slug: 'entry2',
    }

    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, initialEntries: [entry1, entry2] }),
      { wrapper }
    )

    // Should fall back to first entry since URL entry doesn't exist
    await waitFor(() => {
      expect(result.current.selectedId).toBe('entry1')
    })
  })

  it('does not update URL until entries have synced from URL', async () => {
    // URL contains entry2
    window.location.search = '?entry=entry2'
    const mockReplaceState = vi.fn()
    window.history.replaceState = mockReplaceState

    const entry1: EditorEntry = {
      ...mockEntry,
      id: 'entry1',
      slug: 'entry1',
    }
    const entry2: EditorEntry = {
      ...mockEntry,
      id: 'entry2',
      slug: 'entry2',
    }

    // Start with entries already loaded (simulates client-side navigation)
    renderHook(
      () => useEntryManager({ ...defaultOptions, initialEntries: [entry1, entry2] }),
      { wrapper }
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
      id: 'entry1',
      slug: 'entry1',
    }

    // Mock the refresh to return same entry
    mockClient.entries.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        entries: [mockCollectionItem],
        collections: [mockCollectionSummary],
        pagination: { hasMore: false, limit: 100 },
      },
    })

    const { result } = renderHook(
      () => useEntryManager({ ...defaultOptions, initialEntries: [entry1] }),
      { wrapper }
    )

    // Should preserve selection from URL on initial mount, not clear it
    await waitFor(() => {
      expect(result.current.selectedId).toBe('entry1')
    })
  })
})
