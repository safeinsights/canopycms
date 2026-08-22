import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  collectRoutableEntries,
  collectStaticPaths,
  findInvalidEntries,
  findEntriesWithUnknownKeys,
  warnUnknownEntryKeys,
  assertBuildEntriesValid,
  findDuplicateUrlPaths,
  assertNoDuplicateUrlPaths,
  findUnroutableSlugs,
  assertRoutableSlugs,
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

    // Two entries, one URL: exactly one of them gets a route and the other silently vanishes
    // from the build. Same gate, same phase, same reasoning as the schema-validity guard above.
    const contested = [
      {
        urlPath: '/docs/guides',
        slug: 'guides' as never,
        entryPath: 'content/docs/guides' as never,
      },
      {
        urlPath: '/docs/guides',
        slug: 'index' as never,
        entryPath: 'content/docs/guides/index' as never,
      },
    ]

    it('throws on a URL claimed by two entries when CANOPY_BUILD_MODE is set', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      await expect(collectStaticPaths(fakeCtx(contested))).rejects.toThrow(
        'claimed by more than one entry',
      )
    })

    it('does not throw when CANOPY_BUILD_MODE is unset, even with a contested URL', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', '')

      // `next dev` and the admin UI both enumerate mid-edit trees; only the production build fails.
      expect(await collectStaticPaths(fakeCtx(contested))).toHaveLength(2)
    })

    it('sees a collision the caller would have filtered away', async () => {
      // The guard runs on the raw listing, before `filter`. A filtered-out entry still occupies
      // its URL as far as every other route is concerned, so hiding it here would just move the
      // silent page loss somewhere the adopter cannot see it.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      await expect(
        collectStaticPaths(fakeCtx(contested), { filter: (e) => e.slug !== 'index' }),
      ).rejects.toThrow('claimed by more than one entry')
    })

    // A dotted slug is a valid on-disk filename (parseTypedFilename anchors the split on type and
    // ID, so a slug may itself contain dots) but fails parseSlug, which readByUrlPath runs on
    // every candidate slug it tries. The entry lists, builds, and gets advertised, then 404s on
    // every visit — the exact silent-page-loss shape this guard exists to make loud.
    it('throws on a listed entry whose slug cannot round-trip through a URL (e.g. contains a dot)', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')
      const ctx = fakeCtx([
        {
          urlPath: '/posts/getting.started.guide',
          slug: 'getting.started.guide' as never,
          entryType: 'post',
          entryPath: 'content/posts/getting.started.guide' as never,
        },
      ])

      await expect(collectStaticPaths(ctx)).rejects.toThrow(
        'whose slug cannot resolve back through a URL',
      )
    })

    it('does not throw on a dotted slug when CANOPY_BUILD_MODE is unset', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', '')
      const ctx = fakeCtx([
        {
          urlPath: '/posts/getting.started.guide',
          slug: 'getting.started.guide' as never,
          entryType: 'post',
          entryPath: 'content/posts/getting.started.guide' as never,
        },
      ])

      // `next dev` and the admin UI both enumerate mid-edit trees; only the production build fails.
      expect(await collectStaticPaths(ctx)).toHaveLength(1)
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

describe('warnUnknownEntryKeys output volume', () => {
  const schema: EntrySchema = [{ name: 'title', type: 'string' }]

  it('caps the listing but never the count', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      entryPath: `content/posts/p${i}` as never,
      schema,
      format: 'json' as const,
      data: { title: 'x', stale: 1 },
    }))
    const consoleSpy = mockConsole()
    try {
      warnUnknownEntryKeys(items, 'sitemap generation')
      const [message] = consoleSpy.all().warn
      expect(message).toContain('50 entries have')
      expect(message).toContain('…and 30 more')
      expect(message).toContain('content/posts/p19')
      expect(message).not.toContain('content/posts/p20')
    } finally {
      consoleSpy.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// findDuplicateUrlPaths / assertNoDuplicateUrlPaths
// ---------------------------------------------------------------------------

describe('findDuplicateUrlPaths', () => {
  const item = (urlPath: string, entryPath: string) =>
    ({ urlPath, entryPath }) as unknown as { urlPath: string; entryPath: never }

  it('returns nothing when every URL is unique', () => {
    expect(
      findDuplicateUrlPaths([
        item('/posts/a', 'content/posts/a'),
        item('/posts/b', 'content/posts/b'),
        item('/', 'content/index'),
      ]),
    ).toEqual([])
  })

  it('reports an entry colliding with a sibling collection index', () => {
    // The (b) shape: an entry slugged `guides` beside a `guides` collection that also has an
    // index entry. Both compute /docs/guides.
    expect(
      findDuplicateUrlPaths([
        item('/docs/guides', 'content/docs/guides'),
        item('/docs/guides', 'content/docs/guides/index'),
        item('/docs/overview', 'content/docs/overview'),
      ]),
    ).toEqual([
      {
        urlPath: '/docs/guides',
        entryPaths: ['content/docs/guides', 'content/docs/guides/index'],
      },
    ])
  })

  it('reports a case-only collision', () => {
    // `urlPath` is lowercased, so slugs differing only by case land on one URL. Two such files
    // cannot coexist on a case-insensitive filesystem but travel fine through git.
    expect(
      findDuplicateUrlPaths([
        item('/docs/api', 'content/docs/API'),
        item('/docs/api', 'content/docs/api'),
      ]),
    ).toEqual([{ urlPath: '/docs/api', entryPaths: ['content/docs/API', 'content/docs/api'] }])
  })

  it('reports same-slug-different-entry-type in one collection', () => {
    // The write boundary already refuses this (ContentStore.buildPaths resolves by slug across
    // entry types), but a merge can still deliver it — which is the whole reason detection lives
    // here and not only at the write path.
    expect(
      findDuplicateUrlPaths([
        item('/posts/hello', 'content/posts/hello'),
        item('/posts/hello', 'content/posts/hello'),
      ]),
    ).toEqual([
      { urlPath: '/posts/hello', entryPaths: ['content/posts/hello', 'content/posts/hello'] },
    ])
  })

  it('reports all claimants of a three-way collision, and every distinct collision', () => {
    const result = findDuplicateUrlPaths([
      item('/z', 'content/z-three'),
      item('/a', 'content/a-one'),
      item('/z', 'content/z-one'),
      item('/a', 'content/a-two'),
      item('/z', 'content/z-two'),
    ])

    // Sorted by urlPath, each claimant list sorted — listEntries resolves collections in
    // parallel, so its own order is not stable enough to assert against.
    expect(result).toEqual([
      { urlPath: '/a', entryPaths: ['content/a-one', 'content/a-two'] },
      { urlPath: '/z', entryPaths: ['content/z-one', 'content/z-three', 'content/z-two'] },
    ])
  })
})

describe('assertNoDuplicateUrlPaths', () => {
  const item = (urlPath: string, entryPath: string) =>
    ({ urlPath, entryPath }) as unknown as { urlPath: string; entryPath: never }

  it('does not throw when every URL is unique', () => {
    expect(() =>
      assertNoDuplicateUrlPaths(
        [item('/posts/a', 'content/posts/a'), item('/posts/b', 'content/posts/b')],
        'test phase',
      ),
    ).not.toThrow()
  })

  it('says "enumerated more than once" when the claimants are the same entry', () => {
    // Two sibling collections sharing a name resolve to ONE directory, so its entries are
    // listed once per sibling and both entryPaths are identical. "Rename or remove one of the
    // colliding entries" is unfollowable there — there is only one file.
    let thrown: unknown
    try {
      assertNoDuplicateUrlPaths(
        [item('/docs/a', 'content/docs/a'), item('/docs/a', 'content/docs/a')],
        'test phase',
      )
    } catch (err) {
      thrown = err
    }

    const message = (thrown as Error).message
    expect(message).toContain('enumerated more than once')
    expect(message).toContain('sibling collections sharing one name')
    expect(message).toContain('2x content/docs/a')
    // The summary header always says "claimed by more than one entry"; what must NOT appear is
    // the per-line `— claimed by a, b` form and its unfollowable remedy.
    expect(message).not.toContain('— claimed by')
  })

  it('throws one error naming every contested URL and its claimants', () => {
    let thrown: unknown
    try {
      assertNoDuplicateUrlPaths(
        [
          item('/docs/guides', 'content/docs/guides'),
          item('/docs/guides', 'content/docs/guides/index'),
          item('/docs/overview', 'content/docs/overview'),
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
    expect(message).toContain('/docs/guides')
    expect(message).toContain('content/docs/guides/index')
    expect(message).not.toContain('content/docs/overview')
  })
})

// ---------------------------------------------------------------------------
// findUnroutableSlugs / assertRoutableSlugs
// ---------------------------------------------------------------------------

describe('findUnroutableSlugs', () => {
  const item = (slug: string, urlPath: string, entryPath: string) =>
    ({ slug, urlPath, entryPath }) as unknown as {
      slug: never
      urlPath: string
      entryPath: never
    }

  it('returns nothing when every slug is routable', () => {
    expect(
      findUnroutableSlugs([
        item('hello-world', '/posts/hello-world', 'content/posts/hello-world'),
        item('index', '/docs', 'content/docs/index'),
      ]),
    ).toEqual([])
  })

  it('reports a slug containing a dot — valid on disk, rejected by parseSlug', () => {
    // The filename grammar (utils/typed-filename.ts) anchors its split on type and ID, so a slug
    // may itself contain dots. parseSlug does not allow them, and readByUrlPath runs every
    // candidate through parseSlug before trying a read.
    const result = findUnroutableSlugs([
      item(
        'getting.started.guide',
        '/posts/getting.started.guide',
        'content/posts/getting.started.guide',
      ),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      entryPath: 'content/posts/getting.started.guide',
      urlPath: '/posts/getting.started.guide',
      slug: 'getting.started.guide',
    })
    expect(result[0].error).toMatch(/lowercase letters, numbers, and hyphens/)
  })

  it('does not flag the index slug itself', () => {
    // "index" is a perfectly valid parseSlug slug (all lowercase letters) — it just also happens
    // to be the collapse marker computeEntryUrl treats specially. Nothing about routability rejects it.
    expect(findUnroutableSlugs([item('index', '/', 'content/index')])).toEqual([])
  })
})

describe('assertRoutableSlugs', () => {
  const item = (slug: string, urlPath: string, entryPath: string) =>
    ({ slug, urlPath, entryPath }) as unknown as {
      slug: never
      urlPath: string
      entryPath: never
    }

  it('does not throw when every slug is routable', () => {
    expect(() =>
      assertRoutableSlugs(
        [item('hello-world', '/posts/hello-world', 'content/posts/hello-world')],
        'test phase',
      ),
    ).not.toThrow()
  })

  it('throws one error naming every unroutable entry', () => {
    let thrown: unknown
    try {
      assertRoutableSlugs(
        [
          item(
            'getting.started.guide',
            '/posts/getting.started.guide',
            'content/posts/getting.started.guide',
          ),
          item('hello-world', '/posts/hello-world', 'content/posts/hello-world'),
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
    expect(message).toContain('content/posts/getting.started.guide')
    expect(message).not.toContain('content/posts/hello-world')
  })
})
