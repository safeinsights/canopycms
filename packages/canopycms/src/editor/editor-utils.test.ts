import { describe, expect, it, vi } from 'vitest'

import type { FieldConfig, FlatSchemaItem } from '../config'
import type { ListEntriesResponse } from '../api/entries'
import type { EditorEntry } from './Editor'
import {
  buildEntriesFromListResponse,
  buildPreviewSrc,
  buildWritePayload,
  normalizeContentPayload,
  buildCollectionLabels,
  buildBreadcrumbSegments,
  calculatePathToEntry,
  normalizeCollectionPath,
} from './editor-utils'
import type { EditorCollection } from './Editor'
import type { TreeNodeData } from '@mantine/core'
import { unsafeAsLogicalPath, unsafeAsPhysicalPath, unsafeAsContentId, unsafeAsEntrySlug } from '../paths/test-utils'

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
      { collectionPath: 'home', collectionName: 'home', itemType: 'entry' },
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

  it('includes collection path when building preview URL without base', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined }
    )
    expect(result).toBe('/docs/overview?branch=main')
  })

  it('handles nested collection paths correctly', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/docs/api', slug: 'intro', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined }
    )
    expect(result).toBe('/docs/api/intro?branch=main')
  })

  it('handles root-level collections', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/posts', slug: 'my-post', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined }
    )
    expect(result).toBe('/posts/my-post?branch=main')
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
      buildWritePayload({ collectionPath: 'posts', slug: 'hello', format: 'json' }, { title: 'Hi' })
    ).toEqual({
      format: 'json',
      data: { title: 'Hi' },
    })
  })

  it('formats markdown-like payloads and splits body from data', () => {
    expect(
      buildWritePayload({ collectionPath: 'posts', slug: 'hello', format: 'mdx' }, { title: 'Hi', body: 'Copy' })
    ).toEqual({
      format: 'mdx',
      data: { title: 'Hi' },
      body: 'Copy',
    })

    expect(
      buildWritePayload({ collectionPath: 'posts', slug: 'hello', format: 'md' }, { title: 'Hi', body: 42 })
    ).toEqual({
      format: 'md',
      data: { title: 'Hi' },
      body: '',
    })
  })
})

describe('buildEntriesFromListResponse', () => {
  const postsSchema: FieldConfig[] = [{ name: 'title', type: 'string' }]
  const pagesSchema: FieldConfig[] = [{ name: 'body', type: 'mdx' }]

  const flatSchema: FlatSchemaItem[] = [
    {
      type: 'entry-type',
      logicalPath: unsafeAsLogicalPath('posts/post'),
      name: 'post',
      parentPath: unsafeAsLogicalPath('posts'),
      format: 'mdx',
      schema: postsSchema,
    },
    {
      type: 'entry-type',
      logicalPath: unsafeAsLogicalPath('pages/page'),
      name: 'page',
      parentPath: unsafeAsLogicalPath('pages'),
      format: 'json',
      schema: pagesSchema,
    },
  ]

  const response: ListEntriesResponse = {
    entries: [
      {
        logicalPath: unsafeAsLogicalPath('posts/hello'),
        contentId: unsafeAsContentId('ghi789RST345'),
        slug: unsafeAsEntrySlug('hello world'),
        collectionPath: unsafeAsLogicalPath('posts'),
        collectionName: 'Posts',
        format: 'mdx',
        entryType: 'post',
        physicalPath: unsafeAsPhysicalPath('content/posts/hello-world'),
        title: 'Hello Title',
        exists: true,
      },
      {
        logicalPath: unsafeAsLogicalPath('pages/home'),
        contentId: unsafeAsContentId('jkl012MNO678'),
        slug: unsafeAsEntrySlug('home'),
        collectionPath: unsafeAsLogicalPath('pages'),
        collectionName: 'Pages',
        format: 'json',
        entryType: 'page',
        physicalPath: unsafeAsPhysicalPath('content/pages/home.json'),
        exists: false,
      },
    ],
    pagination: { hasMore: false, limit: 50 },
  }

  it('maps entries with schema, status, preview, and api paths', () => {
    const resolvePreviewSrc = vi.fn(
      (entry: { collectionPath?: string; collectionName?: string; slug?: string; entryType?: string }) =>
        `preview-${entry.slug ?? 'home'}`
    )
    const result = buildEntriesFromListResponse({
      response,
      branchName: 'feature-branch',
      resolvePreviewSrc,
      contentRoot: 'content',
      flatSchema,
    })

    expect(result).toHaveLength(2)

    const post = result.find((item) => item.collectionPath === 'posts')
    expect(post?.label).toBe('Hello Title')
    expect(post?.schema).toEqual(postsSchema)
    expect(post?.status).toBe('post')
    expect(post?.apiPath).toBe('/api/canopycms/feature-branch/content/posts/hello%20world')
    expect(post?.previewSrc).toBe('preview-hello world')

    const page = result.find((item) => item.collectionPath === 'pages')
    expect(page?.schema).toEqual(pagesSchema)
    expect(page?.status).toBe('missing')
    expect(page?.apiPath).toBe('/api/canopycms/feature-branch/content/pages/home')
    expect(page?.slug).toBe('home')

    expect(resolvePreviewSrc).toHaveBeenCalledTimes(2)
  })

  it('resolves schema from flatSchema by matching parentPath and entryType', () => {
    const result = buildEntriesFromListResponse({
      response,
      branchName: 'feature-branch',
      resolvePreviewSrc: () => 'preview',
      contentRoot: 'content',
      flatSchema,
    })

    const page = result.find((item) => item.collectionPath === 'pages')
    expect(page?.schema).toEqual(pagesSchema)

    const post = result.find((item) => item.collectionPath === 'posts')
    expect(post?.schema).toEqual(postsSchema)
  })

  it('returns empty schema when entry type not in flatSchema', () => {
    const result = buildEntriesFromListResponse({
      response: {
        entries: [
          {
            logicalPath: unsafeAsLogicalPath('posts/unknown'),
            contentId: unsafeAsContentId('abc123def456'),
            slug: unsafeAsEntrySlug('unknown'),
            collectionPath: unsafeAsLogicalPath('posts'),
            collectionName: 'Posts',
            format: 'mdx',
            entryType: 'unknown-type',
            physicalPath: unsafeAsPhysicalPath('content/posts/unknown'),
            exists: true,
          },
        ],
        pagination: { hasMore: false, limit: 50 },
      },
      branchName: 'main',
      resolvePreviewSrc: () => '',
      contentRoot: 'content',
      flatSchema,
    })

    expect(result[0].schema).toEqual([])
  })

  it('returns empty schema when entry missing entryType', () => {
    const result = buildEntriesFromListResponse({
      response: {
        entries: [
          {
            logicalPath: unsafeAsLogicalPath('posts/no-type'),
            contentId: 'abc123def456',
            slug: 'no-type',
            collectionPath: 'posts',
            collectionName: 'Posts',
            format: 'mdx',
            physicalPath: unsafeAsPhysicalPath('content/posts/no-type'),
            exists: true,
          } as any, // Type assertion needed to test missing entryType
        ],
        pagination: { hasMore: false, limit: 50 },
      },
      branchName: 'main',
      resolvePreviewSrc: () => '',
      contentRoot: 'content',
      flatSchema,
    })

    expect(result[0].schema).toEqual([])
  })
})

describe('buildCollectionLabels', () => {
  it('returns empty map when no collections provided', () => {
    expect(buildCollectionLabels(undefined)).toEqual(new Map())
    expect(buildCollectionLabels([])).toEqual(new Map())
  })

  it('builds flat map of collection IDs to labels', () => {
    const collections: EditorCollection[] = [
      { path: unsafeAsLogicalPath('posts'), name: 'posts', label: 'Posts', type: 'collection', format: 'mdx' },
      { path: unsafeAsLogicalPath('pages'), name: 'pages', type: 'collection', format: 'mdx' },
    ]

    const result = buildCollectionLabels(collections)

    expect(result.get('posts')).toBe('Posts')
    expect(result.get('pages')).toBe('pages') // Falls back to name when label is missing
  })

  it('handles nested collections', () => {
    const collections: EditorCollection[] = [
      {
        path: unsafeAsLogicalPath('content'),
        name: 'content',
        label: 'Content',
        type: 'collection',
        format: 'mdx',
        children: [
          {
            path: unsafeAsLogicalPath('content/docs'),
            name: 'docs',
            label: 'Documentation',
            type: 'collection',
            format: 'mdx',
            children: [
              {
                path: unsafeAsLogicalPath('content/docs/guides'),
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

  it('returns only "All Files" for entry without collectionPath', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('test'),
      label: 'Test',
      schema: [],
      apiPath: '/api/test',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map<string, string>()
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('returns "All Files" for single-level collection (root level)', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('posts/hello'),
      label: 'Hello',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('posts'),
      slug: 'hello',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([['posts', 'Posts']])
    // Single-level collection: parts = ['posts'], loop starts at i=1 which is >= length, so no segments added
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('shows hierarchy for nested collections', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/docs/guides/config'),
      label: 'Configuration Guide',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('content/docs/guides'),
      slug: 'config',
      contentId: unsafeAsContentId('test123456789'),
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
      path: unsafeAsLogicalPath('content/docs/api/v2/endpoint'),
      label: 'Endpoint',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('content/docs/api/v2'),
      slug: 'endpoint',
      contentId: unsafeAsContentId('test123456789'),
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
      path: unsafeAsLogicalPath('content/docs/guides/config'),
      label: 'Configuration Guide',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('content/docs/guides'),
      slug: 'config',
      contentId: unsafeAsContentId('test123456789'),
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
      path: unsafeAsLogicalPath('posts/2024/01/new-year'),
      label: 'New Year Post',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('posts'),
      slug: '2024/01/new-year',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([['posts', 'Posts']])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should include slug path segments (minus the last one which is the file name)
    expect(result).toEqual(['All Files', '2024', '01'])
  })

  it('combines collection hierarchy and slug segments', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/2024/01/new-year'),
      label: 'New Year Post',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      slug: '2024/01/new-year',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/posts', 'Blog Posts'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Collection hierarchy + slug segments
    expect(result).toEqual(['All Files', 'Blog Posts', '2024', '01'])
  })

  it('works for root entry types with maxItems: 1', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/settings'),
      label: 'Site Settings',
      schema: [],
      apiPath: '/api/test',
      collectionPath: unsafeAsLogicalPath('content/settings'),
      type: 'entry',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/settings', 'Settings'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    expect(result).toEqual(['All Files', 'Settings'])
  })
})

describe('calculatePathToEntry', () => {
  it('returns empty object when no entry ID is provided', () => {
    const treeData: TreeNodeData[] = []
    expect(calculatePathToEntry(undefined, treeData)).toEqual({})
    expect(calculatePathToEntry('', treeData)).toEqual({})
  })

  it('returns empty object when entry is not found in tree', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
    ]
    expect(calculatePathToEntry('posts/nonexistent', treeData)).toEqual({})
  })

  it('returns empty object for flat list (no collections)', () => {
    const treeData: TreeNodeData[] = [
      { value: 'entry1', label: 'Entry 1' },
      { value: 'entry2', label: 'Entry 2' },
    ]
    expect(calculatePathToEntry('entry1', treeData)).toEqual({})
  })

  it('expands single parent collection', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [
          { value: 'posts/hello', label: 'Hello' },
          { value: 'posts/world', label: 'World' },
        ],
      },
    ]

    const result = calculatePathToEntry('posts/hello', treeData)

    expect(result).toEqual({
      'collection:posts': true,
    })
  })

  it('expands all ancestor collections for deeply nested entry', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [
              {
                value: 'collection:content/docs/api',
                label: 'API Reference',
                children: [
                  {
                    value: 'collection:content/docs/api/v1',
                    label: 'v1',
                    children: [{ value: 'content/docs/api/v1/endpoint', label: 'Endpoint' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('content/docs/api/v1/endpoint', treeData)

    expect(result).toEqual({
      'collection:content': true,
      'collection:content/docs': true,
      'collection:content/docs/api': true,
      'collection:content/docs/api/v1': true,
    })
  })

  it('expands path across multiple root collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [{ value: 'content/docs/guide', label: 'Guide' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('content/docs/guide', treeData)

    // Should only expand collections in the path, not sibling trees
    expect(result).toEqual({
      'collection:content': true,
      'collection:content/docs': true,
    })
  })

  it('handles entry at root level within collection', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [
          { value: 'posts/entry1', label: 'Entry 1' },
          {
            value: 'collection:posts/nested',
            label: 'Nested',
            children: [{ value: 'posts/nested/entry2', label: 'Entry 2' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('posts/entry1', treeData)

    expect(result).toEqual({
      'collection:posts': true,
    })
  })

  it('does not expand unrelated collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
      {
        value: 'collection:pages',
        label: 'Pages',
        children: [{ value: 'pages/about', label: 'About' }],
      },
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [{ value: 'content/docs/guide', label: 'Guide' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('pages/about', treeData)

    // Should only expand 'pages', not 'posts' or 'content' or 'content/docs'
    expect(result).toEqual({
      'collection:pages': true,
    })
  })

  it('handles complex tree with mixed entries and collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:blog',
        label: 'Blog',
        children: [
          { value: 'blog/post1', label: 'Post 1' },
          {
            value: 'collection:blog/featured',
            label: 'Featured',
            children: [
              { value: 'blog/featured/post2', label: 'Post 2' },
              {
                value: 'collection:blog/featured/archive',
                label: 'Archive',
                children: [{ value: 'blog/featured/archive/post3', label: 'Post 3' }],
              },
            ],
          },
          { value: 'blog/post4', label: 'Post 4' },
        ],
      },
    ]

    // Find entry deep in the tree
    const result = calculatePathToEntry('blog/featured/archive/post3', treeData)

    expect(result).toEqual({
      'collection:blog': true,
      'collection:blog/featured': true,
      'collection:blog/featured/archive': true,
    })
  })
})

describe('normalizeCollectionPath', () => {
  it('strips content/ prefix from collection ID', () => {
    expect(normalizeCollectionPath('content/posts')).toBe('posts')
    expect(normalizeCollectionPath('content/docs')).toBe('docs')
  })

  it('strips content/ prefix from nested collection paths', () => {
    expect(normalizeCollectionPath('content/docs/api')).toBe('docs/api')
    expect(normalizeCollectionPath('content/docs/api/v2')).toBe('docs/api/v2')
  })

  it('returns path unchanged if no content/ prefix', () => {
    expect(normalizeCollectionPath('posts')).toBe('posts')
    expect(normalizeCollectionPath('docs/api')).toBe('docs/api')
  })

  it('only strips the first occurrence of content/', () => {
    expect(normalizeCollectionPath('content/content/posts')).toBe('content/posts')
  })

  it('handles empty string', () => {
    expect(normalizeCollectionPath('')).toBe('')
  })
})
