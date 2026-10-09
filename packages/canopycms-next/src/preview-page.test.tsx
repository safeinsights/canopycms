import type { AsyncLocalStorage } from 'node:async_hooks'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopyContext } from 'canopycms/server'
import { notFound } from 'next/navigation'
import { ANONYMOUS_USER, assetUrl } from 'canopycms'
import type { PreviewLoadContext } from './preview-page'

const NOT_FOUND = 'NEXT_NOT_FOUND'
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND)
  },
}))

// React's `cache` as a server renders it: memoized per request, and not at all outside one. Each
// test's render runs inside `inRequest`, as a Next request does.
const server = vi.hoisted(() => ({ request: undefined as AsyncLocalStorage<object> | undefined }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const { AsyncLocalStorage: Storage } = await import('node:async_hooks')
  const requests = (server.request ??= new Storage<object>())
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new WeakMap<object, R>()
    return (...args: A): R => {
      const request = requests.getStore()
      if (!request) return fn(...args)
      if (!memo.has(request)) memo.set(request, fn(...args))
      return memo.get(request) as R
    }
  }
  return { ...actual, cache }
})
const inRequest = <R,>(fn: () => R): R => server.request!.run({}, fn)

const RAW_BASE = '/api/canopycms/assets/raw'
const CROP = { src: '/assets/t/orig/0123456789abcdef0123456789abcdef/photo.jpg' }
const CROP_AT_320 = '/assets/t/w=320/0123456789abcdef0123456789abcdef/photo.jpg'

const { createPreviewPageFor, previewView } = await import('./preview-page')

const PostView = () => null
const DocView = () => null
const views = { post: PostView, doc: DocView }

const readByUrlPath = vi.fn()
const signedIn = { type: 'authenticated', userId: 'editor-1', groups: [] }
const canopy = { readByUrlPath, user: signedIn } as unknown as CanopyContext
const getCanopy = vi.fn(async () => canopy)

const entry = (
  entryType: string,
  data: unknown = { title: 'Hello' },
  at: { slug: string; urlPath: string } = { slug: 'hello', urlPath: '/posts/hello' },
) => ({
  data,
  // Not derived from urlPath, so a page that parsed urlPath out of path would fail.
  path: '/link?branch=feature%2Fx',
  meta: { entryType, entryId: 'abc', physicalPath: '/srv/workspace/secret/post.md', ...at },
})

const render = (path: string[] | undefined, query: Record<string, string | string[]> = {}) =>
  inRequest(() =>
    createPreviewPageFor(getCanopy, { views })({
      params: Promise.resolve(path === undefined ? {} : { path }),
      searchParams: Promise.resolve(query),
    }),
  )

const anonymously = () => {
  getCanopy.mockResolvedValueOnce({
    readByUrlPath,
    user: ANONYMOUS_USER,
  } as unknown as CanopyContext)
}

beforeEach(() => {
  readByUrlPath.mockReset()
  getCanopy.mockReset()
  getCanopy.mockResolvedValue(canopy)
})

describe('createPreviewPageFor', () => {
  it("reads the route's path from the requested branch and renders the entry type's view", async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await render(['posts', 'hello'], { branch: 'feature/x' })) as ReactElement<
      Record<string, unknown>
    >

    expect(readByUrlPath).toHaveBeenCalledWith('/posts/hello', { branch: 'feature/x' })
    expect(element.type).toBe(PostView)
    expect(element.props).toEqual({
      initialData: { title: 'Hello' },
      editorOrigin: undefined,
      previewAssetBase: RAW_BASE,
    })
  })

  it('hands the client only the entry data, never the server-only meta', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await render(['posts', 'hello'])) as ReactElement<Record<string, unknown>>

    expect(JSON.stringify(element.props)).not.toContain('/srv/workspace')
  })

  it('reads the root entry for the bare prefix, on the active branch when none is named', async () => {
    readByUrlPath.mockResolvedValue(entry('doc'))

    const element = (await render(undefined)) as ReactElement<Record<string, unknown>>

    expect(readByUrlPath).toHaveBeenCalledWith('/', { branch: undefined })
    expect(element.type).toBe(DocView)
  })

  it('passes a configured editorOrigin to the view', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await createPreviewPageFor(getCanopy, {
      views,
      editorOrigin: 'https://cms.example.com',
    })({
      params: Promise.resolve({ path: ['posts', 'hello'] }),
      searchParams: Promise.resolve({}),
    })) as ReactElement<Record<string, unknown>>

    expect(element.props.editorOrigin).toBe('https://cms.example.com')
  })

  it('is a 404 when the read finds nothing: a missing path, or a missing or denied branch', async () => {
    readByUrlPath.mockResolvedValue(null)

    await expect(render(['posts', 'nope'], { branch: 'hidden' })).rejects.toThrow(NOT_FOUND)
  })

  it('is a 404 for an anonymous request, without reading, though ACLs would grant the read', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))
    anonymously()

    await expect(render(['posts', 'hello'])).rejects.toThrow(NOT_FOUND)
    expect(readByUrlPath).not.toHaveBeenCalled()
  })

  it('is a 404 for a repeated ?branch=, without reading', async () => {
    await expect(render(['posts', 'hello'], { branch: ['a', 'b'] })).rejects.toThrow(NOT_FOUND)
    expect(getCanopy).not.toHaveBeenCalled()
    expect(readByUrlPath).not.toHaveBeenCalled()
  })

  it("is a 404 on a deployedAs: 'static' deployment, without reading", async () => {
    readByUrlPath.mockResolvedValue(entry('post'))
    const page = createPreviewPageFor(getCanopy, { views }, { deployedAs: 'static' })

    await expect(
      page({
        params: Promise.resolve({ path: ['posts', 'hello'] }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(NOT_FOUND)
    expect(getCanopy).not.toHaveBeenCalled()
  })

  it.each(['author', 'constructor', 'toString', '__proto__'])(
    'is a 404 for an entry type with no view of its own: %s',
    async (entryType) => {
      readByUrlPath.mockResolvedValue(entry(entryType))

      await expect(render(['authors', 'alice'])).rejects.toThrow(NOT_FOUND)
    },
  )
})

describe('createPreviewPageFor with a loader', () => {
  type Extras = { related: string[] }
  const ExtrasView = (props: { extras?: Extras }) => <>{props.extras?.related}</>
  const pageWith = (
    load: (ctx: PreviewLoadContext) => Extras | Promise<Extras>,
    deployedAs?: 'static',
  ) =>
    createPreviewPageFor(
      getCanopy,
      { views: { post: previewView({ view: ExtrasView, load }), doc: DocView } },
      { deployedAs },
    )
  const props = (path: string[], query: Record<string, string | string[]> = {}) => ({
    params: Promise.resolve({ path }),
    searchParams: Promise.resolve(query),
  })

  it("hands the loader the entry, the request's canopy and the branch, and its result to the view as extras", async () => {
    const found = entry('post')
    readByUrlPath.mockResolvedValue(found)
    const load = vi.fn(() => ({ related: ['a', 'b'] }))

    const element = (await pageWith(load)(
      props(['posts', 'hello'], { branch: 'feature/x' }),
    )) as ReactElement<Record<string, unknown>>

    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith({
      entry: {
        data: found.data,
        slug: 'hello',
        urlPath: '/posts/hello',
        path: '/link?branch=feature%2Fx',
        entryType: 'post',
        entryId: 'abc',
      },
      canopy,
      branch: 'feature/x',
    })
    expect(element.type).toBe(ExtrasView)
    expect(element.props).toEqual({
      initialData: { title: 'Hello' },
      editorOrigin: undefined,
      extras: { related: ['a', 'b'] },
      previewAssetBase: RAW_BASE,
    })
  })

  it("hands the loader an index entry's slug and its collection's URL path", async () => {
    readByUrlPath.mockResolvedValue(entry('post', undefined, { slug: 'index', urlPath: '/posts' }))
    const load = vi.fn(() => ({ related: [] }))

    await pageWith(load)(props(['posts'], { branch: 'feature/x' }))

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ slug: 'index', urlPath: '/posts' }),
      }),
    )
  })

  it('gives the loader no server-only meta, so returning the whole entry cannot leak it', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await pageWith(({ entry: e }) => ({ related: [], e }))(
      props(['posts', 'hello']),
    )) as ReactElement<Record<string, unknown>>

    expect(JSON.stringify(element.props.extras)).toContain('"entryType":"post"')
    expect(JSON.stringify(element.props.extras)).not.toContain('/srv/workspace')
  })

  it('awaits an async loader', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await pageWith(async () => ({ related: ['later'] }))(
      props(['posts', 'hello']),
    )) as ReactElement<Record<string, unknown>>

    expect(element.props.extras).toEqual({ related: ['later'] })
  })

  it('still gives a bare view in the same record no extras prop', async () => {
    readByUrlPath.mockResolvedValue(entry('doc'))
    const load = vi.fn(() => ({ related: [] }))

    const element = (await pageWith(load)(props(['docs', 'x']))) as ReactElement<
      Record<string, unknown>
    >

    expect(element.type).toBe(DocView)
    expect('extras' in element.props).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  describe('never runs the loader', () => {
    it('for an entry type with no view', async () => {
      readByUrlPath.mockResolvedValue(entry('author'))
      const load = vi.fn(() => ({ related: [] }))

      await expect(pageWith(load)(props(['authors', 'alice']))).rejects.toThrow(NOT_FOUND)
      expect(load).not.toHaveBeenCalled()
    })

    it('when the read finds nothing', async () => {
      readByUrlPath.mockResolvedValue(null)
      const load = vi.fn(() => ({ related: [] }))

      await expect(pageWith(load)(props(['posts', 'nope']))).rejects.toThrow(NOT_FOUND)
      expect(load).not.toHaveBeenCalled()
    })

    it('for an anonymous request', async () => {
      readByUrlPath.mockResolvedValue(entry('post'))
      const load = vi.fn(() => ({ related: [] }))
      anonymously()

      await expect(pageWith(load)(props(['posts', 'hello']))).rejects.toThrow(NOT_FOUND)
      expect(load).not.toHaveBeenCalled()
    })

    it('for a repeated ?branch=', async () => {
      readByUrlPath.mockResolvedValue(entry('post'))
      const load = vi.fn(() => ({ related: [] }))

      await expect(
        pageWith(load)(props(['posts', 'hello'], { branch: ['a', 'b'] })),
      ).rejects.toThrow(NOT_FOUND)
      expect(load).not.toHaveBeenCalled()
    })

    it("on a deployedAs: 'static' deployment", async () => {
      readByUrlPath.mockResolvedValue(entry('post'))
      const load = vi.fn(() => ({ related: [] }))

      await expect(pageWith(load, 'static')(props(['posts', 'hello']))).rejects.toThrow(NOT_FOUND)
      expect(load).not.toHaveBeenCalled()
    })
  })

  it('rejects the page with what the loader throws, rather than rendering', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    await expect(
      pageWith(async () => {
        throw new Error('listing failed')
      })(props(['posts', 'hello'])),
    ).rejects.toThrow('listing failed')
  })

  it("checks a loader's result against the view's extras at compile time", () => {
    // @ts-expect-error `related` must be string[], the type the view's extras prop declares
    previewView({ view: ExtrasView, load: () => ({ related: 1 }) })
    expect(previewView({ view: ExtrasView, load: () => ({ related: [] }) }).load).toBeTypeOf(
      'function',
    )
  })

  it('is a 404 when the loader calls notFound()', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    await expect(pageWith(() => notFound())(props(['posts', 'hello']))).rejects.toThrow(NOT_FOUND)
  })
})

describe("a preview request's server-rendered asset URLs", () => {
  const plainRender = (): Promise<string> =>
    inRequest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return assetUrl(CROP, { width: 320 })
    })

  it('go behind the signed-in route, from the loader and from what renders after the page', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))
    const fromLoad: string[] = []

    const afterPage = await inRequest(async () => {
      await createPreviewPageFor(getCanopy, {
        views: {
          post: previewView({
            view: (props: { extras?: { related: string[] } }) => <>{props.extras?.related}</>,
            load: () => {
              fromLoad.push(assetUrl(CROP, { width: 320 }))
              return { related: [] }
            },
          }),
        },
      })({
        params: Promise.resolve({ path: ['posts', 'hello'] }),
        searchParams: Promise.resolve({}),
      })
      return {
        transform: assetUrl(CROP, { width: 320, baseUrl: 'https://assets.example.com' }),
        file: assetUrl({ src: '/assets/0123456789abcdef0123456789abcdef/report.pdf' }),
      }
    })

    expect(fromLoad).toEqual([`${RAW_BASE}${CROP_AT_320}`])
    // The prefix wins over `baseUrl`, and only for `/assets/t/` srcs.
    expect(afterPage.transform).toBe(`${RAW_BASE}${CROP_AT_320}`)
    expect(afterPage.file).toBe('/assets/0123456789abcdef0123456789abcdef/report.pdf')
  })

  it('follow basePath', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const [element, url] = await inRequest(async () => [
      (await createPreviewPageFor(
        getCanopy,
        { views },
        { basePath: '/docs' },
      )({
        params: Promise.resolve({ path: ['posts', 'hello'] }),
        searchParams: Promise.resolve({}),
      })) as ReactElement<Record<string, unknown>>,
      assetUrl(CROP, { width: 320 }),
    ])

    expect(element.props.previewAssetBase).toBe(`/docs${RAW_BASE}`)
    expect(url).toBe(`/docs${RAW_BASE}${CROP_AT_320}`)
  })

  it('stay public when basePath would put the prefix off-origin', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const [element, url] = await inRequest(async () => [
      (await createPreviewPageFor(
        getCanopy,
        { views },
        { basePath: '//evil.example' },
      )({
        params: Promise.resolve({ path: ['posts', 'hello'] }),
        searchParams: Promise.resolve({}),
      })) as ReactElement<Record<string, unknown>>,
      assetUrl(CROP, { width: 320 }),
    ])

    expect(element.props.previewAssetBase).toBeUndefined()
    expect(url).toBe(CROP_AT_320)
  })

  it.each([
    ['an anonymous request', anonymously, {}],
    ['a read that finds nothing', () => readByUrlPath.mockResolvedValue(null), {}],
    ['an entry type with no view', () => readByUrlPath.mockResolvedValue(entry('author')), {}],
    ["a deployedAs: 'static' deployment", () => {}, { deployedAs: 'static' as const }],
  ])('stay public after %s', async (_, arrange, config) => {
    readByUrlPath.mockResolvedValue(entry('post'))
    arrange()

    const url = await inRequest(async () => {
      await createPreviewPageFor(
        getCanopy,
        { views },
        config,
      )({
        params: Promise.resolve({ path: ['posts', 'hello'] }),
        searchParams: Promise.resolve({}),
      }).catch(() => undefined)
      return assetUrl(CROP, { width: 320 })
    })

    expect(url).toBe(CROP_AT_320)
  })

  it('stay public in a request rendered alongside a preview, and outside any request', async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const [preview, ...plain] = await Promise.all([
      inRequest(async () => {
        await createPreviewPageFor(getCanopy, { views })({
          params: Promise.resolve({ path: ['posts', 'hello'] }),
          searchParams: Promise.resolve({}),
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        return assetUrl(CROP, { width: 320 })
      }),
      plainRender(),
      plainRender(),
    ])

    expect(preview).toBe(`${RAW_BASE}${CROP_AT_320}`)
    expect(plain).toEqual([CROP_AT_320, CROP_AT_320])
    expect(assetUrl(CROP, { width: 320 })).toBe(CROP_AT_320)
  })
})
