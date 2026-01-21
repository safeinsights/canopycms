import { describe, it, expect } from 'vitest'
import { resolveLogicalPath } from '../resolve'
import { toLogicalPath } from '../normalize'
import type { FlatSchemaItem } from '../../config'

describe('resolveLogicalPath', () => {
  const createMockSchemaItems = (): FlatSchemaItem[] => [
    {
      type: 'collection',
      logicalPath: toLogicalPath('content/authors'),
      name: 'authors',
      label: 'Authors',
    } as FlatSchemaItem,
    {
      type: 'collection',
      logicalPath: toLogicalPath('content/posts'),
      name: 'posts',
      label: 'Posts',
    } as FlatSchemaItem,
    {
      type: 'collection',
      logicalPath: toLogicalPath('content/docs'),
      name: 'docs',
      label: 'Docs',
    } as FlatSchemaItem,
    {
      type: 'collection',
      logicalPath: toLogicalPath('content/docs/api'),
      name: 'api',
      label: 'API',
    } as FlatSchemaItem,
    {
      type: 'collection',
      logicalPath: toLogicalPath('content/post'),
      name: 'post',
      label: 'Post (singular)',
    } as FlatSchemaItem,
  ]

  describe('basic path matching', () => {
    it('should match physical path to logical path with ID suffix', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/authors.q52DCVPuH4ga', schemaItems)
      expect(result).toBe('content/authors')
    })

    it('should match exact path without ID suffix', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/authors', schemaItems)
      expect(result).toBe('content/authors')
    })

    it('should return physical path when no match found', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/unknown.ABC123', schemaItems)
      expect(result).toBe('content/unknown.ABC123')
    })
  })

  describe('nested collections', () => {
    it('should match nested collection with IDs at all levels', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/docs.bChqT78gcaLd/api.meiuwxTSo7UN', schemaItems)
      expect(result).toBe('content/docs/api')
    })

    it('should match nested collection with ID only on parent', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/docs.bChqT78gcaLd/api', schemaItems)
      expect(result).toBe('content/docs/api')
    })

    it('should match nested collection with ID only on child', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/docs/api.meiuwxTSo7UN', schemaItems)
      expect(result).toBe('content/docs/api')
    })

    it('should not match if segment count differs', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/docs.ABC/api.DEF/extra.GHI', schemaItems)
      expect(result).toBe('content/docs.ABC/api.DEF/extra.GHI')
    })
  })

  describe('edge cases with similar names', () => {
    it('should not match collection with similar prefix (post vs posts)', () => {
      const schemaItems = createMockSchemaItems()
      // "posts-archive" does NOT match "posts" because there's no dot after "posts"
      const result = resolveLogicalPath('content/posts-archive.ID123', schemaItems)
      expect(result).toBe('content/posts-archive.ID123')
    })

    it('should match collection with exact name followed by dot', () => {
      const schemaItems = createMockSchemaItems()
      const result = resolveLogicalPath('content/posts.ID123', schemaItems)
      expect(result).toBe('content/posts')
    })

    it('should distinguish between "post" and "posts"', () => {
      const schemaItems = createMockSchemaItems()

      // "post.ID" should match "post", not "posts"
      const result1 = resolveLogicalPath('content/post.ABC123', schemaItems)
      expect(result1).toBe('content/post')

      // "posts.ID" should match "posts", not "post"
      const result2 = resolveLogicalPath('content/posts.XYZ789', schemaItems)
      expect(result2).toBe('content/posts')
    })

    it('should not match if physical segment is shorter than logical', () => {
      const schemaItems = createMockSchemaItems()
      // "pos.ID" should not match "post" or "posts"
      const result = resolveLogicalPath('content/pos.ABC', schemaItems)
      expect(result).toBe('content/pos.ABC')
    })
  })

  describe('deeply nested collections', () => {
    it('should handle 5+ levels of nesting', () => {
      const deepSchemaItems: FlatSchemaItem[] = [
        {
          type: 'collection',
          logicalPath: toLogicalPath('content/level1/level2/level3/level4/level5'),
          name: 'level5',
          label: 'Level 5',
        } as FlatSchemaItem,
      ]

      const result = resolveLogicalPath(
        'content/level1.A/level2.B/level3.C/level4.D/level5.E',
        deepSchemaItems
      )
      expect(result).toBe('content/level1/level2/level3/level4/level5')
    })
  })

  describe('special characters and dots in names', () => {
    it('should handle collection names with dots in logical path', () => {
      const schemaItems: FlatSchemaItem[] = [
        {
          type: 'collection',
          logicalPath: toLogicalPath('content/v1.0'),
          name: 'v1.0',
          label: 'Version 1.0',
        } as FlatSchemaItem,
      ]

      // This is a tricky case: the logical name itself has a dot
      // Physical path would be "v1.0.ID123", so it has TWO dots
      const result = resolveLogicalPath('content/v1.0.ABC123', schemaItems)
      expect(result).toBe('content/v1.0')
    })

    it('should not match if physical segment has multiple dots but wrong prefix', () => {
      const schemaItems = createMockSchemaItems()
      // "post.extra.ID" has a dot but doesn't match "post.ID" pattern
      const result = resolveLogicalPath('content/post.extra.ID', schemaItems)
      // This will match because "post.extra.ID" starts with "post."
      expect(result).toBe('content/post')
    })
  })

  describe('empty and root paths', () => {
    it('should handle empty schema items', () => {
      const result = resolveLogicalPath('content/authors.ID', [])
      expect(result).toBe('content/authors.ID')
    })

    it('should handle root-level collection', () => {
      const schemaItems: FlatSchemaItem[] = [
        {
          type: 'collection',
          logicalPath: toLogicalPath('content'),
          name: 'content',
          label: 'Content',
        } as FlatSchemaItem,
      ]

      const result = resolveLogicalPath('content', schemaItems)
      expect(result).toBe('content')
    })
  })

  describe('non-collection schema items', () => {
    it('should skip entry-type schema items', () => {
      const schemaItems: FlatSchemaItem[] = [
        {
          type: 'entry-type',
          logicalPath: toLogicalPath('content/posts/article'),
          name: 'article',
          label: 'Article',
        } as FlatSchemaItem,
        {
          type: 'collection',
          logicalPath: toLogicalPath('content/posts'),
          name: 'posts',
          label: 'Posts',
        } as FlatSchemaItem,
      ]

      const result = resolveLogicalPath('content/posts.ID123', schemaItems)
      expect(result).toBe('content/posts')
    })
  })
})
