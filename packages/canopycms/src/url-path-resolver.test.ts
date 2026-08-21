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

  it('resolves root path to index candidate', () => {
    expect(resolveUrlPathCandidates('', 'content')).toEqual([
      { entryPath: 'content', slug: 'index' },
    ])
    expect(resolveUrlPathCandidates('/', 'content')).toEqual([
      { entryPath: 'content', slug: 'index' },
    ])
    expect(resolveUrlPathCandidates('///', 'content')).toEqual([
      { entryPath: 'content', slug: 'index' },
    ])
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

  // A literal `index` segment is the one case where the direct-entry candidate is dropped: an
  // index entry's only URL is its collapsed collection path, so emitting the direct candidate
  // would let it answer at a URL no forward surface (computeEntryUrl / defaultBuildPath) ever
  // publishes. See the resolver's own doc comment.
  describe('a literal `index` segment', () => {
    it('drops the direct-entry candidate, keeping only the index fallback', () => {
      expect(resolveUrlPathCandidates('/docs/guides/index', 'content')).toEqual([
        { entryPath: 'content/docs/guides/index', slug: 'index' },
      ])
    })

    it('drops it at the content root too', () => {
      expect(resolveUrlPathCandidates('/index', 'content')).toEqual([
        { entryPath: 'content/index', slug: 'index' },
      ])
    })

    it('still resolves a collection literally named `index`', () => {
      // The surviving candidate is exactly the one that addresses that collection's own index
      // entry — the target `defaultBuildPath(kind: 'collection')` assigns the path /docs/index.
      expect(resolveUrlPathCandidates('/docs/index', 'content')).toEqual([
        { entryPath: 'content/docs/index', slug: 'index' },
      ])
    })

    it('is case-insensitive — /x/Index and /x/INDEX are the same phantom', () => {
      // This function is the ONE consumer that sees a raw URL segment; parseSlug and
      // ContentStore both lowercase downstream, so a strict compare closed `/x/index` while
      // leaving every case variant resolving the index entry it exists to hide.
      for (const variant of ['Index', 'INDEX', 'InDeX']) {
        expect(resolveUrlPathCandidates(`/docs/guides/${variant}`, 'content')).toEqual([
          { entryPath: `content/docs/guides/${variant}`, slug: 'index' },
        ])
      }
    })

    it('only applies to the LAST segment', () => {
      // `index` earlier in the path is an ordinary collection name and changes nothing.
      expect(resolveUrlPathCandidates('/index/overview', 'content')).toEqual([
        { entryPath: 'content/index', slug: 'overview' },
        { entryPath: 'content/index/overview', slug: 'index' },
      ])
    })

    it('never returns an empty candidate list', () => {
      // readByUrlPath treats an empty list as an immediate miss, so the fallback has to survive.
      for (const urlPath of ['/index', '/a/index', '/a/b/index']) {
        expect(resolveUrlPathCandidates(urlPath, 'content')).toHaveLength(1)
      }
    })
  })
})
