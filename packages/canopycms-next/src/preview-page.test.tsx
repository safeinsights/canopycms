import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopyContext } from 'canopycms/server'
import { notFound } from 'next/navigation'
import type { PreviewLoadContext } from './preview-page'

const NOT_FOUND = 'NEXT_NOT_FOUND'
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND)
  },
}))

const { createPreviewPageFor, previewView } = await import('./preview-page')

const PostView = () => null
const DocView = () => null
const views = { post: PostView, doc: DocView }

const readByUrlPath = vi.fn()
const canopy = { readByUrlPath } as unknown as CanopyContext
const getCanopy = vi.fn(async () => canopy)

const entry = (entryType: string, data: unknown = { title: 'Hello' }) => ({
  data,
  path: 'content/posts',
  meta: { entryType, entryId: 'abc', physicalPath: '/srv/workspace/secret/post.md' },
})

const render = (path: string[] | undefined, query: Record<string, string | string[]> = {}) =>
  createPreviewPageFor(getCanopy, { views })({
    params: Promise.resolve(path === undefined ? {} : { path }),
    searchParams: Promise.resolve(query),
  })

beforeEach(() => {
  readByUrlPath.mockReset()
  getCanopy.mockClear()
})

describe('createPreviewPageFor', () => {
  it("reads the route's path from the requested branch and renders the entry type's view", async () => {
    readByUrlPath.mockResolvedValue(entry('post'))

    const element = (await render(['posts', 'hello'], { branch: 'feature/x' })) as ReactElement<
      Record<string, unknown>
    >

    expect(readByUrlPath).toHaveBeenCalledWith('/posts/hello', { branch: 'feature/x' })
    expect(element.type).toBe(PostView)
    expect(element.props).toEqual({ initialData: { title: 'Hello' }, editorOrigin: undefined })
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

  it('is a 404 for a repeated ?branch=, without reading', async () => {
    await expect(render(['posts', 'hello'], { branch: ['a', 'b'] })).rejects.toThrow(NOT_FOUND)
    expect(getCanopy).not.toHaveBeenCalled()
    expect(readByUrlPath).not.toHaveBeenCalled()
  })

  it("is a 404 on a deployedAs: 'static' deployment, without reading", async () => {
    readByUrlPath.mockResolvedValue(entry('post'))
    const page = createPreviewPageFor(getCanopy, { views }, 'static')

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
      deployedAs,
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
      entry: { data: found.data, path: found.path, entryType: 'post', entryId: 'abc' },
      canopy,
      branch: 'feature/x',
    })
    expect(element.type).toBe(ExtrasView)
    expect(element.props).toEqual({
      initialData: { title: 'Hello' },
      editorOrigin: undefined,
      extras: { related: ['a', 'b'] },
    })
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
