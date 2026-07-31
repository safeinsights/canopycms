import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReferenceResolution } from './useReferenceResolution'
import type { EntrySchema } from '../../config'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import type { ApiResponse } from '../../api/types'

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
    vi.mocked(createApiClient).mockReturnValue(mockClient as any)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an uncached reference as unresolved/loading before the debounce fires', () => {
    const { result } = renderHook(() =>
      useReferenceResolution({ value: { author: 'idA' }, fields: schema, branch: 'main' }),
    )

    expect(result.current.resolvedValue.author).toBeNull()
    expect(result.current.loadingState.author).toBe(true)
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })

  it('resolves an uncached reference id after the debounce and updates resolvedValue', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const onResolvedValueChange = vi.fn()
    const { result } = renderHook(() =>
      useReferenceResolution({
        value: { author: 'idA' },
        fields: schema,
        branch: 'main',
        onResolvedValueChange,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
    expect(result.current.loadingState.author).toBe(false)
    expect(onResolvedValueChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ author: { title: 'Alice' } }),
    )
  })

  it('does not re-fetch when only a non-reference field changes', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idA' } as Record<string, unknown> } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)

    // Re-render with an unrelated field change, same reference id -- nothing
    // new to resolve.
    rerender({ value: { author: 'idA', title: 'A new title' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)
  })

  it('reuses the cache across rerenders instead of calling the API again for the same id', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({ value: props.value, fields: schema, branch: 'main' }),
      { initialProps: { value: { author: 'idA' } } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)

    // Switch away and back to the same id -- second time should be a cache hit.
    rerender({ value: { author: 'idB' } })
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idB: { title: 'Bob' } } },
    } satisfies ResolveResult)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2)

    rerender({ value: { author: 'idA' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2) // no new call
  })

  it('a superseded resolve does not overwrite a newer one, regardless of response order', async () => {
    // Each call to resolveReferences parks on its own hand-held resolver,
    // keyed by the id being resolved, so we can settle them out of order.
    const resolvers: Record<string, (v: ResolveResult) => void> = {}
    mockClient.content.resolveReferences.mockImplementation(
      (_params: Record<string, string>, body: { ids: string[] }) =>
        new Promise<ResolveResult>((resolve) => {
          resolvers[body.ids[0]] = resolve
        }),
    )

    const onResolvedValueChange = vi.fn()
    const { result, rerender } = renderHook(
      (props: { value: Record<string, unknown> }) =>
        useReferenceResolution({
          value: props.value,
          fields: schema,
          branch: 'main',
          onResolvedValueChange,
        }),
      { initialProps: { value: { author: 'idA' } } },
    )

    // First debounce fires, dispatching idA's (soon-to-be-superseded) request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(resolvers.idA).toBeDefined()

    // Value changes to a different reference BEFORE idA settles.
    rerender({ value: { author: 'idB' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(resolvers.idB).toBeDefined()

    // Settle the NEWER request (idB) first -- it should commit.
    await act(async () => {
      resolvers.idB({ ok: true, status: 200, data: { resolved: { idB: { title: 'Bob' } } } })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Bob' })

    const callsBeforeStaleSettle = onResolvedValueChange.mock.calls.length

    // Now settle the STALE request (idA) -- must be discarded entirely: no
    // cache write, no resolvedValue change, no extra notify call.
    await act(async () => {
      resolvers.idA({ ok: true, status: 200, data: { resolved: { idA: { title: 'Alice' } } } })
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.resolvedValue.author).toEqual({ title: 'Bob' })
    expect(onResolvedValueChange.mock.calls.length).toBe(callsBeforeStaleSettle)
  })

  it('does not update state after unmount when a debounced resolve settles later', async () => {
    const resolvers: Record<string, (v: ResolveResult) => void> = {}
    mockClient.content.resolveReferences.mockImplementation(
      (_params: Record<string, string>, body: { ids: string[] }) =>
        new Promise<ResolveResult>((resolve) => {
          resolvers[body.ids[0]] = resolve
        }),
    )

    const onResolvedValueChange = vi.fn()
    const { unmount } = renderHook(() =>
      useReferenceResolution({
        value: { author: 'idA' },
        fields: schema,
        branch: 'main',
        onResolvedValueChange,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(resolvers.idA).toBeDefined()

    const callsBeforeUnmount = onResolvedValueChange.mock.calls.length
    unmount()

    // Settle the in-flight request AFTER unmount.
    await act(async () => {
      resolvers.idA({ ok: true, status: 200, data: { resolved: { idA: { title: 'Alice' } } } })
      await vi.advanceTimersByTimeAsync(0)
    })

    // No further notifications after unmount -- the stale settle was discarded.
    expect(onResolvedValueChange.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('clears the cache when branch changes, so a resolved id reverts to unresolved', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: { idA: { title: 'Alice' } } },
    } satisfies ResolveResult)

    const { result, rerender } = renderHook(
      (props: { branch: string }) =>
        useReferenceResolution({ value: { author: 'idA' }, fields: schema, branch: props.branch }),
      { initialProps: { branch: 'main' } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(result.current.resolvedValue.author).toEqual({ title: 'Alice' })

    act(() => {
      rerender({ branch: 'feature' })
    })

    // Cache is branch-scoped: the same id under a different branch is unresolved again
    // (prevents a stale cross-branch resolved value from flashing in the new branch's preview).
    expect(result.current.resolvedValue.author).toBeNull()
    expect(result.current.loadingState.author).toBe(true)
  })
})
