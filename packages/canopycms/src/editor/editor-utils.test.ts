import { describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import type { ListEntriesResponse } from '../api/entries'
import type { EditorEntry } from './Editor'
import {
  buildEntriesFromListResponse,
  buildPreviewSrc,
  buildWritePayload,
  normalizeContentPayload,
  buildCollectionLabels,
  buildBreadcrumbSegments,
} from './editor-utils'
import type { EditorCollection } from './Editor'

describe('buildPreviewSrc', () => {
  it('returns the provided preview without modification', () => {
    const result = buildPreviewSrc(
      { previewSrc: '/custom-preview', itemType: 'entry' },
      { branchName: 'feature/test', previewBaseByCollection: { posts: '/posts' } }
    )
    expect(result).toBe('/custom-preview')
  })

  it('applies preview base and branch for entries', () => {
    const result = buildPreviewSrc(
      { collectionId: 'home', collectionName: 'home', itemType: 'entry' },
      { branchName: 'feature/nested', previewBaseByCollection: { home: '/preview/' } }
    )
    expect(result).toBe('/preview?branch=feature%2Fnested')
  })

  it('falls back to slug-based URLs and encodes branch parameters', () => {
    const result = buildPreviewSrc(
      { slug: 'nested path/post', itemType: 'entry' },
      { branchName: 'feature-1', previewBaseByCollection: undefined }
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
      })
    ).toEqual({ title: 'Post' })
  })

  it('handles nested payloads containing format/data/body', () => {
    expect(
      normalizeContentPayload({
        data: { format: 'md', data: { title: 'Post' }, body: 123 },
      })
    ).toEqual({ title: 'Post', body: '' })
  })

  it('preserves json payloads without injecting a body', () => {
    expect(
      normalizeContentPayload({
        format: 'json',
        data: { title: 'JSON Post' },
        body: 'ignored',
      })
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
      buildWritePayload({ collectionId: 'posts', slug: 'hello', format: 'json' }, { title: 'Hi' })
    ).toEqual({
      format: 'json',
      data: { title: 'Hi' },
    })
  })

  it('formats markdown-like payloads and splits body from data', () => {
    expect(
      buildWritePayload({ collectionId: 'posts', slug: 'hello', format: 'mdx' }, { title: 'Hi', body: 'Copy' })
    ).toEqual({
      format: 'mdx',
      data: { title: 'Hi' },
      body: 'Copy',
    })

    expect(
      buildWritePayload({ collectionId: 'posts', slug: 'hello', format: 'md' }, { title: 'Hi', body: 42 })
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
      type: 'singleton',
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
        itemType: 'entry',
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
        itemType: 'singleton',
        path: 'content/home.json',
        exists: false,
      },
    ],
    pagination: { hasMore: false, limit: 50 },
  }

  it('maps entries with schema, status, preview, and api paths', () => {
    const resolvePreviewSrc = vi.fn(
      (entry: { collectionId?: string; collectionName?: string; slug?: string; itemType?: string }) =>
        `preview-${entry.slug ?? 'home'}`
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

describe('buildCollectionLabels', () => {
  it('returns empty map when no collections provided', () => {
    expect(buildCollectionLabels(undefined)).toEqual(new Map())
    expect(buildCollectionLabels([])).toEqual(new Map())
  })

  it('builds flat map of collection IDs to labels', () => {
    const collections: EditorCollection[] = [
      { id: 'posts', name: 'posts', label: 'Posts', type: 'collection', format: 'mdx' },
      { id: 'pages', name: 'pages', type: 'collection', format: 'mdx' },
    ]

    const result = buildCollectionLabels(collections)

    expect(result.get('posts')).toBe('Posts')
    expect(result.get('pages')).toBe('pages') // Falls back to name when label is missing
  })

  it('handles nested collections', () => {
    const collections: EditorCollection[] = [
      {
        id: 'content',
        name: 'content',
        label: 'Content',
        type: 'collection',
        format: 'mdx',
        children: [
          {
            id: 'content/docs',
            name: 'docs',
            label: 'Documentation',
            type: 'collection',
            format: 'mdx',
            children: [
              {
                id: 'content/docs/guides',
                name: 'guides',
                label: 'Guides',
                type: 'collection',
                format: 'mdx',
              },
            ],
          },
        ],
      },
    ]

    const result = buildCollectionLabels(collections)

    expect(result.get('content')).toBe('Content')
    expect(result.get('content/docs')).toBe('Documentation')
    expect(result.get('content/docs/guides')).toBe('Guides')
  })
})

describe('buildBreadcrumbSegments', () => {
  it('returns only "All Files" when no entry is provided', () => {
    const labels = new Map<string, string>()
    expect(buildBreadcrumbSegments(undefined, labels)).toEqual(['All Files'])
  })

  it('returns only "All Files" for entry without collectionId', () => {
    const entry: EditorEntry = {
      id: 'test',
      label: 'Test',
      schema: [],
      apiPath: '/api/test',
    }
    const labels = new Map<string, string>()
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('returns "All Files" for single-level collection (root level)', () => {
    const entry: EditorEntry = {
      id: 'posts/hello',
      label: 'Hello',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'posts',
      slug: 'hello',
    }
    const labels = new Map([['posts', 'Posts']])
    // Single-level collection: parts = ['posts'], loop starts at i=1 which is >= length, so no segments added
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('shows hierarchy for nested collections', () => {
    const entry: EditorEntry = {
      id: 'content/docs/guides/config',
      label: 'Configuration Guide',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'content/docs/guides',
      slug: 'config',
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/docs', 'Documentation'],
      ['content/docs/guides', 'Guides'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should include: All Files, Documentation, Guides (skips 'Content' which is the root)
    expect(result).toEqual(['All Files', 'Documentation', 'Guides'])
  })

  it('shows hierarchy for deeply nested collections', () => {
    const entry: EditorEntry = {
      id: 'content/docs/api/v2/endpoint',
      label: 'Endpoint',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'content/docs/api/v2',
      slug: 'endpoint',
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/docs', 'Documentation'],
      ['content/docs/api', 'API Reference'],
      ['content/docs/api/v2', 'Version 2'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    expect(result).toEqual(['All Files', 'Documentation', 'API Reference', 'Version 2'])
  })

  it('skips missing labels in hierarchy', () => {
    const entry: EditorEntry = {
      id: 'content/docs/guides/config',
      label: 'Configuration Guide',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'content/docs/guides',
      slug: 'config',
    }
    const labels = new Map([
      ['content', 'Content'],
      // 'content/docs' is missing
      ['content/docs/guides', 'Guides'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should skip the missing 'Documentation' segment
    expect(result).toEqual(['All Files', 'Guides'])
  })

  it('includes slug path segments for nested slugs', () => {
    const entry: EditorEntry = {
      id: 'posts/2024/01/new-year',
      label: 'New Year Post',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'posts',
      slug: '2024/01/new-year',
    }
    const labels = new Map([['posts', 'Posts']])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should include slug path segments (minus the last one which is the file name)
    expect(result).toEqual(['All Files', '2024', '01'])
  })

  it('combines collection hierarchy and slug segments', () => {
    const entry: EditorEntry = {
      id: 'content/posts/2024/01/new-year',
      label: 'New Year Post',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'content/posts',
      slug: '2024/01/new-year',
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/posts', 'Blog Posts'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Collection hierarchy + slug segments
    expect(result).toEqual(['All Files', 'Blog Posts', '2024', '01'])
  })

  it('works for singleton entries with collection', () => {
    const entry: EditorEntry = {
      id: 'content/settings',
      label: 'Site Settings',
      schema: [],
      apiPath: '/api/test',
      collectionId: 'content/settings',
      type: 'singleton',
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/settings', 'Settings'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    expect(result).toEqual(['All Files', 'Settings'])
  })
})
