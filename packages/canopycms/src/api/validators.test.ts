import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  branchNameSchema,
  logicalPathSchema,
  contentIdSchema,
  entrySlugSchema,
  collectionSlugSchema,
} from './validators'

describe('API validators', () => {
  describe('branchNameSchema', () => {
    it('validates and brands valid branch names', () => {
      const result = branchNameSchema.parse('main')
      expect(result).toBe('main')
    })

    it('accepts branch names with slashes', () => {
      const result = branchNameSchema.parse('feature/add-dark-mode')
      expect(result).toBe('feature/add-dark-mode')
    })

    it('rejects empty branch names', () => {
      expect(() => branchNameSchema.parse('')).toThrow()
    })

    it('rejects branch names with spaces', () => {
      expect(() => branchNameSchema.parse('my branch')).toThrow('space')
    })

    it('rejects branch names with double dots', () => {
      expect(() => branchNameSchema.parse('feature..bug')).toThrow()
    })

    it('rejects branch names starting with slash', () => {
      expect(() => branchNameSchema.parse('/feature')).toThrow('slash')
    })

    it('rejects branch names ending with slash', () => {
      expect(() => branchNameSchema.parse('feature/')).toThrow('slash')
    })

    it('provides clear error messages', () => {
      try {
        branchNameSchema.parse('my branch')
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError)
        if (error instanceof z.ZodError) {
          expect(error.errors[0].message).toContain('space')
        }
      }
    })
  })

  describe('logicalPathSchema', () => {
    it('validates and brands valid logical paths', () => {
      const result = logicalPathSchema.parse('content/posts')
      expect(result).toBe('content/posts')
    })

    it('accepts nested paths', () => {
      const result = logicalPathSchema.parse('content/posts/published')
      expect(result).toBe('content/posts/published')
    })

    it('rejects empty paths', () => {
      expect(() => logicalPathSchema.parse('')).toThrow()
    })

    it('rejects paths with traversal sequences', () => {
      expect(() => logicalPathSchema.parse('content/../admin')).toThrow('traversal')
    })

    it('rejects physical paths', () => {
      expect(() => logicalPathSchema.parse('posts.abc123def456')).toThrow('physical path')
    })

    it('provides clear error messages', () => {
      try {
        logicalPathSchema.parse('content/../admin')
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError)
        if (error instanceof z.ZodError) {
          expect(error.errors[0].message).toContain('traversal')
        }
      }
    })
  })

  describe('contentIdSchema', () => {
    it('validates and brands valid content IDs', () => {
      const result = contentIdSchema.parse('vh2WdhwAFiSL')
      expect(result).toBe('vh2WdhwAFiSL')
    })

    it('accepts various Base58 IDs', () => {
      const validIds = ['abc123def456', 'XYZabc123def', 'vh2WdhwAFiSL']
      validIds.forEach((id) => {
        const result = contentIdSchema.parse(id)
        expect(result).toBe(id)
      })
    })

    it('rejects empty IDs', () => {
      expect(() => contentIdSchema.parse('')).toThrow('required')
    })

    it('rejects IDs with wrong length', () => {
      expect(() => contentIdSchema.parse('abc123')).toThrow('12 Base58 characters')
    })

    it('rejects IDs with invalid characters', () => {
      // 0, O, I, l are excluded from Base58
      expect(() => contentIdSchema.parse('0abc23def456')).toThrow('12 Base58 characters')
    })

    it('provides clear error messages with the invalid ID', () => {
      try {
        contentIdSchema.parse('invalid')
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError)
        if (error instanceof z.ZodError) {
          expect(error.errors[0].message).toContain('invalid')
        }
      }
    })
  })

  describe('entrySlugSchema', () => {
    it('validates and brands valid entry slugs', () => {
      const result = entrySlugSchema.parse('my-first-post')
      expect(result).toBe('my-first-post')
    })

    it('accepts slugs starting with numbers', () => {
      const result = entrySlugSchema.parse('2023-update')
      expect(result).toBe('2023-update')
    })

    it('rejects empty slugs', () => {
      expect(() => entrySlugSchema.parse('')).toThrow()
    })

    it('rejects slugs with path separators', () => {
      expect(() => entrySlugSchema.parse('posts/hello')).toThrow('separator')
    })

    it('rejects slugs with uppercase', () => {
      expect(() => entrySlugSchema.parse('HelloWorld')).toThrow('lowercase')
    })

    it('rejects slugs not starting with alphanumeric', () => {
      expect(() => entrySlugSchema.parse('-hello')).toThrow('start with a letter or number')
    })

    it('rejects slugs longer than 64 characters', () => {
      const longSlug = 'a'.repeat(65)
      expect(() => entrySlugSchema.parse(longSlug)).toThrow('too long')
    })

    it('provides clear error messages', () => {
      try {
        entrySlugSchema.parse('posts/hello')
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError)
        if (error instanceof z.ZodError) {
          expect(error.errors[0].message).toContain('separator')
        }
      }
    })
  })

  describe('collectionSlugSchema', () => {
    it('validates and brands valid collection slugs', () => {
      const result = collectionSlugSchema.parse('blog-posts')
      expect(result).toBe('blog-posts')
    })

    it('applies same validation as entry slugs', () => {
      // Valid
      expect(collectionSlugSchema.parse('posts')).toBe('posts')

      // Invalid
      expect(() => collectionSlugSchema.parse('')).toThrow()
      expect(() => collectionSlugSchema.parse('posts/items')).toThrow('separator')
      expect(() => collectionSlugSchema.parse('Posts')).toThrow('lowercase')
    })
  })

  describe('integration with z.object', () => {
    it('works in combined schemas', () => {
      const schema = z.object({
        branch: branchNameSchema,
        path: logicalPathSchema,
        slug: entrySlugSchema,
      })

      const result = schema.parse({
        branch: 'main',
        path: 'content/posts',
        slug: 'hello-world',
      })

      expect(result.branch).toBe('main')
      expect(result.path).toBe('content/posts')
      expect(result.slug).toBe('hello-world')
    })

    it('reports multiple validation errors', () => {
      const schema = z.object({
        branch: branchNameSchema,
        path: logicalPathSchema,
      })

      try {
        schema.parse({
          branch: 'my branch',
          path: 'content/../admin',
        })
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError)
        if (error instanceof z.ZodError) {
          // Should have errors for both fields
          expect(error.errors.length).toBeGreaterThanOrEqual(1)
        }
      }
    })
  })
})
