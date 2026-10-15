import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { NotificationData } from '@mantine/notifications'
import {
  ENTRY_DELETED_MESSAGE,
  ENTRY_GONE_UNCHECKED_MESSAGE,
  ENTRY_RENAMED_MESSAGE,
  RECREATE_TAKEN_MESSAGE,
  RECREATE_TIMED_OUT_MESSAGE,
  RECREATED_NOT_LISTED_MESSAGE,
  SAVE_MAY_HAVE_LANDED_MESSAGE,
  SAVE_TIMED_OUT_MESSAGE,
  useDraftManager,
} from './useDraftManager'
import type { RetryToastMessageProps } from '../components/RetryToastMessage'
import { ApiTimeoutError } from '../../api/request-deadline'
import { ENTRY_CHANGED_MESSAGE, ENTRY_GONE_MESSAGE } from '../../api/entries-constants'
import { UnansweredError } from '../unanswered'
import { EntrySchemaUnavailableError, SaveApiError } from './useEntryManager'
import type { EditorEntry } from '../Editor'
import type { EntrySchema } from '../../config'
import { withItemKeys } from '../../item-keys'
import type { FormValue } from '../FormRenderer'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../../paths/test-utils'

// Mock notifications
vi.mock('@mantine/notifications', () => ({
  notifications: {
    show: vi.fn(),
    hide: vi.fn(),
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

/**
 * Read the persisted draft map, tolerating BOTH the legacy bare
 * `Record<contentId, FormValue>` shape and the current `{ v, drafts,
 * baseVersions }` envelope -- assertions are about which entries have drafts,
 * not about the serialization format.
 */
const readPersistedDrafts = (branch: string): Record<string, unknown> => {
  const raw = window.localStorage.getItem(`canopycms:drafts:${branch}`)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'drafts' in parsed) {
    return (parsed as { drafts: Record<string, unknown> }).drafts
  }
  return parsed as Record<string, unknown>
}

const readPersistedBaseVersions = (branch: string): Record<string, number | null> => {
  const raw = window.localStorage.getItem(`canopycms:drafts:${branch}`)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'baseVersions' in parsed) {
    return (parsed as { baseVersions: Record<string, number | null> }).baseVersions
  }
  return {}
}

describe('useDraftManager', () => {
  const mockEntry: EditorEntry = {
    path: unsafeAsLogicalPath('entry1'),
    contentId: unsafeAsContentId('abc123def456'), // 12-char content ID
    label: 'Test Entry',
    collectionPath: unsafeAsLogicalPath('posts'),
    collectionName: 'posts',
    slug: 'test',
    type: 'entry',
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
    const entries = ['xyz789uvw123', 'mno456pqr789'].map((id, i) => ({
      ...mockEntry,
      path: unsafeAsLogicalPath(`other${i}`),
      contentId: unsafeAsContentId(id),
      label: `Other ${i}`,
    }))
    const { result } = renderHook(() =>
      useDraftManager({ ...defaultOptions, entries: [mockEntry, ...entries] }),
    )

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

    expect(readPersistedDrafts('main')).toEqual({
      abc123def456: { title: 'New Draft', body: 'Content' },
    })
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

  describe('save error notification copy', () => {
    // #189 wrote specific guard copy on the server (api/guards.ts) explaining
    // WHICH lock applies and how to recover -- e.g. "withdraw it to make
    // changes". Before this fix, the save catch block special-cased only 409
    // and 422 and collapsed everything else (including 403) to a generic
    // 'Save failed', which threw that copy away exactly when a locked-branch
    // save gets rejected -- including the brief window Change 1's
    // fail-closed default can still leave (client momentarily stale, server
    // is authoritative and correctly says no).
    it('surfaces the server message and a distinct title on a 403 (branch locked)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSaveEntry.mockRejectedValueOnce(
        new SaveApiError(
          403,
          'Branch "main" is submitted for review and cannot be edited. Withdraw it or request changes to resume editing.',
        ),
      )
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Save not allowed',
          message:
            'Branch "main" is submitted for review and cannot be edited. Withdraw it or request changes to resume editing.',
          color: 'red',
        }),
      )
      consoleErrorSpy.mockRestore()
    })

    it("shows the server's own message on a 409, untitled", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const busy =
        'This branch is busy syncing or saving another change, so your change was not saved. Try again in a moment.'
      mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, busy))
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({ message: busy, color: 'yellow' }),
      )
      const call = vi.mocked(notifications.show).mock.calls.at(-1)?.[0]
      expect(call).not.toHaveProperty('title')
      consoleErrorSpy.mockRestore()
    })

    it.each([undefined, ''])(
      'falls back to the version-mismatch copy on a 409 with no server message (%j)',
      async (serverMessage) => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, serverMessage))
        const { result } = renderHook(() => useDraftManager(defaultOptions))

        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await result.current.handleSave()
        })

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({
            message:
              'This entry changed since you opened it. Choose "Refresh from server" to see the latest version (your unsaved edits will be lost).',
            color: 'yellow',
          }),
        )
        consoleErrorSpy.mockRestore()
      },
    )

    describe('a save whose outcome is unknown (WRITE_OUTCOME_UNKNOWN)', () => {
      const mockGetEntryVersion = vi.fn<(contentId: string) => number | undefined>()
      const versionedOptions = { ...defaultOptions, getEntryVersion: mockGetEntryVersion }
      const landed =
        "We couldn't confirm your change was saved because the branch was syncing at the same time. Reload to check before saving again (your unsaved edits will be lost)."
      const toastId = 'canopy-save-may-have-landed:abc123def456'
      /** Render with a draft, then make one save that comes back outcome-unknown. */
      const renderAfterUnknownOutcome = async (serverMessage: string | undefined = landed) => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(
          new SaveApiError(409, serverMessage, undefined, 'WRITE_OUTCOME_UNKNOWN'),
        )
        const hook = renderHook((props) => useDraftManager(props), {
          initialProps: versionedOptions,
        })
        act(() => {
          hook.result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await hook.result.current.handleSave()
        })
        return hook
      }

      let consoleErrorSpy: ReturnType<typeof vi.spyOn>
      beforeEach(() => {
        mockGetEntryVersion.mockReset()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      })
      afterEach(() => {
        consoleErrorSpy.mockRestore()
      })

      it("shows the server's message in a sticky toast, then holds a re-save that would send the same version", async () => {
        const { result } = await renderAfterUnknownOutcome()
        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({
            id: toastId,
            message: landed,
            color: 'yellow',
            autoClose: false,
          }),
        )
        expect(notifications.hide).toHaveBeenCalledWith(toastId)

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).toHaveBeenCalledTimes(1)
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          id: toastId,
          message: SAVE_MAY_HAVE_LANDED_MESSAGE,
          color: 'yellow',
          autoClose: false,
        })
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
      })

      it('replaces the toast rather than stacking a second one when the held save is refused again', async () => {
        const { result } = await renderAfterUnknownOutcome()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleSave()
        })

        expect(notifications.hide).toHaveBeenCalledWith(toastId)
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({ id: toastId })
      })

      it('falls back to the generic message when the server gave none', async () => {
        await renderAfterUnknownOutcome('')

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          id: toastId,
          message: SAVE_MAY_HAVE_LANDED_MESSAGE,
          color: 'yellow',
          autoClose: false,
        })
      })

      it('takes the toast down when the entry is reloaded over the unsaved draft', async () => {
        const { result } = await renderAfterUnknownOutcome()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleReload()
        })

        expect(notifications.hide).toHaveBeenCalledWith(toastId)
      })

      it('takes the toast down when the entry is reloaded with nothing unsaved', async () => {
        const { result } = await renderAfterUnknownOutcome()
        act(() => result.current.handleDiscardDrafts())
        const { notifications } = await import('@mantine/notifications')
        const { modals } = await import('@mantine/modals')
        vi.mocked(notifications.hide).mockClear()
        vi.mocked(modals.openConfirmModal).mockClear()

        await act(async () => {
          await result.current.handleReload()
        })

        expect(modals.openConfirmModal).not.toHaveBeenCalled()
        expect(notifications.hide).toHaveBeenCalledWith(toastId)
      })

      it('takes the toast down for every held entry on switching branch', async () => {
        const otherEntry: EditorEntry = {
          ...mockEntry,
          path: unsafeAsLogicalPath('entry2'),
          contentId: unsafeAsContentId('def456abc123'),
        }
        const { result, rerender } = await renderAfterUnknownOutcome()
        rerender({ ...versionedOptions, currentEntry: otherEntry, selectedPath: 'entry2' })
        act(() => {
          result.current.setDrafts({ def456abc123: { title: 'Other draft' } })
        })
        mockSaveEntry.mockRejectedValueOnce(
          new SaveApiError(409, landed, undefined, 'WRITE_OUTCOME_UNKNOWN'),
        )
        await act(async () => {
          await result.current.handleSave()
        })
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        rerender({ ...versionedOptions, currentEntry: otherEntry, branchName: 'feature' })

        expect(notifications.hide).toHaveBeenCalledWith(toastId)
        expect(notifications.hide).toHaveBeenCalledWith('canopy-save-may-have-landed:def456abc123')
      })

      it('stops holding once the entry was re-read, leaving the draft to the stale-base check', async () => {
        const { result } = await renderAfterUnknownOutcome()
        mockGetEntryVersion.mockReturnValue(200)
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleSave()
        })

        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message:
            'This entry changed since you opened it. Choose "Refresh from server" to see the latest version (your unsaved edits will be lost).',
        })
        expect(mockSaveEntry).toHaveBeenCalledTimes(1)
        expect(notifications.hide).toHaveBeenCalledWith('canopy-save-may-have-landed:abc123def456')
      })

      it('lets the save through after Reload, even if the version did not move', async () => {
        const { result } = await renderAfterUnknownOutcome()
        await act(async () => {
          await result.current.handleReload()
        })
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Edited after reload' } })
        })

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).toHaveBeenCalledTimes(2)
      })
    })

    describe('a save refused because the entry is gone (ENTRY_GONE)', () => {
      const mockGetEntryVersion = vi.fn<(contentId: string) => number | undefined>()
      const mockFollowMovedEntry = vi.fn<(entry: EditorEntry) => Promise<EditorEntry | undefined>>()
      const mockRecreateEntry =
        vi.fn<(entry: EditorEntry, value: FormValue) => Promise<EditorEntry | undefined>>()
      const versionedOptions = {
        ...defaultOptions,
        getEntryVersion: mockGetEntryVersion,
        followMovedEntry: mockFollowMovedEntry,
        recreateEntry: mockRecreateEntry,
      }
      const goneToastId = 'canopy-entry-gone:abc123def456'
      const timedOutToastId = 'canopy-save-timed-out:abc123def456'
      const goneError = () => new SaveApiError(409, ENTRY_GONE_MESSAGE, undefined, 'ENTRY_GONE')
      const movedEntry: EditorEntry = { ...mockEntry, path: unsafeAsLogicalPath('entry1-renamed') }

      /** The "Save as new entry" toast's body, which is a RetryToastMessage element. */
      const goneToastBody = (toast: NotificationData | undefined) =>
        (toast?.message as ReactElement<RetryToastMessageProps>).props

      /** The gone toast most recently shown. */
      const lastGoneToast = async () => {
        const { notifications } = await import('@mantine/notifications')
        const toast = vi
          .mocked(notifications.show)
          .mock.calls.map(([n]) => n)
          .filter((n) => n.id === goneToastId)
          .at(-1)
        expect(toast).toBeDefined()
        return toast
      }

      /** Render with a draft, then make one save that is refused as gone. */
      const renderAfterGone = async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(goneError())
        const hook = renderHook((props) => useDraftManager(props), {
          initialProps: versionedOptions,
        })
        act(() => {
          hook.result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await hook.result.current.handleSave()
        })
        return hook
      }

      /** Click "Save as new entry" on the toast; resolves once the create has ended. */
      const clickSaveAsNewEntry = async () => {
        const body = goneToastBody(await lastGoneToast())
        mockSetBusy.mockClear()
        await act(async () => {
          body.onRetry()
        })
        await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))
      }

      /** A promise settled by hand, to hold a call in flight while the test acts. */
      const deferred = <T>() => {
        let resolve!: (value: T) => void
        let reject!: (reason: unknown) => void
        const promise = new Promise<T>((res, rej) => {
          resolve = res
          reject = rej
        })
        return { promise, resolve, reject }
      }

      let consoleErrorSpy: ReturnType<typeof vi.spyOn>
      beforeEach(() => {
        mockGetEntryVersion.mockReset()
        mockFollowMovedEntry.mockReset()
        mockFollowMovedEntry.mockResolvedValue(undefined)
        mockRecreateEntry.mockReset()
        mockRecreateEntry.mockResolvedValue(undefined)
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      })
      afterEach(() => {
        consoleErrorSpy.mockRestore()
      })

      it('says the entry was not saved in a sticky toast offering "Save as new entry", and keeps the draft', async () => {
        const { result } = await renderAfterGone()

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({
            id: goneToastId,
            title: '"Test Entry" not saved',
            color: 'yellow',
            autoClose: false,
            withCloseButton: true,
          }),
        )
        expect(goneToastBody(await lastGoneToast())).toMatchObject({
          message: ENTRY_DELETED_MESSAGE,
          actionLabel: 'Save as new entry',
          onRetry: expect.any(Function),
        })
        const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
        expect(shownMessages).not.toContain('Saved')
        expect(shownMessages).not.toContain(ENTRY_CHANGED_MESSAGE)
        expect(shownMessages).not.toContain(SAVE_MAY_HAVE_LANDED_MESSAGE)
        expect(mockFollowMovedEntry).toHaveBeenCalledWith(mockEntry)
        expect(mockRecreateEntry).not.toHaveBeenCalled()
        expect(mockSetBusy).toHaveBeenLastCalledWith(false)
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
      })

      it('does not hold the entry for a reload: the next save sends a request again', async () => {
        const { result } = await renderAfterGone()
        expect(mockSaveEntry).toHaveBeenCalledTimes(1)

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).toHaveBeenCalledTimes(2)
        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message: 'Saved',
        })
      })

      it('takes the timed-out warning down when the retry of an unanswered save finds the entry gone', async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(
          new ApiTimeoutError('PUT', '/main/content/posts/a', 75_000),
        )
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await result.current.handleSave()
        })
        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ id: timedOutToastId, message: SAVE_TIMED_OUT_MESSAGE }),
        )
        expect(notifications.hide).not.toHaveBeenCalledWith(timedOutToastId)
        mockSaveEntry.mockRejectedValueOnce(goneError())

        await act(async () => {
          await result.current.handleSave()
        })

        expect(notifications.hide).toHaveBeenCalledWith(timedOutToastId)
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          id: goneToastId,
        })
        expect(goneToastBody(await lastGoneToast()).message).toBe(ENTRY_DELETED_MESSAGE)
        const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
        expect(shownMessages).not.toContain(SAVE_MAY_HAVE_LANDED_MESSAGE)
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
      })

      it('hides the toast before showing it again when a second save is refused too', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()
        vi.mocked(notifications.show).mockClear()
        mockSaveEntry.mockRejectedValueOnce(goneError())

        await act(async () => {
          await result.current.handleSave()
        })

        const hideIndex = vi
          .mocked(notifications.hide)
          .mock.calls.findIndex(([id]) => id === goneToastId)
        const showIndex = vi
          .mocked(notifications.show)
          .mock.calls.findIndex(([n]) => n.id === goneToastId)
        expect(hideIndex).toBeGreaterThanOrEqual(0)
        expect(showIndex).toBeGreaterThanOrEqual(0)
        expect(vi.mocked(notifications.hide).mock.invocationCallOrder[hideIndex]).toBeLessThan(
          vi.mocked(notifications.show).mock.invocationCallOrder[showIndex],
        )
      })

      describe('when the entry was renamed', () => {
        it('opens it under its new name, explains the save did not happen, and offers no create', async () => {
          mockFollowMovedEntry.mockResolvedValue(movedEntry)

          const { result } = await renderAfterGone()

          const { notifications } = await import('@mantine/notifications')
          expect(mockFollowMovedEntry).toHaveBeenCalledTimes(1)
          expect(mockFollowMovedEntry).toHaveBeenCalledWith(mockEntry)
          const renamed = vi
            .mocked(notifications.show)
            .mock.calls.map(([n]) => n)
            .find((n) => n.message === ENTRY_RENAMED_MESSAGE)
          expect(renamed).toMatchObject({
            title: '"Test Entry" not saved',
            message: ENTRY_RENAMED_MESSAGE,
            color: 'yellow',
            withCloseButton: true,
          })
          expect(renamed?.autoClose).toEqual(expect.any(Number))
          expect(renamed).not.toHaveProperty('id', goneToastId)
          expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: goneToastId }),
          )
          expect(mockSetBusy).toHaveBeenLastCalledWith(false)
          // The draft is keyed by content ID, which the rename kept.
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it('takes down a "Save as new entry" toast from an earlier refusal', async () => {
          const { result } = await renderAfterGone()
          const { notifications } = await import('@mantine/notifications')
          expect(goneToastBody(await lastGoneToast()).message).toBe(ENTRY_DELETED_MESSAGE)
          vi.mocked(notifications.hide).mockClear()
          mockFollowMovedEntry.mockResolvedValue(movedEntry)
          mockSaveEntry.mockRejectedValueOnce(goneError())

          await act(async () => {
            await result.current.handleSave()
          })

          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: ENTRY_RENAMED_MESSAGE,
          })
          expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
        })
      })

      it('says it could not check, and offers no create, when looking for the entry fails', async () => {
        mockFollowMovedEntry.mockRejectedValue(new Error('list failed'))

        const { result } = await renderAfterGone()

        const { notifications } = await import('@mantine/notifications')
        expect(mockFollowMovedEntry).toHaveBeenCalledTimes(1)
        // A plain string: a create could duplicate an entry that was in fact renamed.
        expect(await lastGoneToast()).toMatchObject({
          message: ENTRY_GONE_UNCHECKED_MESSAGE,
          color: 'yellow',
          autoClose: false,
        })
        const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
        expect(shownMessages).not.toContain(ENTRY_RENAMED_MESSAGE)
        expect(mockSetBusy).toHaveBeenLastCalledWith(false)
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
      })

      describe('when the branch changes while looking for a rename', () => {
        it.each([
          ['finds nothing', undefined],
          ['finds the renamed entry', movedEntry],
        ])('shows no toast of either kind when the look-up %s', async (_name, found) => {
          const lookup = deferred<EditorEntry | undefined>()
          mockFollowMovedEntry.mockReturnValue(lookup.promise)
          mockGetEntryVersion.mockReturnValue(100)
          mockSaveEntry.mockRejectedValueOnce(goneError())
          const { result, rerender } = renderHook((props) => useDraftManager(props), {
            initialProps: versionedOptions,
          })
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Draft' } })
          })
          let saving: Promise<void> = Promise.resolve()
          await act(async () => {
            saving = result.current.handleSave()
          })
          // The save is parked on the look-up, so the toast decision is still to come.
          expect(mockFollowMovedEntry).toHaveBeenCalledTimes(1)
          rerender({ ...versionedOptions, branchName: 'feature' })
          const { notifications } = await import('@mantine/notifications')
          vi.mocked(notifications.show).mockClear()

          await act(async () => {
            lookup.resolve(found)
            await saving
          })

          const shownIds = vi.mocked(notifications.show).mock.calls.map(([n]) => n.id)
          const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
          expect(shownIds).not.toContain(goneToastId)
          expect(shownMessages).not.toContain(ENTRY_RENAMED_MESSAGE)
          expect(mockSetBusy).toHaveBeenLastCalledWith(false)
        })
      })

      describe('"Save as new entry"', () => {
        it("creates the entry from the draft as it is now, then drops the draft and says it's saved", async () => {
          const created: EditorEntry = {
            ...mockEntry,
            contentId: unsafeAsContentId('new789new789'),
          }
          mockRecreateEntry.mockResolvedValue(created)
          const { result } = await renderAfterGone()
          // An edit made after the refusal is in the new entry too.
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Edited after the refusal' } })
          })
          const { notifications } = await import('@mantine/notifications')
          vi.mocked(notifications.hide).mockClear()

          await clickSaveAsNewEntry()

          expect(mockRecreateEntry).toHaveBeenCalledTimes(1)
          expect(mockRecreateEntry).toHaveBeenCalledWith(mockEntry, {
            title: 'Edited after the refusal',
          })
          expect(mockSetBusy.mock.calls).toEqual([[true], [false]])
          expect(result.current.drafts).not.toHaveProperty('abc123def456')
          expect(readPersistedDrafts('main')).not.toHaveProperty('abc123def456')
          expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: 'Saved as a new entry',
            color: 'green',
          })
        })

        it('uses the loaded value when the entry has no draft', async () => {
          mockGetEntryVersion.mockReturnValue(100)
          mockSaveEntry.mockRejectedValueOnce(goneError())
          const { result } = renderHook(() => useDraftManager(versionedOptions))
          act(() => {
            result.current.setLoadedValues({ abc123def456: { title: 'Loaded' } })
            result.current.setDrafts({ abc123def456: { title: 'Draft' } })
          })
          await act(async () => {
            await result.current.handleSave()
          })
          act(() => {
            result.current.setDrafts({})
          })

          await clickSaveAsNewEntry()

          expect(mockRecreateEntry).toHaveBeenCalledWith(mockEntry, { title: 'Loaded' })
        })

        it('offers itself again, with the path taken, when another entry now holds the path', async () => {
          mockRecreateEntry.mockRejectedValue(new SaveApiError(409, 'taken'))
          const { result } = await renderAfterGone()
          const { notifications } = await import('@mantine/notifications')

          await clickSaveAsNewEntry()

          const goneToasts = vi
            .mocked(notifications.show)
            .mock.calls.filter(([n]) => n.id === goneToastId)
          expect(goneToasts).toHaveLength(2)
          const toast = await lastGoneToast()
          expect(toast).toMatchObject({ color: 'yellow', autoClose: false })
          expect(goneToastBody(toast)).toMatchObject({
            message: RECREATE_TAKEN_MESSAGE,
            actionLabel: 'Save as new entry',
          })
          const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
          expect(shownMessages).not.toContain('Saved as a new entry')
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it('says it may have gone through when the server did not answer, and keeps the draft', async () => {
          mockRecreateEntry.mockRejectedValue(new UnansweredError())
          const { result } = await renderAfterGone()

          await clickSaveAsNewEntry()

          expect(goneToastBody(await lastGoneToast())).toMatchObject({
            message: RECREATE_TIMED_OUT_MESSAGE,
            actionLabel: 'Save as new entry',
          })
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it("says it was not saved, with the server's reason, on any other refusal", async () => {
          mockRecreateEntry.mockRejectedValue(new SaveApiError(422, 'x'))
          const { result } = await renderAfterGone()

          await clickSaveAsNewEntry()

          const body = goneToastBody(await lastGoneToast())
          expect(body.message).toBe('It was not saved as a new entry: x')
          expect(body.actionLabel).toBe('Save as new entry')
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it('says it was not saved when the failure has no server reason', async () => {
          mockRecreateEntry.mockRejectedValue(new Error('boom'))
          const { result } = await renderAfterGone()

          await clickSaveAsNewEntry()

          const body = goneToastBody(await lastGoneToast())
          expect(body.message).toMatch(/^It was not saved as a new entry/)
          expect(body.message).not.toContain('boom')
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it("does nothing on a click after a branch switch: the drafts in hand are another branch's", async () => {
          const { result, rerender } = await renderAfterGone()
          const body = goneToastBody(await lastGoneToast())
          rerender({ ...versionedOptions, branchName: 'feature' })
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Feature draft' } })
          })
          const { notifications } = await import('@mantine/notifications')
          vi.mocked(notifications.hide).mockClear()
          vi.mocked(notifications.show).mockClear()

          await act(async () => {
            body.onRetry()
          })

          expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
          expect(mockRecreateEntry).not.toHaveBeenCalled()
          expect(vi.mocked(notifications.show)).not.toHaveBeenCalled()
          expect(result.current.drafts).toEqual({ abc123def456: { title: 'Feature draft' } })
        })

        describe('when the branch changes while the create is in flight', () => {
          const created: EditorEntry = {
            ...mockEntry,
            contentId: unsafeAsContentId('new789new789'),
          }

          /** Starts the create, switches branch, and gives the new branch a draft under the same ID. */
          const switchDuringCreate = async (
            create: ReturnType<typeof deferred<EditorEntry | undefined>>,
          ) => {
            mockRecreateEntry.mockReturnValue(create.promise)
            const { result, rerender } = await renderAfterGone()
            const body = goneToastBody(await lastGoneToast())
            await act(async () => {
              body.onRetry()
            })
            expect(mockRecreateEntry).toHaveBeenCalledTimes(1)
            rerender({ ...versionedOptions, branchName: 'feature' })
            act(() => {
              result.current.setDrafts({ abc123def456: { title: 'Feature draft' } })
            })
            const { notifications } = await import('@mantine/notifications')
            vi.mocked(notifications.show).mockClear()
            mockSetBusy.mockClear()
            return { result, notifications }
          }

          it('leaves the new branch drafts and toasts alone when it then succeeds', async () => {
            const create = deferred<EditorEntry | undefined>()
            const { result, notifications } = await switchDuringCreate(create)

            await act(async () => {
              create.resolve(created)
            })
            await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))

            expect(result.current.drafts).toEqual({ abc123def456: { title: 'Feature draft' } })
            expect(vi.mocked(notifications.show)).not.toHaveBeenCalled()
          })

          it('shows no failure toast for the old branch when it then fails', async () => {
            const create = deferred<EditorEntry | undefined>()
            const { result, notifications } = await switchDuringCreate(create)

            await act(async () => {
              create.reject(new SaveApiError(409, 'taken'))
            })
            await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))

            expect(result.current.drafts).toEqual({ abc123def456: { title: 'Feature draft' } })
            expect(vi.mocked(notifications.show)).not.toHaveBeenCalled()
          })
        })

        it('sends one create for two activations, and accepts another once it has ended', async () => {
          const create = deferred<EditorEntry | undefined>()
          mockRecreateEntry.mockReturnValueOnce(create.promise)
          await renderAfterGone()
          const body = goneToastBody(await lastGoneToast())

          await act(async () => {
            body.onRetry()
            body.onRetry()
          })

          expect(mockRecreateEntry).toHaveBeenCalledTimes(1)
          mockSetBusy.mockClear()
          mockRecreateEntry.mockRejectedValueOnce(new SaveApiError(409, 'taken'))
          await act(async () => {
            create.reject(new SaveApiError(409, 'taken'))
          })
          await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))
          // The failure put the offer back; taking it is a new create.
          await clickSaveAsNewEntry()
          expect(mockRecreateEntry).toHaveBeenCalledTimes(2)
        })

        it('sends a create for the same content ID on another branch while one is in flight on the first', async () => {
          const create = deferred<EditorEntry | undefined>()
          mockRecreateEntry.mockReturnValueOnce(create.promise)
          const { result, rerender } = await renderAfterGone()
          const firstBody = goneToastBody(await lastGoneToast())
          await act(async () => {
            firstBody.onRetry()
          })
          expect(mockRecreateEntry).toHaveBeenCalledTimes(1)

          // The same content ID is refused as gone on branch `feature`, while main's create is held.
          rerender({ ...versionedOptions, branchName: 'feature' })
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Feature draft' } })
          })
          mockSaveEntry.mockRejectedValueOnce(goneError())
          await act(async () => {
            await result.current.handleSave()
          })
          const featureBody = goneToastBody(await lastGoneToast())
          await act(async () => {
            featureBody.onRetry()
          })

          expect(mockRecreateEntry).toHaveBeenCalledTimes(2)
          expect(mockRecreateEntry.mock.calls[1]).toEqual([mockEntry, { title: 'Feature draft' }])

          await act(async () => {
            create.resolve(undefined)
          })
          await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))
        })

        describe('a draft edited while the create is in flight', () => {
          const created: EditorEntry = {
            ...mockEntry,
            contentId: unsafeAsContentId('new789new789'),
          }

          it('moves to the new entry instead of being dropped', async () => {
            const create = deferred<EditorEntry | undefined>()
            mockRecreateEntry.mockReturnValue(create.promise)
            const { result } = await renderAfterGone()
            const body = goneToastBody(await lastGoneToast())
            await act(async () => {
              body.onRetry()
            })
            act(() => {
              result.current.setDrafts({ abc123def456: { title: 'Edited mid-flight' } })
            })
            mockSetBusy.mockClear()

            await act(async () => {
              create.resolve(created)
            })
            await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))

            expect(result.current.drafts).toEqual({ new789new789: { title: 'Edited mid-flight' } })
          })

          it('is absent, with nothing under the new ID, when there was no edit', async () => {
            const create = deferred<EditorEntry | undefined>()
            mockRecreateEntry.mockReturnValue(create.promise)
            const { result } = await renderAfterGone()
            const body = goneToastBody(await lastGoneToast())
            await act(async () => {
              body.onRetry()
            })
            expect(result.current.drafts).toEqual({ abc123def456: { title: 'Draft' } })
            mockSetBusy.mockClear()

            await act(async () => {
              create.resolve(created)
            })
            await waitFor(() => expect(mockSetBusy).toHaveBeenLastCalledWith(false))

            expect(result.current.drafts).toEqual({})
          })
        })

        it('keeps the draft and says the entry will open later when the list does not show it yet', async () => {
          mockRecreateEntry.mockResolvedValue(undefined)
          const { result } = await renderAfterGone()
          const { notifications } = await import('@mantine/notifications')

          await clickSaveAsNewEntry()

          expect(mockRecreateEntry).toHaveBeenCalledTimes(1)
          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: RECREATED_NOT_LISTED_MESSAGE,
            color: 'green',
          })
          const shownMessages = vi.mocked(notifications.show).mock.calls.map(([n]) => n.message)
          expect(shownMessages).not.toContain('Saved as a new entry')
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })
      })

      it('takes the toast down when a later save of that entry lands', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleSave()
        })

        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message: 'Saved',
        })
        expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
      })

      it('hides no entry-gone toast for a save of an entry that never had one', async () => {
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })

        await act(async () => {
          await result.current.handleSave()
        })

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message: 'Saved',
        })
        expect(notifications.hide).not.toHaveBeenCalledWith(goneToastId)
      })

      it('takes the toast down on discarding that entry alone', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        act(() => result.current.handleDiscardFileDraft())

        expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
        expect(result.current.drafts).not.toHaveProperty('abc123def456')
      })

      it('takes the toast down when the entry is reloaded', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        await act(async () => {
          await result.current.handleReload()
        })

        expect(mockLoadEntry).toHaveBeenCalledWith(mockEntry)
        expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
      })

      it('leaves the toast up when the reload fails', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()
        mockLoadEntry.mockRejectedValueOnce(new Error('Load failed'))

        await act(async () => {
          await result.current.handleReload()
        })

        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message: "Couldn't refresh from the server. Your changes are still here; try again.",
        })
        expect(notifications.hide).not.toHaveBeenCalledWith(goneToastId)
      })

      it('takes the toast down on switching branch, where the same entry id is another file', async () => {
        const { rerender } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        rerender({ ...versionedOptions, branchName: 'feature' })

        expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
      })

      it('takes the toast down on discarding all drafts', async () => {
        const { result } = await renderAfterGone()
        const { notifications } = await import('@mantine/notifications')
        vi.mocked(notifications.hide).mockClear()

        act(() => result.current.handleDiscardDrafts())

        expect(notifications.hide).toHaveBeenCalledWith(goneToastId)
      })
    })

    describe('a save that times out', () => {
      const mockGetEntryVersion = vi.fn<(contentId: string) => number | undefined>()
      const versionedOptions = { ...defaultOptions, getEntryVersion: mockGetEntryVersion }

      let consoleErrorSpy: ReturnType<typeof vi.spyOn>
      beforeEach(() => {
        mockGetEntryVersion.mockReset()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      })
      afterEach(() => {
        consoleErrorSpy.mockRestore()
      })

      it('ends the save, keeps the draft, says so until dismissed, and lets the next save go out', async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(
          new ApiTimeoutError('PUT', '/main/content/posts/a', 75_000),
        )
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await result.current.handleSave()
        })

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'No answer saving "Test Entry"',
            message: SAVE_TIMED_OUT_MESSAGE,
            color: 'yellow',
            autoClose: false,
          }),
        )
        expect(mockSetBusy).toHaveBeenLastCalledWith(false)
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })

        // The server's version check, not a forced reload, guards a save that did land.
        await act(async () => {
          await result.current.handleSave()
        })
        expect(mockSaveEntry).toHaveBeenCalledTimes(2)
        // The next save that lands takes the warning down.
        expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
          message: 'Saved',
        })
        expect(notifications.hide).toHaveBeenCalledWith('canopy-save-timed-out:abc123def456')
      })

      it("treats a gateway's 5xx page the same, and takes the warning down on discard", async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(new UnansweredError())
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await result.current.handleSave()
        })

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ message: SAVE_TIMED_OUT_MESSAGE, color: 'yellow' }),
        )
        act(() => result.current.handleDiscardDrafts())
        expect(notifications.hide).toHaveBeenCalledWith('canopy-save-timed-out:abc123def456')
      })

      /** Render with a draft, then make one save that times out. */
      const renderAfterTimeout = async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(
          new ApiTimeoutError('PUT', '/main/content/posts/a', 75_000),
        )
        const hook = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          hook.result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })
        await act(async () => {
          await hook.result.current.handleSave()
        })
        return hook
      }

      describe('then the retry is refused as a version conflict', () => {
        it('says the first save may have landed, and takes the timed-out warning down', async () => {
          const { result } = await renderAfterTimeout()
          const { notifications } = await import('@mantine/notifications')
          expect(notifications.hide).not.toHaveBeenCalled()
          mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, ENTRY_CHANGED_MESSAGE))

          await act(async () => {
            await result.current.handleSave()
          })

          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            id: 'canopy-save-may-have-landed:abc123def456',
            title: 'No answer saving "Test Entry"',
            message: SAVE_MAY_HAVE_LANDED_MESSAGE,
            color: 'yellow',
            autoClose: false,
          })
          expect(notifications.hide).toHaveBeenCalledWith('canopy-save-timed-out:abc123def456')
          expect(notifications.hide).toHaveBeenCalledWith(
            'canopy-save-may-have-landed:abc123def456',
          )
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
        })

        it('refuses further saves without a write until the entry was re-read', async () => {
          const { result } = await renderAfterTimeout()
          mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, ENTRY_CHANGED_MESSAGE))
          await act(async () => {
            await result.current.handleSave()
          })
          expect(mockSaveEntry).toHaveBeenCalledTimes(2)

          await act(async () => {
            await result.current.handleSave()
          })

          const { notifications } = await import('@mantine/notifications')
          expect(mockSaveEntry).toHaveBeenCalledTimes(2)
          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: SAVE_MAY_HAVE_LANDED_MESSAGE,
          })

          mockGetEntryVersion.mockReturnValue(200)
          await act(async () => {
            await result.current.handleSave()
          })
          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: ENTRY_CHANGED_MESSAGE,
          })
        })

        it('forgets a timed-out save on switching branch, where the same entry id is another file', async () => {
          mockGetEntryVersion.mockReturnValue(100)
          mockSaveEntry.mockRejectedValueOnce(
            new ApiTimeoutError('PUT', '/main/content/posts/a', 75_000),
          )
          const { result, rerender } = renderHook((props) => useDraftManager(props), {
            initialProps: versionedOptions,
          })
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Draft' } })
          })
          await act(async () => {
            await result.current.handleSave()
          })
          const { notifications } = await import('@mantine/notifications')
          expect(notifications.hide).not.toHaveBeenCalled()

          rerender({ ...versionedOptions, branchName: 'feature' })
          expect(notifications.hide).toHaveBeenCalledWith('canopy-save-timed-out:abc123def456')
          act(() => {
            result.current.setDrafts({ abc123def456: { title: 'Other branch' } })
          })
          mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, ENTRY_CHANGED_MESSAGE))
          await act(async () => {
            await result.current.handleSave()
          })

          expect(vi.mocked(notifications.show).mock.calls.at(-1)?.[0]).toMatchObject({
            message: ENTRY_CHANGED_MESSAGE,
          })
        })

        it('keeps the server message for a conflict that is not the entry having changed', async () => {
          const busy =
            'This branch is busy syncing or saving another change, so your change was not saved. Try again in a moment.'
          const { result } = await renderAfterTimeout()
          mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, busy))

          await act(async () => {
            await result.current.handleSave()
          })

          const { notifications } = await import('@mantine/notifications')
          expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
            expect.objectContaining({ message: busy }),
          )
          expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: SAVE_MAY_HAVE_LANDED_MESSAGE }),
          )
          expect(notifications.hide).not.toHaveBeenCalled()

          await act(async () => {
            await result.current.handleSave()
          })
          expect(mockSaveEntry).toHaveBeenCalledTimes(3)
        })
      })

      it('keeps saying the entry changed for a version conflict with no earlier timed-out save', async () => {
        mockGetEntryVersion.mockReturnValue(100)
        mockSaveEntry.mockRejectedValueOnce(new SaveApiError(409, ENTRY_CHANGED_MESSAGE))
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        act(() => {
          result.current.setDrafts({ abc123def456: { title: 'Draft' } })
        })

        await act(async () => {
          await result.current.handleSave()
        })
        await act(async () => {
          await result.current.handleSave()
        })

        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ message: ENTRY_CHANGED_MESSAGE, color: 'yellow' }),
        )
        expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: SAVE_MAY_HAVE_LANDED_MESSAGE }),
        )
        expect(mockSaveEntry).toHaveBeenCalledTimes(2)
      })
    })

    it('still shows the server validation message and "Save rejected" title on a 422, unaffected by the 403 branch', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSaveEntry.mockRejectedValueOnce(new SaveApiError(422, 'title: is required'))
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Save rejected',
          message: 'title: is required',
          color: 'red',
        }),
      )
      consoleErrorSpy.mockRestore()
    })

    it("shows the server's message when the save is refused as SCHEMA_UNAVAILABLE", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSaveEntry.mockRejectedValueOnce(
        new SaveApiError(503, 'not known yet', undefined, 'SCHEMA_UNAVAILABLE'),
      )
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Not saved yet', message: 'not known yet' }),
      )
      expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft' })
      consoleErrorSpy.mockRestore()
    })

    it('falls back to the generic "Save failed" for a non-SaveApiError failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSaveEntry.mockRejectedValueOnce(new Error('network exploded'))
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Save failed', color: 'red' }),
      )
      consoleErrorSpy.mockRestore()
    })
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
    // After discarding, localStorage is removed, but the persist effect will
    // write an empty store back next.
    expect(readPersistedDrafts('main')).toEqual({})
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

  it('shows no toast when an entry draft is discarded: the form and the unsaved indicator already show it', async () => {
    const { notifications } = await import('@mantine/notifications')
    vi.mocked(notifications.show).mockClear()
    const { result } = renderHook(() => useDraftManager(defaultOptions))
    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Draft 1' } })
    })

    act(() => {
      result.current.handleDiscardFileDraft()
    })

    expect(result.current.drafts).not.toHaveProperty('abc123def456')
    expect(notifications.show).not.toHaveBeenCalled()
  })

  it('toasts a discard when asked, for a draft the form is not showing', async () => {
    const { notifications } = await import('@mantine/notifications')
    vi.mocked(notifications.show).mockClear()
    const { result } = renderHook(() => useDraftManager(defaultOptions))
    act(() => {
      result.current.setDrafts({ abc123def456: { title: 'Draft 1' } })
    })

    act(() => {
      result.current.handleDiscardFileDraft(undefined, { announce: true })
    })

    expect(result.current.drafts).not.toHaveProperty('abc123def456')
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unsaved changes to "Test Entry" discarded' }),
    )
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
      const otherEntry: EditorEntry = {
        ...mockEntry,
        path: unsafeAsLogicalPath('entry2'),
        contentId: unsafeAsContentId('xyz789uvw123'),
        label: 'Other Entry',
      }
      const { result } = renderHook(() =>
        useDraftManager({ ...defaultOptions, entries: [mockEntry, otherEntry] }),
      )

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

    it('words the discard-all dialog by entries, and names its confirm button', async () => {
      const { modals } = await import('@mantine/modals')
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Original' } })
        result.current.setDrafts({ abc123def456: { title: 'Edited' } })
      })
      act(() => {
        result.current.handleDiscardDrafts()
      })

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Discard all changes',
          children: 'Discard unsaved changes for 1 entry? They will be lost.',
          labels: expect.objectContaining({ confirm: 'Discard all changes' }),
          confirmProps: expect.objectContaining({ 'data-testid': 'confirm-discard-all' }),
        }),
      )
    })

    it('words the single-entry discard dialog, and names its confirm button', async () => {
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
          title: 'Discard changes to "Test Entry"?',
          labels: expect.objectContaining({ confirm: 'Discard changes', cancel: 'Keep editing' }),
          confirmProps: expect.objectContaining({ 'data-testid': 'confirm-discard-entry' }),
        }),
      )
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
    // Reload no longer seeds a draft with the server value: `effectiveValue`
    // falls back to `loadedValues`, so the seed only ever manufactured a
    // phantom-dirty snapshot in localStorage.
    expect(result.current.drafts.abc123def456).toBeUndefined()
  })

  describe('reload confirmation (D5)', () => {
    // "Refresh from server" overwrites the working value with the server's copy, so it
    // is at least as destructive as "Discard draft" -- which has always been
    // behind a confirm. It is also the recovery path the 409 conflict toast
    // points at, so an unguarded reload destroys exactly the work the user was
    // told to protect.
    const dirtyDraft = { title: 'My unsaved edit', body: 'Loaded Content' }

    const makeDirty = async (result: { current: ReturnType<typeof useDraftManager> }) => {
      act(() => {
        result.current.setLoadedValues({
          abc123def456: { title: 'Loaded Title', body: 'Loaded Content' },
        })
      })
      act(() => {
        result.current.setDrafts({ abc123def456: dirtyDraft })
      })
      await waitFor(() => expect(result.current.isSelectedDirty()).toBe(true))
    }

    it('opens a confirm modal before reloading over a dirty draft', async () => {
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      await makeDirty(result)

      await act(async () => {
        await result.current.handleReload()
      })

      const { modals } = await import('@mantine/modals')
      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Refresh from server' }),
      )
      // Auto-confirmed by the modals mock, so the reload still went through and
      // the stale draft is gone (the loaded value is the working value again).
      await waitFor(() => {
        expect(result.current.drafts.abc123def456).toBeUndefined()
      })
      expect(result.current.loadedValues.abc123def456).toEqual({
        title: 'Loaded Title',
        body: 'Loaded Content',
      })
    })

    it('reloads without a confirm modal when the selected draft is clean', async () => {
      const { result } = renderHook(() => useDraftManager(defaultOptions))

      await act(async () => {
        await result.current.handleReload()
      })

      const { modals } = await import('@mantine/modals')
      expect(modals.openConfirmModal).not.toHaveBeenCalled()
      expect(mockLoadEntry).toHaveBeenCalledWith(mockEntry)
    })

    it('keeps the unsaved draft when the user cancels the reload confirmation', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce(
        (opts: { onCancel?: () => void }) => {
          opts.onCancel?.()
          return 'cancelled-modal-id'
        },
      )

      const { result } = renderHook(() => useDraftManager(defaultOptions))
      await makeDirty(result)
      mockLoadEntry.mockClear()

      await act(async () => {
        await result.current.handleReload()
      })

      expect(mockLoadEntry).not.toHaveBeenCalled()
      expect(result.current.drafts.abc123def456).toEqual(dirtyDraft)
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

  it('explains a reload refused as SCHEMA_UNAVAILABLE instead of reporting a failure', async () => {
    mockLoadEntry.mockRejectedValueOnce(new EntrySchemaUnavailableError('not known yet'))
    const { result } = renderHook(() => useDraftManager(defaultOptions))

    await act(async () => {
      await result.current.handleReload()
    })

    const { notifications } = await import('@mantine/notifications')
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Not available yet', message: 'not known yet' }),
    )
    expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Couldn't refresh from the server. Your changes are still here; try again.",
      }),
    )
    expect(mockSetBusy).toHaveBeenLastCalledWith(false)
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
      const onSaveBlocked = vi.fn()
      const { result } = renderHook(() => useDraftManager({ ...validatedOptions, onSaveBlocked }))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: '', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).not.toHaveBeenCalled()
      expect(mockSetBusy).not.toHaveBeenCalled()
      expect(result.current.fieldErrors).toEqual({ title: 'This field is required' })
      expect(onSaveBlocked).toHaveBeenCalledTimes(1)
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
      const onSaveBlocked = vi.fn()
      const { result } = renderHook(() => useDraftManager({ ...validatedOptions, onSaveBlocked }))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Hello', body: 'Content' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(result.current.fieldErrors).toEqual({
        author: 'Referenced entry does not exist',
      })
      expect(onSaveBlocked).toHaveBeenCalledTimes(1)
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

  describe('draft base versions (cross-session conflict detection)', () => {
    const mockGetEntryVersion = vi.fn<(contentId: string) => number | undefined>()
    const versionedOptions = { ...defaultOptions, getEntryVersion: mockGetEntryVersion }

    const persistV2 = (drafts: Record<string, unknown>, baseVersions: Record<string, number>) => {
      window.localStorage.setItem(
        'canopycms:drafts:main',
        JSON.stringify({ v: 2, drafts, baseVersions }),
      )
    }

    beforeEach(() => {
      mockGetEntryVersion.mockReset()
    })

    it('stamps a new draft with the version currently held for that entry, and persists it', () => {
      mockGetEntryVersion.mockReturnValue(100)
      const { result } = renderHook(() => useDraftManager(versionedOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'My edit' } })
      })

      expect(readPersistedBaseVersions('main')).toEqual({ abc123def456: 100 })
    })

    it('drops the base version again once the draft is saved', async () => {
      mockGetEntryVersion.mockReturnValue(100)
      const { result } = renderHook(() => useDraftManager(versionedOptions))

      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'My edit' } })
      })
      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).toHaveBeenCalled()
      await waitFor(() => {
        expect(readPersistedBaseVersions('main')).toEqual({})
      })
    })

    it('shows the conflict UI instead of saving when a restored draft is based on an older version', async () => {
      persistV2({ abc123def456: { title: 'Draft from last session' } }, { abc123def456: 100 })
      // The entry was re-read this session and captured a NEWER token -- the
      // exact situation the OCC token alone cannot catch, because the save
      // would send 200 and pass the server's check.
      mockGetEntryVersion.mockReturnValue(200)

      const { result } = renderHook(() => useDraftManager(versionedOptions))
      await waitFor(() =>
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft from last session' }),
      )

      await act(async () => {
        await result.current.handleSave()
      })

      const { notifications } = await import('@mantine/notifications')
      expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'This entry changed since you opened it. Choose "Refresh from server" to see the latest version (your unsaved edits will be lost).',
          color: 'yellow',
        }),
      )
      // Not saved -- and not silently discarded either.
      expect(mockSaveEntry).not.toHaveBeenCalled()
      expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft from last session' })
    })

    describe("a submit's stamps", () => {
      const id = 'abc123def456'
      const stamp = '2026-10-14T09:00:00.000Z'
      const stamped = [
        {
          contentId: unsafeAsContentId(id),
          fields: { publishedAt: stamp },
          previousVersion: 100,
          version: 150,
        },
      ]
      let tokens: Map<string, number>
      const stampOptions = () => ({
        ...versionedOptions,
        getEntryVersion: (contentId: string) => tokens.get(contentId),
        adoptEntryVersion: (contentId: string, version: number) => {
          tokens.set(contentId, version)
        },
      })

      beforeEach(() => {
        tokens = new Map([[id, 100]])
      })

      const renderWithDraft = async (draft: FormValue) => {
        const { result } = renderHook(() => useDraftManager(stampOptions()))
        act(() => {
          result.current.setLoadedValues({ [id]: { title: 'Loaded', publishedAt: '' } })
        })
        act(() => {
          result.current.setDrafts({ [id]: draft })
        })
        expect(readPersistedBaseVersions('main')).toEqual({ [id]: 100 })
        return result
      }

      it('fills an empty stamp field in the draft and the loaded value, and the save goes through on the new version', async () => {
        const result = await renderWithDraft({ title: 'Unsaved edit', publishedAt: '' })

        act(() => {
          result.current.applySubmitStamps(stamped)
        })

        expect(result.current.drafts[id]).toEqual({ title: 'Unsaved edit', publishedAt: stamp })
        expect(result.current.loadedValues[id]).toEqual({ title: 'Loaded', publishedAt: stamp })
        expect(tokens.get(id)).toBe(150)
        await waitFor(() => expect(readPersistedBaseVersions('main')).toEqual({ [id]: 150 }))
        await act(async () => {
          await result.current.handleSave()
        })
        expect(mockSaveEntry).toHaveBeenCalledWith(mockEntry, {
          title: 'Unsaved edit',
          publishedAt: stamp,
        })
      })

      it('keeps a date the editor typed into the draft', async () => {
        const typed = '2020-01-01T00:00:00.000Z'
        const result = await renderWithDraft({ title: 'Unsaved edit', publishedAt: typed })

        act(() => {
          result.current.applySubmitStamps(stamped)
        })

        expect(result.current.drafts[id]).toEqual({ title: 'Unsaved edit', publishedAt: typed })
        await waitFor(() => expect(readPersistedBaseVersions('main')).toEqual({ [id]: 150 }))
      })

      it('leaves a draft already behind the stamped version to the conflict check', async () => {
        const result = await renderWithDraft({ title: 'Unsaved edit', publishedAt: '' })

        act(() => {
          result.current.applySubmitStamps([{ ...stamped[0], previousVersion: 120 }])
        })

        expect(result.current.drafts[id]).toEqual({ title: 'Unsaved edit', publishedAt: '' })
        expect(tokens.get(id)).toBe(100)
        expect(readPersistedBaseVersions('main')).toEqual({ [id]: 100 })
      })

      it('moves the token but leaves a draft based on an older version to the stale check', async () => {
        persistV2({ [id]: { title: 'Last session', publishedAt: '' } }, { [id]: 90 })
        const { result } = renderHook(() => useDraftManager(stampOptions()))
        await waitFor(() => expect(result.current.drafts[id]).toBeDefined())

        act(() => {
          result.current.applySubmitStamps(stamped)
        })
        await act(async () => {
          await result.current.handleSave()
        })

        expect(tokens.get(id)).toBe(150)
        expect(result.current.drafts[id]).toEqual({ title: 'Last session', publishedAt: '' })
        expect(readPersistedBaseVersions('main')).toEqual({ [id]: 90 })
        expect(mockSaveEntry).not.toHaveBeenCalled()
        const { notifications } = await import('@mantine/notifications')
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringMatching(/changed since you opened/) }),
        )
      })

      it('moves the draft of an entry not loaded yet, which its later load then matches', async () => {
        tokens.clear()
        persistV2({ [id]: { title: 'Last session', publishedAt: '' } }, { [id]: 100 })
        const { result } = renderHook(() => useDraftManager(stampOptions()))
        await waitFor(() => expect(result.current.drafts[id]).toBeDefined())

        act(() => {
          result.current.applySubmitStamps(stamped)
        })

        expect(tokens.has(id)).toBe(false)
        expect(result.current.drafts[id]).toEqual({ title: 'Last session', publishedAt: stamp })
        await waitFor(() => expect(readPersistedBaseVersions('main')).toEqual({ [id]: 150 }))
        // The entry's first load this session reads the stamped version.
        tokens.set(id, 150)
        await act(async () => {
          await result.current.handleSave()
        })
        expect(mockSaveEntry).toHaveBeenCalledWith(mockEntry, {
          title: 'Last session',
          publishedAt: stamp,
        })
      })
    })

    describe('legacy draft with no recorded base version (pre-v2 storage)', () => {
      /** Pre-v2 storage format: a bare map, no base versions anywhere. */
      const persistLegacyDraft = () => {
        window.localStorage.setItem(
          'canopycms:drafts:main',
          JSON.stringify({ abc123def456: { title: 'Legacy draft' } }),
        )
        mockGetEntryVersion.mockReturnValue(200)
      }

      it('asks before overwriting rather than saving silently', async () => {
        const { modals } = await import('@mantine/modals')
        persistLegacyDraft()
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        await waitFor(() =>
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' }),
        )

        await act(async () => {
          await result.current.handleSave()
        })

        expect(modals.openConfirmModal).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Unsaved draft from an older editor version' }),
        )
        const { children } = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)![0] as {
          children: string
        }
        expect(children).toContain(
          `Choose "Refresh from server" or "Discard changes" in the entry's menu, on its name`,
        )
        expect(children).not.toMatch(/\bfile\b/)
      })

      // The defect: `null` was treated exactly like a known-stale base, and
      // nothing ever re-stamps `null`, so the draft was visible and
      // unsaveable by any sequence of actions - while the only advice given
      // (Reload / Discard) destroyed it.
      it('saves the draft once the overwrite is confirmed', async () => {
        persistLegacyDraft()
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        await waitFor(() =>
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' }),
        )

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).toHaveBeenCalled()
      })

      it('re-stamps the base on confirm so the next save is not asked again', async () => {
        const { modals } = await import('@mantine/modals')
        persistLegacyDraft()
        const { result } = renderHook(() => useDraftManager(versionedOptions))
        await waitFor(() =>
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' }),
        )

        await act(async () => {
          await result.current.handleSave()
        })
        // A fresh edit after the save re-stamps from the current version, so
        // the only way to prove the null was cleared is a second save on a
        // draft that still exists. Re-create the draft and save again.
        await act(async () => {
          result.current.setDrafts({ abc123def456: { title: 'Edited after upgrade' } })
        })
        vi.mocked(modals.openConfirmModal).mockClear()
        await act(async () => {
          await result.current.handleSave()
        })

        expect(modals.openConfirmModal).not.toHaveBeenCalled()
        expect(mockSaveEntry).toHaveBeenCalledTimes(2)
      })

      it('keeps the draft and does not save when the overwrite is declined', async () => {
        const { modals } = await import('@mantine/modals')
        persistLegacyDraft()
        vi.mocked(modals.openConfirmModal).mockImplementationOnce(
          (options: { onCancel?: () => void }) => {
            options.onCancel?.()
            return 'mock-modal-id'
          },
        )

        const { result } = renderHook(() => useDraftManager(versionedOptions))
        await waitFor(() =>
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' }),
        )

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).not.toHaveBeenCalled()
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' })
      })

      // Escape/overlay dismissal does not call onCancel in Mantine, so a
      // promise settled only by onCancel would hang here forever and the
      // Save button would never come back.
      it('does not hang when the modal is dismissed without a button', async () => {
        const { modals } = await import('@mantine/modals')
        persistLegacyDraft()
        vi.mocked(modals.openConfirmModal).mockImplementationOnce(
          (options: { onClose?: () => void }) => {
            options.onClose?.()
            return 'mock-modal-id'
          },
        )

        const { result } = renderHook(() => useDraftManager(versionedOptions))
        await waitFor(() =>
          expect(result.current.drafts.abc123def456).toEqual({ title: 'Legacy draft' }),
        )

        await act(async () => {
          await result.current.handleSave()
        })

        expect(mockSaveEntry).not.toHaveBeenCalled()
      })
    })

    it('saves normally when the restored draft base version still matches the server', async () => {
      persistV2({ abc123def456: { title: 'Draft from last session' } }, { abc123def456: 100 })
      mockGetEntryVersion.mockReturnValue(100)

      const { result } = renderHook(() => useDraftManager(versionedOptions))
      await waitFor(() =>
        expect(result.current.drafts.abc123def456).toEqual({ title: 'Draft from last session' }),
      )

      await act(async () => {
        await result.current.handleSave()
      })

      expect(mockSaveEntry).toHaveBeenCalledWith(mockEntry, { title: 'Draft from last session' })
    })
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

  describe('verifying drafts restored from storage', () => {
    const otherEntry: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry2'),
      contentId: unsafeAsContentId('xyz789uvw123'),
      label: 'Other Entry',
    }
    const thirdEntry: EditorEntry = {
      ...mockEntry,
      path: unsafeAsLogicalPath('entry3'),
      contentId: unsafeAsContentId('mno456pqr789'),
      label: 'Third Entry',
    }
    const mockReadEntryValue = vi.fn()

    const storeDrafts = (branch: string, drafts: Record<string, unknown>) => {
      window.localStorage.setItem(
        `canopycms:drafts:${branch}`,
        JSON.stringify({
          v: 2,
          drafts,
          baseVersions: Object.fromEntries(Object.keys(drafts).map((id) => [id, 3])),
        }),
      )
    }

    const verifyOptions = {
      ...defaultOptions,
      entries: [mockEntry, otherEntry, thirdEntry],
      readEntryValue: mockReadEntryValue,
    }

    /** Lets already-resolved promises (and the state updates they trigger) land. */
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

    beforeEach(() => {
      mockReadEntryValue.mockReset()
    })

    it('treats a restored draft that equals the server value as a pristine leftover and removes it everywhere', async () => {
      const server = { title: 'Server title' }
      storeDrafts('main', { [otherEntry.contentId]: server })
      mockReadEntryValue.mockResolvedValue({ title: 'Server title' })

      const { result } = renderHook(() => useDraftManager(verifyOptions))

      await waitFor(() => expect(result.current.isAnyDirty()).toBe(false))
      expect(mockReadEntryValue).toHaveBeenCalledWith(otherEntry)
      expect(result.current.drafts).toEqual({})
      expect(readPersistedDrafts('main')).toEqual({})
    })

    it('counts the restored draft as dirty until it has been checked against the server', async () => {
      let release: (value: unknown) => void = () => {}
      mockReadEntryValue.mockReturnValue(new Promise((resolve) => (release = resolve)))
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Server title' } })

      const { result } = renderHook(() => useDraftManager(verifyOptions))
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalled())

      expect(result.current.isAnyDirty()).toBe(true)

      await act(async () => {
        release({ title: 'Server title' })
      })
      await waitFor(() => expect(result.current.isAnyDirty()).toBe(false))
    })

    it('does not count, and does not delete, a draft whose entry no longer exists', async () => {
      storeDrafts('main', { deadbeef0000: { title: 'Orphan' } })

      const { result } = renderHook(() => useDraftManager(verifyOptions))

      await waitFor(() => expect(result.current.drafts).toHaveProperty('deadbeef0000'))
      await flush()
      expect(result.current.isAnyDirty()).toBe(false)
      expect(result.current.modifiedCount).toBe(0)
      expect(mockReadEntryValue).not.toHaveBeenCalled()
      expect(readPersistedDrafts('main')).toEqual({ deadbeef0000: { title: 'Orphan' } })
    })

    it('does not treat any draft as an orphan while the entries list is still empty', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Mine' } })

      const { result } = renderHook(() => useDraftManager({ ...verifyOptions, entries: [] }))

      await waitFor(() => expect(result.current.drafts).toHaveProperty(otherEntry.contentId))
      await flush()
      expect(result.current.isAnyDirty()).toBe(true)
      expect(mockReadEntryValue).not.toHaveBeenCalled()
    })

    it('keeps a restored draft that differs from the server as dirty, without touching loadedValues', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'My edit' } })
      mockReadEntryValue.mockResolvedValue({ title: 'Server title' })

      const { result } = renderHook(() => useDraftManager(verifyOptions))

      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(1))
      await flush()
      expect(result.current.isAnyDirty()).toBe(true)
      expect(result.current.modifiedCount).toBe(1)
      expect(result.current.drafts[otherEntry.contentId]).toEqual({ title: 'My edit' })
      expect(readPersistedDrafts('main')).toEqual({ [otherEntry.contentId]: { title: 'My edit' } })
      // The verification read is not an entry load: no OCC token path, no loaded value.
      expect(result.current.loadedValues).toEqual({})
      expect(mockLoadEntry).not.toHaveBeenCalled()
    })

    it('stops counting a verified-dirty draft once the user edits it back to the server value', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'My edit' } })
      mockReadEntryValue.mockResolvedValue({ title: 'Server title' })

      const { result } = renderHook(() => useDraftManager(verifyOptions))
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(1))
      await flush()
      expect(result.current.isAnyDirty()).toBe(true)

      act(() => {
        result.current.setDrafts({ [otherEntry.contentId]: { title: 'Server title' } })
      })

      expect(result.current.isAnyDirty()).toBe(false)
    })

    it('leaves a draft unverified, and still dirty, when its read fails', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Server title' } })
      mockReadEntryValue.mockRejectedValue(new Error('network down'))

      const { result } = renderHook(() => useDraftManager(verifyOptions))

      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(1))
      await flush()
      expect(result.current.isAnyDirty()).toBe(true)
      expect(readPersistedDrafts('main')).toHaveProperty(otherEntry.contentId)
      // A failed read must not hold callers waiting for the full cap.
      vi.useFakeTimers()
      try {
        let settled = false
        const pending = result.current.whenDraftsVerified().then(() => {
          settled = true
        })
        await vi.advanceTimersByTimeAsync(100)
        expect(settled).toBe(true)
        await pending
      } finally {
        vi.useRealTimers()
      }
    })

    it('reads each unverified draft once, at most four at a time', async () => {
      const ids = ['aaaaaaaaaaa1', 'aaaaaaaaaaa2', 'aaaaaaaaaaa3', 'aaaaaaaaaaa4', 'aaaaaaaaaaa5']
      const entries = [
        mockEntry,
        ...ids.map((id, i) => ({
          ...mockEntry,
          path: unsafeAsLogicalPath(`e${i}`),
          contentId: unsafeAsContentId(id),
          label: `E${i}`,
        })),
      ]
      storeDrafts('main', Object.fromEntries(ids.map((id) => [id, { title: id }])))
      let inFlight = 0
      let maxInFlight = 0
      const releases: Array<() => void> = []
      mockReadEntryValue.mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            releases.push(() => {
              inFlight--
              resolve({ title: 'server' })
            })
          }),
      )

      const { result } = renderHook(() => useDraftManager({ ...verifyOptions, entries }))
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(4))
      await flush()
      expect(mockReadEntryValue).toHaveBeenCalledTimes(4)

      await act(async () => {
        releases.shift()?.()
      })
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(5))
      await act(async () => {
        while (releases.length > 0) releases.shift()?.()
      })
      await flush()

      expect(maxInFlight).toBe(4)
      expect(mockReadEntryValue).toHaveBeenCalledTimes(5)
      expect(result.current.isAnyDirty()).toBe(true)
    })

    it('ignores a read that settles after the branch changed, even for the same contentId', async () => {
      // The same contentId exists on every branch. The late `main` read equals the
      // draft the `feature` branch restored, so an unguarded settle would delete it.
      const featureDraft = { title: 'Feature edit' }
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Main draft' } })
      storeDrafts('feature', { [otherEntry.contentId]: featureDraft })
      let releaseMain: (value: unknown) => void = () => {}
      mockReadEntryValue
        .mockReturnValueOnce(new Promise((resolve) => (releaseMain = resolve)))
        .mockResolvedValue({ title: 'Feature server' })

      const { result, rerender } = renderHook((props) => useDraftManager(props), {
        initialProps: verifyOptions,
      })
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(1))

      rerender({ ...verifyOptions, branchName: 'feature' })
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalledTimes(2))
      await flush()
      await act(async () => {
        releaseMain({ title: 'Feature edit' })
      })
      await flush()

      expect(result.current.drafts).toEqual({ [otherEntry.contentId]: featureDraft })
      expect(result.current.isAnyDirty()).toBe(true)
      expect(readPersistedDrafts('feature')).toEqual({ [otherEntry.contentId]: featureDraft })
      // The old branch's drafts are untouched in its own storage.
      expect(readPersistedDrafts('main')).toEqual({
        [otherEntry.contentId]: { title: 'Main draft' },
      })
    })

    it('whenDraftsVerified resolves once the pending reads have settled', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Server title' } })
      let release: (value: unknown) => void = () => {}
      mockReadEntryValue.mockReturnValue(new Promise((resolve) => (release = resolve)))

      const { result } = renderHook(() => useDraftManager(verifyOptions))
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalled())

      let settled = false
      const pending = result.current.whenDraftsVerified().then(() => {
        settled = true
      })
      await flush()
      expect(settled).toBe(false)

      await act(async () => {
        release({ title: 'Server title' })
      })
      await act(async () => {
        await pending
      })
      expect(settled).toBe(true)
      expect(result.current.isAnyDirty()).toBe(false)
    })

    it('whenDraftsVerified gives up after its cap rather than waiting on a read that never settles', async () => {
      storeDrafts('main', { [otherEntry.contentId]: { title: 'Server title' } })
      mockReadEntryValue.mockReturnValue(new Promise(() => {}))

      const { result } = renderHook(() => useDraftManager(verifyOptions))
      await waitFor(() => expect(mockReadEntryValue).toHaveBeenCalled())

      vi.useFakeTimers()
      try {
        let settled = false
        const pending = result.current.whenDraftsVerified().then(() => {
          settled = true
        })
        await vi.advanceTimersByTimeAsync(2900)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(200)
        await pending
        expect(settled).toBe(true)
      } finally {
        vi.useRealTimers()
      }
      expect(result.current.isAnyDirty()).toBe(true)
    })

    it('resolveUnsaved names only the entries still counted dirty, after verification', async () => {
      storeDrafts('main', {
        [otherEntry.contentId]: { title: 'Server title' }, // pristine leftover
        [thirdEntry.contentId]: { title: 'My edit' }, // real edit
        deadbeef0000: { title: 'Orphan' },
      })
      mockReadEntryValue.mockImplementation(async (entry: EditorEntry) =>
        entry.contentId === otherEntry.contentId ? { title: 'Server title' } : { title: 'Other' },
      )

      const { result } = renderHook(() => useDraftManager(verifyOptions))
      await waitFor(() => expect(result.current.drafts).toHaveProperty(thirdEntry.contentId))

      let unsaved: Awaited<ReturnType<typeof result.current.resolveUnsaved>> | undefined
      await act(async () => {
        unsaved = await result.current.resolveUnsaved()
      })

      expect(unsaved).toEqual({ count: 1, labels: ['Third Entry'] })
    })

    it('drops a draft that equals the value its entry just loaded', async () => {
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Same' } })
      })
      expect(readPersistedDrafts('main')).toEqual({ abc123def456: { title: 'Same' } })

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Same' } })
      })

      await waitFor(() => expect(result.current.drafts).toEqual({}))
      expect(readPersistedDrafts('main')).toEqual({})
      expect(result.current.effectiveValue).toEqual({ title: 'Same' })
    })

    it('keeps a draft that differs from the value its entry just loaded', async () => {
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Mine' } })
      })

      act(() => {
        result.current.setLoadedValues({ abc123def456: { title: 'Server' } })
      })
      await flush()

      expect(result.current.drafts).toEqual({ abc123def456: { title: 'Mine' } })
      expect(result.current.isAnyDirty()).toBe(true)
    })
  })

  describe('leaving the page', () => {
    /** Whether a `beforeunload` now would ask the user to stay. */
    const leaveIsGuarded = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }

    it('lets the page go with an unsaved draft, which storage keeps', () => {
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      expect(result.current.modifiedCount).toBe(1)
      expect(result.current.draftStorageFailed).toBe(false)
      expect(leaveIsGuarded()).toBe(false)
    })

    it('asks the user to stay while a save is in flight', async () => {
      let finishSave: (value: Record<string, unknown>) => void = () => {}
      mockSaveEntry.mockReturnValue(
        new Promise((resolve) => {
          finishSave = resolve
        }),
      )
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })

      let saving: Promise<void> = Promise.resolve()
      act(() => {
        saving = result.current.handleSave()
      })
      expect(leaveIsGuarded()).toBe(true)

      await act(async () => {
        finishSave({ title: 'Draft' })
        await saving
      })
      expect(leaveIsGuarded()).toBe(false)
    })

    it('asks the user to stay when storage refuses the drafts, and reports it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { result } = renderHook(() => useDraftManager(defaultOptions))
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
      act(() => {
        result.current.setDrafts({ abc123def456: { title: 'Draft' } })
      })
      expect(result.current.draftStorageFailed).toBe(true)
      expect(leaveIsGuarded()).toBe(true)
      warn.mockRestore()
    })
  })
  describe('drafts stored before list items had keys', () => {
    const teamSchema: EntrySchema = [
      { name: 'title', type: 'string' },
      {
        name: 'team',
        type: 'object',
        list: true,
        fields: [{ name: 'name', type: 'string' }],
      },
    ]
    const teamEntry: EditorEntry = { ...mockEntry, schema: teamSchema }
    const ID = 'abc123def456'
    const teamOf = (...names: string[]) => names.map((name) => ({ name }))
    /** What the server read gives the entry: every item keyed. */
    const loaded = (...names: string[]) =>
      withItemKeys(teamSchema, { title: 'Hello', team: teamOf(...names) }, 'content')
    const storeDraft = (value: Record<string, unknown>) =>
      window.localStorage.setItem(
        'canopycms:drafts:main',
        JSON.stringify({ v: 2, drafts: { [ID]: value }, baseVersions: { [ID]: 100 } }),
      )
    const options = { ...defaultOptions, currentEntry: teamEntry, entries: [teamEntry] }

    it('drops a restored draft equal to the loaded value apart from keys', async () => {
      storeDraft({ title: 'Hello', team: teamOf('A', 'B') })
      const { result } = renderHook(() => useDraftManager(options))
      await waitFor(() => expect(result.current.drafts[ID]).toBeDefined())

      act(() => result.current.setLoadedValues({ [ID]: loaded('A', 'B') }))

      await waitFor(() => expect(result.current.drafts[ID]).toBeUndefined())
      expect(result.current.modifiedCount).toBe(0)
      expect(result.current.isSelectedDirty()).toBe(false)
      expect(result.current.editedFiles).toEqual([])
      await waitFor(() => expect(readPersistedDrafts('main')[ID]).toBeUndefined())
    })

    it('keeps a restored draft that really differs, gaining the keys its unchanged items hold', async () => {
      storeDraft({ title: 'Hello', team: teamOf('A', 'B, edited') })
      const { result } = renderHook(() => useDraftManager(options))
      await waitFor(() => expect(result.current.drafts[ID]).toBeDefined())
      const base = loaded('A', 'B')

      act(() => result.current.setLoadedValues({ [ID]: base }))

      await waitFor(() => expect(result.current.modifiedCount).toBe(1))
      const draftTeam = result.current.drafts[ID].team as Array<Record<string, unknown>>
      const baseTeam = base.team as Array<Record<string, unknown>>
      expect(draftTeam.map((t) => t.name)).toEqual(['A', 'B, edited'])
      // The unchanged item has the key a read gives it; the edited one has a key of its own,
      // as a read of the file with that edit would give it.
      expect(draftTeam[0]._key).toBe(baseTeam[0]._key)
      expect(typeof draftTeam[1]._key).toBe('string')
      expect(draftTeam[1]._key).not.toBe(baseTeam[1]._key)
      expect(result.current.isSelectedDirty()).toBe(true)
    })

    it('waits for the entry schema: a draft of an entry not yet known stays as stored', async () => {
      storeDraft({ title: 'Hello', team: teamOf('A', 'B') })
      const { result, rerender } = renderHook(
        (props: { entries: EditorEntry[] }) => useDraftManager({ ...options, ...props }),
        { initialProps: { entries: [] as EditorEntry[] } },
      )
      await waitFor(() => expect(result.current.drafts[ID]).toBeDefined())
      expect(result.current.drafts[ID]).toEqual({ title: 'Hello', team: teamOf('A', 'B') })

      rerender({ entries: [teamEntry] })

      await waitFor(() => {
        const team = result.current.drafts[ID].team as Array<Record<string, unknown>>
        expect(team.every((t) => typeof t._key === 'string')).toBe(true)
      })
      act(() => result.current.setLoadedValues({ [ID]: loaded('A', 'B') }))
      await waitFor(() => expect(result.current.drafts[ID]).toBeUndefined())
    })

    it('leaves a draft whose items already carry keys as it is', async () => {
      const keyed = loaded('A', 'B')
      storeDraft({ ...keyed, title: 'Edited' })
      const { result } = renderHook(() => useDraftManager(options))
      await waitFor(() => expect(result.current.drafts[ID]).toBeDefined())

      expect(result.current.drafts[ID]).toEqual({ ...keyed, title: 'Edited' })
      expect(result.current.drafts[ID].team).toEqual(keyed.team)
    })

    it('keeps the keys of a restored draft whose entry was renamed, which kept its content ID', async () => {
      const keyed = loaded('A', 'B')
      storeDraft({ ...keyed, title: 'Edited' })
      const renamed: EditorEntry = {
        ...teamEntry,
        path: unsafeAsLogicalPath('content/posts/renamed'),
        slug: 'renamed',
      }
      const { result } = renderHook(() =>
        useDraftManager({ ...options, currentEntry: renamed, entries: [renamed] }),
      )
      await waitFor(() => expect(result.current.drafts[ID]).toBeDefined())

      act(() => result.current.setLoadedValues({ [ID]: keyed }))

      await waitFor(() => expect(result.current.modifiedCount).toBe(1))
      expect(result.current.drafts[ID]).toEqual({ ...keyed, title: 'Edited' })
    })
  })
})
