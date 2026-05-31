import { describe, expect, it } from 'vitest'
import type { CanopyBuildContext } from 'canopycms/server'
import { generateContentStaticParams } from './static'

/** Build a fake build context exposing only listEntries (all the helper touches). */
function fakeGetCanopyForBuild(items: Array<{ urlPath: string; slug: string; entryType: string }>) {
  const ctx = {
    listEntries: async () => items,
  } as unknown as CanopyBuildContext
  return async () => ctx
}

describe('generateContentStaticParams', () => {
  it('catch-all (default): emits segments arrays under "slug"', async () => {
    const get = fakeGetCanopyForBuild([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/docs/guides', slug: 'index', entryType: 'doc' },
    ])

    const params = await generateContentStaticParams(get)

    expect(params).toEqual([{ slug: ['posts', 'a'] }, { slug: ['docs', 'guides'] }])
  })

  it('single shape: emits the entry slug as a string', async () => {
    const get = fakeGetCanopyForBuild([
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
      { urlPath: '/posts/b', slug: 'b', entryType: 'post' },
    ])

    const params = await generateContentStaticParams(get, { shape: 'single' })

    expect(params).toEqual([{ slug: 'a' }, { slug: 'b' }])
  })

  it('honors a custom paramName and filter', async () => {
    const get = fakeGetCanopyForBuild([
      { urlPath: '/', slug: 'index', entryType: 'home' },
      { urlPath: '/posts/a', slug: 'a', entryType: 'post' },
    ])

    const params = await generateContentStaticParams(get, {
      paramName: 'path',
      filter: (e) => e.segments.length > 0,
    })

    expect(params).toEqual([{ path: ['posts', 'a'] }])
  })
})
