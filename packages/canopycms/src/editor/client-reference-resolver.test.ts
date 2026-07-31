import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { EntrySchema } from '../config'
import { findChangedFields, resolveChangedReferences } from './client-reference-resolver'
import { createMockApiClient, type MockApiClient } from '../api/__test__/mock-client'
import { mockConsole } from '../test-utils/console-spy'

// client-reference-resolver.ts calls createApiClient() directly (not via
// context DI), so the mock target is '../api/client' -- the same specifier
// the module under test imports -- not the '../api' barrel.
vi.mock('../api/client', () => ({
  createApiClient: vi.fn(),
}))

describe('findChangedFields', () => {
  const schema: EntrySchema = [
    { name: 'title', type: 'string' },
    { name: 'author', type: 'reference' },
    { name: 'tags', type: 'reference', list: true },
  ]

  it('returns fields whose value changed between prev and current', () => {
    const prev = { title: 'A', author: 'id1', tags: ['id1'] }
    const current = { title: 'A', author: 'id2', tags: ['id1'] }

    const changed = findChangedFields(prev, current, schema)

    expect(changed.map((f) => f.name)).toEqual(['author'])
  })

  it('returns no fields when nothing changed', () => {
    const value = { title: 'A', author: 'id1', tags: ['id1', 'id2'] }
    expect(findChangedFields(value, { ...value }, schema)).toEqual([])
  })

  it('detects array value changes', () => {
    const prev = { title: 'A', author: 'id1', tags: ['id1'] }
    const current = { title: 'A', author: 'id1', tags: ['id1', 'id2'] }

    const changed = findChangedFields(prev, current, schema)

    expect(changed.map((f) => f.name)).toEqual(['tags'])
  })

  it('treats a field missing from prevValue as changed (undefined -> value)', () => {
    const changed = findChangedFields({}, { author: 'id1' }, schema)
    expect(changed.map((f) => f.name)).toEqual(['author'])
  })
})

describe('resolveChangedReferences', () => {
  let mockClient: MockApiClient

  const schema: EntrySchema = [
    { name: 'title', type: 'string' },
    { name: 'author', type: 'reference' },
    { name: 'contributors', type: 'reference', list: true },
  ]

  beforeEach(async () => {
    mockClient = createMockApiClient()
    const { createApiClient } = await import('../api/client')
    vi.mocked(createApiClient).mockReturnValue(mockClient as any)
  })

  it('resolves a single changed reference field via the API', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { id1: { title: 'Alice' } } },
    })

    const cache = new Map<string, unknown>()
    const updates = await resolveChangedReferences(
      { title: 'A', author: undefined },
      { title: 'A', author: 'id1' },
      schema,
      'main',
      cache,
    )

    expect(updates).toEqual({ author: { title: 'Alice' } })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledWith(
      { branch: 'main' },
      { ids: ['id1'] },
    )
    // Resolved value is cached under branch-scoped key for reuse.
    expect(cache.get('main:id1')).toEqual({ title: 'Alice' })
  })

  it('resolves a list reference field, one API call per id', async () => {
    mockClient.content.resolveReferences
      .mockResolvedValueOnce({ ok: true, status: 200, data: { resolved: { id1: { name: 'A' } } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { resolved: { id2: { name: 'B' } } } })

    const cache = new Map<string, unknown>()
    const updates = await resolveChangedReferences(
      { title: 'A', contributors: [] },
      { title: 'A', contributors: ['id1', 'id2'] },
      schema,
      'main',
      cache,
    )

    expect(updates).toEqual({ contributors: [{ name: 'A' }, { name: 'B' }] })
    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(2)
  })

  it('reuses the cache instead of calling the API again for an already-resolved id', async () => {
    const cache = new Map<string, unknown>([['main:id1', { title: 'Cached Alice' }]])

    const updates = await resolveChangedReferences(
      { title: 'A', author: undefined },
      { title: 'A', author: 'id1' },
      schema,
      'main',
      cache,
    )

    expect(updates).toEqual({ author: { title: 'Cached Alice' } })
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })

  it('ignores non-reference field changes', async () => {
    const cache = new Map<string, unknown>()
    const updates = await resolveChangedReferences(
      { title: 'A' },
      { title: 'B' },
      schema,
      'main',
      cache,
    )

    expect(updates).toEqual({})
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })

  it('returns the original id unresolved when the API reports failure, without throwing', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const cache = new Map<string, unknown>()
    const updates = await resolveChangedReferences(
      { title: 'A', author: undefined },
      { title: 'A', author: 'id1' },
      schema,
      'main',
      cache,
    )

    expect(updates).toEqual({ author: 'id1' })
    expect(cache.has('main:id1')).toBe(false)
  })

  it('returns the original id unresolved when the API call rejects, without throwing', async () => {
    const consoleSpy = mockConsole()
    try {
      mockClient.content.resolveReferences.mockRejectedValueOnce(new Error('network down'))

      const cache = new Map<string, unknown>()
      const updates = await resolveChangedReferences(
        { title: 'A', author: undefined },
        { title: 'A', author: 'id1' },
        schema,
        'main',
        cache,
      )

      expect(updates).toEqual({ author: 'id1' })
    } finally {
      consoleSpy.restore()
    }
  })
})
