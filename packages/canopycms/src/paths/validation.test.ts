import { describe, it, expect } from 'vitest'
import {
  hasEmbeddedContentId,
  looksLikePhysicalPath,
  looksLikeLogicalPath,
  parseLogicalPath,
  parsePhysicalPath,
  isValidContentId,
  parseContentId,
  parseBranchName,
  parseSlug,
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

    it('normalizes backslashes to forward slashes', () => {
      const result = parseLogicalPath('content\\posts\\hello')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('content/posts/hello')
      }
    })

    it('rejects backslash-encoded traversal sequences', () => {
      const result = parseLogicalPath('content\\..\\admin')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
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

    it('rejects backslash traversal', () => {
      const result = parsePhysicalPath('content\\..\\.sensitive.abc123def456.json')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('normalizes backslashes to forward slashes', () => {
      const result = parsePhysicalPath('content\\posts\\post.hello.abc123def456.json')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('content/posts/post.hello.abc123def456.json')
      }
    })
  })

  describe('parseContentId', () => {
    it('returns typed ContentId for valid IDs', () => {
      const result = parseContentId('vh2WdhwAFiSL')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.id).toBe('vh2WdhwAFiSL')
      }
    })

    it('accepts various valid Base58 IDs', () => {
      const validIds = ['abc123def456', 'XYZabc123def', 'vh2WdhwAFiSL', '123456789ABC']
      validIds.forEach((id) => {
        const result = parseContentId(id)
        expect(result.ok).toBe(true)
      })
    })

    it('rejects empty or invalid IDs', () => {
      const result = parseContentId('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('required')
      }
    })

    it('rejects IDs with wrong length', () => {
      const result = parseContentId('abc123')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('12 Base58 characters')
      }
    })

    it('rejects IDs with invalid Base58 characters', () => {
      // 0, O, I, l are excluded from Base58
      const invalidIds = ['0abc23def456', 'Oabc23def456', 'Iabc23def456', 'labc23def456']
      invalidIds.forEach((id) => {
        const result = parseContentId(id)
        expect(result.ok).toBe(false)
      })
    })

    it('rejects IDs with special characters', () => {
      const result = parseContentId('abc-23def456')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('12 Base58 characters')
      }
    })
  })

  describe('parseBranchName', () => {
    it('returns typed BranchName for valid branch names', () => {
      const result = parseBranchName('main')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.name).toBe('main')
      }
    })

    it('accepts various valid branch names', () => {
      const validNames = ['main', 'develop', 'feature/add-dark-mode', 'fix/bug-123', 'release/v1.0']
      validNames.forEach((name) => {
        const result = parseBranchName(name)
        expect(result.ok).toBe(true)
      })
    })

    it('rejects empty branch names', () => {
      const result = parseBranchName('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('required')
      }
    })

    it('rejects branch names with double dots', () => {
      const result = parseBranchName('feature..bug')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('".."')
      }
    })

    it('rejects branch names starting or ending with slash', () => {
      let result = parseBranchName('/feature')
      expect(result.ok).toBe(false)

      result = parseBranchName('feature/')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('slash')
      }
    })

    it('rejects branch names with spaces', () => {
      const result = parseBranchName('my branch')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('space')
      }
    })

    it('rejects branch names starting or ending with dot', () => {
      let result = parseBranchName('.feature')
      expect(result.ok).toBe(false)

      result = parseBranchName('feature.')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('dot')
      }
    })

    it('rejects branch names with @{', () => {
      const result = parseBranchName('feature@{tag}')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('@{')
      }
    })

    it('rejects branch names with double slashes', () => {
      const result = parseBranchName('feature//bug')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('slash')
      }
    })

    it('rejects branch names ending with .lock', () => {
      const result = parseBranchName('feature.lock')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('.lock')
      }
    })

    it('rejects branch names with git-forbidden characters', () => {
      const forbidden = ['feat~1', 'feat^2', 'feat:bar', 'feat?x', 'feat*x', 'feat[0]', 'feat\\bar']
      forbidden.forEach((name) => {
        const result = parseBranchName(name)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('invalid characters')
        }
      })
    })

    it('rejects branch names with control characters', () => {
      const result = parseBranchName('feat\x01bar')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('invalid characters')
      }
    })

    it('rejects branch names exceeding max length', () => {
      const result = parseBranchName('a'.repeat(251))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('too long')
      }
    })

    it('accepts branch names at max length', () => {
      const result = parseBranchName('a'.repeat(250))
      expect(result.ok).toBe(true)
    })
  })

  describe('parseSlug', () => {
    describe('entry slugs', () => {
      it('returns typed Slug for valid entry slugs', () => {
        const result = parseSlug('my-first-post', 'entry')
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.slug).toBe('my-first-post')
        }
      })

      it('accepts various valid entry slugs', () => {
        const validSlugs = ['hello', 'hello-world', 'my-first-post', 'post123', '2023-update']
        validSlugs.forEach((slug) => {
          const result = parseSlug(slug, 'entry')
          expect(result.ok).toBe(true)
        })
      })

      it('rejects empty slugs', () => {
        const result = parseSlug('', 'entry')
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('required')
        }
      })

      it('rejects slugs with path separators', () => {
        let result = parseSlug('posts/hello', 'entry')
        expect(result.ok).toBe(false)

        result = parseSlug('posts\\hello', 'entry')
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('separator')
        }
      })

      it('rejects slugs not starting with alphanumeric', () => {
        const result = parseSlug('-hello', 'entry')
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('start with a letter or number')
        }
      })

      it('rejects slugs with uppercase letters', () => {
        const result = parseSlug('HelloWorld', 'entry')
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('lowercase')
        }
      })

      it('rejects slugs with special characters', () => {
        const invalidSlugs = ['hello_world', 'hello.world', 'hello world', 'hello@world']
        invalidSlugs.forEach((slug) => {
          const result = parseSlug(slug, 'entry')
          expect(result.ok).toBe(false)
        })
      })

      it('accepts slugs at exactly 64 characters', () => {
        const slug64 = 'a'.repeat(64)
        const result = parseSlug(slug64, 'entry')
        expect(result.ok).toBe(true)
      })

      it('rejects slugs longer than 64 characters', () => {
        const longSlug = 'a'.repeat(65)
        const result = parseSlug(longSlug, 'entry')
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('too long')
        }
      })
    })

    describe('collection slugs', () => {
      it('returns typed Slug for valid collection slugs', () => {
        const result = parseSlug('posts', 'collection')
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.slug).toBe('posts')
        }
      })

      it('accepts various valid collection slugs', () => {
        const validSlugs = ['posts', 'blog-posts', 'api-docs', '2023-articles']
        validSlugs.forEach((slug) => {
          const result = parseSlug(slug, 'collection')
          expect(result.ok).toBe(true)
        })
      })

      it('applies same validation rules as entry slugs', () => {
        // Empty
        let result = parseSlug('', 'collection')
        expect(result.ok).toBe(false)

        // With separator
        result = parseSlug('posts/items', 'collection')
        expect(result.ok).toBe(false)

        // Not starting with alphanumeric
        result = parseSlug('-posts', 'collection')
        expect(result.ok).toBe(false)

        // Uppercase
        result = parseSlug('Posts', 'collection')
        expect(result.ok).toBe(false)
      })
    })
  })
})
