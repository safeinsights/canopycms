import { describe, it, expect } from 'vitest'
import {
  resolveEntryUrl,
  resolveEntryLinksInText,
  resolveEntryLinksInData,
  extractEntryLinkIds,
} from './entry-link-resolver'
import type { IdLocation } from './content-id-index'
import type { ContentId, LogicalPath, PhysicalPath, Slug } from './paths/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocation(
  overrides: Omit<Partial<IdLocation>, 'collection' | 'slug'> & {
    collection: string
    slug: string
  },
): IdLocation {
  const { collection, slug, ...rest } = overrides
  return {
    id: 'vh2WdhwAFiSL' as ContentId,
    type: 'entry',
    relativePath: 'content/posts/post.hello.vh2WdhwAFiSL.md' as PhysicalPath,
    ...rest,
    collection: collection as LogicalPath,
    slug: slug as Slug,
  }
}

/**
 * Minimal mock of ContentIdIndex.findById for testing.
 */
function createMockIdIndex(entries: Record<string, { collection: string; slug: string }>) {
  const map = new Map<string, IdLocation>()
  for (const [id, entry] of Object.entries(entries)) {
    map.set(
      id,
      makeLocation({
        id: id as ContentId,
        collection: entry.collection,
        slug: entry.slug,
        relativePath: `${entry.collection}/${entry.slug}.${id}.md` as PhysicalPath,
      }),
    )
  }
  return {
    findById: (id: string) => map.get(id) ?? null,
  } as unknown as import('./content-id-index').ContentIdIndex
}

// ---------------------------------------------------------------------------
// resolveEntryUrl
// ---------------------------------------------------------------------------

describe('resolveEntryUrl', () => {
  it('resolves a basic entry URL', () => {
    const loc = makeLocation({ collection: 'content/posts', slug: 'hello-world' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/posts/hello-world')
  })

  it('resolves a nested collection entry', () => {
    const loc = makeLocation({ collection: 'content/docs/api/v2', slug: 'authentication' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/docs/api/v2/authentication')
  })

  it('collapses index entries to parent path', () => {
    const loc = makeLocation({ collection: 'content/docs/guides', slug: 'index' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/docs/guides')
  })

  it('handles root index entry', () => {
    const loc = makeLocation({ collection: 'content', slug: 'index' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/')
  })

  it('handles root non-index entry', () => {
    const loc = makeLocation({ collection: 'content', slug: 'about' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/about')
  })

  it('handles custom contentRoot', () => {
    const loc = makeLocation({ collection: 'site-content/posts', slug: 'hello' })
    expect(resolveEntryUrl(loc, 'site-content')).toBe('/posts/hello')
  })

  it('handles empty collection (entry at root without prefix)', () => {
    const loc = makeLocation({ collection: '', slug: 'about' })
    expect(resolveEntryUrl(loc, 'content')).toBe('/about')
  })
})

// ---------------------------------------------------------------------------
// resolveEntryLinksInText
// ---------------------------------------------------------------------------

describe('resolveEntryLinksInText', () => {
  const idx = createMockIdIndex({
    vh2WdhwAFiSL: { collection: 'content/posts', slug: 'hello-world' },
    abc123def456: { collection: 'content/docs/guides', slug: 'getting-started' },
    XYZindexENTR: { collection: 'content/docs', slug: 'index' },
  })

  it('resolves a markdown link with entry: syntax', () => {
    const text = 'See [Hello World](entry:vh2WdhwAFiSL) for details.'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(
      'See [Hello World](/posts/hello-world) for details.',
    )
  })

  it('resolves multiple entry links in the same text', () => {
    const text = 'Read [Hello](entry:vh2WdhwAFiSL) and [Guide](entry:abc123def456).'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(
      'Read [Hello](/posts/hello-world) and [Guide](/docs/guides/getting-started).',
    )
  })

  it('preserves anchor fragments', () => {
    const text = '[Section](entry:vh2WdhwAFiSL#data-governance)'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(
      '[Section](/posts/hello-world#data-governance)',
    )
  })

  it('handles index entries', () => {
    const text = '[Docs](entry:XYZindexENTR)'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe('[Docs](/docs)')
  })

  it('replaces missing IDs with # (dead link)', () => {
    // Use a valid 12-char Base58 ID that is not in the index
    const text = '[Gone](entry:ZZZZZZZZZZZz)'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe('[Gone](#)')
  })

  it('skips entry:ID inside fenced code blocks', () => {
    const text = [
      'Before link.',
      '```',
      'See [Hello](entry:vh2WdhwAFiSL)',
      '```',
      'After link [Hello](entry:vh2WdhwAFiSL).',
    ].join('\n')

    const result = resolveEntryLinksInText(text, idx, 'content')
    expect(result).toContain('See [Hello](entry:vh2WdhwAFiSL)') // inside code block: preserved
    expect(result).toContain('After link [Hello](/posts/hello-world).') // outside: resolved
  })

  it('skips entry:ID inside inline code spans', () => {
    const text = 'Use `entry:vh2WdhwAFiSL` syntax for [Hello](entry:vh2WdhwAFiSL).'
    const result = resolveEntryLinksInText(text, idx, 'content')
    expect(result).toContain('`entry:vh2WdhwAFiSL`') // inside code: preserved
    expect(result).toContain('[Hello](/posts/hello-world)') // outside: resolved
  })

  it('skips entry:ID inside triple-backtick code with language', () => {
    const text = [
      '```markdown',
      '[Hello](entry:vh2WdhwAFiSL)',
      '```',
      '[Hello](entry:vh2WdhwAFiSL)',
    ].join('\n')

    const result = resolveEntryLinksInText(text, idx, 'content')
    const lines = result.split('\n')
    expect(lines[1]).toBe('[Hello](entry:vh2WdhwAFiSL)') // inside code block
    expect(lines[3]).toBe('[Hello](/posts/hello-world)') // outside code block
  })

  it('handles entry:ID in JSX props', () => {
    const text = '<Link href="entry:vh2WdhwAFiSL">Hello</Link>'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(
      '<Link href="/posts/hello-world">Hello</Link>',
    )
  })

  it('handles entry:ID with anchor in JSX props', () => {
    const text = '<Link href="entry:vh2WdhwAFiSL#section">Hello</Link>'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(
      '<Link href="/posts/hello-world#section">Hello</Link>',
    )
  })

  it('uses custom resolver when provided', () => {
    const text = '[Hello](entry:vh2WdhwAFiSL)'
    const customResolver = (entry: { collection: string; slug: string; id: string }) =>
      `/custom/${entry.slug}`
    expect(resolveEntryLinksInText(text, idx, 'content', customResolver)).toBe(
      '[Hello](/custom/hello-world)',
    )
  })

  it('handles text with no entry links', () => {
    const text = 'Just a [normal link](https://example.com) and some text.'
    expect(resolveEntryLinksInText(text, idx, 'content')).toBe(text)
  })

  it('handles empty string', () => {
    expect(resolveEntryLinksInText('', idx, 'content')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// extractEntryLinkIds
// ---------------------------------------------------------------------------

describe('extractEntryLinkIds', () => {
  it('extracts IDs from markdown links', () => {
    const text = '[Hello](entry:vh2WdhwAFiSL) and [Guide](entry:abc123def456)'
    const ids = extractEntryLinkIds(text)
    expect(ids).toEqual([
      { id: 'vh2WdhwAFiSL', anchor: undefined },
      { id: 'abc123def456', anchor: undefined },
    ])
  })

  it('extracts IDs with anchor fragments', () => {
    const text = '[Hello](entry:vh2WdhwAFiSL#section-one)'
    const ids = extractEntryLinkIds(text)
    expect(ids).toEqual([{ id: 'vh2WdhwAFiSL', anchor: '#section-one' }])
  })

  it('skips IDs inside code blocks', () => {
    const text = ['```', 'entry:vh2WdhwAFiSL', '```', '[Real](entry:abc123def456)'].join('\n')
    const ids = extractEntryLinkIds(text)
    expect(ids).toEqual([{ id: 'abc123def456', anchor: undefined }])
  })

  it('skips IDs inside inline code', () => {
    const text = '`entry:vh2WdhwAFiSL` and [Real](entry:abc123def456)'
    const ids = extractEntryLinkIds(text)
    expect(ids).toEqual([{ id: 'abc123def456', anchor: undefined }])
  })

  it('returns empty array for text without entry links', () => {
    expect(extractEntryLinkIds('No links here.')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveEntryLinksInData
// ---------------------------------------------------------------------------

describe('resolveEntryLinksInData', () => {
  const idx = createMockIdIndex({
    vh2WdhwAFiSL: { collection: 'content/posts', slug: 'hello-world' },
    abc123def456: { collection: 'content/docs/guides', slug: 'getting-started' },
  })

  it('resolves entry links in nested object fields', () => {
    const data = {
      title: 'Home',
      hero: {
        heading: 'Welcome',
        body: 'See [Hello](entry:vh2WdhwAFiSL) for more.',
      },
    }
    const result = resolveEntryLinksInData(data, idx, 'content') as typeof data
    expect(result.hero.body).toBe('See [Hello](/posts/hello-world) for more.')
    expect(result.title).toBe('Home') // unchanged
    expect(result.hero.heading).toBe('Welcome') // unchanged
  })

  it('resolves entry links in arrays', () => {
    const data = {
      blocks: [
        { type: 'text', content: 'Read [Guide](entry:abc123def456)' },
        { type: 'image', src: '/photo.jpg' },
      ],
    }
    const result = resolveEntryLinksInData(data, idx, 'content') as typeof data
    expect(result.blocks[0].content).toBe('Read [Guide](/docs/guides/getting-started)')
    expect(result.blocks[1].src).toBe('/photo.jpg') // unchanged
  })

  it('returns same reference when nothing changes', () => {
    const data = { title: 'No links', count: 42 }
    const result = resolveEntryLinksInData(data, idx, 'content')
    expect(result).toBe(data) // exact same object
  })

  it('handles deeply nested structures', () => {
    const data = {
      sections: [
        {
          items: [{ label: '[Hello](entry:vh2WdhwAFiSL)' }],
        },
      ],
    }
    const result = resolveEntryLinksInData(data, idx, 'content') as typeof data
    expect(result.sections[0].items[0].label).toBe('[Hello](/posts/hello-world)')
  })

  it('handles null and non-object values', () => {
    expect(resolveEntryLinksInData(null, idx, 'content')).toBe(null)
    expect(resolveEntryLinksInData(42, idx, 'content')).toBe(42)
    expect(resolveEntryLinksInData(true, idx, 'content')).toBe(true)
  })
})
