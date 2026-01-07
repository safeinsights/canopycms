import { describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import type { ListEntriesResponse } from '../api/entries'
import type { EditorEntry } from './Editor'
import {
  buildEntriesFromListResponse,
  buildPreviewSrc,
  buildWritePayload,
  normalizeContentPayload,
} from './editor-utils'

describe('buildPreviewSrc', () => {
  it('returns the provided preview without modification', () => {
    const result = buildPreviewSrc(
      { previewSrc: '/custom-preview', type: 'entry' },
      { branchName: 'feature/test', previewBaseByCollection: { posts: '/posts' } },
    )
    expect(result).toBe('/custom-preview')
  })

  it('applies preview base and branch for entries', () => {
    const result = buildPreviewSrc(
      { collectionId: 'home', collectionName: 'home', type: 'entry' },
      { branchName: 'feature/nested', previewBaseByCollection: { home: '/preview/' } },
    )
    expect(result).toBe('/preview?branch=feature%2Fnested')
  })

  it('falls back to slug-based URLs and encodes branch parameters', () => {
    const result = buildPreviewSrc(
      { slug: 'nested path/post', type: 'entry' },
      { branchName: 'feature-1', previewBaseByCollection: undefined },
    )
    expect(result).toBe('/nested%20path/post?branch=feature-1')
  })
})

describe('normalizeContentPayload', () => {
  it('unwraps data payloads', () => {
    expect(normalizeContentPayload({ data: { title: 'Hello' } })).toEqual({ title: 'Hello' })
  })

  it('ignores top-level format/body when data is provided separately', () => {
    expect(
      normalizeContentPayload({
        format: 'mdx',
        data: { title: 'Post' },
        body: 'Body content',
      }),
    ).toEqual({ title: 'Post' })
  })

  it('handles nested payloads containing format/data/body', () => {
    expect(
      normalizeContentPayload({
        data: { format: 'md', data: { title: 'Post' }, body: 123 },
      }),
    ).toEqual({ title: 'Post', body: '' })
  })

  it('preserves json payloads without injecting a body', () => {
    expect(
      normalizeContentPayload({
        format: 'json',
        data: { title: 'JSON Post' },
        body: 'ignored',
      }),
    ).toEqual({ title: 'JSON Post' })
  })
})

describe('buildWritePayload', () => {
  it('returns the original value when entry data is incomplete', () => {
    const value = { title: 'Draft' }
    expect(buildWritePayload({}, value)).toBe(value)
  })

  it('formats json payloads', () => {
    expect(
      buildWritePayload({ collectionId: 'posts', slug: 'hello', format: 'json' }, { title: 'Hi' }),
    ).toEqual({
      format: 'json',
      data: { title: 'Hi' },
    })
  })

  it('formats markdown-like payloads and splits body from data', () => {
    expect(
      buildWritePayload(
        { collectionId: 'posts', slug: 'hello', format: 'mdx' },
        { title: 'Hi', body: 'Copy' },
      ),
    ).toEqual({
      format: 'mdx',
      data: { title: 'Hi' },
      body: 'Copy',
    })

    expect(
      buildWritePayload(
        { collectionId: 'posts', slug: 'hello', format: 'md' },
        { title: 'Hi', body: 42 },
      ),
    ).toEqual({
      format: 'md',
      data: { title: 'Hi' },
      body: '',
    })
  })
})

describe('buildEntriesFromListResponse', () => {
  const postsSchema: FieldConfig[] = [{ name: 'title', type: 'string' }]
  const fallbackSchema: FieldConfig[] = [{ name: 'fallback', type: 'string' }]

  const existingEntries: EditorEntry[] = [
    {
      id: 'home',
      label: 'Home',
      status: 'entry',
      schema: fallbackSchema,
      apiPath: '/api/canopycms/feature-branch/content/home',
      previewSrc: '/preview/home',
      collectionId: 'home',
      collectionName: 'Home',
      slug: '',
      format: 'json',
      type: 'standalone',
    },
  ]

  const response: ListEntriesResponse = {
    collections: [
      {
        id: 'posts',
        name: 'Posts',
        path: 'posts',
        format: 'mdx',
        type: 'collection',
        schema: postsSchema,
      },
      {
        id: 'home',
        name: 'Home',
        path: 'home',
        format: 'json',
        type: 'entry',
        schema: [],
      },
    ],
    entries: [
      {
        id: 'posts/hello',
        slug: 'hello world',
        collectionId: 'posts',
        collectionName: 'Posts',
        format: 'mdx',
        type: 'entry',
        path: 'content/posts/hello-world',
        title: 'Hello Title',
        exists: true,
      },
      {
        id: 'home',
        slug: '',
        collectionId: 'home',
        collectionName: 'Home',
        format: 'json',
        type: 'standalone',
        path: 'content/home.json',
        exists: false,
      },
    ],
    pagination: { hasMore: false, limit: 50 },
  }

  it('maps entries with schema, status, preview, and api paths', () => {
    const resolvePreviewSrc = vi.fn(
      (entry: { collectionId?: string; collectionName?: string; slug?: string; type?: string }) =>
        `preview-${entry.slug ?? 'home'}`,
    )
    const result = buildEntriesFromListResponse({
      response,
      branchName: 'feature-branch',
      resolvePreviewSrc,
      existingEntries,
      initialEntries: existingEntries,
    })

    expect(result).toHaveLength(2)

    const post = result.find((item) => item.collectionId === 'posts')
    expect(post?.label).toBe('Hello Title')
    expect(post?.schema).toEqual(postsSchema)
    expect(post?.status).toBe('entry')
    expect(post?.apiPath).toBe('/api/canopycms/feature-branch/content/posts/hello%20world')
    expect(post?.previewSrc).toBe('preview-hello world')

    const home = result.find((item) => item.collectionId === 'home')
    expect(home?.schema).toEqual([])
    expect(home?.status).toBe('missing')
    expect(home?.apiPath).toBe('/api/canopycms/feature-branch/content/home')
    expect(home?.slug).toBe('')

    expect(resolvePreviewSrc).toHaveBeenCalledTimes(2)
  })

  it('falls back to existing schemas when collection metadata is missing', () => {
    const result = buildEntriesFromListResponse({
      response: { ...response, collections: response.collections.filter((c) => c.id !== 'home') },
      branchName: 'feature-branch',
      resolvePreviewSrc: () => 'preview',
      existingEntries,
      initialEntries: existingEntries,
    })

    const home = result.find((item) => item.collectionId === 'home')
    expect(home?.schema).toEqual(fallbackSchema)
  })
})
