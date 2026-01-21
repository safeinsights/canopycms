import { describe, it, expect } from 'vitest'
import {
  hasEmbeddedContentId,
  looksLikePhysicalPath,
  looksLikeLogicalPath,
  parseLogicalPath,
  parsePhysicalPath,
  isValidContentId,
} from './validation'

describe('path validation utilities', () => {
  describe('isValidContentId', () => {
    it('returns true for valid 12-char Base58 IDs', () => {
      expect(isValidContentId('abc123def456')).toBe(true)
      expect(isValidContentId('XYZabc123def')).toBe(true)
      expect(isValidContentId('vh2WdhwAFiSL')).toBe(true)
    })

    it('returns false for IDs with wrong length', () => {
      expect(isValidContentId('abc')).toBe(false)
      expect(isValidContentId('abc123def4567890')).toBe(false)
      expect(isValidContentId('')).toBe(false)
    })

    it('returns false for IDs with invalid characters', () => {
      // 0, O, I, l are excluded from Base58
      expect(isValidContentId('0abc23def456')).toBe(false)
      expect(isValidContentId('Oabc23def456')).toBe(false)
      expect(isValidContentId('Iabc23def456')).toBe(false)
      expect(isValidContentId('labc23def456')).toBe(false)
      // Special characters
      expect(isValidContentId('abc-23def456')).toBe(false)
      expect(isValidContentId('abc_23def456')).toBe(false)
    })
  })

  describe('hasEmbeddedContentId', () => {
    it('detects content ID in entry filenames', () => {
      expect(hasEmbeddedContentId('post.hello-world.vh2WdhwAFiSL.json')).toBe(true)
      expect(hasEmbeddedContentId('post.hello-world.abc123def456.mdx')).toBe(true)
      expect(hasEmbeddedContentId('home.XYZabc123def.json')).toBe(true)
    })

    it('detects content ID in collection directory names', () => {
      expect(hasEmbeddedContentId('posts.vh2WdhwAFiSL')).toBe(true)
      expect(hasEmbeddedContentId('blog.abc123def456')).toBe(true)
    })

    it('returns false for segments without content IDs', () => {
      expect(hasEmbeddedContentId('posts')).toBe(false)
      expect(hasEmbeddedContentId('hello-world')).toBe(false)
      expect(hasEmbeddedContentId('my-post.json')).toBe(false)
      expect(hasEmbeddedContentId('content')).toBe(false)
    })

    it('returns false for IDs with wrong length', () => {
      expect(hasEmbeddedContentId('post.hello.abc123.json')).toBe(false) // 6 chars
      expect(hasEmbeddedContentId('posts.abc')).toBe(false)
    })
  })

  describe('looksLikePhysicalPath', () => {
    it('identifies physical paths with embedded IDs', () => {
      expect(looksLikePhysicalPath('content/posts.vh2WdhwAFiSL/post.hello.abc123def456.json')).toBe(
        true,
      )
      expect(looksLikePhysicalPath('posts/post.hello.abc123def456.json')).toBe(true)
      expect(looksLikePhysicalPath('home.XYZabc123def.json')).toBe(true)
    })

    it('returns false for logical paths', () => {
      expect(looksLikePhysicalPath('content/posts/hello')).toBe(false)
      expect(looksLikePhysicalPath('posts/hello-world')).toBe(false)
      expect(looksLikePhysicalPath('posts')).toBe(false)
      expect(looksLikePhysicalPath('')).toBe(false)
    })
  })

  describe('looksLikeLogicalPath', () => {
    it('identifies logical paths without embedded IDs', () => {
      expect(looksLikeLogicalPath('content/posts/hello')).toBe(true)
      expect(looksLikeLogicalPath('posts/hello-world')).toBe(true)
      expect(looksLikeLogicalPath('posts')).toBe(true)
      expect(looksLikeLogicalPath('blog/posts/my-article')).toBe(true)
    })

    it('returns false for physical paths', () => {
      expect(looksLikeLogicalPath('posts.vh2WdhwAFiSL')).toBe(false)
      expect(looksLikeLogicalPath('post.hello.abc123def456.json')).toBe(false)
    })
  })

  describe('parseLogicalPath', () => {
    it('returns typed LogicalPath for valid logical paths', () => {
      const result = parseLogicalPath('posts/hello')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('posts/hello')
      }
    })

    it('rejects empty paths', () => {
      const result = parseLogicalPath('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('required')
      }
    })

    it('rejects paths with traversal sequences', () => {
      const result = parseLogicalPath('posts/../admin')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('rejects physical paths', () => {
      const result = parseLogicalPath('posts.vh2WdhwAFiSL/post.hello.abc123def456.json')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('physical path')
      }
    })
  })

  describe('parsePhysicalPath', () => {
    it('returns typed PhysicalPath for valid physical paths', () => {
      const result = parsePhysicalPath('post.hello.abc123def456.json')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('post.hello.abc123def456.json')
      }
    })

    it('rejects empty paths', () => {
      const result = parsePhysicalPath('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('required')
      }
    })

    it('rejects paths with traversal sequences', () => {
      const result = parsePhysicalPath('../post.hello.abc123def456.json')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('rejects logical paths', () => {
      const result = parsePhysicalPath('posts/hello')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('logical path')
      }
    })
  })
})
