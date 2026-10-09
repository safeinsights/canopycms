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
  author: 'idTop',
  contributors: ['idList1', 'idList2'],
  reviewer: 'idGroup',
  byline: { person: 'idObject', note: 'kept' },
  credits: [{ people: ['idCredit'] }],
  blocks: [
    {
      template: 'quote',
      value: { speaker: 'idBlock', panel: [{ members: ['idDeep1', 'idDeep2'] }] },
    },
  ],
}

const ALL_IDS = [
  'idTop',
  'idList1',
  'idList2',
  'idGroup',
  'idObject',
  'idCredit',
  'idBlock',
  'idDeep1',
  'idDeep2',
]

const person = (id: string) => ({ id, name: `Name of ${id}` })

function cacheOf(ids: string[], branch = 'main'): ReferenceCache {
  return new Map(ids.map((id) => [`${branch}:${id}`, { value: person(id) }]))
}

describe('idsToFetch', () => {
  it('finds the ids at every reference position, nested at any depth, once each', () => {
    expect(
      idsToFetch(schema, { ...draft, author: 'idList1' }, 'main', new Map(), 0).sort(),
    ).toEqual(ALL_IDS.filter((id) => id !== 'idTop').sort())
  })

  it('skips cached ids, and a missing id until its entry expires', () => {
    const cache = cacheOf(ALL_IDS.filter((id) => id !== 'idDeep2'))
    storeReferences(cache, 'main', new Map([['idDeep2', null]]), 1000)

    expect(idsToFetch(schema, draft, 'main', cache, 1000)).toEqual([])
    expect(idsToFetch(schema, draft, 'main', cache, 1000 + MISSING_REFERENCE_TTL_MS)).toEqual([
      'idDeep2',
    ])
  })

  it('treats another branch’s cache entry as absent', () => {
    expect(idsToFetch(schema, { author: 'idTop' }, 'feature', cacheOf(['idTop']), 0)).toEqual([
      'idTop',
    ])
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
      author: person('idTop'),
      contributors: [person('idList1'), person('idList2')],
      reviewer: person('idGroup'),
      byline: { person: person('idObject'), note: 'kept' },
      credits: [{ people: [person('idCredit')] }],
      blocks: [
        {
          template: 'quote',
          value: {
            speaker: person('idBlock'),
            panel: [{ members: [person('idDeep1'), person('idDeep2')] }],
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
    storeReferences(cache, 'main', new Map([['idTop', null]]), 0)

    const { resolvedValue, loadingState } = applyReferenceCache(
      schema,
      { author: 'idTop' },
      'main',
      cache,
    )

    expect(resolvedValue.author).toBeNull()
    expect(loadingState.author).toBe(false)
  })

  it('passes an unavailable target through as the endpoint returned it', () => {
    const missing = { id: 'idTop', unavailable: true, reason: 'missing' }
    const cache: ReferenceCache = new Map()
    storeReferences(cache, 'main', new Map([['idTop', missing]]), 0)

    expect(cache.get('main:idTop')).toEqual({ value: missing })
    expect(applyReferenceCache(schema, { author: 'idTop' }, 'main', cache).resolvedValue).toEqual({
      author: missing,
    })
  })

  it('handles inline-shaped block items, whose fields sit beside the template name', () => {
    const { resolvedValue } = applyReferenceCache(
      schema,
      { blocks: [{ _type: 'quote', speaker: 'idBlock' }] },
      'main',
      cacheOf(['idBlock']),
    )
    expect(resolvedValue.blocks).toEqual([{ _type: 'quote', speaker: person('idBlock') }])
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
      data: { resolved: { idA: person('idA') } },
    } satisfies ResolveResult)

    const found = await fetchReferences(['idA', 'idB'], 'main')

    expect(mockClient.content.resolveReferences).toHaveBeenCalledTimes(1)
    expect(mockClient.content.resolveReferences).toHaveBeenCalledWith(
      { branch: 'main' },
      { ids: ['idA', 'idB'] },
    )
    expect(found).toEqual(
      new Map<string, unknown>([
        ['idA', person('idA')],
        ['idB', null],
      ]),
    )
  })

  it('returns an unavailable target as the endpoint sent it, not as missing', async () => {
    const restricted = { id: 'idA', title: 'A', unavailable: true, reason: 'restricted' }
    const missing = { id: 'idB', unavailable: true, reason: 'missing' }
    mockClient.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: { idA: restricted, idB: missing } },
    } satisfies ResolveResult)

    const found = await fetchReferences(['idA', 'idB'], 'main')

    expect(found.get('idA')).toBe(restricted)
    expect(found.get('idB')).toBe(missing)
  })

  it('splits more ids than the endpoint accepts into batches of 100', async () => {
    mockClient.content.resolveReferences.mockResolvedValue({
      ok: true,
      status: 200,
      data: { resolved: {} },
    } satisfies ResolveResult)
    const ids = Array.from({ length: 201 }, (_, i) => `id${i}`)

    const found = await fetchReferences(ids, 'main')

    const batches = mockClient.content.resolveReferences.mock.calls.map(([, body]) => body.ids)
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1])
    expect(batches.flat()).toEqual(ids)
    expect(found.size).toBe(201)
  })

  it('throws when the endpoint fails, so nothing is cached as missing', async () => {
    mockClient.content.resolveReferences.mockResolvedValueOnce({ ok: false, status: 500 })

    await expect(fetchReferences(['idA'], 'main')).rejects.toThrow('status 500')
  })

  it('uses the client it is given instead of creating one', async () => {
    const given = createMockApiClient()
    given.content.resolveReferences.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { resolved: {} },
    } satisfies ResolveResult)

    await fetchReferences(
      ['idA'],
      'main',
      given as unknown as Parameters<typeof fetchReferences>[2],
    )

    expect(given.content.resolveReferences).toHaveBeenCalledTimes(1)
    expect(mockClient.content.resolveReferences).not.toHaveBeenCalled()
  })
})
