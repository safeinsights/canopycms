import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftManager, type UseDraftManagerOptions } from './useDraftManager'
import { SAVE_ALL_REASONS, type SaveAllResult } from './save-all'
import { SaveApiError } from './useEntryManager'
import { ApiTimeoutError } from '../../api/request-deadline'
import { ENTRY_CHANGED_MESSAGE, ENTRY_GONE_MESSAGE } from '../../api/entries-constants'
import type { EditorEntry } from '../Editor'
import type { FormValue } from '../FormRenderer'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
import { mockConsole, type MockConsole } from '../../test-utils/console-spy'

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}))
vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: vi.fn() },
}))

const entry = (id: string, extra: Partial<EditorEntry> = {}): EditorEntry => ({
  path: unsafeAsLogicalPath(`posts/${id}`),
  contentId: unsafeAsContentId(`${id}`.padEnd(12, '0')),
  label: `Entry ${id}`,
  collectionPath: unsafeAsLogicalPath('posts'),
  collectionName: 'posts',
  slug: id,
  type: 'entry',
  format: 'json',
  schema: [{ name: 'title', type: 'string' }],
  ...extra,
})

const a = entry('a')
const b = entry('b')
const c = entry('c')
const idOf = (e: EditorEntry) => e.contentId as string

/**
 * The server side of a branch: each entry's value and version, the tokens the editor holds, and
 * an OCC-checked write, the contract `useEntryManager` gives the hook.
 */
const makeServer = (entries: EditorEntry[]) => {
  const stored = new Map<string, { value: FormValue; version: number }>()
  for (const e of entries) stored.set(idOf(e), { value: { title: `server ${e.slug}` }, version: 1 })
  const tokens = new Map<string, number>()
  const write = (id: string, value: FormValue) => {
    const record = stored.get(id)
    if (!record) throw new Error(`no entry ${id}`)
    record.value = value
    record.version += 1
    return record.version
  }
  // A failure to inject in place of an entry's write, after or before it lands.
  const failures = new Map<string, (value: FormValue) => Promise<FormValue>>()
  let inFlight = 0
  let maxInFlight = 0
  const order: string[] = []
  const saveEntry = vi.fn(async (e: EditorEntry, value: FormValue) => {
    const id = idOf(e)
    order.push(id)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await Promise.resolve()
      const fail = failures.get(id)
      if (fail) return await fail(value)
      const record = stored.get(id)
      if (!record || tokens.get(id) !== record.version) {
        throw new SaveApiError(409, ENTRY_CHANGED_MESSAGE)
      }
      tokens.set(id, write(id, value))
      return value
    } finally {
      inFlight -= 1
    }
  })
  return {
    stored,
    tokens,
    write,
    failures,
    order,
    maxInFlight: () => maxInFlight,
    options: {
      loadEntry: vi.fn(async (e: EditorEntry) => {
        const record = stored.get(idOf(e))
        if (!record) throw new Error('Load failed: 404')
        tokens.set(idOf(e), record.version)
        return record.value
      }),
      readEntryValue: vi.fn(async (e: EditorEntry) => {
        const record = stored.get(idOf(e))
        if (!record) throw new Error('Load failed: 404')
        return record.value
      }),
      saveEntry,
      getEntryVersion: (id: string) => tokens.get(id),
    },
  }
}

/** Drafts a previous session left, each based on the server version it was edited from. */
const persistDrafts = (
  branch: string,
  drafts: Record<string, FormValue>,
  baseVersions: Record<string, number | null>,
) => {
  window.localStorage.setItem(
    `canopycms:drafts:${branch}`,
    JSON.stringify({ v: 2, drafts, baseVersions }),
  )
}

const persistedDrafts = (branch: string): Record<string, FormValue> =>
  (
    JSON.parse(window.localStorage.getItem(`canopycms:drafts:${branch}`) ?? '{}') as {
      drafts?: Record<string, FormValue>
    }
  ).drafts ?? {}

describe('useDraftManager - Save all', () => {
  let server: ReturnType<typeof makeServer>
  let consoleSpy: MockConsole
  const setBusy = vi.fn()

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
    server = makeServer([a, b, c])
    setBusy.mockReset()
    // A refused save logs its error, as `handleSave`'s does.
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    vi.clearAllMocks()
  })

  /** The hook with the open entry loaded, as `Editor.tsx` loads it, so no draft awaits a check. */
  const setup = (overrides: Partial<UseDraftManagerOptions> = {}) => {
    const rendered = renderHook((props: Partial<UseDraftManagerOptions>) =>
      useDraftManager({
        branchName: 'feature',
        selectedPath: a.path,
        currentEntry: a,
        entries: [a, b, c],
        setBusy,
        ...server.options,
        ...overrides,
        ...props,
      }),
    )
    const opened = server.stored.get(idOf(a))
    server.tokens.set(idOf(a), opened?.version ?? 1)
    act(() => {
      rendered.result.current.setLoadedValues((prev) => ({
        ...prev,
        [idOf(a)]: opened?.value ?? {},
      }))
    })
    return rendered
  }

  /** Three entries with drafts based on the server's current version, none opened yet. */
  const draftAll = () =>
    persistDrafts(
      'feature',
      { [idOf(a)]: { title: 'A2' }, [idOf(b)]: { title: 'B2' }, [idOf(c)]: { title: 'C2' } },
      { [idOf(a)]: 1, [idOf(b)]: 1, [idOf(c)]: 1 },
    )

  const run = async (result: { current: ReturnType<typeof useDraftManager> }) => {
    let outcome: SaveAllResult | undefined
    await act(async () => {
      outcome = await result.current.handleSaveAll()
    })
    return outcome
  }

  it('saves every unsaved entry one at a time, the open one first, and drops their drafts', async () => {
    draftAll()
    const onSaved = vi.fn()
    const { result } = setup({ onSaved })
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)

    expect(outcome).toMatchObject({ branch: 'feature', total: 3, failed: [] })
    expect(outcome?.saved.map((s) => s.label)).toEqual(['Entry a', 'Entry b', 'Entry c'])
    expect(server.order[0]).toBe(idOf(a))
    expect(server.maxInFlight()).toBe(1)
    expect(server.stored.get(idOf(b))?.value).toEqual({ title: 'B2' })
    expect(result.current.modifiedCount).toBe(0)
    expect(persistedDrafts('feature')).toEqual({})
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(setBusy).toHaveBeenNthCalledWith(1, true)
    expect(setBusy).toHaveBeenLastCalledWith(false)
    expect(result.current.saveAllProgress).toBeNull()
    expect(consoleSpy.all().error).toEqual([])
  })

  it('reports progress per entry while it runs', async () => {
    draftAll()
    let release: () => void = () => {}
    server.failures.set(
      idOf(b),
      (value) =>
        new Promise((resolve) => {
          release = () => {
            server.tokens.set(idOf(b), server.write(idOf(b), value))
            resolve(value)
          }
        }),
    )
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let pending: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    act(() => {
      pending = result.current.handleSaveAll()
    })
    await waitFor(() => expect(result.current.saveAllProgress).toEqual({ done: 1, total: 3 }))
    await act(async () => {
      release()
      await pending
    })
    expect(result.current.saveAllProgress).toBeNull()
  })

  it('keeps the entries that saved when others fail, and names each failure and its reason', async () => {
    draftAll()
    server.failures.set(idOf(b), async () => {
      throw new SaveApiError(422, 'Title is too long', [
        { fieldPath: 'title', message: 'Too long' },
      ])
    })
    server.failures.set(idOf(c), async () => {
      throw new SaveApiError(500, undefined)
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)

    expect(outcome?.saved.map((s) => s.label)).toEqual(['Entry a'])
    expect(consoleSpy).toHaveErrored('Title is too long')
    expect(outcome?.failed).toEqual([
      expect.objectContaining({ label: 'Entry b', kind: 'invalid', reason: 'Title is too long' }),
      expect.objectContaining({ label: 'Entry c', kind: 'error', reason: SAVE_ALL_REASONS.failed }),
    ])
    // The failed entries keep their unsaved input, in memory and on the device.
    expect(result.current.drafts[idOf(b)]).toEqual({ title: 'B2' })
    expect(result.current.drafts[idOf(c)]).toEqual({ title: 'C2' })
    expect(Object.keys(persistedDrafts('feature')).sort()).toEqual([idOf(b), idOf(c)].sort())
    expect(result.current.drafts[idOf(a)]).toBeUndefined()
    expect(result.current.modifiedCount).toBe(2)
  })

  it('refuses an entry that changed on the server since its draft started, without writing it', async () => {
    draftAll()
    server.write(idOf(b), { title: 'someone else' })
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([
      expect.objectContaining({
        label: 'Entry b',
        kind: 'conflict',
        reason: SAVE_ALL_REASONS.staleBase,
      }),
    ])
    expect(server.order).not.toContain(idOf(b))
    expect(server.stored.get(idOf(b))?.value).toEqual({ title: 'someone else' })
    expect(result.current.drafts[idOf(b)]).toEqual({ title: 'B2' })
  })

  it("says an open entry the server refused as changed needs a refresh, in Save all's words", async () => {
    draftAll()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))
    server.write(idOf(a), { title: 'someone else' })

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([
      expect.objectContaining({
        label: 'Entry a',
        kind: 'conflict',
        reason: SAVE_ALL_REASONS.staleBase,
      }),
    ])
    expect(result.current.drafts[idOf(a)]).toEqual({ title: 'A2' })
  })

  it('loads an entry not yet opened for its token before writing it', async () => {
    draftAll()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))
    expect(server.tokens.has(idOf(c))).toBe(false)

    await run(result)

    expect(server.options.loadEntry).toHaveBeenCalledWith(c)
    expect(server.stored.get(idOf(c))?.version).toBe(2)
  })

  it('asks for a draft from an older editor to be saved on its own', async () => {
    persistDrafts('feature', { [idOf(b)]: { title: 'B2' } }, { [idOf(b)]: null })
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(1))

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([
      expect.objectContaining({ kind: 'conflict', reason: SAVE_ALL_REASONS.unknownBase }),
    ])
    expect(server.order).toEqual([])
  })

  it('refuses an entry that fails schema validation, without writing it', async () => {
    const strict = entry('b', { schema: [{ name: 'title', type: 'string', required: true }] })
    persistDrafts('feature', { [idOf(strict)]: { title: '' } }, { [idOf(strict)]: 1 })
    const { result } = setup({ entries: [a, strict, c] })
    await waitFor(() => expect(result.current.modifiedCount).toBe(1))

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([
      expect.objectContaining({
        kind: 'invalid',
        reason: '1 field needs fixing. Open it to see which.',
      }),
    ])
    expect(server.order).toEqual([])
  })

  it('counts an unanswered save that the server holds as saved', async () => {
    draftAll()
    server.failures.set(idOf(b), async (value) => {
      server.write(idOf(b), value)
      throw new ApiTimeoutError('PUT', '/api/content', 30000)
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([])
    expect(outcome?.saved.map((s) => s.label)).toContain('Entry b')
    expect(result.current.drafts[idOf(b)]).toBeUndefined()
    // The token moved to the version holding the save, so the next save is not a false conflict.
    expect(server.tokens.get(idOf(b))).toBe(server.stored.get(idOf(b))?.version)
  })

  it('warns that an unanswered save may have gone through when the server does not hold it, and keeps the draft', async () => {
    draftAll()
    server.failures.set(idOf(b), async () => {
      throw new ApiTimeoutError('PUT', '/api/content', 30000)
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)

    expect(outcome?.failed).toEqual([
      expect.objectContaining({
        label: 'Entry b',
        kind: 'unanswered',
        reason: SAVE_ALL_REASONS.unanswered,
      }),
    ])
    expect(result.current.drafts[idOf(b)]).toEqual({ title: 'B2' })

    // Its retry is refused as changed: most likely the first save landed, so saves hold until a refresh.
    server.failures.set(idOf(b), async () => {
      throw new SaveApiError(409, ENTRY_CHANGED_MESSAGE)
    })
    const retry = await run(result)
    expect(retry?.failed).toEqual([
      expect.objectContaining({ kind: 'unanswered', reason: SAVE_ALL_REASONS.earlierUnanswered }),
    ])
    server.failures.delete(idOf(b))
    const held = await run(result)
    expect(held?.failed).toEqual([
      expect.objectContaining({ kind: 'unanswered', reason: SAVE_ALL_REASONS.earlierUnanswered }),
    ])
  })

  it('offers "Save as new entry" for an entry deleted since its edits started', async () => {
    draftAll()
    server.failures.set(idOf(c), async () => {
      throw new SaveApiError(409, ENTRY_GONE_MESSAGE, undefined, 'ENTRY_GONE')
    })
    const followMovedEntry = vi.fn(async () => undefined)
    const recreateEntry = vi.fn(async () => undefined)
    const { result } = setup({ followMovedEntry, recreateEntry })
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)
    const failure = outcome?.failed[0]
    expect(failure).toMatchObject({ kind: 'conflict', reason: SAVE_ALL_REASONS.deleted })
    expect(failure?.recreate).toBeTypeOf('function')
    await act(async () => {
      failure?.recreate?.()
    })
    await waitFor(() => expect(recreateEntry).toHaveBeenCalledWith(c, { title: 'C2' }))
  })

  it('says a renamed entry moved its changes with it', async () => {
    draftAll()
    server.failures.set(idOf(c), async () => {
      throw new SaveApiError(409, ENTRY_GONE_MESSAGE, undefined, 'ENTRY_GONE')
    })
    const followMovedEntry = vi.fn(async () => ({ ...c, path: unsafeAsLogicalPath('posts/c2') }))
    const { result } = setup({ followMovedEntry })
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const outcome = await run(result)
    expect(outcome?.failed).toEqual([
      // "Open" goes to where the changes moved.
      expect.objectContaining({ reason: SAVE_ALL_REASONS.renamed, path: 'posts/c2' }),
    ])
  })

  it('keeps edits typed while the entry was saving, based on the version just written', async () => {
    draftAll()
    let release: () => void = () => {}
    server.failures.set(
      idOf(a),
      (value) =>
        new Promise((resolve) => {
          release = () => {
            server.tokens.set(idOf(a), server.write(idOf(a), value))
            resolve(value)
          }
        }),
    )
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let pending: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    act(() => {
      pending = result.current.handleSaveAll()
    })
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    act(() => {
      result.current.setDrafts((prev) => ({ ...prev, [idOf(a)]: { title: 'A3' } }))
    })
    await act(async () => {
      release()
      await pending
    })

    expect(result.current.drafts[idOf(a)]).toEqual({ title: 'A3' })
    server.failures.delete(idOf(a))
    // Saving it again is not mistaken for someone else's change.
    await act(async () => {
      await result.current.handleSave()
    })
    expect(server.stored.get(idOf(a))?.value).toEqual({ title: 'A3' })
  })

  it('stops when the branch changes mid-run and reports nothing', async () => {
    draftAll()
    let release: () => void = () => {}
    server.failures.set(
      idOf(a),
      (value) =>
        new Promise((resolve) => {
          release = () => resolve(value)
        }),
    )
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let pending: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    act(() => {
      pending = result.current.handleSaveAll()
    })
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    rerender({ branchName: 'other' })
    let outcome: SaveAllResult | undefined = { branch: 'x', total: 1, saved: [], failed: [] }
    await act(async () => {
      release()
      outcome = await pending
    })

    expect(outcome).toBeUndefined()
    expect(server.order).toEqual([idOf(a)])
    // Not even read: a read now would record a token on the other branch.
    expect(server.options.loadEntry).not.toHaveBeenCalled()
  })

  it('runs once at a time', async () => {
    draftAll()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let first: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    let second: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    await act(async () => {
      first = result.current.handleSaveAll()
      second = result.current.handleSaveAll()
      await Promise.all([first, second])
    })
    expect(await second).toBeUndefined()
    expect((await first)?.total).toBe(3)
    expect(server.order).toHaveLength(3)
  })

  it('has nothing to do with no unsaved entries', async () => {
    const { result } = setup()
    const outcome = await run(result)
    expect(outcome).toEqual({ branch: 'feature', total: 0, saved: [], failed: [] })
    expect(server.order).toEqual([])
    expect(setBusy).toHaveBeenLastCalledWith(false)
  })

  /** Holds entry a's write until `release()`, landing it then. */
  const holdWriteOfA = () => {
    const held = { release: () => {} }
    server.failures.set(
      idOf(a),
      (value) =>
        new Promise((resolve) => {
          held.release = () => {
            server.tokens.set(idOf(a), server.write(idOf(a), value))
            resolve(value)
          }
        }),
    )
    return held
  }

  const startRun = (result: { current: ReturnType<typeof useDraftManager> }) => {
    let pending: Promise<SaveAllResult | undefined> = Promise.resolve(undefined)
    act(() => {
      pending = result.current.handleSaveAll()
    })
    return () => pending
  }

  it("commits nothing into the next branch's state when a save answers after a switch", async () => {
    draftAll()
    // The other branch holds a draft of the same entry, based on a version since replaced.
    persistDrafts('other', { [idOf(a)]: { title: 'stale other draft' } }, { [idOf(a)]: 1 })
    const held = holdWriteOfA()
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const pending = startRun(result)
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    rerender({ branchName: 'other' })
    await waitFor(() =>
      expect(result.current.drafts[idOf(a)]).toEqual({ title: 'stale other draft' }),
    )
    server.tokens.set(idOf(a), 3)
    await act(async () => {
      held.release()
      await pending()
    })

    expect(result.current.loadedValues[idOf(a)]).toBeUndefined()
    // Its base stays the stale one, so saving it is still refused.
    await act(async () => {
      await result.current.handleSave()
    })
    expect(server.order).toEqual([idOf(a)])
  })

  it("a single Save answering after a switch commits nothing into the next branch's state", async () => {
    draftAll()
    const held = holdWriteOfA()
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.handleSave()
    })
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    rerender({ branchName: 'other' })
    await act(async () => {
      held.release()
      await pending
    })
    expect(result.current.loadedValues[idOf(a)]).toBeUndefined()
  })

  it('persists the new base of edits typed during the save, so a reload keeps them saveable', async () => {
    persistDrafts('feature', { [idOf(a)]: { title: 'A2' } }, { [idOf(a)]: 1 })
    const held = holdWriteOfA()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(1))

    const pending = startRun(result)
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    act(() => {
      result.current.setDrafts((prev) => ({ ...prev, [idOf(a)]: { title: 'A3' } }))
    })
    await act(async () => {
      held.release()
      await pending()
    })

    const stored = JSON.parse(window.localStorage.getItem('canopycms:drafts:feature') ?? '{}') as {
      baseVersions?: Record<string, number>
    }
    expect(stored.baseVersions?.[idOf(a)]).toBe(server.stored.get(idOf(a))?.version)
  })

  it('does not start while a single Save is out', async () => {
    draftAll()
    const held = holdWriteOfA()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = result.current.handleSave()
    })
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    expect(await run(result)).toBeUndefined()
    await act(async () => {
      held.release()
      await saving
    })
    expect(server.order).toEqual([idOf(a)])
  })

  it("leaves a single Save's late failure off the next branch", async () => {
    draftAll()
    let fail: () => void = () => {}
    server.failures.set(
      idOf(a),
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new ApiTimeoutError('PUT', '/api/content', 30000))
        }),
    )
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = result.current.handleSave()
    })
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    rerender({ branchName: 'other' })
    await act(async () => {
      fail()
      await saving
    })
    const { notifications } = await import('@mantine/notifications')
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: `canopy-save-timed-out:${idOf(a)}` }),
    )
  })

  it('records no base for a draft discarded while its save was out', async () => {
    draftAll()
    const held = holdWriteOfA()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const pending = startRun(result)
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    act(() => {
      result.current.setDrafts((prev) => {
        const next = { ...prev }
        delete next[idOf(a)]
        return next
      })
    })
    await act(async () => {
      held.release()
      await pending()
    })

    const stored = JSON.parse(window.localStorage.getItem('canopycms:drafts:feature') ?? '{}') as {
      baseVersions?: Record<string, unknown>
    }
    expect(stored.baseVersions).not.toHaveProperty(idOf(a))
  })

  it('holds a single Save while Save all runs, from before its draft check', async () => {
    draftAll()
    const held = holdWriteOfA()
    const { result } = setup()
    await waitFor(() => expect(result.current.modifiedCount).toBe(3))

    const pending = startRun(result)
    expect(setBusy).toHaveBeenCalledWith(true)
    expect(result.current.saveAllProgress).not.toBeNull()
    await waitFor(() => expect(server.order).toContain(idOf(a)))
    await act(async () => {
      await result.current.handleSave()
    })
    expect(server.order).toEqual([idOf(a)])
    await act(async () => {
      held.release()
      await pending()
    })
    expect(server.order).toHaveLength(3)
  })
})
