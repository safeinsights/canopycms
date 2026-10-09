import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntrySchema } from '../config'
import {
  applyReferenceCache,
  fetchReferences,
  idsToFetch,
  MISSING_REFERENCE_TTL_MS,
  storeReferences,
  type ReferenceCache,
} from './client-reference-resolver'
import { createMockApiClient, type MockApiClient } from '../api/__test__/mock-client'
import type { ApiResponse } from '../api/types'

// client-reference-resolver.ts calls createApiClient() directly (not via
// context DI), so the mock target is '../api/client' -- the same specifier
// the module under test imports -- not the '../api' barrel.
vi.mock('../api/client', () => ({
  createApiClient: vi.fn(),
}))

type ResolveResult = ApiResponse<{ resolved: Record<string, unknown> }>

/** Every position a reference can sit in, each nested inside the one before where it can be. */
const schema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'reference', label: 'Author', collections: ['people'] },
  {
    name: 'contributors',
    type: 'reference',
    label: 'Contributors',
    list: true,
    collections: ['people'],
  },
  {
    name: 'seo',
    type: 'group',
    fields: [{ name: 'reviewer', type: 'reference', label: 'Reviewer', collections: ['people'] }],
  },
  {
    name: 'byline',
    type: 'object',
    label: 'Byline',
    fields: [
      { name: 'person', type: 'reference', label: 'Person', collections: ['people'] },
      { name: 'note', type: 'string', label: 'Note' },
    ],
  },
  {
    name: 'credits',
    type: 'object',
    label: 'Credits',
    list: true,
    fields: [
      { name: 'people', type: 'reference', label: 'People', list: true, collections: ['people'] },
    ],
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
          { name: 'speaker', type: 'reference', label: 'Speaker', collections: ['people'] },
          {
            name: 'panel',
            type: 'object',
            label: 'Panel',
            list: true,
            fields: [
              {
                name: 'members',
                type: 'reference',
                label: 'Members',
                list: true,
                collections: ['people'],
              },
            ],
          },
        ],
      },
    ],
  },
] as EntrySchema

const draft = {
  title: 'Post',
  author: 'idTopAAAAAAA',
  contributors: ['idList1AAAAA', 'idList2AAAAA'],
  reviewer: 'idGroupAAAAA',
  byline: { person: 'idxbjectAAAA', note: 'kept' },
  credits: [{ people: ['idCreditAAAA'] }],
  blocks: [
    {
      template: 'quote',
      value: { speaker: 'idBxockAAAAA', panel: [{ members: ['idDeep1AAAAA', 'idDeep2AAAAA'] }] },
    },
  ],
}

const ALL_IDS = [
  'idTopAAAAAAA',
  'idList1AAAAA',
  'idList2AAAAA',
  'idGroupAAAAA',
  'idxbjectAAAA',
  'idCreditAAAA',
  'idBxockAAAAA',
  'idDeep1AAAAA',
  'idDeep2AAAAA',
]

const person = (id: string) => ({ id, name: `Name of ${id}` })

function cacheOf(ids: string[], branch = 'main'): ReferenceCache {
  return new Map(ids.map((id) => [`${branch}:${id}`, { value: person(id) }]))
}

describe('idsToFetch', () => {
  it('finds the ids at every reference position, nested at any depth, once each', () => {
    expect(
      idsToFetch(schema, { ...draft, author: 'idList1AAAAA' }, 'main', new Map(), 0).sort(),
    ).toEqual(ALL_IDS.filter((id) => id !== 'idTopAAAAAAA').sort())
  })

  it('skips cached ids, and a missing id until its entry expires', () => {
    const cache = cacheOf(ALL_IDS.filter((id) => id !== 'idDeep2AAAAA'))
    storeReferences(cache, 'main', new Map([['idDeep2AAAAA', null]]), 1000)

    expect(idsToFetch(schema, draft, 'main', cache, 1000)).toEqual([])
    expect(idsToFetch(schema, draft, 'main', cache, 1000 + MISSING_REFERENCE_TTL_MS)).toEqual([
      'idDeep2AAAAA',
    ])
  })

  it('treats another branch’s cache entry as absent', () => {
    expect(
      idsToFetch(schema, { author: 'idTopAAAAAAA' }, 'feature', cacheOf(['idTopAAAAAAA']), 0),
    ).toEqual(['idTopAAAAAAA'])
  })
})

describe('applyReferenceCache', () => {
  it('replaces every reference with its cached target, at every depth', () => {
    const { resolvedValue, loadingState } = applyReferenceCache(
      schema,
      draft,
      'main',
      cacheOf(ALL_IDS),
    )

    expect(resolvedValue).toEqual({
      title: 'Post',
      author: person('idTopAAAAAAA'),
      contributors: [person('idList1AAAAA'), person('idList2AAAAA')],
      reviewer: person('idGroupAAAAA'),
      byline: { person: person('idxbjectAAAA'), note: 'kept' },
      credits: [{ people: [person('idCreditAAAA')] }],
      blocks: [
        {
          template: 'quote',
          value: {
            speaker: person('idBxockAAAAA'),
            panel: [{ members: [person('idDeep1AAAAA'), person('idDeep2AAAAA')] }],
          },
        },
      ],
    })
    expect(loadingState).toEqual({
      author: false,
      contributors: [false, false],
      reviewer: false,
      byline: { person: false },
      credits: [{ people: [false] }],
      blocks: [{ value: { speaker: false, panel: [{ members: [false, false] }] } }],
    })
  })

  it('gives a reference with no cache entry null, never its bare id, and marks it loading', () => {
    const { resolvedValue, loadingState } = applyReferenceCache(schema, draft, 'main', new Map())

    expect(JSON.stringify(resolvedValue)).not.toMatch(/"id[A-Z]/)
    expect(resolvedValue.byline).toEqual({ person: null, note: 'kept' })
    expect(resolvedValue.blocks).toEqual([
      { template: 'quote', value: { speaker: null, panel: [{ members: [null, null] }] } },
    ])
    expect(loadingState.blocks).toEqual([
      { value: { speaker: true, panel: [{ members: [true, true] }] } },
    ])
    expect(loadingState.author).toBe(true)
  })

  it('gives an id the endpoint omitted null, not loading, even after it expires', () => {
    const cache: ReferenceCache = new Map()
    storeReferences(cache, 'main', new Map([['idTopAAAAAAA', null]]), 0)

    const { resolvedValue, loadingState } = applyReferenceCache(
      schema,
      { author: 'idTopAAAAAAA' },
      'main',
      cache,
    )

    expect(resolvedValue.author).toBeNull()
    expect(loadingState.author).toBe(false)
  })

  it('passes an unavailable target through as the endpoint returned it', () => {
    const missing = { id: 'idTopAAAAAAA', unavailable: true, reason: 'missing' }
    const cache: ReferenceCache = new Map()
    storeReferences(cache, 'main', new Map([['idTopAAAAAAA', missing]]), 0)

    expect(cache.get('main:idTopAAAAAAA')).toEqual({ value: missing })
    expect(
      applyReferenceCache(schema, { author: 'idTopAAAAAAA' }, 'main', cache).resolvedValue,
    ).toEqual({
      author: missing,
    })
  })

  it('gives every list item a loading entry, so isLoading arrays have no holes', () => {
    const { loadingState } = applyReferenceCache(
      schema,
      {
        credits: [{}, { people: ['idCreditAAAA'] }],
        blocks: [
          { template: 'text', value: { body: 'no references' } },
          { template: 'quote', value: { speaker: 'idBxockAAAAA' } },
        ],
      },
      'main',
      new Map(),
    )

    expect(loadingState.credits).toEqual([{ people: false }, { people: [true] }])
    expect(loadingState.blocks).toEqual([{}, { value: { speaker: true } }])
    expect(Object.keys(loadingState.blocks as unknown[])).toEqual(['0', '1'])
  })

  it('follows the server on list shapes: arrays only for list fields, non-strings to null', () => {
    const { resolvedValue, loadingState } = applyReferenceCache(
      schema,
      { author: ['idTopAAAAAAA'], contributors: ['idList1AAAAA', 7, ''] },
      'main',
      cacheOf(ALL_IDS),
    )

    expect(resolvedValue.author).toEqual(['idTopAAAAAAA'])
    expect(loadingState.author).toBe(false)
    expect(resolvedValue.contributors).toEqual([person('idList1AAAAA'), null, null])
    expect(idsToFetch(schema, { author: ['idTopAAAAAAA'] }, 'main', new Map(), 0)).toEqual([])
  })

  it('handles inline-shaped block items, whose fields sit beside the template name', () => {
    const { resolvedValue } = applyReferenceCache(
      schema,
      { blocks: [{ _type: 'quote', speaker: 'idBxockAAAAA' }] },
      'main',
      cacheOf(['idBxockAAAAA']),
    )
    expect(resolvedValue.blocks).toEqual([{ _type: 'quote', speaker: person('idBxockAAAAA') }])
  })

  it('never mutates the draft, and leaves subtrees without references as they were', () => {
    const before = JSON.parse(JSON.stringify(draft)) as typeof draft
    const withPlain = { ...draft, plain: { untouched: true } }
    const { resolvedValue } = applyReferenceCache(schema, withPlain, 'main', cacheOf(ALL_IDS))

    expect(draft).toEqual(before)
    expect(resolvedValue.plain).toBe(withPlain.plain)
    expect(resolvedValue).not.toBe(withPlain)
  })

  it('returns the draft itself, and false loading, when it holds no reference', () => {
    const value = { title: 'Post', author: '', contributors: [] }
    const { resolvedValue, loadingState } = applyReferenceCache(schema, value, 'main', new Map())

    expect(resolvedValue).toBe(value)
    expect(loadingState).toEqual({ author: false, contributors: [], reviewer: false })
  })
})

describe('fetchReferences', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = createMockApiClient()
    const { createApiClient } = await import('../api/client')
    vi.mocked(createApiClient).mockReturnValue(
      mockClient as unknown as ReturnType<typeof createApiClient>,
    )
  })

  it('asks for all ids in one request, and maps an omitted id to null', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: person('idAAAAAAAAAA') } },
    } satisfies ResolveResult)

    const found = await fetchReferences(['idAAAAAAAAAA', 'idBAAAAAAAAA'], 'main')

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)
    expect(mockClient.content.resolveReferences).toHaveBeenCalledWith(
      { branch: 'main' },
      { ids: ['idAAAAAAAAAA', 'idBAAAAAAAAA'] },
    )
    expect(found).toEqual(
      new Map<string, unknown>([
        ['idAAAAAAAAAA', person('idAAAAAAAAAA')],
        ['idBAAAAAAAAA', null],
      ]),
    )
  })

  it('returns an unavailable target as the endpoint sent it, not as missing', async () => {
    const restricted = { id: 'idAAAAAAAAAA', title: 'A', unavailable: true, reason: 'restricted' }
    const missing = { id: 'idBAAAAAAAAA', unavailable: true, reason: 'missing' }
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idAAAAAAAAAA: restricted, idBAAAAAAAAA: missing } },
    } satisfies ResolveResult)

    const found = await fetchReferences(['idAAAAAAAAAA', 'idBAAAAAAAAA'], 'main')

    expect(found.get('idAAAAAAAAAA')).toBe(restricted)
    expect(found.get('idBAAAAAAAAA')).toBe(missing)
  })

  it('splits more ids than the endpoint accepts into batches of 100', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: {} },
    } satisfies ResolveResult)
    // Base58 has no 0, so each index is spelled in letters.
    const ids = Array.from({ length: 201 }, (_, i) =>
      `b${i.toString().replace(/0/g, 'z')}`.padEnd(12, 'A'),
    )

    const found = await fetchReferences(ids, 'main')

    const batches = mockClient.content.resolveReferences.mock.calls.map(([, body]) => body.ids)
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1])
    expect(batches.flat()).toEqual(ids)
    expect(found.size).toBe(201)
  })

  it('throws when the endpoint fails, so nothing is cached as missing', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({ ok: false, status: 500 })

    await expect(fetchReferences(['idAAAAAAAAAA'], 'main')).rejects.toThrow('status 500')
  })

  it('uses the client it is given instead of creating one', async () => {
    const given = createMockApiClient()
    given.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: {} },
    } satisfies ResolveResult)

    await fetchReferences(
      ['idAAAAAAAAAA'],
      'main',
      given as unknown as Parameters<typeof fetchReferences>[2],
    )

    expect(given.content.resolveReferences).toHaveBeenCalledTimes(1)
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })
})
