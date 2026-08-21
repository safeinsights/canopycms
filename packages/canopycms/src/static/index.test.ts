import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  collectRoutableEntries,
  collectStaticPaths,
  findInvalidEntries,
  findEntriesWithUnknownKeys,
  warnUnknownEntryKeys,
  assertBuildEntriesValid,
  type StaticPathEntry,
} from './index'
import type { ListEntriesItem, ListEntriesOptions } from '../content-listing'
import type { EntrySchema } from '../config'
import { mockConsole } from '../test-utils/console-spy'

/** Minimal listEntries stub returning the given items (typed loosely — only fields the helper reads). */
function fakeCtx(
  items: Array<Partial<ListEntriesItem>>,
  capture?: { rootPath?: string; resolveReferences?: boolean },
) {
  return {
    listEntries: async <T = Record<string, unknown>>(options?: ListEntriesOptions<T>) => {
      if (capture) {
        capture.rootPath = options?.rootPath
        capture.resolveReferences = options?.resolveReferences
      }
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

  // Path enumeration discards `data`, so it must never opt into resolution -- doing so
  // would pay a full ContentId index scan plus a read per referenced entry for nothing.
  it('never asks listEntries to resolve references', async () => {
    const capture: { resolveReferences?: boolean } = {}
    const ctx = fakeCtx([], capture)

    await collectStaticPaths(ctx)

    expect(capture.resolveReferences).toBeUndefined()
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

    it('warns about stale keys during a build without failing it', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')
      const consoleSpy = mockConsole()
      try {
        const ctx = fakeCtx([
          {
            urlPath: '/posts/a',
            slug: 'a' as never,
            entryType: 'post',
            entryPath: 'content/posts/a' as never,
            format: 'json',
            schema: [{ name: 'title', type: 'string' }] as EntrySchema,
            data: { title: 'A', subtitle: 'renamed away' },
          },
        ])

        const result = await collectStaticPaths(ctx)
        expect(result).toHaveLength(1)
        expect(consoleSpy).toHaveWarned('subtitle')
      } finally {
        consoleSpy.restore()
      }
    })

    it('warns BEFORE the throwing guard, so a failing build still reports both', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')
      const consoleSpy = mockConsole()
      try {
        const ctx = fakeCtx([
          {
            urlPath: '/posts/draft',
            slug: 'draft' as never,
            entryType: 'post',
            entryPath: 'content/posts/draft' as never,
            format: 'json',
            schema: requiredTitleSchema,
            data: { subtitle: 'renamed away' },
          },
        ])

        await expect(collectStaticPaths(ctx)).rejects.toThrow('CanopyCMS static build:')
        expect(consoleSpy).toHaveWarned('subtitle')
      } finally {
        consoleSpy.restore()
      }
    })

    it('stays quiet outside build mode', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', '')
      const consoleSpy = mockConsole()
      try {
        const ctx = fakeCtx([
          {
            urlPath: '/posts/a',
            slug: 'a' as never,
            entryType: 'post',
            entryPath: 'content/posts/a' as never,
            format: 'json',
            schema: [{ name: 'title', type: 'string' }] as EntrySchema,
            data: { title: 'A', subtitle: 'renamed away' },
          },
        ])

        await collectStaticPaths(ctx)
        expect(consoleSpy.all().warn).toEqual([])
      } finally {
        consoleSpy.restore()
      }
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

  // `resolveReferences` reaches listEntries as a positional argument through the shared
  // `enumerateRoutableEntries`, so nothing else would go red if a refactor dropped it.
  it('passes resolveReferences through to listEntries', async () => {
    const capture: { resolveReferences?: boolean } = {}
    const ctx = fakeCtx([], capture)

    await collectRoutableEntries(ctx, { resolveReferences: true })

    expect(capture.resolveReferences).toBe(true)
  })

  it('leaves resolveReferences unset when not asked for', async () => {
    const capture: { resolveReferences?: boolean } = {}
    const ctx = fakeCtx([], capture)

    await collectRoutableEntries(ctx)

    expect(capture.resolveReferences).toBeUndefined()
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

/**
 * The inverse of `findInvalidEntries`: keys in the data with no schema counterpart. Non-fatal by
 * design — the page still renders, it is just quietly missing whatever the renamed field used to
 * supply, so a build reports rather than dies. Adopter request log item 29.
 */
describe('findEntriesWithUnknownKeys', () => {
  const schema: EntrySchema = [
    { name: 'title', type: 'string' },
    { name: 'hero', type: 'object', fields: [{ name: 'headline', type: 'string' }] },
  ]

  it('finds nothing when every key is in the schema', () => {
    expect(
      findEntriesWithUnknownKeys([
        { entryPath: 'content/posts/a' as never, schema, data: { title: 'A' } },
      ]),
    ).toEqual([])
  })

  it('reports stale keys per entry, path-qualified', () => {
    expect(
      findEntriesWithUnknownKeys([
        { entryPath: 'content/posts/a' as never, schema, data: { title: 'A' } },
        {
          entryPath: 'content/posts/b' as never,
          schema,
          data: { title: 'B', subtitle: 'stale', hero: { headline: 'H', kicker: 'also stale' } },
        },
      ]),
    ).toEqual([{ entryPath: 'content/posts/b', fieldPaths: ['subtitle', 'hero.kicker'] }])
  })

  it('does not report the md body that listEntries merges in when no isBody field is declared', () => {
    // `findBodyFieldName` falls back to the literal 'body' when a schema declares no `isBody`
    // field -- which is legal config -- and `listEntries` merges the file's prose in under that
    // name. Reporting it told the adopter their page content was a stale key to delete.
    const mdSchema: EntrySchema = [{ name: 'title', type: 'string' }]
    expect(
      findEntriesWithUnknownKeys([
        {
          entryPath: 'content/posts/a' as never,
          schema: mdSchema,
          format: 'md',
          data: { title: 'A', body: '# Prose' },
        },
      ]),
    ).toEqual([])
  })

  it('still reports other stale keys on an md entry alongside the body', () => {
    const mdSchema: EntrySchema = [{ name: 'title', type: 'string' }]
    expect(
      findEntriesWithUnknownKeys([
        {
          entryPath: 'content/posts/a' as never,
          schema: mdSchema,
          format: 'md',
          data: { title: 'A', body: '# Prose', subtitle: 'stale' },
        },
      ]),
    ).toEqual([{ entryPath: 'content/posts/a', fieldPaths: ['subtitle'] }])
  })

  it('does report a literal `body` key on a data-only entry, where nothing merges one in', () => {
    const jsonSchema: EntrySchema = [{ name: 'title', type: 'string' }]
    expect(
      findEntriesWithUnknownKeys([
        {
          entryPath: 'content/settings/a' as never,
          schema: jsonSchema,
          format: 'json',
          data: { title: 'A', body: 'stale' },
        },
      ]),
    ).toEqual([{ entryPath: 'content/settings/a', fieldPaths: ['body'] }])
  })

  it('respects a custom isBody field name', () => {
    const customBody: EntrySchema = [
      { name: 'title', type: 'string' },
      { name: 'content', type: 'markdown', isBody: true },
    ]
    expect(
      findEntriesWithUnknownKeys([
        {
          entryPath: 'content/posts/a' as never,
          schema: customBody,
          format: 'md',
          data: { title: 'A', content: '# Prose' },
        },
      ]),
    ).toEqual([])
  })

  it('skips an item whose schema could not be resolved', () => {
    expect(
      findEntriesWithUnknownKeys([
        { entryPath: 'content/posts/mystery' as never, schema: undefined, data: { any: 1 } },
      ]),
    ).toEqual([])
  })

  it('skips an item with an empty schema — no schema is not "everything is unknown"', () => {
    expect(
      findEntriesWithUnknownKeys([
        { entryPath: 'content/posts/typeless' as never, schema: [], data: { any: 1 } },
      ]),
    ).toEqual([])
  })

  it('normalizes gray-matter Date instances the same way the validity scan does', () => {
    const dateSchema: EntrySchema = [{ name: 'publishedAt', type: 'datetime' }]
    expect(
      findEntriesWithUnknownKeys([
        {
          entryPath: 'content/posts/dated' as never,
          schema: dateSchema,
          data: { publishedAt: new Date('2024-01-15') },
        },
      ]),
    ).toEqual([])
  })
})

describe('warnUnknownEntryKeys', () => {
  const schema: EntrySchema = [{ name: 'title', type: 'string' }]

  it('warns without throwing, naming the entry and the keys', () => {
    const consoleSpy = mockConsole()
    try {
      expect(() =>
        warnUnknownEntryKeys(
          [
            {
              entryPath: 'content/posts/b' as never,
              schema,
              data: { title: 'B', subtitle: 'stale' },
            },
          ],
          'sitemap generation',
        ),
      ).not.toThrow()
      expect(consoleSpy).toHaveWarned('content/posts/b')
      expect(consoleSpy).toHaveWarned('subtitle')
      expect(consoleSpy).toHaveWarned('sitemap generation')
    } finally {
      consoleSpy.restore()
    }
  })

  it('says nothing when there is nothing to say', () => {
    const consoleSpy = mockConsole()
    try {
      warnUnknownEntryKeys(
        [{ entryPath: 'content/posts/a' as never, schema, data: { title: 'A' } }],
        'sitemap generation',
      )
      expect(consoleSpy.all().warn).toEqual([])
    } finally {
      consoleSpy.restore()
    }
  })
})
