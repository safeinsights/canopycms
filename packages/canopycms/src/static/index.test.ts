import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  collectRoutableEntries,
  collectStaticPaths,
  findInvalidEntries,
  assertBuildEntriesValid,
  type StaticPathEntry,
} from './index'
import type { ListEntriesItem, ListEntriesOptions } from '../content-listing'
import type { EntrySchema } from '../config'

/** Minimal listEntries stub returning the given items (typed loosely — only fields the helper reads). */
function fakeCtx(items: Array<Partial<ListEntriesItem>>, capture?: { rootPath?: string }) {
  return {
    listEntries: async <T = Record<string, unknown>>(options?: ListEntriesOptions<T>) => {
      if (capture) capture.rootPath = options?.rootPath
      return items as unknown as ListEntriesItem<T>[]
    },
  }
}

describe('collectStaticPaths', () => {
  it('maps urlPath to collapsed segments and carries slug + entryType', async () => {
    const ctx = fakeCtx([
      { urlPath: '/posts/hello-world', slug: 'hello-world' as never, entryType: 'post' },
      { urlPath: '/docs/guides', slug: 'index' as never, entryType: 'doc' },
    ])

    const result = await collectStaticPaths(ctx)

    expect(result).toEqual<StaticPathEntry[]>([
      {
        urlPath: '/posts/hello-world',
        segments: ['posts', 'hello-world'],
        slug: 'hello-world',
        entryType: 'post',
      },
      { urlPath: '/docs/guides', segments: ['docs', 'guides'], slug: 'index', entryType: 'doc' },
    ])
  })

  it('represents a root index ("/") as empty segments', async () => {
    const ctx = fakeCtx([{ urlPath: '/', slug: 'index' as never, entryType: 'home' }])

    const [entry] = await collectStaticPaths(ctx)

    expect(entry.segments).toEqual([])
    expect(entry.urlPath).toBe('/')
  })

  it('passes rootPath through to listEntries', async () => {
    const capture: { rootPath?: string } = {}
    const ctx = fakeCtx([], capture)

    await collectStaticPaths(ctx, { rootPath: 'content/posts' })

    expect(capture.rootPath).toBe('content/posts')
  })

  it('applies the filter predicate (e.g. drop the root index)', async () => {
    const ctx = fakeCtx([
      { urlPath: '/', slug: 'index' as never, entryType: 'home' },
      { urlPath: '/posts/a', slug: 'a' as never, entryType: 'post' },
    ])

    const result = await collectStaticPaths(ctx, { filter: (e) => e.segments.length > 0 })

    expect(result.map((e) => e.urlPath)).toEqual(['/posts/a'])
  })

  describe('build-mode guard', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    const requiredTitleSchema: EntrySchema = [{ name: 'title', type: 'string', required: true }]

    it('throws on a schema-invalid entry when CANOPY_BUILD_MODE is set', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')
      const ctx = fakeCtx([
        {
          urlPath: '/posts/draft',
          slug: 'draft' as never,
          entryType: 'post',
          entryPath: 'content/posts/draft' as never,
          format: 'json',
          schema: requiredTitleSchema,
          data: {},
        },
      ])

      await expect(collectStaticPaths(ctx)).rejects.toThrow('CanopyCMS static build:')
    })

    it('does not throw when CANOPY_BUILD_MODE is unset, even with an invalid entry', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', '')
      const ctx = fakeCtx([
        {
          urlPath: '/posts/draft',
          slug: 'draft' as never,
          entryType: 'post',
          entryPath: 'content/posts/draft' as never,
          format: 'json',
          schema: requiredTitleSchema,
          data: {},
        },
      ])

      const result = await collectStaticPaths(ctx)
      expect(result).toHaveLength(1)
    })
  })
})

describe('collectRoutableEntries', () => {
  it('carries data and updatedAt through alongside the path descriptors', async () => {
    const ctx = fakeCtx([
      {
        urlPath: '/posts/hello',
        slug: 'hello' as never,
        entryType: 'post',
        data: { title: 'Hello' },
        updatedAt: '2026-01-02T03:04:05.000Z',
      },
    ])

    const [entry] = await collectRoutableEntries(ctx)

    expect(entry).toEqual({
      urlPath: '/posts/hello',
      segments: ['posts', 'hello'],
      slug: 'hello',
      entryType: 'post',
      data: { title: 'Hello' },
      updatedAt: '2026-01-02T03:04:05.000Z',
    })
  })

  it('omits updatedAt when the listing has none, rather than emitting undefined', async () => {
    const ctx = fakeCtx([
      { urlPath: '/posts/a', slug: 'a' as never, entryType: 'post', data: { title: 'A' } },
    ])

    const [entry] = await collectRoutableEntries(ctx)

    expect('updatedAt' in entry).toBe(false)
  })

  // The regression guard for the production bug this helper exists to prevent: a sitemap built
  // from a hand-maintained list of entry types shipped with whole content types missing.
  it('enumerates EVERY entry type by default — omission must be an explicit opt-out', async () => {
    const ctx = fakeCtx([
      { urlPath: '/', slug: 'index' as never, entryType: 'home', data: {} },
      { urlPath: '/about', slug: 'about' as never, entryType: 'page', data: {} },
      { urlPath: '/blog/a', slug: 'a' as never, entryType: 'article', data: {} },
      { urlPath: '/case-studies/b', slug: 'b' as never, entryType: 'caseStudy', data: {} },
      { urlPath: '/people/c', slug: 'c' as never, entryType: 'person', data: {} },
    ])

    const entries = await collectRoutableEntries(ctx)

    expect(entries.map((e) => e.entryType).sort()).toEqual([
      'article',
      'caseStudy',
      'home',
      'page',
      'person',
    ])
  })

  it('does NOT drop noindex entries — they must still be built', async () => {
    const ctx = fakeCtx([
      { urlPath: '/stub', slug: 'stub' as never, entryType: 'page', data: { noindex: true } },
    ])

    expect(await collectRoutableEntries(ctx)).toHaveLength(1)
  })

  it('applies a filter that reads entry data', async () => {
    const ctx = fakeCtx([
      { urlPath: '/a', slug: 'a' as never, entryType: 'page', data: { published: true } },
      { urlPath: '/b', slug: 'b' as never, entryType: 'page', data: { published: false } },
    ])

    const entries = await collectRoutableEntries<{ published: boolean }>(ctx, {
      filter: (e) => e.data.published,
    })

    expect(entries.map((e) => e.urlPath)).toEqual(['/a'])
  })

  it('passes rootPath through to listEntries', async () => {
    const capture: { rootPath?: string } = {}
    const ctx = fakeCtx([], capture)

    await collectRoutableEntries(ctx, { rootPath: 'content/posts' })

    expect(capture.rootPath).toBe('content/posts')
  })

  // Inherited from the shared enumeration: sitemap generation is now another place a
  // schema-invalid entry can turn a build red.
  it('applies the same build-time schema-validity guard as collectStaticPaths', async () => {
    vi.stubEnv('CANOPY_BUILD_MODE', 'true')
    try {
      const ctx = fakeCtx([
        {
          urlPath: '/posts/draft',
          slug: 'draft' as never,
          entryType: 'post',
          entryPath: 'content/posts/draft' as never,
          format: 'json',
          schema: [{ name: 'title', type: 'string', required: true }] as EntrySchema,
          data: {},
        },
      ])

      await expect(collectRoutableEntries(ctx)).rejects.toThrow('CanopyCMS static build:')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// ---------------------------------------------------------------------------
// findInvalidEntries / assertBuildEntriesValid
// ---------------------------------------------------------------------------

describe('findInvalidEntries', () => {
  const requiredTitleSchema: EntrySchema = [{ name: 'title', type: 'string', required: true }]

  it('flags an entry with empty data whose schema has a required field', () => {
    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/draft' as never,
        schema: requiredTitleSchema,
        data: {},
      },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].entryPath).toBe('content/posts/draft')
    expect(result[0].errors.length).toBeGreaterThan(0)
    expect(result[0].errors[0].fieldPath).toBe('title')
  })

  it('passes a valid entry', () => {
    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/hello' as never,
        schema: requiredTitleSchema,
        data: { title: 'Hello' },
      },
    ])

    expect(result).toHaveLength(0)
  })

  it('skips items whose schema is undefined (unknown entry type)', () => {
    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/mystery' as never,
        schema: undefined,
        data: {},
      },
    ])

    expect(result).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Regression: the guard must validate on-disk listEntries-shaped data
  // (validateEntryData), not the editor's FormValue shape (validateEntryFormValue).
  // listEntries already merges an md/mdx body under the schema's isBody field
  // name (readEntryData in content-listing.ts) — NOT under a literal 'body' key.
  // Using validateEntryFormValue here used to remap a (nonexistent) `body` key
  // over the real content field, wiping out a fully valid entry's data and
  // reporting it as missing-required.
  // -------------------------------------------------------------------------

  it('validates a valid md entry whose schema uses a custom-named isBody field', () => {
    const customBodySchema: EntrySchema = [
      { name: 'content', type: 'markdown', isBody: true, required: true },
    ]

    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/custom-body' as never,
        schema: customBodySchema,
        // On-disk shape: listEntries merges the md body under the schema's isBody
        // field name ('content'), not under a literal 'body' key.
        data: { content: '# Hello\n\nReal body content.' },
      },
    ])

    expect(result).toHaveLength(0)
  })

  it('normalizes gray-matter Date instances (unquoted YAML dates) before validating, including nested in an object and a list item', () => {
    const dateSchema: EntrySchema = [
      { name: 'publishedAt', type: 'datetime', required: true },
      {
        name: 'meta',
        type: 'object',
        fields: [{ name: 'updatedAt', type: 'datetime', required: true }],
      },
      {
        name: 'events',
        type: 'object',
        list: true,
        fields: [{ name: 'when', type: 'datetime', required: true }],
      },
    ]

    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/hand-authored' as never,
        schema: dateSchema,
        data: {
          // gray-matter parses unquoted YAML dates into JS Date instances.
          publishedAt: new Date('2024-01-15T00:00:00.000Z'),
          meta: { updatedAt: new Date('2024-02-01T00:00:00.000Z') },
          events: [{ when: new Date('2024-03-01T00:00:00.000Z') }],
        },
      },
    ])

    expect(result).toHaveLength(0)
  })
})

describe('assertBuildEntriesValid', () => {
  const requiredTitleSchema: EntrySchema = [{ name: 'title', type: 'string', required: true }]

  it('does not throw when all entries are valid', () => {
    expect(() =>
      assertBuildEntriesValid(
        [
          {
            entryPath: 'content/posts/hello' as never,
            schema: requiredTitleSchema,
            data: { title: 'Hello' },
          },
        ],
        'test phase',
      ),
    ).not.toThrow()
  })

  it('throws one error listing every offending entryPath', () => {
    let thrown: unknown
    try {
      assertBuildEntriesValid(
        [
          {
            entryPath: 'content/posts/draft-one' as never,
            schema: requiredTitleSchema,
            data: {},
          },
          {
            entryPath: 'content/posts/draft-two' as never,
            schema: requiredTitleSchema,
            data: {},
          },
          {
            entryPath: 'content/posts/hello' as never,
            schema: requiredTitleSchema,
            data: { title: 'Hello' },
          },
        ],
        'test phase',
      )
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('CanopyCMS static build:')
    expect(message).toContain('test phase')
    expect(message).toContain('content/posts/draft-one')
    expect(message).toContain('content/posts/draft-two')
    expect(message).not.toContain('content/posts/hello')
  })
})
