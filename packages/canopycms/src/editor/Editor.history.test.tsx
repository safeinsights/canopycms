import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import { SWRConfig } from 'swr'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { notifications } from '@mantine/notifications'
import { RESTORED_ENTRY_GONE_MESSAGE } from './hooks/useEntryManager'
import { writeEditorUrl } from './hooks/editor-history'

import { CANOPY_PREVIEW_NAVIGATE, CANOPY_PREVIEW_READY } from './preview-bridge'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'

const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>{ui}</ApiClientProvider>
    </SWRConfig>,
  )

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

const originalMatchMedia = window.matchMedia
const originalResizeObserver = window.ResizeObserver

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterAll(() => {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
  if (originalResizeObserver) window.ResizeObserver = originalResizeObserver
})

afterEach(() => {
  cleanup()
  vi.mocked(notifications.show).mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

const okJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const hello: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema: [{ name: 'title', type: 'string' }],
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'json',
  type: 'entry',
}
const world: EditorEntry = {
  ...hello,
  path: unsafeAsLogicalPath('content/posts/world'),
  contentId: unsafeAsContentId('ghi789DEF456'),
  label: 'World',
  slug: 'world',
}
const helloSrc = '/preview/posts/hello?branch=main'
const worldSrc = '/preview/posts/world?branch=main'

const stubApi = () => {
  const branch = (name: string) => ({
    name,
    status: 'editing',
    access: {},
    createdBy: 'user-1',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    isProtected: false,
    readOnly: false,
    writeBlocked: false,
    submitBlocked: false,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              branches: [
                branch('main'),
                branch('feature'),
                branch('feature-x'),
                { ...branch('canopycms/local/spring'), shortName: 'spring' },
              ],
              defaultBranch: 'main',
            },
          }),
        )
      }
      if (url.includes('/schema') && !url.includes('/schema/')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              schema: {},
              flatSchema: [
                {
                  type: 'entry-type',
                  logicalPath: 'content/posts/post',
                  name: 'post',
                  parentPath: 'content/posts',
                  format: 'json',
                  schemaRef: 'postSchema',
                },
              ],
              entrySchemas: { postSchema: [{ name: 'title', type: 'string' }] },
            },
          }),
        )
      }
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              collections: [
                {
                  logicalPath: 'content/posts',
                  contentId: 'abc123XYZ789',
                  name: 'posts',
                  type: 'collection',
                  format: 'json',
                  schema: hello.schema,
                  order: [],
                },
              ],
              entries: [hello, world].map((e) => ({
                logicalPath: e.path,
                contentId: e.contentId,
                collectionPath: e.collectionPath,
                collectionName: e.collectionName,
                slug: e.slug,
                format: e.format,
                entryType: 'post',
                physicalPath: `/content/posts.abc123XYZ789/post.${e.slug}.${e.contentId}.json`,
                exists: true,
              })),
              pagination: { hasMore: false, limit: 50 },
            },
          }),
        )
      }
      if (url.includes('/content/content/posts/') && (init?.method ?? 'GET') === 'GET') {
        const slug = url.slice(url.lastIndexOf('/') + 1)
        return Promise.resolve(
          okJson({ ok: true, status: 200, data: { title: `${slug} title`, version: 1 } }),
        )
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    }),
  )
}

const renderEditor = () =>
  renderWithProviders(
    <Editor
      entries={[hello, world]}
      title="Test Editor"
      branchName="main"
      operatingMode="dev"
      themeOptions={{}}
      previewPrefix="/preview"
    />,
  )

const iframe = () => document.querySelector('iframe')
const sayReady = () => {
  const frame = iframe() as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_READY, path: frame.getAttribute('src') },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    )
  })
}
const followPreviewLink = (href: string) => {
  const frame = iframe() as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_NAVIGATE, href },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    )
  })
}
const entryMenu = () =>
  screen.queryAllByTestId('file-dropdown-button').find((el) => el.tagName === 'BUTTON')
const urlEntry = () => new URLSearchParams(window.location.search).get('entry')
const urlBranch = () => new URLSearchParams(window.location.search).get('branch')
const isOpen = (slug: string) =>
  Boolean(screen.queryByRole('button', { name: `Copy path /posts/${slug}` }))

let pushState: MockInstance<History['pushState']>
const openEditor = async (search = '?branch=main') => {
  window.history.replaceState(null, '', `/${search}`)
  pushState = vi.spyOn(window.history, 'pushState')
  stubApi()
  renderEditor()
  await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
  await waitFor(() => expect(urlEntry()).toBe(hello.path))
  sayReady()
}
const openInTree = async (slug: string) => {
  if (!screen.queryByTestId(`entry-nav-item-${slug}`)) {
    fireEvent.click(screen.getByTestId('content-panel-toggle'))
  }
  fireEvent.click(await screen.findByTestId(`entry-nav-item-${slug}`))
}
const back = async () => {
  const popped = new Promise((resolve) =>
    window.addEventListener('popstate', resolve, { once: true }),
  )
  act(() => window.history.back())
  await act(async () => {
    await popped
  })
}
const forward = async () => {
  const popped = new Promise((resolve) =>
    window.addEventListener('popstate', resolve, { once: true }),
  )
  act(() => window.history.forward())
  await act(async () => {
    await popped
  })
}
const pushedEntries = () =>
  pushState.mock.calls.map(([, , url]) =>
    new URL(String(url), window.location.href).searchParams.get('entry'),
  )

describe('history across entries', () => {
  it('replaces, never pushes, the URL the initial load settles on', async () => {
    await openEditor('?branch=main&entry=content/posts/gone')

    expect(isOpen('hello')).toBe(true)
    expect(pushState).not.toHaveBeenCalled()
  })

  it('pushes an entry for each entry opened from the content tree', async () => {
    await openEditor()

    await openInTree('world')

    await waitFor(() => expect(urlEntry()).toBe(world.path))
    expect(pushedEntries()).toEqual([world.path])
  })

  it('pushes an entry for an entry a preview link opens', async () => {
    await openEditor()

    followPreviewLink(`${window.location.origin}/posts/world`)

    await waitFor(() => expect(urlEntry()).toBe(world.path))
    expect(pushedEntries()).toEqual([world.path])
  })

  it('pushes an entry for an entry found with Mod+P and opened with Enter', async () => {
    await openEditor()

    fireEvent.keyDown(document.body, { key: 'p', ctrlKey: true })
    const filter = await screen.findByTestId('entry-nav-filter')
    fireEvent.change(filter, { target: { value: 'world' } })
    fireEvent.keyDown(filter, { key: 'Enter' })

    await waitFor(() => expect(urlEntry()).toBe(world.path))
    expect(pushedEntries()).toEqual([world.path])
  })

  it('pushes nothing when the open entry is chosen again', async () => {
    await openEditor()

    await openInTree('hello')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pushState).not.toHaveBeenCalled()
  })

  it('goes Back and Forward between entries, framing each one, without pushing', async () => {
    await openEditor()
    await openInTree('world')
    await waitFor(() => expect(urlEntry()).toBe(world.path))

    await back()

    await waitFor(() => expect(isOpen('hello')).toBe(true))
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    expect(urlEntry()).toBe(hello.path)

    await forward()

    await waitFor(() => expect(isOpen('world')).toBe(true))
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    expect(pushedEntries()).toEqual([world.path])
  })

  it('moves focus to the entry menu after Back, not into the preview a link left', async () => {
    await openEditor()
    followPreviewLink(`${window.location.origin}/posts/world`)
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    fireEvent.load(iframe() as HTMLIFrameElement)
    expect(document.activeElement).toBe(iframe())

    await back()

    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    fireEvent.load(iframe() as HTMLIFrameElement)
    await waitFor(() => expect(document.activeElement).toBe(entryMenu()))
    expect(entryMenu()?.textContent).toContain('hello')
  })

  it('leaves the URL alone on a Back off the editor to another page', async () => {
    await openEditor()
    await openInTree('world')
    await waitFor(() => expect(urlEntry()).toBe(world.path))
    window.history.pushState(null, '', '/docs/guide')

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(window.location.pathname).toBe('/docs/guide')
    expect(window.location.search).toBe('')
    expect(isOpen('world')).toBe(true)
  })

  it('refuses a Forward onto a branch no longer listed, keeping that history entry', async () => {
    await openEditor()
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/branches'))).toBe(
        true,
      ),
    )
    // The branch list is in once its response has been read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    writeEditorUrl('/?branch=gone&entry=content/posts/world', true)
    await back()

    await forward()

    await waitFor(() => expect(urlBranch()).toBe('main'))
    expect(urlEntry()).toBe(hello.path)
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Branch “gone” no longer exists'),
      }),
    )
    await forward()
    await waitFor(() => expect(urlBranch()).toBe('main'))
    expect(notifications.show).toHaveBeenCalledTimes(2)
  })

  it("switches for a Back onto a branch listed under its name's sanitized form", async () => {
    await openEditor()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    window.history.replaceState(null, '', '/?branch=feature%2Fx&entry=content/posts/world')

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => expect(isOpen('world')).toBe(true))
    await waitFor(() => expect(urlBranch()).toBe('feature-x'))
    expect(isOpen('world')).toBe(true)
    expect(notifications.show).not.toHaveBeenCalled()
  })

  it('switches for a Back onto a namespace branch named by its short name', async () => {
    await openEditor()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    window.history.replaceState(null, '', '/?branch=spring&entry=content/posts/world')

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => expect(isOpen('world')).toBe(true))
    await waitFor(() => expect(urlBranch()).toBe('canopycms/local/spring'))
    expect(isOpen('world')).toBe(true)
    expect(notifications.show).not.toHaveBeenCalled()
  })

  it('leaves focus alone on a Back to the entry already open', async () => {
    await openEditor()
    await openInTree('world')
    await waitFor(() => expect(urlEntry()).toBe(world.path))
    const filter = screen.getByTestId('entry-nav-filter')
    act(() => filter.focus())

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(document.activeElement).toBe(filter)
  })

  it('writes no URL while the page shown is not the editor', async () => {
    await openEditor()
    window.history.pushState(null, '', '/docs/guide')

    await openInTree('world')
    await waitFor(() => expect(isOpen('world')).toBe(true))

    expect(window.location.pathname).toBe('/docs/guide')
    expect(window.location.search).toBe('')
  })

  it("keeps the editor's branch in the URLs it writes", async () => {
    await openEditor()
    window.history.replaceState(null, '', '/?branch=feature&entry=content/posts/hello')

    await openInTree('world')

    await waitFor(() => expect(urlEntry()).toBe(world.path))
    expect(urlBranch()).toBe('main')
  })

  it('opens the home page, replacing the URL, when Back returns to an entry since deleted', async () => {
    await openEditor()
    await openInTree('world')
    await waitFor(() => expect(urlEntry()).toBe(world.path))
    window.history.replaceState(null, '', '/?branch=main&entry=content/posts/gone')

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => expect(isOpen('hello')).toBe(true))
    await waitFor(() => expect(urlEntry()).toBe(hello.path))
    expect(pushedEntries()).toEqual([world.path])
    expect(notifications.show).toHaveBeenCalledWith({
      message: RESTORED_ENTRY_GONE_MESSAGE,
      color: 'blue',
    })
  })

  it('switches branch for a Back onto another branch, and opens its entry there', async () => {
    await openEditor()
    window.history.replaceState(null, '', '/?branch=feature&entry=content/posts/world')

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(iframe()?.getAttribute('src')).toBe('/preview/posts/world?branch=feature'),
    )
    expect(urlBranch()).toBe('feature')
    expect(urlEntry()).toBe(world.path)
    expect(pushState).not.toHaveBeenCalled()
  })
})
