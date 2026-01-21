import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftManager } from './useDraftManager'
import type { EditorEntry } from '../Editor'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useDraftManager', () => {
  const mockEntry: EditorEntry = {
    path: 'entry1',
    label: 'Test Entry',
    collectionId: 'posts',
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
    apiPath: '/api/canopycms/main/content/posts/test',
    format: 'mdx',
    schema: [],
  }

  const mockLoadEntry = vi.fn()
  const mockSaveEntry = vi.fn()
  const mockSetBusy = vi.fn()

  const defaultOptions = {
    branchName: 'main',
    selectedPath: 'entry1',
    currentEntry: mockEntry,
    entries: [mockEntry],
    loadEntry: mockLoadEntry,
    saveEntry: mockSaveEntry,
    setBusy: mockSetBusy,
  }

  beforeEach(() => {
    // Mock localStorage
    const localStorageMock = (() => {
      let store: Record<string, string> = {}
      return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => {
          store[key] = value
        },
        removeItem: (key: string) => {
          delete store[key]
        },
        clear: () => {
          store = {}
        },
      }
    })()
    Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true })

    mockLoadEntry.mockResolvedValue({ title: 'Loaded Title', body: 'Loaded Content' })
    mockSaveEntry.mockResolvedValue({ title: 'Saved Title', body: 'Saved Content' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('initializes with empty drafts', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    expect(result.current.drafts).toEqual({})
    expect(result.current.loadedValues).toEqual({})
    expect(result.current.modifiedCount).toBe(0)
    expect(result.current.editedFiles).toEqual([])
  })

  it('initializes with initialValues', () => {
    const initialValues = { entry1: { title: 'Initial', body: 'Content' } }
    const { result } = renderHook(() => useDraftManager({ ...defaultOptions, initialValues }))

    expect(result.current.drafts).toEqual(initialValues)
  })

  it('computes selectedValue and effectiveValue', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft', body: 'Draft Content' } })
    })

    expect(result.current.selectedValue).toEqual({ title: 'Draft', body: 'Draft Content' })
    expect(result.current.effectiveValue).toEqual({ title: 'Draft', body: 'Draft Content' })
  })

  it('falls back to loadedValue when no draft exists', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setLoadedValues({ entry1: { title: 'Loaded', body: 'Loaded Content' } })
    })

    expect(result.current.selectedValue).toBeUndefined()
    expect(result.current.loadedValue).toEqual({ title: 'Loaded', body: 'Loaded Content' })
    expect(result.current.effectiveValue).toEqual({ title: 'Loaded', body: 'Loaded Content' })
  })

  it('computes modifiedCount correctly', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    expect(result.current.modifiedCount).toBe(0)

    act(() => {
      result.current.setDrafts({
        entry1: { title: 'Draft 1' },
        entry2: { title: 'Draft 2' },
        entry3: { title: 'Draft 3' },
      })
    })

    expect(result.current.modifiedCount).toBe(3)
  })

  it('computes editedFiles correctly', () => {
    const entries = [
      mockEntry,
      { ...mockEntry, path: 'entry2', label: 'Entry 2' },
      { ...mockEntry, path: 'entry3', label: 'Entry 3' },
    ]

    const { result } = renderHook(() => useDraftManager({ ...defaultOptions, entries }))

    act(() => {
      result.current.setDrafts({
        entry1: { title: 'Draft 1' },
        entry2: { title: 'Draft 2' },
      })
    })

    expect(result.current.editedFiles).toEqual([
      { path: 'entry1', label: 'Test Entry' },
      { path: 'entry2', label: 'Entry 2' },
    ])
  })

  it('restores drafts from localStorage on mount', () => {
    window.localStorage.setItem(
      'canopycms:drafts:main',
      JSON.stringify({ entry1: { title: 'Restored', body: 'From Storage' } }),
    )

    const { result } = renderHook(() => useDraftManager(defaultOptions))

    waitFor(() => {
      expect(result.current.drafts).toEqual({ entry1: { title: 'Restored', body: 'From Storage' } })
    })
  })

  it('persists drafts to localStorage when changed', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'New Draft', body: 'Content' } })
    })

    const stored = window.localStorage.getItem('canopycms:drafts:main')
    expect(stored).toBe(JSON.stringify({ entry1: { title: 'New Draft', body: 'Content' } }))
  })

  it('saves draft successfully', async () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft', body: 'Content' } })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockSaveEntry).toHaveBeenCalledWith(mockEntry, { title: 'Draft', body: 'Content' })
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
    expect(result.current.drafts.entry1).toEqual({ title: 'Saved Title', body: 'Saved Content' })
    expect(result.current.loadedValues.entry1).toEqual({
      title: 'Saved Title',
      body: 'Saved Content',
    })
  })

  it('handles save error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSaveEntry.mockRejectedValueOnce(new Error('Save failed'))

    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft' } })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockSetBusy).toHaveBeenCalledWith(false)
    consoleErrorSpy.mockRestore()
  })

  it('does not save when no currentEntry', async () => {
    const { result } = renderHook(() =>
      useDraftManager({ ...defaultOptions, currentEntry: undefined }),
    )

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockSaveEntry).not.toHaveBeenCalled()
  })

  it('discards all drafts', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft' }, entry2: { title: 'Draft 2' } })
    })

    act(() => {
      result.current.handleDiscardDrafts()
    })

    expect(result.current.drafts).toEqual({})
    // After discarding, localStorage is removed, but the effect will write {} next
    const stored = window.localStorage.getItem('canopycms:drafts:main')
    expect(stored === null || stored === '{}').toBe(true)
  })

  it('discards single file draft', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft 1' }, entry2: { title: 'Draft 2' } })
    })

    act(() => {
      result.current.handleDiscardFileDraft()
    })

    expect(result.current.drafts).toEqual({ entry2: { title: 'Draft 2' } })
  })

  it('reloads entry from server', async () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    await act(async () => {
      await result.current.handleReload()
    })

    expect(mockLoadEntry).toHaveBeenCalledWith(mockEntry)
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
    expect(result.current.loadedValues.entry1).toEqual({
      title: 'Loaded Title',
      body: 'Loaded Content',
    })
    expect(result.current.drafts.entry1).toEqual({ title: 'Loaded Title', body: 'Loaded Content' })
  })

  it('handles reload error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockLoadEntry.mockRejectedValueOnce(new Error('Load failed'))

    const { result } = renderHook(() => useDraftManager(defaultOptions))

    await act(async () => {
      await result.current.handleReload()
    })

    expect(mockSetBusy).toHaveBeenCalledWith(false)
    consoleErrorSpy.mockRestore()
  })

  it('does not reload when no currentEntry', async () => {
    const { result } = renderHook(() =>
      useDraftManager({ ...defaultOptions, currentEntry: undefined }),
    )

    await act(async () => {
      await result.current.handleReload()
    })

    expect(mockLoadEntry).not.toHaveBeenCalled()
  })

  it('updates storageKey when branchName changes', () => {
    const { result, rerender } = renderHook((props) => useDraftManager(props), {
      initialProps: defaultOptions,
    })

    act(() => {
      result.current.setDrafts({ entry1: { title: 'Draft' } })
    })

    expect(window.localStorage.getItem('canopycms:drafts:main')).toBeTruthy()

    rerender({ ...defaultOptions, branchName: 'feature' })

    waitFor(() => {
      expect(window.localStorage.getItem('canopycms:drafts:feature')).toBeTruthy()
    })
  })
})
