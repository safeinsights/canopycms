import { describe, expect, it } from 'vitest'
import type { CanopyBuildContext } from 'canopycms/server'
import { collectStaticParams } from './static'

/** Build a fake build context exposing only listEntries (all the helper touches). */
function fakeBuildCtx(items: Array<{ urlPath: string; slug: string; entryType: string }>) {
  return { listEntries: async () => items } as unknown as Pick<CanopyBuildContext, 'listEntries'>
}

describe('collectStaticParams', () => {
  it('catch-all (default): emits segments arrays under "slug"', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/docs/guides', slug: 'index', entryType: 'doc' },
    ])

    const params = await collectStaticParams(ctx)

    expect(params).toEqual([{ slug: ['posts', 'a'] }, { slug: ['docs', 'guides'] }])
  })

  it('single shape: emits the entry slug as a string', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/posts/b', slug: 'b', entryType: 'post' },
    ])

    const params = await collectStaticParams(ctx, { shape: 'single' })

    expect(params).toEqual([{ slug: 'a' }, { slug: 'b' }])
  })

  it('honors a custom paramName and filter', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/', slug: 'index', entryType: 'home' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
    ])

    const params = await collectStaticParams(ctx, {
      paramName: 'path',
      filter: (e) => e.segments.length > 0,
    })

    expect(params).toEqual([{ path: ['posts', 'a'] }])
  })

  it('basePath: scopes to the prefix and makes segments relative to it (nested catch-all)', async () => {
    const ctx = fakeBuildCtx([
      { urlPath: '/docs', slug: 'index', entryType: 'doc' },
      { urlPath: '/docs/guides/intro', slug: 'intro', entryType: 'doc' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' }, // outside /docs → excluded
    ])

    const params = await collectStaticParams(ctx, { rootPath: 'content/docs', basePath: '/docs' })

    // /docs index → empty segments; /docs/guides/intro → ['guides','intro']; /posts/a excluded
    expect(params).toEqual([{ slug: [] }, { slug: ['guides', 'intro'] }])
  })

  it('basePath matches case-insensitively (urlPath is always lowercased)', async () => {
    const ctx = fakeBuildCtx([{ urlPath: '/docs/guides', slug: 'guides', entryType: 'doc' }])

    const params = await collectStaticParams(ctx, { basePath: '/Docs' })

    expect(params).toEqual([{ slug: ['guides'] }])
  })
})
