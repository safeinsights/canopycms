import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftManager, type UseDraftManagerOptions } from './useDraftManager'
import type { EditorEntry } from '../Editor'
import type { FormValue } from '../FormRenderer'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}))
vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: vi.fn((o: { onConfirm?: () => void }) => o.onConfirm?.()) },
}))

const entry = (id: string): EditorEntry => ({
  path: unsafeAsLogicalPath(`posts/${id}`),
  contentId: unsafeAsContentId(id.padEnd(12, '0')),
  label: `Entry ${id}`,
  collectionPath: unsafeAsLogicalPath('posts'),
  collectionName: 'posts',
  slug: id,
  type: 'entry',
  format: 'json',
  schema: [{ name: 'title', type: 'string' }],
})

const a = entry('a')
const b = entry('b')
const idA = a.contentId as string
const idB = b.contentId as string

describe('useDraftManager - conflict choices waiting on a save', () => {
  const saved: Record<string, FormValue> = {}
  const saveEntry = vi.fn(async (e: EditorEntry, value: FormValue) => {
    saved[e.contentId as string] = value
    return value
  })

  beforeEach(() => {
    const store: Record<string, string> = {}
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value
        },
        removeItem: (key: string) => {
          delete store[key]
        },
        clear: () => {
          for (const key of Object.keys(store)) delete store[key]
        },
      },
      writable: true,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(saved)) delete saved[key]
  })

  /** The hook with entry `a` open and both entries loaded, no drafts. */
  const setup = (pendingIds: ReadonlySet<string>) => {
    const rendered = renderHook((props: Partial<UseDraftManagerOptions>) =>
      useDraftManager({
        branchName: 'feature',
        selectedPath: a.path,
        currentEntry: a,
        entries: [a, b],
        setBusy: vi.fn(),
        loadEntry: vi.fn(async () => ({ title: 'server' })),
        saveEntry,
        getEntryVersion: () => 1,
        pendingIds,
        ...props,
      }),
    )
    act(() => {
      rendered.result.current.setLoadedValues({
        [idA]: { title: 'kept a' },
        [idB]: { title: 'kept b' },
      })
    })
    return rendered
  }

  it('counts an entry with a choice to send as unsaved, though its value is unchanged', () => {
    const { result } = setup(new Set([idA]))
    expect(result.current.modifiedCount).toBe(1)
    expect(result.current.isSelectedDirty()).toBe(true)
    expect(result.current.isDirtyForEntry(a.path)).toBe(true)
    expect(result.current.isDirtyForEntry(b.path)).toBe(false)
    expect(result.current.editedFiles.map((f) => f.label)).toEqual(['Entry a'])
  })

  it('counts nothing once no choice waits', () => {
    const { result } = setup(new Set())
    expect(result.current.modifiedCount).toBe(0)
    expect(result.current.isSelectedDirty()).toBe(false)
  })

  it('Save writes the open entry as loaded, so its choice reaches the server', async () => {
    const { result } = setup(new Set([idA]))
    await act(async () => {
      await result.current.handleSave()
    })
    expect(saveEntry).toHaveBeenCalledTimes(1)
    expect(saved[idA]).toEqual({ title: 'kept a' })
  })

  it('Save all writes an entry whose only unsaved work is a choice', async () => {
    const { result } = setup(new Set([idB]))
    let outcome: Awaited<ReturnType<typeof result.current.handleSaveAll>>
    await act(async () => {
      outcome = await result.current.handleSaveAll()
    })
    expect(saved[idB]).toEqual({ title: 'kept b' })
    expect(outcome!.saved.map((s) => s.label)).toEqual(['Entry b'])
  })
})
