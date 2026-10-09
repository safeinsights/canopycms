import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReferenceResolution } from './useReferenceResolution'
import type { EntrySchema } from '../../config'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { ApiResponse } from '../../api/types'
import { MISSING_REFERENCE_TTL_MS } from '../client-reference-resolver'
import { mockConsole } from '../../test-utils/console-spy'

// client-reference-resolver.ts (which this hook calls) uses createApiClient()
// directly (not context DI) -- mock the same resolved module the hook's
// dependency chain imports, matching client-reference-resolver.test.ts.
vi.mock('../../api/client', () => ({
  createApiClient: vi.fn(),
}))

type ResolveResult = ApiResponse<{ resolved: Record<string, unknown> }>

describe('useReferenceResolution', () => {
  let mockClient: MockApiClient

  const schema: EntrySchema = [
    { name: 'title', type: 'string' },
    { name: 'author', type: 'reference' },
  ]

  beforeEach(async () => {
    mockClient = createMockApiClient()
    const { createApiClient } = await import('../../api/client')
    vi.mocked(createApiClient).mockReturnValue(
      mockClient as unknown as ReturnType<typeof createApiClient>,
    )
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an uncached reference as unresolved/loading before the debounce fires', () => {
    const { result } = renderHook(() =>
      useReferenceResolution({ value: { author: 'idAAAAAAAAAA' }, fields: schema, branch: 'main' }),
    )

    expect(result.current.resolvedValue.author).toBeNull()
    expect(result.current.loadingState.author).toBe(true)
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })

  it('resolves an uncached reference id after the debounce and updates resolvedValue', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result } = renderHook(() =>
      useReferenceResolution({ value: { author: 'idAAAAAAAAAA' }, fields: schema, branch: 'main' }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
    expect(result.current.loadingState.author).toBe(false)
  })

  it('resolves references nested in objects and blocks, in one request', async () => {
    const nestedSchema: EntrySchema = [
      {
        name: 'byline',
        type: 'object',
        label: 'Byline',
        fields: [{ name: 'person', type: 'reference', label: 'Person', collections: ['people'] }],
      },
      {
        name: 'blocks',
        type: 'block',
        label: 'Blocks',
        templates: [
          {
            name: 'quote',
            label: 'Quote',
            fields: [
              {
                name: 'speakers',
                type: 'reference',
                label: 'Speakers',
                list: true,
                collections: ['people'],
              },
            ],
          },
        ],
      },
    ]
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { name: 'Alice' }, idBAAAAAAAAA: { name: 'Bob' } } },
    } satisfies ResolveResult)

    const { result } = renderHook(() =>
      useReferenceResolution({
        value: {
          byline: { person: 'idAAAAAAAAAA' },
          blocks: [{ template: 'quote', value: { speakers: ['idAAAAAAAAAA', 'idBAAAAAAAAA'] } }],
        },
        fields: nestedSchema,
        branch: 'main',
      }),
    )
    expect(result.current.resolvedValue.byline).toEqual({ person: null })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)
    expect(result.current.resolvedValue).toEqual({
      byline: { person: { name: 'Alice' } },
      blocks: [{ template: 'quote', value: { speakers: [{ name: 'Alice' }, { name: 'Bob' }] } }],
    })
    expect(result.current.loadingState).toEqual({
      byline: { person: false },
      blocks: [{ value: { speakers: [false, false] } }],
    })
  })

  it('asks again for a missing id once its null entry expires, on the next edit', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: {} },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idAAAAAAAAAA' } as Record<string, unknown> } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.resolvedValue.author).toBeNull()
    expect(result.current.loadingState.author).toBe(false)

    // Within the TTL an edit does not ask again.
    rerender({ value: { author: 'idAAAAAAAAAA', title: 'one' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)

    // The target is created; after the TTL the next edit picks it up.
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSING_REFERENCE_TTL_MS)
    })
    rerender({ value: { author: 'idAAAAAAAAAA', title: 'two' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2)
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
  })

  it('leaves a reference pending, not missing, when the request fails', async () => {
    const consoleSpy = mockConsole()
    try {
      mockClient.content.resolveReferences.mockResolvedValueOnce({ ok: false, status: 500 })
      const { result } = renderHook(() =>
        useReferenceResolution({
          value: { author: 'idAAAAAAAAAA' },
          fields: schema,
          branch: 'main',
        }),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(result.current.resolvedValue.author).toBeNull()
      expect(result.current.loadingState.author).toBe(true)
    } finally {
      consoleSpy.restore()
    }
  })

  it('does not re-fetch when only a non-reference field changes', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idAAAAAAAAAA' } as Record<string, unknown> } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)

    // Re-render with an unrelated field change, same reference id -- nothing
    // new to resolve.
    rerender({ value: { author: 'idAAAAAAAAAA', title: 'A new title' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)
  })

  it('reuses the cache across rerenders instead of calling the API again for the same id', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idAAAAAAAAAA' } } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)

    // Switch away and back to the same id -- second time should be a cache hit.
    rerender({ value: { author: 'idBAAAAAAAAA' } })
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idBAAAAAAAAA: { title: 'Bob' } } },
    } satisfies ResolveResult)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2)

    rerender({ value: { author: 'idAAAAAAAAAA' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2) // no new call
  })

  it('keeps a result that settles after the draft moved on', async () => {
    // Each request parks on its own hand-held resolver, keyed by the first id it asks for.
    const resolvers: Record<string, (v: ResolveResult) => void> = {}
    mockClient.content.resolveReferences.mockImplementation(
      (_params: Record<string, string>, body: { ids: string[] }) =>
        new Promise<ResolveResult>((resolve) => {
          resolvers[body.ids[0]] = resolve
        }),
    )

    const { result, rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idAAAAAAAAAA' } as Record<string, unknown> } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // The author changes, then changes back, while the first request is in flight.
    rerender({ value: { author: 'idBAAAAAAAAA' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ value: { author: 'idAAAAAAAAAA', title: 'typed' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences.mock.calls.map(([, body]) => body.ids)).toEqual([
      ['idAAAAAAAAAA'],
      ['idBAAAAAAAAA'],
      ['idAAAAAAAAAA'],
    ])

    await act(async () => {
      resolvers['idBAAAAAAAAA']({
        ok: true,
        status: 200,
        data: { resolved: { idBAAAAAAAAA: { title: 'Bob' } } },
      })
      resolvers['idAAAAAAAAAA']({
        ok: true,
        status: 200,
        data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })

    rerender({ value: { author: 'idBAAAAAAAAA' } })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Bob' })
  })

  it('resolves on returning to a branch whose request settled while the editor was away', async () => {
    let settleMain: (v: ResolveResult) => void = () => {}
    mockClient.content.resolveReferences
      .mockImplementationOnce(
        () =>
          new Promise<ResolveResult>((resolve) => {
            settleMain = resolve
          }),
      )
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
      } satisfies ResolveResult)
    // One draft object throughout, as when the editor keeps the same entry open.
    const value = { author: 'idAAAAAAAAAA' }

    const { result, rerender } = renderHook(
      (props: { branch: string }) =>
        useReferenceResolution({ value, fields: schema, branch: props.branch }),
      { initialProps: { branch: 'main' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ branch: 'feature' })
    await act(async () => {
      settleMain({
        ok: true,
        status: 200,
        data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
      })
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ branch: 'main' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(3)
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
  })

  it('resolves on returning to a branch while its request is still in flight', async () => {
    const pending: Array<(v: ResolveResult) => void> = []
    mockClient.content.resolveReferences.mockImplementation(
      () =>
        new Promise<ResolveResult>((resolve) => {
          pending.push(resolve)
        }),
    )
    const value = { author: 'idAAAAAAAAAA' }

    const { result, rerender } = renderHook(
      (props: { branch: string }) =>
        useReferenceResolution({ value, fields: schema, branch: props.branch }),
      { initialProps: { branch: 'main' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ branch: 'feature' })
    rerender({ branch: 'main' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    await act(async () => {
      for (const resolve of pending) {
        resolve({ ok: true, status: 200, data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } } })
      }
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
  })

  it('asks again for every target after a branch switch and back', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { branch: string }) =>
        useReferenceResolution({
          value: { author: 'idAAAAAAAAAA' },
          fields: schema,
          branch: props.branch,
        }),
      { initialProps: { branch: 'main' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })

    rerender({ branch: 'feature' })
    expect(result.current.resolvedValue.author).toBeNull()
    expect(result.current.loadingState.author).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ branch: 'main' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // main's entry was cleared by the switch, so returning asks for the id a third time.
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(3)
  })

  it('refetches cached targets when the open entry changes, showing them meanwhile', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { entryKey: string }) =>
        useReferenceResolution({
          value: { author: 'idAAAAAAAAAA' },
          fields: schema,
          branch: 'main',
          entryKey: props.entryKey,
        }),
      { initialProps: { entryKey: 'one' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice, renamed' } } },
    } satisfies ResolveResult)
    rerender({ entryKey: 'two' })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
    expect(result.current.loadingState.author).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2)
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice, renamed' })
  })

  it('never sends a malformed id, so the well-formed ones still resolve', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: { title: 'Alice' } } },
    } satisfies ResolveResult)
    const listSchema: EntrySchema = [
      { name: 'authors', type: 'reference', label: 'Authors', list: true, collections: ['people'] },
    ]

    const { result } = renderHook(() =>
      useReferenceResolution({
        value: { authors: ['idAAAAAAAAAA', 'some-slug', 42] },
        fields: listSchema,
        branch: 'main',
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledWith(
      { branch: 'main' },
      { ids: ['idAAAAAAAAAA'] },
    )
    expect(result.current.resolvedValue.authors).toEqual([{ title: 'Alice' }, null, null])
    expect(result.current.loadingState.authors).toEqual([false, false, false])
  })
})
