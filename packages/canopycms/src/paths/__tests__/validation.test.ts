import { describe, expect, it } from 'vitest'
import {
  isValidSlug,
  validateContentPath,
  isValidCollectionId,
  sanitizeForPath,
} from '../validation'

describe('isValidSlug', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('my-post')).toBe(true)
    expect(isValidSlug('post_123')).toBe(true)
    expect(isValidSlug('hello-world')).toBe(true)
    expect(isValidSlug('CamelCase')).toBe(true)
    // Slugs can contain special chars except separators and traversal
    expect(isValidSlug('my post')).toBe(true)
    expect(isValidSlug('post@123')).toBe(true)
  })

  it('rejects slugs with path separators', () => {
    expect(isValidSlug('posts/my-post')).toBe(false)
    expect(isValidSlug('posts\\my-post')).toBe(false)
  })

  it('rejects traversal sequences', () => {
    expect(isValidSlug('..')).toBe(false)
    expect(isValidSlug('.')).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isValidSlug('')).toBe(false)
  })
})

describe('validateContentPath', () => {
  it('returns valid for safe paths', () => {
    const result = validateContentPath('content/posts/my-post.mdx', '/root')
    expect(result.valid).toBe(true)
  })

  it('returns invalid for traversal attempts', () => {
    const result = validateContentPath('../../../etc/passwd', '/root')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('traversal')
  })
})

describe('isValidCollectionId', () => {
  it('accepts valid collection IDs', () => {
    expect(isValidCollectionId('posts')).toBe(true)
    expect(isValidCollectionId('docs/api')).toBe(true)
    expect(isValidCollectionId('blog-posts')).toBe(true)
  })

  it('rejects collection IDs with traversal', () => {
    expect(isValidCollectionId('../evil')).toBe(false)
    expect(isValidCollectionId('posts/../evil')).toBe(false)
  })

  it('rejects empty collection IDs', () => {
    expect(isValidCollectionId('')).toBe(false)
  })
})

describe('sanitizeForPath', () => {
  it('removes invalid filesystem characters', () => {
    expect(sanitizeForPath('file<name>:test')).toBe('filenametest')
    expect(sanitizeForPath('file|name?test')).toBe('filenametest')
    expect(sanitizeForPath('file*name"test')).toBe('filenametest')
  })

  it('removes backslashes', () => {
    expect(sanitizeForPath('path\\to\\file')).toBe('pathtofile')
  })

  it('collapses multiple dots', () => {
    expect(sanitizeForPath('hello...world')).toBe('hello.world')
    expect(sanitizeForPath('a..b..c')).toBe('a.b.c')
  })

  it('removes leading dots', () => {
    expect(sanitizeForPath('.hidden')).toBe('hidden')
  })

  it('trims whitespace', () => {
    expect(sanitizeForPath('  hello  ')).toBe('hello')
  })

  it('preserves valid characters', () => {
    expect(sanitizeForPath('hello-world_123')).toBe('hello-world_123')
  })
})
