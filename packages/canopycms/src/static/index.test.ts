import { describe, expect, it, vi, afterEach } from 'vitest'
import {
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

// ---------------------------------------------------------------------------
// findInvalidEntries / assertBuildEntriesValid
// ---------------------------------------------------------------------------

describe('findInvalidEntries', () => {
  const requiredTitleSchema: EntrySchema = [{ name: 'title', type: 'string', required: true }]

  it('flags an entry with empty data whose schema has a required field', () => {
    const result = findInvalidEntries([
      {
        entryPath: 'content/posts/draft' as never,
        format: 'json',
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
        format: 'json',
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
        format: 'json',
        schema: undefined,
        data: {},
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
            format: 'json',
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
            format: 'json',
            schema: requiredTitleSchema,
            data: {},
          },
          {
            entryPath: 'content/posts/draft-two' as never,
            format: 'json',
            schema: requiredTitleSchema,
            data: {},
          },
          {
            entryPath: 'content/posts/hello' as never,
            format: 'json',
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
