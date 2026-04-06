import { describe, it, expect } from 'vitest'
import { resolveUrlPathCandidates } from './url-path-resolver'

describe('resolveUrlPathCandidates', () => {
  it('resolves a simple slug path', () => {
    const candidates = resolveUrlPathCandidates('/getting-started', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content', slug: 'getting-started' },
      { entryPath: 'content/getting-started', slug: 'index' },
    ])
  })

  it('resolves a nested path (collection + slug)', () => {
    const candidates = resolveUrlPathCandidates('/docs/guides/getting-started', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content/docs/guides', slug: 'getting-started' },
      { entryPath: 'content/docs/guides/getting-started', slug: 'index' },
    ])
  })

  it('resolves a collection path (for index entries)', () => {
    const candidates = resolveUrlPathCandidates('/docs/guides', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content/docs', slug: 'guides' },
      { entryPath: 'content/docs/guides', slug: 'index' },
    ])
  })

  it('handles leading and trailing slashes', () => {
    const candidates = resolveUrlPathCandidates('///docs/guides///', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content/docs', slug: 'guides' },
      { entryPath: 'content/docs/guides', slug: 'index' },
    ])
  })

  it('handles no leading slash', () => {
    const candidates = resolveUrlPathCandidates('docs/guides/getting-started', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content/docs/guides', slug: 'getting-started' },
      { entryPath: 'content/docs/guides/getting-started', slug: 'index' },
    ])
  })

  it('returns empty array for empty path', () => {
    expect(resolveUrlPathCandidates('', 'content')).toEqual([])
    expect(resolveUrlPathCandidates('/', 'content')).toEqual([])
    expect(resolveUrlPathCandidates('///', 'content')).toEqual([])
  })

  it('uses custom content root', () => {
    const candidates = resolveUrlPathCandidates('/posts/hello', 'site-content')
    expect(candidates).toEqual([
      { entryPath: 'site-content/posts', slug: 'hello' },
      { entryPath: 'site-content/posts/hello', slug: 'index' },
    ])
  })

  it('handles single-segment path at content root', () => {
    const candidates = resolveUrlPathCandidates('/about', 'content')
    expect(candidates).toEqual([
      { entryPath: 'content', slug: 'about' },
      { entryPath: 'content/about', slug: 'index' },
    ])
  })
})
