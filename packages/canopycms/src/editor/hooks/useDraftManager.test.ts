import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftManager } from './useDraftManager'
import { SaveApiError } from './useEntryManager'
import type { EditorEntry } from '../Editor'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../../paths/test-utils'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
  },
}))

// Mock modals - auto-confirm by default (matches the pattern used in
// useBranchManager.test.tsx); individual tests override with
// mockImplementationOnce to simulate a cancel.
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn((options: { onConfirm?: () => void; onCancel?: () => void }) => {
      options.onConfirm?.()
    }),
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

    mockLoadEntry.mockReset()
    mockSaveEntry.mockReset()
    mockSetBusy.mockReset()

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
    // clearAllMocks (not restoreAllMocks): the latter resets vi.fn()-based
    // mocks (like the @mantine/modals auto-confirm implementation above,
    // which isn't a vi.spyOn spy) to a no-op, which would silently break
    // every discard test after the first. Tests that need a real restore
    // (console.error spies) call mockRestore() themselves.
    vi.clearAllMocks()
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

  it('does not count a draft as dirty when it differs from loaded only by key insertion order', () => {
    // Regression test: the dirty check used to compare via JSON.stringify,
    // which is property-order sensitive. A localStorage-hydrated draft (or
    // one built by spreading fields in a different order) can serialize its
    // keys in a different order than the server-loaded object even though
    // the values are identical -- that must NOT read as dirty.
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    const loadedVal = { title: 'Same Title', body: 'Same Body', tags: ['a', 'b'] }
    // Same values, different key insertion order.
    const rehydratedDraft = { tags: ['a', 'b'], body: 'Same Body', title: 'Same Title' }

    act(() => {
      result.current.setLoadedValues({ abc123def456: loadedVal })
      result.current.setDrafts({ abc123def456: rehydratedDraft })
    })

    expect(result.current.modifiedCount).toBe(0)
    expect(result.current.isSelectedDirty()).toBe(false)
    expect(result.current.isAnyDirty()).toBe(false)
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
    expect(result.current.loadedValues.abc123def456).toEqual({
      title: 'Saved Title',
      body: 'Saved Content',
    })
    // effectiveValue still reflects the saved value even with the draft key gone
    expect(result.current.effectiveValue).toEqual({
      title: 'Saved Title',
      body: 'Saved Content',
    })
  })

  it('clears the draft key (state and localStorage) after a successful save, instead of keeping it forever', async () => {
    // This is the "phantom dirty" bug: a draft that survives a save forever
    // means a fresh page load (draft restored from localStorage, no
    // loadedValues yet) always shows Save enabled with zero real edits.
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({
        abc123def456: { title: 'Draft', body: 'Content' },
      })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(result.current.drafts).not.toHaveProperty('abc123def456')
    expect(result.current.modifiedCount).toBe(0)

    const stored = JSON.parse(window.localStorage.getItem('canopycms:drafts:main') ?? '{}')
    expect(stored).not.toHaveProperty('abc123def456')
  })

  it('calls onSaved after a successful save', async () => {
    const mockOnSaved = vi.fn()
    const { result } = renderHook(() =>
      useDraftManager({ ...defaultOptions, onSaved: mockOnSaved }),
    )

    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Draft', body: 'Content' } })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockOnSaved).toHaveBeenCalledTimes(1)
  })

  it('does not call onSaved when save fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSaveEntry.mockRejectedValueOnce(new Error('Save failed'))
    const mockOnSaved = vi.fn()
    const { result } = renderHook(() =>
      useDraftManager({ ...defaultOptions, onSaved: mockOnSaved }),
    )

    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Draft' } })
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mockOnSaved).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
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

  it('discards all drafts (via the auto-confirmed modal, since there is something to lose)', () => {
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

  it('discards single file draft (via the auto-confirmed modal, since it has no loaded value to match)', () => {
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

  describe('discard confirmation', () => {
    it('opens a confirm modal before discarding a file draft that differs from the loaded value', async () => {
      const { modals } = await import('@mantine/modals')
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
        result.current.setDrafts({ abc123def456: { title: 'Edited' } })
      })

      act(() => {
        result.current.handleDiscardFileDraft()
      })

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          onConfirm: expect.any(Function),
        }),
      )
      // The default mock auto-confirms, so the draft should be gone
      expect(result.current.drafts).not.toHaveProperty('abc123def456')
    })

    it('keeps the file draft when the user cancels the discard confirmation', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onCancel?.()
        return ''
      })
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
        result.current.setDrafts({ abc123def456: { title: 'Edited' } })
      })

      act(() => {
        result.current.handleDiscardFileDraft()
      })

      expect(result.current.drafts.abc123def456).toEqual({ title: 'Edited' })
    })

    it('discards a file draft silently (no modal) when it equals the loaded value', async () => {
      const { modals } = await import('@mantine/modals')
      const sameValue = { title: 'Same' }
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: sameValue })
        result.current.setDrafts({ abc123def456: sameValue })
      })

      act(() => {
        result.current.handleDiscardFileDraft()
      })

      expect(modals.openConfirmModal).not.toHaveBeenCalled()
      expect(result.current.drafts).not.toHaveProperty('abc123def456')
    })

    it('opens a confirm modal mentioning the number of files before discarding all drafts', async () => {
      const { modals } = await import('@mantine/modals')
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
        result.current.setDrafts({
          abc123def456: { title: 'Edited' },
          xyz789uvw123: { title: 'Draft 2' },
        })
      })

      act(() => {
        result.current.handleDiscardDrafts()
      })

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          children: expect.stringContaining('2'),
        }),
      )
      expect(result.current.drafts).toEqual({})
    })

    it('keeps all drafts when the user cancels the discard-all confirmation', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onCancel?.()
        return ''
      })
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
        result.current.setDrafts({ abc123def456: { title: 'Edited' } })
      })

      act(() => {
        result.current.handleDiscardDrafts()
      })

      expect(result.current.drafts.abc123def456).toEqual({ title: 'Edited' })
    })

    it('discards all drafts silently (no modal) when nothing is modified', async () => {
      const { modals } = await import('@mantine/modals')
      const sameValue = { title: 'Same' }
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: sameValue })
        result.current.setDrafts({ abc123def456: sameValue })
      })

      expect(result.current.modifiedCount).toBe(0)

      act(() => {
        result.current.handleDiscardDrafts()
      })

      expect(modals.openConfirmModal).not.toHaveBeenCalled()
      expect(result.current.drafts).toEqual({})
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

  describe('pre-save schema validation (ED-H1)', () => {
    const validatedEntry: EditorEntry = {
      ...mockEntry,
      schema: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'blocks',
          type: 'block',
          templates: [
            { name: 'quote', fields: [{ name: 'text', type: 'string', required: true }] },
          ],
        },
      ],
    }
    const validatedOptions = { ...defaultOptions, currentEntry: validatedEntry }

    it('blocks the save and surfaces per-field errors for an invalid draft', async () => {
      const { result } = renderHook(() => useDraftManager(validatedOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).not.toHaveBeenCalled()
      expect(mockSetBusy).not.toHaveBeenCalled()
      expect(result.current.fieldErrors).toEqual({ title: 'This field is required' })
      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red', title: 'Cannot save yet' }),
      )
    })

    it('blocks the save on block-nested errors (D1 traversal + D4 rules)', async () => {
      const { result } = renderHook(() => useDraftManager(validatedOptions))

      act(() => {
        result.current.setDrafts({
          abc123def456: {
            title: 'ok',
            body: 'Content',
            blocks: [{ template: 'quote', value: { text: '' } }],
          },
        })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).not.toHaveBeenCalled()
      expect(result.current.fieldErrors).toEqual({
        'blocks[0].text': 'This field is required',
      })
    })

    it('saves a valid draft and keeps fieldErrors empty', async () => {
      const { result } = renderHook(() => useDraftManager(validatedOptions))

      act(() => {
        result.current.setDrafts({
          abc123def456: {
            title: 'Hello',
            body: 'Content',
            blocks: [{ template: 'quote', value: { text: 'quoted' } }],
          },
        })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).toHaveBeenCalled()
      expect(result.current.fieldErrors).toEqual({})
    })

    it('clears field errors as the user fixes the draft', async () => {
      const { result } = renderHook(() => useDraftManager(validatedOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })
      expect(result.current.fieldErrors).toEqual({ title: 'This field is required' })

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Fixed', body: 'Content' } })
      })
      await waitFor(() => {
        expect(result.current.fieldErrors).toEqual({})
      })
    })

    it('maps server 422 fieldErrors into the form (server-only checks)', async () => {
      // Client-side rules pass, but the server rejects (e.g. dangling reference —
      // existence is only checkable server-side).
      mockSaveEntry.mockRejectedValueOnce(
        new SaveApiError(422, 'author: Referenced entry does not exist', [
          { fieldPath: 'author', message: 'Referenced entry does not exist' },
        ]),
      )
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { result } = renderHook(() => useDraftManager(validatedOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Hello', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(result.current.fieldErrors).toEqual({
        author: 'Referenced entry does not exist',
      })
      consoleErrorSpy.mockRestore()
    })

    it('clears fieldErrors immediately when switching to a different entry (no stale flash)', async () => {
      const entryB: EditorEntry = {
        ...validatedEntry,
        path: unsafeAsLogicalPath('entry2'),
        contentId: unsafeAsContentId('xyz789uvw123'),
        label: 'Entry B',
      }
      const { result, rerender } = renderHook((props) => useDraftManager(props), {
        initialProps: validatedOptions,
      })

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })
      expect(result.current.fieldErrors).toEqual({ title: 'This field is required' })

      // Switching the selected entry (as Editor does when the user picks a
      // different entry in the nav) must not render even once with entry A's
      // errors against entry B's now-reset preview.
      rerender({ ...validatedOptions, currentEntry: entryB, selectedPath: 'entry2' })

      expect(result.current.fieldErrors).toEqual({})
    })

    it('recomputes fieldErrors when the schema changes for the same entry, without another save', async () => {
      const { result, rerender } = renderHook((props) => useDraftManager(props), {
        initialProps: validatedOptions,
      })

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })
      expect(result.current.fieldErrors).toEqual({ title: 'This field is required' })
      expect(mockSaveEntry).not.toHaveBeenCalled()

      // Same entry id, but the title field is no longer required.
      const relaxedEntry: EditorEntry = {
        ...validatedEntry,
        schema: [{ name: 'title', type: 'string', required: false }, validatedEntry.schema[1]],
      }
      rerender({ ...validatedOptions, currentEntry: relaxedEntry })

      expect(result.current.fieldErrors).toEqual({})
      expect(mockSaveEntry).not.toHaveBeenCalled()
    })

    it('keeps the same fieldErrors object identity when the schema reference changes but is structurally equal', async () => {
      const { result, rerender } = renderHook((props) => useDraftManager(props), {
        initialProps: validatedOptions,
      })

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })
      const firstErrors = result.current.fieldErrors
      expect(firstErrors).toEqual({ title: 'This field is required' })

      // New array/object reference, same content — simulates useEntryManager's
      // `currentEntry` becoming a fresh object because `entriesState` was
      // replaced (its `currentEntry` is a `useMemo` over `entriesState.find`).
      const sameSchemaNewRef: EditorEntry = {
        ...validatedEntry,
        schema: [...validatedEntry.schema],
      }
      rerender({ ...validatedOptions, currentEntry: sameSchemaNewRef })

      expect(result.current.fieldErrors).toBe(firstErrors)
    })
  })

  it('never persists the previous branch drafts under the new branch storage key', () => {
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
    const { result, rerender } = renderHook((props) => useDraftManager(props), {
      initialProps: defaultOptions,
    })

    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Branch A draft' } })
    })

    act(() => {
      rerender({ ...defaultOptions, branchName: 'feature' })
    })

    const leakedWrites = setItemSpy.mock.calls.filter(
      ([key, value]) => key === 'canopycms:drafts:feature' && value.includes('Branch A draft'),
    )
    expect(leakedWrites).toHaveLength(0)
  })

  it('merges drafts from another tab without overwriting local edits', () => {
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Local draft' } })
    })

    act(() => {
      window.localStorage.setItem(
        'canopycms:drafts:main',
        JSON.stringify({
          abc123def456: { title: 'Other tab draft for same entry' },
          xyz789uvw123: { title: 'Other tab draft for different entry' },
        }),
      )
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'canopycms:drafts:main',
          newValue: window.localStorage.getItem('canopycms:drafts:main'),
        }),
      )
    })

    expect(result.current.drafts.abc123def456).toEqual({ title: 'Local draft' })
    expect(result.current.drafts.xyz789uvw123).toEqual({
      title: 'Other tab draft for different entry',
    })
  })
})
