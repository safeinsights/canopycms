import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopyContext } from 'canopycms/server'

const NOT_FOUND = 'NEXT_NOT_FOUND'
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND)
  },
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('canopycms/client', () => ({ CanopyEditorPage: vi.fn(), useCanopyPreview: vi.fn() }))

const { createPreviewPageFor } = await import('./preview-page')
const { CanopyPreviewView } = await import('./client')

const PostView = () => null
const DocView = () => null
const views = { post: PostView, doc: DocView }

const readByUrlPath = vi.fn()
const getCanopy = vi.fn(async () => ({ readByUrlPath }) as unknown as CanopyContext)

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
    expect(element.type).toBe(CanopyPreviewView)
    expect(element.props).toEqual({
      view: PostView,
      initialData: { title: 'Hello' },
      editorOrigin: undefined,
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
    expect(element.props.view).toBe(DocView)
  })

  it('passes a configured editorOrigin to the view wrapper', async () => {
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
