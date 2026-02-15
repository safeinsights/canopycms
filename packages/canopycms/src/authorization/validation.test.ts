import { describe, it, expect } from 'vitest'
import { parsePermissionPath } from './validation'

describe('authorization validation', () => {
  describe('parsePermissionPath', () => {
    it('returns typed PermissionPath for valid paths', () => {
      const result = parsePermissionPath('content/posts')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('content/posts')
      }
    })

    it('accepts various valid permission paths', () => {
      const validPaths = [
        'content',
        'content/posts',
        'content/posts/published',
        'content/settings/config',
        'assets/images',
      ]
      validPaths.forEach((path) => {
        const result = parsePermissionPath(path)
        expect(result.ok).toBe(true)
      })
    })

    it('rejects empty paths', () => {
      const result = parsePermissionPath('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('required')
      }
    })

    it('rejects paths with traversal sequences', () => {
      const result = parsePermissionPath('content/../admin')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('rejects paths with double-dot at start', () => {
      const result = parsePermissionPath('../content')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('rejects paths with double-dot at end', () => {
      const result = parsePermissionPath('content/..')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })

    it('rejects paths starting with slash', () => {
      const result = parsePermissionPath('/content/posts')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('start')
      }
    })

    it('rejects paths ending with slash', () => {
      const result = parsePermissionPath('content/posts/')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('end')
      }
    })

    it('rejects paths with consecutive slashes', () => {
      const result = parsePermissionPath('content//posts')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('consecutive')
      }
    })

    it('normalizes backslashes to forward slashes', () => {
      const result = parsePermissionPath('content\\posts')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('content/posts')
      }
    })

    it('prevents bypass via backslashes with traversal', () => {
      const result = parsePermissionPath('content\\..\\admin')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('traversal')
      }
    })
  })
})
