import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEntryManager } from './useEntryManager'
import type { EditorEntry, EditorCollection } from '../Editor'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useEntryManager', () => {
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

  const mockCollections: EditorCollection[] = [
    {
      id: 'posts',
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

  beforeEach(() => {
    // Mock fetch with default response for refreshEntries called in useEffect
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { entries: [], collections: [] } }),
    })
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

  it('initializes with provided entries and selects first entry', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions))

    expect(result.current.entries).toEqual([mockEntry])
    expect(result.current.selectedId).toBe('entry1')
    expect(result.current.currentEntry).toEqual(mockEntry)
  })

  it('uses initialSelectedId when provided', () => {
    const { result } = renderHook(() =>
      useEntryManager({ ...defaultOptions, initialSelectedId: 'entry1' })
    )

    expect(result.current.selectedId).toBe('entry1')
  })

  it('builds collectionById map correctly', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions))

    expect(result.current.collectionById.get('posts')).toEqual(mockCollections[0])
  })

  it('loads entry successfully', async () => {
    const mockData = { data: { slug: 'test', title: 'Test Entry', body: 'Content' } }
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: loadEntry
        ok: true,
        json: async () => mockData,
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    const loaded = await result.current.loadEntry(mockEntry)

    expect(loaded).toEqual({ slug: 'test', title: 'Test Entry', body: 'Content' })
    expect(global.fetch).toHaveBeenCalledWith(mockEntry.apiPath)
  })

  it('handles load entry error', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: loadEntry with error
        ok: false,
        status: 404,
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await expect(result.current.loadEntry(mockEntry)).rejects.toThrow('Load failed: 404')
  })

  it('saves entry successfully', async () => {
    const mockValue = { title: 'Updated Title', body: 'Updated Content' }
    const mockResponse = { data: mockValue }
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: saveEntry
        ok: true,
        json: async () => mockResponse,
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    const saved = await result.current.saveEntry(mockEntry, mockValue)

    expect(saved).toEqual(mockValue)
    expect(global.fetch).toHaveBeenCalledWith(
      mockEntry.apiPath,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  it('handles save entry error', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: saveEntry with error
        ok: false,
        status: 500,
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await expect(result.current.saveEntry(mockEntry, {})).rejects.toThrow('Save failed: 500')
  })

  it('refreshes entries successfully', async () => {
    const mockRefreshed = [mockEntry, { ...mockEntry, id: 'entry2', slug: 'test2' }]
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: manual refreshEntries
        ok: true,
        json: async () => ({
          data: {
            entries: mockRefreshed,
            collections: [],
          },
        }),
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/main/entries')
  })

  it('selects newly created entry after refresh', async () => {
    const newEntry = { ...mockEntry, id: 'new-entry', slug: 'new' }
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        // First call: refreshEntries in useEffect
        ok: true,
        json: async () => ({ data: { entries: [mockEntry], collections: [] } }),
      })
      .mockResolvedValueOnce({
        // Second call: manual refreshEntries
        ok: true,
        json: async () => ({
          data: {
            entries: [mockEntry, newEntry],
            collections: [],
          },
        }),
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await act(async () => {
      await result.current.refreshEntries()
    })

    await waitFor(() => {
      expect(result.current.selectedId).toBe('new-entry')
    })
  })

  it('creates new entry successfully', async () => {
    window.prompt = vi.fn(() => 'new-post')
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            entries: [mockEntry, { ...mockEntry, id: 'new-post', slug: 'new-post' }],
            collections: [],
          },
        }),
      })

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await act(async () => {
      await result.current.handleCreateEntry('posts')
    })

    expect(window.prompt).toHaveBeenCalledWith('New Posts slug?', 'untitled')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/canopycms/main/content/posts/new-post',
      expect.objectContaining({
        method: 'PUT',
      })
    )
    expect(defaultOptions.setBusy).toHaveBeenCalledWith(true)
    expect(defaultOptions.setBusy).toHaveBeenCalledWith(false)
  })

  it('does not create entry when prompt is cancelled', async () => {
    window.prompt = vi.fn(() => null)

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    await act(async () => {
      await result.current.handleCreateEntry('posts')
    })

    // Only the initial refreshEntries call, not a create call
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/main/entries')
  })

  it('does not create entry for singleton collection', async () => {
    const singletonCollections: EditorCollection[] = [
      {
        id: 'config',
        name: 'config',
        type: 'singleton',
        format: 'json',
      },
    ]

    const { result } = renderHook(() =>
      useEntryManager({ ...defaultOptions, collections: singletonCollections })
    )

    await act(async () => {
      await result.current.handleCreateEntry('config')
    })

    // Only the initial refreshEntries call, not a create call
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('/api/canopycms/main/entries')
  })

  it('toggles navigator open state', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions))

    expect(result.current.navigatorOpen).toBe(false)

    act(() => {
      result.current.setNavigatorOpen(true)
    })

    expect(result.current.navigatorOpen).toBe(true)
  })

  it('updates selectedId and syncs to URL', () => {
    const { result } = renderHook(() => useEntryManager(defaultOptions))

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

    const { result } = renderHook(() => useEntryManager(defaultOptions))

    waitFor(() => {
      expect(result.current.selectedId).toBe('entry1')
    })
  })
})
