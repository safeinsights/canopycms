import { describe, expect, it } from 'vitest'
import {
  validateContentPath,
  isValidCollectionPath,
  sanitizeForPath,
} from '../validation'

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

describe('isValidCollectionPath', () => {
  it('accepts valid collection paths', () => {
    expect(isValidCollectionPath('posts')).toBe(true)
    expect(isValidCollectionPath('docs/api')).toBe(true)
    expect(isValidCollectionPath('blog-posts')).toBe(true)
  })

  it('rejects collection paths with traversal', () => {
    expect(isValidCollectionPath('../evil')).toBe(false)
    expect(isValidCollectionPath('posts/../evil')).toBe(false)
  })

  it('rejects empty collection paths', () => {
    expect(isValidCollectionPath('')).toBe(false)
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
