import { describe, expect, it } from 'vitest'
import {
  normalizeFilesystemPath,
  normalizeCollectionId,
  validateAndNormalizePath,
  hasTraversalSequence,
  createLogicalPath,
  createPhysicalPath,
  joinPath,
} from '../normalize'

describe('normalizeFilesystemPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeFilesystemPath('content\\posts\\my-post')).toBe('content/posts/my-post')
  })

  it('removes empty segments from double slashes', () => {
    expect(normalizeFilesystemPath('content//posts///my-post')).toBe('content/posts/my-post')
  })

  it('removes leading and trailing slashes', () => {
    expect(normalizeFilesystemPath('/content/posts/')).toBe('content/posts')
  })

  it('handles mixed separators', () => {
    expect(normalizeFilesystemPath('content\\\\posts//my-post')).toBe('content/posts/my-post')
  })

  it('returns empty string for empty input', () => {
    expect(normalizeFilesystemPath('')).toBe('')
  })

  it('returns empty string for only slashes', () => {
    expect(normalizeFilesystemPath('///')).toBe('')
  })
})

describe('normalizeCollectionId', () => {
  it('removes content/ prefix', () => {
    expect(normalizeCollectionId('content/posts')).toBe('posts')
  })

  it('removes content/ prefix from nested paths', () => {
    expect(normalizeCollectionId('content/docs/api')).toBe('docs/api')
  })

  it('leaves paths without content/ prefix unchanged', () => {
    expect(normalizeCollectionId('posts')).toBe('posts')
    expect(normalizeCollectionId('docs/api')).toBe('docs/api')
  })

  it('normalizes slashes before stripping prefix', () => {
    expect(normalizeCollectionId('content\\blog\\posts')).toBe('blog/posts')
  })

  it('handles custom content root', () => {
    expect(normalizeCollectionId('src/posts', 'src')).toBe('posts')
  })
})

describe('validateAndNormalizePath', () => {
  it('returns valid result for path within root', () => {
    const result = validateAndNormalizePath('/root/content', '/root/content/posts/my-post')
    expect(result.valid).toBe(true)
    expect(result.normalizedPath).toBe('posts/my-post')
  })

  it('returns valid for root itself', () => {
    const result = validateAndNormalizePath('/root/content', '/root/content')
    expect(result.valid).toBe(true)
    expect(result.normalizedPath).toBe('')
  })

  it('returns invalid for path traversal attempt', () => {
    const result = validateAndNormalizePath('/root/content', '/root/evil')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Path traversal detected')
  })

  it('returns invalid for parent directory escape', () => {
    const result = validateAndNormalizePath('/root/content', '/root/content/../evil')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Path traversal detected')
  })
})

describe('hasTraversalSequence', () => {
  it('detects double dots', () => {
    expect(hasTraversalSequence('../evil')).toBe(true)
    expect(hasTraversalSequence('content/../posts')).toBe(true)
  })

  it('returns false for safe paths', () => {
    expect(hasTraversalSequence('content/posts')).toBe(false)
    expect(hasTraversalSequence('file.name.txt')).toBe(false)
  })
})

describe('createLogicalPath', () => {
  it('joins segments with forward slashes', () => {
    expect(createLogicalPath('content', 'posts', 'my-post')).toBe('content/posts/my-post')
  })

  it('filters empty segments', () => {
    expect(createLogicalPath('content', '', 'posts')).toBe('content/posts')
  })

  it('normalizes each segment', () => {
    expect(createLogicalPath('content\\posts', 'my-post')).toBe('content/posts/my-post')
  })

  it('throws on traversal sequence', () => {
    expect(() => createLogicalPath('content', '..', 'evil')).toThrow(
      'Invalid path: contains traversal sequence',
    )
  })
})

describe('createPhysicalPath', () => {
  it('joins segments with forward slashes', () => {
    expect(createPhysicalPath('content', 'posts', 'my-post.ABC123.mdx')).toBe(
      'content/posts/my-post.ABC123.mdx',
    )
  })

  it('throws on traversal sequence', () => {
    expect(() => createPhysicalPath('content', '../evil')).toThrow(
      'Invalid path: contains traversal sequence',
    )
  })
})

describe('joinPath', () => {
  it('joins segments without validation', () => {
    expect(joinPath('content', 'posts', 'my-post')).toBe('content/posts/my-post')
  })

  it('normalizes each segment', () => {
    expect(joinPath('content\\posts', '', 'my-post')).toBe('content/posts/my-post')
  })
})
