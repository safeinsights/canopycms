import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftManager } from './useDraftManager'
import type { EditorEntry } from '../Editor'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../../paths/test-utils'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

describe('useDraftManager', () => {
  const mockEntry: EditorEntry = {
    path: unsafeAsLogicalPath('entry1'),
    contentId: unsafeAsContentId('abc123def456'), // 12-char content ID
    label: 'Test Entry',
    collectionPath: unsafeAsLogicalPath('posts'),
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
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    })

    mockLoadEntry.mockResolvedValue({
      title: 'Loaded Title',
      body: 'Loaded Content',
    })
    mockSaveEntry.mockResolvedValue({
      title: 'Saved Title',
      body: 'Saved Content',
    })
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
    const initialValues = {
      abc123def456: { title: 'Initial', body: 'Content' },
    }
    const { result } = renderHook(() => useDraftManager({ ...defaultOptions, initialValues }))

    expect(result.current.drafts).toEqual(initialValues)
  })

  it('computes selectedValue and effectiveValue', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'Draft', body: 'Draft Content' },
      })
    })

    expect(result.current.selectedValue).toEqual({
      title: 'Draft',
      body: 'Draft Content',
    })
    expect(result.current.effectiveValue).toEqual({
      title: 'Draft',
      body: 'Draft Content',
    })
  })

  it('falls back to loadedValue when no draft exists', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setLoadedValues({
        abc123def456: { title: 'Loaded', body: 'Loaded Content' },
      })
    })

    expect(result.current.selectedValue).toBeUndefined()
    expect(result.current.loadedValue).toEqual({
      title: 'Loaded',
      body: 'Loaded Content',
    })
    expect(result.current.effectiveValue).toEqual({
      title: 'Loaded',
      body: 'Loaded Content',
    })
  })

  it('computes modifiedCount correctly', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    expect(result.current.modifiedCount).toBe(0)

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'Draft 1' },
        xyz789uvw123: { title: 'Draft 2' },
        mno456pqr789: { title: 'Draft 3' },
      })
    })

    expect(result.current.modifiedCount).toBe(3)
  })

  it('modifiedCount does not count entries seeded with their loaded value', () => {
    // This is the bug: Editor.tsx seeds drafts[id] = loaded AND loadedValues[id] = loaded
    // on first entry open. That entry should not count as "modified".
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    const loadedVal = { title: 'Loaded Title', body: 'Loaded Content' }

    act(() => {
      result.current.setLoadedValues({ abc123def456: loadedVal })
      result.current.setDrafts({ abc123def456: loadedVal })
    })

    expect(result.current.modifiedCount).toBe(0)
  })

  it('modifiedCount counts only entries where draft differs from loaded', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    const loadedVal = { title: 'Original', body: 'Original Content' }
    const editedVal = { title: 'Edited', body: 'Original Content' }

    act(() => {
      result.current.setLoadedValues({ abc123def456: loadedVal })
      result.current.setDrafts({ abc123def456: editedVal }) // differs → dirty
    })

    expect(result.current.modifiedCount).toBe(1)
  })

  it('isAnyDirty returns false when no entries have unsaved changes', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))
    expect(result.current.isAnyDirty()).toBe(false)
  })

  it('isAnyDirty returns true when the selected entry is dirty', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
      result.current.setDrafts({ abc123def456: { title: 'Changed' } })
    })

    expect(result.current.isAnyDirty()).toBe(true)
  })

  it('isAnyDirty returns true when a non-selected entry is dirty', () => {
    // This is the bug: switching branches when entry A is dirty but entry B is selected
    // should still prompt the user — but isSelectedDirty() only checks the selected entry.
    const otherEntry: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry2'),
      contentId: unsafeAsContentId('xyz789uvw123'),
      label: 'Other Entry',
    }
    const { result } = renderHook(() =>
      useDraftManager({
        ...defaultOptions,
        currentEntry: otherEntry, // currently viewing entry2
        entries: [mockEntry, otherEntry],
      }),
    )

    act(() => {
      // entry1 (abc123def456) is dirty but not selected
      result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
      result.current.setDrafts({ abc123def456: { title: 'Unsaved changes on entry1!' } })
    })

    expect(result.current.isAnyDirty()).toBe(true)
    // Confirm isSelectedDirty() does NOT catch this (the bug we're fixing)
    expect(result.current.isSelectedDirty()).toBe(false)
  })

  it('computes editedFiles correctly', () => {
    const entries = [
      mockEntry,
      {
        ...mockEntry,
        path: unsafeAsLogicalPath('entry2'),
        contentId: unsafeAsContentId('xyz789uvw123'),
        label: 'Entry 2',
      },
      {
        ...mockEntry,
        path: unsafeAsLogicalPath('entry3'),
        contentId: unsafeAsContentId('mno456pqr789'),
        label: 'Entry 3',
      },
    ]

    const { result } = renderHook(() => useDraftManager({ ...defaultOptions, entries }))

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'Draft 1' },
        xyz789uvw123: { title: 'Draft 2' },
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
      JSON.stringify({
        abc123def456: { title: 'Restored', body: 'From Storage' },
      }),
    )

    const { result } = renderHook(() => useDraftManager(defaultOptions))

    waitFor(() => {
      expect(result.current.drafts).toEqual({
        abc123def456: { title: 'Restored', body: 'From Storage' },
      })
    })
  })

  it('persists drafts to localStorage when changed', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'New Draft', body: 'Content' },
      })
    })

    const stored = window.localStorage.getItem('canopycms:drafts:main')
    expect(stored).toBe(JSON.stringify({ abc123def456: { title: 'New Draft', body: 'Content' } }))
  })

  it('saves draft successfully', async () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'Draft', body: 'Content' },
      })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockSaveEntry).toHaveBeenCalledWith(mockEntry, {
      title: 'Draft',
      body: 'Content',
    })
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
    expect(result.current.drafts.abc123def456).toEqual({
      title: 'Saved Title',
      body: 'Saved Content',
    })
    expect(result.current.loadedValues.abc123def456).toEqual({
      title: 'Saved Title',
      body: 'Saved Content',
    })
  })

  it('handles save error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSaveEntry.mockRejectedValueOnce(new Error('Save failed'))

    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Draft' } })
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
      result.current.setDrafts({
        abc123def456: { title: 'Draft' },
        xyz789uvw123: { title: 'Draft 2' },
      })
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
      result.current.setDrafts({
        abc123def456: { title: 'Draft 1' },
        xyz789uvw123: { title: 'Draft 2' },
      })
    })

    act(() => {
      result.current.handleDiscardFileDraft()
    })

    expect(result.current.drafts).toEqual({
      xyz789uvw123: { title: 'Draft 2' },
    })
  })

  it('reloads entry from server', async () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    await act(async () => {
      await result.current.handleReload()
    })

    expect(mockLoadEntry).toHaveBeenCalledWith(mockEntry)
    expect(mockSetBusy).toHaveBeenCalledWith(true)
    expect(mockSetBusy).toHaveBeenCalledWith(false)
    expect(result.current.loadedValues.abc123def456).toEqual({
      title: 'Loaded Title',
      body: 'Loaded Content',
    })
    expect(result.current.drafts.abc123def456).toEqual({
      title: 'Loaded Title',
      body: 'Loaded Content',
    })
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
      result.current.setDrafts({ abc123def456: { title: 'Draft' } })
    })

    expect(window.localStorage.getItem('canopycms:drafts:main')).toBeTruthy()

    rerender({ ...defaultOptions, branchName: 'feature' })

    waitFor(() => {
      expect(window.localStorage.getItem('canopycms:drafts:feature')).toBeTruthy()
    })
  })
})
